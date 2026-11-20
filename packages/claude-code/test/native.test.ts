import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ClaudeCodeAgentRuntime } from "../src/index.js";

// Real bundled Claude Code + real SDK, but only a localhost synthetic Messages provider.
// No inherited credentials/config, billed calls, or execution of model-selected tools.
test("bundled native engine handles multiple turns, literal input, interruption and shutdown", { timeout: 45_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "minu-claude-native-"));
  let held!: () => void;
  const holdStarted = new Promise<void>((resolve) => { held = resolve; });
  const requests: string[] = [];
  let sawDeniedToolResult = false;
  const server = createServer(async (request, response) => {
    let raw = "";
    for await (const chunk of request) raw += chunk;
    if (request.url?.includes("count_tokens")) {
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify({ input_tokens: 10 }));
      return;
    }
    if (!request.url?.startsWith("/v1/messages")) {
      response.writeHead(404).end();
      return;
    }
    const body = JSON.parse(raw);
    const text = body.messages.filter((message: any) => message.role === "user").flatMap((message: any) =>
      typeof message.content === "string" ? [message.content]
        : message.content.filter((block: any) => block.type === "text").map((block: any) => block.text),
    ).join("\n");
    requests.push(text);
    const answer = `synthetic reply ${requests.length}`;
    response.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
    const event = (type: string, data: unknown) => response.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
    event("message_start", { type: "message_start", message: { id: `msg_${requests.length}`, type: "message", role: "assistant",
      model: body.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 0 } } });
    if (text.includes("hold-native") && !text.includes("after-native")) { held(); return; }
    const toolResult = body.messages.flatMap((message: any) => Array.isArray(message.content) ? message.content : [])
      .find((block: any) => block.type === "tool_result" && block.tool_use_id === "native-write-1");
    if (toolResult) sawDeniedToolResult = toolResult.is_error === true;
    const attemptWrite = text.includes("permission-native") && !toolResult;
    if (attemptWrite) {
      event("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "native-write-1", name: "Write", input: {} } });
      event("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "input_json_delta",
        partial_json: JSON.stringify({ file_path: join(dir, "must-not-exist"), content: "denied write" }) } });
    } else {
      event("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
      event("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: answer } });
    }
    event("content_block_stop", { type: "content_block_stop", index: 0 });
    event("message_delta", { type: "message_delta", delta: { stop_reason: attemptWrite ? "tool_use" : "end_turn", stop_sequence: null }, usage: { output_tokens: 4 } });
    event("message_stop", { type: "message_stop" });
    response.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  const runtime = new ClaudeCodeAgentRuntime({ tools: ["Write"], executable: "bundled",
    env: { PATH: process.env.PATH, HOME: dir, CLAUDE_CONFIG_DIR: join(dir, "config"),
      ANTHROPIC_API_KEY: "synthetic-local-only", ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`,
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1" } });
  let session: Awaited<ReturnType<typeof runtime.start>> | undefined;
  try {
    session = await runtime.start({ cwd: dir });
    // Verbatim input must not invoke slash commands or expand a nonexistent @file.
    await runtime.send(session.id, "/status @nonexistent-file first-native");
    await runtime.send(session.id, "second-native");
    assert.equal(requests.length, 2);
    assert.ok(requests[0].includes("/status @nonexistent-file first-native"), JSON.stringify(requests[0]));
    assert.deepEqual((await runtime.messages(session.id)).filter((m) => m.role === "assistant").map((m) => m.content), ["synthetic reply 1", "synthetic reply 2"]);
    await runtime.startTurn(session.id, "native-hold", "hold-native");
    await holdStarted;
    await runtime.interrupt(session.id);
    const end = Date.now() + 5_000;
    while ((await runtime.turn(session.id, "native-hold"))?.status === "running" && Date.now() < end) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal((await runtime.turn(session.id, "native-hold"))?.status, "interrupted");
    await runtime.send(session.id, "after-native");
    await runtime.send(session.id, "permission-native");
    assert.ok(sawDeniedToolResult, "Native Write must produce a permission-denied tool result");
    await assert.rejects(stat(join(dir, "must-not-exist")), { code: "ENOENT" });
    assert.equal(await runtime.status(session.id), "idle");
  } finally {
    try { if (session) await runtime.stop(session.id); }
    finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(dir, { recursive: true, force: true });
    }
  }
});
