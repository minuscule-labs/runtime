import assert from "node:assert/strict";
import { createServer } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { test, type TestContext } from "node:test";
import type { AgentEvent, AgentRuntime, AgentTurn, RuntimeActivityEvent } from "@minu/runtime-core";
import { Queue } from "../src/queue.js";
import { createClaudeCodeWorkerBridge } from "../src/worker-bridge.js";
import { ClaudeCodeWorkerClient } from "../src/worker-client.js";
import { ClaudeCodeWorkerError } from "../src/worker-protocol.js";

const TIMEOUT = "Fencing test timed out";
async function bounded<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(TIMEOUT)), 2_000);
    })]);
  } finally { clearTimeout(timer); }
}
async function until(done: () => boolean) {
  const end = Date.now() + 2_000;
  while (!done()) {
    if (Date.now() > end) throw new Error(TIMEOUT);
    await delay(5);
  }
}
const denied = (error: unknown) => error instanceof ClaudeCodeWorkerError && error.status === 409;
const disconnected = (error: unknown) => error instanceof Error && error.message !== TIMEOUT;

async function fixture(t: TestContext) {
  const nativeId = "native-session";
  const events = new Queue<AgentEvent>(64), activities = new Queue<RuntimeActivityEvent>(64);
  const turns = new Map<string, AgentTurn>();
  const interrupted: string[] = [], steered: string[] = [];
  let active: AgentTurn | undefined;
  const authority: {
    current: boolean; calls: number; active: number;
    before?: () => Promise<void>; after?: () => void;
  } = { current: true, calls: 0, active: 0 };
  const runtime: AgentRuntime = {
    async start() { throw new Error("Not used by transport fixture"); },
    async send() { throw new Error("Not used by transport fixture"); },
    async status() { return active ? "working" : "idle"; },
    async startTurn(_sessionId, id, input) {
      if (active) throw new Error("Claude Code session is busy");
      const now = new Date().toISOString();
      const turn: AgentTurn = { id, input, status: "running", createdAt: now, updatedAt: now };
      turns.set(id, turn); active = turn;
      return { ...turn };
    },
    async turn(_sessionId, id) { const turn = turns.get(id); return turn && { ...turn }; },
    async messages() { return []; },
    async interrupt() {
      if (active) { interrupted.push(active.id); active.status = "interrupted"; active = undefined; }
    },
    async steer() { if (active) steered.push(active.id); },
    events() { return events; },
    activityEvents() { return activities; },
    async stop() { events.end(); activities.end(); active = undefined; },
  };
  const bridge = await createClaudeCodeWorkerBridge({
    sessionId: "logical-session", ownerId: "owner", generation: "generation", token: "a".repeat(64),
    nativeSessionId: nativeId, runtime,
    async admit(operation) {
      authority.calls++;
      const before = authority.before; authority.before = undefined;
      await before?.();
      if (!authority.current) throw new ClaudeCodeWorkerError("stale_generation", 409);
      authority.active++;
      try {
        const value = await operation();
        const after = authority.after; authority.after = undefined; after?.();
        return value;
      } finally { authority.active--; }
    },
  });
  t.after(async () => { authority.current = true; await bridge.close(); });
  const client = new ClaudeCodeWorkerClient(bridge.connection, 2_000);
  const headers = { authorization: `Bearer ${bridge.connection.token}`, "x-minu-runtime-session": bridge.connection.sessionId,
    "x-minu-runtime-owner": bridge.connection.ownerId, "x-minu-runtime-generation": bridge.connection.generation,
    "content-type": "application/json" };
  const emitEvent = (text: string) => events.push({ type: "message_delta", sessionId: nativeId, timestamp: new Date().toISOString(), delta: text });
  const emitActivity = (phase: RuntimeActivityEvent["phase"]) => activities.push({ phase, observedAt: new Date().toISOString() });
  const complete = () => { if (active) { active.status = "completed"; active.updatedAt = new Date().toISOString(); active = undefined; } };
  return { bridge, client, authority, emitEvent, emitActivity, complete, interrupted, steered, headers };
}

for (const kind of ["events", "activity"] as const) {
  test(`established ${kind} streams reject post-revocation frames without holding idle admission`, async t => {
    const f = await fixture(t);
    const abort = new AbortController();
    const before = f.authority.calls;
    const iterator: AsyncIterator<AgentEvent | RuntimeActivityEvent> = (kind === "events" ? f.client.events(abort.signal) : f.client.activityEvents(abort.signal))[Symbol.asyncIterator]();
    try {
      const first = iterator.next();
      if (kind === "activity") {
        await until(() => f.authority.calls >= before + 2);
        f.emitActivity("working");
      }
      assert.equal((await bounded(first)).done, false);
      assert.equal(f.authority.active, 0, "An idle stream must not retain a lifecycle lease");
      // Open streams must not block a valid turn's independent admission.
      await f.client.startTurn("still-admitted", "input");
      f.authority.current = false;
      await assert.rejects(f.client.status(), denied);
      const next = iterator.next();
      if (kind === "events") f.emitEvent("POST_REVOCATION_DATA"); else f.emitActivity("responding");
      await assert.rejects(bounded(next), disconnected);
      assert.equal(f.authority.active, 0);
    } finally { abort.abort(); await iterator.return?.(); }
  });

  test(`${kind} revocation between opening lookup and subscription setup denies the subscription`, async t => {
    const f = await fixture(t);
    const abort = new AbortController();
    f.authority.after = () => { f.authority.current = false; };
    const iterator: AsyncIterator<AgentEvent | RuntimeActivityEvent> = (kind === "events" ? f.client.events(abort.signal) : f.client.activityEvents(abort.signal))[Symbol.asyncIterator]();
    try {
      const rejected = assert.rejects(bounded(iterator.next()), denied);
      await until(() => !f.authority.current);
      if (kind === "events") f.emitEvent("POST_REVOCATION_DATA"); else f.emitActivity("responding");
      await rejected;
      assert.equal(f.authority.active, 0);
    } finally { abort.abort(); await iterator.return?.(); }
  });

  test(`${kind} frame waiting for admission is discarded if authority is revoked while waiting`, async t => {
    const f = await fixture(t);
    const abort = new AbortController();
    const before = f.authority.calls;
    const iterator: AsyncIterator<AgentEvent | RuntimeActivityEvent> = (kind === "events" ? f.client.events(abort.signal) : f.client.activityEvents(abort.signal))[Symbol.asyncIterator]();
    let release!: () => void;
    try {
      const first = iterator.next();
      if (kind === "activity") { await until(() => f.authority.calls >= before + 2); f.emitActivity("working"); }
      await bounded(first);
      let entered!: () => void;
      const enteredPromise = new Promise<void>(resolve => { entered = resolve; });
      const gate = new Promise<void>(resolve => { release = resolve; });
      f.authority.before = async () => { entered(); await gate; };
      const next = iterator.next();
      if (kind === "events") f.emitEvent("QUEUED_PRIVATE_DATA"); else f.emitActivity("responding");
      await bounded(enteredPromise);
      f.authority.current = false;
      release();
      await assert.rejects(bounded(next), disconnected);
    } finally { release?.(); abort.abort(); await iterator.return?.(); }
  });
}

for (const kind of ["interrupt", "steer"] as const) {
  test(`delayed ${kind} for turn A cannot affect later turn B in the same generation`, async t => {
    const f = await fixture(t);
    let entered!: () => void, release!: () => void;
    const enteredPromise = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    let forwardedTarget: string | undefined;
    const proxy = createServer(async (request, response) => {
      let raw = ""; for await (const chunk of request) raw += chunk;
      forwardedTarget = JSON.parse(raw).expectedTurnId;
      entered(); await gate;
      try {
        const upstream = await fetch(`${f.bridge.connection.endpoint}${request.url}`, {
          method: request.method, headers: request.headers as Record<string, string>, body: raw, redirect: "error",
        });
        response.writeHead(upstream.status, { "content-type": "application/json" });
        response.end(await upstream.text());
      } catch { response.writeHead(503).end(); }
    });
    await new Promise<void>(resolve => proxy.listen(0, "127.0.0.1", resolve));
    try {
      await f.client.startTurn("turn-A", "A");
      const delayed = new ClaudeCodeWorkerClient({ ...f.bridge.connection, endpoint: `http://127.0.0.1:${(proxy.address() as { port: number }).port}` }, 5_000);
      const pending = (kind === "interrupt" ? delayed.interrupt("turn-A") : delayed.steer("turn-A", "guidance"))
        .then(() => undefined, (error: unknown) => error);
      await bounded(enteredPromise);
      assert.equal(forwardedTarget, "turn-A");
      f.complete();
      await f.client.startTurn("turn-B", "B");
      release();
      assert.ok(denied(await bounded(pending)), "Stale controls must reject instead of targeting the then-active turn");
      assert.deepEqual(f.interrupted, []); assert.deepEqual(f.steered, []);
      assert.equal((await f.client.turn("turn-B"))?.status, "running");
      if (kind === "interrupt") { await f.client.interrupt("turn-B"); assert.deepEqual(f.interrupted, ["turn-B"]); }
      else { await f.client.steer("turn-B", "current guidance"); assert.deepEqual(f.steered, ["turn-B"]); }
    } finally {
      release(); proxy.closeAllConnections();
      await new Promise<void>(resolve => proxy.close(() => resolve()));
    }
  });
}

test("missing, unknown and settled control targets never fall back to the current active turn", async t => {
  const f = await fixture(t);
  await f.client.startTurn("settled", "old"); f.complete();
  await f.client.startTurn("active", "new");
  for (const path of ["/interrupt", "/steer"]) for (const target of [undefined, null, "missing", "settled"]) {
    const response = await fetch(`${f.bridge.connection.endpoint}${path}`, {
      method: "POST", headers: f.headers, body: JSON.stringify({ expectedTurnId: target, input: "guidance" }),
    });
    assert.equal(response.status, typeof target === "string" ? 409 : 400);
    await response.body?.cancel();
  }
  assert.deepEqual(f.interrupted, []); assert.deepEqual(f.steered, []);
  assert.equal((await f.client.turn("active"))?.status, "running");
});
