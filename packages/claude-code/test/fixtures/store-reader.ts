import { createRequire, syncBuiltinESMExports } from "node:module";

const require = createRequire(import.meta.url);
const fs = require("node:fs/promises") as typeof import("node:fs/promises");
const originalOpen = fs.open;
fs.open = async (...args) => {
  const handle = await originalOpen(...args);
  if (String(args[0]).endsWith("/manifest.json")) {
    const resume = new Promise<void>(resolve => process.once("message", () => resolve()));
    process.send?.({ type: "pinned" });
    await resume;
  }
  return handle;
};
syncBuiltinESMExports();
const { ClaudeCodeManagedStore } = await import("../../src/managed-store.js");
const [root, id, ownerId] = process.argv.slice(2);
const manifest = await new ClaudeCodeManagedStore(root).read(id, ownerId);
process.send?.({ type: "read", manifest }, () => process.disconnect());
