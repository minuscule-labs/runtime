import { createRequire, syncBuiltinESMExports } from "node:module";
import { fileURLToPath } from "node:url";

// Separate-process fault injection: production exposes no publication test hooks.
const [root, id, ownerId, generation, logPath, point] = process.argv.slice(2);
const require = createRequire(import.meta.url);
const fs = require("node:fs/promises") as typeof import("node:fs/promises");
const originalRename = fs.rename;
async function pause(): Promise<void> {
  process.on("message", () => {});
  process.send?.({ type: "paused", point });
  await new Promise<void>(() => {});
}
fs.rename = async (...args) => {
  let state: string | undefined;
  if (String(args[1]).endsWith("/manifest.json")) {
    state = JSON.parse(await fs.readFile(String(args[0]), "utf8")).native.state;
  }
  if (state === "bound" && point === "before-binding") await pause();
  if (state === "bound" && point === "binding-failure") throw new Error("Injected binding publication failure");
  await originalRename(...args);
  if (state === "creating" && point === "after-intent") await pause();
  if (state === "bound" && point === "after-binding") await pause();
  if (state === "bound" && point === "post-binding-failure") throw new Error("Injected post-publication failure");
};
syncBuiltinESMExports();
const { CodexManagedStore } = await import("../../src/managed-store.js");
const { allocatePendingCodexThread } = await import("../../src/managed-native.js");
try {
  const allocation = await allocatePendingCodexThread(new CodexManagedStore(root), { id, ownerId, generation }, {
    command: process.execPath,
    args: [fileURLToPath(new URL("./app-server.js", import.meta.url)), "normal", logPath],
    requestTimeoutMs: 1_000, shutdownTimeoutMs: 100,
  });
  await allocation.runtime.stop(allocation.session.id);
  process.send?.({ type: "allocated" }, () => process.disconnect());
} catch {
  process.send?.({ type: "failed" }, () => process.disconnect());
}
