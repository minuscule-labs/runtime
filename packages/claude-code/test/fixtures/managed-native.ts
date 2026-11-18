// Observe the production store BEFORE the protocol peer handles any user input.
// This is a separate SDK child process; no production test hooks/provider calls.
import { createRequire, syncBuiltinESMExports } from "node:module";
import { appendFileSync, chmodSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
const require = createRequire(import.meta.url);
const readline = require("node:readline") as typeof import("node:readline");
const create = readline.createInterface;
readline.createInterface = ((...args: Parameters<typeof create>) => {
  const lines = create(...args);
  lines.prependListener("line", (line: string) => {
    const message = JSON.parse(line);
    if (message.type === "control_request" && message.request?.subtype === "initialize" && process.env.MINU_CLAUDE_DENY_BINDING === "1") {
      chmodSync(dirname(process.env.MINU_CLAUDE_MANIFEST!), 0o500);
    }
    if (message.type !== "user") return;
    const manifest = JSON.parse(readFileSync(process.env.MINU_CLAUDE_MANIFEST!, "utf8"));
    appendFileSync(process.env.MINU_CLAUDE_TRACE!, JSON.stringify({ native: manifest.native, dispatch: manifest.lastDispatch,
      sessionId: message.session_id, messageId: message.uuid }) + "\n", { mode: 0o600 });
    if (process.env.MINU_CLAUDE_DENY_SETTLEMENT === "1") chmodSync(dirname(process.env.MINU_CLAUDE_MANIFEST!), 0o500);
  });
  return lines;
}) as typeof create;
syncBuiltinESMExports();
await import("./claude.js");
