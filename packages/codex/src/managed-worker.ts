import { fork, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { CodexAgentRuntimeOptions } from "./client.js";
import type { CodexManagedIdentity } from "./managed-native.js";
import { CodexManagedStore, CodexManifestConflictError, type CodexManifestLease, type CodexManagedManifest, type CodexRetirementIntent, codexResumeEpoch } from "./managed-store.js";
import { CodexWorkerClient } from "./worker-client.js";
import { validateWorkerConnection, type CodexWorkerConnection } from "./worker-identity.js";
import { record } from "./rpc.js";
import { observeDarwinPidAbsence } from "./darwin-process-absence.js";
import { collectDarwinProcessDomainObservation, type DarwinProcessDomainObservation } from "./darwin-process-domain.js";

interface ReadyReport { connection: CodexWorkerConnection; processDomain?: unknown }

function observation(value: unknown): DarwinProcessDomainObservation {
  const fields = record(value);
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
  if (!fields || Object.keys(fields).length !== 2 || Object.keys(fields).some(key => !["ioPlatformUuid", "bootSessionUuid"].includes(key))
    || ![fields.ioPlatformUuid, fields.bootSessionUuid].every(id => typeof id === "string" && uuid.test(id)
      && !/^(?:0|-)+$/.test(id) && !/^(?:f|-)+$/.test(id))) throw new Error("Codex worker domain report is invalid");
  return { ioPlatformUuid: fields.ioPlatformUuid as string, bootSessionUuid: fields.bootSessionUuid as string };
}

export class CodexWorkerUnavailableError extends Error {}

function sameConnection(a: CodexWorkerConnection, b: CodexWorkerConnection): boolean {
  return (["version", "ownerId", "sessionId", "generation", "endpoint", "token", "pid", "claimId"] as const)
    .every(key => a[key] === b[key]);
}

interface RetirementFinalizationTarget {
  identity: CodexManagedIdentity;
  expectedRevision: number;
  connection: CodexWorkerConnection;
  intent: CodexRetirementIntent;
}

function sameNative(a: CodexManagedManifest["native"], b: CodexManagedManifest["native"]): boolean {
  return a.state === b.state && (a.state !== "bound" || b.state === "bound" && a.threadId === b.threadId);
}
function sameDomain(a: CodexManagedManifest["processDomain"], b: CodexManagedManifest["processDomain"]): boolean {
  return !!a && !!b && sameConnection(a.connection, b.connection)
    && a.launcher.ioPlatformUuid === b.launcher.ioPlatformUuid && a.launcher.bootSessionUuid === b.launcher.bootSessionUuid
    && a.worker.ioPlatformUuid === b.worker.ioPlatformUuid && a.worker.bootSessionUuid === b.worker.bootSessionUuid;
}

function finalizationTarget(current: CodexManagedManifest | undefined, expected: RetirementFinalizationTarget) {
  const worker = current?.worker;
  if (!current || current.version !== 5 || current.revision !== expected.expectedRevision || current.requiresExplicitResume
    || current.id !== expected.identity.id || current.ownerId !== expected.identity.ownerId || current.generation !== expected.identity.generation
    || (worker?.state !== "retiring" && worker?.state !== "retired") || worker.generation !== current.generation
    || !sameConnection(worker.connection, expected.connection) || !current.processDomain || !worker.nativeQuiesce
    || worker.retirement.operationId !== expected.intent.operationId || !sameNative(worker.retirement.native, expected.intent.native)
    || !sameNative(current.native, expected.intent.native)) throw new Error("Codex finalization target is unavailable");
  return { manifest: current, worker, domain: current.processDomain, nativeFact: worker.nativeQuiesce };
}

/** Private controller only. No retirement request, retry, repair or recovery.
 * already_retired is read-only inspection, not fresh exit/RPC confirmation.
 */
export async function finalizeCodexWorkerRetirement(root: string, input: RetirementFinalizationTarget): Promise<{
  status: "finalized" | "pid_present" | "unconfirmed" | "already_retired"; revision: number;
}> {
  try {
    const expected = structuredClone(input);
    const id = (value: unknown) => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value);
    if (!expected || typeof expected !== "object" || Array.isArray(expected) || Object.keys(expected).length !== 4
      || Object.keys(expected).some(key => !["identity", "expectedRevision", "connection", "intent"].includes(key))
      || !expected.identity || Object.keys(expected.identity).length !== 3
      || Object.keys(expected.identity).some(key => !["id", "ownerId", "generation"].includes(key))
      || ![expected.identity.id, expected.identity.ownerId, expected.identity.generation].every(id)
      || !Number.isSafeInteger(expected.expectedRevision) || expected.expectedRevision < 0
      || !expected.intent || Array.isArray(expected.intent) || Object.keys(expected.intent).length !== 2
      || Object.keys(expected.intent).some(key => !["operationId", "native"].includes(key)) || !id(expected.intent.operationId)) throw new Error("Invalid Codex finalization input");
    const native = expected.intent.native;
    if (!native || typeof native !== "object" || Array.isArray(native)
      || (native.state === "pending" ? Object.keys(native).length !== 1
        : native.state !== "bound" || !id(native.threadId) || Object.keys(native).length !== 2
          || Object.keys(native).some(key => !["state", "threadId"].includes(key)))) throw new Error("Invalid Codex finalization native target");
    validateWorkerConnection(expected.connection);
    if (!Number.isInteger(expected.connection.pid) || expected.connection.pid < 1 || expected.connection.pid > 0x7fffffff) throw new Error("Invalid Codex finalization PID");
    const store = new CodexManagedStore(root), { identity } = expected;
    const captured = await store.withSessionLock(identity.id, identity.ownerId, async () => {
      const target = finalizationTarget(await store.read(identity.id, identity.ownerId), expected);
      return structuredClone(target);
    });
    if (captured.worker.state === "retired") return { status: "already_retired", revision: captured.manifest.revision };
    // The complete preflight lock has returned before fresh OS observation.
    const observed = await observeDarwinPidAbsence(captured.worker.connection.pid, captured.domain.launcher);
    return await store.withSessionLock(identity.id, identity.ownerId, async lease => {
      const current = finalizationTarget(await store.read(identity.id, identity.ownerId), expected);
      if (current.worker.state !== "retiring" || !sameDomain(current.domain, captured.domain)
        || current.nativeFact.kind !== captured.nativeFact.kind) throw new Error("Codex finalization changed during observation");
      // Revalidation applies to negative outcomes too, never stale availability.
      if (observed !== "pid_absent") return { status: observed, revision: current.manifest.revision };
      const absence = { pid: captured.worker.connection.pid, domain: captured.domain.launcher, result: "pid_absent" as const };
      await lease.finalizeRetirement(expected.expectedRevision, expected.connection, expected.intent, absence);
      const final = finalizationTarget(await store.read(identity.id, identity.ownerId), { ...expected, expectedRevision: expected.expectedRevision + 1 });
      if (final.worker.state !== "retired" || !sameDomain(final.domain, captured.domain) || final.nativeFact.kind !== captured.nativeFact.kind
        || final.worker.workerAbsence.pid !== absence.pid || final.worker.workerAbsence.result !== "pid_absent"
        || final.worker.workerAbsence.domain.ioPlatformUuid !== absence.domain.ioPlatformUuid
        || final.worker.workerAbsence.domain.bootSessionUuid !== absence.domain.bootSessionUuid) throw new Error("Codex finalization readback mismatch");
      return { status: "finalized" as const, revision: final.manifest.revision };
    });
  } catch { throw new CodexWorkerUnavailableError("Codex retirement finalization is unavailable or uncertain"); }
}

function registered(manifest: Awaited<ReturnType<CodexManagedStore["read"]>>, identity: CodexManagedIdentity): CodexWorkerConnection {
  if (!manifest || manifest.ownerId !== identity.ownerId || manifest.id !== identity.id
    || manifest.generation !== identity.generation || manifest.requiresExplicitResume
    || manifest.worker.state !== "ready" || manifest.worker.generation !== identity.generation) {
    throw new CodexWorkerUnavailableError("Codex worker is unavailable or fenced");
  }
  return { ...manifest.worker.connection };
}

/** Pure rediscovery: no spawn, registry repair, PID liveness inference or replacement. */
export async function reconnectCodexWorker(root: string, identity: CodexManagedIdentity): Promise<CodexWorkerConnection> {
  identity = { ...identity };
  const store = new CodexManagedStore(root);
  try {
    const connection = registered(await store.read(identity.id, identity.ownerId), identity);
    await new CodexWorkerClient(connection).verifyIdentity();
    const current = registered(await store.read(identity.id, identity.ownerId), identity);
    if (!sameConnection(current, connection)) throw new Error("Registration changed during authentication");
    return connection;
  } catch { throw new CodexWorkerUnavailableError("Codex worker could not be authenticated; registration preserved"); }
}

function waitExit(child: ChildProcess, milliseconds: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise(resolve => {
    const done = (exited: boolean) => { clearTimeout(timer); child.off("exit", exitedEvent); resolve(exited); };
    const exitedEvent = () => done(true);
    const timer = setTimeout(() => done(false), milliseconds);
    child.once("exit", exitedEvent);
  });
}

async function stopSpawnedChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  if (await waitExit(child, 1_000)) return;
  // A registered worker may own a native child. Do not SIGKILL the worker and
  // mistake that exit for native cleanup; production group recovery is separate.
  throw new CodexWorkerUnavailableError("Codex worker shutdown is unconfirmed; registration preserved");
}

function awaitReady(child: ChildProcess, timeoutMs: number): Promise<ReadyReport> {
  return new Promise((resolve, reject) => {
    const cleanup = () => { clearTimeout(timer); child.off("message", message); child.off("exit", failed); child.off("error", failed); child.off("disconnect", failed); };
    const failed = () => { cleanup(); reject(new CodexWorkerUnavailableError("Codex worker did not become ready")); };
    const message = (value: unknown) => {
      const response = record(value);
      if (response?.type !== "ready") { failed(); return; }
      cleanup();
      try { resolve(structuredClone({ connection: response.connection, processDomain: response.processDomain }) as ReadyReport); }
      catch { reject(new CodexWorkerUnavailableError("Codex worker readiness report is invalid")); }
    };
    const timer = setTimeout(failed, timeoutMs);
    child.once("message", message);
    child.once("exit", failed);
    child.once("error", failed);
    child.once("disconnect", failed);
  });
}

/** Internal pending-worker launch/reconnect only. A reservation is never cleared
 * or retried after uncertainty, even when no native input was dispatched.
 */
export async function launchOrReconnectCodexWorker(
  root: string,
  identity: CodexManagedIdentity,
  options: { native?: Omit<CodexAgentRuntimeOptions, "sandbox">; startupTimeoutMs?: number } = {},
): Promise<CodexWorkerConnection> {
  identity = { ...identity };
  const native = { ...options.native, ...(options.native?.args ? { args: [...options.native.args] } : {}) };
  if (Object.hasOwn(native, "sandbox")) throw new Error("Saved Codex sandbox policy is authoritative");
  const timeoutMs = options.startupTimeoutMs ?? 10_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new Error("Invalid Codex worker startup deadline");
  const store = new CodexManagedStore(root);
  const claimId = randomUUID();
  let child: ChildProcess | undefined;
  let ready: Promise<ReadyReport> | undefined;
  let launcherObservation: DarwinProcessDomainObservation | undefined;
  const reserveAndFork = async (lease: CodexManifestLease, revision: number) => {
    const reserved = await lease.reserveWorker(revision, claimId);
    child = fork(new URL("./owned-worker.js", import.meta.url), [], { stdio: ["ignore", "ignore", "ignore", "ipc"], execArgv: [] });
    ready = awaitReady(child, timeoutMs);
    void ready.catch(() => {});
    if (!child.pid) throw new Error("Codex worker has no verified launch PID");
    await lease.recordWorkerPid(reserved.revision, claimId, child.pid);
    return false;
  };
  try {
    let existing = await store.withSessionLock(identity.id, identity.ownerId, async lease => {
      const current = await store.read(identity.id, identity.ownerId);
      if (!current || current.generation !== identity.generation || current.requiresExplicitResume) {
        throw new CodexManifestConflictError("Codex worker launch is unavailable or fenced");
      }
      if (current.worker.state === "ready") return true;
      if (current.worker.state !== "none" || (current.native.state !== "pending" && !(current.native.state === "bound" && codexResumeEpoch(current)))) {
        throw new CodexWorkerUnavailableError("Codex worker launch is already reserved or uncertain");
      }
      if (current.version === 5) return current.revision;
      return reserveAndFork(lease, current.revision);
    });
    if (typeof existing === "number") {
      const revision = existing;
      const collected = await collectDarwinProcessDomainObservation();
      if (!collected) throw new Error("Codex launcher domain observation is unavailable");
      launcherObservation = observation(collected);
      existing = await store.withSessionLock(identity.id, identity.ownerId, async lease => {
        const current = await store.read(identity.id, identity.ownerId);
        if (!current || current.generation !== identity.generation || current.requiresExplicitResume) throw new CodexManifestConflictError("Codex launch is fenced");
        // A concurrent ready winner is rediscovery, never late enrollment.
        if (current.worker.state === "ready") return true;
        if (current.version !== 5 || current.revision !== revision || current.worker.state !== "none" || (current.native.state !== "pending" && !(current.native.state === "bound" && codexResumeEpoch(current)))) {
          throw new CodexManifestConflictError("Codex launch changed during domain collection");
        }
        return reserveAndFork(lease, current.revision);
      });
    }
    if (existing) return await reconnectCodexWorker(root, identity);
    // Never await worker startup under the lifecycle lock it needs to publish.
    await new Promise<void>((resolve, reject) => {
      child!.send({ type: "launch", managedRoot: root, claimId,
        identity: { ownerId: identity.ownerId, sessionId: identity.id, generation: identity.generation }, options: native },
      error => error ? reject(error) : resolve());
    });
    const report = await ready!;
    const reported = structuredClone(report.connection);
    validateWorkerConnection(reported);
    const workerObservation = launcherObservation ? observation(report.processDomain) : undefined;
    if (launcherObservation && (launcherObservation.ioPlatformUuid !== workerObservation!.ioPlatformUuid
      || launcherObservation.bootSessionUuid !== workerObservation!.bootSessionUuid)) throw new Error("Codex worker domain mismatch");
    if (reported.pid !== child!.pid || reported.claimId !== claimId || reported.ownerId !== identity.ownerId
      || reported.sessionId !== identity.id || reported.generation !== identity.generation) throw new Error("Codex worker readiness identity mismatch");
    const authenticated = await reconnectCodexWorker(root, identity);
    if (!sameConnection(reported, authenticated)) throw new Error("Codex worker readiness registration mismatch");
    if (launcherObservation && workerObservation) {
      const launcher = launcherObservation, worker = workerObservation;
      await store.withSessionLock(identity.id, identity.ownerId, async lease => {
        const current = await store.read(identity.id, identity.ownerId);
        const connection = registered(current, identity);
        if (current?.version !== 5 || !sameConnection(connection, reported)) throw new CodexManifestConflictError("Codex correlation target changed");
        await lease.recordProcessDomain(current.revision, { connection: reported, launcher, worker });
      });
    }
    if (child!.connected) child!.disconnect();
    child!.unref();
    return authenticated;
  } catch {
    if (child) {
      try {
        // IPC silence is not cleanup authority. Revoke readiness under its
        // publication lock first; a published or uncertain claim must survive.
        if (child.pid && await store.claimPreReadyCleanup(identity, { claimId, pid: child.pid })) {
          await stopSpawnedChild(child);
        }
      }
      finally { if (child.connected) child.disconnect(); child.unref(); }
    }
    throw new CodexWorkerUnavailableError("Codex worker launch/reconnect failed; registration preserved");
  }
}
