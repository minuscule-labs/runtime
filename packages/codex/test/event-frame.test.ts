import assert from "node:assert/strict";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:http";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import test from "node:test";
import type { AgentEvent } from "@minu/runtime-core";
import { BoundedEvents, EVENT_LIMITS } from "../src/event-stream.js";
import { CodexAgentRuntime } from "../src/client.js";
import { createCodexWorkerBridge } from "../src/worker-bridge.js";
import { CodexWorkerClient } from "../src/worker-client.js";

const identity = { ownerId: "owner-a", sessionId: "stable-runtime-id", generation: "generation-a" };
function atWireBytes(bytes: number, utf8: boolean) {
  const prefix = utf8 ? 'é🐈"\\\n' : "";
  const event = { type: "message_delta" as const, sessionId: identity.sessionId, timestamp: "2026-01-01T00:00:00.000Z", delta: prefix };
  const padding = bytes - Buffer.byteLength(JSON.stringify({ event }) + "\n");
  assert.ok(padding >= 0);
  event.delta += "x".repeat(padding);
  const frame = JSON.stringify({ event }) + "\n";
  assert.equal(Buffer.byteLength(frame), bytes, "Count UTF-8 bytes including the actual envelope and newline");
  if (utf8) assert.ok(frame.length < Buffer.byteLength(frame), "Unicode bytes must not be mistaken for JS string length");
  return { event, padding };
}

for (const utf8 of [false, true]) {
  test(`shared queue accepts the exact wire limit and rejects limit plus one: ${utf8 ? "UTF-8/escaping" : "ASCII"}`, async () => {
    const valid = atWireBytes(EVENT_LIMITS.frame, utf8).event;
    const queue = new BoundedEvents(); queue.push(valid);
    assert.deepEqual((await queue.next()).value, valid);
    // Direct delivery to a blocked next must enforce the same wire boundary.
    const waiting = queue.next(); queue.push(valid);
    assert.deepEqual((await waiting).value, valid);
    queue.push(atWireBytes(EVENT_LIMITS.frame + 1, utf8).event);
    await assert.rejects(queue.next(), /frame exceeds limit/);
  });

  test(`aggregate queue budget retains overhead and releases drained bytes: ${utf8 ? "UTF-8" : "ASCII"}`, async () => {
    const event = atWireBytes(EVENT_LIMITS.frame, utf8).event;
    const charge = Buffer.byteLength(JSON.stringify(event)) + 32;
    const count = Math.floor(EVENT_LIMITS.bytes / charge);
    assert.equal(count, 7, "Eight maximum wire frames exceed the unchanged queue budget when overhead is retained");
    const queue = new BoundedEvents();
    for (let i = 0; i < count; i++) queue.push(event);
    assert.deepEqual((await queue.next()).value, event);
    queue.push(event); // Reuse exactly the charge released by the drain.
    for (let i = 0; i < count; i++) assert.deepEqual((await queue.next()).value, event);
    for (let i = 0; i <= count; i++) queue.push(event);
    await assert.rejects(queue.next(), /consumer overflow/);
  });

  for (const extra of [0, 1]) {
    test(`raw reader boundary ${EVENT_LIMITS.frame + extra} bytes: ${utf8 ? "UTF-8/escaping" : "ASCII"}`, async t => {
      const expected = atWireBytes(EVENT_LIMITS.frame + extra, utf8).event;
      const server = createServer((_request, response) => {
        response.writeHead(200, { "content-type": "application/x-ndjson", "x-minu-runtime-events": "1" });
        response.end(JSON.stringify({ ready: 1, identity: { version: 1, ...identity, pid: process.pid } }) + "\n"
          + JSON.stringify({ event: expected }) + "\n" + JSON.stringify({ end: 1 }) + "\n");
      });
      server.listen(0, "127.0.0.1"); await once(server, "listening");
      t.after(async () => { const closed = new Promise<void>(resolve => server.close(() => resolve())); server.closeAllConnections(); await closed; });
      const client = new CodexWorkerClient({ version: 1, ...identity, pid: process.pid, token: "a".repeat(64),
        endpoint: `http://127.0.0.1:${(server.address() as AddressInfo).port}` });
      const stream = client.events(); t.after(() => stream.return?.()); await stream.ready;
      if (extra === 0) {
        assert.deepEqual((await stream.next()).value, expected);
        assert.equal((await stream.next()).done, true);
      } else await assert.rejects(stream.next(), /frame exceeds limit/);
    });

    test(`actual bridge/native reader boundary ${EVENT_LIMITS.frame + extra} bytes: ${utf8 ? "UTF-8/escaping" : "ASCII"}`, { timeout: 10_000 }, async t => {
      const directory = await realpath(await mkdtemp(join(tmpdir(), "codex-frame-boundary-")));
      const log = join(directory, "native.jsonl");
      const expected = atWireBytes(EVENT_LIMITS.frame + extra, utf8);
      const runtime = new CodexAgentRuntime({ command: process.execPath,
        args: [fileURLToPath(new URL("./fixtures/frame-native.js", import.meta.url)), String(expected.padding), utf8 ? "utf8" : "ascii", "normal", log],
        requestTimeoutMs: 1_000, shutdownTimeoutMs: 100 });
      let cleanup = async () => {};
      t.after(async () => { try { await cleanup(); } finally { await rm(directory, { recursive: true, force: true }); } });
      const session = await runtime.start({ cwd: directory });
      cleanup = () => runtime.stop(session.id);
      const bridge = await createCodexWorkerBridge(runtime, session, identity);
      cleanup = () => bridge.close();
      const stream = new CodexWorkerClient(bridge.connection).events();
      cleanup = async () => { try { await stream.return?.(); } finally { await bridge.close(); } };
      await stream.ready;
      const observed = (async () => {
        const events: AgentEvent[] = [];
        try {
          for await (const event of stream) {
            events.push(event);
            if (event.type === "turn_completed") break;
          }
          return { events, error: undefined };
        } catch (error) { return { events, error }; }
      })();
      await runtime.send(session.id, "Boundary observation must not replay or stop work");
      const result = await observed;
      if (extra === 0) {
        assert.equal(result.error, undefined);
        const delta = result.events.find(event => event.type === "message_delta");
        assert.ok(delta?.type === "message_delta");
        assert.equal(delta.delta, expected.event.delta);
        assert.equal(Buffer.byteLength(JSON.stringify({ event: delta }) + "\n"), EVENT_LIMITS.frame);
        assert.ok(result.events.some(event => event.type === "turn_completed"));
      } else {
        assert.ok(result.error instanceof Error, "Oversized output must fail observation explicitly");
        assert.equal(result.events.some(event => event.type === "message_delta"), false);
      }
      assert.equal(await runtime.status(session.id), "idle", "Observation failure cannot stop native work");
      const calls = (await readFile(log, "utf8")).trim().split("\n").map(line => JSON.parse(line));
      assert.equal(calls.filter(call => call.method === "turn/start").length, 1, "Observation must not replay input");
    });
  }
}
