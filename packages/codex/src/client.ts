import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { realpath } from "node:fs/promises";
import type {
  AgentEvent, AgentRuntime, AgentSession, AgentStartConfig, AgentStatus, AgentTurn, ManagedAgentSession, ManagedSessionSummary,
  RuntimeActivityEvent, RuntimeActivityOptions, RuntimeImageContent, RuntimeInputCapabilities,
  RuntimeMessage, RuntimeSessionCapabilities, RuntimeLaunchCapabilities, RuntimeSessionProfile, RuntimeSessionEvents,
} from "@minu/runtime-core";
import { runtimeInput, RUNTIME_INPUT_LIMITS, sessionProfile } from "@minu/runtime-core";
import { finalResponse, normalizeCodexItem, toolName } from "./messages.js";
import { CodexRpcProcess, CodexRpcResponseError, record, type CodexNotification, type CodexRpcOptions } from "./rpc.js";
import { readNativeHistory, readNativeCheckpoint, type CodexHistoryCheckpoint, validateNativeResume, validateNativeThreadId } from "./native-resume.js";
import { CodexManagedClient } from "./managed-client.js";
import { EVENT_LIMITS, safeCodexActivity } from "./event-stream.js";
import { validateCodexConfig, publicId, reasoning, nativeModels, skillOverrides, discoverNativeLaunch, type NativeModel } from "./native-capabilities.js";
import { codexInputFingerprint, nativeInput } from "./input.js";

type EventPayload<T = AgentEvent> = T extends AgentEvent ? Omit<T, "sessionId" | "timestamp"> : never;

export class CodexSessionBusyError extends Error {}
export class CodexSessionOfflineError extends Error {}
/** @internal Raised only before input admission/native dispatch. */
export class CodexInputRejectedError extends Error {}

/** @internal Retain shutdown authority when startup fails before a session is registered. */
export class CodexNativeStartupCleanupError extends Error {
  constructor(readonly stop: () => Promise<void>) {
    super("Codex startup failed; native exit could not be confirmed");
  }
}

const NATIVE_SANDBOX = { "read-only": "readOnly", "workspace-write": "workspaceWrite", "danger-full-access": "dangerFullAccess" } as const;

export interface CodexAgentRuntimeOptions extends CodexRpcOptions {
  /** Default is read-only. "danger-full-access" lets Codex change anything the user account can, without approvals. */
  sandbox?: "read-only" | "workspace-write" | "danger-full-access";
  turnRetentionLimit?: number;
  /** Owner-private managed storage; defaults to ~/.minu/runtime-codex/managed. */
  managedRoot?: string;
}

class EventStream implements AsyncIterableIterator<AgentEvent> {
  private readonly queue: Array<{ event: AgentEvent; bytes: number }> = [];
  private bytes = 0;
  private readonly waiters: Array<{ resolve(value: IteratorResult<AgentEvent>): void; reject(error: Error): void }> = [];
  private closed = false;
  private error?: Error;
  constructor(private readonly remove: () => void) {}
  [Symbol.asyncIterator](): AsyncIterableIterator<AgentEvent> { return this; }
  next(): Promise<IteratorResult<AgentEvent>> {
    if (this.error) return Promise.reject(this.error);
    const queued = this.queue.shift();
    if (queued) { this.bytes -= queued.bytes; return Promise.resolve({ value: queued.event, done: false }); }
    if (this.closed) return Promise.resolve({ value: undefined, done: true });
    return new Promise((resolve, reject) => { this.waiters.push({ resolve, reject }); });
  }
  push(event: AgentEvent): void {
    if (this.closed) return;
    const waiter = this.waiters.shift();
    if (waiter) waiter.resolve({ value: { ...event }, done: false });
    else {
      const bytes = Buffer.byteLength(JSON.stringify(event));
      if (this.queue.length < EVENT_LIMITS.frames && this.bytes + bytes <= EVENT_LIMITS.bytes) {
        this.queue.push({ event: { ...event }, bytes }); this.bytes += bytes; return;
      }
      this.error = new Error("Codex event consumer fell behind; reconnect to observe new events");
      void this.return();
    }
  }
  close(): void {
    this.closed = true;
    this.remove();
    for (const waiter of this.waiters.splice(0)) {
      if (this.error) waiter.reject(this.error);
      else waiter.resolve({ value: undefined, done: true });
    }
  }
  return(): Promise<IteratorResult<AgentEvent>> {
    this.queue.length = 0;
    this.bytes = 0;
    this.close();
    return Promise.resolve({ value: undefined, done: true });
  }
}

interface Execution {
  turn: AgentTurn;
  fingerprint: string;
  hasImages: boolean;
  nativeId?: string;
  buffered: CodexNotification[];
  bufferedBytes: number;
  items: Map<string, Record<string, unknown>>;
  started: Promise<void>;
  done: Promise<void>;
  settle(): void;
}

interface Session {
  public: AgentSession;
  rpc: CodexRpcProcess;
  threadId: string;
  model: string;
  provider?: string;
  metadata?: NativeModel;
  effort?: string;
  state: AgentStatus;
  stopping: boolean;
  turns: Map<string, Execution>;
  active?: Execution;
  history: RuntimeMessage[];
  streams: Set<EventStream>;
}

function copyTurn(turn: AgentTurn): AgentTurn {
  return { ...turn, ...(turn.response ? { response: { ...turn.response } } : {}) };
}

function checkedInput(input: string, images?: RuntimeImageContent[]): string {
  return runtimeInput(input, images).input;
}

/** Owned Codex execution plus bounded owner-authorized managed entry/reconnect. */
export class CodexAgentRuntime implements AgentRuntime {
  private readonly sessions = new Map<string, Session>();
  private readonly options: CodexAgentRuntimeOptions;
  private readonly retention: number;
  private readonly managed: CodexManagedClient;

  constructor(options: CodexAgentRuntimeOptions = {}) {
    this.options = { ...options, ...(options.args ? { args: [...options.args] } : {}) };
    this.retention = options.turnRetentionLimit ?? 1_000;
    if (!Number.isSafeInteger(this.retention) || this.retention < 1) throw new RangeError("turnRetentionLimit must be a positive integer");
    if (options.sandbox !== undefined && options.sandbox !== "read-only" && options.sandbox !== "workspace-write" && options.sandbox !== "danger-full-access") {
      throw new Error("Codex Runtime only supports read-only, workspace-write or danger-full-access sandboxing");
    }
    this.managed = new CodexManagedClient(this.options, id => this.sessions.has(id));
  }

  async capabilities(config: Pick<AgentStartConfig, "cwd"> = {}): Promise<RuntimeLaunchCapabilities> {
    let cwd: string, rpc: CodexRpcProcess;
    try { cwd = await realpath(resolve(config.cwd ?? process.cwd())); rpc = new CodexRpcProcess(cwd, this.options); }
    catch { throw new Error("Codex launch discovery is unavailable"); }
    let result: RuntimeLaunchCapabilities | undefined;
    try { await rpc.initialize(); result = await discoverNativeLaunch(rpc, cwd); }
    catch { /* No guessed defaults or discovery retry. */ }
    try { await rpc.stop(); } catch { throw new CodexNativeStartupCleanupError(() => rpc.stop()); }
    if (!result) throw new Error("Codex launch discovery is unavailable");
    return result;
  }

  async start(config: AgentStartConfig = {}): Promise<AgentSession> {
    return this.open(config);
  }

  async startManaged(config: AgentStartConfig, ownerId: string): Promise<ManagedAgentSession> {
    return this.managed.create(config, ownerId, this.options.sandbox ?? "read-only");
  }

  async suspend(id: string, ownerId: string): Promise<void> { return this.managed.suspend(id, ownerId); }
  async forceStopManaged(id: string, ownerId: string): Promise<void> { return this.managed.forceStop(id, ownerId); }
  async destroy(id: string, ownerId: string): Promise<void> { return this.managed.destroy(id, ownerId); }

  /** @internal Inspection creates no thread and dispatches no user input. */
  async inspectNativeHistory(threadId: string, cwd: string): Promise<CodexHistoryCheckpoint> {
    validateNativeThreadId(threadId);
    if (await realpath(cwd) !== cwd) throw new Error("Codex inspection workspace is redirected");
    const rpc = new CodexRpcProcess(cwd, this.options);
    try {
      await rpc.initialize(); await validateNativeResume(rpc, threadId, cwd);
      return await readNativeCheckpoint(rpc, threadId);
    } finally { await rpc.stop(); }
  }

  /** @internal Called only after managed admission has been sealed. */
  async nativeHistoryCheckpoint(id: string): Promise<CodexHistoryCheckpoint> {
    const session = this.session(id);
    if (session.stopping || session.state !== "idle") throw new Error("Codex checkpoint requires idle native execution");
    const value = await readNativeCheckpoint(session.rpc, session.threadId, structuredClone(session.history));
    if (session.stopping || session.state !== "idle") throw new Error("Codex checkpoint changed during observation");
    return value;
  }

  /** @internal Exact owned native process state; never launch settings/discovery. */
  nativeSessionProfile(id: string): RuntimeSessionProfile {
    const session = this.session(id);
    if (session.stopping || session.state === "offline") throw new CodexSessionOfflineError("Codex session is offline");
    const level = reasoning(session.effort);
    return sessionProfile({ version: 1, capturedAt: new Date().toISOString(),
      model: publicId(session.provider) && publicId(session.model) ? { status: "verified", provider: session.provider, id: session.model } : { status: "not_verified" },
      reasoning: level ? { status: "verified", level } : { status: "not_verified" }, skills: { status: "not_verified" } });
  }

  async inspectSessionProfile(id: string, ownerId: string, options: { signal?: AbortSignal } = {}): Promise<RuntimeSessionProfile | undefined> {
    return this.managed.inspectProfile(id, ownerId, options.signal);
  }
  async inspectSessionEvents(id: string, ownerId: string, options: { signal?: AbortSignal } = {}): Promise<RuntimeSessionEvents | undefined> {
    return this.managed.inspectEvents(id, ownerId, options.signal);
  }
  async openDiagnostic(id: string): Promise<void> { return this.managed.openDiagnostic(id); }

  async listManagedSessions(ownerId: string): Promise<ManagedSessionSummary[]> {
    return this.managed.inventory(ownerId);
  }
  /** Owner-scoped summary of one session; undefined when it does not exist for this owner. */
  async getManagedSession(id: string, ownerId: string, options: { signal?: AbortSignal } = {}): Promise<ManagedSessionSummary | undefined> {
    options.signal?.throwIfAborted();
    return (await this.managed.inventory(ownerId, id))[0];
  }

  /** Connect to an existing living worker only; never launch or cold-resume. */
  async connectManaged(id: string, ownerId: string): Promise<ManagedAgentSession> { return this.managed.connect(id, ownerId); }

  async resume(id: string, ownerId: string, options?: { allowStopped?: boolean }): Promise<ManagedAgentSession> {
    // Fenced material is cleared only for a force-stopped slot, on explicit request, where a fresh launch is already permitted.
    return this.managed.resume(id, ownerId, options?.allowStopped === true);
  }

  /** @internal Native worker primitive, not owner-scoped managed resume.
   * The lifecycle controller must authorize and fence the persisted mapping.
   */
  async resumeNativeThread(threadId: string, config: AgentStartConfig): Promise<AgentSession> {
    validateNativeThreadId(threadId);
    return this.open(config, threadId);
  }

  /** @internal One-shot managed allocation. The caller must persist creation intent
   * first, bind the returned native identity before input, and own worker fencing.
   */
  async createNativeThread(config: AgentStartConfig): Promise<{ session: AgentSession; threadId: string }> {
    const session = await this.open(config, undefined, true);
    return { session, threadId: this.session(session.id).threadId };
  }

  private async open(config: AgentStartConfig, threadId?: string, managedCreation = false): Promise<AgentSession> {
    config = structuredClone(config);
    validateCodexConfig(config);
    const effort = config.reasoningLevel === "off" ? "none" : config.reasoningLevel;
    const requestedCwd = resolve(config.cwd ?? process.cwd());
    const verifyNative = Boolean(threadId) || managedCreation;
    const cwd = verifyNative ? await realpath(requestedCwd) : requestedCwd;
    if (verifyNative && cwd !== requestedCwd) throw new Error("Codex native workspace is redirected");
    const rpc = new CodexRpcProcess(cwd, this.options);
    let session: Session | undefined;
    let failure: Error | undefined;
    rpc.onFailure = (error) => {
      failure = error;
      if (session) this.offline(session, error);
    };
    try {
      await rpc.initialize();
      const sandbox = this.options.sandbox ?? "read-only";
      if (threadId) await validateNativeResume(rpc, threadId, cwd);
      const overrides = config.skillIds === undefined ? {} : await skillOverrides(rpc, cwd, config.skillIds);
      const method = threadId ? "thread/resume" : "thread/start";
      const response = record(await rpc.request(method, {
        ...(threadId ? { threadId, excludeTurns: true } : managedCreation ? { ephemeral: false } : {}),
        cwd, approvalPolicy: "never", sandbox,
        ...(config.systemPrompt !== undefined ? { baseInstructions: config.systemPrompt } : {}),
        ...(config.appendSystemPrompt !== undefined ? { developerInstructions: config.appendSystemPrompt } : {}),
        ...(config.model ? { model: config.model.id, modelProvider: config.model.provider } : {}),
        ...((effort || config.skillIds !== undefined) ? { config: { ...overrides, ...(effort ? { model_reasoning_effort: effort } : {}) } } : {}),
      }));
      const thread = record(response?.thread);
      if (!thread || typeof thread.id !== "string" || !thread.id || typeof response?.model !== "string") throw new Error(`Invalid Codex ${method} response`);
      if (verifyNative) {
        validateNativeThreadId(thread.id);
        if ((threadId !== undefined && thread.id !== threadId) || response.cwd !== cwd || thread.cwd !== cwd
          || thread.ephemeral !== false || record(thread.status)?.type !== "idle") {
          throw new Error("Codex did not open the exact idle thread and workspace");
        }
      }
      if (response.approvalPolicy !== "never" || record(response.sandbox)?.type !== NATIVE_SANDBOX[sandbox]) {
        throw new Error("Codex did not apply the requested execution policy");
      }
      if (config.model && (response.model !== config.model.id || response.modelProvider !== config.model.provider)) {
        throw new Error("Codex did not apply the exact requested model");
      }
      if (effort && response.reasoningEffort !== effort) throw new Error("Codex did not apply the requested reasoning level");
      const history = threadId ? await readNativeHistory(rpc, threadId) : [];
      const metadata = (await nativeModels(rpc).catch(() => undefined))?.find(model => model.id === response.model);
      if (config.reasoningLevel !== undefined && metadata && !metadata.levels.includes(config.reasoningLevel)) throw new Error("Requested Codex model reasoning is unsupported");
      if (failure) throw failure;
      const publicSession: AgentSession = { id: randomUUID(), runtime: "codex", ownership: "owned", cwd };
      if (this.sessions.has(publicSession.id) || this.managed.hasIdentity(publicSession.id)) throw new Error("Codex Runtime session identity collision");
      session = {
        public: publicSession, rpc, threadId: thread.id, model: response.model, metadata,
        ...(typeof response.modelProvider === "string" ? { provider: response.modelProvider } : {}),
        ...(typeof response.reasoningEffort === "string" ? { effort: response.reasoningEffort } : {}),
        state: "idle", stopping: false, turns: new Map(), history, streams: new Set(),
      };
      const live = session;
      rpc.onNotification = (event) => this.notification(live, event);
      this.sessions.set(publicSession.id, session);
      return { ...publicSession };
    } catch (error) {
      try { await rpc.stop(); }
      catch { throw new CodexNativeStartupCleanupError(() => rpc.stop()); }
      if (error instanceof CodexRpcResponseError) throw new Error("Codex native launch request failed");
      throw error;
    }
  }

  async send(sessionId: string, input: string, images?: RuntimeImageContent[]): Promise<void> {
    const content = runtimeInput(input, images);
    if (this.managed.has(sessionId)) return this.managed.send(sessionId, content.input, content.images);
    const execution = this.accept(this.session(sessionId), randomUUID(), content.input, content.images);
    await execution.done;
    if (execution.turn.status !== "completed") throw new Error(execution.turn.error ?? `Codex turn ${execution.turn.status}`);
  }

  async startTurn(sessionId: string, turnId: string, input: string, images?: RuntimeImageContent[]): Promise<AgentTurn> {
    if (typeof turnId !== "string" || !turnId.trim() || Buffer.byteLength(turnId) > 256) throw new Error("A turn id of at most 256 bytes is required");
    const content = runtimeInput(input, images);
    if (this.managed.has(sessionId)) return this.managed.request<AgentTurn>(sessionId, "startTurn", { turnId, input: content.input, ...(content.images.length ? { images: content.images } : {}) });
    return copyTurn(this.accept(this.session(sessionId), turnId, content.input, content.images).turn);
  }

  async turn(sessionId: string, turnId: string): Promise<AgentTurn | undefined> {
    if (this.managed.has(sessionId)) return this.managed.turn(sessionId, turnId);
    const turn = this.session(sessionId).turns.get(turnId)?.turn;
    return turn ? copyTurn(turn) : undefined;
  }

  async steer(sessionId: string, input: string): Promise<void> {
    if (this.managed.has(sessionId)) { await this.managed.request(sessionId, "steer", { input: checkedInput(input) }); return; }
    const session = this.session(sessionId);
    const message = checkedInput(input);
    const execution = this.working(session);
    await execution.started;
    if (session.active !== execution || !execution.nativeId) throw new CodexSessionBusyError("Codex turn has already settled");
    await session.rpc.request("turn/steer", {
      threadId: session.threadId, expectedTurnId: execution.nativeId,
      input: [{ type: "text", text: message, text_elements: [] }],
    });
  }

  async interrupt(sessionId: string): Promise<void> {
    if (this.managed.has(sessionId)) { await this.managed.request(sessionId, "interrupt"); return; }
    const session = this.session(sessionId);
    const execution = this.working(session);
    await execution.started;
    if (session.active !== execution || !execution.nativeId) return;
    await session.rpc.request("turn/interrupt", { threadId: session.threadId, turnId: execution.nativeId });
    // Only the native terminal notification settles work; acknowledgment is not completion.
  }

  async status(sessionId: string): Promise<AgentStatus> {
    return this.managed.has(sessionId) ? this.managed.status(sessionId) : this.session(sessionId).state;
  }
  async messages(sessionId: string): Promise<RuntimeMessage[]> {
    if (this.managed.has(sessionId)) return this.managed.request<RuntimeMessage[]>(sessionId, "messages");
    return this.session(sessionId).history.map((message) => ({ ...message }));
  }
  async inputCapabilities(sessionId: string): Promise<RuntimeInputCapabilities> {
    if (this.managed.has(sessionId)) {
      const result = record(await this.managed.request(sessionId, "inputCapabilities"));
      if (result?.version !== 1 || typeof result.images !== "boolean") throw new Error("Codex live input capabilities are unavailable");
      return { version: 1, images: result.images };
    }
    const session = this.session(sessionId);
    if (session.stopping || session.state === "offline") throw new CodexSessionOfflineError("Codex session is offline");
    // This is the metadata verified for the actual opened model, not saved
    // launch config. Every turn pins that model; rerouting seals the session.
    // A live observation must not send a deadline-bearing RPC that can stop work.
    if (session.metadata?.images === undefined) throw new Error("Codex live input capabilities are unavailable");
    return { version: 1, images: session.metadata.images };
  }
  async sessionCapabilities(sessionId: string): Promise<RuntimeSessionCapabilities> {
    if (this.managed.has(sessionId)) {
      const value = record(await this.managed.request(sessionId, "sessionCapabilities"));
      if (value?.version !== 1 || ["safeActivityEvents", "interrupt", "reconnectExisting", "interactiveAttach", "openDiagnostic", "liveSkillVerification"].some(key => typeof value[key] !== "boolean")) throw new Error("Codex live session capabilities are unavailable");
      return { version: 1, safeActivityEvents: await this.managed.supportsEvents(sessionId), reconnectExisting: true,
        interrupt: value.interrupt as boolean, interactiveAttach: value.interactiveAttach as boolean,
        openDiagnostic: value.openDiagnostic === true && await this.managed.supportsDiagnostic(sessionId), liveSkillVerification: value.liveSkillVerification as boolean };
    }
    const session = this.session(sessionId);
    if (session.stopping || session.state === "offline") throw new CodexSessionOfflineError("Codex session is offline");
    return { version: 1, safeActivityEvents: true, interrupt: true, reconnectExisting: false, interactiveAttach: false, openDiagnostic: false, liveSkillVerification: false };
  }

  events(sessionId: string): AsyncIterableIterator<AgentEvent> {
    if (this.managed.has(sessionId)) return this.managed.events(sessionId);
    const session = this.session(sessionId);
    const stream = new EventStream(() => session.streams.delete(stream));
    if (session.state === "offline") void stream.return();
    else session.streams.add(stream);
    return stream;
  }

  activityEvents(sessionId: string, options: RuntimeActivityOptions): AsyncIterableIterator<RuntimeActivityEvent> {
    return safeCodexActivity(() => this.events(sessionId), options.signal);
  }

  async stop(sessionId: string): Promise<void> {
    if (this.managed.has(sessionId)) return this.managed.stop(sessionId);
    const session = this.session(sessionId);
    session.stopping = true;
    this.setStatus(session, "offline");
    await session.rpc.stop();
  }

  private session(id: string): Session {
    const session = this.sessions.get(id);
    if (!session) throw new CodexSessionOfflineError("Unknown Codex Runtime session");
    return session;
  }
  private working(session: Session): Execution {
    if (session.state !== "working" || !session.active || session.stopping) throw new CodexSessionBusyError("Codex session must be working");
    return session.active;
  }

  private accept(session: Session, id: string, input: string, images: RuntimeImageContent[] = []): Execution {
    const fingerprint = codexInputFingerprint(input, images);
    const existing = session.turns.get(id);
    if (existing) {
      if (existing.fingerprint !== fingerprint) throw new Error("Turn id conflicts with different input");
      return existing;
    }
    if (session.state === "offline" || session.stopping) throw new CodexSessionOfflineError("Codex session is offline");
    if (session.active) throw new CodexSessionBusyError("Codex session is working");
    if (images.length && session.metadata?.images !== true) throw new CodexInputRejectedError(session.metadata?.images === false ? "Codex model does not support images" : "Codex model vision support is unverified");
    const now = new Date().toISOString();
    let settle!: () => void;
    const execution: Execution = {
      turn: { id, input, status: "running", createdAt: now, updatedAt: now }, fingerprint, hasImages: images.length > 0,
      buffered: [], bufferedBytes: 0, items: new Map(), started: Promise.resolve(),
      done: new Promise((resolve) => { settle = resolve; }), settle: () => settle(),
    };
    session.turns.set(id, execution);
    session.active = execution;
    session.history.push({ role: "user", content: input });
    this.setStatus(session, "working");
    this.publish(session, { type: "turn_started", operationId: id });
    execution.started = this.dispatch(session, execution, images);
    this.prune(session);
    return execution;
  }

  private async dispatch(session: Session, execution: Execution, images: RuntimeImageContent[]): Promise<void> {
    try {
      const response = record(await session.rpc.request("turn/start", {
        threadId: session.threadId, model: session.model, approvalPolicy: "never",
        ...(session.effort ? { effort: session.effort } : {}),
        input: nativeInput(execution.turn.input, images),
      }));
      if (session.active !== execution) return;
      const native = record(response?.turn);
      if (!native || typeof native.id !== "string" || !native.id || !["inProgress", "completed", "interrupted", "failed"].includes(String(native.status))) {
        session.rpc.abort(new Error("Invalid Codex turn/start response; session stopped"));
        return;
      }
      execution.nativeId = native.id;
      // The initial prompt may appear only in this snapshot, even for a running
      // turn. Retain it before buffered notifications can add steering or finish.
      if (Array.isArray(native.items)) {
        for (const value of native.items) {
          const item = record(value);
          if (item && typeof item.id === "string") execution.items.set(item.id, item);
        }
      }
      for (const event of execution.buffered.splice(0)) this.notification(session, event);
      execution.bufferedBytes = 0;
      if (session.active === execution && native.status !== "inProgress") this.finishNative(session, execution, native);
    } catch (error) {
      if (session.active === execution) this.finish(session, execution, session.stopping ? "interrupted" : "failed",
        session.stopping ? undefined : error instanceof CodexRpcResponseError ? "Codex native turn request failed"
          : error instanceof Error ? error.message : "Codex turn failed");
    }
  }

  private notification(session: Session, event: CodexNotification): void {
    if (event.params.threadId === session.threadId && event.method === "model/rerouted" && event.params.toModel !== session.model) {
      session.rpc.abort(new Error("Codex changed the selected model; session stopped")); return;
    }
    const execution = session.active;
    if (!execution || event.params.threadId !== session.threadId) return;
    if (!execution.nativeId) {
      execution.bufferedBytes += Buffer.byteLength(JSON.stringify(event));
      if (execution.buffered.length >= 1_000 || execution.bufferedBytes > RUNTIME_INPUT_LIMITS.transportBytes) {
        session.rpc.abort(new Error("Codex emitted too many events before acknowledging turn/start"));
      } else execution.buffered.push(event);
      return;
    }
    const native = record(event.params.turn);
    if ((native?.id ?? event.params.turnId) !== execution.nativeId) return;
    if (event.method === "turn/completed" && native) this.finishNative(session, execution, native);
    else if (event.method === "item/agentMessage/delta" && typeof event.params.delta === "string") {
      this.publish(session, { type: "message_delta", delta: event.params.delta });
    } else if (event.method === "item/started" || event.method === "item/completed") {
      const item = record(event.params.item);
      if (!item || typeof item.id !== "string") return;
      if (event.method === "item/completed") execution.items.set(item.id, item);
      const name = toolName(item);
      if (!name) return;
      if (event.method === "item/started") this.publish(session, { type: "tool_started", toolCallId: item.id, toolName: name });
      else this.publish(session, { type: "tool_completed", toolCallId: item.id, toolName: name,
        isError: item.status === "failed" || item.status === "declined" || item.success === false || (typeof item.exitCode === "number" && item.exitCode !== 0) });
    }
  }

  private finishNative(session: Session, execution: Execution, native: Record<string, unknown>): void {
    if (!["completed", "interrupted", "failed"].includes(String(native.status))) {
      session.rpc.abort(new Error("Invalid Codex terminal status; session stopped"));
      return;
    }
    if (Array.isArray(native.items)) {
      for (const value of native.items) {
        const item = record(value);
        if (item && typeof item.id === "string") execution.items.set(item.id, item);
      }
    }
    if (native.status === "completed") {
      const response = finalResponse(execution.items.values());
      if (response) { execution.turn.response = response; this.finish(session, execution, "completed"); }
      else this.finish(session, execution, "failed", "Codex turn produced no final assistant response");
    } else if (native.status === "interrupted") this.finish(session, execution, "interrupted");
    // Native diagnostics may contain prior image inputs or private credentials,
    // even when this particular turn was text-only or followed a cold resume.
    else this.finish(session, execution, "failed", "Codex native turn failed");
  }

  private finish(session: Session, execution: Execution, status: AgentTurn["status"], error?: string): void {
    if (execution.turn.status !== "running") return;
    execution.turn.status = status;
    execution.turn.updatedAt = new Date().toISOString();
    if (error && execution.hasImages) error = "Codex image turn failed";
    if (error) execution.turn.error = error;
    let originalPromptDeduplicated = false;
    for (const item of execution.items.values()) {
      const message = normalizeCodexItem(item);
      if (!message) continue;
      // Admission already recorded the original prompt. Only skip its first
      // native echo, not every user item: later items can be steering messages.
      if (message.role === "user" && message.content === execution.turn.input && !originalPromptDeduplicated) {
        originalPromptDeduplicated = true;
        continue;
      }
      session.history.push(message);
    }
    execution.items.clear();
    execution.buffered.length = 0;
    if (session.active === execution) session.active = undefined;
    this.publish(session, { type: "turn_completed", operationId: execution.turn.id });
    if (error) this.publish(session, { type: "error", operationId: execution.turn.id, message: error });
    if (session.state !== "offline") this.setStatus(session, session.stopping ? "offline" : "idle");
    execution.settle();
    this.prune(session);
  }

  private offline(session: Session, error: Error): void {
    this.setStatus(session, "offline");
    if (session.active) this.finish(session, session.active, session.stopping ? "interrupted" : "failed", session.stopping ? undefined : error.message);
    for (const stream of session.streams) stream.close();
  }

  private prune(session: Session): void {
    for (const [id, execution] of session.turns) {
      if (session.turns.size <= this.retention) break;
      if (execution.turn.status !== "running") session.turns.delete(id);
    }
  }

  private setStatus(session: Session, status: AgentStatus): void {
    if (session.state === status) return;
    session.state = status;
    this.publish(session, { type: "status", status });
  }
  private publish(session: Session, event: EventPayload): void {
    const frame = { ...event, sessionId: session.public.id, timestamp: new Date().toISOString() } as AgentEvent;
    for (const stream of session.streams) stream.push(frame);
  }
}
