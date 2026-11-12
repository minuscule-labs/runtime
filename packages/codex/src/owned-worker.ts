import type { AgentSession, AgentStartConfig } from "@minu/runtime-core";
import { CodexAgentRuntime, CodexNativeStartupCleanupError, type CodexAgentRuntimeOptions } from "./client.js";
import { createCodexWorkerBridge, validateWorkerIdentity, type CodexWorkerIdentity, type CodexWorkerRuntime } from "./worker-bridge.js";
import { CodexManagedStore, assertCodexWorkerClaim, type CodexManagedManifest, type CodexRetirementIntent } from "./managed-store.js";
import { CodexNativeCleanupError } from "./managed-native.js";
import { openPendingCodexWorker } from "./pending-worker.js";
import { record } from "./rpc.js";
import type { CodexWorkerConnection } from "./worker-identity.js";

function sameConnection(a: CodexWorkerConnection, b: CodexWorkerConnection): boolean {
  return (["version", "ownerId", "sessionId", "generation", "claimId", "pid", "endpoint", "token"] as const).every(key => a[key] === b[key]);
}
function sameDomain(a: CodexManagedManifest["processDomain"], b: CodexManagedManifest["processDomain"]): boolean {
  return !!a && !!b && sameConnection(a.connection, b.connection)
    && a.launcher.ioPlatformUuid === b.launcher.ioPlatformUuid && a.launcher.bootSessionUuid === b.launcher.bootSessionUuid
    && a.worker.ioPlatformUuid === b.worker.ioPlatformUuid && a.worker.bootSessionUuid === b.worker.bootSessionUuid;
}
function sameNative(a: CodexManagedManifest["native"], b: CodexManagedManifest["native"]): boolean {
  return a.state === b.state && (a.state !== "bound" || b.state === "bound" && a.threadId === b.threadId);
}
import { collectDarwinProcessDomainObservation, type DarwinProcessDomainObservation } from "./darwin-process-domain.js";

/** Internal entry point. Native command options use private IPC, not argv;
 * registered credentials/configuration persist only in owner-private manifests.
 * Registered mode publishes only an exact persisted launch claim. No replacement
 * or process-group escalation is authorized by this entry point.
 */
if (!process.send) throw new Error("Codex owned worker requires a private IPC launch channel");
let bridge: Awaited<ReturnType<typeof createCodexWorkerBridge>> | undefined;
let startup: Promise<void> | undefined;
let shuttingDown = false;
let ready = false;
let shutdown: Promise<void> | undefined;
let startupCleanup: Promise<void> | undefined;
let nativeStartupCleanup: (() => Promise<void>) | undefined;
let registrationContext: {
  store: CodexManagedStore;
  identity: { id: string; ownerId: string; generation: string };
  claim: { claimId: string; pid: number };
} | undefined;

function stop(code: number): Promise<void> {
  return shutdown ??= (async () => {
    shuttingDown = true;
    clearTimeout(launchTimer);
    await startup?.catch(() => {});
    try { await nativeStartupCleanup?.(); await bridge?.close(); }
    catch {
      // Leave the worker alive on uncertain native exit so a controller cannot
      // mistake this worker's exit for confirmation that the app-server stopped.
      process.exitCode = 1;
      return;
    }
    if (process.connected) process.disconnect();
    process.exitCode = code;
  })();
}

function failedStartup(code: number): Promise<void> {
  return startupCleanup ??= (async () => {
    if (shuttingDown) return;
    clearTimeout(launchTimer);
    if (registrationContext) {
      const { store, identity, claim } = registrationContext;
      if (!await store.claimPreReadyCleanup(identity, claim)) {
        // Durable readiness may already have allowed another consumer to adopt
        // this worker. Neither missing IPC acknowledgment nor uncertainty can
        // revoke it. Normal RPC stop / explicit signals retain cleanup authority.
        if (process.connected) process.disconnect();
        return;
      }
    }
    await stop(code);
  })();
}

const launchTimer = setTimeout(() => { void failedStartup(1); }, 10_000);
process.on("SIGTERM", () => { void stop(0); });
process.on("SIGINT", () => { void stop(0); });
process.on("disconnect", () => {
  // Registered workers consult durable publication, not IPC-local readiness.
  if (registrationContext || !ready) void failedStartup(1);
});
process.once("message", message => {
  if (shuttingDown) return;
  clearTimeout(launchTimer);
  startup = (async () => {
    const launch = record(message);
    const identity = record(launch?.identity) as unknown as CodexWorkerIdentity;
    validateWorkerIdentity(identity);
    if (launch?.type !== "launch" || (launch.options !== undefined && !record(launch.options))) {
      throw new Error("Invalid Codex worker launch");
    }
    let runtime: CodexWorkerRuntime;
    let pendingRuntime: Awaited<ReturnType<typeof openPendingCodexWorker>>["runtime"] | undefined;
    let session: AgentSession;
    let registrationStore: CodexManagedStore | undefined;
    const claimId = launch.claimId;
    if (claimId !== undefined && (typeof claimId !== "string" || launch.managedRoot === undefined)) throw new Error("Invalid Codex worker claim");
    if (launch.managedRoot !== undefined) {
      if (typeof launch.managedRoot !== "string" || launch.config !== undefined || launch.threadId !== undefined
        || Object.hasOwn(record(launch.options) ?? {}, "sandbox")) throw new Error("Invalid pending Codex worker launch");
      const store = new CodexManagedStore(launch.managedRoot);
      if (typeof claimId === "string") {
        registrationStore = store;
        registrationContext = { store, identity: { id: identity.sessionId, ownerId: identity.ownerId, generation: identity.generation },
          claim: { claimId, pid: process.pid } };
      }
      const opened = await openPendingCodexWorker(store, {
        id: identity.sessionId, ownerId: identity.ownerId, generation: identity.generation,
      }, launch.options as CodexAgentRuntimeOptions | undefined,
      typeof claimId === "string" ? { claimId, pid: process.pid } : undefined);
      ({ runtime, session } = opened); pendingRuntime = opened.runtime;
      // Until a bridge exists, retain the successfully opened runtime for
      // cleanup only after registered pre-ready abort arbitration permits it.
      nativeStartupCleanup = () => opened.runtime.stop(opened.session.id);
    } else {
      if (!record(launch.config)) throw new Error("Invalid Codex worker launch");
      const native = new CodexAgentRuntime(launch.options as CodexAgentRuntimeOptions | undefined);
      runtime = native;
      session = launch.threadId === undefined
        ? await native.start(launch.config as AgentStartConfig)
        : await native.resumeNativeThread(launch.threadId as string, launch.config as AgentStartConfig);
    }
    const authorize = async (control?: "interrupt" | "observe") => {
      if (!registrationStore || typeof claimId !== "string") return;
      if (shuttingDown) throw new Error("Codex worker is shutting down");
      const check = async () => {
        const current = await registrationStore!.read(identity.sessionId, identity.ownerId);
        if (shuttingDown || !current || current.generation !== identity.generation || current.requiresExplicitResume) throw new Error("Codex worker is fenced");
        assertCodexWorkerClaim(current, { claimId, pid: process.pid });
        if (current.worker.state !== "ready" || current.worker.connection.token !== bridge?.connection.token
          || current.worker.connection.endpoint !== bridge.connection.endpoint) throw new Error("Codex worker connection is fenced");
      };
      // Read-only observations and preparation cancellation must not queue behind
      // allocation. Dispatched interrupts recheck authority under withFence.
      if (control === "interrupt" || control === "observe") await check();
      else await registrationStore.withSessionLock(identity.sessionId, identity.ownerId, check);
    };
    let retirement: { operationId: string; admitted: boolean; connection: CodexWorkerConnection;
      domain: CodexManagedManifest["processDomain"]; intent?: CodexRetirementIntent; completion: Promise<void> } | undefined;
    const retirementAuthority = async (operationId: string, connection: CodexWorkerConnection) => {
      if (!registrationStore || !pendingRuntime || !bridge || !sameConnection(connection, bridge.connection)) throw new Error("Codex retirement is unsupported");
      // Preflight must not queue behind an active allocation's lifecycle lock.
      // The producer rechecks fresh authority under its seal/publication locks;
      // its locked callback also binds that context to this actual connection.
      const current = await registrationStore.read(identity.sessionId, identity.ownerId);
      const worker = current?.worker;
      if (!current || current.version !== 5 || !current.processDomain || current.generation !== identity.generation || current.requiresExplicitResume
        || current.ownerId !== identity.ownerId || current.id !== identity.sessionId
        || (worker?.state !== "ready" && worker?.state !== "retiring") || worker.generation !== identity.generation
        || !sameConnection(worker.connection, connection) || current.native.state === "creating") throw new Error("Codex retirement is unavailable or fenced");
      if (retirement && (retirement.operationId !== operationId || !sameConnection(retirement.connection, connection)
        || !sameDomain(retirement.domain, current.processDomain))) throw new Error("Codex retirement operation conflicts");
      if (worker.state === "ready") {
        if (shuttingDown || retirement?.admitted) throw new Error("Codex retirement is unavailable");
      } else if (!retirement?.admitted || !retirement.intent || worker.retirement.operationId !== operationId
        || !sameNative(worker.retirement.native, retirement.intent.native)) throw new Error("Codex retirement local evidence is unavailable");
      return current;
    };
    const retire = async (operationId: string, connection: CodexWorkerConnection) => {
      const current = await retirementAuthority(operationId, connection);
      if (retirement && (retirement.operationId !== operationId || !sameConnection(retirement.connection, connection)
        || !sameDomain(retirement.domain, current.processDomain))) throw new Error("Codex retirement operation conflicts");
      if (!retirement) {
        const attempt = { operationId, admitted: false, connection: structuredClone(connection), domain: structuredClone(current.processDomain),
          intent: undefined as CodexRetirementIntent | undefined, completion: undefined as unknown as Promise<void> };
        retirement = attempt;
        attempt.completion = Promise.resolve().then(() => pendingRuntime!.quiesceIdleWithNativeFact(session.id, operationId, async context => {
          // This callback is invoked synchronously immediately after the real
          // runtime seal. Mark admission before validation/commit can await/fail.
          attempt.admitted = true;
          const c = context.current;
          if (c.version !== 5 || c.worker.state !== "ready" || c.requiresExplicitResume || c.generation !== identity.generation
            || !sameConnection(c.worker.connection, attempt.connection) || !sameDomain(c.processDomain, attempt.domain)
            || context.intent.operationId !== operationId || !sameNative(c.native, context.intent.native)) throw new Error("Codex retirement seal context mismatch");
          attempt.intent = structuredClone(context.intent);
          await context.commitIntentWithHistory();
        })).finally(() => { if (!attempt.admitted && retirement === attempt) retirement = undefined; });
        void attempt.completion.catch(() => {});
      }
      const attempt = retirement;
      await attempt.completion;
      await pendingRuntime!.quiesceIdleWithNativeFact(session.id, operationId, async () => { throw new Error("Codex retirement publisher cannot repeat"); });
    };
    const beforeClose = async () => {
      const attempt = retirement;
      if (!attempt?.admitted) return;
      await attempt.completion;
      // Revalidate cached success; visible data never substitutes for the full
      // attempt outcome, and this barrier never waits for bridge closure itself.
      await pendingRuntime!.quiesceIdleWithNativeFact(session.id, attempt.operationId, async () => { throw new Error("Codex retirement publisher cannot repeat"); });
    };
    let workerObservation: DarwinProcessDomainObservation | undefined;
    let observationRevision: number | undefined;
    try {
      if (registrationStore && (await registrationStore.read(identity.sessionId, identity.ownerId))?.version === 5) {
        observationRevision = await registrationStore.withSessionLock(identity.sessionId, identity.ownerId, async () => {
          const current = await registrationStore!.read(identity.sessionId, identity.ownerId);
          if (shuttingDown || !current || current.version !== 5 || current.generation !== identity.generation || current.requiresExplicitResume) throw new Error("Codex launch is fenced");
          assertCodexWorkerClaim(current, { claimId: claimId as string, pid: process.pid }, "reserved");
          return current.revision;
        });
        workerObservation = await collectDarwinProcessDomainObservation();
        if (!workerObservation) throw new Error("Codex worker domain observation is unavailable");
      }
      bridge = await createCodexWorkerBridge(runtime, session, identity,
        typeof claimId === "string" ? { claimId, authorize, retire, beforeClose } : undefined);
      nativeStartupCleanup = undefined; // The bridge now owns runtime shutdown.
      void bridge.closed.then(() => {
        if (process.connected) process.disconnect();
      });
      if (registrationStore) {
        await registrationStore.withSessionLock(identity.sessionId, identity.ownerId, async lease => {
          const current = await registrationStore!.read(identity.sessionId, identity.ownerId);
          if (shuttingDown || !current || current.generation !== identity.generation || current.requiresExplicitResume) throw new Error("Codex worker launch is fenced");
          if ((current.version === 5) !== (observationRevision !== undefined)
            || (observationRevision !== undefined && current.revision !== observationRevision)) throw new Error("Codex launch changed during domain collection");
          await lease.publishWorkerReady(current.revision, bridge!.connection);
        });
      }
    } catch (error) {
      // Registered cleanup must first win the durable pre-ready abort transition.
      // Publication may have succeeded before fsync/lock-release reported failure.
      if (!registrationContext) {
        if (bridge) await bridge.close();
        else await runtime.stop(session.id);
      }
      throw error;
    }
    if (shuttingDown) return;
    await new Promise<void>((resolve, reject) => {
      process.send!({ type: "ready", connection: bridge!.connection, ...(workerObservation ? { processDomain: workerObservation } : {}) }, error => error ? reject(error) : resolve());
    });
    ready = true;
  })();
  void startup.catch(error => {
    if (error instanceof CodexNativeStartupCleanupError) nativeStartupCleanup = error.stop;
    if (error instanceof CodexNativeCleanupError) nativeStartupCleanup = () => error.allocation.runtime.stop(error.allocation.session.id);
    // Do not forward native error text or launch configuration through diagnostics.
    if (process.connected) process.send?.({ type: "failed" }, () => { void failedStartup(1); });
    else void failedStartup(1);
  });
});
