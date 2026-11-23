import { randomUUID } from "node:crypto";
import type { AgentEvent, AgentStartConfig, AgentStatus, AgentTurn, ManagedAgentSession, ManagedSessionSummary, RuntimeImageContent, RuntimeSessionProfile, RuntimeSessionEvents } from "@minu/runtime-core";
import { SESSION_PROFILE_LIMITS, SESSION_EVENTS_LIMITS, sessionProfile, sessionEvents } from "@minu/runtime-core";
import { diagnosticAvailable, openCodexDiagnostic } from "./diagnostic.js";
import { CodexAgentRuntime, type CodexAgentRuntimeOptions } from "./client.js";
import { CodexManagedStore, codexManagedRoot, codexResumeEligible, codexResumeEpoch, sameCodexHistory } from "./managed-store.js";
import { recoverCodexWorker } from "./worker-recovery.js";
import { createPendingCodexSession } from "./managed-native.js";
import { launchOrReconnectCodexWorker, reconnectCodexWorker, finalizeCodexWorkerRetirement } from "./managed-worker.js";
import { CodexWorkerClient, type CodexWorkerMethod } from "./worker-client.js";
import type { CodexWorkerConnection } from "./worker-identity.js";

interface Binding {
  ownerId: string;
  client: CodexWorkerClient;
  connection: CodexWorkerConnection;
  stopped: boolean;
  stopping?: Promise<void>;
}

/** Public adapter's owner-authorized routing only. No cold resume or replacement. */
export class CodexManagedClient {
  private readonly store: CodexManagedStore;
  private readonly root: string;
  private readonly bindings = new Map<string, Binding>();
  private readonly suspending = new Map<string, { ownerId: string; result: Promise<void> }>();
  private readonly destroying = new Map<string, { ownerId: string; result: Promise<void> }>();
  private readonly inspectionReads = new Set<string>();
  private readonly diagnosticOpening = new Set<string>();
  private readonly intents = new Map<string, { ownerId: string; users: number }>();
  private readonly native: Omit<CodexAgentRuntimeOptions, "sandbox" | "managedRoot">;

  constructor(
    options: CodexAgentRuntimeOptions,
    private readonly inProcessIdentity: (id: string) => boolean,
  ) {
    this.root = options.managedRoot ?? codexManagedRoot();
    this.store = new CodexManagedStore(this.root);
    const { sandbox: _sandbox, managedRoot: _root, ...native } = options;
    this.native = { ...native, ...(native.args ? { args: [...native.args] } : {}) };
  }

  has(id: string): boolean { return this.bindings.has(id); }
  hasIdentity(id: string): boolean { return this.has(id) || this.intents.has(id); }

  private begin(id: string, ownerId: string): () => void {
    if (this.inProcessIdentity(id)) throw new Error("Codex managed identity conflicts with an in-process session");
    const bound = this.bindings.get(id);
    const pending = this.intents.get(id);
    if ((bound && bound.ownerId !== ownerId) || (pending && pending.ownerId !== ownerId)) {
      throw new Error("Codex session is already bound to another owner in this adapter");
    }
    const intent = pending ?? { ownerId, users: 0 };
    intent.users++;
    this.intents.set(id, intent);
    return () => { if (--intent.users === 0 && this.intents.get(id) === intent) this.intents.delete(id); };
  }

  private bind(id: string, ownerId: string, connection: CodexWorkerConnection): void {
    if (this.inProcessIdentity(id) || (this.bindings.has(id) && this.bindings.get(id)!.ownerId !== ownerId)) {
      throw new Error("Codex session identity collision");
    }
    const existing = this.bindings.get(id);
    // A successful re-authentication of this exact worker must not discard an
    // in-flight/confirmed stop. Runtime ID alone cannot identify that worker.
    if (existing && (["version", "ownerId", "sessionId", "generation", "claimId", "pid", "endpoint", "token"] as const)
      .every(key => existing.connection[key] === connection[key])) return;
    // A failed authorization never changes a previous binding or grants routing.
    this.bindings.set(id, { ownerId, client: new CodexWorkerClient(connection), connection: { ...connection }, stopped: false });
  }

  async create(config: AgentStartConfig, ownerId: string, sandbox: "read-only" | "workspace-write" | "danger-full-access"): Promise<ManagedAgentSession> {
    const identity = { id: randomUUID(), ownerId, generation: randomUUID() };
    if (this.hasIdentity(identity.id)) throw new Error("Codex managed identity collision");
    const release = this.begin(identity.id, ownerId);
    try {
      const session = await createPendingCodexSession(this.store, identity, config, sandbox, process.platform === "darwin" ? 5 : 4);
      const connection = await launchOrReconnectCodexWorker(this.root, identity, { native: this.native });
      this.bind(session.id, ownerId, connection);
      return session;
    } finally { release(); }
  }

  async connect(id: string, ownerId: string): Promise<ManagedAgentSession> {
    const release = this.begin(id, ownerId);
    try {
      if (this.suspending.has(id) || this.destroying.has(id)) throw new Error("Codex lifecycle operation is pending");
      const manifest = await this.store.read(id, ownerId);
      if (!manifest || manifest.requiresExplicitResume || manifest.worker.state !== "ready" || manifest.worker.generation !== manifest.generation) throw new Error("Codex living worker is unavailable");
      const connection = await reconnectCodexWorker(this.root, { id, ownerId, generation: manifest.generation });
      this.bind(id, ownerId, connection);
      return { id, ownerId, runtime: "codex", ownership: "owned", cwd: manifest.launchConfig.cwd };
    } finally { release(); }
  }

  async resume(id: string, ownerId: string, allowStopped = false): Promise<ManagedAgentSession> {
    const release = this.begin(id, ownerId);
    try {
      let manifest;
      try { manifest = await this.store.read(id, ownerId); }
      catch { throw new Error("Codex managed resume material is unavailable or unsafe"); }
      if (this.suspending.has(id) || this.destroying.has(id)) throw new Error("Codex lifecycle operation is pending");
      // A force-stopped slot (fenced, worker none) relaunches only on explicit request and only where a fresh launch
      // is already permitted: native never started, or a verified resume epoch. Anything else stays fenced.
      if (allowStopped && manifest?.requiresExplicitResume && manifest.worker.state === "none"
        && (manifest.native.state === "pending" || codexResumeEpoch(manifest))) {
        const expected = manifest;
        manifest = await this.store.withSessionLock(id, ownerId, async lease => {
          const current = await this.store.read(id, ownerId);
          if (!current || current.revision !== expected.revision || current.generation !== expected.generation) throw new Error("Codex resume authority changed");
          return lease.update(current.revision, { requiresExplicitResume: false });
        });
      }
      if (!manifest || manifest.requiresExplicitResume) throw new Error("Codex managed session is unavailable or fenced");
      if (manifest.worker.state === "retired") {
        if (process.platform !== "darwin" || !codexResumeEligible(manifest)) throw new Error("Codex clean cold resume is unavailable");
        const expected = manifest;
        manifest = await this.store.withSessionLock(id, ownerId, async lease => {
          const current = await this.store.read(id, ownerId);
          if (!current || current.revision !== expected.revision || current.generation !== expected.generation) throw new Error("Codex resume authority changed");
          return lease.beginResume(current.revision, randomUUID());
        });
      }
      // A new epoch has an explicit predecessor receipt; ordinary uncertain
      // records still cannot authorize launch/replacement.
      const connection = await launchOrReconnectCodexWorker(this.root, { id, ownerId, generation: manifest.generation }, { native: this.native });
      this.bind(id, ownerId, connection);
      return { id, ownerId, runtime: "codex", ownership: "owned", cwd: manifest.launchConfig.cwd };
    } finally { release(); }
  }

  async inventory(ownerId: string, only?: string): Promise<ManagedSessionSummary[]> {
    try {
      const manifests = only === undefined ? await this.store.list(ownerId) : [await this.store.read(only, ownerId)].filter(m => m !== undefined);
      const summaries: ManagedSessionSummary[] = [];
      for (const manifest of manifests) {
        let state: ManagedSessionSummary["state"] = "unavailable";
        if (process.platform === "darwin" && codexResumeEligible(manifest)) state = "suspended";
        else if (manifest.requiresExplicitResume && manifest.worker.state === "none") state = "suspended"; // Force-stopped.
        else if (!manifest.requiresExplicitResume && manifest.native.state === "pending" && manifest.worker.state === "none") state = "suspended";
        else if (!manifest.requiresExplicitResume && manifest.worker.state === "ready") {
          let connection: CodexWorkerConnection | undefined;
          let status: unknown;
          try {
            connection = await reconnectCodexWorker(this.root, { id: manifest.id, ownerId, generation: manifest.generation });
            status = await new CodexWorkerClient(connection).request("status");
          } catch { /* Unreachable/fenced workers are unavailable, never repaired or replaced. */ }
          // Do not turn corrupt/unsafe persisted data into a silent unavailable
          // summary, including changes that happened while authentication waited.
          const latest = await this.store.read(manifest.id, ownerId);
          if (!latest) throw new Error("Inventory changed during observation");
          if (connection && (status === "idle" || status === "working") && latest.generation === manifest.generation
            && !latest.requiresExplicitResume && latest.worker.state === "ready" && latest.worker.generation === connection.generation
            && latest.worker.connection.token === connection.token && latest.worker.connection.pid === connection.pid
            && latest.worker.connection.endpoint === connection.endpoint && latest.worker.claimId === connection.claimId) state = "active";
        }
        summaries.push({ id: manifest.id, ownerId, state, createdAt: new Date(manifest.createdAt).toISOString() });
      }
      return summaries;
    } catch { throw new Error("Codex managed inventory is unavailable: invalid or unsafe saved data"); }
  }

  private async observationConnection(id: string, ownerId: string): Promise<CodexWorkerConnection | undefined> {
    const manifest = await this.store.read(id, ownerId);
    return manifest && !manifest.requiresExplicitResume && manifest.worker.state === "ready" && manifest.worker.generation === manifest.generation
      ? structuredClone(manifest.worker.connection) : undefined;
  }

  private async observe(id: string, ownerId: string, kind: "profile" | "events", caller?: AbortSignal): Promise<RuntimeSessionProfile | RuntimeSessionEvents | undefined> {
    const limits = kind === "profile" ? SESSION_PROFILE_LIMITS : SESSION_EVENTS_LIMITS;
    const signal = AbortSignal.any([AbortSignal.timeout(limits.readMs), ...(caller ? [caller] : [])]);
    const key = JSON.stringify([ownerId, id]); let aborted: (() => void) | undefined;
    try {
      signal.throwIfAborted();
      if (this.inspectionReads.has(key) || this.inspectionReads.size >= 16) return undefined;
      this.inspectionReads.add(key);
      const task = (async () => {
        const original = await this.observationConnection(id, ownerId); signal.throwIfAborted();
        if (!original) return undefined;
        const result = await new CodexWorkerClient(original).observe(kind, signal);
        signal.throwIfAborted();
        const current = await this.observationConnection(id, ownerId); signal.throwIfAborted();
        return current && (["version", "ownerId", "sessionId", "generation", "claimId", "pid", "endpoint", "token"] as const)
          .every(field => original[field] === current[field]) ? result : undefined;
      })();
      // Keep physical ownership through filesystem work even if cancellation wins.
      void task.then(() => this.inspectionReads.delete(key), () => this.inspectionReads.delete(key));
      return await Promise.race([task, new Promise<never>((_, reject) => {
        aborted = () => reject(new DOMException("Codex inspection aborted", "AbortError"));
        signal.addEventListener("abort", aborted, { once: true }); if (signal.aborted) aborted();
      })]);
    } catch {
      if (caller?.aborted) throw new DOMException("Codex inspection aborted", "AbortError");
      return undefined;
    } finally { if (aborted) signal.removeEventListener("abort", aborted); }
  }

  async inspectProfile(id: string, ownerId: string, signal?: AbortSignal): Promise<RuntimeSessionProfile | undefined> {
    const value = await this.observe(id, ownerId, "profile", signal); return value ? sessionProfile(value) : undefined;
  }
  async inspectEvents(id: string, ownerId: string, signal?: AbortSignal): Promise<RuntimeSessionEvents | undefined> {
    const value = await this.observe(id, ownerId, "events", signal); return value ? sessionEvents(value) : undefined;
  }
  async supportsDiagnostic(id: string): Promise<boolean> { return !this.binding(id).stopped && await diagnosticAvailable(); }
  async openDiagnostic(id: string): Promise<void> {
    try {
      const binding = this.binding(id), expected = structuredClone(binding.connection);
      if (binding.stopped || binding.stopping || this.diagnosticOpening.has(id)) throw new Error("Unavailable");
      this.diagnosticOpening.add(id);
      try {
        const authorize = async () => {
          const current = await this.observationConnection(id, binding.ownerId);
          if (binding.stopped || binding.stopping || !current || (["version", "ownerId", "sessionId", "generation", "claimId", "pid", "endpoint", "token"] as const)
            .some(field => current[field] !== expected[field])) throw new Error("Unavailable");
        };
        await authorize();
        const profile = await this.inspectProfile(id, binding.ownerId), events = await this.inspectEvents(id, binding.ownerId);
        if (!profile || !events) throw new Error("Unavailable");
        await openCodexDiagnostic(this.root, id, binding.ownerId, profile, events, authorize);
      } finally { this.diagnosticOpening.delete(id); }
    } catch { throw new Error("Codex local diagnostic is unavailable"); }
  }

  /** Fence, one admission-bypassing stop, then absence proof or verified termination. Never clears on uncertainty. */
  async forceStop(id: string, ownerId: string): Promise<void> {
    const release = this.begin(id, ownerId);
    try {
      if (await recoverCodexWorker(this.store, id, ownerId) === "missing") throw new Error("Codex managed session is unavailable");
      const bound = this.bindings.get(id); if (bound?.ownerId === ownerId) bound.stopped = true;
    } catch { throw new Error("Codex managed force-stop is unavailable or uncertain"); }
    finally { release(); }
  }

  async destroy(id: string, ownerId: string): Promise<void> {
    const pending = this.destroying.get(id);
    if (pending) {
      if (pending.ownerId !== ownerId) throw new Error("Codex lifecycle owner mismatch");
      return pending.result;
    }
    const release = this.begin(id, ownerId);
    const result = Promise.resolve().then(async () => {
      const addressed = await this.store.read(id, ownerId);
      if (!addressed) throw new Error("Codex destruction material is unavailable");
      const neverStarted = addressed.worker.state === "none" && addressed.native.state === "pending" && !addressed.requiresExplicitResume;
      // Prefer the clean idle retirement (keeps verified history) where it exists; its failure is not an error.
      if (!neverStarted && !addressed.requiresExplicitResume && addressed.worker.state === "ready") await this.suspend(id, ownerId, addressed.generation).catch(() => {});
      const expected = await this.store.read(id, ownerId);
      if (!expected || expected.generation !== addressed.generation) throw new Error("Codex destruction authority changed");
      // An unfenced none slot with a bound thread may still have an unregistered (legacy) worker: refuse it.
      if (expected.worker.state === "none" && !expected.requiresExplicitResume && expected.native.state !== "pending") throw new Error("Codex destruction material is uncertain");
      // Absence is proven (or the slot is already none/retired) before the resume metadata goes; history stays.
      if (expected.worker.state !== "none" && expected.worker.state !== "retired") {
        if (await recoverCodexWorker(this.store, id, ownerId, { remove: true }) !== "removed") throw new Error("Codex destruction is uncertain");
      } else {
        await this.store.withSessionLock(id, ownerId, async lease => {
          const current = await this.store.read(id, ownerId);
          if (!current || current.generation !== addressed.generation || current.revision !== expected.revision) throw new Error("Codex destruction is stale");
          if (current.worker.state === "retired" || current.requiresExplicitResume) await lease.removeStoppedSession(current.revision);
          else await lease.removeResumeMetadata(current.revision);
        });
      }
      if (await this.store.read(id, ownerId)) throw new Error("Codex destruction readback is uncertain");
      if (this.bindings.get(id)?.ownerId === ownerId) this.bindings.delete(id);
    }).catch(() => { throw new Error("Codex managed destruction is unavailable or uncertain"); });
    this.destroying.set(id, { ownerId, result });
    try { await result; } finally { if (this.destroying.get(id)?.result === result) this.destroying.delete(id); release(); }
  }

  async suspend(id: string, ownerId: string, expectedGeneration?: string): Promise<void> {
    const pending = this.suspending.get(id);
    if (pending) {
      if (pending.ownerId !== ownerId) throw new Error("Codex lifecycle owner mismatch");
      return pending.result;
    }
    const release = this.begin(id, ownerId);
    const result = Promise.resolve().then(async () => {
      if (process.platform !== "darwin") throw new Error("Codex suspension is unsupported on this platform");
      let manifest = await this.store.read(id, ownerId);
      if (!manifest || manifest.version !== 5 || manifest.requiresExplicitResume
        || (expectedGeneration !== undefined && manifest.generation !== expectedGeneration)) throw new Error("Codex suspension is unavailable for this saved session");
      if (codexResumeEligible(manifest)) return;
      if (manifest.worker.state !== "ready" || !manifest.processDomain || manifest.native.state === "creating") throw new Error("Codex suspension material is uncertain");
      const generation = manifest.generation;
      // The retirement route authenticates the exact bridge itself. A generic
      // identity RPC would queue behind preparation's lock before busy rejection.
      const connection = structuredClone(manifest.worker.connection);
      const operationId = randomUUID();
      // Dispatch once; failures remain uncertain, never a resend/stop fallback.
      await new CodexWorkerClient(connection).retire(operationId);
      manifest = await this.store.read(id, ownerId);
      if (!manifest || manifest.version !== 5 || manifest.generation !== generation || manifest.worker.state !== "retiring"
        || manifest.worker.retirement.operationId !== operationId || !manifest.worker.nativeQuiesce || !manifest.history) throw new Error("Codex suspension receipt is unavailable");
      const target = { identity: { id, ownerId, generation }, expectedRevision: manifest.revision, connection, intent: structuredClone(manifest.worker.retirement) };
      const deadline = Date.now() + 5_000;
      while (true) {
        // Explicit bounded exit wait: only a confirmed occupied slot may be
        // observed again. No mutation retry, revision rebase or uncertainty retry.
        const observed = await finalizeCodexWorkerRetirement(this.root, target);
        if (observed.status === "finalized") break;
        if (observed.status !== "pid_present" || Date.now() >= deadline) throw new Error("Codex worker exit is unconfirmed");
        await new Promise(resolve => setTimeout(resolve, 25));
      }
      const retired = await this.store.read(id, ownerId);
      if (!retired || retired.version !== 5 || retired.worker.state !== "retired" || retired.generation !== generation
        || retired.requiresExplicitResume || !retired.history || retired.history.operationId !== operationId) throw new Error("Codex retired history receipt is unavailable");
      const checkpoint = retired.native.state === "pending" ? { kind: "pending" as const }
        : retired.native.state === "bound" ? await new CodexAgentRuntime({ ...this.native, sandbox: retired.sandbox }).inspectNativeHistory(retired.native.threadId, retired.launchConfig.cwd)
        : undefined;
      if (!checkpoint || !sameCodexHistory(checkpoint, retired.history.checkpoint)) throw new Error("Codex persisted history does not match the sealed checkpoint");
      await this.store.withSessionLock(id, ownerId, async lease => {
        const current = await this.store.read(id, ownerId);
        if (!current || current.revision !== retired.revision || current.generation !== generation) throw new Error("Codex history authority changed");
        const verified = await lease.verifyHistory(current.revision, checkpoint);
        const readback = await this.store.read(id, ownerId);
        if (!readback || readback.revision !== verified.revision || !codexResumeEligible(readback)) throw new Error("Codex history verification is uncertain");
      });
      const bound = this.bindings.get(id); if (bound?.ownerId === ownerId) bound.stopped = true;
    }).catch(() => { throw new Error("Codex managed suspension is unavailable or uncertain"); });
    this.suspending.set(id, { ownerId, result });
    try { await result; } finally { if (this.suspending.get(id)?.result === result) this.suspending.delete(id); release(); }
  }

  private binding(id: string): Binding {
    const binding = this.bindings.get(id);
    if (!binding) throw new Error("Codex managed session has not been owner-authorized in this adapter");
    return binding;
  }

  request<T = unknown>(id: string, method: CodexWorkerMethod, args?: { turnId?: string; input?: string; images?: RuntimeImageContent[] }): Promise<T> {
    return this.binding(id).client.request<T>(method, args);
  }

  async status(id: string): Promise<AgentStatus> {
    const binding = this.binding(id);
    if (binding.stopped) return "offline";
    try {
      const status = await binding.client.request("status");
      if (status === "idle" || status === "working" || status === "offline") return status;
    } catch {}
    return "offline";
  }

  async verifyReachable(id: string): Promise<void> {
    const binding = this.binding(id);
    await binding.client.verifyIdentity();
    if (await this.status(id) === "offline") throw new Error("Codex managed worker is offline");
  }

  events(id: string): AsyncIterableIterator<AgentEvent> {
    return this.binding(id).client.events();
  }

  async supportsEvents(id: string): Promise<boolean> {
    const stream = this.binding(id).client.events();
    try { await stream.ready; return true; }
    catch { return false; }
    finally { await stream.return?.(); }
  }

  async turn(id: string, turnId: string): Promise<AgentTurn | undefined> {
    return await this.request<AgentTurn | null>(id, "turn", { turnId }) ?? undefined;
  }

  async send(id: string, input: string, images: RuntimeImageContent[] = []): Promise<void> {
    const turnId = randomUUID();
    // Dispatch exactly once. Lost acknowledgments or polling errors surface as
    // uncertainty; never recover them by resending input under another turn ID.
    let turn = await this.request<AgentTurn>(id, "startTurn", { turnId, input, ...(images.length ? { images } : {}) });
    while (turn.status === "running") {
      await new Promise(resolve => setTimeout(resolve, 25));
      const observed = await this.turn(id, turnId);
      if (!observed) throw new Error("Accepted Codex turn is no longer observable; input was not replayed");
      turn = observed;
    }
    if (turn.status !== "completed") throw new Error(turn.error ?? `Codex turn ${turn.status}`);
  }

  async stop(id: string): Promise<void> {
    const binding = this.binding(id);
    if (binding.stopped) return;
    if (binding.stopping) return binding.stopping;
    binding.stopping = (async () => {
      const confirmation = await binding.client.request("stop");
      if (confirmation !== null) throw new Error("Codex managed stop confirmation is invalid");
      // Only the confirmed native-stop response is success, not an unreachable
      // listener or an uncertain failure. This is not group recovery authority.
      binding.stopped = true;
    })();
    try { await binding.stopping; }
    finally { binding.stopping = undefined; }
  }
}
