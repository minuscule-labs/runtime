// A stream-json protocol peer for the real SDK. No provider calls or native tools.
import { createInterface } from "node:readline";
import { appendFileSync, writeFileSync } from "node:fs";

const mode = process.env.MINU_CLAUDE_FIXTURE_MODE;
if (process.env.MINU_CLAUDE_FIXTURE_PID) writeFileSync(process.env.MINU_CLAUDE_FIXTURE_PID, String(process.pid));
if (process.env.MINU_CLAUDE_FIXTURE_PROJECT_DIR) writeFileSync(process.env.MINU_CLAUDE_FIXTURE_PROJECT_DIR, process.env.CLAUDE_CODE_PROJECT_DIR_NAME ?? "<default>");
let current: any;
let pendingPermission: any;
const output = (value: unknown) => process.stdout.write(`${JSON.stringify(value)}\n`);
const base = () => ({ session_id: current.session_id, uuid: crypto.randomUUID() });
function result(text: string, extra: Record<string, unknown> = {}) {
  output({ ...base(), type: "result", subtype: "success", is_error: false,
    result: text, user_message_uuid: current.uuid, ...extra });
}
function assistant(content: unknown[], parent: string | null = null) {
  output({ ...base(), type: "assistant", parent_tool_use_id: parent, message: { role: "assistant", content } });
}
const lines = createInterface({ input: process.stdin });
lines.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.type === "control_response" && process.env.MINU_CLAUDE_FIXTURE_REPLIES) {
    appendFileSync(process.env.MINU_CLAUDE_FIXTURE_REPLIES, JSON.stringify({
      subtype: message.response?.subtype, behavior: message.response?.response?.behavior,
    }) + "\n", { mode: 0o600 });
  }
  if (message.type === "control_request") {
    const request = message.request;
    if (request.subtype === "initialize" && mode === "startup-hang") return;
    if (request.subtype === "initialize" && mode === "startup-exit") process.exit(2);
    if (request.subtype === "interrupt" && mode === "interrupt-hang") return;
    output({ type: "control_response", response: { subtype: "success", request_id: message.request_id,
      response: request.subtype === "initialize" ? { commands: [], agents: [], models: [], account: {}, output_style: "default", available_output_styles: [],
        claude_code_version: process.env.MINU_CLAUDE_FIXTURE_VERSION ?? "2.1.321" } : {} } });
    if (request.subtype === "interrupt" && mode !== "interrupt-no-result") {
      setTimeout(() => result("interrupted", { subtype: "error_during_execution", is_error: true, errors: ["interrupted"] }), 20);
    }
    return;
  }
  if (message.type === "control_response" && pendingPermission) {
    const response = message.response.response;
    if (pendingPermission === "elicitation") result(response?.action === "decline" ? "elicitation declined" : "unexpected elicitation answer",
      { is_error: response?.action !== "decline" });
    else result(response?.behavior === "allow" ? "allowed" : "denied");
    pendingPermission = undefined;
    return;
  }
  if (message.type !== "user") return;
  current = message;
  const input = typeof message.message.content === "string" ? message.message.content : message.message.content[0].text;
  if (process.env.MINU_CLAUDE_FIXTURE_INPUT) writeFileSync(process.env.MINU_CLAUDE_FIXTURE_INPUT, input);
  output({ ...base(), type: "system", subtype: "init", permissionMode: "default",
    cwd: mode === "wrong-workspace-init" ? "/" : process.cwd(), model: "fixture-model", claude_code_version: "2.1.321" });
  if (input === "hold") return;
  if (input === "crash") process.exit(3);
  if (input === "wrong-session") { result("wrong", { session_id: crypto.randomUUID() }); return; }
  if (input === "wrong-turn") { result("wrong", { user_message_uuid: crypto.randomUUID() }); return; }
  if (input === "fail") { result("private error should not escape", { is_error: true }); return; }
  if (input === "malformed-result") { result(123 as unknown as string); return; }
  if (input.startsWith("user-dialog:")) {
    pendingPermission = true;
    output({ type: "control_request", request_id: crypto.randomUUID(), request: {
      subtype: "request_user_dialog", dialog_kind: input.slice("user-dialog:".length),
      payload: { question: "PRIVATE_DIALOG_QUESTION", choices: ["PRIVATE_DIALOG_CHOICE"] },
    } });
    return;
  }
  if (input === "elicitation") {
    pendingPermission = "elicitation";
    output({ type: "control_request", request_id: crypto.randomUUID(), request: {
      subtype: "elicitation", mcp_server_name: "fixture", mode: "form", message: "PRIVATE_ELICITATION_QUESTION",
      requested_schema: { type: "object", properties: { answer: { type: "string" } } },
    } });
    return;
  }
  if (input === "permission" || input === "permission-cancel") {
    pendingPermission = true;
    const requestId = crypto.randomUUID();
    output({ type: "control_request", request_id: requestId, request: {
      subtype: "can_use_tool", tool_name: "Write", input: { file_path: "fixture-only", content: "test" }, tool_use_id: "write-1",
    } });
    if (input === "permission-cancel") setTimeout(() => {
      pendingPermission = undefined; // The native request was withdrawn; late replies cannot settle it.
      output({ type: "control_cancel_request", request_id: requestId });
    }, 30);
    return;
  }
  if (input === "tool") {
    output({ ...base(), type: "stream_event", parent_tool_use_id: null,
      event: { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "tool-1", name: "Read", input: {} } } });
    assistant([{ type: "tool_use", id: "tool-1", name: "Read", input: { file_path: "private-path" } }]);
    output({ ...base(), type: "user", parent_tool_use_id: null, message: { role: "user", content: [
      { type: "tool_result", tool_use_id: "tool-1", content: [{ type: "text", text: "file contents" }, { type: "image", source: { data: "private-pixels" } }] },
    ] } });
    assistant([{ type: "text", text: "private subagent text" }], "tool-1");
  }
  const answer = `reply: ${input}`;
  const count = input === "worker-burst" ? 1024 : input === "burst" ? 20 : 1;
  const delta = input === "worker-burst" ? "x".repeat(16 * 1024) : answer;
  for (let n = 0; n < count; n++) output({ ...base(), type: "stream_event", parent_tool_use_id: null,
    event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: delta } } });
  output({ ...base(), type: "stream_event", parent_tool_use_id: null,
    event: { type: "content_block_delta", index: 1, delta: { type: "thinking_delta", thinking: "private reasoning" } } });
  assistant([{ type: "text", text: answer }]);
  result(answer);
});
lines.on("close", () => process.exit(0));
