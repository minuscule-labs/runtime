import { createRequire, syncBuiltinESMExports } from "node:module";
import type { ClaudeCodeManagedManifest } from "../../src/managed-store.js";

// Fault injection stays in a separate process: production has no test hooks.
const require = createRequire(import.meta.url);
const fs = require("node:fs/promises") as typeof import("node:fs/promises");
const rename = fs.rename;
const [root, json, point, mode] = process.argv.slice(2);
const pause = async () => {
  process.on("message", () => {}); // Keep IPC referenced until the parent kills us.
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
const manifest = JSON.parse(json) as ClaudeCodeManagedManifest;
const store = new ClaudeCodeManagedStore(root);
if (mode === "update") await store.update(manifest.id, manifest.ownerId, manifest.revision, { generation: "generation-b" });
else if (mode === "dispatch" || mode === "settle") {
  const identity = { turnId: "turn-a", fingerprint: "a".repeat(64), nativeMessageId: "11111111-1111-4111-8111-111111111111" };
  await store.withSessionLock(manifest.id, manifest.ownerId, lease => mode === "dispatch"
    ? lease.beginDispatch(manifest.revision, manifest.generation, identity)
    : lease.settleDispatch(manifest.revision, manifest.generation, identity, "completed"));
} else await store.create(manifest);
throw new Error("Expected publication pause");
