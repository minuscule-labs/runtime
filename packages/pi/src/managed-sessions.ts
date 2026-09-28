import { createHash, randomUUID } from "node:crypto";
import { StringDecoder } from "node:string_decoder";
import { open, chmod, lstat, mkdir, readFile, readdir, realpath, rm, rename } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import type {
  AgentStartConfig,
  ManagedSessionState,
} from "@minu/runtime-core";
import { registryDirectory } from "./registry.js";

const OWNER_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const MANAGED_SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const MANIFEST_STATES = ["starting", "active", "suspending", "suspended", "resuming", "destroying"] as const;
type ManifestState = typeof MANIFEST_STATES[number];
const SESSION_ENTRY_TYPES = new Set([
  "message", "thinking_level_change", "model_change", "compaction", "branch_summary",
  "custom", "custom_message", "label", "session_info",
]);
const SESSION_MESSAGE_ROLES = new Set([
  "user", "assistant", "toolResult", "bashExecution", "custom", "branchSummary", "compactionSummary",
]);
const MAX_SESSION_ENTRY_LENGTH = 64 * 1024 * 1024;

export interface ManagedSessionManifest {
  version: 2;
  managedSessionId: string;
  ownerId: string;
  state: ManifestState;
  cwd: string;
  launchConfig: AgentStartConfig;
  sessionFile?: string;
  /** Immutable Pi session-header identity; unlike nativeSessionId, this does not change on reopen. */
  transcriptId: string;
  nativeSessionId?: string;
  workerPid?: number;
  createdAt: string;
  updatedAt: string;
}

const processLocks = new Map<string, Promise<void>>();

export class ManagedSessionBusyError extends Error {}
export class ManagedSessionNotFoundError extends Error {}

export function validateRuntimeOwnerId(ownerId: string): void {
  if (typeof ownerId !== "string" || !OWNER_ID_PATTERN.test(ownerId)) throw new Error("Invalid Runtime owner id");
}

export function validateManagedSessionIdentity(managedSessionId: string, ownerId: string): void {
  if (typeof managedSessionId !== "string" || !MANAGED_SESSION_ID_PATTERN.test(managedSessionId)) {
    throw new Error("Invalid Runtime-managed session id");
  }
  validateRuntimeOwnerId(ownerId);
}

function managedRoot(): string {
  return resolve(join(registryDirectory(), "managed"));
}

function ownerDirectory(ownerId: string): string {
  if (!OWNER_ID_PATTERN.test(ownerId)) throw new Error("Invalid Runtime owner id");
  const ownerKey = createHash("sha256").update(ownerId).digest("hex");
  return join(managedRoot(), ownerKey);
}

function managedTranscriptPath(managedSessionId: string, ownerId: string): string {
  validateManagedSessionIdentity(managedSessionId, ownerId);
  return join(ownerDirectory(ownerId), `${managedSessionId}.jsonl`);
}

export function managedSessionManifestPath(managedSessionId: string, ownerId: string): string {
  validateManagedSessionIdentity(managedSessionId, ownerId);
  return join(ownerDirectory(ownerId), `${managedSessionId}.json`);
}

async function verifyPrivateDirectory(directory: string): Promise<void> {
  const metadata = await lstat(directory);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()
    || (typeof process.getuid === "function" && metadata.uid !== process.getuid())
    || (process.platform !== "win32" && (metadata.mode & 0o077) !== 0)) {
    throw new Error("Runtime managed-session storage directory is redirected or not private");
  }
}

async function ensurePrivateDirectory(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const metadata = await lstat(directory);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()
    || (typeof process.getuid === "function" && metadata.uid !== process.getuid())) {
    throw new Error("Runtime managed-session storage directory is redirected or not owned by this user");
  }
  if (process.platform !== "win32" && (metadata.mode & 0o077) !== 0) await chmod(directory, 0o700);
  await verifyPrivateDirectory(directory);
}

async function syncDirectory(directory: string): Promise<void> {
  if (process.platform === "win32") return;
  const handle = await open(directory, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function normalizedLaunchConfig(config: AgentStartConfig, cwd: string): AgentStartConfig {
  return {
    cwd,
    ...(config.systemPrompt !== undefined ? { systemPrompt: config.systemPrompt } : {}),
    ...(config.appendSystemPrompt !== undefined ? { appendSystemPrompt: config.appendSystemPrompt } : {}),
    ...(config.model ? { model: { provider: config.model.provider, id: config.model.id } } : {}),
    ...(config.reasoningLevel !== undefined ? { reasoningLevel: config.reasoningLevel } : {}),
    ...(config.skillIds !== undefined ? { skillIds: [...config.skillIds] } : {}),
  };
}

function validateManifest(manifest: ManagedSessionManifest): void {
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    throw new Error("Invalid Runtime managed-session manifest");
  }
  validateManagedSessionIdentity(manifest.managedSessionId, manifest.ownerId);
  if (manifest.version !== 2 || !MANIFEST_STATES.includes(manifest.state)) {
    throw new Error("Invalid Runtime managed-session manifest");
  }
  if (!isAbsolute(manifest.cwd) || resolve(manifest.cwd) !== manifest.cwd) {
    throw new Error("Invalid Runtime managed-session working directory");
  }
  if (!manifest.launchConfig || typeof manifest.launchConfig !== "object" || Array.isArray(manifest.launchConfig)
    || manifest.launchConfig.cwd !== manifest.cwd
    || (manifest.launchConfig.systemPrompt !== undefined && typeof manifest.launchConfig.systemPrompt !== "string")
    || (manifest.launchConfig.appendSystemPrompt !== undefined && typeof manifest.launchConfig.appendSystemPrompt !== "string")
    || (manifest.launchConfig.systemPrompt !== undefined && manifest.launchConfig.appendSystemPrompt !== undefined)) {
    throw new Error("Invalid Runtime managed-session launch configuration");
  }
  if (manifest.sessionFile !== undefined
    && (typeof manifest.sessionFile !== "string" || !isAbsolute(manifest.sessionFile) || resolve(manifest.sessionFile) !== manifest.sessionFile
      || manifest.sessionFile !== managedTranscriptPath(manifest.managedSessionId, manifest.ownerId))) {
    throw new Error("Invalid Runtime managed-session transcript path");
  }
  if (typeof manifest.transcriptId !== "string" || manifest.transcriptId.length === 0 || manifest.transcriptId.length > 512) {
    throw new Error("Invalid Runtime managed-session transcript identity");
  }
  if (manifest.nativeSessionId !== undefined
    && (typeof manifest.nativeSessionId !== "string" || manifest.nativeSessionId.length > 512)) {
    throw new Error("Invalid Runtime managed-session native reference");
  }
  if (manifest.workerPid !== undefined && (!Number.isSafeInteger(manifest.workerPid) || manifest.workerPid < 1)) {
    throw new Error("Invalid Runtime managed-session worker process reference");
  }
  if (typeof manifest.createdAt !== "string" || typeof manifest.updatedAt !== "string"
    || !Number.isFinite(Date.parse(manifest.createdAt)) || !Number.isFinite(Date.parse(manifest.updatedAt))) {
    throw new Error("Invalid Runtime managed-session timestamps");
  }
}

export async function writeManagedSessionManifest(manifest: ManagedSessionManifest): Promise<void> {
  validateManifest(manifest);
  const directory = ownerDirectory(manifest.ownerId);
  await ensurePrivateDirectory(managedRoot());
  await ensurePrivateDirectory(directory);
  const destination = managedSessionManifestPath(manifest.managedSessionId, manifest.ownerId);
  const temporary = join(dirname(destination), `.${basename(destination)}.${process.pid}.${randomUUID()}.tmp`);
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(temporary, destination);
    await syncDirectory(directory);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

export async function createManagedSessionManifest(
  config: AgentStartConfig,
  ownerId: string,
  managedSessionId = randomUUID(),
): Promise<ManagedSessionManifest> {
  validateManagedSessionIdentity(managedSessionId, ownerId);
  const cwd = await realpath(resolve(config.cwd ?? process.cwd()));
  const timestamp = new Date().toISOString();
  const sessionFile = managedTranscriptPath(managedSessionId, ownerId);
  const transcriptId = randomUUID();
  const manifest: ManagedSessionManifest = {
    version: 2,
    managedSessionId,
    ownerId,
    state: "starting",
    cwd,
    launchConfig: normalizedLaunchConfig(config, cwd),
    sessionFile,
    transcriptId,
    nativeSessionId: transcriptId,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  await writeManagedSessionManifest(manifest);
  try {
    const transcript = await open(sessionFile, "wx", 0o600);
    try {
      await transcript.writeFile(`${JSON.stringify({
        type: "session",
        version: 3,
        id: transcriptId,
        timestamp,
        cwd,
      })}\n`, "utf8");
      await transcript.sync();
    } finally {
      await transcript.close();
    }
    await syncDirectory(ownerDirectory(ownerId));
  } catch (error) {
    await rm(sessionFile, { force: true }).catch(() => {});
    await removeManagedSessionManifest(managedSessionId, ownerId).catch(() => {});
    throw error;
  }
  return manifest;
}

export async function readManagedSessionManifest(
  managedSessionId: string,
  ownerId: string,
): Promise<ManagedSessionManifest | undefined> {
  const path = managedSessionManifestPath(managedSessionId, ownerId);
  try {
    await verifyPrivateDirectory(managedRoot());
    await verifyPrivateDirectory(ownerDirectory(ownerId));
    const metadata = await lstat(path);
    if (!metadata.isFile() || metadata.isSymbolicLink()
      || (typeof process.getuid === "function" && metadata.uid !== process.getuid())
      || (process.platform !== "win32" && (metadata.mode & 0o077) !== 0)) {
      throw new Error("Runtime managed-session manifest is not private");
    }
    const manifest = JSON.parse(await readFile(path, "utf8")) as ManagedSessionManifest;
    validateManifest(manifest);
    if (manifest.managedSessionId !== managedSessionId || manifest.ownerId !== ownerId) {
      throw new Error("Runtime managed-session ownership does not match");
    }
    return manifest;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

export interface ManagedSessionManifestEntry {
  managedSessionId: string;
  manifest?: ManagedSessionManifest;
  createdAt?: string;
  updatedAt: string;
}

export async function listManagedSessionManifests(ownerId: string): Promise<ManagedSessionManifestEntry[]> {
  const directory = ownerDirectory(ownerId);
  let entries: string[];
  try {
    await verifyPrivateDirectory(managedRoot());
    await verifyPrivateDirectory(directory);
    entries = await readdir(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const manifests = await Promise.all(entries.flatMap((entry) => {
    if (!entry.endsWith(".json")) return [];
    const managedSessionId = entry.slice(0, -5);
    if (!MANAGED_SESSION_ID_PATTERN.test(managedSessionId)) return [];
    return [(async (): Promise<ManagedSessionManifestEntry | undefined> => {
      const manifestPath = managedSessionManifestPath(managedSessionId, ownerId);
      const metadata = await lstat(manifestPath).catch(() => undefined);
      if (!metadata) return undefined;
      const manifest = await readManagedSessionManifest(managedSessionId, ownerId).catch(() => undefined);
      const observedAt = metadata.mtime.toISOString();
      return {
        managedSessionId,
        ...(manifest ? { manifest } : {}),
        ...(manifest ? { createdAt: manifest.createdAt } : {}),
        updatedAt: manifest?.updatedAt ?? observedAt,
      };
    })()];
  }));
  return manifests.filter((entry): entry is ManagedSessionManifestEntry => entry !== undefined);
}

export async function removeManagedSessionManifest(managedSessionId: string, ownerId: string): Promise<void> {
  const path = managedSessionManifestPath(managedSessionId, ownerId);
  await verifyPrivateDirectory(managedRoot());
  await verifyPrivateDirectory(dirname(path));
  await rm(path, { force: true });
  await syncDirectory(dirname(path));
}

export async function recordManagedSessionWorkerStarted(managedSessionId: string, ownerId: string): Promise<void> {
  const manifest = await readManagedSessionManifest(managedSessionId, ownerId);
  if (!manifest || (manifest.state !== "starting" && manifest.state !== "resuming")) {
    throw new ManagedSessionNotFoundError("Runtime-managed session is not in a start or resume transition");
  }
  await validateManagedSessionCwd(manifest.cwd);
  manifest.workerPid = process.pid;
  manifest.updatedAt = new Date().toISOString();
  await writeManagedSessionManifest(manifest);
}

export async function recordManagedSessionWorker(
  managedSessionId: string,
  ownerId: string,
  sessionFile: string | undefined,
  nativeSessionId: string,
): Promise<void> {
  const manifest = await readManagedSessionManifest(managedSessionId, ownerId);
  if (!manifest || (manifest.state !== "starting" && manifest.state !== "resuming")) {
    throw new ManagedSessionNotFoundError("Runtime-managed session is not in a start or resume transition");
  }
  if (!sessionFile || resolve(sessionFile) !== manifest.sessionFile) {
    throw new Error("Pi did not reopen the Runtime-managed transcript");
  }
  await validatePiSessionFile(sessionFile, manifest.cwd, manifest.transcriptId);
  manifest.sessionFile = resolve(sessionFile);
  manifest.nativeSessionId = nativeSessionId;
  manifest.workerPid = process.pid;
  manifest.state = "active";
  manifest.updatedAt = new Date().toISOString();
  await writeManagedSessionManifest(manifest);
}

export async function validateManagedSessionCwd(cwd: string): Promise<void> {
  if (!isAbsolute(cwd) || resolve(cwd) !== cwd) throw new Error("Managed Pi working directory is invalid");
  try {
    if (await realpath(cwd) !== cwd) throw new Error("redirected");
  } catch {
    throw new Error("Managed Pi working directory is missing or redirected");
  }
}

export async function validatePiSessionFile(sessionFile: string, cwd: string, transcriptId: string): Promise<void> {
  if (!isAbsolute(sessionFile) || resolve(sessionFile) !== sessionFile) {
    throw new Error("Pi session transcript path is invalid");
  }
  let handle;
  try {
    await validateManagedSessionCwd(cwd);
    const metadata = await lstat(sessionFile);
    if (!metadata.isFile() || metadata.isSymbolicLink()
      || (process.platform !== "win32" && (metadata.mode & 0o077) !== 0)) throw new Error("not a private regular file");
    if (typeof process.getuid === "function" && metadata.uid !== process.getuid()) {
      throw new Error("not owned by this Runtime user");
    }
    handle = await open(sessionFile, "r");
    const openedMetadata = await handle.stat();
    if (!openedMetadata.isFile() || metadata.dev !== openedMetadata.dev || metadata.ino !== openedMetadata.ino) {
      throw new Error("transcript changed while opening");
    }

    const decoder = new StringDecoder("utf8");
    const buffer = Buffer.allocUnsafe(64 * 1024);
    const entryIds = new Set<string>();
    let pending = "";
    let lineNumber = 0;
    const validateLine = (line: string): void => {
      if (!line.trim() || line.length > MAX_SESSION_ENTRY_LENGTH) throw new Error("empty or oversized session entry");
      const value = JSON.parse(line) as unknown;
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("entry is not an object");
      const entry = value as Record<string, unknown>;
      if (lineNumber === 0) {
        if (entry.type !== "session" || entry.id !== transcriptId || entry.cwd !== cwd
          || !Number.isSafeInteger(entry.version) || typeof entry.timestamp !== "string"
          || !Number.isFinite(Date.parse(entry.timestamp))) {
          throw new Error("session header does not match its managed identity");
        }
      } else {
        if (typeof entry.type !== "string" || !SESSION_ENTRY_TYPES.has(entry.type)
          || typeof entry.id !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(entry.id)
          || entryIds.has(entry.id)
          || (entry.parentId !== null && typeof entry.parentId !== "string")
          || (entryIds.size === 0 && entry.parentId !== null)
          || (entryIds.size > 0 && (typeof entry.parentId !== "string" || !entryIds.has(entry.parentId)))
          || typeof entry.timestamp !== "string" || !Number.isFinite(Date.parse(entry.timestamp))) {
          throw new Error("invalid session entry identity or ancestry");
        }
        switch (entry.type) {
          case "message": {
            const message = entry.message;
            if (!message || typeof message !== "object" || Array.isArray(message)
              || typeof (message as Record<string, unknown>).role !== "string"
              || !SESSION_MESSAGE_ROLES.has((message as Record<string, unknown>).role as string)) {
              throw new Error("invalid message entry");
            }
            break;
          }
          case "thinking_level_change":
            if (typeof entry.thinkingLevel !== "string") throw new Error("invalid thinking-level entry");
            break;
          case "model_change":
            if (typeof entry.provider !== "string" || typeof entry.modelId !== "string") throw new Error("invalid model entry");
            break;
          case "compaction":
            if (typeof entry.summary !== "string") throw new Error("invalid compaction entry");
            break;
          case "branch_summary":
            if (typeof entry.fromId !== "string" || !entryIds.has(entry.fromId) || typeof entry.summary !== "string") {
              throw new Error("invalid branch-summary entry");
            }
            break;
          case "custom":
            if (typeof entry.customType !== "string") throw new Error("invalid custom entry");
            break;
          case "custom_message":
            if (typeof entry.customType !== "string" || typeof entry.display !== "boolean"
              || (typeof entry.content !== "string" && !Array.isArray(entry.content))) {
              throw new Error("invalid custom-message entry");
            }
            break;
          case "label":
            if (typeof entry.targetId !== "string" || !entryIds.has(entry.targetId)
              || (entry.label !== undefined && typeof entry.label !== "string")) {
              throw new Error("invalid label entry");
            }
            break;
          case "session_info":
            if (entry.name !== undefined && typeof entry.name !== "string") throw new Error("invalid session-info entry");
            break;
        }
        entryIds.add(entry.id);
      }
      lineNumber += 1;
    };

    while (true) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      pending += decoder.write(buffer.subarray(0, bytesRead));
      let newlineIndex = pending.indexOf("\n");
      while (newlineIndex !== -1) {
        validateLine(pending.slice(0, newlineIndex).replace(/\r$/, ""));
        pending = pending.slice(newlineIndex + 1);
        newlineIndex = pending.indexOf("\n");
      }
      if (pending.length > MAX_SESSION_ENTRY_LENGTH) throw new Error("oversized session entry");
    }
    pending += decoder.end();
    if (pending.length > 0) validateLine(pending.replace(/\r$/, ""));
    if (lineNumber === 0) throw new Error("missing session header");
  } catch {
    throw new Error("Managed Pi transcript is missing, redirected, or invalid");
  } finally {
    await handle?.close();
  }
}

export async function managedSessionState(
  manifest: ManagedSessionManifest,
  isActive: boolean,
): Promise<ManagedSessionState> {
  if (isActive) return "active";
  if (!manifest.sessionFile || manifest.state === "starting" || manifest.state === "destroying") {
    return "unavailable";
  }
  try {
    await validatePiSessionFile(manifest.sessionFile, manifest.cwd, manifest.transcriptId);
    return "suspended";
  } catch {
    return "unavailable";
  }
}

export function managedWorkerProcessExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

const delay = (milliseconds: number) => new Promise<void>((resolveDelay) => setTimeout(resolveDelay, milliseconds));

async function ensurePrivateLockDatabase(lockPath: string): Promise<void> {
  try {
    const handle = await open(lockPath, "wx", 0o600);
    await handle.close();
    await syncDirectory(dirname(lockPath));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  const metadata = await lstat(lockPath);
  if (!metadata.isFile() || metadata.isSymbolicLink()
    || (typeof process.getuid === "function" && metadata.uid !== process.getuid())) {
    throw new Error("Runtime lifecycle lock database is redirected or not owned by this user");
  }
  if (process.platform !== "win32" && (metadata.mode & 0o077) !== 0) await chmod(lockPath, 0o600);
}

function isSqliteBusy(error: unknown): boolean {
  const errcode = (error as { errcode?: unknown } | null)?.errcode;
  return typeof errcode === "number" && (errcode & 0xff) === 5;
}

async function acquireProcessLock(lockPath: string): Promise<() => Promise<void>> {
  let DatabaseSync: typeof import("node:sqlite").DatabaseSync;
  try {
    ({ DatabaseSync } = await import("node:sqlite"));
  } catch {
    throw new Error("Managed Pi session lifecycle requires Node.js 22.5 or newer for crash-safe cross-process locks");
  }
  await ensurePrivateLockDatabase(lockPath);
  const database = new DatabaseSync(lockPath);
  database.exec("PRAGMA busy_timeout = 0");
  const deadline = Date.now() + 60_000;
  try {
    while (Date.now() < deadline) {
      try {
        database.exec("BEGIN IMMEDIATE");
        return async () => {
          try {
            database.exec("ROLLBACK");
          } finally {
            database.close();
          }
        };
      } catch (error) {
        if (!isSqliteBusy(error)) throw error;
        await delay(25);
      }
    }
    throw new ManagedSessionBusyError("Runtime-managed session lifecycle operation is already in progress");
  } catch (error) {
    database.close();
    throw error;
  }
}

export async function withManagedSessionLock<T>(
  managedSessionId: string,
  ownerId: string,
  operation: () => Promise<T>,
): Promise<T> {
  validateManagedSessionIdentity(managedSessionId, ownerId);
  await ensurePrivateDirectory(managedRoot());
  await ensurePrivateDirectory(ownerDirectory(ownerId));
  const lockPath = join(ownerDirectory(ownerId), `.lifecycle-${managedSessionId}.sqlite`);
  const previous = processLocks.get(lockPath) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolveGate) => { release = resolveGate; });
  const queued = previous.then(() => gate);
  processLocks.set(lockPath, queued);
  await previous;
  try {
    const releaseFileLock = await acquireProcessLock(lockPath);
    try {
      return await operation();
    } finally {
      await releaseFileLock();
    }
  } finally {
    release();
    if (processLocks.get(lockPath) === queued) processLocks.delete(lockPath);
  }
}
