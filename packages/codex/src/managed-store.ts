import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, realpath, rename, rm, rmdir, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import type { AgentStartConfig } from "@minu/runtime-core";
import { withCodexLifecycleLock } from "./lifecycle-lock.js";
import { validateWorkerConnection, type CodexWorkerClaim, type CodexWorkerConnection } from "./worker-identity.js";
import type { CodexHistoryCheckpoint } from "./native-resume.js";
import type { DarwinProcessDomainObservation } from "./darwin-process-domain.js";

const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const MAX_BYTES = 64 * 1024;
const LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

export type CodexNativeBinding =
  | { state: "pending" }
  | { state: "creating" }
  | { state: "bound"; threadId: string };

export interface CodexRetirementIntent {
  operationId: string;
  native: Exclude<CodexNativeBinding, { state: "creating" }>;
}

export type CodexNativeQuiesce = { kind: "never_started" } | { kind: "owned_exit" };
export interface CodexWorkerAbsence {
  pid: number;
  domain: DarwinProcessDomainObservation;
  result: "pid_absent";
}

/** Launch identity for forced recovery. `pgid` (always === pid) is the ps-verified own group of the fork, `marked`
 * means the argv identity markers were passed, `bootIdentity` is the boot it started in. Absent = legacy: such a
 * worker is never signalled and can only be cleared by a boot-change proof. None of it is authority by itself. */
export interface CodexWorkerLaunchIdentity { pgid?: number; bootIdentity?: string; marked?: true }
export type CodexWorkerRegistration =
  | { state: "none" }
  | ({ state: "reserved" | "aborted"; claimId: string; generation: string; pid?: number } & CodexWorkerLaunchIdentity)
  | ({ state: "ready"; claimId: string; generation: string; connection: CodexWorkerConnection } & CodexWorkerLaunchIdentity)
  | ({ state: "retiring"; claimId: string; generation: string; connection: CodexWorkerConnection; retirement: CodexRetirementIntent; nativeQuiesce?: CodexNativeQuiesce } & CodexWorkerLaunchIdentity)
  | ({ state: "retired"; claimId: string; generation: string; connection: CodexWorkerConnection; retirement: CodexRetirementIntent; nativeQuiesce: CodexNativeQuiesce; workerAbsence: CodexWorkerAbsence } & CodexWorkerLaunchIdentity);
export type CodexWorkerAbsenceProof = "boot" | "group";

/** Private correlation only, not independent collection, attestation or exit proof. */
export interface CodexProcessDomain {
  connection: CodexWorkerConnection;
  launcher: DarwinProcessDomainObservation;
  worker: DarwinProcessDomainObservation;
}

/** Internal resume material, never a presentation-safe session summary. */
interface CodexManagedManifestFields {
  runtime: "codex";
  revision: number;
  generation: string;
  requiresExplicitResume: boolean;
  id: string;
  ownerId: string;
  native: CodexNativeBinding;
  worker: CodexWorkerRegistration;
  launchConfig: AgentStartConfig & { cwd: string };
  sandbox: "read-only" | "workspace-write";
  createdAt: string;
}

export type CodexManagedManifest = CodexManagedManifestFields & (
  | { version: 4; processDomain?: never }
  | { version: 5; processDomain?: CodexProcessDomain; history?: { operationId: string; checkpoint: CodexHistoryCheckpoint; verified: boolean }; previous?: CodexManagedManifest }
);

export interface CodexManifestPatch {
  generation?: string;
  requiresExplicitResume?: boolean;
}

/** Valid only during the owning withSessionLock callback; never retain it. */
export interface CodexManifestLease {
  update(expectedRevision: number, patch: CodexManifestPatch): Promise<CodexManagedManifest>;
  /** Persist intent before any native process/thread creation; never reset it on failure. */
  beginNativeCreation(expectedRevision: number): Promise<CodexManagedManifest>;
  /** Bind once, before submitting user input. A bound native ID is immutable. */
  bindNativeThread(expectedRevision: number, threadId: string): Promise<CodexManagedManifest>;
  reserveWorker(expectedRevision: number, claimId: string, launch?: { bootIdentity?: string }): Promise<CodexManagedManifest>;
  /** `pgid` is recorded only after ps verified that the fork leads its own group. */
  recordWorkerPid(expectedRevision: number, claimId: string, pid: number, pgid?: number): Promise<CodexManagedManifest>;
  /** Forced recovery: needs the fence already persisted, NOT a clean dispatch/history. The caller MUST have proven
   * absence independently (reboot or own-group ESRCH); the store only checks the proof fits the record. Drops the
   * worker slot and its process-domain/history receipts (which require a worker), keeps the native binding and the
   * resume predecessor, keeps the fence, and rotates the generation. */
  clearWorkerAfterProvenAbsence(expectedRevision: number, generation: string, claimId: string, proof: CodexWorkerAbsenceProof): Promise<CodexManagedManifest>;
  publishWorkerReady(expectedRevision: number, connection: CodexWorkerConnection): Promise<CodexManagedManifest>;
  abortWorkerStartup(expectedRevision: number, claimId: string, pid: number): Promise<CodexManagedManifest>;
  recordProcessDomain(expectedRevision: number, domain: CodexProcessDomain): Promise<CodexManagedManifest>;
  beginRetirementIntent(expectedRevision: number, connection: CodexWorkerConnection, intent: CodexRetirementIntent, checkpoint?: CodexHistoryCheckpoint): Promise<CodexManagedManifest>;
  removeResumeMetadata(expectedRevision: number): Promise<CodexManagedManifest>;
  /** Destroy after recovery: the slot is none (force-cleared, fenced) or retired, so absence is already proven.
   * Removes only Runtime resume metadata; native history is never touched. */
  removeStoppedSession(expectedRevision: number): Promise<CodexManagedManifest>;
  verifyHistory(expectedRevision: number, checkpoint: CodexHistoryCheckpoint): Promise<CodexManagedManifest>;
  beginResume(expectedRevision: number, generation: string): Promise<CodexManagedManifest>;
  recordNativeQuiesce(expectedRevision: number, connection: CodexWorkerConnection, intent: CodexRetirementIntent, fact: CodexNativeQuiesce): Promise<CodexManagedManifest>;
  finalizeRetirement(expectedRevision: number, connection: CodexWorkerConnection, intent: CodexRetirementIntent, absence: CodexWorkerAbsence): Promise<CodexManagedManifest>;
}

export class CodexManifestConflictError extends Error {}

export function sameCodexHistory(a: CodexHistoryCheckpoint, b: CodexHistoryCheckpoint): boolean {
  return a.kind === b.kind && (a.kind === "pending" || b.kind === "history" && a.digest === b.digest && a.turns === b.turns && a.items === b.items);
}
export function codexResumeEligible(value: CodexManagedManifest): boolean {
  return value.version === 5 && !value.requiresExplicitResume && value.worker.state === "retired"
    && value.worker.generation === value.generation && value.history?.verified === true;
}
export function codexResumeEpoch(value: CodexManagedManifest): boolean {
  return value.version === 5 && !!value.previous && codexResumeEligible(value.previous)
    && value.generation !== value.previous.generation;
}
function validateCheckpoint(value: CodexHistoryCheckpoint): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid Codex history checkpoint");
  if (value.kind === "pending") { if (Object.keys(value).length !== 1) throw new Error("Invalid pending history"); }
  else if (value.kind !== "history" || Object.keys(value).length !== 4 || Object.keys(value).some(key => !["kind", "digest", "turns", "items"].includes(key))
    || typeof value.digest !== "string" || !/^[a-f0-9]{64}$/.test(value.digest) || !Number.isSafeInteger(value.turns) || value.turns < 0 || value.turns > 2000
    || !Number.isSafeInteger(value.items) || value.items < 0 || value.items > 10000) throw new Error("Invalid Codex history checkpoint");
}

function identity(value: string): void {
  if (typeof value !== "string" || !ID.test(value)) throw new Error("Invalid Codex managed identity");
}

function validateRegistration(value: CodexManagedManifest): void {
  const worker = value.worker;
  if (!worker || typeof worker !== "object" || Array.isArray(worker)) throw new Error("Invalid Codex worker registration");
  if (worker.state === "none") {
    if (Object.keys(worker).some(key => key !== "state")) throw new Error("Invalid empty Codex registration");
    return;
  }
  identity(worker.claimId);
  identity(worker.generation);
  const identityKeys = ["pgid", "bootIdentity", "marked"];
  const pid = worker.state === "ready" || worker.state === "retiring" || worker.state === "retired" ? worker.connection?.pid : worker.pid;
  if ((worker.pgid !== undefined && (worker.pgid !== pid || !Number.isSafeInteger(worker.pgid) || worker.pgid < 2))
    || (worker.bootIdentity !== undefined && (typeof worker.bootIdentity !== "string" || !/^[a-z]+:[0-9a-f-]{32,36}$/.test(worker.bootIdentity)))
    || (worker.marked !== undefined && worker.marked !== true)) throw new Error("Invalid Codex worker launch identity");
  if (worker.state === "reserved" || worker.state === "aborted") {
    if (Object.keys(worker).some(key => !["state", "claimId", "generation", "pid", ...identityKeys].includes(key))
      || (worker.pid !== undefined && (!Number.isSafeInteger(worker.pid) || worker.pid < 1))) throw new Error("Invalid Codex worker reservation");
  } else if (worker.state === "ready" || worker.state === "retiring" || worker.state === "retired") {
    validateWorkerConnection(worker.connection);
    if (Object.keys(worker).some(key => !["state", "claimId", "generation", "connection", ...identityKeys, ...(worker.state === "retiring" ? ["retirement", "nativeQuiesce"] : worker.state === "retired" ? ["retirement", "nativeQuiesce", "workerAbsence"] : [])].includes(key))
      || worker.connection.claimId !== worker.claimId || worker.connection.generation !== worker.generation
      || worker.connection.ownerId !== value.ownerId || worker.connection.sessionId !== value.id) {
      throw new Error("Codex worker registration identity mismatch");
    }
    if (worker.state === "retiring" || worker.state === "retired") {
      if (value.version !== 5 || !value.processDomain) throw new Error("Codex retirement requires v5 process-domain correlation");
      validateRetirementIntent(worker.retirement);
      if (!sameNative(worker.retirement.native, value.native)) throw new Error("Codex retirement native snapshot mismatch");
      if (worker.state === "retired" || Object.hasOwn(worker, "nativeQuiesce")) validateNativeQuiesce(worker.nativeQuiesce!, worker.retirement);
      if (worker.state === "retired") validateWorkerAbsence(worker.workerAbsence, worker.connection, value.processDomain);
    }
  } else throw new Error("Invalid Codex worker registration state");
}

/** No claim is allowed only for legacy/internal unregistered workers. */
export function assertCodexWorkerClaim(manifest: CodexManagedManifest, claim?: CodexWorkerClaim, state: "reserved" | "ready" = "ready"): void {
  const worker = manifest.worker;
  if (!claim) {
    if (worker.state !== "none") throw new CodexManifestConflictError("Codex worker is reserved or registered");
    return;
  }
  if ((worker.state !== "reserved" && worker.state !== "ready") || worker.state !== state || worker.claimId !== claim.claimId
    || worker.generation !== manifest.generation || (worker.state === "ready" ? worker.connection.pid : worker.pid) !== claim.pid) {
    throw new CodexManifestConflictError("Codex worker claim is unavailable or fenced");
  }
}

function sameConnection(a: CodexWorkerConnection, b: CodexWorkerConnection): boolean {
  return (["version", "ownerId", "sessionId", "generation", "claimId", "pid", "endpoint", "token"] as const)
    .every(key => a[key] === b[key]);
}

function sameNative(a: CodexNativeBinding, b: CodexNativeBinding): boolean {
  return !!a && !!b && (a.state === "pending" && b.state === "pending"
    || a.state === "bound" && b.state === "bound" && a.threadId === b.threadId);
}

function validateRetirementIntent(intent: CodexRetirementIntent): void {
  if (!intent || typeof intent !== "object" || Array.isArray(intent) || Object.keys(intent).length !== 2
    || Object.keys(intent).some(key => !["operationId", "native"].includes(key))) throw new Error("Invalid Codex retirement intent");
  identity(intent.operationId);
  const native = intent.native;
  if (!native || typeof native !== "object" || Array.isArray(native)) throw new Error("Invalid Codex retirement native snapshot");
  if (native.state === "pending") {
    if (Object.keys(native).length !== 1) throw new Error("Invalid Codex pending retirement snapshot");
  } else if (native.state === "bound") {
    identity(native.threadId);
    if (Object.keys(native).length !== 2 || Object.keys(native).some(key => !["state", "threadId"].includes(key))) throw new Error("Invalid Codex bound retirement snapshot");
  } else throw new Error("Invalid Codex retirement native state");
}

function validateNativeQuiesce(fact: CodexNativeQuiesce, intent: CodexRetirementIntent): void {
  if (!fact || typeof fact !== "object" || Array.isArray(fact) || Object.keys(fact).length !== 1
    || Object.keys(fact)[0] !== "kind" || fact.kind !== (intent.native.state === "pending" ? "never_started" : "owned_exit")) {
    throw new Error("Invalid Codex native-quiesce assertion");
  }
}

function validateWorkerAbsence(absence: CodexWorkerAbsence, connection: CodexWorkerConnection, domain?: CodexProcessDomain): void {
  if (!absence || typeof absence !== "object" || Array.isArray(absence) || Object.keys(absence).length !== 3
    || Object.keys(absence).some(key => !["pid", "domain", "result"].includes(key))
    || !Number.isInteger(absence.pid) || absence.pid < 1 || absence.pid > 0x7fffffff
    || absence.pid !== connection.pid || absence.result !== "pid_absent") throw new Error("Invalid Codex worker-absence assertion");
  validateObservation(absence.domain);
  if (domain && (!sameObservation(absence.domain, domain.launcher) || !sameObservation(absence.domain, domain.worker))) {
    throw new Error("Codex worker-absence domain mismatch");
  }
}

function retirementWorker(current: CodexManagedManifest, connection: CodexWorkerConnection, intent: CodexRetirementIntent) {
  const worker = current.worker;
  if (current.version !== 5 || current.requiresExplicitResume || !current.processDomain
    || (worker.state !== "retiring" && worker.state !== "retired") || worker.generation !== current.generation
    || !sameConnection(connection, worker.connection) || !sameNative(intent.native, current.native)
    || worker.retirement.operationId !== intent.operationId || !sameNative(worker.retirement.native, intent.native)) {
    throw new CodexManifestConflictError("Codex retirement assertion is unavailable or fenced");
  }
  return worker;
}

function validateObservation(value: DarwinProcessDomainObservation): void {
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length !== 2
    || Object.keys(value).some(key => !["ioPlatformUuid", "bootSessionUuid"].includes(key))
    || ![value.ioPlatformUuid, value.bootSessionUuid].every(id => typeof id === "string" && uuid.test(id)
      && !/^(?:0|-)+$/.test(id) && !/^(?:f|-)+$/.test(id))) throw new Error("Invalid Codex process-domain observation");
}

function sameObservation(a: DarwinProcessDomainObservation, b: DarwinProcessDomainObservation): boolean {
  return a.ioPlatformUuid === b.ioPlatformUuid && a.bootSessionUuid === b.bootSessionUuid;
}

function validateProcessDomain(domain: CodexProcessDomain, manifest: CodexManagedManifest): void {
  if (!domain || typeof domain !== "object" || Array.isArray(domain) || Object.keys(domain).length !== 3
    || Object.keys(domain).some(key => !["connection", "launcher", "worker"].includes(key))) throw new Error("Invalid Codex process-domain correlation");
  validateWorkerConnection(domain.connection);
  validateObservation(domain.launcher);
  validateObservation(domain.worker);
  // Structural history follows the recorded registration, not current root
  // authority: generation/explicit-resume fence updates must remain possible.
  if ((manifest.worker.state !== "ready" && manifest.worker.state !== "retiring" && manifest.worker.state !== "retired") || !sameConnection(domain.connection, manifest.worker.connection)
    || !sameObservation(domain.launcher, domain.worker)) throw new Error("Codex process-domain correlation mismatch");
}

function validate(value: CodexManagedManifest): void {
  if (!value || typeof value !== "object") throw new Error("Invalid Codex manifest");
  identity(value.id);
  identity(value.ownerId);
  validateRegistration(value);
  const config = value.launchConfig;
  const native = value.native;
  const nativeValid = native && typeof native === "object" && !Array.isArray(native)
    && (native.state === "bound"
      ? typeof native.threadId === "string" && ID.test(native.threadId)
        && Object.keys(native).every(key => ["state", "threadId"].includes(key))
      : ["pending", "creating"].includes(native.state)
        && Object.keys(native).every(key => key === "state"));
  if ((value.version !== 4 && value.version !== 5) || value.runtime !== "codex"
    || !Number.isSafeInteger(value.revision) || value.revision < 0 || value.revision >= Number.MAX_SAFE_INTEGER
    || typeof value.generation !== "string" || !ID.test(value.generation)
    || typeof value.requiresExplicitResume !== "boolean"
    || !nativeValid
    || (value.worker.state === "aborted" && native.state !== "pending" && !codexResumeEpoch(value))
    || Object.keys(value).some(key => !["version", "runtime", "revision", "generation", "requiresExplicitResume",
      "id", "ownerId", "native", "worker", "launchConfig", "sandbox", "createdAt", ...(value.version === 5 ? ["processDomain", "history", "previous"] : [])].includes(key))
    || !["read-only", "workspace-write"].includes(value.sandbox)
    || typeof value.createdAt !== "string" || !Number.isFinite(Date.parse(value.createdAt))
    || !config || typeof config !== "object" || Array.isArray(config)
    || typeof config.cwd !== "string" || !isAbsolute(config.cwd) || resolve(config.cwd) !== config.cwd
    || (config.systemPrompt !== undefined && typeof config.systemPrompt !== "string")
    || (config.appendSystemPrompt !== undefined && typeof config.appendSystemPrompt !== "string")
    || (config.systemPrompt !== undefined && config.appendSystemPrompt !== undefined)
    || (config.skillIds !== undefined && (!Array.isArray(config.skillIds) || config.skillIds.length > 256 || new Set(config.skillIds).size !== config.skillIds.length
      || config.skillIds.some(id => typeof id !== "string" || !/^codex-skill-[a-f0-9]{64}$/.test(id))))
    || (config.reasoningLevel !== undefined && !LEVELS.includes(config.reasoningLevel))
    || (config.model !== undefined && (!config.model || typeof config.model.provider !== "string"
      || !config.model.provider.trim() || typeof config.model.id !== "string" || !config.model.id.trim()))
    || Object.keys(config).some(key => !["cwd", "systemPrompt", "appendSystemPrompt", "model", "reasoningLevel", "skillIds"].includes(key))) {
    throw new Error("Invalid Codex managed launch policy");
  }
  if (value.version === 5 && Object.hasOwn(value, "processDomain")) validateProcessDomain(value.processDomain!, value);
  if (value.version === 5 && Object.hasOwn(value, "history")) {
    const h = value.history;
    if (!h || typeof h !== "object" || Array.isArray(h) || Object.keys(h).length !== 3
      || Object.keys(h).some(key => !["operationId", "checkpoint", "verified"].includes(key)) || typeof h.verified !== "boolean"
      || (value.worker.state !== "retiring" && value.worker.state !== "retired") || h.operationId !== value.worker.retirement.operationId
      || (h.verified && value.worker.state !== "retired")) throw new Error("Invalid Codex history receipt");
    validateCheckpoint(h.checkpoint);
    if ((value.native.state === "pending") !== (h.checkpoint.kind === "pending")) throw new Error("Codex history binding mismatch");
  }
  if (value.version === 5 && Object.hasOwn(value, "previous")) {
    const previous = value.previous;
    if (!previous || previous.version !== 5 || Object.hasOwn(previous, "previous")) throw new Error("Invalid Codex predecessor");
    validate(previous);
    if (!codexResumeEpoch(value) || previous.id !== value.id || previous.ownerId !== value.ownerId
      || previous.sandbox !== value.sandbox || JSON.stringify(previous.launchConfig) !== JSON.stringify(value.launchConfig)
      || (previous.native.state === "bound" && !sameNative(previous.native, value.native))) throw new Error("Invalid Codex resume epoch");
  }
}

async function privateDirectory(path: string, create = false): Promise<void> {
  if (create) await mkdir(path, { recursive: true, mode: 0o700 });
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()
    || (process.getuid && stat.uid !== process.getuid()) || (stat.mode & 0o077)
    || await realpath(path) !== path) throw new Error("Codex managed directory must be private and not redirected");
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, "r");
  try { await handle.sync(); } finally { await handle.close(); }
}

export function codexManagedRoot(): string {
  return join(homedir(), ".minu", "runtime-codex", "managed");
}

/** Storage and lifecycle-lock primitives only; no public managed API or native history access. */
export class CodexManagedStore {
  private readonly root: string;
  constructor(root = codexManagedRoot()) {
    if (!isAbsolute(root) || resolve(root) !== root) throw new Error("Codex storage root must be absolute and normalized");
    this.root = root;
  }

  private directory(ownerId: string): string {
    identity(ownerId);
    return join(this.root, createHash("sha256").update(ownerId).digest("hex"));
  }

  private async verify(ownerId: string, create = false): Promise<string> {
    const directory = this.directory(ownerId);
    await privateDirectory(this.root, create);
    await privateDirectory(directory, create);
    return directory;
  }

  /** Internal cleanup for a caller already holding this exact spawned-child or
   * self-worker identity. A PID from storage alone is never shutdown authority.
   * Claim an irrevocable pre-ready abort under the same lock as publication.
   * Ready or unreadable/uncertain state must preserve a potentially adopted worker.
   */
  async claimPreReadyCleanup(
    expected: { id: string; ownerId: string; generation: string }, claim: CodexWorkerClaim,
  ): Promise<boolean> {
    expected = { ...expected };
    claim = { ...claim };
    try {
      // Denial needs no mutation lock. A published worker may disconnect and
      // then be stopped while this cleanup check is running; do not freeze its
      // lifecycle lock and prevent recovery from fencing it. Any actual cleanup
      // authorization is still decided from a fresh read under the lock below.
      const observed = await this.read(expected.id, expected.ownerId);
      if (!observed || (observed.worker.state !== "reserved" && observed.worker.state !== "aborted")) return false;
      return await this.withSessionLock(expected.id, expected.ownerId, async lease => {
        const current = await this.read(expected.id, expected.ownerId);
        const worker = current?.worker;
        if (!current || !worker || (worker.state !== "reserved" && worker.state !== "aborted")
          || worker.claimId !== claim.claimId || worker.generation !== expected.generation
          || (worker.pid !== undefined && worker.pid !== claim.pid)) return false;
        if (worker.state === "aborted") return true;
        if (current.generation !== expected.generation || current.requiresExplicitResume) return false;
        await lease.abortWorkerStartup(current.revision, claim.claimId, claim.pid);
        return true;
      });
    } catch { return false; }
  }

  /** Same-session lifecycle operations must use this lock, including external
   * worker actions. Do not recursively lock the same session; use the lease.
   */
  async withSessionLock<T>(
    id: string, ownerId: string, operation: (lease: CodexManifestLease) => Promise<T>, timeoutMs = 5_000,
  ): Promise<T> {
    identity(id);
    const directory = await this.verify(ownerId, true);
    return withCodexLifecycleLock(join(directory, `.lifecycle-${id}.sqlite`), async () => {
      let active = true;
      let pending: Promise<CodexManagedManifest> | undefined;
      const mutate = async (operation: () => Promise<CodexManagedManifest>) => {
        if (!active || pending) throw new Error("Codex lifecycle lease is inactive or already mutating");
        pending = operation();
        try { return await pending; } finally { pending = undefined; }
      };
      const lease: CodexManifestLease = {
        update: (expectedRevision, patch) => mutate(() => this.updateLocked(id, ownerId, expectedRevision, patch)),
        beginNativeCreation: expectedRevision => mutate(() => this.bindLocked(id, ownerId, expectedRevision)),
        bindNativeThread: (expectedRevision, threadId) => mutate(() => this.bindLocked(id, ownerId, expectedRevision, threadId)),
        reserveWorker: (revision, claimId, launch) => mutate(() => this.registerLocked(id, ownerId, revision, claimId, undefined, undefined, undefined, launch)),
        clearWorkerAfterProvenAbsence: (revision, generation, claimId, proof) => mutate(() => this.forceClearLocked(id, ownerId, revision, generation, claimId, proof)),
        abortWorkerStartup: (revision, claimId, pid) => mutate(() => this.abortStartupLocked(id, ownerId, revision, claimId, pid)),
        recordWorkerPid: (revision, claimId, pid, pgid) => mutate(() => this.registerLocked(id, ownerId, revision, claimId, pid, undefined, pgid)),
        recordNativeQuiesce: (revision, connection, intent, fact) => {
          const snapshot = JSON.parse(JSON.stringify({ connection, intent, fact })) as { connection: CodexWorkerConnection; intent: CodexRetirementIntent; fact: CodexNativeQuiesce };
          validateWorkerConnection(snapshot.connection); validateRetirementIntent(snapshot.intent); validateNativeQuiesce(snapshot.fact, snapshot.intent);
          return mutate(() => this.recordNativeQuiesceLocked(id, ownerId, revision, snapshot.connection, snapshot.intent, snapshot.fact));
        },
        finalizeRetirement: (revision, connection, intent, absence) => {
          const snapshot = JSON.parse(JSON.stringify({ connection, intent, absence })) as { connection: CodexWorkerConnection; intent: CodexRetirementIntent; absence: CodexWorkerAbsence };
          validateWorkerConnection(snapshot.connection); validateRetirementIntent(snapshot.intent); validateWorkerAbsence(snapshot.absence, snapshot.connection);
          return mutate(() => this.finalizeRetirementLocked(id, ownerId, revision, snapshot.connection, snapshot.intent, snapshot.absence));
        },
        removeResumeMetadata: revision => mutate(() => this.removeResumeMetadataLocked(id, ownerId, revision)),
        removeStoppedSession: revision => mutate(() => this.removeResumeMetadataLocked(id, ownerId, revision, true)),
        verifyHistory: (revision, checkpoint) => {
          const captured = structuredClone(checkpoint);
          return mutate(() => this.verifyHistoryLocked(id, ownerId, revision, captured));
        },
        beginResume: (revision, generation) => mutate(() => this.beginResumeLocked(id, ownerId, revision, generation)),
        beginRetirementIntent: (revision, connection, intent, checkpoint) => {
          const snapshot = JSON.parse(JSON.stringify({ connection, intent, checkpoint })) as { connection: CodexWorkerConnection; intent: CodexRetirementIntent; checkpoint?: CodexHistoryCheckpoint };
          validateWorkerConnection(snapshot.connection);
          validateRetirementIntent(snapshot.intent);
          return mutate(() => this.beginRetirementIntentLocked(id, ownerId, revision, snapshot.connection, snapshot.intent, snapshot.checkpoint));
        },
        recordProcessDomain: (revision, domain) => {
          const snapshot = JSON.parse(JSON.stringify(domain)) as CodexProcessDomain;
          return mutate(() => this.recordProcessDomainLocked(id, ownerId, revision, snapshot));
        },
        publishWorkerReady: (revision, connection) => {
          const snapshot = { ...connection };
          return mutate(() => this.registerLocked(id, ownerId, revision, snapshot.claimId ?? "", undefined, snapshot));
        },
      };
      try { return await operation(lease); }
      finally {
        active = false;
        // An unawaited mutation must settle before another process acquires the lock.
        await pending?.catch(() => {});
      }
    }, timeoutMs);
  }

  async update(id: string, ownerId: string, expectedRevision: number, patch: CodexManifestPatch): Promise<CodexManagedManifest> {
    const snapshot = JSON.parse(JSON.stringify(patch)) as CodexManifestPatch;
    return this.withSessionLock(id, ownerId, lease => lease.update(expectedRevision, snapshot));
  }

  private async updateLocked(id: string, ownerId: string, expectedRevision: number, patch: CodexManifestPatch): Promise<CodexManagedManifest> {
    const snapshot = JSON.parse(JSON.stringify(patch)) as CodexManifestPatch;
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0
      || !snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)
      || !Object.keys(snapshot).length
      || Object.keys(snapshot).some(key => !["generation", "requiresExplicitResume"].includes(key))) {
      throw new Error("Invalid Codex manifest update");
    }
    const current = await this.current(id, ownerId, expectedRevision);
    return this.publishUpdate({ ...current, ...snapshot, revision: current.revision + 1 });
  }

  private async current(id: string, ownerId: string, expectedRevision: number): Promise<CodexManagedManifest> {
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) throw new Error("Invalid Codex manifest revision");
    const current = await this.read(id, ownerId);
    if (!current || current.revision !== expectedRevision) throw new CodexManifestConflictError("Codex manifest is missing or stale");
    return current;
  }

  private async recordProcessDomainLocked(
    id: string, ownerId: string, revision: number, domain: CodexProcessDomain,
  ): Promise<CodexManagedManifest> {
    // Revision and fresh fences apply even to identical cached-data replay.
    const current = await this.current(id, ownerId, revision);
    if (current.version !== 5 || current.requiresExplicitResume || current.worker.state !== "ready"
      || current.worker.generation !== current.generation) throw new CodexManifestConflictError("Codex process-domain recording is unavailable or fenced");
    validateProcessDomain(domain, current);
    if (current.processDomain) {
      if (!sameConnection(domain.connection, current.processDomain.connection)
        || !sameObservation(domain.launcher, current.processDomain.launcher)
        || !sameObservation(domain.worker, current.processDomain.worker)) throw new CodexManifestConflictError("Codex process-domain correlation is immutable");
      return current;
    }
    return this.publishUpdate({ ...current, processDomain: domain, revision: current.revision + 1 });
  }

  private async beginRetirementIntentLocked(
    id: string, ownerId: string, revision: number, connection: CodexWorkerConnection, intent: CodexRetirementIntent, checkpoint?: CodexHistoryCheckpoint,
  ): Promise<CodexManagedManifest> {
    const current = await this.current(id, ownerId, revision);
    const worker = current.worker;
    if (current.version !== 5 || current.requiresExplicitResume || !current.processDomain
      || (worker.state !== "ready" && worker.state !== "retiring") || worker.generation !== current.generation
      || !sameConnection(connection, worker.connection) || !sameNative(intent.native, current.native)) {
      throw new CodexManifestConflictError("Codex retirement intent is unavailable or fenced");
    }
    if (worker.state === "retiring") {
      if (worker.retirement.operationId !== intent.operationId || !sameNative(worker.retirement.native, intent.native)) {
        throw new CodexManifestConflictError("Codex retirement intent is immutable");
      }
      return current;
    }
    if (checkpoint) validateCheckpoint(checkpoint);
    return this.publishUpdate({ ...current, worker: { ...worker, state: "retiring", retirement: intent },
      ...(checkpoint ? { history: { operationId: intent.operationId, checkpoint, verified: false } } : {}), revision: current.revision + 1 });
  }

  private async removeResumeMetadataLocked(id: string, ownerId: string, revision: number, afterRecovery = false): Promise<CodexManagedManifest> {
    const current = await this.current(id, ownerId, revision);
    const neverStarted = current.native.state === "pending" && current.worker.state === "none" && !current.requiresExplicitResume;
    // A fenced none slot was force-cleared after proven absence; a retired one exited. Native history stays either way.
    const stopped = afterRecovery && ((current.worker.state === "none" && current.requiresExplicitResume) || current.worker.state === "retired");
    if (!neverStarted && !stopped && !codexResumeEligible(current)) throw new CodexManifestConflictError("Codex destruction requires confirmed eligible shutdown");
    const owner = await this.verify(ownerId), directory = join(owner, `${id}.session`);
    await privateDirectory(directory);
    const entries = await readdir(directory);
    // Never move/delete a directory containing unknown/native data. No recursive
    // removal: only our validated manifest may be unlinked, even after a race.
    if (entries.length !== 1 || entries[0] !== "manifest.json") throw new Error("Codex resume directory contains non-metadata files");
    const removed = join(owner, `.destroy-${randomUUID()}`);
    await rename(directory, removed);
    await syncDirectory(owner);
    await unlink(join(removed, "manifest.json"));
    await rmdir(removed);
    await syncDirectory(owner);
    // Keep the owner/session lifecycle lock file: queued callers must continue
    // sharing the same lock domain and observe the missing canonical record.
    return current;
  }

  private async verifyHistoryLocked(id: string, ownerId: string, revision: number, checkpoint: CodexHistoryCheckpoint): Promise<CodexManagedManifest> {
    const current = await this.current(id, ownerId, revision);
    validateCheckpoint(checkpoint);
    if (current.version !== 5 || current.requiresExplicitResume || current.worker.state !== "retired" || current.worker.generation !== current.generation
      || !current.history || !sameCodexHistory(current.history.checkpoint, checkpoint)) throw new CodexManifestConflictError("Codex history verification is unavailable");
    if (current.history.verified) return current;
    return this.publishUpdate({ ...current, history: { ...current.history, verified: true }, revision: revision + 1 });
  }

  private async beginResumeLocked(id: string, ownerId: string, revision: number, generation: string): Promise<CodexManagedManifest> {
    const current = await this.current(id, ownerId, revision); identity(generation);
    if (!codexResumeEligible(current) || generation === current.generation) throw new CodexManifestConflictError("Codex clean resume is unavailable");
    if (current.version !== 5) throw new CodexManifestConflictError("Codex legacy resume is unavailable");
    // Keep one complete immutable predecessor, not an unbounded recursive log.
    const { previous: _older, ...previous } = current;
    const { processDomain: _domain, history: _history, previous: _old, ...fields } = current;
    return this.publishUpdate({ ...fields, generation, worker: { state: "none" }, previous, revision: revision + 1 });
  }

  private async recordNativeQuiesceLocked(
    id: string, ownerId: string, revision: number, connection: CodexWorkerConnection, intent: CodexRetirementIntent, fact: CodexNativeQuiesce,
  ): Promise<CodexManagedManifest> {
    const current = await this.current(id, ownerId, revision);
    const worker = retirementWorker(current, connection, intent);
    if (worker.state !== "retiring") throw new CodexManifestConflictError("Codex retired native assertion cannot regress");
    if (worker.nativeQuiesce) {
      if (worker.nativeQuiesce.kind !== fact.kind) throw new CodexManifestConflictError("Codex native-quiesce assertion is immutable");
      return current;
    }
    return this.publishUpdate({ ...current, worker: { ...worker, nativeQuiesce: fact }, revision: current.revision + 1 });
  }

  private async finalizeRetirementLocked(
    id: string, ownerId: string, revision: number, connection: CodexWorkerConnection, intent: CodexRetirementIntent, absence: CodexWorkerAbsence,
  ): Promise<CodexManagedManifest> {
    const current = await this.current(id, ownerId, revision);
    const worker = retirementWorker(current, connection, intent);
    if (!worker.nativeQuiesce) throw new CodexManifestConflictError("Codex retirement requires a native-quiesce assertion");
    validateWorkerAbsence(absence, worker.connection, current.processDomain);
    if (worker.state === "retired") {
      if (worker.workerAbsence.pid !== absence.pid || worker.workerAbsence.result !== absence.result
        || !sameObservation(worker.workerAbsence.domain, absence.domain)) throw new CodexManifestConflictError("Codex worker-absence assertion is immutable");
      return current;
    }
    return this.publishUpdate({ ...current, worker: { ...worker, state: "retired", nativeQuiesce: worker.nativeQuiesce, workerAbsence: absence }, revision: current.revision + 1 });
  }

  private async bindLocked(id: string, ownerId: string, expectedRevision: number, threadId?: string): Promise<CodexManagedManifest> {
    const current = await this.current(id, ownerId, expectedRevision);
    if (current.requiresExplicitResume || current.worker.state === "retiring" || current.worker.state === "retired") throw new CodexManifestConflictError("Codex session requires explicit recovery or is retiring");
    const expectedState = threadId === undefined ? "pending" : "creating";
    if (current.native.state !== expectedState) throw new CodexManifestConflictError("Codex native creation is already bound or uncertain");
    const native: CodexNativeBinding = threadId === undefined ? { state: "creating" } : { state: "bound", threadId };
    return this.publishUpdate({ ...current, native, revision: current.revision + 1 });
  }

  private async abortStartupLocked(id: string, ownerId: string, revision: number, claimId: string, pid: number): Promise<CodexManagedManifest> {
    identity(claimId);
    if (!Number.isSafeInteger(pid) || pid < 1) throw new Error("Invalid Codex cleanup PID");
    const current = await this.current(id, ownerId, revision);
    const worker = current.worker;
    if (worker.state !== "reserved" || worker.claimId !== claimId
      || worker.generation !== current.generation || current.requiresExplicitResume
      || (worker.pid !== undefined && worker.pid !== pid) || (current.native.state !== "pending" && !(current.native.state === "bound" && codexResumeEpoch(current)))) {
      throw new CodexManifestConflictError("Codex startup is not eligible for pre-ready cleanup");
    }
    return this.publishUpdate({ ...current, worker: { ...worker, state: "aborted", pid }, revision: current.revision + 1 });
  }

  private async forceClearLocked(
    id: string, ownerId: string, revision: number, generation: string, claimId: string, proof: CodexWorkerAbsenceProof,
  ): Promise<CodexManagedManifest> {
    identity(generation); identity(claimId);
    const current = await this.current(id, ownerId, revision), worker = current.worker;
    if (!current.requiresExplicitResume || current.generation !== generation || worker.state === "none" || worker.state === "retired"
      || worker.claimId !== claimId || worker.generation !== generation || !["boot", "group"].includes(proof)
      || (proof === "group" && !worker.pgid)
      || (proof === "boot" && !worker.bootIdentity && !(current.version === 5 && current.processDomain))) {
      throw new CodexManifestConflictError("Codex forced clear requires the fence and a coherent absence proof");
    }
    const { processDomain: _domain, history: _history, ...rest } = current as Extract<CodexManagedManifest, { version: 5 }>;
    return this.publishUpdate({ ...(current.version === 5 ? rest : current), generation: randomUUID(), worker: { state: "none" }, revision: current.revision + 1 } as CodexManagedManifest);
  }

  private async registerLocked(
    id: string, ownerId: string, revision: number, claimId: string, pid?: number, connection?: CodexWorkerConnection, pgid?: number,
    launch?: { bootIdentity?: string },
  ): Promise<CodexManagedManifest> {
    identity(claimId);
    const current = await this.current(id, ownerId, revision);
    if (current.requiresExplicitResume || (current.native.state !== "pending" && !(current.native.state === "bound" && codexResumeEpoch(current)))) throw new CodexManifestConflictError("Codex worker launch is unavailable or fenced");
    let worker: CodexWorkerRegistration;
    if (connection) {
      assertCodexWorkerClaim(current, { claimId, pid: connection.pid }, "reserved");
      if (connection.generation !== current.generation) throw new CodexManifestConflictError("Codex worker generation is stale");
      const { pgid: group, bootIdentity, marked } = current.worker as CodexWorkerLaunchIdentity;
      worker = { state: "ready", claimId, generation: current.generation, connection,
        ...(group ? { pgid: group } : {}), ...(bootIdentity ? { bootIdentity } : {}), ...(marked ? { marked } : {}) };
    } else if (pid !== undefined) {
      if (current.worker.state !== "reserved" || current.worker.claimId !== claimId || current.worker.pid !== undefined
        || current.worker.generation !== current.generation || !Number.isSafeInteger(pid) || pid < 1) {
        throw new CodexManifestConflictError("Codex worker PID is already bound or stale");
      }
      worker = { ...current.worker, pid, ...(pgid ? { pgid } : {}) };
    } else {
      if (current.worker.state !== "none") throw new CodexManifestConflictError("Codex worker is already reserved or registered");
      worker = { state: "reserved", claimId, generation: current.generation,
        ...(launch ? { marked: true as const, ...(launch.bootIdentity ? { bootIdentity: launch.bootIdentity } : {}) } : {}) };
    }
    return this.publishUpdate({ ...current, worker, revision: current.revision + 1 });
  }

  private async publishUpdate(next: CodexManagedManifest): Promise<CodexManagedManifest> {
    validate(next);
    const data = `${JSON.stringify(next)}\n`;
    if (Buffer.byteLength(data) > MAX_BYTES) throw new Error("Codex manifest is too large");
    const directory = join(this.directory(next.ownerId), `${next.id}.session`);
    const temporary = join(directory, `.${randomUUID()}.tmp`);
    const handle = await open(temporary, "wx", 0o600);
    try {
      try { await handle.writeFile(data); await handle.sync(); } finally { await handle.close(); }
      await rename(temporary, join(directory, "manifest.json"));
      await syncDirectory(directory);
    } finally { await rm(temporary, { force: true }); }
    return next;
  }

  async create(manifest: CodexManagedManifest): Promise<void> {
    // Snapshot before awaiting: a caller cannot mutate the validated payload mid-write.
    const snapshot = JSON.parse(JSON.stringify(manifest)) as CodexManagedManifest;
    validate(snapshot);
    const data = `${JSON.stringify(snapshot)}\n`;
    if (Buffer.byteLength(data) > MAX_BYTES) throw new Error("Codex manifest is too large");
    const directory = await this.verify(snapshot.ownerId, true);
    const temporary = join(directory, `.${randomUUID()}.tmp`);
    await mkdir(temporary, { mode: 0o700 });
    try {
      const handle = await open(join(temporary, "manifest.json"), "wx", 0o600);
      try { await handle.writeFile(data); await handle.sync(); } finally { await handle.close(); }
      await syncDirectory(temporary);
      // Publish a complete directory in one rename. An existing valid session is
      // nonempty, so POSIX rename refuses to replace it. The manifest always has
      // one link; a writer crash needs no cleanup to make published data readable.
      await rename(temporary, join(directory, `${snapshot.id}.session`));
      await syncDirectory(directory);
    } finally {
      // Before publication a crash may leave an ignored staging directory.
      // After publication this path no longer exists; never remove the final path.
      await rm(temporary, { recursive: true, force: true });
    }
  }

  async read(id: string, ownerId: string): Promise<CodexManagedManifest | undefined> {
    identity(id);
    identity(ownerId);
    let handle;
    try {
      const directory = await this.verify(ownerId);
      const sessionDirectory = join(directory, `${id}.session`);
      await privateDirectory(sessionDirectory);
      handle = await open(join(sessionDirectory, "manifest.json"), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      const stat = await handle.stat();
      // A pinned old snapshot may have been unlinked by an atomic update. Zero
      // links is safe for that descriptor; multiple links still imply aliases.
      if (!stat.isFile() || stat.nlink > 1 || stat.size > MAX_BYTES
        || (process.getuid && stat.uid !== process.getuid()) || (stat.mode & 0o077)) {
        throw new Error("Codex manifest must be a bounded private regular file");
      }
      const buffer = Buffer.alloc(MAX_BYTES + 1);
      let length = 0;
      while (length < buffer.length) {
        const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
        if (!bytesRead) break;
        length += bytesRead;
      }
      if (length > MAX_BYTES) throw new Error("Codex manifest is too large");
      const manifest = JSON.parse(buffer.toString("utf8", 0, length)) as CodexManagedManifest;
      validate(manifest);
      if (manifest.id !== id || manifest.ownerId !== ownerId) throw new Error("Codex manifest ownership mismatch");
      return manifest;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    } finally { await handle?.close(); }
  }

  async list(ownerId: string): Promise<CodexManagedManifest[]> {
    let names: string[];
    try { names = await readdir(await this.verify(ownerId)); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const result: CodexManagedManifest[] = [];
    for (const name of names.sort()) {
      if (!name.endsWith(".session") || !ID.test(name.slice(0, -8))) continue;
      const manifest = await this.read(name.slice(0, -8), ownerId);
      if (!manifest) throw new Error("Codex inventory contains incomplete or concurrently removed session material");
      result.push(manifest);
    }
    return result;
  }
}
