import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { homedir } from "node:os";
import { performance } from "node:perf_hooks";
import {
  query, type CanUseTool, type McpServerStatus, type Query, type SDKMessage, type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import {
  runtimeInput, type AgentReasoningLevel, type AgentEvent, type AgentRuntime, type AgentSession, type AgentStartConfig,
  type AgentStatus, type AgentTurn, type ManagedAgentSession, type ManagedSessionSummary, type RuntimeActivityEvent, type RuntimeActivityPhase,
  type RuntimeActivityOptions, type RuntimeImageContent, type RuntimeMessage,
  type RuntimeIntegrationSnapshot, type RuntimeLaunchCapabilities, type RuntimeSessionCapabilities, type RuntimeSessionEvents, type RuntimeSessionProfile,
} from "@minu/runtime-core";
import { Queue } from "./queue.js";
import { claudeCodeCapabilities, claudeCodeDiscovery, claudeCodeExpectedModels, claudeCodeSelectionOptions, claudeCodeSkillOptions, claudeCodeSupportsImages,
  validateClaudeCodeSelection, verifyClaudeCodeSelection, withoutMissingSkills } from "./launch-options.js";
import { probeClaudeCode, requireClaudeCodeAuth } from "./probe.js";
import { claudeCodeVersionSupported } from "./native-history.js";
import { claudeCodePermissionOptions, resolveClaudeCodePermissions, type ClaudeCodePermissionPolicy, type ClaudeCodePermissions } from "./permissions.js";
import { claudeCodeNativeEnvironment, resolveClaudeCodeConfigRoot, resolveClaudeCodeExecutable, ClaudeCodeUnsupportedVersionError } from "./native-config.js";

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
  /** Omit to use the installed `claude` found on PATH (like Pi's `pi`); "bundled" selects the SDK's pinned engine; otherwise an
   * explicit path. Nothing is pinned: each launch uses what is installed. */
  executable?: string;
  /** When supplied, replaces (does not merge with) the inherited native environment. */
  env?: Record<string, string | undefined>;
  /** Managed (durable, owner-per-call) sessions: where manifests live. Default ~/.minu/runtime/claude-code (mode 0700, created
   * if missing). Unused by in-process sessions. */
  managedRoot?: string;
  /** Managed sessions only. Omitted resolves as Claude Code does ($CLAUDE_CONFIG_DIR, else ~/.claude). Never created or written. */
  nativeConfigRoot?: string;
  /** Trusted host overrides for managed workers (worker entry / node interpreter / readiness budget), not user-selected commands. */
  workerExecutable?: string;
  nodeExecutable?: string;
  managedTimeoutMs?: number;
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
  /** Engine version recorded at creation; a different major refuses the launch (minor/patch changes are accepted). */
  engineVersion?: string;
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

/** A steering message queued into the live streaming input of the running turn. */
interface Steer { steer: true; uuid: string; text: string; execution: Execution }

interface Execution {
  turn: AgentTurn;
  images: RuntimeImageContent[];
  /** Native message ids / sha256 of steering messages delivered during this turn (their result frames may carry the id). */
  steerIds: Set<string>;
  steerFingerprints: string[];
  digest: string;
  nativeId: ReturnType<typeof randomUUID>;
  sending: boolean;
  written: ReturnType<typeof deferred>;
  done: ReturnType<typeof deferred>;
  interruptRequested: boolean;
  permissionAbort: AbortController;
  evidence: ClaudeCodeSettlementEvidence;
}

interface SessionState {
  session: AgentSession;
  nativeId: string;
  persistent: boolean;
  /** Whether the selected model accepts images, observed at initialization. */
  images: boolean;
  /** system/init must report one of these when a model was requested (undefined: not checkable). */
  expectedModels?: string[];
  /** What the live engine reported (system/init model, discovered skills, launch-verified reasoning). */
  observed: { model?: string; reasoning?: AgentReasoningLevel; skills?: string[] };
  policy: ClaudeCodePermissionPolicy;
  status: AgentStatus;
  query?: Query;
  process?: ChildProcess;
  exited: ReturnType<typeof deferred>;
  abort: AbortController;
  inputs: Queue<Execution | Steer>;
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
  /** Owner-per-call managed API: one durable controller per owner, created lazily; ids learn their owner on start/resume/get/list. */
  private managers = new Map<string, import("./managed-runtime.js").ClaudeCodeManagedRuntime>();
  private managedOwners = new Map<string, string>();
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

  private async manager(ownerId: string) {
    let manager = this.managers.get(ownerId);
    if (!manager) {
      const { ClaudeCodeManagedRuntime } = await import("./managed-runtime.js");
      const requested = resolve(this.options.managedRoot ?? join(homedir(), ".minu", "runtime", "claude-code"));
      await mkdir(requested, { recursive: true, mode: 0o700 });
      // The store requires a canonical root; a HOME or temp dir behind a symlink (macOS /var -> /private/var) must still work.
      const storeRoot = await realpath(requested);
      const { executable, env, startupTimeoutMs, controlTimeoutMs, shutdownTimeoutMs, turnRetentionLimit, eventBufferLimit } = this.options;
      manager = new ClaudeCodeManagedRuntime({ ownerId, storeRoot, permissions: this.options.permissions,
        isolateConfiguration: this.options.isolateConfiguration,
        ...(this.options.nativeConfigRoot !== undefined ? { nativeConfigRoot: this.options.nativeConfigRoot } : {}),
        ...(this.options.workerExecutable !== undefined ? { workerExecutable: this.options.workerExecutable } : {}),
        ...(this.options.nodeExecutable !== undefined ? { nodeExecutable: this.options.nodeExecutable } : {}),
        ...(this.options.managedTimeoutMs !== undefined ? { timeoutMs: this.options.managedTimeoutMs } : {}),
        nativeOptions: { ...(executable !== undefined ? { executable } : {}),
          ...(env ? { env: Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined)) } : {}),
          ...(startupTimeoutMs !== undefined ? { startupTimeoutMs } : {}), ...(controlTimeoutMs !== undefined ? { controlTimeoutMs } : {}),
          ...(shutdownTimeoutMs !== undefined ? { shutdownTimeoutMs } : {}), ...(turnRetentionLimit !== undefined ? { turnRetentionLimit } : {}),
          ...(eventBufferLimit !== undefined ? { eventBufferLimit } : {}) } });
      this.managers.set(ownerId, manager);
    }
    return manager;
  }
  /** The durable controller for a session started/resumed through this runtime, if any. */
  private owned(sessionId: string) {
    const owner = this.managedOwners.get(sessionId);
    return owner === undefined ? undefined : this.managers.get(owner);
  }
  async startManaged(config: AgentStartConfig, ownerId: string): Promise<ManagedAgentSession> {
    const session = await (await this.manager(ownerId)).startManaged(config, ownerId);
    this.managedOwners.set(session.id, ownerId); return session;
  }
  async resume(managedSessionId: string, ownerId: string, options?: { allowStopped?: boolean }): Promise<ManagedAgentSession> {
    const session = await (await this.manager(ownerId)).resume(managedSessionId, ownerId, options);
    this.managedOwners.set(session.id, ownerId); return session;
  }
  async inspectSessionProfile(id: string, ownerId: string, options?: { signal?: AbortSignal }): Promise<RuntimeSessionProfile | undefined> {
    return (await this.manager(ownerId)).inspectSessionProfile(id, ownerId, options);
  }
  async inspectSessionEvents(id: string, ownerId: string, options?: { signal?: AbortSignal }): Promise<RuntimeSessionEvents | undefined> {
    return (await this.manager(ownerId)).inspectSessionEvents(id, ownerId, options);
  }
  async inspectSessionIntegrations(id: string, ownerId: string, options?: { signal?: AbortSignal }): Promise<RuntimeIntegrationSnapshot | undefined> {
    return (await this.manager(ownerId)).inspectSessionIntegrations(id, ownerId, options);
  }
  async suspend(managedSessionId: string, ownerId: string): Promise<void> { await (await this.manager(ownerId)).suspend(managedSessionId, ownerId); }
  async forceStopManaged(managedSessionId: string, ownerId: string): Promise<void> { await (await this.manager(ownerId)).forceStopManaged(managedSessionId, ownerId); }
  async destroy(managedSessionId: string, ownerId: string): Promise<void> {
    await (await this.manager(ownerId)).destroy(managedSessionId, ownerId); this.managedOwners.delete(managedSessionId);
  }
  async getManagedSession(managedSessionId: string, ownerId: string, options?: { signal?: AbortSignal }): Promise<ManagedSessionSummary | undefined> {
    const summary = await (await this.manager(ownerId)).getManagedSession(managedSessionId, ownerId, options);
    if (summary) this.managedOwners.set(managedSessionId, ownerId);
    return summary;
  }
  async listManagedSessions(ownerId: string, options?: { signal?: AbortSignal }): Promise<ManagedSessionSummary[]> {
    const sessions = await (await this.manager(ownerId)).listManagedSessions(ownerId, options);
    for (const session of sessions) this.managedOwners.set(session.id, ownerId);
    return sessions;
  }

  /** Short-lived, prompt-less probe for this cwd: models, effort levels and skills as the user's own native setup reports
   * them. Never dispatches input and closes with confirmed process exit. */
  async capabilities(config: Pick<AgentStartConfig, "cwd"> = {}): Promise<RuntimeLaunchCapabilities> {
    const cwd = await realpath(config.cwd ?? process.cwd());
    if (!(await stat(cwd)).isDirectory()) throw new Error("Workspace must be a directory");
    const probe = await requireClaudeCodeAuth({ cwd, executable: this.options.executable,
      env: Object.fromEntries(Object.entries(this.options.env ?? claudeCodeNativeEnvironment()).filter((entry): entry is [string, string] => entry[1] !== undefined)),
      isolate: this.options.isolateConfiguration, startupTimeoutMs: this.startupMs, shutdownTimeoutMs: this.shutdownMs });
    return claudeCodeCapabilities(probe);
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
    // No silent model/effort fallback: unsupported selections are refused (shape here, support after initialization).
    validateClaudeCodeSelection(config);
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
        canonicalCwd: cwd, nativeConfigRoot: root, nativeRoot: native.nativeRoot, acceptQueuedDeliveries: native.nativeRoot, signal: native.signal });
      if (native.mode === "resume") {
        if (snapshot.state !== "present") throw new Error("Mapped Claude Code native history is missing");
        history = snapshot.messages;
      } else if (snapshot.state === "present") throw new Error("Claude Code native history already exists; creation refused");
      native.signal?.throwIfAborted();
    }
    const policy = resolveClaudeCodePermissions(this.options.permissions);
    const executable = await resolveClaudeCodeExecutable(this.options.executable, launchEnv ?? process.env);
    if (config.skillIds?.length) {
      config = withoutMissingSkills(config, await probeClaudeCode({ cwd, executable,
        env: Object.fromEntries(Object.entries(launchEnv ?? process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)),
        startupTimeoutMs: this.startupMs, shutdownTimeoutMs: this.shutdownMs, isolate: this.options.isolateConfiguration, signal: native?.signal }));
    }
    const id = native?.runtimeSessionId ?? randomUUID();
    if (this.sessions.has(id) || this.starting.has(id)) throw new Error("Claude Code Runtime identity is already in use");
    this.starting.add(id);
    const state: SessionState = {
      session: { id, runtime: "claude-code", ownership: "owned", cwd },
      nativeId: native?.nativeSessionId ?? id, persistent: !!native, policy, images: false, observed: {},
      status: "idle", abort: new AbortController(), exited: deferred(),
      inputs: new Queue<Execution | Steer>(this.retention), turns: new Map(), messages: history.map(message => ({ ...message })), tools: new Map(),
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
          pathToClaudeCodeExecutable: executable, env: launchEnv,
          systemPrompt: config.systemPrompt ?? {
            type: "preset", preset: "claude_code", append: config.appendSystemPrompt,
          },
          ...claudeCodePermissionOptions(policy, this.options.tools),
          ...claudeCodeSelectionOptions(config), ...claudeCodeSkillOptions(config),
          // bypassPermissions auto-approves before the callback is consulted (the SDK warns), so none is registered.
          ...(policy.permissionMode === "bypassPermissions" ? {}
            : { canUseTool: (name: string, input: Record<string, unknown>, options: Parameters<CanUseTool>[2]) => this.permissionDecision(state, name, input, options) }),
          // Headless: no dialog renderer. Never invent an answer; like Pi, the owned session goes offline (shared contract).
          onUserDialog: async () => {
            this.offline(state, "Claude Code requested unsupported interactive input");
            await this.shutdown(state);
            throw new Error("Claude Code interactive input is unsupported by Runtime");
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
      const discovery = claudeCodeDiscovery(initialized);
      verifyClaudeCodeSelection(config, discovery);
      state.images = claudeCodeSupportsImages(config, discovery);
      state.expectedModels = claudeCodeExpectedModels(config, discovery);
      state.observed.skills = config.skillIds ? [...config.skillIds] : discovery.skills.map(skill => skill.name);
      if (config.reasoningLevel) state.observed.reasoning = config.reasoningLevel; // Verified against the engine at launch.
      if (native && !claudeCodeVersionSupported(initialized.claude_code_version)) throw new ClaudeCodeUnsupportedVersionError();
      if (native?.engineVersion && String(initialized.claude_code_version).split(".")[0] !== native.engineVersion.split(".")[0]) {
        throw new Error("Persistent Claude Code engine major version changed");
      }
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
    for await (const item of state.inputs) {
      if (state.status === "offline") continue;
      if ("steer" in item) {
        // Delivered by the engine at its next native boundary, inside the running turn.
        if (state.active !== item.execution) continue;
        yield { type: "user", session_id: state.nativeId, parent_tool_use_id: null, uuid: item.uuid as ReturnType<typeof randomUUID>,
          priority: "next", message: { role: "user", content: item.text } };
        continue;
      }
      const execution = item;
      if (state.active !== execution) continue;
      execution.sending = true;
      yield {
        type: "user", session_id: state.nativeId, parent_tool_use_id: null,
        uuid: execution.nativeId, message: { role: "user", content: execution.images.length ? [
          ...(execution.turn.input ? [{ type: "text" as const, text: execution.turn.input }] : []),
          ...execution.images.map(image => ({ type: "image" as const, source: { type: "base64" as const, media_type: image.mimeType, data: image.data } })),
        ] : execution.turn.input },
      };
      // The SDK requests the next item only after the previous transport write settles.
      execution.written.resolve();
    }
  }

  async send(sessionId: string, input: string, images?: RuntimeImageContent[]): Promise<void> {
    { const m = this.owned(sessionId); if (m) return m.send(sessionId, input, images); }
    const turn = await this.startTurn(sessionId, randomUUID(), input, images);
    const state = this.get(sessionId);
    const execution = state.turns.get(turn.id)!;
    await execution.done.promise;
    if (execution.turn.status !== "completed") {
      throw new Error(execution.turn.error ?? `Claude Code turn ${execution.turn.status}`);
    }
  }

  async startTurn(sessionId: string, turnId: string, input: string, images?: RuntimeImageContent[]): Promise<AgentTurn> {
    { const m = this.owned(sessionId); if (m) return m.startTurn(sessionId, turnId, input, images); }
    return this.acceptTurn(sessionId, turnId, input, images);
  }

  /** Supplied UUID lets an admitted worker persist exact dispatch intent before calling this. */
  protected async acceptTurn(sessionId: string, turnId: string, input: string, images?: RuntimeImageContent[], nativeMessageId?: string): Promise<AgentTurn> {
    if (nativeMessageId !== undefined && !NATIVE_UUID.test(nativeMessageId)) throw new Error("Invalid native message identity");
    const normalized = runtimeInput(input, images);
    if (typeof turnId !== "string" || !turnId.trim() || Buffer.byteLength(turnId) > 256) {
      throw new Error("Turn id must be nonempty and at most 256 bytes");
    }
    const state = this.get(sessionId);
    if (normalized.images.length && !state.images) throw new Error("Claude Code image input is not supported by the selected model");
    const digest = createHash("sha256").update(JSON.stringify([normalized.input, normalized.images.map(image => createHash("sha256").update(image.mimeType).update("\0").update(image.data).digest("hex"))])).digest("hex");
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
      images: normalized.images, steerIds: new Set(), steerFingerprints: [],
      digest, nativeId: (nativeMessageId ?? randomUUID()) as ReturnType<typeof randomUUID>, sending: false, written: deferred(), done: deferred(),
      interruptRequested: false, permissionAbort: new AbortController(), evidence: "uncertain",
    };
    state.turns.set(turnId, execution);
    state.active = execution;
    // Same projection as native history: pixels never enter text, only a placeholder.
    state.messages.push({ role: "user", content: [input, ...normalized.images.map(() => "[image]")].filter(Boolean).join("\n"), timestamp: Date.now() });
    this.setStatus(state, "working");
    this.emit(state, { type: "turn_started", operationId: turnId });
    this.activity(state, "working");
    state.inputs.push(execution);
    return copyTurn(execution.turn);
  }

  async turn(sessionId: string, turnId: string): Promise<AgentTurn | undefined> {
    { const m = this.owned(sessionId); if (m) return m.turn(sessionId, turnId); }
    const turn = this.get(sessionId).turns.get(turnId)?.turn;
    return turn && copyTurn(turn);
  }

  /** Live-engine observations for one session (model from system/init; nothing is promised before the first turn). */
  protected observedProfile(sessionId: string) { return { ...this.get(sessionId).observed }; }
  /** One bounded read of the engine's MCP server status. */
  protected async integrationStatuses(sessionId: string): Promise<McpServerStatus[]> {
    const state = this.get(sessionId);
    if (state.status === "offline" || !state.query) throw new Error("Claude Code session is offline");
    return deadline(state.query.mcpServerStatus(), Math.min(this.controlMs, 2_000), "Claude Code integration read timed out");
  }

  /** Observation only; never derive this from resumed textual history. */
  protected settlementEvidence(sessionId: string, turnId: string): ClaudeCodeSettlementEvidence | undefined {
    return this.get(sessionId).turns.get(turnId)?.evidence;
  }

  /** Queues a user message into the live streaming input while a turn is running; the engine folds it in at its next
   * native boundary (the turn still has one result). Never starts a turn and never replays. */
  async steer(sessionId: string, input: string): Promise<void> {
    { const m = this.owned(sessionId); if (m) return m.steer(sessionId, input); }
    const state = this.get(sessionId), text = runtimeInput(input, undefined).input;
    const execution = state.active;
    if (state.status === "offline") throw new Error("Claude Code session is offline");
    if (!execution || state.status !== "working" || execution.interruptRequested || state.control || !execution.sending) {
      throw new Error("Claude Code session has no running turn to steer");
    }
    const uuid = randomUUID();
    execution.steerIds.add(uuid); execution.steerFingerprints.push(createHash("sha256").update(text).digest("hex"));
    state.messages.push({ role: "user", content: text, timestamp: Date.now() });
    state.inputs.push({ steer: true, uuid, text, execution });
  }

  /** Observation only: steering messages sent during that turn (sha256), for exact history eligibility. */
  protected steerFingerprints(sessionId: string, turnId: string): string[] {
    return [...(this.get(sessionId).turns.get(turnId)?.steerFingerprints ?? [])];
  }

  async interrupt(sessionId: string): Promise<void> {
    { const m = this.owned(sessionId); if (m) return m.interrupt(sessionId); }
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

  async status(sessionId: string): Promise<AgentStatus> { const m = this.owned(sessionId); return m ? m.status(sessionId) : this.get(sessionId).status; }

  async inputCapabilities(sessionId: string): Promise<{ version: 1; images: boolean }> {
    { const m = this.owned(sessionId); if (m) return m.inputCapabilities(sessionId); }
    return { version: 1, images: this.get(sessionId).images };
  }

  async sessionCapabilities(sessionId: string): Promise<RuntimeSessionCapabilities> {
    { const m = this.owned(sessionId); if (m) return m.sessionCapabilities(sessionId); }
    const live = this.get(sessionId).status !== "offline";
    return { version: 1, safeActivityEvents: live, interrupt: live, reconnectExisting: false,
      interactiveAttach: false, openDiagnostic: false, liveSkillVerification: false };
  }

  async messages(sessionId: string): Promise<RuntimeMessage[]> {
    { const m = this.owned(sessionId); if (m) return m.messages(sessionId); }
    return this.get(sessionId).messages.map((message) => ({ ...message }));
  }

  async *events(sessionId: string): AsyncIterable<AgentEvent> {
    { const m = this.owned(sessionId); if (m) { yield* m.events(sessionId); return; } }
    const state = this.get(sessionId);
    if (state.status === "offline") return;
    const queue = new Queue<AgentEvent>(this.buffer);
    state.events.add(queue);
    try { yield* queue; }
    finally { state.events.delete(queue); await queue.return(); }
  }

  async *activityEvents(sessionId: string, options: RuntimeActivityOptions): AsyncIterable<RuntimeActivityEvent> {
    { const m = this.owned(sessionId); if (m) { yield* m.activityEvents(sessionId, options); return; } }
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
    { const m = this.owned(sessionId); if (m) return m.suspend(sessionId, this.managedOwners.get(sessionId)!); }
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
          && (message.cwd !== state.session.cwd || !claudeCodeVersionSupported(message.claude_code_version) || message.permissionMode !== state.policy.permissionMode)) {
          throw new Error("Persistent Claude Code launch metadata mismatch");
        }
        if (message.type === "system" && message.subtype === "init") {
          // Fail closed if the engine ran a different model than the one requested.
          if (state.expectedModels && !state.expectedModels.includes(String(message.model))) throw new Error("Claude Code model mismatch");
          if (typeof message.model === "string") state.observed.model = message.model;
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
      && message.user_message_uuid !== execution.nativeId && !execution.steerIds.has(message.user_message_uuid)) throw new Error("Native turn identity mismatch");
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
