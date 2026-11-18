// Controlled producer-protocol peer only: never native/SDK work or descendants.
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { ClaudeCodeManagedStore } from "../../src/managed-store.js";
import { encodeClaudeCodeWorkerRegistration } from "../../src/worker-registration.js";

createInterface({ input: process.stdin }).once("line", line => { if (line === "dispose-owned-fixture") process.exit(0); });
process.send?.({ version: 1, type: "bootstrap_required" });
process.once("message", async value => {
  const frame = JSON.parse(value as string), scope = frame.scope;
  const manifest = await new ClaudeCodeManagedStore(frame.storeRoot).read(scope.sessionId, scope.ownerId);
  await writeFile(join(process.env.HOME!, "peer-observed.json"), JSON.stringify({ manifest,
    environment: process.env, argv: process.argv, execArgv: process.execArgv }), { mode: 0o600 });
  const mode = frame.nativeOptions.env.MINU_PRODUCER_PEER;
  if (mode === "hang") return;
  if (mode === "ready-only") { process.send?.({ version: 1, type: "ready" }); return; }
  if (mode === "oversized") { process.send?.({ version: 1, type: "prepared", registration: "x".repeat(16_385) }); return; }
  if (mode === "wrong-scope") scope.ownerId = "other-owner";
  const pid = mode === "wrong-pid" ? process.pid + 1 : process.pid;
  const registration = encodeClaudeCodeWorkerRegistration({ version: 1, runtime: "claude-code", ownership: "owned", ...scope,
    pid, processGroupId: mode === "wrong-group" ? null : pid,
    endpoint: "http://127.0.0.1:1", token: "a".repeat(64), createdAt: new Date().toISOString() }, scope);
  process.send?.({ version: 1, type: "prepared", registration: Buffer.from(registration).toString("utf8") });
});
