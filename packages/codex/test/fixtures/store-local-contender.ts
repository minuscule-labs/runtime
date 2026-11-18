import { createRequire, syncBuiltinESMExports } from "node:module";
import type { CodexManagedManifest } from "../../src/managed-store.js";

const require = createRequire(import.meta.url);
const fs = require("node:fs/promises") as typeof import("node:fs/promises");
const originalOpen = fs.open;
const originalRename = fs.rename;
let lockFileOpens = 0;
let resume!: () => void;
fs.open = async (...args) => {
  if (String(args[0]).endsWith(".sqlite")) lockFileOpens++;
  return originalOpen(...args);
};
fs.rename = async (...args) => {
  if (String(args[1]).endsWith("/manifest.json")) {
    const paused = new Promise<void>(resolve => { resume = resolve; });
    process.send?.({ type: "paused" });
    await paused;
  }
  return originalRename(...args);
};
syncBuiltinESMExports();
const { CodexManagedStore } = await import("../../src/managed-store.js");
const [root, json] = process.argv.slice(2);
const manifest = JSON.parse(json) as CodexManagedManifest;
const store = new CodexManagedStore(root);
process.on("message", async command => {
  if (command === "release") { resume(); return; }
  if (command !== "contend" && command !== "contend-alias") return;
  const before = lockFileOpens;
  const started = Date.now();
  try {
    const contenderId = command === "contend-alias" ? manifest.id.toUpperCase() : manifest.id;
    await store.withSessionLock(contenderId, manifest.ownerId, async () => {}, 50);
    process.send?.({ type: "unexpected-entry" });
  } catch (error) {
    process.send?.({ type: "contender-failed", name: error instanceof Error ? error.constructor.name : "Error",
      opens: lockFileOpens - before, elapsed: Date.now() - started });
  }
});
try {
  const next = await store.update(manifest.id, manifest.ownerId, manifest.revision, { generation: "writer-a" });
  process.send?.({ type: "updated", next }, () => process.disconnect());
} catch (error) {
  process.send?.({ type: "failed", name: error instanceof Error ? error.constructor.name : "Error" }, () => process.disconnect());
}
