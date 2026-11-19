import { createServer } from "node:http";

export type ScriptedBlock = { type: "text"; text: string } | { type: "tool_use"; name: string; input: Record<string, unknown> };
export type ScriptedReply = ScriptedBlock[] | ((body: Record<string, any>, call: number) => ScriptedBlock[]);
export interface ScriptedProvider {
  url: string;
  bodies: Record<string, any>[];
  calls(): number;
  close(): Promise<void>;
}

/** Local synthetic Messages endpoint. Replies come from a script (tool calls included); it never forwards requests
 * and never needs credentials. `gate` lets a test hold a reply (e.g. to steer while a turn is mid-flight). */
export async function scriptedProvider(script: ScriptedReply[], options: { gate?: (call: number) => Promise<void> | void } = {}): Promise<ScriptedProvider> {
  const bodies: Record<string, any>[] = []; let calls = 0;
  const server = createServer(async (request, response) => {
    let raw = "";
    for await (const chunk of request) raw += chunk;
    if (request.url?.includes("count_tokens")) { response.setHeader("Content-Type", "application/json"); response.end(JSON.stringify({ input_tokens: 10 })); return; }
    if (!request.url?.startsWith("/v1/messages")) { response.writeHead(404).end(); return; }
    const body = JSON.parse(raw); bodies.push(body);
    const call = ++calls, step = script[call - 1];
    if (!step) { response.writeHead(400).end("synthetic script exhausted"); return; }
    await options.gate?.(call);
    const blocks = typeof step === "function" ? step(body, call) : step;
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    const event = (type: string, data: unknown) => response.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
    event("message_start", { type: "message_start", message: { id: `scripted-${call}`, type: "message", role: "assistant", model: body.model,
      content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 0 } } });
    blocks.forEach((block, index) => {
      if (block.type === "text") {
        event("content_block_start", { type: "content_block_start", index, content_block: { type: "text", text: "" } });
        event("content_block_delta", { type: "content_block_delta", index, delta: { type: "text_delta", text: block.text } });
      } else {
        event("content_block_start", { type: "content_block_start", index, content_block: { type: "tool_use", id: `toolu_scripted_${call}_${index}`, name: block.name, input: {} } });
        event("content_block_delta", { type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: JSON.stringify(block.input) } });
      }
      event("content_block_stop", { type: "content_block_stop", index });
    });
    event("message_delta", { type: "message_delta", delta: { stop_reason: blocks.some(b => b.type === "tool_use") ? "tool_use" : "end_turn", stop_sequence: null }, usage: { output_tokens: 4 } });
    event("message_stop", { type: "message_stop" });
    response.end();
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  return { url: `http://127.0.0.1:${(server.address() as { port: number }).port}`, bodies, calls: () => calls,
    async close() { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); } };
}
