import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test, type TestContext } from "node:test";
import type { AgentEvent, AgentRuntime, AgentTurn, RuntimeActivityEvent } from "@minu/runtime-core";
import { ClaudeCodeManagedStore, type ClaudeCodeManagedManifest } from "../src/managed-store.js";
import { createClaudeCodeWorkerBridge } from "../src/worker-bridge.js";
import { ClaudeCodeWorkerClient } from "../src/worker-client.js";
import { ClaudeCodeWorkerError } from "../src/worker-protocol.js";
import { encodeClaudeCodeWorkerRegistration, type ClaudeCodeWorkerRegistrationScope } from "../src/worker-registration.js";
import { Queue } from "../src/queue.js";

async function bounded<T>(operation: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([operation, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Quiesce test timed out")), 3_000); })]); }
  finally { clearTimeout(timer); }
}
const statusError = (status: number) => (error: unknown) => error instanceof ClaudeCodeWorkerError && error.status === status;

async function fixture(t: TestContext) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "claude-quiesce-")));
  const cwd = join(root, "workspace"), nativeRoot = join(root, "native");
  await mkdir(cwd, { mode: 0o700 }); await mkdir(nativeRoot, { mode: 0o700 });
  const store = new ClaudeCodeManagedStore(join(root, "managed"));
  const initial: ClaudeCodeManagedManifest = { version: 3, runtime: "claude-code", id: "quiesce-session", ownerId: "owner",
    revision: 0, generation: "generation", requiresExplicitResume: false, native: { state: "pending" }, worker: { state: "none" },
    lastDispatch: { state: "none" }, launchConfig: { cwd },
    policy: { configuration: "isolated", permissionMode: "default", nativeConfigRoot: nativeRoot, tools: [] }, createdAt: new Date().toISOString() };
  await store.create(initial);
  const scope: ClaudeCodeWorkerRegistrationScope = { sessionId: initial.id, ownerId: initial.ownerId, generation: initial.generation,
    reservationId: randomUUID(), workerExecutable: fileURLToPath(import.meta.url), cwd, nativeConfigRoot: nativeRoot };
  const events = new Queue<AgentEvent>(64), activities = new Queue<RuntimeActivityEvent>(64), turns = new Map<string, AgentTurn>();
  const controls: { status?: () => Promise<void>; start?: () => Promise<void>; stop?: () => Promise<void>; failure?: boolean } = {};
  const counts = { stops: 0, inputs: 0, interrupts: 0 };
  let active: AgentTurn | undefined, stopped = false, cleanup = false, admission = 0;
  const runtime: AgentRuntime = {
    async start() { throw new Error("Unused"); }, async send() { throw new Error("Unused"); },
    async status() { assert.ok(cleanup || admission === 1); const status = stopped ? "offline" : active ? "working" : "idle"; await controls.status?.(); return status; },
    async startTurn(_, id, input) {
      assert.equal(admission, 1); await controls.start?.(); assert.equal(stopped, false); counts.inputs++;
      const now = new Date().toISOString(); active = { id, input, status: "running", createdAt: now, updatedAt: now };
      turns.set(id, active); return { ...active };
    },
    async turn(_, id) { const turn = turns.get(id); return turn && { ...turn }; }, async messages() { return []; },
    async interrupt() { counts.interrupts++; if (active) { active.status = "interrupted"; active = undefined; } },
    async steer() { throw new Error("Unused"); }, events() { return events; }, activityEvents() { return activities; },
    async stop() {
      assert.ok(cleanup || admission === 1); counts.stops++; stopped = true;
      await controls.stop?.(); if (controls.failure) throw new Error("PRIVATE_NATIVE_SHUTDOWN_FAILURE");
      if (active) { active.status = "interrupted"; active = undefined; }
      events.end(); activities.end();
    },
  };
  const bridge = await createClaudeCodeWorkerBridge({ ...scope, token: "a".repeat(64), nativeSessionId: scope.sessionId, runtime,
    admit: operation => cleanup ? operation() : store.withWorkerAdmission(scope, bytes, async () => {
      admission++; try { return await operation(); } finally { admission--; }
    }) });
  const bytes = encodeClaudeCodeWorkerRegistration({ version: 1, runtime: "claude-code", ownership: "owned", ...scope,
    pid: process.pid, processGroupId: null, endpoint: bridge.connection.endpoint, token: bridge.connection.token,
    createdAt: new Date().toISOString() }, scope);
  await store.withSessionLock(scope.sessionId, scope.ownerId, async lease => {
    await lease.reserveWorker(0, scope.generation, scope.reservationId, scope.workerExecutable);
    await lease.beginWorkerStart(1, scope.generation, scope.reservationId);
    await lease.recordWorkerProcess(2, scope.generation, scope.reservationId, process.pid, null);
    await lease.publishWorker(3, scope.generation, scope.reservationId, bytes);
  });
  const releases: (() => void)[] = [];
  t.after(async () => {
    for (const release of releases) release();
    controls.start = controls.status = controls.stop = undefined; controls.failure = false;
    // TEST-ONLY disposal of this fake runtime/listener after deliberate revocation.
    // No production admission bypass, metadata clear or physical-exit claim.
    cleanup = true; await bridge.close(); await rm(root, { recursive: true, force: true });
  });
  const pause = (point: "status" | "start" | "stop") => {
    let entered!: () => void, release!: () => void;
    const waiting = new Promise<void>(done => { entered = done; }), held = new Promise<void>(done => { release = done; });
    releases.push(release); controls[point] = async () => { entered(); await held; };
    return { entered: waiting, release };
  };
  let quiesced = false; void bridge.idleQuiesced.then(() => { quiesced = true; });
  return { store, scope, counts, controls, pause, bridge, admission: () => admission, quiesced: () => quiesced,
    connection: bridge.connection, client: new ClaudeCodeWorkerClient(bridge.connection, 1_000),
    read: async () => (await store.read(scope.sessionId, scope.ownerId))! };
}

test("idle quiesce confirms native stop under admission and permanently rejects new input without clearing metadata", async t => {
  const f = await fixture(t), before = await f.read();
  await f.client.requestQuiesceIdle(); assert.equal(f.counts.stops, 1); assert.equal(await f.client.status(), "offline");
  await assert.rejects(f.client.startTurn("late", "not dispatched"), statusError(409));
  await assert.rejects(f.client.requestQuiesceIdle(), statusError(409));
  assert.equal(f.counts.inputs, 0); assert.equal(f.counts.stops, 1); assert.deepEqual(await f.read(), before);
});

test("idle completion releases admission and closes transport without readmitting or repeating native stop", async t => {
  const f = await fixture(t);
  const completed = f.bridge.idleQuiesced.then(() => { assert.equal(f.admission(), 0); });
  await f.client.requestQuiesceIdle(); await bounded(completed); assert.equal(f.counts.stops, 1);
  await f.store.withSessionLock(f.scope.sessionId, f.scope.ownerId, async lease => {
    await lease.update((await f.read()).revision, { generation: "new-generation", requiresExplicitResume: true });
  });
  const fenced = await f.read(); await bounded(f.bridge.close());
  await assert.rejects(f.client.status()); assert.equal(f.counts.stops, 1); assert.deepEqual(await f.read(), fenced);
});

test("unfinished ACK delivery is bounded and cannot block idle completion or repeat native stop", async t => {
  const f = await fixture(t), before = await f.read(), original = ServerResponse.prototype.end;
  // Scoped fault: hold the successful ACK without finish/close. Do not turn this
  // transport fault into another native stop, replay or metadata mutation.
  ServerResponse.prototype.end = function(this: ServerResponse, ...args: any[]) {
    if (this.req.url === "/quiesce-idle") return this;
    return (original as Function).apply(this, args);
  } as typeof original;
  try {
    const request = assert.rejects(new ClaudeCodeWorkerClient(f.connection, 2_500).requestQuiesceIdle());
    await bounded(f.bridge.idleQuiesced); assert.equal(f.admission(), 0); assert.equal(f.counts.stops, 1);
    await bounded(f.bridge.close()); await request; assert.deepEqual(await f.read(), before);
  } finally { ServerResponse.prototype.end = original; }
});

test("generic stop never emits the idle-retirement completion signal", async t => {
  const f = await fixture(t); await f.client.requestStop();
  assert.equal(await f.client.status(), "offline"); assert.equal(f.quiesced(), false); assert.equal(f.counts.stops, 1);
});

test("busy quiesce refusal does not stop, interrupt or fence the running session", async t => {
  const f = await fixture(t), before = await f.read();
  await f.client.startTurn("busy", "hold"); await assert.rejects(f.client.requestQuiesceIdle(), statusError(409));
  assert.equal(f.counts.stops, 0); assert.equal(f.counts.interrupts, 0); assert.equal((await f.client.turn("busy"))?.status, "running");
  await f.client.interrupt("busy"); assert.equal((await f.client.startTurn("next", "still usable")).status, "running");
  assert.equal(f.counts.stops, 0); assert.equal(f.quiesced(), false); assert.deepEqual(await f.read(), before);
});

test("a turn already holding mutation admission wins over idle quiesce", async t => {
  const f = await fixture(t), gate = f.pause("start"), starting = f.client.startTurn("winner", "hold");
  await bounded(gate.entered); await assert.rejects(f.client.requestQuiesceIdle(), statusError(409));
  assert.equal(f.counts.stops, 0); gate.release(); assert.equal((await starting).status, "running");
});

test("quiesce excludes input across the idle-check await and waits for native confirmation before acknowledgment", async t => {
  const f = await fixture(t), statusGate = f.pause("status"), stopGate = f.pause("stop");
  let acknowledged = false;
  const stopping = f.client.requestQuiesceIdle().then(() => { acknowledged = true; });
  await bounded(statusGate.entered);
  await assert.rejects(f.client.startTurn("check-race", "not dispatched"), statusError(409));
  assert.equal(f.counts.stops, 0); statusGate.release(); await bounded(stopGate.entered);
  await assert.rejects(f.client.startTurn("stop-race", "not dispatched"), statusError(409));
  assert.equal(acknowledged, false); assert.equal(f.counts.inputs, 0);
  stopGate.release(); await stopping; assert.equal(acknowledged, true); assert.equal(f.counts.stops, 1);
});

test("failed native confirmation keeps new input fenced, sanitizes errors and never retries automatically", async t => {
  const f = await fixture(t), before = await f.read(); f.controls.failure = true;
  await assert.rejects(f.client.requestQuiesceIdle(), (error: unknown) => statusError(503)(error) && !String(error).includes("PRIVATE_NATIVE_SHUTDOWN_FAILURE"));
  await assert.rejects(f.client.startTurn("late", "not dispatched"), statusError(409));
  await assert.rejects(f.client.requestQuiesceIdle(), statusError(409));
  assert.equal(f.counts.stops, 1); assert.equal(f.quiesced(), false); assert.deepEqual(await f.read(), before);
});

test("lost quiesce acknowledgment does not reopen input or replay the stop request", async t => {
  const f = await fixture(t), before = await f.read(), gate = f.pause("stop");
  const client = new ClaudeCodeWorkerClient(f.connection, 300);
  const stopping = assert.rejects(client.requestQuiesceIdle());
  await bounded(gate.entered); await stopping;
  await assert.rejects(f.client.startTurn("late", "not dispatched"), statusError(409));
  assert.equal(f.counts.stops, 1); assert.equal(f.quiesced(), false); gate.release();
  await bounded(f.bridge.idleQuiesced); assert.equal(f.admission(), 0);
  assert.equal(await f.client.status(), "offline"); assert.deepEqual(await f.read(), before);
});

test("wrong-owner/generation and revoked admission cannot quiesce native work", async t => {
  const f = await fixture(t);
  for (const patch of [{ ownerId: "other-owner" }, { generation: "other-generation" }]) {
    await assert.rejects(new ClaudeCodeWorkerClient({ ...f.connection, ...patch }).requestQuiesceIdle(), statusError(401));
  }
  await f.store.withSessionLock(f.scope.sessionId, f.scope.ownerId, async lease => { await lease.update((await f.read()).revision, { requiresExplicitResume: true }); });
  const fenced = await f.read(); await assert.rejects(f.client.requestQuiesceIdle(), statusError(503));
  assert.equal(f.counts.stops, 0); assert.equal(f.quiesced(), false); assert.deepEqual(await f.read(), fenced);
});
