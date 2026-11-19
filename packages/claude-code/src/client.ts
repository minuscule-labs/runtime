import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import {
  query, type CanUseTool, type Query, type SDKMessage, type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import {
  runtimeInput, type AgentEvent, type AgentRuntime, type AgentSession, type AgentStartConfig,
  type AgentStatus, type AgentTurn, type RuntimeActivityEvent, type RuntimeActivityPhase,
  type RuntimeActivityOptions, type RuntimeImageContent, type RuntimeMessage,
  type RuntimeSessionCapabilities,
} from "@minu/runtime-core";
import { Queue } from "./queue.js";
import { claudeCodePermissionOptions, resolveClaudeCodePermissions, type ClaudeCodePermissionPolicy, type ClaudeCodePermissions } from "./permissions.js";
import { claudeCodeNativeEnvironment, resolveClaudeCodeConfigRoot } from "./native-config.js";

export interface ClaudeCodeRuntimeOptions {
  /** What sessions may do natively; the library default is "readOnly" so callers opt in to "full". Not an OS sandbox
   * or a filesystem boundary. See ClaudeCodePermissions. */
  permissions?: ClaudeCodePermissions;
  /** Restore the isolated behavior: no user/project/local settings, hooks, MCP servers or plugins. Default: native
   * configuration, i.e. what running `claude` in that cwd would load (no new trust is granted). */
  isolateConfiguration?: boolean;
  /** Explicit tool list; overrides the policy's tools (legacy). */
  tools?: string[];
  /** Denied when omitted; configured decisions use controlTimeoutMs and a request/turn abort signal.
   * Null/out-of-band replies are unsupported. Does not gate native auto-allowed tools. */
  canUseTool?: CanUseTool;
  /** Omit to use the SDK's pinned, bundled Claude Code executable. */
  executable?: string;
  /** When supplied, replaces (does not merge with) the inherited native environment. */
  env?: Record<string, string | undefined>;
  startupTimeoutMs?: number;
  controlTimeoutMs?: number;
  shutdownTimeoutMs?: number;
  turnRetentionLimit?: number;
  eventBufferLimit?: number;
}

/** Internal native opening only; caller supplies owner/generation/uncertainty admission. */
export interface ClaudeCodeNativeLaunch {
  mode: "create" | "resume";
  runtimeSessionId: string;
  nativeSessionId: string;
  canonicalCwd: string;
  nativeConfigRoot: string;
  /** The root is the user's NATIVE Claude Code configuration: inherited environment overlaid by `env`, owned (not
   * private) directories, never created/chmodded/written by Runtime. Omitted keeps the private-root behavior. */
  nativeRoot?: boolean;
  signal?: AbortSignal;
}
export type ClaudeCodeSettlementEvidence = "native" | "undispatched" | "uncertain";
const NATIVE_UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;

type EventPayload<E = AgentEvent> = E extends AgentEvent ? Omit<E, "sessionId" | "timestamp"> : never;

function copyTurn(turn: AgentTurn): AgentTurn {
  const copy = { ...turn };
  if (turn.response) copy.response = { ...turn.response };
  return copy;
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

interface Execution {
  turn: AgentTurn;
  digest: string;
  nativeId: ReturnType<typeof randomUUID>;
  sending: boolean;
  written: ReturnType<typeof deferred>;
  done: ReturnType<typeof deferred>;
  interruptRequested: boolean;
  /** Set when the turn must end failed (e.g. a human-in-the-loop dialog); settled by its native result. */
  failure?: string;
  permissionAbort: AbortController;
  evidence: ClaudeCodeSettlementEvidence;
}

interface SessionState {
  session: AgentSession;
  nativeId: string;
  persistent: boolean;
  policy: ClaudeCodePermissionPolicy;
  status: AgentStatus;
  query?: Query;
  process?: ChildProcess;
  exited: ReturnType<typeof deferred>;
  abort: AbortController;
  inputs: Queue<Execution>;
  turns: Map<string, Execution>;
  active?: Execution;
  control?: Promise<void>;
  stopping?: Promise<void>;
  messages: RuntimeMessage[];
  tools: Map<string, string>;
  events: Set<Queue<AgentEvent>>;
  activities: Set<Queue<RuntimeActivityEvent>>;
  phase?: RuntimeActivityPhase;
}

async function deadline<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms); }),
    ]);
  } finally { clearTimeout(timer); }
}

async function privateNativeDirectory(path: string, create = false): Promise<void> {
  if (create) {
    try { await mkdir(path, { mode: 0o700 }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  }
  const metadata = await lstat(path);
  if (!metadata.isDirectory() || (metadata.mode & 0o077) || metadata.uid !== process.getuid?.()
    || await realpath(path) !== path) throw new Error("Persistent Claude Code configuration must be private and canonical");
}

/** In-process owned sessions. No managed lifecycle, recovery, attachment, or automatic replay. */
export class ClaudeCodeAgentRuntime implements AgentRuntime {
  private sessions = new Map<string, SessionState>();
  private starting = new Set<string>();
  private options: ClaudeCodeRuntimeOptions;
  private startupMs: number;
  private controlMs: number;
  private shutdownMs: number;
  private retention: number;
  private buffer: number;

  constructor(options: ClaudeCodeRuntimeOptions = {}) {
    this.options = { ...options, tools: options.tools ? [...options.tools] : undefined,
      env: options.env ? { ...options.env } : undefined };
    this.startupMs = options.startupTimeoutMs ?? 30_000;
    this.controlMs = options.controlTimeoutMs ?? 10_000;
    this.shutdownMs = options.shutdownTimeoutMs ?? 10_000;
    this.retention = options.turnRetentionLimit ?? 1_000;
    this.buffer = options.eventBufferLimit ?? 256;
    for (const value of [this.startupMs, this.controlMs, this.shutdownMs, this.retention, this.buffer]) {
      if (!Number.isSafeInteger(value) || value <= 0 || value > 2_147_483_647) {
        throw new Error("Runtime limits must be positive bounded integers");
      }
    }
  }

  async start(config: AgentStartConfig = {}): Promise<AgentSession> {
    return this.launch(config);
  }

  /** Internal subclasses only. Not managed lifecycle, ownership or replacement authority. */
  protected async launch(config: AgentStartConfig, native?: ClaudeCodeNativeLaunch): Promise<AgentSession> {
    if (!config || typeof config !== "object" || Array.isArray(config)) throw new Error("Invalid Claude Code launch configuration");
    if (native !== undefined && (!native || typeof native !== "object" || Array.isArray(native))) throw new Error("Invalid persistent Claude Code launch");
    config = { ...config };
    native = native && { ...native };
    native?.signal?.throwIfAborted();
    if (config.systemPrompt !== undefined && config.appendSystemPrompt !== undefined) {
      throw new Error("System prompt replacement and append are mutually exclusive");
    }
    for (const prompt of [config.systemPrompt, config.appendSystemPrompt]) {
      if (prompt !== undefined && typeof prompt !== "string") throw new Error("System prompt must be text");
    }
    // No silent model/effort fallback or skill-filter promises in the initial slice.
    if (config.model !== undefined) throw new Error("Claude Code model selection is not supported yet");
    if (config.reasoningLevel !== undefined) throw new Error("Claude Code reasoning selection is not supported yet");
    if (config.skillIds !== undefined) throw new Error("Claude Code skill selection is not supported yet");
    const cwd = await realpath(config.cwd ?? process.cwd());
    if (!(await stat(cwd)).isDirectory()) throw new Error("Workspace must be a directory");
    let history: RuntimeMessage[] = [];
    let launchEnv = this.options.env;
    if (native) {
      if (!["create", "resume"].includes(native.mode)
        || typeof native.runtimeSessionId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(native.runtimeSessionId)
        || typeof native.nativeSessionId !== "string" || !NATIVE_UUID.test(native.nativeSessionId) || config.cwd !== native.canonicalCwd || cwd !== native.canonicalCwd) {
        throw new Error("Invalid persistent Claude Code identity or workspace");
      }
      const env: Record<string, string | undefined> = native.nativeRoot ? claudeCodeNativeEnvironment(this.options.env)
        : { ...(this.options.env ?? process.env) };
      launchEnv = env; // Validate and spawn from the same per-launch snapshot.
      if (env.CLAUDE_CODE_PROJECT_DIR_NAME !== undefined) {
        throw new Error("Persistent Claude Code project-directory override is not supported");
      }
      const root = native.nativeConfigRoot;
      if (!process.getuid || !isAbsolute(root) || resolve(root) !== root || root.includes("\0")) {
        throw new Error("Persistent Claude Code native configuration root is not verified");
      }
      if (native.nativeRoot) {
        // The user's own root: resolve exactly as Claude Code does, and require it to be the one authorized for this session.
        if (await resolveClaudeCodeConfigRoot(undefined, env) !== root) {
          throw new Error("Persistent Claude Code native configuration root is not verified");
        }
      } else if ((env.CLAUDE_CONFIG_DIR ?? (env.HOME ? join(env.HOME, ".claude") : undefined)) !== root) {
        throw new Error("Persistent Claude Code native configuration root is not verified");
      }
      if (env.CLAUDE_CODE_RESUME_INTERRUPTED_TURN !== undefined) {
        throw new Error("Automatic interrupted-turn replay is not allowed");
      }
      if (!native.nativeRoot) try {
        await privateNativeDirectory(root);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT" || native.mode === "resume") throw error;
        if (await realpath(dirname(root)) !== dirname(root)) throw new Error("Persistent Claude Code configuration parent is redirected");
      }
      const { inspectClaudeCodeHistory, claudeCodeNativeProjectKey } = await import("./native-history.js");
      if (native.mode === "create" && !native.nativeRoot) {
        // Native defaults can create these as 0755. Prepare only missing directories;
        // never chmod/repair existing native storage or manufacture history files.
        for (const path of [root, join(root, "projects"), join(root, "projects", claudeCodeNativeProjectKey(cwd))]) {
          native.signal?.throwIfAborted();
          await privateNativeDirectory(path, true);
        }
      }
      const snapshot = await inspectClaudeCodeHistory({ nativeSessionId: native.nativeSessionId,
        canonicalCwd: cwd, nativeConfigRoot: root, nativeRoot: native.nativeRoot, signal: native.signal });
      if (native.mode === "resume") {
        if (snapshot.state !== "present") throw new Error("Mapped Claude Code native history is missing");
        history = snapshot.messages;
      } else if (snapshot.state === "present") throw new Error("Claude Code native history already exists; creation refused");
      native.signal?.throwIfAborted();
    }
    const policy = resolveClaudeCodePermissions(this.options.permissions);
    const id = native?.runtimeSessionId ?? randomUUID();
    if (this.sessions.has(id) || this.starting.has(id)) throw new Error("Claude Code Runtime identity is already in use");
    this.starting.add(id);
    const state: SessionState = {
      session: { id, runtime: "claude-code", ownership: "owned", cwd },
      nativeId: native?.nativeSessionId ?? id, persistent: !!native, policy,
      status: "idle", abort: new AbortController(), exited: deferred(),
      inputs: new Queue<Execution>(this.retention), turns: new Map(), messages: history.map(message => ({ ...message })), tools: new Map(),
      events: new Set(), activities: new Set(),
    };
    const canceled = () => state.abort.abort(native?.signal?.reason);
    try {
      native?.signal?.addEventListener("abort", canceled, { once: true });
      native?.signal?.throwIfAborted();
      state.query = query({
        prompt: this.prompts(state),
        options: {
          cwd, ...(native?.mode === "resume" ? { resume: state.nativeId } : { sessionId: state.nativeId }),
          abortController: state.abort,
          pathToClaudeCodeExecutable: this.options.executable, env: launchEnv,
          systemPrompt: config.systemPrompt ?? {
            type: "preset", preset: "claude_code", append: config.appendSystemPrompt,
          },
          ...claudeCodePermissionOptions(policy, this.options.tools),
          // bypassPermissions auto-approves before the callback is consulted (the SDK warns), so none is registered.
          ...(policy.permissionMode === "bypassPermissions" ? {}
            : { canUseTool: (name: string, input: Record<string, unknown>, options: Parameters<CanUseTool>[2]) => this.permissionDecision(state, name, input, options) }),
          // Headless: no dialog renderer, so never invent an answer. Only the active turn fails; the session stays usable.
          onUserDialog: async () => {
            const execution = state.active;
            if (execution && state.status === "working") execution.failure ??= "Claude Code requested unsupported interactive input";
            return { behavior: "cancelled" };
          },
          ...(this.options.isolateConfiguration
            ? { settingSources: [], settings: { disableAllHooks: true }, strictMcpConfig: true, mcpServers: {}, plugins: [] }
            : { settingSources: ["user", "project", "local"] }),
          persistSession: state.persistent, includePartialMessages: true, verbatimPrompts: true,
          spawnClaudeCodeProcess: (options) => {
            const child = spawn(options.command, options.args, {
              cwd: options.cwd, env: options.env, signal: options.signal,
              stdio: ["pipe", "pipe", "ignore"], windowsHide: true,
            });
            state.process = child;
            child.once("exit", () => {
              // Drain stdout before classifying the last turn; exit can precede stream consumption.
              state.exited.resolve();
            });
            child.once("error", () => {
              if (!child.pid) state.exited.resolve();
              this.offline(state, "Claude Code process failed");
            });
            return child;
          },
        },
      });
      // Consume independently of event subscribers; their speed cannot stall native work.
      void this.consume(state);
      const initialized = await deadline(state.query.initializationResult(), this.startupMs, "Claude Code startup timed out");
      native?.signal?.throwIfAborted();
      if (native && initialized.claude_code_version !== "2.1.321") throw new Error("Unsupported persistent Claude Code version");
      if (state.status === "offline") throw new Error("Claude Code exited during startup");
      this.sessions.set(id, state);
      return { ...state.session };
    } catch (error) {
      const failure = native?.signal?.aborted ? native.signal.reason : error;
      this.offline(state, "Claude Code startup failed");
      try { await this.shutdown(state); }
      catch { throw new Error("Claude Code startup failed; process shutdown is unconfirmed", { cause: failure }); }
      throw failure;
    } finally {
      this.starting.delete(id);
      native?.signal?.removeEventListener("abort", canceled);
    }
  }

  private async permissionDecision(state: SessionState, name: string, input: Record<string, unknown>, options: Parameters<CanUseTool>[2]): ReturnType<CanUseTool> {
    const execution = state.active;
    const denied = { behavior: "deny" as const, message: "Runtime permission request was cancelled" };
    if (!execution || state.status !== "working" || execution.interruptRequested) return denied;
    const handler = this.options.canUseTool;
    if (!handler) return { behavior: "deny", message: "Runtime has no permission approval handler" };
    const cancelled = Symbol(), timedOut = Symbol();
    const signal = AbortSignal.any([options.signal, state.abort.signal, execution.permissionAbort.signal]);
    const controller = new AbortController();
    const expiresAt = performance.now() + this.controlMs;
    let cancel!: () => void, timer: ReturnType<typeof setTimeout> | undefined;
    const gate = new Promise<symbol>(resolve => {
      cancel = () => { resolve(cancelled); controller.abort(); };
      signal.addEventListener("abort", cancel, { once: true });
      timer = setTimeout(() => { resolve(timedOut); controller.abort(); }, this.controlMs);
      if (signal.aborted) cancel();
    });
    let reason = "Claude Code permission decision failed";
    try {
      const response = await Promise.race([gate, Promise.resolve().then(async () => controller.signal.aborted
        ? cancelled : handler(name, input, { ...options, signal: controller.signal }))]);
      if (response === cancelled || signal.aborted || state.active !== execution || execution.interruptRequested) return denied;
      if (response === timedOut || performance.now() >= expiresAt) reason = "Claude Code permission decision timed out";
      else if (response && typeof response !== "symbol" && (response.behavior === "allow" || response.behavior === "deny")) {
        const decision = { ...response };
        // A promise can resolve before an overdue timer gets its event-loop turn.
        if (performance.now() < expiresAt) return decision;
        reason = "Claude Code permission decision timed out";
      }
    } catch { /* Caller errors/invalid results never become native diagnostics or approval. */ }
    finally { clearTimeout(timer); signal.removeEventListener("abort", cancel); }
    controller.abort();
    this.offline(state, reason);
    await this.shutdown(state);
    throw new Error(reason);
  }

  private async *prompts(state: SessionState): AsyncGenerator<SDKUserMessage> {
    for await (const execution of state.inputs) {
      if (state.status === "offline" || state.active !== execution) continue;
      execution.sending = true;
      yield {
        type: "user", session_id: state.nativeId, parent_tool_use_id: null,
        uuid: execution.nativeId, message: { role: "user", content: execution.turn.input },
      };
      // The SDK requests the next item only after the previous transport write settles.
      execution.written.resolve();
    }
  }

  async send(sessionId: string, input: string, images?: RuntimeImageContent[]): Promise<void> {
    const turn = await this.startTurn(sessionId, randomUUID(), input, images);
    const state = this.get(sessionId);
    const execution = state.turns.get(turn.id)!;
    await execution.done.promise;
    if (execution.turn.status !== "completed") {
      throw new Error(execution.turn.error ?? `Claude Code turn ${execution.turn.status}`);
    }
  }

  async startTurn(sessionId: string, turnId: string, input: string, images?: RuntimeImageContent[]): Promise<AgentTurn> {
    return this.acceptTurn(sessionId, turnId, input, images);
  }

  /** Supplied UUID lets an admitted worker persist exact dispatch intent before calling this. */
  protected async acceptTurn(sessionId: string, turnId: string, input: string, images?: RuntimeImageContent[], nativeMessageId?: string): Promise<AgentTurn> {
    if (nativeMessageId !== undefined && !NATIVE_UUID.test(nativeMessageId)) throw new Error("Invalid native message identity");
    const normalized = runtimeInput(input, images);
    if (normalized.images.length) throw new Error("Claude Code image input is not supported yet");
    if (typeof turnId !== "string" || !turnId.trim() || Buffer.byteLength(turnId) > 256) {
      throw new Error("Turn id must be nonempty and at most 256 bytes");
    }
    const state = this.get(sessionId);
    const digest = createHash("sha256").update(normalized.input).digest("hex");
    const existing = state.turns.get(turnId);
    if (existing) {
      if (existing.digest !== digest) throw new Error("Turn id conflicts with previously accepted input");
      if (nativeMessageId !== undefined && nativeMessageId !== existing.nativeId) throw new Error("Native message identity conflicts with retained turn");
      return copyTurn(existing.turn);
    }
    if (state.status === "offline") throw new Error("Claude Code session is offline");
    if (state.active || state.control) throw new Error("Claude Code session is busy");
    while (state.turns.size >= this.retention) state.turns.delete(state.turns.keys().next().value!);
    const now = new Date().toISOString();
    const execution: Execution = {
      turn: { id: turnId, status: "running", input: normalized.input, createdAt: now, updatedAt: now },
      digest, nativeId: (nativeMessageId ?? randomUUID()) as ReturnType<typeof randomUUID>, sending: false, written: deferred(), done: deferred(),
      interruptRequested: false, permissionAbort: new AbortController(), evidence: "uncertain",
    };
    state.turns.set(turnId, execution);
    state.active = execution;
    state.messages.push({ role: "user", content: input, timestamp: Date.now() });
    this.setStatus(state, "working");
    this.emit(state, { type: "turn_started", operationId: turnId });
    this.activity(state, "working");
    state.inputs.push(execution);
    return copyTurn(execution.turn);
  }

  async turn(sessionId: string, turnId: string): Promise<AgentTurn | undefined> {
    const turn = this.get(sessionId).turns.get(turnId)?.turn;
    return turn && copyTurn(turn);
  }

  /** Observation only; never derive this from resumed textual history. */
  protected settlementEvidence(sessionId: string, turnId: string): ClaudeCodeSettlementEvidence | undefined {
    return this.get(sessionId).turns.get(turnId)?.evidence;
  }

  async steer(sessionId: string, _input: string): Promise<void> {
    this.get(sessionId);
    throw new Error("Claude Code steering is not supported yet; interrupt before sending another turn");
  }

  async interrupt(sessionId: string): Promise<void> {
    const state = this.get(sessionId);
    if (state.status === "offline") throw new Error("Claude Code session is offline");
    if (state.control) return state.control;
    const execution = state.active;
    if (!execution) return;
    execution.interruptRequested = true;
    execution.permissionAbort.abort();
    if (!execution.sending) {
      state.inputs.remove(execution);
      this.finish(state, execution, "interrupted", undefined, undefined, "undispatched");
      return;
    }
    const operation = (async () => {
      try {
        await deadline(execution.written.promise, this.controlMs, "Claude Code input dispatch timed out");
        if (state.status === "offline") throw new Error("Claude Code session is offline");
        if (state.active !== execution) return;
        await deadline(state.query!.interrupt(), this.controlMs, "Claude Code interrupt timed out");
        // An acknowledgment is not turn completion. Keep the session busy until its native result.
      } catch (error) {
        this.offline(state, "Claude Code control failed; outcome is uncertain");
        await this.shutdown(state);
        throw error;
      }
    })();
    state.control = operation;
    try { await operation; }
    finally { if (state.control === operation) state.control = undefined; }
  }

  async status(sessionId: string): Promise<AgentStatus> { return this.get(sessionId).status; }

  async inputCapabilities(sessionId: string): Promise<{ version: 1; images: boolean }> {
    this.get(sessionId);
    return { version: 1, images: false };
  }

  async sessionCapabilities(sessionId: string): Promise<RuntimeSessionCapabilities> {
    const live = this.get(sessionId).status !== "offline";
    return { version: 1, safeActivityEvents: live, interrupt: live, reconnectExisting: false,
      interactiveAttach: false, openDiagnostic: false, liveSkillVerification: false };
  }

  async messages(sessionId: string): Promise<RuntimeMessage[]> {
    return this.get(sessionId).messages.map((message) => ({ ...message }));
  }

  async *events(sessionId: string): AsyncIterable<AgentEvent> {
    const state = this.get(sessionId);
    if (state.status === "offline") return;
    const queue = new Queue<AgentEvent>(this.buffer);
    state.events.add(queue);
    try { yield* queue; }
    finally { state.events.delete(queue); await queue.return(); }
  }

  async *activityEvents(sessionId: string, options: RuntimeActivityOptions): AsyncIterable<RuntimeActivityEvent> {
    const state = this.get(sessionId);
    if (options.signal.aborted || state.status === "offline") return;
    const queue = new Queue<RuntimeActivityEvent>(this.buffer);
    const abort = () => { void queue.return(); };
    options.signal.addEventListener("abort", abort, { once: true });
    state.activities.add(queue);
    if (state.status === "working" && state.phase) {
      queue.push({ phase: state.phase, observedAt: new Date().toISOString() });
    }
    try { yield* queue; }
    finally {
      options.signal.removeEventListener("abort", abort);
      state.activities.delete(queue);
      await queue.return();
    }
  }

  async stop(sessionId: string): Promise<void> {
    const state = this.get(sessionId);
    this.offline(state, "Claude Code session stopped", true);
    await this.shutdown(state);
  }

  private async shutdown(state: SessionState): Promise<void> {
    if (state.stopping) return state.stopping;
    const operation = (async () => {
      state.inputs.end();
      try { state.query?.close(); }
      finally { state.abort.abort(); }
      if (state.process) {
        await deadline(state.exited.promise, this.shutdownMs, "Claude Code process shutdown is unconfirmed");
      }
    })();
    state.stopping = operation;
    try { await operation; }
    finally { if (state.stopping === operation) state.stopping = undefined; }
  }

  private get(sessionId: string): SessionState {
    const state = this.sessions.get(sessionId);
    if (!state) throw new Error("Unknown Claude Code session");
    return state;
  }

  private async consume(state: SessionState): Promise<void> {
    try {
      for await (const message of state.query!) {
        if (state.status === "offline") break;
        if ("session_id" in message && message.session_id && message.session_id !== state.nativeId) {
          throw new Error("Claude Code session identity mismatch");
        }
        if (state.persistent && message.type === "system" && message.subtype === "init"
          && (message.cwd !== state.session.cwd || message.claude_code_version !== "2.1.321" || message.permissionMode !== state.policy.permissionMode)) {
          throw new Error("Persistent Claude Code launch metadata mismatch");
        }
        this.observe(state, message);
      }
      this.offline(state, "Claude Code stream ended");
    } catch {
      this.offline(state, "Claude Code stream failed; outcome is uncertain");
    } finally {
      // Observe cleanup failures here; explicit stop still reports unconfirmed physical exit.
      await this.shutdown(state).catch(() => {});
    }
  }

  private observe(state: SessionState, message: SDKMessage): void {
    const execution = state.active;
    if (!execution) {
      if (message.type === "result" || (state.persistent && ["assistant", "stream_event", "tool_progress"].includes(message.type))) {
        throw new Error("Unexpected native turn activity");
      }
      return;
    }
    if ("parent_tool_use_id" in message && message.parent_tool_use_id) return;
    if ("user_message_uuid" in message && message.user_message_uuid
      && message.user_message_uuid !== execution.nativeId) throw new Error("Native turn identity mismatch");
    if (message.type === "stream_event") {
      const event = message.event;
      if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
        this.emit(state, { type: "message_delta", delta: event.delta.text });
        this.activity(state, "responding");
      } else if (event.type === "content_block_start" && event.content_block.type === "tool_use") {
        this.toolStarted(state, event.content_block.id, event.content_block.name);
      }
    } else if (message.type === "assistant") {
      const text: string[] = [];
      for (const block of message.message.content) {
        if (block.type === "text") text.push(block.text);
        else if (block.type === "tool_use") this.toolStarted(state, block.id, block.name);
      }
      if (text.length) state.messages.push({ role: "assistant", content: text.join("\n"), timestamp: Date.now() });
    } else if (message.type === "user" && Array.isArray(message.message.content)) {
      for (const block of message.message.content) {
        if (block.type !== "tool_result") continue;
        const toolName = state.tools.get(block.tool_use_id);
        if (!toolName) continue;
        const content = typeof block.content === "string" ? block.content
          : (block.content ?? []).flatMap((part) => part.type === "text" ? [part.text] : []).join("\n");
        state.messages.push({ role: "tool", content, toolName, timestamp: Date.now() });
        this.emit(state, { type: "tool_completed", toolCallId: block.tool_use_id, toolName, isError: block.is_error === true });
        state.tools.delete(block.tool_use_id);
      }
    } else if (message.type === "result") {
      if (execution.interruptRequested) this.finish(state, execution, "interrupted", undefined, undefined, "native");
      else if (execution.failure) this.finish(state, execution, "failed", undefined, execution.failure, "native");
      else if (message.subtype !== "success" || message.is_error) {
        this.finish(state, execution, "failed", undefined, "Claude Code turn failed", "native");
      } else {
        if (typeof message.result !== "string") throw new Error("Invalid Claude Code result");
        const response: RuntimeMessage = { role: "assistant", content: message.result, timestamp: Date.now() };
        const previous = state.messages.at(-1);
        if (message.result && (previous?.role !== "assistant" || previous.content !== message.result)) state.messages.push(response);
        this.finish(state, execution, "completed", response, undefined, "native");
      }
    }
  }

  private toolStarted(state: SessionState, id: string, name: string): void {
    if (state.tools.has(id)) return;
    state.tools.set(id, name);
    this.emit(state, { type: "tool_started", toolCallId: id, toolName: name });
    this.activity(state, "using_tools");
  }

  private finish(state: SessionState, execution: Execution, status: AgentTurn["status"], response?: RuntimeMessage, error?: string,
    evidence: ClaudeCodeSettlementEvidence = "uncertain"): void {
    if (state.active !== execution) return;
    execution.permissionAbort.abort();
    execution.evidence = evidence;
    execution.turn = { ...execution.turn, status, response, error, updatedAt: new Date().toISOString() };
    state.active = undefined;
    state.tools.clear();
    execution.written.resolve();
    execution.done.resolve();
    if (status === "completed") this.emit(state, { type: "turn_completed", operationId: execution.turn.id });
    else if (error) this.emit(state, { type: "error", operationId: execution.turn.id, message: error });
    if (state.status !== "offline") this.setStatus(state, "idle");
    state.phase = undefined;
  }

  private offline(state: SessionState, reason: string, interrupted = false): void {
    if (state.status === "offline") return;
    this.setStatus(state, "offline");
    if (state.active) this.finish(state, state.active, interrupted ? "interrupted" : "failed", undefined, reason,
      state.active.sending ? "uncertain" : "undispatched");
    state.inputs.end();
    for (const queue of state.events) queue.end();
    for (const queue of state.activities) queue.end();
  }

  private setStatus(state: SessionState, status: AgentStatus): void {
    state.status = status;
    this.emit(state, { type: "status", status });
  }

  private emit(state: SessionState, event: EventPayload): void {
    const value = { ...event, sessionId: state.session.id, timestamp: new Date().toISOString() } as AgentEvent;
    for (const queue of state.events) queue.push(value);
  }

  private activity(state: SessionState, phase: RuntimeActivityPhase): void {
    if (state.phase === phase) return;
    state.phase = phase;
    const value = { phase, observedAt: new Date().toISOString() };
    for (const queue of state.activities) queue.push(value);
  }
}
