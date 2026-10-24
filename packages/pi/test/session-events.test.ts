import assert from "node:assert/strict";
import test from "node:test";
import { chmod, link, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type RequestListener } from "node:http";
import type { AddressInfo } from "node:net";
import { sessionEvents, SESSION_EVENTS_LIMITS, type RuntimeSessionEvents } from "@minu/runtime-core";
import { PiAgentRuntime } from "../src/client.js";
import { createPiBridgeServer, SessionBusyError, type PiBridgeServerOptions } from "../src/server.js";
import { writeRegistration } from "../src/registry.js";
import { SessionEventLog } from "../src/session-events.js";

function gate<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; }
const snapshot = (): RuntimeSessionEvents => ({ version: 1, source: "runtime_bridge", capturedAt: new Date().toISOString(), recordingSince: new Date().toISOString(), eventsDropped: 0, events: [] });
async function fixture(overrides: Partial<PiBridgeServerOptions> = {}) {
  const dir = await mkdtemp(join(tmpdir(), "runtime-events-test-"));
  const previous = process.env.MINU_RUNTIME_DIR;
  process.env.MINU_RUNTIME_DIR = dir;
  let sends = 0, messageReads = 0, statusReads = 0;
  let status: "idle" | "working" | "offline" = "idle";
  const bridge = await createPiBridgeServer({
    sessionId: "PRIVATE_NATIVE", token: "test-token", managedSession: { id: "managed", ownerId: "owner" },
    getStatus: () => { statusReads++; return status; },
    async send() { sends++; },
    async getMessages() { messageReads++; return sends ? [{ role: "assistant", content: `SECRET_TOOL_OUTPUT_${sends}` }] : []; },
    ...overrides,
  });
  const registration = { sessionId: "managed", ownerId: "owner", endpoint: bridge.endpoint, token: "test-token", pid: process.pid,
    cwd: "/PRIVATE_PATH", logFile: "/SECRET_LOG", sessionFile: "/SECRET_TRANSCRIPT", ownership: "owned" as const, updatedAt: new Date().toISOString() };
  await writeRegistration(registration);
  const runtime = new PiAgentRuntime();
  const headers = { authorization: "Bearer test-token", "x-minu-runtime-owner": "owner", "x-minu-runtime-session": "managed" };
  return { dir, bridge, registration, runtime, headers, get sends() { return sends; }, get messageReads() { return messageReads; }, get statusReads() { return statusReads; },
    set status(value: typeof status) { status = value; },
    async post(path: string, body?: unknown) {
      return fetch(`${bridge.endpoint}${path}`, { method: "POST", headers, body: body === undefined ? undefined : JSON.stringify(body) });
    },
    async read() { const value = await runtime.inspectSessionEvents("managed", "owner"); assert.ok(value); return value; },
    async close() { await bridge.close(); await rm(dir, { recursive: true, force: true }); if (previous === undefined) delete process.env.MINU_RUNTIME_DIR; else process.env.MINU_RUNTIME_DIR = previous; },
  };
}

test("fixed-field projection drops secrets, validates coverage and rejects malformed events", () => {
  const value = sessionEvents({ ...snapshot(), token: "SECRET", events: [{ sequence: 1, observedAt: new Date().toISOString(), code: "turn_accepted",
    input: "SECRET_PROMPT", toolName: "SECRET_TOOL", nativeId: "SECRET_ID", message: "SECRET_ERROR" }] });
  assert.deepEqual(Object.keys(value.events[0]!), ["sequence", "observedAt", "code"]);
  assert.doesNotMatch(JSON.stringify(value), /SECRET|input|toolName|nativeId|message|token/);
  for (const patch of [
    { version: 2 }, { source: "pi_stderr" }, { recordingSince: "yesterday" }, { capturedAt: "2026-13-01T00:00:00.000Z" },
    { eventsDropped: -1 }, { eventsDropped: 1 }, { events: Array(201).fill(value.events[0]) },
    { events: [{ ...value.events[0], sequence: 0 }] }, { events: [{ ...value.events[0], sequence: Number.MAX_SAFE_INTEGER + 1 }] },
    { events: [{ ...value.events[0], code: "SECRET" }] }, { events: [{ ...value.events[0], observedAt: "/SECRET_PATH" }] },
    { events: [value.events[0], { ...value.events[0], sequence: 3 }] },
  ]) assert.throws(() => sessionEvents({ ...value, ...patch }), /unavailable/);
});

test("worker ring bounds retention, reports eviction, copies snapshots and starts a new window", () => {
  const log = new SessionEventLog();
  assert.deepEqual(log.snapshot().events, []);
  for (let i = 0; i < 211; i++) log.record("turn_dispatch_requested");
  const value = log.snapshot();
  assert.equal(value.events.length, 200);
  assert.equal(value.eventsDropped, 11);
  assert.equal(value.events[0]?.sequence, 12);
  assert.equal(value.events[199]?.sequence, 211);
  assert.ok(Buffer.byteLength(JSON.stringify({ events: value })) <= SESSION_EVENTS_LIMITS.bytes);
  value.events[0]!.code = "turn_failed";
  assert.equal(log.snapshot().events[0]?.code, "turn_dispatch_requested", "caller cannot mutate retained evidence");
  const next = new SessionEventLog(); next.record("bridge_ready");
  assert.equal(next.snapshot().events[0]?.sequence, 1);
  assert.equal(next.snapshot().eventsDropped, 0);
  assert.doesNotThrow(() => log.record("SECRET" as never), "recording failure must not enter lifecycle authority");
  assert.throws(() => log.snapshot(), /unavailable/, "invalid producer state is not a complete empty history");
});

test("event inspection is exact-owner, read-only, no-store and independent of raw harness sources", async () => {
  const f = await fixture();
  try {
    const path = join(f.dir, "managed.json"), before = await readFile(path, "utf8");
    const events = await f.read();
    assert.deepEqual(events.events.map(event => event.code), ["bridge_ready"]);
    f.bridge.publish({ type: "error", sessionId: "SECRET_NATIVE", message: "SECRET_ERROR", timestamp: "/SECRET_PATH" });
    f.bridge.publish({ type: "tool_started", sessionId: "SECRET_NATIVE", toolName: "SECRET_TOOL", toolCallId: "SECRET_ID", timestamp: "SECRET_TIME" });
    f.bridge.publish({ type: "message_delta", sessionId: "SECRET_NATIVE", delta: "SECRET_PROMPT", timestamp: "SECRET_TIME" });
    const response = await fetch(`${f.bridge.endpoint}/session-events`, { headers: f.headers });
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.deepEqual((await f.read()).events, events.events, "reads and raw events never create safe-log observations");
    assert.doesNotMatch(await response.text(), /SECRET|PRIVATE|toolName|nativeId|sessionId|logFile|token/);
    assert.equal(f.sends, 0); assert.equal(f.messageReads, 0);
    assert.equal(await readFile(path, "utf8"), before);
    assert.deepEqual(await readdir(f.dir), ["managed.json"], "no log, manifest, transcript or launch access/writes");
    const reads = f.statusReads;
    assert.equal(await f.runtime.inspectSessionEvents("managed", "other-owner"), undefined);
    for (const headers of [{}, { ...f.headers, authorization: "Bearer wrong" }, { ...f.headers, "x-minu-runtime-owner": "other" }, { ...f.headers, "x-minu-runtime-session": "other" }]) {
      const denied = await fetch(`${f.bridge.endpoint}/session-events`, { headers });
      assert.ok([401, 404].includes(denied.status)); await denied.arrayBuffer();
    }
    assert.equal(f.statusReads, reads, "denial precedes worker observation");
    assert.equal((await f.post("/session-events")).status, 405);
    const query = await fetch(`${f.bridge.endpoint}/session-events?path=/SECRET`, { headers: f.headers });
    assert.equal(query.status, 503); await query.arrayBuffer();
    f.status = "offline";
    assert.equal(await f.runtime.inspectSessionEvents("managed", "owner"), undefined);
  } finally { await f.close(); }
  const attached = await fixture({ managedSession: undefined });
  try { assert.equal(await attached.runtime.inspectSessionEvents("managed", "owner"), undefined); }
  finally { await attached.close(); }
});

test("worker observation failures expose only a fixed unavailable response", async () => {
  const f = await fixture({ getStatus() { throw new Error("SECRET_PATH SECRET_TOKEN"); } });
  try {
    const response = await fetch(`${f.bridge.endpoint}/session-events`, { headers: f.headers });
    assert.equal(response.status, 503);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.deepEqual(await response.json(), { error: "Session events unavailable" });
  } finally { await f.close(); }
});

test("failed reads cannot pollute the event history with busy-control observations", async () => {
  const f = await fixture({ getMessages: async () => { throw new SessionBusyError("SECRET_BUSY"); } });
  try {
    const before = await f.read();
    const response = await fetch(`${f.bridge.endpoint}/messages`, { headers: f.headers });
    assert.equal(response.status, 409); await response.arrayBuffer();
    assert.deepEqual((await f.read()).events, before.events);
  } finally { await f.close(); }
});

test("Runtime records turn admission/dispatch/results without changing idempotency or leaking payloads", async () => {
  const f = await fixture();
  try {
    const accepted = await f.post("/turns", { turnId: "SECRET_ID", input: "SECRET_PROMPT" });
    assert.equal(accepted.status, 202); await accepted.arrayBuffer();
    assert.equal((await f.post("/turns", { turnId: "SECRET_ID", input: "SECRET_PROMPT" })).status, 200);
    assert.equal((await f.post("/turns", { turnId: "SECRET_ID", input: "OTHER_SECRET" })).status, 409);
    const value = await f.read();
    assert.deepEqual(value.events.map(event => event.code), ["bridge_ready", "turn_accepted", "turn_dispatch_requested", "turn_dispatch_returned", "turn_completed", "turn_reused", "turn_rejected_conflict"]);
    assert.equal(f.sends, 1);
    assert.doesNotMatch(JSON.stringify(value), /SECRET|PRIVATE/);
  } finally { await f.close(); }
});

test("dispatch errors are safe categories and never turn into success observations", async () => {
  const f = await fixture({ async send() { throw new Error("SECRET_TOKEN /SECRET_PATH SECRET_TOOL_OUTPUT"); } });
  try {
    assert.equal((await f.post("/turns", { turnId: "SECRET_ID", input: "SECRET_PROMPT" })).status, 202);
    const value = await f.read();
    assert.deepEqual(value.events.map(event => event.code), ["bridge_ready", "turn_accepted", "turn_dispatch_requested", "turn_dispatch_failed", "turn_failed"]);
    assert.doesNotMatch(JSON.stringify(value), /SECRET/);
    assert.equal((await f.post("/send", { input: "SECRET_PROMPT" })).status, 500);
    assert.deepEqual((await f.read()).events.slice(-2).map(event => event.code), ["turn_dispatch_requested", "turn_dispatch_failed"]);
  } finally { await f.close(); }
});

test("busy admission and control request acknowledgments remain distinct observations", async () => {
  let stops = 0, fail = false;
  const f = await fixture({
    async interrupt() { if (fail) throw new Error("SECRET_INTERRUPT"); },
    async steer() { if (fail) throw new Error("SECRET_STEER"); },
    stopRequiresIdle: true, stop() { stops++; },
  });
  try {
    f.status = "working";
    assert.equal((await f.post("/turns", { turnId: "SECRET_ID", input: "SECRET_PROMPT" })).status, 409);
    assert.equal((await f.post("/stop")).status, 409); assert.equal(stops, 0);
    assert.equal((await f.post("/steer", { input: "SECRET_PROMPT" })).status, 202);
    assert.equal((await f.post("/interrupt")).status, 202);
    fail = true;
    assert.equal((await f.post("/steer", { input: "SECRET_PROMPT" })).status, 500);
    assert.equal((await f.post("/interrupt")).status, 500);
    f.status = "idle";
    assert.equal((await f.post("/stop")).status, 202);
    assert.equal((await f.post("/stop")).status, 202);
    const value = await f.read();
    assert.deepEqual(value.events.map(event => event.code), ["bridge_ready", "request_rejected_busy", "request_rejected_busy", "steer_requested", "steer_acknowledged", "interrupt_requested", "interrupt_acknowledged", "steer_requested", "steer_failed", "interrupt_requested", "interrupt_failed", "stop_requested"]);
    assert.equal(stops, 1);
    assert.doesNotMatch(JSON.stringify(value), /SECRET/);
  } finally { await f.close(); }
});

test("pending control requests and turn dispatch do not claim acknowledgment/completion early", async () => {
  const entered = gate<void>(), pending = gate<void>();
  const f = await fixture({ async interrupt() { entered.resolve(); await pending.promise; } });
  try {
    f.status = "working";
    const interrupting = f.post("/interrupt"); await entered.promise;
    assert.deepEqual((await f.read()).events.map(event => event.code), ["bridge_ready", "interrupt_requested"]);
    pending.resolve(); assert.equal((await interrupting).status, 202);
    assert.equal((await f.read()).events.at(-1)?.code, "interrupt_acknowledged");
  } finally { pending.resolve(); await f.close(); }
  const dispatching = gate<void>(), dispatchDone = gate<void>();
  const other = await fixture({ async send() { dispatching.resolve(); await dispatchDone.promise; } });
  try {
    const sending = other.post("/send", { input: "SECRET_PROMPT" }); await dispatching.promise;
    assert.deepEqual((await other.read()).events.map(event => event.code), ["bridge_ready", "turn_dispatch_requested"]);
    dispatchDone.resolve(); assert.equal((await sending).status, 200);
    assert.equal((await other.read()).events.at(-1)?.code, "turn_dispatch_returned");
  } finally { dispatchDone.resolve(); await other.close(); }
});

test("unsafe/stale registrations fail closed without cleaning or reading arbitrary log paths", async () => {
  const f = await fixture();
  try {
    const path = join(f.dir, "managed.json"), before = await readFile(path, "utf8");
    for (const patch of [{ ownership: "attached" }, { ownerId: "other" }, { pid: 2147483000 }, { endpoint: "https://example.com" }, { token: "bad token" }]) {
      await writeFile(path, JSON.stringify({ ...f.registration, ...patch }));
      assert.equal(await f.runtime.inspectSessionEvents("managed", "owner"), undefined);
      assert.deepEqual(JSON.parse(await readFile(path, "utf8")), { ...f.registration, ...patch });
    }
    await writeFile(path, before); await chmod(path, 0o644);
    assert.equal(await f.runtime.inspectSessionEvents("managed", "owner"), undefined);
    await chmod(path, 0o600); await rm(path); await writeFile(join(f.dir, "target"), before, { mode: 0o600 });
    await symlink(join(f.dir, "target"), path);
    assert.equal(await f.runtime.inspectSessionEvents("managed", "owner"), undefined);
    await rm(path); await link(join(f.dir, "target"), path);
    assert.equal(await f.runtime.inspectSessionEvents("managed", "owner"), undefined);
    assert.equal(await readFile(join(f.dir, "target"), "utf8"), before);
    assert.equal(f.statusReads, 0);
  } finally { await f.close(); }
});

async function transportFixture(handler: RequestListener) {
  const f = await fixture();
  const server = createServer(handler);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  await writeRegistration({ ...f.registration, endpoint: `http://127.0.0.1:${(server.address() as AddressInfo).port}` });
  return { ...f, async close() { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await f.close(); } };
}

test("old workers, redirects, malformed/oversized/unknown-version responses never release evidence", async () => {
  for (const mode of ["old", "redirect", "malformed", "oversized", "version", "secret-code"]) {
    let requests = 0;
    const f = await transportFixture((_request, response) => {
      requests++;
      if (mode === "old") { response.writeHead(404); response.end("SECRET_ERROR"); }
      else if (mode === "redirect") { response.writeHead(302, { location: "/SECRET" }); response.end(); }
      else if (mode === "malformed") response.end("SECRET_NOT_JSON");
      else if (mode === "oversized") response.end(JSON.stringify({ events: snapshot(), secret: "x".repeat(33 * 1024) }));
      else if (mode === "secret-code") response.end(JSON.stringify({ events: { ...snapshot(), events: [{ sequence: 1, observedAt: new Date().toISOString(), code: "SECRET" }] } }));
      else response.end(JSON.stringify({ events: { ...snapshot(), version: 2 } }));
    });
    try { assert.equal(await f.runtime.inspectSessionEvents("managed", "owner"), undefined, mode); assert.equal(requests, 1); }
    finally { await f.close(); }
  }
});

test("worker registration changes during decoding fence the old snapshot", async () => {
  const entered = gate<void>(), pending = gate<void>();
  const f = await transportFixture(async (_request, response) => { entered.resolve(); await pending.promise; response.end(JSON.stringify({ events: snapshot() })); });
  try {
    const reading = f.runtime.inspectSessionEvents("managed", "owner"); await entered.promise;
    await writeRegistration({ ...f.registration, token: "replacement-worker-token" }); pending.resolve();
    assert.equal(await reading, undefined);
  } finally { pending.resolve(); await f.close(); }
});

test("caller cancellation and the deadline cover stalled body decoding", { timeout: 8000 }, async () => {
  for (const cancel of [true, false]) {
    const entered = gate<void>();
    const f = await transportFixture((_request, response) => { response.writeHead(200); response.write('{"events":'); entered.resolve(); });
    try {
      const controller = new AbortController(), started = performance.now();
      const reading = f.runtime.inspectSessionEvents("managed", "owner", { signal: controller.signal });
      await entered.promise;
      if (cancel) { controller.abort(); await assert.rejects(reading, { name: "AbortError" }); }
      else { assert.equal(await reading, undefined); assert.ok(performance.now() - started < 3000); }
    } finally { await f.close(); }
  }
});

test("canceled physical work keeps its shared profile/event slot until it actually settles", async () => {
  const f = await fixture(), entered = gate<void>(), pending = gate<Response>();
  const original = globalThis.fetch;
  try {
    let calls = 0;
    globalThis.fetch = async () => { calls++; entered.resolve(); return pending.promise; };
    const controller = new AbortController();
    const reading = f.runtime.inspectSessionEvents("managed", "owner", { signal: controller.signal }); await entered.promise;
    controller.abort(); await assert.rejects(reading, { name: "AbortError" });
    assert.equal(await f.runtime.inspectSessionEvents("managed", "owner"), undefined);
    assert.equal(await f.runtime.inspectSessionProfile("managed", "owner"), undefined);
    assert.equal(calls, 1);
    pending.resolve(new Response(JSON.stringify({ events: snapshot() })));
    await new Promise(resolve => setImmediate(resolve));
    globalThis.fetch = original;
    assert.ok(await f.runtime.inspectSessionEvents("managed", "owner"), "settled work releases its physical slot");
  } finally { pending.resolve(new Response("{}")); globalThis.fetch = original; await f.close(); }
});

test("one client cannot exceed 16 concurrent optional physical reads across resources", async () => {
  const f = await fixture(), allEntered = gate<void>(), pending = gate<Response>();
  const original = globalThis.fetch;
  try {
    for (let i = 0; i < 17; i++) await writeRegistration({ ...f.registration, sessionId: `managed${i}` });
    let calls = 0;
    globalThis.fetch = async () => { if (++calls === 16) allEntered.resolve(); return pending.promise.then(response => response.clone()); };
    const controllers = Array.from({ length: 16 }, () => new AbortController());
    const reads = controllers.map((controller, i) => f.runtime.inspectSessionEvents(`managed${i}`, "owner", { signal: controller.signal }));
    await allEntered.promise;
    controllers.forEach(controller => controller.abort());
    const results = await Promise.allSettled(reads);
    assert.ok(results.every(result => result.status === "rejected" && result.reason.name === "AbortError"));
    assert.equal(await f.runtime.inspectSessionEvents("managed16", "owner"), undefined);
    assert.equal(await f.runtime.inspectSessionProfile("managed16", "owner"), undefined);
    assert.equal(calls, 16);
    pending.resolve(new Response(JSON.stringify({ events: snapshot() })));
    await new Promise(resolve => setImmediate(resolve));
  } finally { pending.resolve(new Response("{}")); globalThis.fetch = original; await f.close(); }
});
