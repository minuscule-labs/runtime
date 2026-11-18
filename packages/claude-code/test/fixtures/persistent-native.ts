// Test-only stream-json SDK peer with the pinned linear persistence subset.
// Never calls a provider. Materializes rows BEFORE forwarding success, not a
// claim about the bundled engine's persistence contract (covered separately).
import { createRequire, syncBuiltinESMExports } from "node:module";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { claudeCodeNativeProjectKey } from "../../src/native-history.js";
const readline = createRequire(import.meta.url)("node:readline") as typeof import("node:readline");
const create = readline.createInterface;
let sessionId: string, path: string, parent: string | null = null, input = "";
function save(row: Record<string, unknown>) { appendFileSync(path, JSON.stringify(row) + "\n", { mode: 0o600 }); }
function chain(type: string, message: unknown, uuid = randomUUID()) {
  save({ type, message, uuid, parentUuid: parent, isSidechain: false, sessionId, cwd: process.cwd(), version: "2.1.321", timestamp: new Date().toISOString() });
  parent = uuid;
}
readline.createInterface = ((...args: Parameters<typeof create>) => {
  const lines = create(...args);
  const emit = lines.emit;
  lines.emit = function(this: typeof lines, event: string, ...values: any[]) {
    if (event === "line" && process.env.MINU_PERSIST_INIT_DELAY_MS) {
      const message = JSON.parse(values[0]);
      if (message.type === "control_request" && message.request?.subtype === "initialize") {
        setTimeout(() => (emit as Function).call(this, event, ...values), Number(process.env.MINU_PERSIST_INIT_DELAY_MS)); return true;
      }
    }
    return (emit as Function).call(this, event, ...values);
  } as typeof emit;
  lines.prependListener("line", line => {
    const m = JSON.parse(line);
    if (m.type !== "user") return;
    sessionId = m.session_id; input = m.message.content;
    const directory = join(process.env.CLAUDE_CONFIG_DIR!, "projects", claudeCodeNativeProjectKey(process.cwd()));
    mkdirSync(directory, { recursive: true, mode: 0o700 }); path = join(directory, sessionId + ".jsonl");
    if (existsSync(path)) {
      const rows = readFileSync(path, "utf8").trimEnd().split("\n").map(line => JSON.parse(line));
      parent = rows.filter(row => ["user", "assistant", "attachment"].includes(row.type)).at(-1)?.uuid ?? null;
    }
    chain("user", m.message, m.uuid);
  });
  return lines;
}) as typeof create;
syncBuiltinESMExports();
const write = process.stdout.write.bind(process.stdout);
process.stdout.write = ((chunk: string | Uint8Array, ...args: any[]) => {
  for (const line of chunk.toString().trimEnd().split("\n")) if (line) {
    const m = JSON.parse(line);
    if (m.type === "assistant" && !m.parent_tool_use_id && process.env.MINU_PERSIST_DROP_FINAL !== "1") chain("assistant", { ...m.message, stop_reason: "end_turn" });
    if (m.type === "result" && !m.is_error && process.env.MINU_PERSIST_DROP_FINAL !== "1") save({ type: "last-prompt", lastPrompt: input, leafUuid: parent, sessionId });
  }
  return (write as Function)(chunk, ...args);
}) as typeof process.stdout.write;
await import("./claude.js");
