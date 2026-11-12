import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { RUNTIME_INPUT_LIMITS } from "@minu/runtime-core";

const requested = process.argv[2] ?? "normal";
const persistent = requested.startsWith("lifecycle");
const scenario = persistent ? (requested === "lifecycle" ? "normal" : requested.slice("lifecycle-".length)) : requested;
const steeringHistory = ["steer-history", "steer-history-response"].includes(scenario);
const logPath = process.argv[3];
const historyPath = `${logPath}.history.json`;
let savedTurns: Array<Record<string, unknown>> = persistent && existsSync(historyPath) ? JSON.parse(readFileSync(historyPath, "utf8")) : [];
let pendingInput: unknown = [];
let newThread = false;
let openedModel = "gpt-test";
let modelReads = 0;
function log(value: unknown): void { if (logPath) appendFileSync(logPath, `${JSON.stringify(value)}\n`); }
function emit(value: unknown): void { process.stdout.write(`${JSON.stringify(value)}\n`); }
function notification(method: string, params: unknown): void { emit({ method, params }); }
let initialized = false;
let nativeId = "";
let count = savedTurns.length;
let steerCount = 0;
log({ pid: process.pid, args: process.argv.slice(4) });
if (scenario === "ignore-term" || scenario === "hang-ignore-term") process.on("SIGTERM", () => { log({ signal: "SIGTERM" }); });

function complete(status = "completed", commentaryOnly = false): void {
  const items = [
    { type: "agentMessage", id: `${nativeId}-commentary`, phase: "commentary", text: "Working privately" },
    ...commentaryOnly ? [] : [{ type: "agentMessage", id: `${nativeId}-answer`, phase: "final_answer", text: `Answer ${count}: café 🐈` }],
  ];
  {
    savedTurns.push({ id: nativeId, status, itemsView: "full", items: [
      { id: `${nativeId}-user`, type: "userMessage", content: pendingInput },
      { id: `${nativeId}-tool`, type: "commandExecution", exitCode: 0, aggregatedOutput: "tool output" }, ...items,
    ] });
    if (persistent) writeFileSync(historyPath, JSON.stringify(savedTurns));
  }
  const params = { threadId: "native-thread", turnId: nativeId };
  notification("item/started", { ...params, item: { id: `${nativeId}-tool`, type: "commandExecution" } });
  notification("item/completed", { ...params, item: { id: `${nativeId}-tool`, type: "commandExecution", exitCode: 0, aggregatedOutput: "tool output" } });
  for (const item of items) notification("item/completed", { ...params, item });
  notification("item/agentMessage/delta", { ...params, delta: "Answer delta" });
  // Some native terminal payloads omit items already delivered by item/completed.
  notification("turn/completed", { threadId: "native-thread", turn: { id: nativeId, status, items: [], error: status === "failed" ? { message: "native failure" } : null } });
}

createInterface({ input: process.stdin }).on("line", (line) => {
  const frame = JSON.parse(line) as { id?: string; method?: string; params?: Record<string, unknown> };
  log(frame);
  const { id, method, params = {} } = frame;
  const result = (value: unknown) => emit({ id, result: value });
  if (method === "initialize") {
    if (scenario === "hang" || scenario === "hang-ignore-term") return;
    if (scenario === "invalid-json") { process.stdout.write("not json\n"); return; }
    if (scenario === "large-frame") { process.stdout.write(`${"x".repeat(RUNTIME_INPUT_LIMITS.transportBytes + 1)}\n`); return; }
    result({ userAgent: "fake-codex", platformFamily: "unix", platformOs: "test" });
  } else if (method === "initialized") initialized = true;
  else if (method === "model/list") {
    if (++modelReads > 1 && scenario === "catalog-stall-after-open") return;
    result({ data: scenario === "unknown-model" ? [] : [...new Set([openedModel, "text-model"])].map(model => ({ model, id: model, displayName: model,
      supportedReasoningEfforts: (model === "text-model" ? [] : ["none", "minimal", "low", "medium", "high", "xhigh", "max"]).map(reasoningEffort => ({ reasoningEffort })),
      defaultReasoningEffort: "medium", inputModalities: scenario === "text-only" || model === "text-model" ? ["text"] : ["text", "image"] })), nextCursor: null });
  } else if (method === "skills/list") {
    result({ data: [{ cwd: process.cwd(), errors: [], skills: ["alpha", "beta"].map(name => ({ name, description: `Fixture ${name}`, enabled: true,
      path: `${process.cwd()}/private-skills/${name}/SKILL.md` })) }] });
  } else if (method === "thread/read") {
    if (scenario === "resume-missing") { emit({ id, error: { message: "missing thread" } }); return; }
    result({ thread: {
      id: scenario === "resume-read-id" ? "other-thread" : params.threadId,
      cwd: scenario === "resume-read-cwd" ? `${process.cwd()}/other` : process.cwd(),
      ephemeral: scenario === "resume-read-ephemeral",
      status: { type: scenario === "resume-read-array-status" ? ["idle"] : scenario === "resume-read-active" ? "active" : "notLoaded" },
    } });
  } else if (method === "thread/turns/list") {
    if (persistent || newThread) {
      result({ data: savedTurns, nextCursor: null }); return;
    }
    const page = params.cursor ? Number(String(params.cursor).replace("page-", "")) : 0;
    const items: Record<string, unknown>[] = page === 0 ? [
      { id: "old-user", type: "userMessage", content: [{ type: "text", text: "Prior prompt" }] },
      { id: "old-reasoning", type: "reasoning", text: "Private reasoning" },
      { id: "old-answer", type: "agentMessage", text: "Prior answer", phase: "final_answer" },
    ] : [
      { id: "old-steer", type: "userMessage", content: [{ type: "text", text: "Prior steering" }] },
      { id: "old-tool", type: "commandExecution", aggregatedOutput: "Prior tool output" },
    ];
    const malformed: Record<string, Record<string, unknown>> = {
      "resume-history-assistant-text": { type: "agentMessage", text: 42 },
      "resume-history-assistant-missing": { type: "agentMessage" },
      "resume-history-user-content": { type: "userMessage", content: { type: "text", text: "not an array" } },
      "resume-history-user-text": { type: "userMessage", content: [{ type: "text", text: 42 }] },
      "resume-history-user-part": { type: "userMessage", content: [null] },
      "resume-history-tool-output": { type: "commandExecution", aggregatedOutput: 42 },
      "resume-history-tool-result": { type: "mcpToolCall", tool: "lookup", result: { content: "not an array" } },
      "resume-history-tool-text": { type: "mcpToolCall", tool: "lookup", result: { content: [{ type: "text", text: 42 }] } },
      "resume-history-tool-parts": { type: "dynamicToolCall", tool: "lookup", contentItems: "not an array" },
      "resume-history-dynamic-text": { type: "dynamicToolCall", tool: "lookup", contentItems: [{ type: "inputText", text: 42 }] },
    };
    if (page === 1 && malformed[scenario]) items.push({ id: "bad-supported-item", ...malformed[scenario] });
    if (page === 1 && scenario === "resume-history-unsupported") {
      items.push({ id: "future-private-item", type: "futureNativeItem", text: 42, privateMetadata: "not projected" },
        { id: "image-user", type: "userMessage", content: [{ type: "text", text: "Caption" }, { type: "localImage", path: "/private/image.png" }] },
        { id: "no-output-tool", type: "commandExecution", aggregatedOutput: null },
        { id: "mcp-output", type: "mcpToolCall", tool: "lookup", result: { content: [{ type: "text", text: "MCP text" }, { type: "image", data: "private pixels" }] } });
    }
    if (scenario === "resume-history-items") {
      for (let i = 0; i < 10001; i++) items.push({ id: `item-${i}`, type: "reasoning" });
    }
    result({ data: [{ id: scenario === "resume-history-duplicate" ? "same-turn" : `old-turn-${page}`,
      status: scenario === "resume-history-array-status" ? ["completed"] : scenario === "resume-history-active" ? "inProgress" : "completed",
      itemsView: scenario === "resume-history-summary" ? "summary" : "full", items }],
      nextCursor: scenario === "resume-history-cursor" ? "page-1" : scenario === "resume-history-pages" ? `page-${page + 1}`
        : scenario === "resume-history-invalid-cursor" ? 42 : page === 0 ? "page-1" : null,
    });
  } else if (method === "thread/start" || method === "thread/resume") {
    openedModel = typeof params.model === "string" ? params.model : "gpt-test";
    if (scenario === "selection-error") { emit({ id, error: { message: `${process.cwd()}/private-skills/alpha/SKILL.md PRIVATE_SECRET` } }); return; }
    if (method === "thread/start") newThread = true;
    if (!initialized) { emit({ id, error: { message: "missing initialized notification" } }); return; }
    const mode = params.sandbox === "workspace-write" ? "workspaceWrite" : "readOnly";
    const response = {
      thread: { id: scenario === "resume-response-id" ? "other-thread" : "native-thread",
        cwd: scenario === "resume-response-cwd" ? `${process.cwd()}/other` : process.cwd(),
        ephemeral: scenario === "resume-response-ephemeral" || (params.ephemeral === true && scenario !== "discovery-persistent"), path: null,
        status: { type: scenario === "resume-response-active" ? "active" : "idle" } },
      cwd: process.cwd(),
      model: scenario === "mismatch-model" ? "unexpected-model" : params.model ?? "gpt-test",
      modelProvider: scenario === "mismatch-provider" ? "normalized-provider" : scenario === "discovery-private-provider" ? "/private/native-provider" : params.modelProvider ?? "openai",
      reasoningEffort: scenario === "mismatch-reasoning" ? "low" : (params.config as Record<string, unknown> | undefined)?.model_reasoning_effort ?? "medium",
      approvalPolicy: scenario === "mismatch-policy" ? "on-request" : "never",
      sandbox: { type: mode },
    };
    if (scenario === "paused-create") {
      const timer = setInterval(() => {
        if (logPath && existsSync(`${logPath}.release`)) { clearInterval(timer); result(response); }
      }, 5);
    } else result(response);
  } else if (method === "turn/start") {
    if (scenario === "exit") { process.exit(7); }
    if (scenario === "turn-error" || scenario === "image-error") { emit({ id, error: { message: scenario === "image-error" ? JSON.stringify(params.input) : "turn rejected" } }); return; }
    if (scenario === "history-image-error" && count > 0) { emit({ id, error: { message: JSON.stringify(savedTurns) } }); return; }
    if (scenario === "hang-turn") return;
    pendingInput = params.input;
    count += 1;
    nativeId = `native-turn-${count}`;
    const turn = { id: nativeId, status: "inProgress", items: [] as Record<string, unknown>[] };
    if (scenario === "invalid-turn") { result({ turn: {} }); return; }
    if (scenario === "terminal-response") {
      result({ turn: { ...turn, status: "completed", items: [{ type: "agentMessage", id: "final", text: "Immediate answer", phase: null }] } });
      return;
    }
    notification("turn/started", { threadId: "native-thread", turn });
    if (steeringHistory) {
      steerCount = 0;
      const prompt = { type: "userMessage", id: `${nativeId}-prompt`, content: params.input };
      // This variant delivers the original only in the nonterminal response,
      // never in item notifications or the terminal turn snapshot.
      if (scenario === "steer-history-response") turn.items.push(prompt);
      else notification("item/completed", { threadId: "native-thread", turnId: nativeId, item: prompt });
    }
    notification("item/agentMessage/delta", { threadId: "another-thread", turnId: nativeId, delta: "wrong thread" });
    notification("turn/completed", { threadId: "native-thread", turn: { id: "stale-native-turn", status: "completed", items: [] } });
    if (scenario === "early-completion") { complete(); result({ turn }); return; }
    if (scenario === "slow-start") { setTimeout(() => result({ turn }), 40); return; }
    result({ turn });
    if (scenario === "reroute") {
      notification("model/rerouted", { threadId: "native-thread", turnId: nativeId, fromModel: openedModel, toModel: "replacement-model", reason: "test" });
    } else if (scenario === "interactive") {
      notification("item/agentMessage/delta", { threadId: "native-thread", turnId: nativeId, delta: "Before approval" });
      emit({ id: "server-request", method: "item/commandExecution/requestApproval", params: { threadId: "native-thread", command: "PRIVATE COMMAND" } });
    } else if (steeringHistory || ["held", "ignore-term", "interrupt-ack-only", "catalog-stall-after-open"].includes(scenario)) return;
    else if (scenario === "flood" || scenario === "byte-flood") {
      for (let i = 0; i < (scenario === "flood" ? 300 : 20); i += 1) notification("item/agentMessage/delta", {
        threadId: "native-thread", turnId: nativeId, delta: scenario === "flood" ? "delta" : "x".repeat(200_000),
      });
      complete();
    } else setTimeout(() => complete(scenario === "failed" ? "failed" : "completed", scenario === "commentary-only"), 20);
  } else if (method === "turn/steer") {
    result({ turnId: nativeId });
    if (steeringHistory) {
      steerCount += 1;
      const item = { type: "userMessage", id: `${nativeId}-steer-${steerCount}`, content: params.input };
      // Duplicate delivery of one native ID must not duplicate its history entry.
      for (let i = 0; i < 2; i++) notification("item/completed", { threadId: "native-thread", turnId: nativeId, item });
      if (steerCount === 2) complete();
    }
  }
  else if (method === "turn/interrupt") {
    result({});
    if (scenario !== "interrupt-ack-only") setTimeout(() => complete("interrupted"), 10);
  } else if (method === "test/echo") {
    setTimeout(() => result(params), params.order === 1 ? 20 : 0);
  } else if (method === "test/fragmented") {
    const bytes = Buffer.from(`${JSON.stringify({ id, result: { text: "café 🐈" } })}\r\n`);
    const split = bytes.indexOf(Buffer.from("🐈")) + 1;
    process.stdout.write(bytes.subarray(0, split));
    setTimeout(() => process.stdout.write(bytes.subarray(split)), 10);
  } else if (method === "test/error") emit({ id, error: { code: -32000, message: "expected RPC error" } });
  else if (method === "test/interactive") emit({ id: "server-request", method: "future/interactive", params: { secret: "PRIVATE PAYLOAD" } });
});
