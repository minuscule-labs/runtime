// Test-only private disposal, independent of creator IPC (including disconnect).
// Not a production abort/stop route or permission to clear adopted metadata.
import { createInterface } from "node:readline";
import { runClaudeCodeWorkerEntry } from "../../src/worker-entry.js";

const worker = runClaudeCodeWorkerEntry();
void worker.catch(() => { if (process.connected) process.send?.({ version: 1, type: "unavailable" }, () => {}); });
createInterface({ input: process.stdin }).once("line", async line => {
  if (line !== "dispose-owned-fixture") return;
  try { await (await worker.catch(() => undefined))?.closeOwnedNative(); process.exit(0); }
  catch { process.exit(2); } // Parent must separately check the captured native child exited.
});
