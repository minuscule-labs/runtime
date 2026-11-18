import { fork, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { ClaudeCodeManagedStore } from "./managed-store.js";
import { decodeClaudeCodeWorkerBootstrap, type ClaudeCodeWorkerBootstrap } from "./worker-entry.js";
import {
  CLAUDE_CODE_WORKER_REGISTRATION_MAX_BYTES, decodeClaudeCodeWorkerRegistration, encodeClaudeCodeWorkerRegistration,
  type ClaudeCodeWorkerRegistrationScope,
} from "./worker-registration.js";

export interface ClaudeCodeWorkerLaunchOptions {
  storeRoot: string;
  sessionId: string;
  ownerId: string;
  nativeOptions: ClaudeCodeWorkerBootstrap["nativeOptions"];
  /** Trusted host entry/interpreter, never user/tool-selected executables. */
  workerExecutable?: string;
  nodeExecutable?: string;
  /** Bounds IPC preparation/publication eligibility, not readiness or OS filesystem calls. */
  preparationTimeoutMs?: number;
  publicationTimeoutMs?: number;
}
export interface ClaudeCodeWorkerLaunchAttempt {
  /** Unavailable includes UNKNOWN adoption, not permission to retry, clear or kill. */
  state: "adopted" | "unavailable";
  scope: ClaudeCodeWorkerRegistrationScope;
  /** Private canonical candidate bytes, not a readiness or process-control grant. */
  registration?: Uint8Array;
  /** Retained local process object, not recovered PID/group authority. */
  child?: ChildProcess;
}
const unavailable = () => new Error("Claude Code worker launch unavailable");

/** Internal known-child launch/publication only. No discovery, readiness supervision,
 * abort/clear/signals, automatic retries or public managed API. Every outcome retains
 * durable uncertainty. Fresh POSIX groups rely on the documented trusted native-
 * family contract, not OS containment. Exit must be established elsewhere. */
export async function launchClaudeCodeWorker(options: ClaudeCodeWorkerLaunchOptions): Promise<ClaudeCodeWorkerLaunchAttempt> {
  let scope: ClaudeCodeWorkerRegistrationScope | undefined, child: ChildProcess | undefined, bytes: Uint8Array | undefined;
  let adopted = false, removeMessages = () => {};
  let store: ClaudeCodeManagedStore | undefined;
  try {
    // Windows detached children do not establish the required POSIX process group.
    if (process.platform === "win32") throw unavailable();
    // Snapshot private host configuration before the first await. Functions cannot
    // cross this boundary; never silently JSON-drop a permission callback.
    const nativeOptions = structuredClone(options.nativeOptions);
    const { storeRoot, sessionId, ownerId, publicationTimeoutMs } = options;
    // Do not let a missing explicit root select the store constructor's host default.
    if (typeof storeRoot !== "string") throw unavailable();
    const timeout = options.preparationTimeoutMs ?? 5_000;
    if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 30_000) throw unavailable();
    const entryInput = options.workerExecutable ?? fileURLToPath(new URL("./worker-entry.js", import.meta.url));
    const nodeInput = options.nodeExecutable ?? process.execPath;
    const workerExecutable = await realpath(entryInput), nodeExecutable = await realpath(nodeInput);
    store = new ClaudeCodeManagedStore(storeRoot);
    await store.withSessionLock(sessionId, ownerId, async lease => {
      let manifest = await store!.read(sessionId, ownerId);
      if (!manifest || await realpath(manifest.launchConfig.cwd) !== manifest.launchConfig.cwd) throw unavailable();
      const expected: ClaudeCodeWorkerRegistrationScope = { sessionId, ownerId, generation: manifest.generation,
        reservationId: randomUUID(), workerExecutable, cwd: manifest.launchConfig.cwd, nativeConfigRoot: manifest.policy.nativeConfigRoot };
      const frame = JSON.stringify({ version: 1, type: "bootstrap", scope: expected, storeRoot, nativeOptions, publicationTimeoutMs });
      const validated = decodeClaudeCodeWorkerBootstrap(frame); // Before reservation/fork, including size/env/options validation.
      scope = expected;
      manifest = await lease.reserveWorker(manifest.revision, expected.generation, expected.reservationId, workerExecutable);
      manifest = await lease.beginWorkerStart(manifest.revision, expected.generation, expected.reservationId);
      const end = performance.now() + timeout;
      // Only startup essentials enter the worker environment. Provider auth/config
      // remains in the private frame; never inherit process.env or Node preloads.
      const env: NodeJS.ProcessEnv = { CLAUDE_CONFIG_DIR: expected.nativeConfigRoot };
      for (const key of ["PATH", "HOME", "TMPDIR"]) if (validated.nativeOptions.env[key] !== undefined) env[key] = validated.nativeOptions.env[key];
      child = fork(workerExecutable, [], { cwd: expected.cwd, execPath: nodeExecutable, execArgv: [], env,
        detached: true, stdio: ["pipe", "ignore", "ignore", "ipc"] });
      const known = child;
      let required = false, bootstrapped = false, candidate: string | undefined, failed = false;
      // Keep a non-throwing error listener even after returning the local handle.
      known.on("error", () => { failed = true; });
      known.once("exit", () => { failed = true; });
      const message = (value: unknown) => {
        if (!value || typeof value !== "object" || Array.isArray(value)) { failed = true; return; }
        const data = value as Record<string, unknown>;
        if (data.version !== 1) { failed = true; return; }
        if (data.type === "bootstrap_required" && Object.keys(data).length === 2 && !required) required = true;
        else if (data.type === "prepared" && Object.keys(data).length === 3 && bootstrapped && candidate === undefined
          && typeof data.registration === "string" && Buffer.byteLength(data.registration) <= CLAUDE_CODE_WORKER_REGISTRATION_MAX_BYTES) candidate = data.registration;
        else if (data.type !== "ready") failed = true; // A ready hint never substitutes for candidate validation/adoption.
      };
      known.on("message", message); removeMessages = () => { known.off("message", message); };
      const eligible = () => { if (failed || performance.now() >= end) throw unavailable(); };
      const wait = async (done: () => boolean) => {
        while (true) { eligible(); if (done()) return; await delay(Math.min(10, Math.max(1, end - performance.now()))); }
      };
      if (known.pid === undefined) throw unavailable(); // starting/no PID remains uncertain; never release/reset.
      manifest = await lease.recordWorkerProcess(manifest.revision, expected.generation, expected.reservationId, known.pid, known.pid);
      await wait(() => required);
      let sent = false; bootstrapped = true;
      known.send(frame, error => { if (error) failed = true; sent = true; });
      await wait(() => sent);
      await wait(() => candidate !== undefined);
      const registration = decodeClaudeCodeWorkerRegistration(Buffer.from(candidate!, "utf8"), expected);
      if (registration.pid !== known.pid || registration.processGroupId !== known.pid) throw unavailable();
      bytes = encodeClaudeCodeWorkerRegistration(registration, expected);
      eligible();
      await lease.publishWorker(manifest.revision, expected.generation, expected.reservationId, bytes);
      adopted = true;
      // Release the parent lease BEFORE any child initialization/readiness wait.
    });
  } catch {
    // A successful mutation can lose its return. Re-admit ONLY the frozen candidate
    // to classify current adoption; never repeat publication or infer unadopted.
    if (scope && bytes && store) {
      try { await store.withWorkerAdmission(scope, bytes, async () => { adopted = true; }); } catch { /* Unknown/unavailable. */ }
    }
    if (!scope) throw unavailable(); // Preflight failed, before any launch mutation.
  } finally {
    removeMessages();
    // Creator transport lifetime is not worker lifetime. Disconnect is never a
    // stop/cleanup instruction, including after lost publication confirmation.
    try { if (child?.connected) child.disconnect(); } catch { /* Retain uncertainty. */ }
  }
  return { state: adopted ? "adopted" : "unavailable", scope: { ...scope! },
    ...(bytes ? { registration: new Uint8Array(bytes) } : {}), ...(child ? { child } : {}) };
}
