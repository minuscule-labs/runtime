import type { AgentEvent, AgentSession, AgentStatus, AgentTurn, RuntimeImageContent, RuntimeInputCapabilities, RuntimeSessionCapabilities, RuntimeSessionProfile, RuntimeSessionEvents, RuntimeSessionEventCode, RuntimeMessage } from "@minu/runtime-core";
import { runtimeInput, sessionProfile } from "@minu/runtime-core";
import { CodexNativeStartupCleanupError, CodexInputRejectedError, CodexSessionBusyError, CodexSessionOfflineError, type CodexAgentRuntimeOptions } from "./client.js";
import { CodexManagedStore, assertCodexWorkerClaim, type CodexManagedManifest, type CodexRetirementIntent, type CodexNativeQuiesce, codexResumeEpoch, sameCodexHistory } from "./managed-store.js";
import type { CodexWorkerClaim, CodexWorkerConnection } from "./worker-identity.js";
import {
  allocatePendingCodexThread, CodexNativeCleanupError,
  type CodexManagedIdentity, type CodexNativeAllocation,
} from "./managed-native.js";
import type { CodexWorkerRuntime } from "./worker-bridge.js";
import { CodexRpcProcess } from "./rpc.js";
import { probeNativeImageInput } from "./native-capabilities.js";
import { CodexEventHub } from "./event-stream.js";
import { codexInputFingerprint } from "./input.js";
import { CodexSessionEventLog } from "./session-events.js";

type EventPayload<T = AgentEvent> = T extends AgentEvent ? Omit<T, "sessionId" | "timestamp"> : never;

interface PreparedTurn {
  turn: AgentTurn;
  fingerprint: string;
  images: RuntimeImageContent[];
  dispatched: boolean;
  cancelled: boolean;
  work?: Promise<void>;
  nativeSettled?: { promise: Promise<void>; resolve(): void };
}

type IntentPublisher = (context: {
  current: CodexManagedManifest;
  intent: CodexRetirementIntent;
  commitIntent(): Promise<CodexManagedManifest>;
  commitIntentWithHistory(): Promise<CodexManagedManifest>;
}) => Promise<void>;

interface RetirementSeal {
  current: CodexManagedManifest;
  intent: CodexRetirementIntent;
  owned?: { allocation: CodexNativeAllocation; runtime: CodexNativeAllocation["runtime"]; session: CodexNativeAllocation["session"]; sessionId: string; threadId: string };
  nativeFact?: CodexNativeQuiesce;
  publication?: Promise<void>;
  result: Promise<void>;
  resolve(): void;
  reject(error: unknown): void;
}

function sameConnection(a: CodexWorkerConnection, b: CodexWorkerConnection): boolean {
  return (["version", "ownerId", "sessionId", "generation", "claimId", "pid", "endpoint", "token"] as const).every(key => a[key] === b[key]);
}

function copyTurn(turn: AgentTurn): AgentTurn {
  return { ...turn, ...(turn.response ? { response: { ...turn.response } } : {}) };
}

/** Internal lazy worker only. No durable worker registration, replacement, or public lifecycle. */
class PendingCodexWorkerRuntime implements CodexWorkerRuntime {
  private readonly turns = new Map<string, PreparedTurn>();
  private active?: PreparedTurn;
  private allocation?: CodexNativeAllocation;
  private allocating?: Promise<CodexNativeAllocation>;
  private nativeStop?: Promise<void>;
  // Cleanup authority is not a successfully bound execution allocation.
  private cleanupStop?: () => Promise<void>;
  private stopping?: Promise<void>;
  private quiescing?: Promise<void>;
  private retirementSeal?: RetirementSeal;
  private unavailable = false;
  private readonly retention: number;
  private readonly eventHub = new CodexEventHub();
  private readonly observations = new CodexSessionEventLog();
  private eventStatus: AgentStatus = "idle";
  private nativeEvents?: AsyncIterableIterator<AgentEvent>;
  private forwarding?: Promise<void>;
  private nativeEventsClosed = false;

  constructor(
    private readonly store: CodexManagedStore,
    private readonly identity: CodexManagedIdentity,
    private readonly options: Omit<CodexAgentRuntimeOptions, "sandbox">,
    private readonly claim?: CodexWorkerClaim,
    allocation?: CodexNativeAllocation,
  ) {
    this.allocation = allocation;
    this.retention = options.turnRetentionLimit ?? 1_000;
    if (!Number.isSafeInteger(this.retention) || this.retention < 1) throw new Error("Invalid Codex turn retention");
  }

  private address(id: string): void {
    if (id !== this.identity.id) throw new CodexSessionOfflineError("Unknown Codex worker session");
  }

  private async current(): Promise<CodexManagedManifest> {
    // Compare one read with the allocation known when it began, not an allocation
    // that completed while an older creating snapshot was physically in flight.
    const allocation = this.allocation;
    const current = await this.store.read(this.identity.id, this.identity.ownerId);
    if (!current || current.generation !== this.identity.generation || current.requiresExplicitResume
      || (allocation && (current.native.state !== "bound" || current.native.threadId !== allocation.threadId))) {
      throw new CodexSessionOfflineError("Codex worker identity is unavailable or fenced");
    }
    assertCodexWorkerClaim(current, this.claim);
    return current;
  }

  async status(id: string): Promise<AgentStatus> {
    this.address(id);
    if (this.stopping || this.retirementSeal || this.unavailable) return "offline";
    try {
      const current = await this.current();
      if (this.stopping || this.retirementSeal || this.unavailable) return "offline";
      if (this.active) return "working";
      if (!this.allocation) return current.native.state === "pending" ? "idle" : "offline";
      return await this.allocation.runtime.status(this.allocation.session.id);
    } catch { return "offline"; }
  }

  events(id: string): AsyncIterableIterator<AgentEvent> {
    this.address(id);
    return this.eventHub.subscribe({ type: "status", status: this.eventStatus, sessionId: this.identity.id, timestamp: new Date().toISOString() });
  }

  private publish(event: EventPayload): void {
    this.eventHub.publish({ ...event, sessionId: this.identity.id, timestamp: new Date().toISOString() } as AgentEvent);
  }

  private setEventStatus(status: AgentStatus): void {
    if (this.eventStatus !== status) { this.eventStatus = status; this.publish({ type: "status", status }); }
  }

  private async forwardNative(): Promise<void> {
    const allocation = this.allocation!;
    // Synchronous subscription occurs before native startTurn can emit anything.
    const stream = allocation.runtime.events(allocation.session.id);
    this.nativeEvents = stream;
    try {
      for await (const event of stream) {
        await this.current();
        if (event.type === "status" && event.status === "offline") {
          this.unavailable = true; this.setEventStatus("offline");
        } else if (event.type === "turn_completed") {
          this.turns.get(event.operationId)?.nativeSettled?.resolve();
        } else if (event.type === "message_delta" || event.type === "tool_started" || event.type === "tool_completed") {
          this.eventHub.publish({ ...event, sessionId: this.identity.id });
        }
        // Admission/settlement belong to the outer caller turn, not the native
        // execution's separate session. Never duplicate its lifecycle events.
      }
    } catch {
      // Observation failure must not stop/replay native work or fabricate success.
      this.eventHub.close(new Error("Codex native event observation failed; events may have been missed"));
    } finally {
      this.nativeEventsClosed = true;
      for (const entry of this.turns.values()) entry.nativeSettled?.resolve();
      await stream.return?.();
    }
  }

  private imagesProbe?: Promise<boolean>;
  private async probeImages(config: CodexManagedManifest["launchConfig"]): Promise<boolean> {
    const rpc = new CodexRpcProcess(config.cwd, this.options);
    let images = false, failure: unknown;
    try { await rpc.initialize(); images = await probeNativeImageInput(rpc, config.cwd, config); }
    catch (error) { failure = error; }
    await rpc.stop(); // Unconfirmed exit rejects: never report a capability from a probe that may still be running.
    if (failure) throw failure;
    return images;
  }

  async inputCapabilities(id: string): Promise<RuntimeInputCapabilities> {
    this.address(id); const current = await this.current();
    if (!this.allocation && !this.allocating && current.native.state === "pending" && !this.stopping && !this.retirementSeal && !this.unavailable) {
      // Before the lazy first turn there is no live model. Answer from a prompt-less probe (never a persistent thread), like
      // Pi and Claude Code, so an image sent as the first message is not silently dropped by callers that ask first.
      const probe = this.imagesProbe ??= this.probeImages(current.launchConfig);
      const images = await probe.catch(() => { if (this.imagesProbe === probe) this.imagesProbe = undefined; return false; }); // A failure is not cached.
      await this.current();
      if (this.stopping || this.retirementSeal || this.unavailable) throw new CodexSessionOfflineError("Codex worker is offline");
      return { version: 1, images };
    }
    if (this.stopping || this.retirementSeal || this.unavailable || !this.allocation) throw new CodexSessionOfflineError("Codex live model is not available");
    const result = await this.allocation.runtime.inputCapabilities(this.allocation.session.id);
    await this.current();
    if (this.stopping || this.retirementSeal || this.unavailable) throw new CodexSessionOfflineError("Codex worker is offline");
    return result;
  }

  async sessionCapabilities(id: string): Promise<RuntimeSessionCapabilities> {
    this.address(id); await this.current();
    if (this.stopping || this.retirementSeal || this.unavailable || await this.status(id) === "offline") throw new CodexSessionOfflineError("Codex worker is offline");
    return { version: 1, safeActivityEvents: true, interrupt: true, reconnectExisting: true,
      interactiveAttach: false, openDiagnostic: true, liveSkillVerification: false };
  }

  recordSessionEvent(code: RuntimeSessionEventCode): void { this.observations.record(code); }

  async inspectSessionProfile(id: string, ownerId: string, options: { signal?: AbortSignal } = {}): Promise<RuntimeSessionProfile | undefined> {
    this.address(id); if (ownerId !== this.identity.ownerId) return undefined;
    options.signal?.throwIfAborted(); await this.current(); options.signal?.throwIfAborted();
    if (await this.status(id) === "offline") return undefined;
    options.signal?.throwIfAborted();
    return this.allocation ? this.allocation.runtime.nativeSessionProfile(this.allocation.session.id)
      : sessionProfile({ version: 1, capturedAt: new Date().toISOString(), model: { status: "not_verified" }, reasoning: { status: "not_verified" }, skills: { status: "not_verified" } });
  }
  async inspectSessionEvents(id: string, ownerId: string, options: { signal?: AbortSignal } = {}): Promise<RuntimeSessionEvents | undefined> {
    this.address(id); if (ownerId !== this.identity.ownerId) return undefined;
    options.signal?.throwIfAborted(); if (await this.status(id) === "offline") return undefined;
    options.signal?.throwIfAborted(); return this.observations.snapshot();
  }

  async messages(id: string): Promise<RuntimeMessage[]> {
    this.address(id);
    await this.current();
    return this.allocation ? this.allocation.runtime.messages(this.allocation.session.id) : [];
  }

  async turn(id: string, turnId: string): Promise<AgentTurn | undefined> {
    this.address(id);
    await this.current();
    const entry = this.turns.get(turnId);
    return entry ? copyTurn(entry.turn) : undefined;
  }

  async startTurn(id: string, turnId: string, input: string, images?: RuntimeImageContent[]): Promise<AgentTurn> {
    this.address(id);
    if (typeof turnId !== "string" || !turnId.trim() || Buffer.byteLength(turnId) > 256) throw new Error("Invalid Codex turn identity");
    const normalized = runtimeInput(input, images);
    const fingerprint = codexInputFingerprint(normalized.input, normalized.images);
    const current = await this.current();
    if (this.allocation && await this.allocation.runtime.status(this.allocation.session.id) === "offline") this.unavailable = true;
    // Recheck admission after the read: concurrent requests may have admitted the
    // same turn while this request was awaiting filesystem evidence.
    const existing = this.turns.get(turnId);
    if (existing) {
      if (existing.fingerprint !== fingerprint) { this.observations.record("turn_rejected_conflict"); throw new Error("Turn id conflicts with different input"); }
      this.observations.record("turn_reused"); return copyTurn(existing.turn);
    }
    if (this.stopping || this.retirementSeal || this.unavailable) throw new CodexSessionOfflineError("Codex worker is offline");
    if (this.active) { this.observations.record("request_rejected_busy"); throw new CodexSessionBusyError("Codex worker is working"); }
    if (!this.allocation && current.native.state !== "pending") throw new CodexSessionOfflineError("Codex native creation is already bound or uncertain");
    const now = new Date().toISOString();
    const entry: PreparedTurn = {
      turn: { id: turnId, input: normalized.input, status: "running", createdAt: now, updatedAt: now },
      fingerprint, images: normalized.images, dispatched: false, cancelled: false,
    };
    this.turns.set(turnId, entry);
    this.active = entry;
    this.observations.record("turn_accepted");
    this.setEventStatus("working");
    this.publish({ type: "turn_started", operationId: turnId });
    if (this.allocation && !this.forwarding) this.forwarding = this.forwardNative();
    entry.work = this.run(entry);
    this.prune();
    return copyTurn(entry.turn);
  }

  async steer(id: string, input: string): Promise<void> {
    this.address(id);
    const normalized = runtimeInput(input, undefined);
    const entry = this.active;
    if (!entry?.dispatched) throw new CodexSessionBusyError("Codex native turn is not ready for steering");
    await this.withFence(async () => {
      if (this.stopping || this.active !== entry) throw new CodexSessionBusyError("Codex turn has settled");
      await this.allocation!.runtime.steer(this.allocation!.session.id, normalized.input);
    });
  }

  async interrupt(id: string): Promise<void> {
    this.address(id);
    const entry = this.active;
    if (!entry) throw new CodexSessionBusyError("Codex worker must be working");
    await this.current();
    if (this.active !== entry) return;
    if (!entry.dispatched) {
      // Cancellation can be acknowledged without waiting for the allocation lock.
      // The preparation task must finish cleanup before publishing settlement.
      entry.cancelled = true;
      return;
    }
    await this.withFence(async () => {
      if (this.active === entry) await this.allocation!.runtime.interrupt(this.allocation!.session.id);
    });
  }

  /** Internal idle-only native quiesce, not worker retirement/public suspension. */
  async quiesceIdle(id: string): Promise<void> {
    this.address(id);
    if (this.retirementSeal) throw new CodexSessionOfflineError("Codex worker is sealed for retirement");
    // Busy rejection grants no shutdown authority. Do not wait for preparation's
    // allocation lock just to reject work that is already locally active.
    if (this.active) throw new CodexSessionBusyError("Codex worker is working");
    const { shutdown } = await this.store.withSessionLock(this.identity.id, this.identity.ownerId, async () => {
      let current = await this.current();
      if (this.quiescing) return { shutdown: this.quiescing };
      this.assertQuiesceIdle(current);
      if (this.allocation) {
        const status = await this.allocation.runtime.status(this.allocation.session.id);
        // Do not seal from authority captured before an asynchronous status read.
        current = await this.current();
        this.assertQuiesceIdle(current);
        if (status === "working") throw new CodexSessionBusyError("Codex native session is working");
        if (status !== "idle") throw new CodexSessionOfflineError("Codex native session is unavailable");
      }
      // No await between the final idle check and stop's synchronous admission
      // seal. An input that won meanwhile is active, including preparation.
      this.quiescing = this.stop(id);
      void this.quiescing.catch(() => {});
      // Box the promise: the lifecycle callback must not await native shutdown.
      return { shutdown: this.quiescing };
    });
    await shutdown;
  }

  /** Internal seam only: stored intent is not native/worker exit evidence. */
  async quiesceIdleWithIntent(id: string, operationId: string, publishIntent: IntentPublisher): Promise<void> {
    this.address(id);
    if (typeof operationId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(operationId)
      || typeof publishIntent !== "function") throw new Error("Invalid Codex intent publisher");
    if (this.active) throw new CodexSessionBusyError("Codex worker is working");
    let created: RetirementSeal | undefined;
    try {
      const { seal, start } = await this.store.withSessionLock(this.identity.id, this.identity.ownerId, async lease => {
        if (this.retirementSeal) {
          if (this.retirementSeal.intent.operationId !== operationId) throw new CodexSessionOfflineError("Codex retirement operation conflicts");
          await this.currentRetirement(this.retirementSeal);
          return { seal: this.retirementSeal, start: false };
        }
        let current = await this.current();
        this.assertQuiesceIdle(current);
        if (this.allocation) {
          const status = await this.allocation.runtime.status(this.allocation.session.id);
          current = await this.current();
          this.assertQuiesceIdle(current);
          if (status === "working") throw new CodexSessionBusyError("Codex native session is working");
          if (status !== "idle") throw new CodexSessionOfflineError("Codex native session is unavailable");
        }
        if (current.version !== 5 || current.worker.state !== "ready" || !current.processDomain || !this.claim
          || current.native.state === "creating") throw new CodexSessionOfflineError("Codex retirement correlation is unavailable");
        if (current.native.state === "pending" && (this.allocating || this.cleanupStop)) throw new CodexSessionOfflineError("Codex pending native identity is uncertain");
        // No await between the last idle check and this local admission seal.
        let resolve!: () => void, reject!: (error: unknown) => void;
        const result = new Promise<void>((done, failed) => { resolve = done; reject = failed; });
        void result.catch(() => {});
        const intent: CodexRetirementIntent = { operationId, native: structuredClone(current.native) };
        const allocation = this.allocation;
        const seal: RetirementSeal = { current: structuredClone(current), intent, result, resolve, reject,
          ...(allocation ? { owned: { allocation, runtime: allocation.runtime, session: allocation.session, sessionId: allocation.session.id, threadId: allocation.threadId } } : {}) };
        this.retirementSeal = created = seal;
        this.setEventStatus("offline");
        let open = true, used = false, commit: Promise<CodexManagedManifest> | undefined;
        const connection = structuredClone(current.worker.connection);
        const commitIntent = (history = false): Promise<CodexManagedManifest> => {
          if (!open || used) return Promise.reject(new Error("Codex intent publication capability is closed or used"));
          used = true;
          try { commit = (async () => {
            const checkpoint = history ? (seal.owned ? await seal.owned.runtime.nativeHistoryCheckpoint(seal.owned.sessionId) : { kind: "pending" as const }) : undefined;
            return structuredClone(await lease.beginRetirementIntent(seal.current.revision, connection, seal.intent, checkpoint));
          })(); }
          catch (error) { commit = Promise.reject(error); }
          void commit.catch(() => {});
          return commit;
        };
        let failure: { error: unknown } | undefined;
        try { await publishIntent({ current: structuredClone(current), intent: structuredClone(intent), commitIntent: () => commitIntent(), commitIntentWithHistory: () => commitIntent(true) }); }
        catch (error) { failure = { error }; }
        finally { open = false; }
        // Drain even an unawaited commit, including after callback rejection.
        try { if (commit) await commit; } catch (error) { failure ??= { error }; }
        if (failure) throw failure.error;
        if (!commit) throw new CodexSessionOfflineError("Codex retirement intent was not committed");
        await this.currentRetirement(seal);
        return { seal, start: true };
      });
      // Lifecycle lock release and lease draining have both completed. Bypass
      // stop's seal join so this operation cannot join itself.
      if (start) {
        this.assertOwnedCapture(seal);
        void this.stopOwned().then(() => {
          this.assertOwnedCapture(seal);
          seal.nativeFact = { kind: seal.owned ? "owned_exit" : "never_started" };
          seal.resolve();
        }, seal.reject).catch(seal.reject);
      }
      await seal.result;
    } catch (error) {
      created?.reject(error);
      throw error;
    }
  }

  /** Producer completion is distinct from the sealed operation's shutdown result. */
  async quiesceIdleWithNativeFact(id: string, operationId: string, publishIntent: IntentPublisher): Promise<void> {
    this.address(id);
    if (typeof operationId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(operationId)
      || typeof publishIntent !== "function") throw new Error("Invalid Codex intent publisher");
    if (!this.retirementSeal) await this.quiesceIdleWithIntent(id, operationId, publishIntent);
    const seal = this.retirementSeal!;
    if (seal.intent.operationId !== operationId) throw new CodexSessionOfflineError("Codex retirement operation conflicts");
    await seal.result;
    // Install the attempt before any asynchronous lock/FS work. A visible fact
    // cannot bypass its full lock-return outcome, including a terminal rejection.
    const first = !seal.publication;
    seal.publication ??= Promise.resolve().then(() => this.publishNativeFact(seal));
    await seal.publication;
    if (!first) await this.store.withSessionLock(this.identity.id, this.identity.ownerId, () => this.currentNativeFact(seal));
  }

  private assertOwnedCapture(seal: RetirementSeal): void {
    const owned = seal.owned;
    if (this.cleanupStop || (owned
      ? seal.intent.native.state !== "bound" || this.allocation !== owned.allocation
        || owned.allocation.runtime !== owned.runtime || owned.allocation.session !== owned.session || owned.session.id !== owned.sessionId
        || owned.allocation.threadId !== owned.threadId || seal.intent.native.threadId !== owned.threadId
      : seal.intent.native.state !== "pending" || !!this.allocation || !!this.allocating)) {
      throw new CodexSessionOfflineError("Codex owned native capture is unavailable");
    }
  }

  private async publishNativeFact(seal: RetirementSeal): Promise<void> {
    await this.store.withSessionLock(this.identity.id, this.identity.ownerId, async lease => {
      this.assertOwnedCapture(seal);
      if (!seal.nativeFact) throw new CodexSessionOfflineError("Codex owned native shutdown is unconfirmed");
      const current = await this.currentRetirement(seal);
      const worker = seal.current.worker;
      if (worker.state !== "ready") throw new CodexSessionOfflineError("Codex native fact target is unavailable");
      await lease.recordNativeQuiesce(current.revision, worker.connection, seal.intent, seal.nativeFact);
      await this.currentNativeFact(seal);
    });
  }

  private async currentNativeFact(seal: RetirementSeal): Promise<void> {
    this.assertOwnedCapture(seal);
    const current = await this.currentRetirement(seal);
    if (!seal.nativeFact || current.worker.state !== "retiring" || current.worker.nativeQuiesce?.kind !== seal.nativeFact.kind) {
      throw new CodexSessionOfflineError("Codex native fact is unavailable or mismatched");
    }
  }

  private async currentRetirement(seal: RetirementSeal): Promise<CodexManagedManifest> {
    const current = await this.store.read(this.identity.id, this.identity.ownerId);
    const expected = seal.current;
    const a = current?.worker, b = expected.worker;
    const domain = current?.processDomain, original = expected.processDomain;
    if (!current || current.version !== 5 || current.id !== expected.id || current.ownerId !== expected.ownerId
      || current.generation !== this.identity.generation || current.requiresExplicitResume
      || a?.state !== "retiring" || b.state !== "ready" || a.generation !== expected.generation || a.claimId !== b.claimId
      || !sameConnection(a.connection, b.connection) || !domain || !original
      || !sameConnection(domain.connection, original.connection)
      || domain.launcher.ioPlatformUuid !== original.launcher.ioPlatformUuid || domain.launcher.bootSessionUuid !== original.launcher.bootSessionUuid
      || domain.worker.ioPlatformUuid !== original.worker.ioPlatformUuid || domain.worker.bootSessionUuid !== original.worker.bootSessionUuid
      || a.retirement.operationId !== seal.intent.operationId || current.native.state !== seal.intent.native.state
      || (current.native.state === "bound" && (seal.intent.native.state !== "bound"
        || current.native.threadId !== seal.intent.native.threadId || this.allocation?.threadId !== current.native.threadId))
      || (current.native.state === "pending" && !!this.allocation)) {
      throw new CodexSessionOfflineError("Codex retirement operation is unavailable or fenced");
    }
    return current;
  }

  private async joinRetirement(seal: RetirementSeal): Promise<void> {
    await this.store.withSessionLock(this.identity.id, this.identity.ownerId, () => this.currentRetirement(seal));
    await seal.result;
  }

  private assertQuiesceIdle(current: CodexManagedManifest): void {
    if (this.active) throw new CodexSessionBusyError("Codex worker is working");
    if (this.stopping || this.retirementSeal || this.unavailable || this.cleanupStop
      || (!this.allocation && current.native.state !== "pending")) {
      throw new CodexSessionOfflineError("Codex worker is not eligible for idle quiesce");
    }
  }

  stop(id: string): Promise<void> {
    this.address(id);
    if (!this.stopping) this.observations.record("stop_requested");
    if (this.retirementSeal) return this.joinRetirement(this.retirementSeal);
    return this.stopOwned();
  }

  private stopOwned(): Promise<void> {
    if (!this.stopping) {
      // Close admission synchronously, before waiting for native preparation.
      const active = this.active;
      if (active && !active.dispatched) active.cancelled = true;
      this.stopping = (async () => {
        await this.allocating?.catch(() => {});
        await this.stopNative();
        await active?.work;
        await this.nativeEvents?.return?.();
        await this.forwarding;
        this.setEventStatus("offline");
        this.eventHub.close();
      })();
    }
    return this.stopping;
  }

  private async withFence<T>(operation: () => Promise<T>): Promise<T> {
    return this.store.withSessionLock(this.identity.id, this.identity.ownerId, async () => {
      await this.current();
      return operation();
    });
  }

  private async run(entry: PreparedTurn): Promise<void> {
    try {
      if (!this.allocation) {
        this.allocating = allocatePendingCodexThread(this.store, this.identity, this.options, this.claim).catch(error => {
          if (error instanceof CodexNativeCleanupError) {
            const cleanup = error.allocation;
            this.cleanupStop = () => cleanup.runtime.stop(cleanup.session.id);
          }
          if (error instanceof CodexNativeStartupCleanupError) this.cleanupStop = error.stop;
          throw error;
        });
        this.allocation = await this.allocating;
        this.forwarding = this.forwardNative();
      }
      let rejected: CodexInputRejectedError | undefined;
      await this.withFence(async () => {
        if (entry.cancelled || this.stopping || this.retirementSeal) return;
        // Admission writes the native request before this locked callback returns.
        // A changed generation/fence after allocation cannot authorize dispatch.
        entry.dispatched = true;
        let resolve!: () => void;
        const promise = new Promise<void>(done => { resolve = done; });
        entry.nativeSettled = { promise, resolve };
        if (this.nativeEventsClosed) resolve();
        this.observations.record("turn_dispatch_requested");
        try {
          await this.allocation!.runtime.startTurn(this.allocation!.session.id, entry.turn.id, entry.turn.input, entry.images);
          this.observations.record("turn_dispatch_returned");
        } catch (error) {
          this.observations.record("turn_dispatch_failed");
          if (!(error instanceof CodexInputRejectedError)) throw error;
          // This specific native admission check has written no request or turn.
          rejected = error; entry.dispatched = false; entry.nativeSettled = undefined;
        }
        entry.images = [];
      });
      // Only a complete successful lock return permits this classification.
      // Publication/release errors still follow the uncertain failure path below.
      if (rejected) {
        entry.turn.status = "failed";
        entry.turn.error = rejected.message;
        entry.turn.updatedAt = new Date().toISOString();
        return;
      }
      if (!entry.dispatched) {
        this.unavailable = true;
        await this.stopNative();
        entry.turn.status = "interrupted";
        entry.turn.updatedAt = new Date().toISOString();
        return;
      }
      while (true) {
        const native = await this.allocation.runtime.turn(this.allocation.session.id, entry.turn.id);
        if (!native) throw new Error("Codex native turn is unavailable");
        if (native.status !== "running") {
          await entry.nativeSettled?.promise;
          if (await this.allocation.runtime.status(this.allocation.session.id) === "offline") this.unavailable = true;
          entry.turn = { ...copyTurn(native), createdAt: entry.turn.createdAt };
          return;
        }
        await new Promise(resolve => setTimeout(resolve, 25));
      }
    } catch {
      // No new worker may recreate or replay after this failure: persisted state
      // is creating/bound. Keep shutdown authority on an uncertain cleanup error.
      this.unavailable = true;
      let stopped = false;
      try { await this.stopNative(); stopped = true; } catch {}
      entry.turn.status = entry.cancelled && stopped ? "interrupted" : "failed";
      entry.turn.error = stopped ? "Codex preparation or dispatch failed; session unavailable"
        : "Codex preparation failed; native exit is unconfirmed";
      entry.turn.updatedAt = new Date().toISOString();
    } finally {
      entry.images = [];
      this.observations.record(entry.turn.status === "failed" ? "turn_failed" : "turn_completed");
      if (this.active === entry) this.active = undefined;
      this.publish({ type: "turn_completed", operationId: entry.turn.id });
      if (entry.turn.error) this.publish({ type: "error", operationId: entry.turn.id, message: "Codex turn failed; inspect the retained turn result" });
      this.setEventStatus(this.stopping || this.unavailable ? "offline" : "idle");
      this.prune();
    }
  }

  private stopNative(): Promise<void> {
    if (this.cleanupStop) return this.nativeStop ??= this.cleanupStop();
    if (!this.allocation) return Promise.resolve();
    return this.nativeStop ??= this.allocation.runtime.stop(this.allocation.session.id);
  }

  private prune(): void {
    for (const [id, entry] of this.turns) {
      if (this.turns.size <= this.retention) break;
      if (entry.turn.status !== "running") this.turns.delete(id);
    }
  }
}

/** Open a pending worker without constructing a native app-server. */
export async function openPendingCodexWorker(
  store: CodexManagedStore,
  identity: CodexManagedIdentity,
  options: Omit<CodexAgentRuntimeOptions, "sandbox"> = {},
  claim?: CodexWorkerClaim,
): Promise<{ runtime: CodexWorkerRuntime & { quiesceIdle(id: string): Promise<void>; quiesceIdleWithIntent(id: string, operationId: string, publishIntent: IntentPublisher): Promise<void>; quiesceIdleWithNativeFact(id: string, operationId: string, publishIntent: IntentPublisher): Promise<void> }; session: AgentSession }> {
  identity = { ...identity };
  options = { ...options, ...(options.args ? { args: [...options.args] } : {}) };
  claim = claim ? { ...claim } : undefined;
  let allocation: CodexNativeAllocation | undefined;
  try {
    return await store.withSessionLock(identity.id, identity.ownerId, async () => {
      const current = await store.read(identity.id, identity.ownerId);
      if (!current || current.generation !== identity.generation || current.requiresExplicitResume
        || (current.native.state !== "pending" && !(codexResumeEpoch(current) && current.native.state === "bound"))) {
        throw new CodexSessionOfflineError("Codex pending session is unavailable or fenced");
      }
      assertCodexWorkerClaim(current, claim, "reserved");
      if (current.native.state === "bound") {
        if (!codexResumeEpoch(current) || current.version !== 5 || current.previous?.version !== 5 || !current.previous.history) throw new Error("Codex resume evidence is missing");
        const runtime = new (await import("./client.js")).CodexAgentRuntime({ ...options, sandbox: current.sandbox });
        const session = await runtime.resumeNativeThread(current.native.threadId, current.launchConfig);
        allocation = { runtime, session, threadId: current.native.threadId };
        if (!sameCodexHistory(await runtime.nativeHistoryCheckpoint(session.id), current.previous.history.checkpoint)) throw new Error("Codex resumed history mismatch");
        const fresh = await store.read(identity.id, identity.ownerId);
        if (!fresh || fresh.revision !== current.revision || fresh.generation !== identity.generation || fresh.requiresExplicitResume) throw new Error("Codex resume authority changed");
        assertCodexWorkerClaim(fresh, claim, "reserved");
      }
      return {
        runtime: new PendingCodexWorkerRuntime(store, identity, options, claim, allocation),
        session: { id: current.id, runtime: "codex", ownership: "owned", cwd: current.launchConfig.cwd },
      };
    });
  } catch (error) {
    // Ownership transfers only after the complete lease/lock return succeeds.
    if (allocation) {
      try { await allocation.runtime.stop(allocation.session.id); }
      catch { throw new CodexNativeCleanupError(allocation); }
    }
    throw error;
  }
}
