#!/usr/bin/env node
// Synthetic native RPC peer. No model, provider, authentication or tool execution.
import { appendFileSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";

const sessionId = randomUUID();
writeFileSync("native-meta.json", JSON.stringify({ pid: process.pid, sessionId, args: process.argv.slice(2) }));
const messages = [];
const output = (...frames) => process.stdout.write(frames.map(frame => JSON.stringify(frame)).join("\n") + "\n");
createInterface({ input: process.stdin }).on("line", line => {
  appendFileSync("native-input.jsonl", line + "\n");
  const r = JSON.parse(line);
  const response = data => ({ type: "response", id: r.id, command: r.type, success: true, data });
  if (r.type === "get_state") output(response({ sessionId, isStreaming: false }));
  else if (r.type === "get_messages") output(response({ messages }));
  else if (r.type === "prompt") {
    output(response({ disposition: "started" }), { type: "agent_start" });
    if (r.message === "hold") return;
    if (r.message === "question" || r.message === "unknown") {
      output({ type: "extension_ui_request", id: "native-question",
        method: r.message === "question" ? "confirm" : "future-dialog",
        title: "PRIVATE_DIALOG_QUESTION", message: "PRIVATE_DIALOG_QUESTION" },
      { type: "agent_settled" }); // Refusal must fence this already-buffered settlement.
      return;
    }
    messages.push({ role: "user", content: r.message, timestamp: Date.now() },
      { role: "assistant", content: [{ type: "text", text: "native answer" }], timestamp: Date.now() });
    output({ type: "extension_ui_request", id: "native-notice", method: "notify", message: "notice" },
      { type: "tool_execution_start", toolCallId: "read-1", toolName: "Read" },
      { type: "tool_execution_end", toolCallId: "read-1", toolName: "Read", isError: false },
      { type: "agent_settled" });
  } else output(response({}));
});
