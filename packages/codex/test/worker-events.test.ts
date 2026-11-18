import assert from "node:assert/strict";
import { once } from "node:events";
import { request as httpRequest, type ClientRequest, type Server, type ServerResponse } from "node:http";
import { createRequire, syncBuiltinESMExports } from "node:module";
import test, { type TestContext } from "node:test";
import type { AgentEvent } from "@minu/runtime-core";
import { CodexEventHub, EVENT_LIMITS } from "../src/event-stream.js";
import { createCodexWorkerBridge, type CodexWorkerRuntime } from "../src/worker-bridge.js";

function gate() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}
async function until(read: () => boolean | Promise<boolean>, message: string, ms = 4_000) {
  const deadline = Date.now() + ms;
  while (!await read() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
  assert.ok(await read(), message);
}

/** Direct HTTP fixture: no dependency on the unreviewed client/public draft. */
async function fixture(t: TestContext, authorize: (call: number) => Promise<void> = async () => {}, continuous = false) {
  const stats = { auth: 0, settled: 0, opened: 0, returned: 0, stops: 0, next: 0, responses: [] as ServerResponse[] };
  const http = createRequire(import.meta.url)("node:http") as typeof import("node:http");
  const createServer = http.createServer;
  let server!: Server;
  const mock = t.mock.method(http, "createServer", (...args: Parameters<typeof createServer>) => {
    server = createServer(...args);
    server.on("request", (request, response) => { if (request.url === "/events") stats.responses.push(response); });
    return server;
  });
  syncBuiltinESMExports();
  t.after(() => { mock.mock.restore(); syncBuiltinESMExports(); });
  const hub = new CodexEventHub();
  const sourceEvent: AgentEvent = { type: "message_delta", sessionId: "private-source-id", timestamp: new Date().toISOString(), delta: "x".repeat(100_000) };
  const runtime: CodexWorkerRuntime = {
    async status() { return "working"; }, async messages() { return []; }, async turn() { return undefined; },
    async startTurn() { throw new Error("Observation cannot dispatch"); }, async steer() {}, async interrupt() {},
    async stop() { stats.stops++; hub.close(); },
    events(): AsyncIterableIterator<AgentEvent> {
      stats.opened++;
      const source = continuous ? {
        next: async () => { stats.next++; return { value: sourceEvent, done: false as const }; },
        return: async () => ({ value: undefined, done: true as const }),
      } : hub.subscribe();
      return { [Symbol.asyncIterator]() { return this; }, next: () => source.next(),
        return: () => { stats.returned++; return source.return(); } };
    },
  };
  const bridge = await createCodexWorkerBridge(runtime,
    { id: "private-source-id", runtime: "codex", ownership: "owned", cwd: process.cwd() },
    { ownerId: "owner-a", sessionId: "stable-runtime-id", generation: "generation-a" },
    { claimId: "claim-a", async authorize() { const call = ++stats.auth; try { await authorize(call); } finally { stats.settled++; } } });
  const headers = { authorization: `Bearer ${bridge.connection.token}`, "x-minu-runtime-owner": "owner-a",
    "x-minu-runtime-session": "stable-runtime-id", "x-minu-runtime-generation": "generation-a" };
  const requests: ClientRequest[] = [];
  const open = () => {
    const request = httpRequest(`${bridge.connection.endpoint}/events`, { headers, agent: false });
    request.on("error", () => {}); requests.push(request); request.end(); return request;
  };
  t.after(async () => { for (const request of requests) request.destroy(); await bridge.close(); });
  const connections = () => new Promise<number>((resolve, reject) => server.getConnections((error, count) => error ? reject(error) : resolve(count)));
  return { ...bridge, stats, open, connections };
}

test("backpressure timeout destroys a socket whose reader never resumes", { timeout: 8_000 }, async t => {
  const f = await fixture(t, async () => {}, true);
  const request = f.open();
  const [response] = await once(request, "response"); response.on("error", () => {}); response.pause();
  // Intentionally never resume this reader, including while asserting cleanup.
  await until(() => f.stats.returned >= 1, "Timed-out source was not returned", 6_000);
  assert.equal(f.stats.responses[0].destroyed, true);
  await until(async () => await f.connections() === 0, "Failed subscriber must release its server socket, not just queue an end");
  const produced = f.stats.next;
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(f.stats.next, produced, "Producer must no longer be pulled after failure");
  assert.equal(f.stats.stops, 0, "Subscriber failure cannot stop native work");
});

test("initial-authorization disconnect creates no late source or second authorization", { timeout: 5_000 }, async t => {
  const pending = gate(); t.after(pending.release);
  const f = await fixture(t, async call => { if (call === 1) await pending.promise; });
  const request = f.open();
  await until(() => f.stats.auth === 1, "Initial authorization did not start");
  request.destroy();
  await until(() => f.stats.responses[0]?.destroyed, "Server did not see cancellation");
  pending.release();
  await until(() => f.stats.settled === 1, "Underlying authorization did not settle");
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.stats.opened, 0); assert.equal(f.stats.returned, 0); assert.equal(f.stats.auth, 1);
  assert.equal(f.stats.stops, 0);
});

test("handshake-authorization disconnect promptly returns the source without delivery", { timeout: 5_000 }, async t => {
  const pending = gate(); t.after(pending.release);
  const f = await fixture(t, async call => { if (call === 2) await pending.promise; });
  const request = f.open();
  await until(() => f.stats.auth === 2, "Handshake authorization did not start");
  assert.equal(f.stats.opened, 1); request.destroy();
  await until(() => f.stats.returned >= 1, "Blocked subscription did not cancel");
  assert.equal(f.stats.responses[0].headersSent, false); assert.equal(f.stats.stops, 0);
  pending.release();
});

test("cancelled pending authorization retains bounded slots until work settles, then frees them", { timeout: 5_000 }, async t => {
  const pending = gate(); t.after(pending.release);
  const f = await fixture(t, async () => { await pending.promise; });
  const requests = Array.from({ length: EVENT_LIMITS.subscribers }, () => f.open());
  await until(() => f.stats.auth === EVENT_LIMITS.subscribers, "Authorization slots did not fill");
  for (const request of requests) request.destroy();
  await until(() => f.stats.responses.length === EVENT_LIMITS.subscribers && f.stats.responses.every(response => response.destroyed), "Cancelled sockets did not close");
  const excess = f.open(); const [refused] = await once(excess, "response"); refused.resume();
  assert.equal(refused.statusCode, 429);
  assert.equal(f.stats.auth, EVENT_LIMITS.subscribers, "Disconnect must not allow unbounded outstanding authorization");
  assert.equal(f.stats.opened, 0);
  pending.release();
  await until(() => f.stats.settled === EVENT_LIMITS.subscribers, "Cancelled authorization work did not settle");
  const fresh = f.open(); const [accepted] = await once(fresh, "response"); accepted.on("error", () => {});
  assert.equal(accepted.statusCode, 200); assert.equal(f.stats.opened, 1);
  fresh.destroy();
  await until(() => f.stats.returned >= 1, "Recovered subscription did not cancel");
  assert.equal(f.stats.stops, 0);
});

test("bridge close does not await blocked initial authorization or create a late source", { timeout: 5_000 }, async t => {
  const pending = gate(); t.after(pending.release);
  const f = await fixture(t, async () => { await pending.promise; });
  f.open(); await until(() => f.stats.auth === 1, "Initial authorization did not start");
  let timer!: ReturnType<typeof setTimeout>;
  try {
    assert.equal(await Promise.race([f.close().then(() => true), new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(false), 500); })]), true);
  } finally { clearTimeout(timer); }
  pending.release(); await until(() => f.stats.settled === 1, "Authorization did not settle");
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.stats.opened, 0); assert.equal(f.stats.auth, 1); assert.equal(f.stats.stops, 1);
  assert.equal(await f.connections(), 0);
});
