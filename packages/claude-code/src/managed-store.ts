import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, realpath, rename, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import type { AgentStartConfig } from "@minu/runtime-core";
import { withClaudeCodeLifecycleLock } from "./lifecycle-lock.js";
import { CLAUDE_CODE_PERMISSION_MODES, CLAUDE_CODE_READ_ONLY_TOOLS, type ClaudeCodePermissionLabel, type ClaudeCodePermissionMode } from "./permissions.js";
import {
  CLAUDE_CODE_WORKER_REGISTRATION_MAX_BYTES, decodeClaudeCodeWorkerRegistration, encodeClaudeCodeWorkerRegistration,
  type ClaudeCodeWorkerRegistration, type ClaudeCodeWorkerRegistrationScope,
} from "./worker-registration.js";

const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const MAX_BYTES = 64 * 1024;
const LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

export type ClaudeCodeNativeBinding =
  | { state: "pending" }
  | { state: "creating"; sessionId: string }
  | { state: "bound"; sessionId: string };

/** Serializable launch intent, not an authorization grant or verified native state. */
export interface ClaudeCodeManagedPolicy {
  /** "native" inherits the user's settings, hooks, MCP, plugins and skills (as running `claude` in that cwd would). */
  configuration: "native" | "isolated";
  permissionMode: ClaudeCodePermissionMode;
  /** Immutable authorized native root; never inferred from Runtime's storage root. */
  nativeConfigRoot: string;
  /** null means native tool defaults; [] means no tools. Neither grants permission. */
  tools: string[] | null;
  /** v5+. Absent on v3/v4 manifests, which are read as "readOnly". */
  permissions?: ClaudeCodePermissionLabel;
  allowedTools?: string[];
  disallowedTools?: string[];
}

export interface ClaudeCodeDispatchIdentity {
  turnId: string;
  fingerprint: string;
  nativeMessageId: string;
}

/** Last dispatch uncertainty only, not durable turn idempotency/history or replay material. */
export type ClaudeCodeDispatchState =
  | { state: "none" }
  | (ClaudeCodeDispatchIdentity & { state: "dispatching"; generation: string })
  | (ClaudeCodeDispatchIdentity & { state: "settled"; generation: string; outcome: "completed" | "failed" | "interrupted";
    /** sha256 of each steering message sent during this dispatch; lets history eligibility accept exactly those deliveries. */
    steers?: string[] });

export interface ClaudeCodeWorkerProcess { pid: number; processGroupId: number | null }
/** v4 launches carry the exact argv identity markers (`marked`) and the boot they started in. Neither
 * is process authority by itself; a missing bootIdentity means "no boot proof", unmarked means no signals. */
export interface ClaudeCodeWorkerLaunchIdentity { bootIdentity?: string }
interface WorkerReservation { generation: string; reservationId: string; workerExecutable: string; bootIdentity?: string; marked?: true }
/** Which independently observed fact allows forceClearWorker to drop an occupied slot. */
export type ClaudeCodeWorkerAbsenceProof = "unstarted" | "boot" | "group";
export type ClaudeCodeManagedWorker =
  | { state: "none" }
  | (WorkerReservation & { state: "reserved" })
  | (WorkerReservation & { state: "starting"; process: ClaudeCodeWorkerProcess | null })
  | (WorkerReservation & { state: "live"; registration: ClaudeCodeWorkerRegistration });

type WorkerOperation =
  | { type: "reserve"; reservationId: string; workerExecutable: string; launch?: ClaudeCodeWorkerLaunchIdentity }
  | { type: "begin" | "release"; reservationId: string }
  | { type: "process"; reservationId: string; pid: number; processGroupId: number | null }
  | { type: "publish"; reservationId: string; payload: Uint8Array }
  | { type: "clear"; reservationId: string; pid: number }
  | { type: "force-clear"; reservationId: string; proof: ClaudeCodeWorkerAbsenceProof };

/** Internal resume material. Never expose this as a sanitized inventory/profile. */
export interface ClaudeCodeManagedManifest {
  /** 3 predates launch identity (bootIdentity/markers); 4 predates the permission policy (read as readOnly). All stay readable. */
  version: 3 | 4 | 5;
  runtime: "claude-code";
  revision: number;
  generation: string;
  requiresExplicitResume: boolean;
  id: string;
  ownerId: string;
  native: ClaudeCodeNativeBinding;
  worker: ClaudeCodeManagedWorker;
  lastDispatch: ClaudeCodeDispatchState;
  launchConfig: AgentStartConfig & { cwd: string };
  policy: ClaudeCodeManagedPolicy;
  createdAt: string;
}

export interface ClaudeCodeManifestPatch {
  generation?: string;
  requiresExplicitResume?: boolean;
}

/** A lease expires with its lock callback. Native binding is one-way and immutable. */
export interface ClaudeCodeManifestLease {
  update(expectedRevision: number, patch: ClaudeCodeManifestPatch): Promise<ClaudeCodeManagedManifest>;
  beginNativeCreation(expectedRevision: number, sessionId: string): Promise<ClaudeCodeManagedManifest>;
  bindNativeSession(expectedRevision: number, sessionId: string): Promise<ClaudeCodeManagedManifest>;
  /** Persist before native input. A failed/crashed caller cannot reset or automatically replay it. */
  beginDispatch(expectedRevision: number, generation: string, identity: ClaudeCodeDispatchIdentity): Promise<ClaudeCodeManagedManifest>;
  /** Only the current, unfenced generation and exact native/caller input may record a terminal result. */
  settleDispatch(expectedRevision: number, generation: string, identity: ClaudeCodeDispatchIdentity,
    outcome: "completed" | "failed" | "interrupted", steers?: string[]): Promise<ClaudeCodeManagedManifest>;
  reserveWorker(expectedRevision: number, generation: string, reservationId: string, workerExecutable: string,
    launch?: ClaudeCodeWorkerLaunchIdentity): Promise<ClaudeCodeManagedManifest>;
  /** Commit before fork. A starting reservation with no recorded PID remains uncertain. */
  beginWorkerStart(expectedRevision: number, generation: string, reservationId: string): Promise<ClaudeCodeManagedManifest>;
  recordWorkerProcess(expectedRevision: number, generation: string, reservationId: string, pid: number, processGroupId: number | null): Promise<ClaudeCodeManagedManifest>;
  publishWorker(expectedRevision: number, generation: string, reservationId: string, payload: Uint8Array): Promise<ClaudeCodeManagedManifest>;
  /** Only the current unfenced pre-fork attempt can release without physical exit evidence. */
  releaseWorkerReservation(expectedRevision: number, generation: string, reservationId: string): Promise<ClaudeCodeManagedManifest>;
  /** Caller MUST independently confirm exact worker AND managed native/group exit;
   * PID equality or an RPC acknowledgment is NOT exit proof. Starting-without-PID
   * cannot be cleared. Preserves input uncertainty/native history/fence. */
  clearWorkerAfterExit(expectedRevision: number, generation: string, reservationId: string, pid: number): Promise<ClaudeCodeManagedManifest>;
  /** Forced-recovery clear. Needs the fence already persisted, but NOT a clean dispatch/history or a valid
   * registration. The caller MUST have independently proven absence (`proof`); the store only checks that the
   * claimed proof is coherent with the record. Keeps native binding/dispatch; rotates the generation. */
  forceClearWorker(expectedRevision: number, generation: string, reservationId: string, proof: ClaudeCodeWorkerAbsenceProof): Promise<ClaudeCodeManagedManifest>;
  /** Destroy: drop the Runtime resume metadata of a session whose worker slot is already `none`. Native history
   * lives under the native config root and is never touched. Returns the removed snapshot. */
  removeSession(expectedRevision: number): Promise<ClaudeCodeManagedManifest>;
}

export class ClaudeCodeManifestConflictError extends Error {}

function identity(value: string): void {
  if (typeof value !== "string" || !ID.test(value)) throw new Error("Invalid Claude Code managed identity");
}
function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
function keys(value: object, allowed: string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}
function stringList(value: unknown, limit: number): value is string[] {
  return Array.isArray(value) && value.length <= limit && new Set(value).size === value.length
    && value.every((item) => typeof item === "string" && item.trim() && Buffer.byteLength(item) <= 256 && !item.includes("\0"));
}
function dispatchIdentity(value: unknown): value is ClaudeCodeDispatchIdentity {
  if (!record(value)) return false;
  return typeof value.turnId === "string" && !!value.turnId.trim() && !value.turnId.includes("\0")
    && Buffer.byteLength(value.turnId) <= 256
    && typeof value.fingerprint === "string" && /^[a-f0-9]{64}$/.test(value.fingerprint)
    && typeof value.nativeMessageId === "string" && UUID.test(value.nativeMessageId);
}
function validDispatch(value: unknown): value is ClaudeCodeDispatchState {
  if (!record(value)) return false;
  if (value.state === "none") return keys(value, ["state"]);
  return dispatchIdentity(value) && typeof value.generation === "string" && ID.test(value.generation)
    && (value.state === "dispatching" ? keys(value, ["state", "turnId", "fingerprint", "nativeMessageId", "generation"])
      : value.state === "settled" && ["completed", "failed", "interrupted"].includes(value.outcome as string)
        && keys(value, ["state", "turnId", "fingerprint", "nativeMessageId", "generation", "outcome", "steers"])
        && (value.steers === undefined || (Array.isArray(value.steers) && value.steers.length <= 64
          && value.steers.every(item => typeof item === "string" && /^[a-f0-9]{64}$/.test(item)))));
}
function sameDispatch(left: ClaudeCodeDispatchIdentity, right: ClaudeCodeDispatchIdentity): boolean {
  return left.turnId === right.turnId && left.fingerprint === right.fingerprint && left.nativeMessageId === right.nativeMessageId;
}
function normalizedPath(value: unknown): value is string {
  return typeof value === "string" && !value.includes("\0") && isAbsolute(value) && resolve(value) === value
    && Buffer.byteLength(value) <= 4096 && Buffer.from(value).toString() === value;
}
function workerProcess(value: unknown): value is ClaudeCodeWorkerProcess {
  return record(value) && keys(value, ["pid", "processGroupId"])
    && typeof value.pid === "number" && Number.isInteger(value.pid) && value.pid > 0 && value.pid <= 2_147_483_647
    && (value.processGroupId === null || value.processGroupId === value.pid);
}
function workerScope(manifest: ClaudeCodeManagedManifest, reservation: WorkerReservation): ClaudeCodeWorkerRegistrationScope {
  return { sessionId: manifest.id, ownerId: manifest.ownerId, generation: reservation.generation,
    reservationId: reservation.reservationId, workerExecutable: reservation.workerExecutable,
    cwd: manifest.launchConfig.cwd, nativeConfigRoot: manifest.policy.nativeConfigRoot };
}
function validateWorker(worker: unknown, manifest: ClaudeCodeManagedManifest): void {
  if (!record(worker)) throw new Error("Invalid Claude Code worker state");
  if (worker.state === "none" && keys(worker, ["state"])) return;
  if (typeof worker.state !== "string" || !["reserved", "starting", "live"].includes(worker.state)
    || typeof worker.generation !== "string" || !ID.test(worker.generation)
    || typeof worker.reservationId !== "string" || !UUID.test(worker.reservationId)
    || !normalizedPath(worker.workerExecutable)) throw new Error("Invalid Claude Code worker reservation");
  if ((worker.bootIdentity !== undefined || worker.marked !== undefined) && manifest.version < 4) throw new Error("Invalid Claude Code worker launch identity");
  if ((worker.bootIdentity !== undefined && (typeof worker.bootIdentity !== "string" || !/^[a-z]+:[0-9a-f-]{32,36}$/.test(worker.bootIdentity)))
    || (worker.marked !== undefined && worker.marked !== true)) throw new Error("Invalid Claude Code worker launch identity");
  const common = ["state", "generation", "reservationId", "workerExecutable", "bootIdentity", "marked"];
  if (worker.state === "reserved" && keys(worker, common)) return;
  if (worker.state === "starting" && keys(worker, [...common, "process"])
    && (worker.process === null || workerProcess(worker.process))) return;
  if (worker.state === "live" && keys(worker, [...common, "registration"])) {
    encodeClaudeCodeWorkerRegistration(worker.registration as ClaudeCodeWorkerRegistration,
      workerScope(manifest, worker as unknown as WorkerReservation));
    return;
  }
  throw new Error("Invalid Claude Code worker registration state");
}
const LABELS = ["full", "edits", "readOnly", "custom"];
function validPolicy(policy: Record<string, unknown>, version: number): boolean {
  if (!["native", "isolated"].includes(policy.configuration as string) || !normalizedPath(policy.nativeConfigRoot)
    || !(policy.tools === null || stringList(policy.tools, 128))) return false;
  if (version < 5) return policy.permissionMode === "default" && keys(policy, ["configuration", "permissionMode", "tools", "nativeConfigRoot"]);
  if (!keys(policy, ["configuration", "permissionMode", "tools", "nativeConfigRoot", "permissions", "allowedTools", "disallowedTools"])
    || !CLAUDE_CODE_PERMISSION_MODES.includes(policy.permissionMode as string) || !LABELS.includes(policy.permissions as string)
    || (policy.allowedTools !== undefined && !stringList(policy.allowedTools, 128))
    || (policy.disallowedTools !== undefined && !stringList(policy.disallowedTools, 128))) return false;
  const mode = policy.permissionMode as ClaudeCodePermissionMode;
  // The label must describe the stored fields, so a hand-edited manifest cannot widen what a label implies.
  if (policy.permissions === "readOnly") return mode === "default" && policy.allowedTools === undefined && policy.disallowedTools === undefined
    && Array.isArray(policy.tools) && policy.tools.length === 3 && CLAUDE_CODE_READ_ONLY_TOOLS.every(tool => (policy.tools as string[]).includes(tool));
  if (policy.permissions === "edits") return mode === "acceptEdits" && policy.tools === null && policy.allowedTools === undefined && policy.disallowedTools === undefined;
  if (policy.permissions === "full") return mode === "bypassPermissions" && policy.tools === null && policy.allowedTools === undefined && policy.disallowedTools === undefined;
  return policy.tools === null;
}
/** Manifests before v5 predate the policy and are always the read-only MVP policy. */
export function claudeCodeEffectivePermissions(m: ClaudeCodeManagedManifest): ClaudeCodePermissionLabel {
  return m.version < 5 ? "readOnly" : m.policy.permissions!;
}

function validate(value: ClaudeCodeManagedManifest): void {
  if (!record(value)) throw new Error("Invalid Claude Code manifest");
  identity(value.id);
  identity(value.ownerId);
  identity(value.generation);
  const config = value.launchConfig;
  const native = value.native;
  const policy = value.policy;
  if (![3, 4, 5].includes(value.version) || value.runtime !== "claude-code"
    || !keys(value, ["version", "runtime", "revision", "generation", "requiresExplicitResume", "id", "ownerId", "native", "worker", "lastDispatch", "launchConfig", "policy", "createdAt"])
    || !Number.isSafeInteger(value.revision) || value.revision < 0 || value.revision >= Number.MAX_SAFE_INTEGER
    || typeof value.requiresExplicitResume !== "boolean"
    || typeof value.createdAt !== "string" || !Number.isFinite(Date.parse(value.createdAt))
    || !record(native) || !(native.state === "pending" ? keys(native, ["state"])
      : ["creating", "bound"].includes(native.state) && typeof native.sessionId === "string"
        && UUID.test(native.sessionId) && keys(native, ["state", "sessionId"]))
    || !validDispatch(value.lastDispatch) || (native.state !== "bound" && value.lastDispatch.state !== "none")
    || !record(policy) || !validPolicy(policy, value.version)
    || !record(config) || !normalizedPath(config.cwd)
    || !keys(config, ["cwd", "systemPrompt", "appendSystemPrompt", "model", "reasoningLevel", "skillIds"])
    || (config.systemPrompt !== undefined && typeof config.systemPrompt !== "string")
    || (config.appendSystemPrompt !== undefined && typeof config.appendSystemPrompt !== "string")
    || (config.systemPrompt !== undefined && config.appendSystemPrompt !== undefined)
    || (config.model !== undefined && (!record(config.model) || !keys(config.model, ["provider", "id"])
      || typeof config.model.provider !== "string" || !config.model.provider.trim()
      || typeof config.model.id !== "string" || !config.model.id.trim()))
    || (config.reasoningLevel !== undefined && !LEVELS.includes(config.reasoningLevel))
    || (config.skillIds !== undefined && !stringList(config.skillIds, 64))) {
    throw new Error("Invalid Claude Code managed launch policy");
  }
  validateWorker(value.worker, value);
}

async function privateDirectory(path: string, create = false): Promise<void> {
  if (create) await mkdir(path, { recursive: true, mode: 0o700 });
  const metadata = await lstat(path);
  if (!metadata.isDirectory() || metadata.isSymbolicLink() || (metadata.mode & 0o077)
    || (process.getuid && metadata.uid !== process.getuid()) || await realpath(path) !== path) {
    throw new Error("Claude Code managed directory must be private and not redirected");
  }
}
async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, "r");
  try { await handle.sync(); } finally { await handle.close(); }
}

/** Private storage primitives only. No worker launch, public lifecycle or native-history reads. */
export class ClaudeCodeManagedStore {
  private readonly root: string;
  constructor(root = join(homedir(), ".minu", "runtime-claude-code", "managed")) {
    if (!isAbsolute(root) || resolve(root) !== root) throw new Error("Claude Code storage root must be absolute and normalized");
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

  async withSessionLock<T>(
    id: string, ownerId: string, operation: (lease: ClaudeCodeManifestLease) => Promise<T>, timeoutMs = 5_000,
  ): Promise<T> {
    identity(id);
    const directory = await this.verify(ownerId, true);
    return withClaudeCodeLifecycleLock(join(directory, `.lifecycle-${id}.sqlite`), async () => {
      let active = true;
      let pending: Promise<ClaudeCodeManagedManifest> | undefined;
      const mutate = async (operation: () => Promise<ClaudeCodeManagedManifest>) => {
        if (!active || pending) throw new Error("Claude Code lifecycle lease is inactive or already mutating");
        pending = operation();
        try { return await pending; } finally { pending = undefined; }
      };
      const lease: ClaudeCodeManifestLease = {
        update: (revision, patch) => mutate(() => this.updateLocked(id, ownerId, revision, patch)),
        beginNativeCreation: (revision, sessionId) => mutate(() => this.bindLocked(id, ownerId, revision, sessionId, false)),
        bindNativeSession: (revision, sessionId) => mutate(() => this.bindLocked(id, ownerId, revision, sessionId, true)),
        beginDispatch: (revision, generation, identity) => mutate(() => this.dispatchLocked(id, ownerId, revision, generation, identity)),
        settleDispatch: (revision, generation, identity, outcome, steers) => mutate(() => this.dispatchLocked(id, ownerId, revision, generation, identity, { outcome, ...(steers?.length ? { steers } : {}) })),
        reserveWorker: (revision, generation, reservationId, workerExecutable, launch) => mutate(() => this.workerLocked(id, ownerId, revision, generation, { type: "reserve", reservationId, workerExecutable, ...(launch ? { launch } : {}) })),
        beginWorkerStart: (revision, generation, reservationId) => mutate(() => this.workerLocked(id, ownerId, revision, generation, { type: "begin", reservationId })),
        recordWorkerProcess: (revision, generation, reservationId, pid, processGroupId) => mutate(() => this.workerLocked(id, ownerId, revision, generation, { type: "process", reservationId, pid, processGroupId })),
        publishWorker: (revision, generation, reservationId, payload) => mutate(() => this.workerLocked(id, ownerId, revision, generation, { type: "publish", reservationId, payload })),
        releaseWorkerReservation: (revision, generation, reservationId) => mutate(() => this.workerLocked(id, ownerId, revision, generation, { type: "release", reservationId })),
        clearWorkerAfterExit: (revision, generation, reservationId, pid) => mutate(() => this.workerLocked(id, ownerId, revision, generation, { type: "clear", reservationId, pid })),
        removeSession: revision => mutate(() => this.removeLocked(id, ownerId, revision)),
        forceClearWorker: (revision, generation, reservationId, proof) => mutate(() => this.workerLocked(id, ownerId, revision, generation, { type: "force-clear", reservationId, proof })),
      };
      try { return await operation(lease); }
      finally {
        active = false;
        // A caller's unawaited mutation must finish before releasing the OS lock.
        await pending?.catch(() => {});
      }
    }, timeoutMs);
  }

  /** Real metadata-backed bridge admission. This is not OS process provenance or kill authority.
   * Use the supplied lease; never recursively acquire the same lifecycle lock. */
  async withWorkerAdmission<T>(
    scope: ClaudeCodeWorkerRegistrationScope, payload: Uint8Array,
    operation: (lease: ClaudeCodeManifestLease, manifest: ClaudeCodeManagedManifest) => Promise<T>,
    timeoutMs = 5_000,
  ): Promise<T> {
    // Decode/encode synchronously before awaiting; caller objects and buffers are not retained.
    const expected = decodeClaudeCodeWorkerRegistration(payload, scope);
    const expectedBytes = encodeClaudeCodeWorkerRegistration(expected, scope);
    return this.withSessionLock(expected.sessionId, expected.ownerId, async lease => {
      const current = await this.read(expected.sessionId, expected.ownerId);
      if (!current || current.requiresExplicitResume || current.generation !== expected.generation || current.worker.state !== "live") {
        throw new ClaudeCodeManifestConflictError("Claude Code live worker authority is unavailable");
      }
      const actual = encodeClaudeCodeWorkerRegistration(current.worker.registration, workerScope(current, current.worker));
      if (actual.byteLength !== expectedBytes.byteLength || !timingSafeEqual(actual, expectedBytes)) {
        throw new ClaudeCodeManifestConflictError("Claude Code worker registration changed");
      }
      return operation(lease, current);
    }, timeoutMs);
  }

  async create(manifest: ClaudeCodeManagedManifest): Promise<void> {
    const snapshot = JSON.parse(JSON.stringify(manifest)) as ClaudeCodeManagedManifest;
    validate(snapshot);
    if (snapshot.revision !== 0 || snapshot.native.state !== "pending" || snapshot.worker.state !== "none" || snapshot.lastDispatch.state !== "none" || snapshot.requiresExplicitResume) {
      throw new Error("New Claude Code metadata must be pending, unfenced revision zero");
    }
    const data = this.encode(snapshot);
    await this.withSessionLock(snapshot.id, snapshot.ownerId, async () => {
      const directory = this.directory(snapshot.ownerId);
      const destination = join(directory, `${snapshot.id}.session`);
      try {
        await lstat(destination);
        throw new ClaudeCodeManifestConflictError("Claude Code managed identity already exists");
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      const temporary = join(directory, `.${randomUUID()}.tmp`);
      await mkdir(temporary, { mode: 0o700 });
      try {
        const handle = await open(join(temporary, "manifest.json"), "wx", 0o600);
        try { await handle.writeFile(data); await handle.sync(); } finally { await handle.close(); }
        await syncDirectory(temporary);
        await rename(temporary, destination);
        await syncDirectory(directory);
      } finally {
        // Only the unpublished staging path; never the final identity or native history.
        await rm(temporary, { recursive: true, force: true });
      }
    });
  }

  async update(id: string, ownerId: string, revision: number, patch: ClaudeCodeManifestPatch): Promise<ClaudeCodeManagedManifest> {
    const snapshot = JSON.parse(JSON.stringify(patch)) as ClaudeCodeManifestPatch;
    return this.withSessionLock(id, ownerId, (lease) => lease.update(revision, snapshot));
  }
  private async current(id: string, ownerId: string, revision: number): Promise<ClaudeCodeManagedManifest> {
    if (!Number.isSafeInteger(revision) || revision < 0) throw new Error("Invalid Claude Code manifest revision");
    const current = await this.read(id, ownerId);
    if (!current || current.revision !== revision) throw new ClaudeCodeManifestConflictError("Claude Code manifest is missing or stale");
    return current;
  }
  private async updateLocked(id: string, ownerId: string, revision: number, patch: ClaudeCodeManifestPatch): Promise<ClaudeCodeManagedManifest> {
    const snapshot = JSON.parse(JSON.stringify(patch)) as ClaudeCodeManifestPatch;
    if (!record(snapshot) || !Object.keys(snapshot).length || !keys(snapshot, ["generation", "requiresExplicitResume"])) {
      throw new Error("Invalid Claude Code manifest update");
    }
    const current = await this.current(id, ownerId, revision);
    return this.publishUpdate({ ...current, ...snapshot, revision: current.revision + 1 });
  }
  private async bindLocked(id: string, ownerId: string, revision: number, sessionId: string, bind: boolean): Promise<ClaudeCodeManagedManifest> {
    if (typeof sessionId !== "string" || !UUID.test(sessionId)) throw new Error("Invalid Claude Code native session identity");
    const current = await this.current(id, ownerId, revision);
    if (current.requiresExplicitResume || current.native.state !== (bind ? "creating" : "pending")
      || (bind && current.native.state === "creating" && current.native.sessionId !== sessionId)) {
      throw new ClaudeCodeManifestConflictError("Claude Code native binding is fenced, bound or uncertain");
    }
    return this.publishUpdate({ ...current, revision: current.revision + 1,
      native: { state: bind ? "bound" : "creating", sessionId } });
  }
  private async dispatchLocked(
    id: string, ownerId: string, revision: number, generation: string, identity: ClaudeCodeDispatchIdentity,
    completion?: { outcome: "completed" | "failed" | "interrupted"; steers?: string[] },
  ): Promise<ClaudeCodeManagedManifest> {
    const outcome = completion?.outcome;
    const snapshot = JSON.parse(JSON.stringify(identity)) as ClaudeCodeDispatchIdentity;
    if (!dispatchIdentity(snapshot) || !keys(snapshot, ["turnId", "fingerprint", "nativeMessageId"])
      || typeof generation !== "string" || !ID.test(generation)
      || (completion !== undefined && !["completed", "failed", "interrupted"].includes(outcome!))) {
      throw new Error("Invalid Claude Code dispatch identity");
    }
    const current = await this.current(id, ownerId, revision);
    if (current.requiresExplicitResume || current.generation !== generation || current.native.state !== "bound") {
      throw new ClaudeCodeManifestConflictError("Claude Code dispatch generation, binding or recovery fence changed");
    }
    const previous = current.lastDispatch;
    if (outcome === undefined) {
      if (previous.state === "dispatching") throw new ClaudeCodeManifestConflictError("Claude Code input outcome is still uncertain");
      if (previous.state === "settled" && (previous.turnId === snapshot.turnId || previous.nativeMessageId === snapshot.nativeMessageId)) {
        throw new ClaudeCodeManifestConflictError("Claude Code last terminal input cannot be redispatched as new work");
      }
    } else if (previous.state !== "dispatching" || previous.generation !== generation || !sameDispatch(previous, snapshot)) {
      throw new ClaudeCodeManifestConflictError("Claude Code terminal result does not match the active dispatch");
    }
    const lastDispatch: ClaudeCodeDispatchState = outcome === undefined
      ? { ...snapshot, state: "dispatching", generation }
      : { ...snapshot, state: "settled", generation, outcome, ...(completion!.steers?.length ? { steers: [...new Set(completion!.steers)] } : {}) };
    return this.publishUpdate({ ...current, revision: current.revision + 1, lastDispatch });
  }
  private async removeLocked(id: string, ownerId: string, revision: number): Promise<ClaudeCodeManagedManifest> {
    const current = await this.current(id, ownerId, revision);
    if (current.worker.state !== "none") throw new ClaudeCodeManifestConflictError("Claude Code worker slot is occupied; absence is unproven");
    const owner = this.directory(ownerId), directory = join(owner, `${id}.session`), removed = join(owner, `.${randomUUID()}.removed`);
    // Rename first so a crash leaves either the whole record or none; the staging name is never an identity.
    await rename(directory, removed);
    try { await syncDirectory(owner); } finally { await rm(removed, { recursive: true, force: true }); }
    return current;
  }
  private async workerLocked(
    id: string, ownerId: string, revision: number, generation: string, operation: WorkerOperation,
  ): Promise<ClaudeCodeManagedManifest> {
    identity(generation);
    if (typeof operation.reservationId !== "string" || !UUID.test(operation.reservationId)) throw new Error("Invalid Claude Code worker reservation identity");
    let payload: Uint8Array | undefined;
    if (operation.type === "publish") {
      try {
        if (!(operation.payload instanceof Uint8Array) || operation.payload.byteLength > CLAUDE_CODE_WORKER_REGISTRATION_MAX_BYTES) throw new Error();
        payload = new Uint8Array(operation.payload.byteLength);
        payload.set(operation.payload);
      } catch { throw new Error("Invalid bounded Claude Code worker registration payload"); }
    }
    const current = await this.current(id, ownerId, revision);
    if (current.generation !== generation) throw new ClaudeCodeManifestConflictError("Claude Code worker generation changed");
    const worker = current.worker;
    let next: ClaudeCodeManagedWorker;
    if (operation.type === "reserve") {
      if (!normalizedPath(operation.workerExecutable)) throw new Error("Invalid Claude Code worker executable");
      if (current.requiresExplicitResume || worker.state !== "none" || current.native.state === "creating"
        || current.lastDispatch.state === "dispatching"
        || (current.native.state === "bound" && current.lastDispatch.state !== "settled")) {
        throw new ClaudeCodeManifestConflictError("Claude Code worker launch is active, fenced or uncertain");
      }
      next = { state: "reserved", generation, reservationId: operation.reservationId, workerExecutable: operation.workerExecutable,
        ...(operation.launch ? { marked: true as const, ...(operation.launch.bootIdentity ? { bootIdentity: operation.launch.bootIdentity } : {}) } : {}) };
      return this.publishUpdate({ ...current, revision: current.revision + 1, ...(operation.launch ? { version: Math.max(current.version, 4) as 4 | 5 } : {}), worker: next });
    } else {
      if (worker.state === "none" || worker.reservationId !== operation.reservationId) throw new ClaudeCodeManifestConflictError("Claude Code worker reservation changed");
      if (operation.type === "release") {
        if (current.requiresExplicitResume || worker.generation !== generation || worker.state !== "reserved") {
          throw new ClaudeCodeManifestConflictError("Claude Code worker reservation release authority changed");
        }
        return this.publishUpdate({ ...current, revision: current.revision + 1, generation: randomUUID(), worker: { state: "none" } });
      }
      if (operation.type === "force-clear") {
        const group = worker.state === "live" ? worker.registration.processGroupId : worker.state === "starting" ? worker.process?.processGroupId : null;
        if (!current.requiresExplicitResume || !["unstarted", "boot", "group"].includes(operation.proof)
          || (operation.proof === "unstarted" && worker.state !== "reserved")
          || (operation.proof === "boot" && worker.bootIdentity === undefined)
          || (operation.proof === "group" && !group)) {
          throw new ClaudeCodeManifestConflictError("Claude Code forced clear requires the fence and a coherent absence proof");
        }
        // The caller proved absence independently. Rotation fences every old controller/callback.
        return this.publishUpdate({ ...current, revision: current.revision + 1, generation: randomUUID(), worker: { state: "none" } });
      }
      if (operation.type === "clear") {
        const pid = worker.state === "live" ? worker.registration.pid : worker.state === "starting" ? worker.process?.pid : undefined;
        if (pid === undefined || operation.pid !== pid) throw new ClaudeCodeManifestConflictError("Claude Code recorded worker process does not match confirmed exit");
        // Only the caller can prove physical exit. Rotation fences every old controller/callback.
        return this.publishUpdate({ ...current, revision: current.revision + 1, generation: randomUUID(), worker: { state: "none" } });
      }
      if (current.requiresExplicitResume || worker.generation !== generation) throw new ClaudeCodeManifestConflictError("Claude Code worker startup authority changed");
      if (operation.type === "begin") {
        if (worker.state !== "reserved") throw new ClaudeCodeManifestConflictError("Claude Code worker launch has already been attempted");
        next = { ...worker, state: "starting", process: null };
      } else if (operation.type === "process") {
        if (worker.state !== "starting" || worker.process !== null) throw new ClaudeCodeManifestConflictError("Claude Code worker process is already recorded or unavailable");
        const process = { pid: operation.pid, processGroupId: operation.processGroupId };
        if (!workerProcess(process)) throw new Error("Invalid Claude Code worker process identity");
        next = { ...worker, process };
      } else {
        if (worker.state !== "starting" || !worker.process) throw new ClaudeCodeManifestConflictError("Claude Code worker startup has no recorded process");
        const registration = decodeClaudeCodeWorkerRegistration(payload!, workerScope(current, worker));
        if (registration.pid !== worker.process.pid || registration.processGroupId !== worker.process.processGroupId) {
          throw new ClaudeCodeManifestConflictError("Claude Code worker registration process mismatch");
        }
        next = { state: "live", generation, reservationId: worker.reservationId, workerExecutable: worker.workerExecutable, registration,
          ...(worker.marked ? { marked: true as const } : {}), ...(worker.bootIdentity ? { bootIdentity: worker.bootIdentity } : {}) };
      }
    }
    return this.publishUpdate({ ...current, revision: current.revision + 1, worker: next });
  }
  private encode(manifest: ClaudeCodeManagedManifest): string {
    validate(manifest);
    const data = `${JSON.stringify(manifest)}\n`;
    if (Buffer.byteLength(data) > MAX_BYTES) throw new Error("Claude Code manifest is too large");
    return data;
  }
  private async publishUpdate(next: ClaudeCodeManagedManifest): Promise<ClaudeCodeManagedManifest> {
    const data = this.encode(next);
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

  async read(id: string, ownerId: string): Promise<ClaudeCodeManagedManifest | undefined> {
    identity(id);
    identity(ownerId);
    let directory: string;
    try {
      directory = join(await this.verify(ownerId), `${id}.session`);
      await privateDirectory(directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
    // Once a session directory exists, a missing/corrupt manifest is an error, not an absent identity.
    const handle = await open(join(directory, "manifest.json"), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const metadata = await handle.stat();
      // Atomic replacement can unlink a reader's pinned snapshot; multiple links are unsafe.
      if (!metadata.isFile() || metadata.nlink > 1 || metadata.size > MAX_BYTES || (metadata.mode & 0o077)
        || (process.getuid && metadata.uid !== process.getuid())) throw new Error("Claude Code manifest must be a bounded private regular file");
      const buffer = Buffer.alloc(MAX_BYTES + 1);
      let length = 0;
      while (length < buffer.length) {
        const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
        if (!bytesRead) break;
        length += bytesRead;
      }
      if (length > MAX_BYTES) throw new Error("Claude Code manifest is too large");
      let manifest: ClaudeCodeManagedManifest;
      try {
        // Never repair corrupt scope bytes or strip a BOM before validating identity.
        const source = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(buffer.subarray(0, length));
        manifest = JSON.parse(source) as ClaudeCodeManagedManifest;
      } catch { throw new Error("Invalid Claude Code manifest encoding"); }
      validate(manifest);
      if (manifest.id !== id || manifest.ownerId !== ownerId) throw new Error("Claude Code manifest ownership mismatch");
      return manifest;
    } finally { await handle.close(); }
  }

  async list(ownerId: string): Promise<ClaudeCodeManagedManifest[]> {
    let names: string[];
    try { names = await readdir(await this.verify(ownerId)); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const manifests: ClaudeCodeManagedManifest[] = [];
    for (const name of names.sort()) {
      if (!name.endsWith(".session")) continue;
      const manifest = await this.read(name.slice(0, -8), ownerId);
      if (manifest) manifests.push(manifest);
    }
    return manifests;
  }
}
