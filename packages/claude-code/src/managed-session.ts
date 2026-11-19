import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomUUID } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import {
  runtimeInput, type AgentRuntime, type AgentSession, type AgentEvent, type AgentTurn,
  type RuntimeActivityEvent, type RuntimeActivityOptions, type RuntimeImageContent,
} from "@minu/runtime-core";
import { ClaudeCodeAgentRuntime, type ClaudeCodeRuntimeOptions } from "./client.js";
import { openClaudeCodeNativeSession } from "./native-session.js";
import { ClaudeCodeManagedStore, type ClaudeCodeManagedManifest, type ClaudeCodeManifestLease, type ClaudeCodeDispatchIdentity } from "./managed-store.js";
import { decodeClaudeCodeWorkerRegistration, encodeClaudeCodeWorkerRegistration, type ClaudeCodeWorkerRegistrationScope } from "./worker-registration.js";
import { requireClaudeCodePolicy } from "./worker-lifecycle.js";
import { turnId as callerTurnId } from "./worker-protocol.js";
import { Queue } from "./queue.js";
import { CLAUDE_CODE_FORBIDDEN_ENV, claudeCodeNativeEnvironment, resolveClaudeCodeConfigRoot } from "./native-config.js";

type NativeHandle = Awaited<ReturnType<typeof openClaudeCodeNativeSession>>;
// One facade per physical worker epoch, even after failed initialization or stop.
const claimed = new Set<string>();
interface Admission { lease: ClaudeCodeManifestLease; manifest: ClaudeCodeManagedManifest; active: boolean }
interface Execution { turn: AgentTurn; fingerprint: string; identity?: ClaudeCodeDispatchIdentity }
export interface ClaudeCodeManagedSessionOptions {
  store: ClaudeCodeManagedStore;
  scope: ClaudeCodeWorkerRegistrationScope;
  nativeOptions?: Omit<ClaudeCodeRuntimeOptions, "tools">;
}
export interface ClaudeCodeManagedSessionHandle {
  session: AgentSession;
  /** Single-session worker facade. Commands require the admit callback; not a public adapter. */
  runtime: AgentRuntime;
  /** Call once AFTER private publication; native pending remains lazy. No automatic retry. */
  initialize(registration: Uint8Array): Promise<void>;
  /** Pass directly to the bridge; do not retain leases or recursively acquire admission. */
  admit<T>(operation: () => Promise<T>): Promise<T>;
  /** Privileged self-cleanup outside admission, including after revocation.
   * Does not clear metadata, prove worker/group exit, or authorize remote operations. */
  closeOwnedNative(): Promise<void>;
}
function copy(turn: AgentTurn): AgentTurn {
  return { ...turn, ...(turn.response ? { response: { ...turn.response } } : {}) };
}

/** Internal worker-side binding/dispatch driver only. No process launch/registration producer,
 * public managed entry, automatic native replacement or durable caller-result ledger. */
class ManagedSession implements AgentRuntime {
  readonly session: AgentSession;
  private readonly scope: ClaudeCodeWorkerRegistrationScope;
  private readonly options: ClaudeCodeRuntimeOptions;
  private readonly context = new AsyncLocalStorage<Admission>();
  private readonly turns = new Map<string, Execution>();
  private readonly eventsOut = new Set<Queue<AgentEvent>>();
  private readonly activitiesOut = new Set<Queue<RuntimeActivityEvent>>();
  private readonly activityAbort = new AbortController();
  private readonly retention: number;
  private readonly buffer: number;
  private registration?: Uint8Array;
  private activationAttempted = false;
  private ready = false;
  private stopped = false;
  private unavailable = false;
  private policy?: string;
  private native?: NativeHandle;
  private nativeId?: string;
  private opening?: Promise<void>;
  private openingAbort?: AbortController;
  private openingUnknown = false;
  private observing = false;
  private nativeEventsTask?: Promise<void>;
  private nativeActivityTask?: Promise<void>;
  private activityHealthy = true;
  private active?: Execution;
  private phase?: RuntimeActivityEvent["phase"];

  constructor(private readonly store: ClaudeCodeManagedStore, scope: ClaudeCodeWorkerRegistrationScope, options: ClaudeCodeManagedSessionOptions["nativeOptions"] = {}) {
    this.scope = { ...scope };
    this.session = { id: this.scope.sessionId, runtime: "claude-code", ownership: "owned", cwd: this.scope.cwd };
    if (CLAUDE_CODE_FORBIDDEN_ENV.some(key => options.env?.[key] !== undefined)) throw new Error("Managed Claude Code environment overrides are not permitted");
    // The worker inherits its process environment (HOME is needed for keychain access); `env` only overlays it.
    this.options = { ...options, env: claudeCodeNativeEnvironment(options.env) };
    // Validate limits without launching anything. Policy tools are loaded from the manifest.
    new ClaudeCodeAgentRuntime(this.options);
    this.retention = options.turnRetentionLimit ?? 1_000;
    this.buffer = options.eventBufferLimit ?? 256;
    if (this.retention > 1_000 || this.buffer > 4_096) throw new Error("Managed Claude Code retention limits exceed worker bounds");
  }
  async initialize(payload: Uint8Array): Promise<void> {
    if (this.activationAttempted) throw new Error("Managed Claude Code initialization was already attempted");
    this.activationAttempted = true;
    const registration = decodeClaudeCodeWorkerRegistration(payload, this.scope);
    if (registration.pid !== process.pid) throw new Error("Managed Claude Code facade must run in its registered worker process");
    this.registration = encodeClaudeCodeWorkerRegistration(registration, this.scope);
    await this.authority(async () => {
      const key = JSON.stringify([this.scope.sessionId, this.scope.ownerId, this.scope.generation, this.scope.reservationId]);
      if (claimed.has(key)) throw new Error("Managed Claude Code worker epoch was already claimed");
      claimed.add(key);
      const context = this.current(this.session.id), manifest = context.manifest;
      // v3/v4 manifests predate the policy and are the read-only MVP policy (their stored tool list applies verbatim).
      try { requireClaudeCodePolicy(manifest); } catch { throw new Error("Managed Claude Code policy is not supported"); }
      const policy = manifest.policy;
      Object.assign(this.options, manifest.version < 5 ? { permissions: "readOnly" as const, tools: [...(policy.tools ?? [])] }
        : { permissions: policy.permissions !== "custom" ? policy.permissions! : { mode: policy.permissionMode,
          ...(policy.allowedTools ? { allowedTools: [...policy.allowedTools] } : {}),
          ...(policy.disallowedTools ? { disallowedTools: [...policy.disallowedTools] } : {}) } },
      { isolateConfiguration: policy.configuration === "isolated" });
      if (await resolveClaudeCodeConfigRoot(undefined, this.options.env!).catch(() => undefined) !== manifest.policy.nativeConfigRoot) {
        throw new Error("Managed Claude Code native environment is not verified");
      }
      if (await realpath(manifest.launchConfig.cwd) !== manifest.launchConfig.cwd || !(await stat(manifest.launchConfig.cwd)).isDirectory()) {
        throw new Error("Managed Claude Code workspace is not canonical");
      }
      if (manifest.native.state === "creating" || manifest.lastDispatch.state === "dispatching"
        || (manifest.native.state === "bound" && manifest.lastDispatch.state !== "settled")) {
        throw new Error("Managed Claude Code native history or input outcome is uncertain");
      }
      // Close may win while admission or workspace validation is awaited. Check
      // after all prelaunch awaits, before entering any bound native opening.
      if (this.stopped) throw new Error("Managed Claude Code session stopped during initialization");
      this.policy = this.policyKey(manifest);
      if (manifest.native.state === "bound") {
        await this.openNative(context, manifest.native.sessionId, "resume");
        this.nativeId = manifest.native.sessionId;
        this.observeNative();
      }
      if (this.stopped) throw new Error("Managed Claude Code session stopped during initialization");
      this.ready = true;
    });
  }
  private policyKey(manifest: ClaudeCodeManagedManifest): string {
    return JSON.stringify([manifest.launchConfig, manifest.policy]);
  }
  async admit<T>(operation: () => Promise<T>): Promise<T> {
    if (!this.ready) throw new Error("Managed Claude Code worker is not initialized");
    return this.authority(operation);
  }
  private async authority<T>(operation: () => Promise<T>): Promise<T> {
    if (!this.registration) throw new Error("Managed Claude Code worker registration is unavailable");
    return this.store.withWorkerAdmission(this.scope, this.registration, async (lease, manifest) => {
      if ((this.policy !== undefined && this.policyKey(manifest) !== this.policy)
        || (this.nativeId && (manifest.native.state !== "bound" || manifest.native.sessionId !== this.nativeId))) {
        throw new Error("Managed Claude Code native binding or policy changed");
      }
      const context: Admission = { lease, manifest, active: true };
      return this.context.run(context, async () => {
        try { return await operation(); } finally { context.active = false; }
      });
    });
  }
  private current(id: string): Admission {
    const context = this.context.getStore();
    if (id !== this.session.id || !context?.active) throw new Error("Managed Claude Code command requires current worker admission");
    return context;
  }
  async start(): Promise<AgentSession> { throw new Error("Managed worker cannot create another Runtime session"); }
  async send(): Promise<void> { throw new Error("Managed worker transport requires stable caller turn IDs"); }
  async startTurn(id: string, requestedId: string, input: string, images?: RuntimeImageContent[]): Promise<AgentTurn> {
    const context = this.current(id), normalized = runtimeInput(input, images), turnId = callerTurnId(requestedId);
    if (normalized.images.length) throw new Error("Claude Code image input is not implemented");
    const fingerprint = createHash("sha256").update(normalized.input).digest("hex");
    const previous = this.turns.get(turnId);
    if (previous) {
      if (previous.fingerprint !== fingerprint || previous.turn.input !== normalized.input) throw new Error("Turn id conflicts with previously accepted input");
      return copy(previous.turn);
    }
    if (this.stopped || this.unavailable) throw new Error("Managed Claude Code session is offline");
    if (this.active) throw new Error("Claude Code session is busy");
    const last = context.manifest.lastDispatch;
    if (context.manifest.native.state === "creating" || last.state === "dispatching") throw new Error("Managed Claude Code input outcome is uncertain");
    if (last.state === "settled" && last.turnId === turnId) throw new Error("Managed Claude Code retained turn is unavailable; redispatch refused");
    // Lifetime-bounded ledger: never evict an accepted ID then silently reuse it.
    if (this.turns.size >= this.retention) throw new Error("Managed Claude Code worker turn-retention lifetime is exhausted");
    const now = new Date().toISOString();
    const execution: Execution = { fingerprint, turn: { id: turnId, input: normalized.input, status: "running", createdAt: now, updatedAt: now } };
    this.turns.set(turnId, execution); this.active = execution;
    this.emit({ type: "turn_started", operationId: turnId }); this.statusEvent(); this.activity({ phase: "working", observedAt: now });
    try {
      if (!this.native) {
        if (context.manifest.native.state !== "pending") throw new Error("Managed native creation is unavailable");
        const nativeId = randomUUID();
        context.manifest = await context.lease.beginNativeCreation(context.manifest.revision, nativeId);
        if (this.stopped) throw new Error("Managed Claude Code session stopped before native opening");
        await this.openNative(context, nativeId, "create", normalized.input);
        if (this.stopped) throw new Error("Managed Claude Code session stopped before binding");
        context.manifest = await context.lease.bindNativeSession(context.manifest.revision, nativeId);
        this.nativeId = nativeId;
        this.observeNative();
      }
      const identity = { turnId, fingerprint, nativeMessageId: randomUUID() };
      context.manifest = await context.lease.beginDispatch(context.manifest.revision, this.scope.generation, identity);
      execution.identity = identity;
      await this.native!.startMappedTurn(turnId, normalized.input, identity.nativeMessageId);
    } catch {
      this.unavailable = true;
      this.finish(execution, { ...execution.turn, status: "failed", error: "Managed Claude Code preparation or dispatch failed; outcome unavailable" });
      // Retain known handles for cleanup retries; never clear creating/dispatch uncertainty.
      await this.native?.runtime.stop(id).catch(() => {});
    }
    return copy(execution.turn);
  }
  private async openNative(context: Admission, nativeSessionId: string, mode: "create" | "resume", firstInput?: string): Promise<void> {
    this.openingAbort = new AbortController();
    this.openingUnknown = true;
    const common = { runtimeSessionId: this.session.id, nativeSessionId, canonicalCwd: context.manifest.launchConfig.cwd,
      nativeConfigRoot: context.manifest.policy.nativeConfigRoot, nativeRoot: true, signal: this.openingAbort.signal };
    const opening = (async () => {
      this.native = await openClaudeCodeNativeSession(context.manifest.launchConfig,
        mode === "create" ? { ...common, mode, firstInput: firstInput! } : { ...common, mode }, this.options);
      this.openingUnknown = false;
    })();
    this.opening = opening;
    try { await opening; } finally { this.opening = undefined; this.openingAbort = undefined; }
  }
  private observeNative(): void {
    if (this.observing) return;
    this.observing = true;
    const native = this.native!;
    this.nativeEventsTask = (async () => {
      let observedTurn: string | undefined;
      let observationFailed = false;
      try {
        for await (const event of native.runtime.events(this.session.id)) {
          if (event.type === "turn_started") observedTurn = event.operationId;
          if (!this.stopped && ["message_delta", "tool_started", "tool_completed"].includes(event.type)) this.emit(event);
          // Reconcile only after preceding raw frames, targeting the observed turn:
          // a queued idle/error for A must never settle B before B's frames drain.
          if (event.type === "turn_completed" || event.type === "error" || (event.type === "status" && event.status !== "working")) {
            const target = event.type === "turn_completed" || event.type === "error" ? event.operationId ?? observedTurn : observedTurn;
            await this.authority(() => this.reconcile(this.current(this.session.id), target));
          }
        }
      } catch {
        observationFailed = true; this.unavailable = true;
        await native.runtime.stop(this.session.id).catch(() => {});
      } finally {
        // A failed raw subscription cannot upgrade incomplete observation to success.
        if (!observationFailed) await this.authority(() => this.reconcile(this.current(this.session.id), observedTurn)).catch(() => { this.unavailable = true; });
        this.unavailable = true;
        if (this.active) this.finish(this.active, { ...this.active.turn, status: "failed", error: "Managed Claude Code observation unavailable; outcome uncertain" });
        this.statusEvent(); this.endStreams();
      }
    })();
    this.nativeActivityTask = (async () => {
      try {
        if (native.runtime.activityEvents) for await (const event of native.runtime.activityEvents(this.session.id, { signal: this.activityAbort.signal })) {
          if (!this.stopped) this.activity(event);
        }
      } catch { this.activityHealthy = false; }
      finally { this.activityHealthy = false; for (const queue of this.activitiesOut) queue.end(); }
    })();
  }
  private async reconcile(context: Admission, expectedTurn: string | undefined): Promise<void> {
    const execution = this.active;
    if (!execution?.identity || execution.turn.id !== expectedTurn || !this.native) return;
    const turn = await this.native.runtime.turn(this.session.id, execution.turn.id);
    if (!turn || turn.status === "running") return;
    const evidence = this.native.evidence(turn.id);
    if (evidence === "native" || evidence === "undispatched") {
      try {
        context.manifest = await context.lease.settleDispatch(context.manifest.revision, this.scope.generation, execution.identity, turn.status);
        this.finish(execution, turn);
        return;
      } catch { /* A terminal result without confirmed persistence is not durable settlement. */ }
    }
    this.unavailable = true;
    this.finish(execution, { ...execution.turn, status: "failed", error: "Managed Claude Code dispatch outcome or settlement persistence is uncertain" });
  }
  private finish(execution: Execution, turn: AgentTurn): void {
    if (execution.turn.status !== "running") return;
    execution.turn = { ...copy(turn), updatedAt: new Date().toISOString() };
    if (this.active === execution) this.active = undefined;
    this.phase = undefined;
    if (turn.status === "completed") this.emit({ type: "turn_completed", operationId: turn.id });
    else if (turn.error) this.emit({ type: "error", operationId: turn.id, message: turn.error });
    this.statusEvent();
  }
  async turn(id: string, turnId: string): Promise<AgentTurn | undefined> {
    this.current(id); const execution = this.turns.get(callerTurnId(turnId)); return execution && copy(execution.turn);
  }
  async status(id: string): Promise<"offline" | "working" | "idle"> {
    this.current(id); return this.stopped || this.unavailable ? "offline" : this.active ? "working" : "idle";
  }
  async messages(id: string) { this.current(id); return this.native ? this.native.runtime.messages(id) : []; }
  async inputCapabilities(id: string) { this.current(id); return { version: 1 as const, images: false }; }
  async sessionCapabilities(id: string) {
    const live = await this.status(id) !== "offline";
    return { version: 1 as const, safeActivityEvents: live && this.activityHealthy, interrupt: live, reconnectExisting: live,
      interactiveAttach: false, openDiagnostic: false, liveSkillVerification: false };
  }
  async steer(id: string): Promise<void> { this.current(id); throw new Error("Claude Code steering is not implemented"); }
  async interrupt(id: string): Promise<void> {
    this.current(id);
    if (this.stopped || this.unavailable) throw new Error("Managed Claude Code session is offline");
    if (!this.active) return;
    await this.native?.runtime.interrupt(id);
    // Only the ordered native observer settles; control acknowledgment is not a result.
  }
  async stop(id: string): Promise<void> {
    this.current(id);
    this.stopped = true; this.openingAbort?.abort();
    await this.native?.runtime.stop(id);
    if (this.active && !this.active.identity) this.finish(this.active, { ...this.active.turn, status: "interrupted" });
    this.statusEvent(); this.endStreams();
    if (this.openingUnknown) throw new Error("Managed Claude Code native shutdown is unconfirmed");
  }
  async closeOwnedNative(): Promise<void> {
    if (this.context.getStore()?.active) throw new Error("Owned native cleanup must run outside worker admission");
    this.stopped = true; this.openingAbort?.abort();
    try {
      await this.opening?.catch(() => {});
      await this.native?.runtime.stop(this.session.id);
      if (this.openingUnknown) throw new Error("Managed Claude Code native shutdown is unconfirmed");
    } finally {
      this.statusEvent(); this.endStreams();
      await Promise.allSettled([this.nativeEventsTask, this.nativeActivityTask]);
    }
  }
  private emit(event: Omit<AgentEvent, "sessionId" | "timestamp"> | AgentEvent): void {
    const value = { ...event, sessionId: this.session.id, timestamp: new Date().toISOString() } as AgentEvent;
    for (const queue of this.eventsOut) queue.push(value);
  }
  private statusEvent(): void { this.emit({ type: "status", status: this.stopped || this.unavailable ? "offline" : this.active ? "working" : "idle" }); }
  private activity(event: RuntimeActivityEvent): void {
    if (this.phase === event.phase) return;
    this.phase = event.phase; for (const queue of this.activitiesOut) queue.push({ ...event });
  }
  private endStreams(): void {
    this.activityAbort.abort();
    for (const queue of this.eventsOut) queue.end();
    for (const queue of this.activitiesOut) queue.end();
  }
  async *events(id: string): AsyncIterable<AgentEvent> {
    if (id !== this.session.id) throw new Error("Unknown managed Claude Code session");
    if (this.stopped || this.unavailable) return;
    const queue = new Queue<AgentEvent>(this.buffer); this.eventsOut.add(queue);
    try { yield* queue; } finally { this.eventsOut.delete(queue); await queue.return(); }
  }
  async *activityEvents(id: string, options: RuntimeActivityOptions): AsyncIterable<RuntimeActivityEvent> {
    if (id !== this.session.id) throw new Error("Unknown managed Claude Code session");
    if (options.signal.aborted || this.stopped || this.unavailable || !this.activityHealthy) return;
    const queue = new Queue<RuntimeActivityEvent>(this.buffer), abort = () => { void queue.return(); };
    this.activitiesOut.add(queue); options.signal.addEventListener("abort", abort, { once: true });
    if (this.active && this.phase) queue.push({ phase: this.phase, observedAt: new Date().toISOString() });
    try { yield* queue; } finally { this.activitiesOut.delete(queue); options.signal.removeEventListener("abort", abort); await queue.return(); }
  }
}

export function createClaudeCodeManagedSession(options: ClaudeCodeManagedSessionOptions): ClaudeCodeManagedSessionHandle {
  const runtime = new ManagedSession(options.store, options.scope, options.nativeOptions);
  return { runtime, session: { ...runtime.session }, initialize: payload => runtime.initialize(payload),
    admit: operation => runtime.admit(operation), closeOwnedNative: () => runtime.closeOwnedNative() };
}
