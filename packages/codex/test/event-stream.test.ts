import assert from "node:assert/strict";
import { createServer, request as httpRequest, type ServerResponse } from "node:http";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import test, { type TestContext } from "node:test";
import type { AgentEvent } from "@minu/runtime-core";
import { BoundedEvents, checkedEvent, CodexEventHub, EVENT_LIMITS, safeCodexActivity } from "../src/event-stream.js";
import { CodexWorkerClient } from "../src/worker-client.js";
import { createCodexWorkerBridge, type CodexWorkerConnection, type CodexWorkerRuntime } from "../src/worker-bridge.js";

const identity = { ownerId: "owner-a", sessionId: "stable-id", generation: "generation-a" };
function event(delta = "café 🐈"): AgentEvent { return { type: "message_delta", sessionId: identity.sessionId, timestamp: new Date().toISOString(), delta }; }
function headers(c: CodexWorkerConnection) { return { authorization: `Bearer ${c.token}`, "x-minu-runtime-owner": c.ownerId,
  "x-minu-runtime-session": c.sessionId, "x-minu-runtime-generation": c.generation }; }
const hello = JSON.stringify({ ready: 1, identity: { version: 1, ...identity, pid: process.pid } }) + "\n";
function begin(response: ServerResponse) {
  response.writeHead(200, { "content-type": "application/x-ndjson", "x-minu-runtime-events": "1" }); response.write(hello);
}
async function peer(t: TestContext, handle: (response: ServerResponse) => void) {
  const server = createServer((request, response) => {
    assert.equal(request.url, "/events"); assert.equal(request.headers.authorization, `Bearer ${"a".repeat(64)}`);
    handle(response);
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(async () => { const closed = new Promise<void>(resolve => server.close(() => resolve())); server.closeAllConnections(); await closed; });
  const connection: CodexWorkerConnection = { version: 1, ...identity, pid: process.pid, token: "a".repeat(64), endpoint: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
  return { client: new CodexWorkerClient(connection), connection };
}
async function bridge(t: TestContext, streaming = true) {
  const hub = new CodexEventHub();
  let allowed = true;
  let stops = 0;
  const session = { id: "source-session", runtime: "codex", ownership: "owned" as const, cwd: process.cwd() };
  const runtime: CodexWorkerRuntime = {
    async status() { return "idle"; }, async messages() { return []; }, async turn() { return undefined; },
    async startTurn() { throw new Error("Observation cannot dispatch"); }, async steer() {}, async interrupt() {}, async stop() { stops++; hub.close(); },
    ...(streaming ? { events: () => hub.subscribe({ type: "status", status: "idle", sessionId: session.id, timestamp: new Date().toISOString() }) } : {}),
  };
  const value = await createCodexWorkerBridge(runtime, session, identity, { claimId: "claim-a", async authorize() { if (!allowed) throw new Error("fenced"); } });
  t.after(() => value.close());
  return { ...value, client: new CodexWorkerClient(value.connection), hub, sourceId: session.id, fence() { allowed = false; }, stops: () => stops };
}

for (const status of ["idle", "working", "offline"] as const) {
  test(`normalized status event requires a string: ${status}`, () => {
    const valid = { type: "status", sessionId: identity.sessionId, timestamp: new Date().toISOString(), status };
    assert.deepEqual(checkedEvent(valid, identity.sessionId), valid);
    assert.throws(() => checkedEvent({ ...valid, status: [status] }, identity.sessionId), /Invalid Codex status event/);
  });
}

for (const stage of ["open", "next"] as const) {
  test(`safe activity failure hides ${stage} diagnostics and cause`, async () => {
    const canary = "SECRETVALUE";
    const original = Object.assign(new Error(`Private decoder failure: ${canary}`, { cause: new Error(canary) }), { privatePayload: canary });
    let returned = false;
    const source: AsyncIterableIterator<AgentEvent> = {
      [Symbol.asyncIterator]() { return this; },
      async next() { throw original; },
      async return() { returned = true; return { value: undefined, done: true }; },
    };
    const activity = safeCodexActivity(() => { if (stage === "open") throw original; return source; }, new AbortController().signal);
    await assert.rejects(activity.next(), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.notEqual(error, original);
      assert.equal(error.message, "Codex activity observation failed");
      assert.equal(Object.hasOwn(error, "cause"), false);
      assert.equal(String(error.stack).includes(canary), false);
      assert.equal(JSON.stringify(Object.getOwnPropertyDescriptors(error)).includes(canary), false);
      return true;
    });
    assert.equal(returned, stage === "next");
    assert.equal((await activity.return?.())?.done, true);
  });
}

test("fragmented JSON and multibyte UTF-8 decode as exactly one normalized event", { timeout: 5_000 }, async t => {
  const expected = event();
  const f = await peer(t, response => {
    response.writeHead(200, { "content-type": "application/x-ndjson", "x-minu-runtime-events": "1" });
    void (async () => {
      const bytes = Buffer.from(hello + JSON.stringify({ event: expected }) + "\n" + JSON.stringify({ end: 1 }) + "\n");
      for (const byte of bytes) { response.write(Buffer.from([byte])); await new Promise(resolve => setImmediate(resolve)); }
      response.end();
    })();
  });
  const stream = f.client.events(); await stream.ready;
  assert.deepEqual((await stream.next()).value, expected);
  assert.equal((await stream.next()).done, true);
});

for (const [name, body] of [
  ["malformed JSON", Buffer.from("not-json\n")],
  ["malformed UTF-8", Buffer.from([0xff, 10])],
  ["oversized frame", Buffer.from(JSON.stringify({ event: event("x".repeat(EVENT_LIMITS.frame)) }) + "\n")],
  ["unterminated oversized frame", Buffer.from("x".repeat(EVENT_LIMITS.frame + 1))],
  ["wrong session", Buffer.from(JSON.stringify({ event: { ...event(), sessionId: "wrong-session" } }) + "\n")],
  ["unexpected raw field", Buffer.from(JSON.stringify({ event: { ...event(), raw: { secret: "PRIVATE" } } }) + "\n")],
  ["noncanonical timestamp", Buffer.from(JSON.stringify({ event: { ...event(), timestamp: "2020-01-01 (PRIVATE)" } }) + "\n")],
] as const) {
  test(`stream rejects ${name} explicitly`, { timeout: 5_000 }, async t => {
    const f = await peer(t, response => { begin(response); response.write(body); });
    const stream = f.client.events(); await stream.ready;
    await assert.rejects(stream.next()); await stream.return?.();
  });
}

for (const changed of [{ ownerId: "owner-b" }, { generation: "other-generation" }, { pid: process.pid + 1 }, { claimId: "unexpected-claim" }]) {
  test(`stream handshake refuses mismatched ${Object.keys(changed)[0]}`, async t => {
    const f = await peer(t, response => {
      response.writeHead(200, { "content-type": "application/x-ndjson", "x-minu-runtime-events": "1" });
      response.end(JSON.stringify({ ready: 1, identity: { version: 1, ...identity, pid: process.pid, ...changed } }) + "\n");
    });
    const stream = f.client.events(); await assert.rejects(stream.ready, /handshake/); await stream.return?.();
  });
}

test("bounded queues fail overflow without blocking other subscribers", async () => {
  const hub = new CodexEventHub(); const slow = hub.subscribe(); const fast = hub.subscribe();
  for (let i = 0; i <= EVENT_LIMITS.frames; i++) { hub.publish(event()); assert.equal((await fast.next()).value?.type, "message_delta"); }
  await assert.rejects(slow.next(), /overflow/);
  await fast.return();
  const bytes = new BoundedEvents();
  for (let i = 0; i < 12; i++) bytes.push(event("x".repeat(200_000)));
  await assert.rejects(bytes.next(), /overflow/);
});

test("wire consumer overflow fails rather than dropping unread events", { timeout: 5_000 }, async t => {
  const f = await peer(t, response => { begin(response); for (let i = 0; i <= EVENT_LIMITS.frames; i++) response.write(JSON.stringify({ event: event() }) + "\n"); });
  const stream = f.client.events(); await stream.ready;
  // The decoder drains the network independently, but may retain only its fixed
  // queue. Let it observe the producer burst without application next calls.
  await new Promise(resolve => setTimeout(resolve, 50));
  await assert.rejects(stream.next(), /overflow/); await stream.return?.();
});

for (const handshake of [false, true]) {
  test(`return cancels a blocked ${handshake ? "idle read" : "handshake"}`, { timeout: 3_000 }, async t => {
    let arrived!: () => void; const request = new Promise<void>(resolve => { arrived = resolve; });
    let disconnected!: () => void; const closed = new Promise<void>(resolve => { disconnected = resolve; });
    const f = await peer(t, response => { response.once("close", disconnected); if (handshake) begin(response); arrived(); });
    const stream = f.client.events(); const next = stream.next();
    await request; if (handshake) await stream.ready;
    await stream.return?.(); assert.equal((await next).done, true);
    await stream.return?.(); await closed;
  });
}

test("handshake deadline does not terminate a legitimate long-lived idle stream", { timeout: 15_000 }, async t => {
  let response!: ServerResponse;
  const f = await peer(t, value => { response = value; begin(value); });
  const stream = f.client.events(); await stream.ready;
  const next = stream.next();
  await new Promise(resolve => setTimeout(resolve, 10_100));
  response.write(JSON.stringify({ event: event() }) + "\n");
  assert.equal((await next).value?.type, "message_delta"); await stream.return?.();
});

test("stream redirects are refused without forwarding credentials", { timeout: 3_000 }, async t => {
  let contacted = false;
  const trap = createServer((_request, response) => { contacted = true; response.end(); });
  trap.listen(0, "127.0.0.1"); await once(trap, "listening");
  t.after(async () => { const closed = new Promise<void>(resolve => trap.close(() => resolve())); trap.closeAllConnections(); await closed; });
  const f = await peer(t, response => { response.writeHead(302, { location: `http://127.0.0.1:${(trap.address() as AddressInfo).port}/stolen` }); response.end(); });
  const stream = f.client.events(); await assert.rejects(stream.ready); await stream.return?.();
  assert.equal(contacted, false);
});

test("older authenticated peer lacking streaming remains unsupported", async t => {
  const f = await bridge(t, false); await f.client.verifyIdentity();
  const stream = f.client.events(); await assert.rejects(stream.ready, /unsupported/); await stream.return?.();
  assert.equal(await f.client.request("status"), "idle"); assert.equal(f.stops(), 0);
});

test("stream route rejects wrong bearer, owner, generation and Origin", async t => {
  const f = await bridge(t);
  for (const changed of [{ authorization: "Bearer invalid" }, { "x-minu-runtime-owner": "owner-b" },
    { "x-minu-runtime-generation": "generation-b" }, { origin: "https://untrusted.invalid" }]) {
    const response = await fetch(`${f.connection.endpoint}/events`, { headers: { ...headers(f.connection), ...changed } as Record<string, string> });
    assert.equal(response.status, 403); await response.arrayBuffer();
  }
  assert.equal(f.stops(), 0);
});

for (const delivery of ["idle", "event"]) {
  test(`bridge reauthorizes ${delivery} delivery and remaps only the Runtime session ID`, { timeout: 3_000 }, async t => {
    const f = await bridge(t); const stream = f.client.events(); await stream.ready;
    assert.equal((await stream.next()).value?.sessionId, identity.sessionId);
    f.fence();
    if (delivery === "event") f.hub.publish({ ...event("must not be delivered"), sessionId: f.sourceId });
    await assert.rejects(stream.next()); await stream.return?.(); assert.equal(f.stops(), 0);
  });
}

test("subscriber count is bounded and cancellation frees observation slots", { timeout: 5_000 }, async t => {
  const f = await bridge(t);
  const streams = Array.from({ length: EVENT_LIMITS.subscribers }, () => f.client.events());
  await Promise.all(streams.map(stream => stream.ready));
  const excess = f.client.events(); await assert.rejects(excess.ready); await excess.return?.();
  await Promise.all(streams.map(stream => stream.return?.()));
  await new Promise(resolve => setTimeout(resolve, 50));
  const fresh = f.client.events(); await fresh.ready; await fresh.return?.(); assert.equal(f.stops(), 0);
});

test("slow network reader cannot stall a healthy subscriber or grow server queues unbounded", { timeout: 8_000 }, async t => {
  const f = await bridge(t);
  const slow = httpRequest(`${f.connection.endpoint}/events`, { headers: headers(f.connection) });
  const responsePromise = once(slow, "response"); slow.end();
  const [response] = await responsePromise; response.pause(); response.on("error", () => {});
  const stream = f.client.events(); await stream.ready; await stream.next();
  let count = 0;
  const healthy = (async () => { for await (const e of stream) if (e.type === "message_delta" && ++count === 80) break; })();
  for (let i = 0; i < 80; i++) {
    f.hub.publish({ ...event("x".repeat(100_000)), sessionId: f.sourceId });
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  await healthy; assert.equal(count, 80); assert.equal(f.stops(), 0);
  // The abandoned socket must fail/close, never return a clean replay-complete
  // marker after dropping buffered events. Reading resumes only after overflow.
  const chunks: Buffer[] = []; response.on("data", (chunk: Buffer) => chunks.push(chunk));
  const ended = new Promise<void>(resolve => { response.once("close", resolve); response.once("end", resolve); });
  response.resume(); await ended;
  assert.equal(Buffer.concat(chunks).toString().includes('"end":1'), false);
  slow.destroy();
});
