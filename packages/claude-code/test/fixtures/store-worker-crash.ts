import { createRequire, syncBuiltinESMExports } from "node:module";
import type { ClaudeCodeManagedManifest } from "../../src/managed-store.js";
import type { ClaudeCodeWorkerRegistration } from "../../src/worker-registration.js";

// Separate-process fault injection only. No native workers are launched/signalled here.
const require = createRequire(import.meta.url);
const fs = require("node:fs/promises") as typeof import("node:fs/promises");
const rename = fs.rename;
const [root, json, point, operation, encodedRegistration] = process.argv.slice(2);
const pause = async () => {
  process.on("message", () => {});
  process.send?.({ point });
  await new Promise<void>(() => {});
};
fs.rename = async (...args) => {
  if (point === "before-rename") await pause();
  await rename(...args);
  if (point === "after-rename") await pause();
};
syncBuiltinESMExports();
const { ClaudeCodeManagedStore } = await import("../../src/managed-store.js");
const { encodeClaudeCodeWorkerRegistration } = await import("../../src/worker-registration.js");
const manifest = JSON.parse(json) as ClaudeCodeManagedManifest;
const registration = JSON.parse(encodedRegistration) as ClaudeCodeWorkerRegistration;
const scope = { sessionId: manifest.id, ownerId: manifest.ownerId, generation: manifest.generation,
  reservationId: registration.reservationId, workerExecutable: registration.workerExecutable,
  cwd: manifest.launchConfig.cwd, nativeConfigRoot: manifest.policy.nativeConfigRoot };
const store = new ClaudeCodeManagedStore(root);
await store.withSessionLock(manifest.id, manifest.ownerId, lease => {
  const { revision, generation } = manifest, { reservationId, workerExecutable, pid, processGroupId } = registration;
  switch (operation) {
    case "reserve": return lease.reserveWorker(revision, generation, reservationId, workerExecutable);
    case "begin": return lease.beginWorkerStart(revision, generation, reservationId);
    case "process": return lease.recordWorkerProcess(revision, generation, reservationId, pid, processGroupId);
    case "publish": return lease.publishWorker(revision, generation, reservationId, encodeClaudeCodeWorkerRegistration(registration, scope));
    case "clear": return lease.clearWorkerAfterExit(revision, generation, reservationId, pid);
    default: throw new Error("Invalid test operation");
  }
});
throw new Error("Expected publication pause");
