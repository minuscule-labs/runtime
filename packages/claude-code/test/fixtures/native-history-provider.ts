import { createServer } from "node:http";

/** Local synthetic Messages endpoint only; never forwards requests. */
export async function nativeHistoryProvider(maxCalls = Number.POSITIVE_INFINITY, thinking = false) {
  let calls = 0;
  const server = createServer(async (request, response) => {
    let raw = "";
    for await (const chunk of request) raw += chunk;
    if (request.url?.includes("count_tokens")) {
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify({ input_tokens: 10 }));
      return;
    }
    if (!request.url?.startsWith("/v1/messages")) { response.writeHead(404).end(); return; }
    const body = JSON.parse(raw);
    calls++;
    if (calls > maxCalls) { response.writeHead(400).end("synthetic request budget exhausted"); return; }
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    const event = (type: string, data: unknown) => response.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
    event("message_start", { type: "message_start", message: { id: `history-${calls}`, type: "message", role: "assistant",
      model: body.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 0 } } });
    if (thinking) {
      event("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "", signature: "" } });
      event("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "PRIVATE_SYNTHETIC_REASONING" } });
      event("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "c3ludGhldGlj" } });
      event("content_block_stop", { type: "content_block_stop", index: 0 });
    }
    const index = thinking ? 1 : 0;
    event("content_block_start", { type: "content_block_start", index, content_block: { type: "text", text: "" } });
    event("content_block_delta", { type: "content_block_delta", index, delta: { type: "text_delta", text: `history reply ${calls}` } });
    event("content_block_stop", { type: "content_block_stop", index });
    event("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 4 } });
    event("message_stop", { type: "message_stop" });
    response.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
    calls: () => calls,
    async close() { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); },
  };
}
