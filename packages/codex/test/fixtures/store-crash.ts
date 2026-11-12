import { createRequire, syncBuiltinESMExports } from "node:module";
import type { CodexManagedManifest } from "../../src/managed-store.js";

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
const { CodexManagedStore } = await import("../../src/managed-store.js");
const manifest = JSON.parse(json) as CodexManagedManifest;
const store = new CodexManagedStore(root);
if (mode === "update") await store.update(manifest.id, manifest.ownerId, manifest.revision, { generation: "generation-b" });
else await store.create(manifest);
throw new Error("Expected publication pause");
