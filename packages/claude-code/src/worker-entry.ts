import { randomBytes } from "node:crypto";
import { realpath } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import type { ClaudeCodeRuntimeOptions } from "./client.js";
import { createClaudeCodeManagedSession, type ClaudeCodeManagedSessionHandle } from "./managed-session.js";
import { ClaudeCodeManagedStore, type ClaudeCodeManagedManifest } from "./managed-store.js";
import { CLAUDE_CODE_FORBIDDEN_ENV } from "./native-config.js";
import { createClaudeCodeWorkerBridge } from "./worker-bridge.js";
import { encodeClaudeCodeWorkerRegistration, type ClaudeCodeWorkerRegistrationScope } from "./worker-registration.js";

export const CLAUDE_CODE_BOOTSTRAP_MAX_BYTES = 64 * 1024;
/** `env` only OVERLAYS the worker's inherited process environment (never replaces it). */
type NativeOptions = Omit<ClaudeCodeRuntimeOptions, "tools" | "canUseTool" | "env"> & { env?: Record<string, string> };
/** Private IPC only. Not launch authority, a public API or serializable manifest data. */
export interface ClaudeCodeWorkerBootstrap {
  version: 1;
  type: "bootstrap";
  storeRoot: string;
  scope: ClaudeCodeWorkerRegistrationScope;
  nativeOptions: NativeOptions;
  /** Bounds publication observation, not native initialization (which has its own deadline). */
  publicationTimeoutMs?: number;
}
const failed = () => new Error("Claude Code worker bootstrap unavailable");
function object(value: unknown, allowed: string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(key => !allowed.includes(key))) throw failed();
  return value as Record<string, unknown>;
}
function path(value: unknown): value is string {
  return typeof value === "string" && !value.includes("\0") && isAbsolute(value) && resolve(value) === value
    && Buffer.byteLength(value) <= 4096 && Buffer.from(value).toString() === value;
}
/** Shared private-frame validation; also used before the producer mutates launch state. */
export function decodeClaudeCodeWorkerBootstrap(message: unknown): ClaudeCodeWorkerBootstrap {
  if (typeof message !== "string" || Buffer.byteLength(message) > CLAUDE_CODE_BOOTSTRAP_MAX_BYTES) throw failed();
  const data = object(JSON.parse(message), ["version", "type", "storeRoot", "scope", "nativeOptions", "publicationTimeoutMs"]);
  if (data.version !== 1 || data.type !== "bootstrap" || !path(data.storeRoot)) throw failed();
  const scope = object(data.scope, ["sessionId", "ownerId", "generation", "reservationId", "workerExecutable", "cwd", "nativeConfigRoot"]);
  if (![scope.sessionId, scope.ownerId, scope.generation, scope.reservationId].every(value => typeof value === "string")
    || ![scope.workerExecutable, scope.cwd, scope.nativeConfigRoot].every(path)) throw failed();
  const options = object(data.nativeOptions, ["env", "executable", "startupTimeoutMs", "controlTimeoutMs", "shutdownTimeoutMs", "turnRetentionLimit", "eventBufferLimit"]);
  if (options.env !== undefined && (!options.env || typeof options.env !== "object" || Array.isArray(options.env)
    || CLAUDE_CODE_FORBIDDEN_ENV.some(key => (options.env as Record<string, unknown>)[key] !== undefined)
    || Object.entries(options.env).some(([key, value]) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)
      || typeof value !== "string" || value.includes("\0") || Buffer.from(value).toString() !== value))
    || (options.executable !== undefined && !path(options.executable))) throw failed();
  for (const key of ["startupTimeoutMs", "controlTimeoutMs", "shutdownTimeoutMs", "turnRetentionLimit", "eventBufferLimit"]) {
    // Match the managed facade's ceilings before the producer reserves or forks.
    const maximum = key === "turnRetentionLimit" ? 1_000 : key === "eventBufferLimit" ? 4_096 : 2_147_483_647;
    if (options[key] !== undefined && (!Number.isSafeInteger(options[key]) || Number(options[key]) < 1 || Number(options[key]) > maximum)) throw failed();
  }
  if (data.publicationTimeoutMs !== undefined && (!Number.isSafeInteger(data.publicationTimeoutMs)
    || Number(data.publicationTimeoutMs) < 1 || Number(data.publicationTimeoutMs) > 30_000)) throw failed();
  return data as unknown as ClaudeCodeWorkerBootstrap;
}
function notify(message: object): void {
  // Losing this private hint never changes adoption or authorizes cleanup/retry.
  try { if (process.connected) process.send?.(message, () => {}); } catch { /* Hint only. */ }
}
function receive(): Promise<ClaudeCodeWorkerBootstrap> {
  return new Promise((done, reject) => {
    const cleanup = () => { clearTimeout(timer); process.off("message", message); process.off("disconnect", disconnected); };
    const disconnected = () => { cleanup(); reject(failed()); };
    const message = (value: unknown) => {
      cleanup();
      try { done(decodeClaudeCodeWorkerBootstrap(value)); } catch { reject(failed()); }
    };
    const timer = setTimeout(disconnected, 10_000);
    process.once("message", message); process.once("disconnect", disconnected);
    notify({ version: 1, type: "bootstrap_required" });
  });
}
function currentScope(manifest: ClaudeCodeManagedManifest | undefined, scope: ClaudeCodeWorkerRegistrationScope): boolean {
  return !!manifest && manifest.id === scope.sessionId && manifest.ownerId === scope.ownerId
    && manifest.generation === scope.generation && !manifest.requiresExplicitResume
    && manifest.launchConfig.cwd === scope.cwd && manifest.policy.nativeConfigRoot === scope.nativeConfigRoot
    && manifest.worker.state !== "none" && manifest.worker.generation === scope.generation
    && manifest.worker.reservationId === scope.reservationId && manifest.worker.workerExecutable === scope.workerExecutable;
}

/** Internal entry composition only. The parent must commit starting BEFORE fork and record
 * the actual ChildProcess PID/group BEFORE sending bootstrap. No producer, abort authority,
 * physical exit/group proof, recovery, public routing or metadata mutation is supplied here.
 * The returned handle is privileged LOCAL self-cleanup, never exposed over private IPC/HTTP. */
export async function runClaudeCodeWorkerEntry(): Promise<ClaudeCodeManagedSessionHandle> {
  if (!process.send || !process.connected || ![2, 8].includes(process.argv.length) || process.execArgv.length
    || process.env.NODE_OPTIONS !== undefined || process.env.NODE_PATH !== undefined) throw failed();
  const bootstrap = await receive();
  const { scope } = bootstrap;
  if (await realpath(process.argv[1]) !== scope.workerExecutable || await realpath(process.cwd()) !== scope.cwd) throw failed();
  // Marked launches (argv of 8) must carry exactly this scope's identity; legacy launches carry none.
  if (process.argv.length === 8 && process.argv.slice(2).join("\0") !== ["--minu-runtime-session", scope.sessionId,
    "--minu-runtime-owner", scope.ownerId, "--minu-runtime-generation", scope.generation].join("\0")) throw failed();
  const store = new ClaudeCodeManagedStore(bootstrap.storeRoot);
  const initial = await store.read(scope.sessionId, scope.ownerId);
  if (!currentScope(initial, scope) || initial!.worker.state !== "starting" || initial!.worker.process?.pid !== process.pid) throw failed();
  const group = initial!.worker.process.processGroupId;
  const handle = createClaudeCodeManagedSession({ store, scope, nativeOptions: bootstrap.nativeOptions });
  let ready = false;
  const bridge = await createClaudeCodeWorkerBridge({ ...scope, token: randomBytes(32).toString("hex"),
    runtime: handle.runtime, nativeSessionId: scope.sessionId,
    admit: operation => {
      if (!ready) return Promise.reject(failed());
      return handle.admit(operation);
    } });
  // Only fresh isolated workers opt into healthy self-retirement. Legacy null
  // groups retain the native-stop-only behavior; no metadata is cleared here.
  if (group === process.pid) void bridge.idleQuiesced.then(async () => {
    ready = false;
    await bridge.close();
    await handle.closeOwnedNative(); // Privileged captured cleanup, outside admission.
    process.exit(0);
  }).catch(() => { ready = false; notify({ version: 1, type: "unavailable" }); });
  // Recovery stop (own group only): tear down native, then exit; if teardown fails, end the whole own group so
  // no native writer outlives the worker. The controller still proves absence independently.
  if (group === process.pid) void bridge.forceStopped.then(async () => {
    ready = false;
    const backstop = setTimeout(() => { try { process.kill(-process.pid, "SIGKILL"); } catch { process.exit(1); } }, 4_000);
    try { await bridge.close(); await handle.closeOwnedNative(); }
    catch { try { process.kill(-process.pid, "SIGKILL"); } catch { /* Controller TERM/KILL path remains. */ } }
    clearTimeout(backstop); process.exit(0);
  });
  const bytes = encodeClaudeCodeWorkerRegistration({ version: 1, runtime: "claude-code", ownership: "owned", ...scope,
    pid: process.pid, processGroupId: group, endpoint: bridge.connection.endpoint, token: bridge.connection.token,
    createdAt: new Date().toISOString() }, scope);
  const registration = Buffer.from(bytes).toString("utf8");
  notify({ version: 1, type: "prepared", registration });
  // Only publication, not an activation packet/ACK or IPC liveness, can activate.
  // The listener stays unavailable after timeout/failure. Never self-exit or clear an
  // uncertain/adopted attempt merely because the original creator disconnected.
  const activate = async () => {
    const end = performance.now() + (bootstrap.publicationTimeoutMs ?? 10_000);
    while (true) {
      if (performance.now() >= end) throw failed();
      const manifest = await store.read(scope.sessionId, scope.ownerId);
      if (performance.now() >= end || !currentScope(manifest, scope)) throw failed();
      const worker = manifest!.worker;
      if (worker.state === "live") {
        const published = encodeClaudeCodeWorkerRegistration(worker.registration, scope);
        if (!Buffer.from(published).equals(bytes)) throw failed();
        // initialize performs the authoritative admission check across this read/act race.
        await handle.initialize(bytes);
        if (await handle.admit(() => handle.runtime.status(scope.sessionId)) !== "idle") throw failed();
        ready = true;
        notify({ version: 1, type: "ready", registration });
        return;
      }
      if (worker.state !== "starting" || worker.process?.pid !== process.pid || worker.process.processGroupId !== group) throw failed();
      await delay(Math.min(25, Math.max(1, end - performance.now())));
    }
  };
  void activate().catch(() => { notify({ version: 1, type: "unavailable" }); });
  return handle;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  void runClaudeCodeWorkerEntry().catch(() => {
    notify({ version: 1, type: "unavailable" });
    // Setup failed before any initialization/native launch was permitted. Once a
    // candidate is handed off, activate handles failure conservatively without exit.
    process.exit(1);
  });
}
