import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { once } from "node:events";
import { chmod, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire, syncBuiltinESMExports } from "node:module";
import test, { type TestContext } from "node:test";
import type { AgentEvent, AgentTurn, ManagedAgentSession } from "@minu/runtime-core";
import { CodexAgentRuntime, type CodexAgentRuntimeOptions } from "../src/index.js";
import { CodexManagedStore } from "../src/managed-store.js";
import { CodexManagedClient } from "../src/managed-client.js";
import { diagnosticAvailable } from "../src/diagnostic.js";
import { createPendingCodexSession } from "../src/managed-native.js";
import { CodexWorkerClient, type CodexWorkerMethod } from "../src/worker-client.js";

function exists(pid: number): boolean { try { process.kill(pid, 0); return true; } catch { return false; } }
function gate(): { promise: Promise<void>; release(): void } {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}

async function gone(pid: number): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (exists(pid) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(exists(pid), false, "Test-owned worker must exit");
}

async function fixture(t: TestContext, scenario = "normal", overrides: CodexAgentRuntimeOptions = {}) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "codex-public-managed-")));
  const root = join(directory, "managed");
  const log = join(directory, "native.jsonl");
  const store = new CodexManagedStore(root);
  const options: CodexAgentRuntimeOptions = { managedRoot: root, command: process.execPath,
    args: [fileURLToPath(new URL("./fixtures/app-server.js", import.meta.url)), scenario, log],
    requestTimeoutMs: 2_000, shutdownTimeoutMs: 100, ...overrides };
  const runtime = new CodexAgentRuntime(options);
  const pids = new Set<number>();
  const sessions: Array<{ runtime: CodexAgentRuntime; id: string }> = [];
  t.after(async () => {
    for (const session of sessions) await session.runtime.stop(session.id).catch(() => {});
    // Fixture-only cleanup after deliberately fencing/corrupting records. These
    // are exact workers created in this temporary fixture, not production PID
    // discovery or authority to replace an unavailable registration.
    for (const pid of pids) { if (exists(pid)) process.kill(pid, "SIGTERM"); await gone(pid); }
    await rm(directory, { recursive: true, force: true });
  });
  const remember = async (session: ManagedAgentSession, adapter = runtime) => {
    sessions.push({ runtime: adapter, id: session.id });
    const manifest = await store.read(session.id, session.ownerId);
    if (manifest?.worker.state === "ready") pids.add(manifest.worker.connection.pid);
    return session;
  };
  return { directory, root, store, options, runtime, log, pids, remember,
    async create(config: Parameters<typeof runtime.startManaged>[0] = {}, owner = "owner-a") {
      return remember(await runtime.startManaged({ cwd: directory, ...config }, owner));
    },
    async eager() {
      const session = await runtime.start({ cwd: directory });
      sessions.push({ runtime, id: session.id });
      return session;
    },
    async calls(): Promise<Array<Record<string, any>>> {
      try {
        const text = (await readFile(log, "utf8")).trim();
        return text ? text.split("\n").map(line => JSON.parse(line)) : [];
      } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
    },
  };
}

async function settled(runtime: CodexAgentRuntime, id: string, turnId: string): Promise<AgentTurn> {
  const deadline = Date.now() + 4_000;
  while (Date.now() < deadline) {
    const turn = await runtime.turn(id, turnId);
    if (turn && turn.status !== "running") return turn;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error("Public managed turn did not settle");
}

async function dispatched(calls: () => Promise<Array<Record<string, any>>>, count = 1): Promise<void> {
  const deadline = Date.now() + 4_000;
  while (Date.now() < deadline) {
    if ((await calls()).filter(call => call.method === "turn/start").length >= count) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error("Native input was not dispatched");
}

async function observeThrough(stream: AsyncIterableIterator<AgentEvent>, done: (event: AgentEvent) => boolean): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of stream) { events.push(event); if (done(event)) break; }
  return events;
}

function manifestPath(root: string, id: string, ownerId: string): string {
  return join(root, createHash("sha256").update(ownerId).digest("hex"), `${id}.session`, "manifest.json");
}

test("public managed creation saves identity without native launch and reports truthful surfaces", { timeout: 15_000 }, async t => {
  const f = await fixture(t);
  const session = await f.create({ appendSystemPrompt: "PRIVATE_PERSONA", model: { provider: "openai", id: "selected-model" }, reasoningLevel: "high" });
  assert.deepEqual(Object.keys(session).sort(), ["cwd", "id", "ownerId", "ownership", "runtime"]);
  assert.equal(session.ownerId, "owner-a");
  assert.equal(session.cwd, f.directory);
  assert.equal(await f.runtime.status(session.id), "idle");
  assert.deepEqual(await f.runtime.messages(session.id), []);
  assert.equal(await f.runtime.turn(session.id, "missing-turn"), undefined);
  assert.deepEqual(await f.calls(), []);
  assert.equal((await f.store.read(session.id, session.ownerId))?.native.state, "pending");
  const saved = await f.store.read(session.id, session.ownerId);
  assert.deepEqual(await Promise.all([f.runtime.resume(session.id, session.ownerId), f.runtime.resume(session.id, session.ownerId)]), [session, session]);
  assert.deepEqual(await f.store.read(session.id, session.ownerId), saved);
  const inventory = await f.runtime.listManagedSessions("owner-a");
  assert.equal(inventory.length, 1);
  assert.equal(inventory[0].state, "active");
  assert.ok(Object.keys(inventory[0]).every(key => ["id", "ownerId", "state", "createdAt", "updatedAt"].includes(key)));
  assert.equal(JSON.stringify(inventory).includes("PRIVATE_PERSONA"), false);
  assert.equal(JSON.stringify(inventory).includes(f.directory), false);
  assert.deepEqual(await f.runtime.listManagedSessions("other-owner"), []);
  await assert.rejects(f.runtime.inputCapabilities(session.id));
  assert.deepEqual(await f.runtime.sessionCapabilities(session.id), { version: 1, safeActivityEvents: true,
    interrupt: true, reconnectExisting: true, interactiveAttach: false, openDiagnostic: await diagnosticAvailable(), liveSkillVerification: false });
  const stream = f.runtime.events(session.id);
  assert.equal((await stream.next()).value?.type, "status");
  await stream.return?.();
  const aborted = new AbortController(); aborted.abort();
  assert.equal((await f.runtime.activityEvents(session.id, { signal: aborted.signal }).next()).done, true);
  assert.equal(typeof f.runtime.destroy, "function");
  assert.equal(typeof f.runtime.inspectSessionProfile, "function"); assert.equal(typeof f.runtime.inspectSessionEvents, "function"); assert.equal(typeof f.runtime.openDiagnostic, "function");
  for (const method of ["forceStopManaged"]) {
    assert.equal(typeof (f.runtime as any)[method], "undefined");
  }
});

test("managed lifecycle survives actual controller restart, exact history resume and a second suspend", { timeout: 15_000, skip: process.platform !== "darwin" }, async t => {
  const f = await fixture(t, "lifecycle");
  const consume = async (id: string | undefined, turnId: string, input: string) => {
    const child = fork(new URL("./fixtures/managed-runtime-consumer.js", import.meta.url), [], { stdio: ["ignore", "ignore", "ignore", "ipc"] });
    t.after(() => { child.kill("SIGKILL"); }); const exited = once(child, "exit"); const response = once(child, "message");
    child.send({ options: f.options, ownerId: "owner-a", cwd: f.directory, lifecycle: true, id, turnId, input });
    const [result] = await response as any[]; await exited;
    assert.equal(result.ok, true); assert.equal(child.exitCode, 0); return result;
  };
  const first = await consume(undefined, "first", "First prompt");
  assert.equal(first.inventory[0].state, "suspended"); assert.deepEqual(first.prior, []);
  const initial = (await f.store.read(first.session.id, "owner-a"))!;
  assert.ok(initial.version === 5 && initial.history?.verified && initial.worker.state === "retired");
  const second = await consume(first.session.id, "second", "Second prompt");
  assert.equal(second.session.id, first.session.id); assert.deepEqual(second.prior, first.history);
  assert.equal(second.inventory[0].state, "suspended"); assert.ok(second.history.length > first.history.length);
  const current = (await f.store.read(first.session.id, "owner-a"))!;
  assert.deepEqual(current.native, initial.native); assert.notEqual(current.generation, initial.generation);
  assert.ok(current.version === 5 && current.previous?.worker.state === "retired" && current.history?.verified);
  const resumed = await f.remember(await f.runtime.resume(first.session.id, "owner-a"));
  assert.deepEqual(await f.runtime.messages(resumed.id), second.history);
  assert.equal((await f.calls()).filter(call => call.method === "thread/start").length, 1);
  assert.equal((await f.calls()).filter(call => call.method === "thread/resume").length, 2);
  assert.equal((await f.calls()).filter(call => call.method === "turn/start").length, 2);
  await f.runtime.suspend(resumed.id, "owner-a");
});

test("never-used public managed suspension stays lazy across cold resume", { timeout: 15_000, skip: process.platform !== "darwin" }, async t => {
  const f = await fixture(t, "lifecycle"); const session = await f.create();
  await Promise.all([f.runtime.suspend(session.id, session.ownerId), f.runtime.suspend(session.id, session.ownerId)]);
  assert.deepEqual(await f.calls(), []); assert.equal((await f.runtime.listManagedSessions(session.ownerId))[0].state, "suspended");
  await f.remember(await f.runtime.resume(session.id, session.ownerId));
  assert.deepEqual(await f.calls(), []); await f.runtime.send(session.id, "First actual input");
  assert.equal((await f.calls()).filter(c => c.method === "thread/start").length, 1);
  await f.runtime.suspend(session.id, session.ownerId);
});

for (const action of ["suspend", "destroy"] as const) for (const scenario of ["held", "paused-create"]) {
  test(`public ${action} rejects ${scenario} before interrupting or queuing behind preparation`, { timeout: 15_000, skip: process.platform !== "darwin" }, async t => {
    const f = await fixture(t, `lifecycle-${scenario}`); const session = await f.create();
    await f.runtime.startTurn(session.id, "busy", "hello");
    if (scenario === "held") await dispatched(f.calls);
    else {
      const deadline = Date.now() + 4_000;
      while (!(await f.calls()).some(c => c.method === "thread/start") && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
    }
    const before = await f.store.read(session.id, session.ownerId);
    await assert.rejects(f.runtime[action](session.id, session.ownerId));
    assert.deepEqual(await f.store.read(session.id, session.ownerId), before);
    assert.equal((await f.calls()).some(c => c.method === "turn/interrupt"), false);
    if (scenario === "held") await f.runtime.interrupt(session.id); else await writeFile(`${f.log}.release`, "release");
    await settled(f.runtime, session.id, "busy");
    await f.runtime.suspend(session.id, session.ownerId);
    assert.equal((await f.runtime.listManagedSessions(session.ownerId))[0].state, "suspended");
  });
}

for (const inspection of ["mismatch", "cleanup-failure"]) {
  test(`public history ${inspection} cannot grant suspended eligibility`, { timeout: 15_000, skip: process.platform !== "darwin" }, async t => {
    const f = await fixture(t, "lifecycle"); const session = await f.create(); await f.runtime.send(session.id, "preserve this");
    t.mock.method(CodexAgentRuntime.prototype, "inspectNativeHistory", async () => {
      if (inspection === "cleanup-failure") throw new Error("Injected inspection cleanup uncertainty");
      return { kind: "history", digest: "b".repeat(64), turns: 0, items: 0 };
    });
    await assert.rejects(f.runtime.suspend(session.id, session.ownerId));
    const current = (await f.store.read(session.id, session.ownerId))!;
    assert.ok(current.version === 5 && current.worker.state === "retired" && !current.history?.verified);
    assert.equal((await f.runtime.listManagedSessions(session.ownerId))[0].state, "unavailable");
    const starts = (await f.calls()).filter(c => c.method === "thread/start").length;
    await assert.rejects(f.runtime.resume(session.id, session.ownerId));
    assert.equal((await f.calls()).filter(c => c.method === "thread/start").length, starts);
  });
}

test("lost/corrupt persisted native history refuses cold resume without a replacement or retry", { timeout: 15_000, skip: process.platform !== "darwin" }, async t => {
  const f = await fixture(t, "lifecycle"); const session = await f.create(); await f.runtime.send(session.id, "durable input");
  await f.runtime.suspend(session.id, session.ownerId); const saved = (await f.store.read(session.id, session.ownerId))!;
  await writeFile(`${f.log}.history.json`, "[]");
  await assert.rejects(f.runtime.resume(session.id, session.ownerId));
  const failed = (await f.store.read(session.id, session.ownerId))!;
  if (failed.worker.state === "aborted" || failed.worker.state === "reserved") { if (failed.worker.pid) f.pids.add(failed.worker.pid); }
  assert.deepEqual(failed.native, saved.native); assert.ok(failed.version === 5 && failed.previous);
  assert.equal((await f.runtime.listManagedSessions(session.ownerId))[0].state, "unavailable");
  const resumes = (await f.calls()).filter(c => c.method === "thread/resume").length;
  await assert.rejects(f.runtime.resume(session.id, session.ownerId));
  assert.equal((await f.calls()).filter(c => c.method === "thread/resume").length, resumes);
  assert.equal((await f.calls()).filter(c => c.method === "thread/start").length, 1);
});

for (const phase of ["domain", "bridge", "lock-return", "domain-unconfirmed", "ready-after"] as const) {
  test(`resumed startup ${phase} retains exact native cleanup ownership without revoking readiness`, { timeout: 15_000, skip: process.platform !== "darwin" }, async t => {
    const f = await fixture(t, "lifecycle"); const session = await f.create();
    await f.runtime.send(session.id, "Keep this history"); const history = await f.runtime.messages(session.id);
    await f.runtime.suspend(session.id, session.ownerId);
    const cp = createRequire(import.meta.url)("node:child_process") as typeof import("node:child_process");
    const original = cp.fork; let child: ReturnType<typeof original> | undefined, nativePid: number | undefined;
    const mock = t.mock.method(cp, "fork", ((file: Parameters<typeof original>[0], args: string[], options: Parameters<typeof original>[2]) => {
      if (!String(file).endsWith("/src/owned-worker.js")) return original(file, args, options);
      child = original(new URL("./fixtures/registration-worker-fault.js", import.meta.url), [`resume-${phase}`], options);
      return child;
    }) as typeof original);
    syncBuiltinESMExports();
    const attempts = async () => {
      try { return (await readFile(join(f.root, ".resume-stop-attempts"), "utf8")).trim().split("\n").length; }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0; throw error; }
    };
    try {
      await assert.rejects(f.runtime.resume(session.id, session.ownerId));
      assert.ok(child?.pid); f.pids.add(child.pid);
      const calls = await f.calls(); nativePid = calls.filter(call => typeof call.pid === "number").at(-1)!.pid;
      assert.equal(calls.filter(call => call.method === "thread/resume").length, 1);
      assert.equal(calls.filter(call => call.method === "thread/start").length, 1);
      const saved = (await f.store.read(session.id, session.ownerId))!;
      if (phase === "ready-after") {
        assert.equal(saved.worker.state, "ready"); assert.equal(await attempts(), 0);
        assert.ok(exists(nativePid!)); assert.ok(exists(child.pid));
        // Failure after durable readiness cannot revoke a worker another owner-
        // authorized consumer may already have adopted.
        mock.mock.restore(); syncBuiltinESMExports();
        const adopter = new CodexAgentRuntime(f.options);
        await f.remember(await adopter.resume(session.id, session.ownerId), adopter);
        assert.deepEqual(await adopter.messages(session.id), history);
        await adopter.stop(session.id); await gone(nativePid!); await gone(child.pid);
        assert.equal(await attempts(), 1);
      } else {
        assert.equal(saved.worker.state, "aborted"); assert.equal(await attempts(), 1);
        if (phase === "domain-unconfirmed") {
          assert.ok(exists(nativePid!)); assert.ok(exists(child.pid));
          // Rejected cleanup is not successful worker shutdown or permission to
          // resume again. Only this test's exact owned fixtures are cleaned below.
          await assert.rejects(f.runtime.resume(session.id, session.ownerId));
          assert.equal(await attempts(), 1);
        } else { await gone(nativePid!); await gone(child.pid); }
      }
    } finally {
      mock.mock.restore(); syncBuiltinESMExports();
      if (nativePid && exists(nativePid)) { process.kill(nativePid, "SIGTERM"); await gone(nativePid); }
      if (child && child.exitCode === null && child.signalCode === null) {
        child.ref(); const exited = once(child, "exit"); child.kill("SIGKILL"); await exited;
      }
    }
  });
}

for (const state of ["active", "suspended", "unused"] as const) {
  test(`public destroy from a fresh controller removes only ${state} Runtime metadata`, { timeout: 15_000, skip: process.platform !== "darwin" }, async t => {
    const f = await fixture(t, "lifecycle"), session = await f.create();
    if (state !== "unused") await f.runtime.send(session.id, "Preserve native history");
    if (state === "suspended") await f.runtime.suspend(session.id, session.ownerId);
    const history = state === "unused" ? undefined : await readFile(`${f.log}.history.json`, "utf8");
    const peer = await f.create(); const peerBefore = await f.store.read(peer.id, peer.ownerId);
    const fresh = new CodexAgentRuntime(f.options);
    await assert.rejects(fresh.destroy(session.id, "other-owner"));
    await Promise.all([fresh.destroy(session.id, session.ownerId), fresh.destroy(session.id, session.ownerId)]);
    assert.equal(await f.store.read(session.id, session.ownerId), undefined);
    assert.deepEqual((await fresh.listManagedSessions(session.ownerId)).map(s => s.id), [peer.id]);
    assert.deepEqual(await f.store.read(peer.id, peer.ownerId), peerBefore);
    await assert.rejects(fresh.resume(session.id, session.ownerId));
    for (const pid of new Set((await f.calls()).map(call => call.pid).filter((pid): pid is number => typeof pid === "number"))) await gone(pid);
    assert.equal((await f.calls()).filter(call => call.method === "thread/resume").length, 0);
    assert.equal((await f.calls()).filter(call => call.method === "thread/start").length, state === "unused" ? 0 : 1);
    if (history !== undefined) assert.equal(await readFile(`${f.log}.history.json`, "utf8"), history);
    else assert.deepEqual(await f.calls(), []);
  });
}

test("public destroy removes never-launched legacy metadata but never stops uncertain registrations", async t => {
  const f = await fixture(t);
  const pending = await createPendingCodexSession(f.store, { id: "legacy-unlaunched", ownerId: "owner-a", generation: "unused" }, { cwd: f.directory });
  await f.runtime.destroy(pending.id, pending.ownerId);
  assert.equal(await f.store.read(pending.id, pending.ownerId), undefined);
  const live = await f.create(); const before = await f.store.read(live.id, live.ownerId);
  await f.runtime.stop(live.id);
  await assert.rejects(f.runtime.destroy(live.id, live.ownerId));
  assert.deepEqual(await f.store.read(live.id, live.ownerId), before);
  const eager = await f.eager();
  await assert.rejects(f.runtime.destroy(eager.id, "owner-a"));
  assert.equal(await f.runtime.status(eager.id), "idle");
});

for (const leader of ["destroy", "resume"] as const) {
  test(`public ${leader} wins cold destroy/resume contention without metadata or worker resurrection`, { timeout: 15_000, skip: process.platform !== "darwin" }, async t => {
    const f = await fixture(t, "lifecycle"), session = await f.create();
    await f.runtime.send(session.id, "Keep exact history"); const history = await f.runtime.messages(session.id);
    await f.runtime.suspend(session.id, session.ownerId);
    const before = await f.store.read(session.id, session.ownerId), entered = gate(), release = gate();
    const original = CodexManagedStore.prototype.withSessionLock; let first = true;
    t.mock.method(CodexManagedStore.prototype, "withSessionLock", (async function(this: CodexManagedStore, id: string, owner: string, callback: any, timeout?: number) {
      if (id !== session.id || owner !== session.ownerId || !first) return original.call(this, id, owner, callback, timeout);
      first = false;
      return original.call(this, id, owner, async lease => { entered.release(); await release.promise; return callback(lease); }, timeout);
    }) as typeof original);
    const adopter = new CodexAgentRuntime(f.options);
    const runResume = () => adopter.resume(session.id, session.ownerId).then(s => f.remember(s, adopter));
    const leading = leader === "destroy" ? f.runtime.destroy(session.id, session.ownerId) : runResume();
    try {
      await entered.promise;
      const losing = assert.rejects(leader === "destroy" ? runResume() : f.runtime.destroy(session.id, session.ownerId));
      // The contender may read the retired record, but mutation must wait for
      // the same owner/session lock and then reject the winner's changed state.
      release.release(); await Promise.all([leading, losing]);
      if (leader === "destroy") {
        assert.equal(await f.store.read(session.id, session.ownerId), undefined);
        assert.equal((await f.calls()).filter(call => call.method === "thread/resume").length, 0);
      } else {
        const current = (await f.store.read(session.id, session.ownerId))!;
        assert.notEqual(current.generation, before!.generation); assert.equal(current.worker.state, "ready");
        assert.deepEqual(await adopter.messages(session.id), history);
        assert.equal((await f.calls()).filter(call => call.method === "thread/resume").length, 1);
      }
    } finally { release.release(); await leading.catch(() => {}); }
  });
}

test("public stale destroy cannot suspend a replacement generation during shutdown handoff", { timeout: 15_000, skip: process.platform !== "darwin" }, async t => {
  const f = await fixture(t, "lifecycle"), session = await f.create(); await f.runtime.send(session.id, "Preserve history");
  const original = CodexManagedClient.prototype.suspend, adopter = new CodexAgentRuntime(f.options); let interleaved = false;
  t.mock.method(CodexManagedClient.prototype, "suspend", async function(this: CodexManagedClient, ...args: Parameters<typeof original>) {
    if (!interleaved) {
      interleaved = true;
      await adopter.suspend(session.id, session.ownerId);
      await f.remember(await adopter.resume(session.id, session.ownerId), adopter);
    }
    return original.apply(this, args);
  });
  await assert.rejects(f.runtime.destroy(session.id, session.ownerId));
  const current = (await f.store.read(session.id, session.ownerId))!;
  assert.equal(current.worker.state, "ready"); assert.equal(await adopter.status(session.id), "idle");
  assert.equal((await f.calls()).filter(call => call.method === "thread/resume").length, 1);
});

test("public destroy retains metadata after uncertain shutdown/history verification", { timeout: 15_000, skip: process.platform !== "darwin" }, async t => {
  const f = await fixture(t, "lifecycle"), session = await f.create(); await f.runtime.send(session.id, "Keep this history");
  const history = await readFile(`${f.log}.history.json`, "utf8");
  t.mock.method(CodexAgentRuntime.prototype, "inspectNativeHistory", async () => { throw new Error("Injected inspection uncertainty"); });
  await assert.rejects(f.runtime.destroy(session.id, session.ownerId));
  const current = (await f.store.read(session.id, session.ownerId))!;
  assert.equal(current.worker.state, "retired"); assert.equal(current.version === 5 && current.history?.verified, false);
  assert.equal(await readFile(`${f.log}.history.json`, "utf8"), history);
});

test("public destroy full-lock-return uncertainty rejects even after metadata removal", async t => {
  const f = await fixture(t);
  const pending = await createPendingCodexSession(f.store, { id: "unlaunched", ownerId: "owner-a", generation: "unused" }, { cwd: f.directory });
  const original = CodexManagedStore.prototype.withSessionLock; let attempts = 0;
  t.mock.method(CodexManagedStore.prototype, "withSessionLock", (async function(this: CodexManagedStore, ...args: Parameters<typeof original>) {
    const result = await original.apply(this, args);
    if (args[0] === pending.id) { attempts++; throw new Error("Injected destroy full-lock-return failure"); }
    return result;
  }) as typeof original);
  await assert.rejects(f.runtime.destroy(pending.id, pending.ownerId), /uncertain/);
  assert.equal(attempts, 1); assert.equal(await f.store.read(pending.id, pending.ownerId), undefined);
  assert.deepEqual(await f.calls(), []);
});

test("cold resume contention reserves one new worker/native binding", { timeout: 15_000, skip: process.platform !== "darwin" }, async t => {
  const f = await fixture(t, "lifecycle"); const session = await f.create(); await f.runtime.send(session.id, "once");
  await f.runtime.suspend(session.id, session.ownerId); const one = new CodexAgentRuntime(f.options), two = new CodexAgentRuntime(f.options);
  const results = await Promise.allSettled([one.resume(session.id, session.ownerId), two.resume(session.id, session.ownerId)]);
  assert.ok(results.some(r => r.status === "fulfilled"));
  for (const [index, result] of results.entries()) if (result.status === "fulfilled") await f.remember(result.value, index === 0 ? one : two);
  assert.equal((await f.calls()).filter(c => c.method === "thread/resume").length, 1);
  assert.equal((await f.calls()).filter(c => c.method === "thread/start").length, 1);
  await assert.rejects(one.suspend(session.id, "other-owner"));
});

test("unsupported platforms retain v4 creation/controls and explicitly refuse suspension", { timeout: 15_000 }, async t => {
  const f = await fixture(t); const descriptor = Object.getOwnPropertyDescriptor(process, "platform")!;
  try {
    Object.defineProperty(process, "platform", { value: "linux" }); const session = await f.create();
    const saved = (await f.store.read(session.id, session.ownerId))!; assert.equal(saved.version, 4);
    await assert.rejects(f.runtime.suspend(session.id, session.ownerId));
    assert.equal(await f.runtime.status(session.id), "idle"); assert.deepEqual(await f.store.read(session.id, session.ownerId), saved);
    await f.runtime.resume(session.id, session.ownerId);
  } finally { Object.defineProperty(process, "platform", descriptor); }
});

test("invalid managed launch configuration is refused before persistence or native launch", async t => {
  const f = await fixture(t);
  for (const config of [{ skillIds: ["invalid"] }, { systemPrompt: "a", appendSystemPrompt: "b" },
    { reasoningLevel: "unsupported" }, { model: { provider: "", id: "model" } }]) {
    await assert.rejects(f.runtime.startManaged({ cwd: f.directory, ...config } as any, "owner-a"));
  }
  assert.deepEqual(await f.runtime.listManagedSessions("owner-a"), []);
  assert.deepEqual(await f.calls(), []);
});

test("native launch failure is deferred to first input and retained results remain publicly recoverable", { timeout: 15_000 }, async t => {
  const f = await fixture(t, "mismatch-model");
  const session = await f.create({ model: { provider: "openai", id: "selected-model" } });
  assert.deepEqual(await f.calls(), []);
  await f.runtime.startTurn(session.id, "failed-launch", "hello");
  const failed = await settled(f.runtime, session.id, "failed-launch");
  assert.equal(failed.status, "failed");
  assert.equal(await f.runtime.status(session.id), "offline");
  assert.equal((await f.runtime.listManagedSessions(session.ownerId))[0].state, "unavailable");
  const fresh = new CodexAgentRuntime(f.options);
  await f.remember(await fresh.resume(session.id, session.ownerId), fresh);
  assert.deepEqual(await fresh.turn(session.id, "failed-launch"), failed);
  assert.deepEqual(await fresh.startTurn(session.id, "failed-launch", "hello"), failed);
  await assert.rejects(fresh.startTurn(session.id, "new-work", "no"));
  assert.equal((await f.calls()).filter(call => call.method === "thread/start").length, 1);
  assert.equal((await f.calls()).filter(call => call.method === "turn/start").length, 0);
});

test("invalid managed first input cannot allocate native state", { timeout: 15_000 }, async t => {
  const f = await fixture(t);
  const { id, ownerId } = await f.create();
  await assert.rejects(f.runtime.send(id, ""));
  await assert.rejects(f.runtime.startTurn(id, "", "hello"));
  await assert.rejects(f.runtime.startTurn(id, "x".repeat(257), "hello"));
  await assert.rejects(f.runtime.startTurn(id, "oversized", "x".repeat(1024 * 1024 + 1)));
  await assert.rejects(f.runtime.send(id, "image", [{ type: "image", mimeType: "image/png", data: "invalid" }]));
  assert.equal((await f.store.read(id, ownerId))?.native.state, "pending");
  assert.deepEqual(await f.calls(), []);
  assert.equal(await f.runtime.status(id), "idle");
});

test("public controls retain retries/conflicts and bind one native thread across turns", { timeout: 15_000 }, async t => {
  const f = await fixture(t, "held");
  const { id, ownerId } = await f.create();
  assert.equal((await f.runtime.startTurn(id, "turn-a", "hello")).status, "running");
  assert.equal((await f.runtime.startTurn(id, "turn-a", "hello")).status, "running");
  await assert.rejects(f.runtime.startTurn(id, "turn-a", "conflict"));
  await assert.rejects(f.runtime.startTurn(id, "other-turn", "busy"));
  await dispatched(f.calls);
  assert.equal(await f.runtime.status(id), "working");
  const bound = (await f.store.read(id, ownerId))!.native;
  assert.equal(bound.state, "bound");
  await f.runtime.steer(id, "Focus on errors");
  await f.runtime.interrupt(id);
  const terminal = await settled(f.runtime, id, "turn-a");
  assert.equal(terminal.status, "interrupted");
  assert.deepEqual(await f.runtime.startTurn(id, "turn-a", "hello"), terminal);
  await f.runtime.startTurn(id, "turn-b", "continue");
  await dispatched(f.calls, 2);
  assert.deepEqual((await f.store.read(id, ownerId))!.native, bound);
  assert.equal((await f.calls()).filter(call => call.method === "thread/start").length, 1);
  assert.equal((await f.calls()).filter(call => call.method === "turn/start").length, 2);
  assert.equal((await f.calls()).filter(call => call.method === "turn/steer").length, 1);
});

test("managed send waits for settlement, rejects interruption and never replays", { timeout: 15_000 }, async t => {
  const f = await fixture(t, "held");
  const { id } = await f.create();
  let finished = false;
  const sending = f.runtime.send(id, "hello").finally(() => { finished = true; });
  const rejected = assert.rejects(sending, /interrupted/);
  await dispatched(f.calls);
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(finished, false);
  await f.runtime.interrupt(id);
  await rejected;
  assert.equal((await f.calls()).filter(call => call.method === "turn/start").length, 1);
});

for (const scenario of ["normal", "failed"]) {
  test(`managed send surfaces ${scenario} settlement and normalized history`, { timeout: 15_000 }, async t => {
    const f = await fixture(t, scenario);
    const { id } = await f.create();
    if (scenario === "failed") await assert.rejects(f.runtime.send(id, "hello"), /native turn failed/);
    else {
      await f.runtime.send(id, "hello");
      assert.equal((await f.runtime.messages(id)).at(-1)?.content, "Answer 1: café 🐈");
    }
    assert.equal(await f.runtime.status(id), "idle");
    const messages = await f.runtime.messages(id);
    assert.equal(messages[0].content, "hello");
    messages[0].content = "mutated";
    assert.equal((await f.runtime.messages(id))[0].content, "hello");
    assert.equal((await f.calls()).filter(call => call.method === "thread/start").length, 1);
    assert.equal((await f.calls()).filter(call => call.method === "turn/start").length, 1);
  });
}

test("fresh consumer exit/resume preserves running and terminal results with one dispatch", { timeout: 15_000 }, async t => {
  const f = await fixture(t, "held");
  const consume = async (id?: string): Promise<{ session: ManagedAgentSession; turn: AgentTurn }> => {
    const child = fork(new URL("./fixtures/managed-runtime-consumer.js", import.meta.url), [], { stdio: ["ignore", "ignore", "ignore", "ipc"] });
    t.after(() => { child.kill("SIGKILL"); });
    const exited = once(child, "exit");
    const reply = once(child, "message");
    child.send({ options: f.options, ownerId: "owner-a", cwd: f.directory, id, turnId: "retained", input: "hello" });
    const [result] = await reply;
    assert.equal(result.ok, true);
    await exited;
    assert.equal(child.exitCode, 0);
    return result;
  };
  const first = await consume();
  const adopted = await f.remember(await f.runtime.resume(first.session.id, "owner-a"));
  assert.deepEqual(adopted, first.session);
  await dispatched(f.calls);
  assert.equal((await f.runtime.turn(adopted.id, "retained"))?.status, "running");
  const fresh = new CodexAgentRuntime(f.options);
  await fresh.resume(adopted.id, "owner-a");
  const stream = fresh.events(adopted.id);
  assert.equal((await stream.next()).value?.type, "status");
  const subsequent = observeThrough(stream, event => event.type === "turn_completed");
  await f.runtime.interrupt(adopted.id);
  assert.ok((await subsequent).some(event => event.type === "tool_started"));
  const terminal = await settled(f.runtime, adopted.id, "retained");
  const later = await consume(adopted.id);
  assert.deepEqual(later.session, first.session);
  assert.deepEqual(later.turn, terminal);
  assert.equal((await f.calls()).filter(call => call.method === "turn/start").length, 1);
});

test("pending inventory is read-only and resume launches only its never-attempted worker", { timeout: 15_000 }, async t => {
  const f = await fixture(t, "normal", { sandbox: "workspace-write" });
  const identity = { id: "pending-id", ownerId: "owner-a", generation: "pending-generation" };
  await createPendingCodexSession(f.store, identity, { cwd: f.directory }, "read-only");
  const before = await f.store.read(identity.id, identity.ownerId);
  assert.equal((await f.runtime.listManagedSessions(identity.ownerId))[0].state, "suspended");
  assert.deepEqual(await f.store.read(identity.id, identity.ownerId), before);
  const session = await f.remember(await f.runtime.resume(identity.id, identity.ownerId));
  assert.equal(session.id, identity.id);
  assert.deepEqual(await f.calls(), []);
  await f.runtime.send(session.id, "hello");
  assert.equal((await f.calls()).find(call => call.method === "thread/start")!.params.sandbox, "read-only");
});

test("wrong-owner resume does not authorize routing or poison later correct-owner resume", { timeout: 15_000 }, async t => {
  const f = await fixture(t);
  const session = await f.create();
  const fresh = new CodexAgentRuntime(f.options);
  await assert.rejects(fresh.status(session.id), /Unknown Codex/);
  await assert.rejects(fresh.resume(session.id, "owner-b"));
  await assert.rejects(fresh.startTurn(session.id, "unbound", "no"), /Unknown Codex/);
  await f.remember(await fresh.resume(session.id, session.ownerId), fresh);
  assert.equal(await fresh.status(session.id), "idle");
  assert.deepEqual(await fresh.listManagedSessions("owner-b"), []);
  assert.deepEqual(await f.calls(), []);
});

test("generated managed and eager ID collisions cannot overwrite an existing managed binding", { timeout: 15_000 }, async t => {
  const f = await fixture(t);
  const session = await f.create();
  const before = await f.store.read(session.id, session.ownerId);
  const crypto = createRequire(import.meta.url)("node:crypto") as typeof import("node:crypto");
  const uuid = crypto.randomUUID;
  crypto.randomUUID = () => session.id as ReturnType<typeof uuid>;
  syncBuiltinESMExports();
  try {
    await assert.rejects(f.runtime.startManaged({ cwd: f.directory }, session.ownerId), /identity collision/);
    await assert.rejects(f.runtime.start({ cwd: f.directory }), /identity collision/);
  } finally { crypto.randomUUID = uuid; syncBuiltinESMExports(); }
  assert.deepEqual(await f.store.read(session.id, session.ownerId), before);
  assert.equal(await f.runtime.status(session.id), "idle");
  assert.deepEqual(await f.runtime.messages(session.id), []);
  const calls = await f.calls();
  assert.equal(calls.filter(call => call.method === "thread/start").length, 1);
  assert.equal(exists(calls[0].pid), false, "The colliding eager startup must clean up its own native process");
});

test("different-owner and in-process ID collisions cannot overwrite local routing", { timeout: 15_000 }, async t => {
  const f = await fixture(t);
  const identity = { id: "same-id", ownerId: "owner-a", generation: "generation-a" };
  await createPendingCodexSession(f.store, identity, { cwd: f.directory });
  await createPendingCodexSession(f.store, { ...identity, ownerId: "owner-b" }, { cwd: f.directory });
  const resumed = await Promise.allSettled([f.runtime.resume(identity.id, identity.ownerId), f.runtime.resume(identity.id, "owner-b")]);
  assert.equal(resumed[0].status, "fulfilled");
  assert.equal(resumed[1].status, "rejected");
  await f.remember((resumed[0] as PromiseFulfilledResult<ManagedAgentSession>).value);
  assert.equal((await f.store.read(identity.id, "owner-b"))?.worker.state, "none");
  await assert.rejects(f.runtime.resume(identity.id, "owner-b"));
  await f.runtime.send(identity.id, "owner-a-input");
  assert.equal((await f.runtime.messages(identity.id))[0].content, "owner-a-input");
  const eager = await f.eager();
  await createPendingCodexSession(f.store, { ...identity, id: eager.id, ownerId: "owner-c" }, { cwd: f.directory });
  await assert.rejects(f.runtime.resume(eager.id, "owner-c"), /in-process/);
  assert.equal((await f.store.read(eager.id, "owner-c"))?.worker.state, "none");
  await f.runtime.send(eager.id, "eager-input");
  assert.equal((await f.runtime.messages(eager.id))[0].content, "eager-input");
});

for (const patch of [{ generation: "new-generation" }, { requiresExplicitResume: true }]) {
  test(`persisted ${Object.keys(patch)[0]} fences public control and allowStopped cannot clear it`, { timeout: 15_000 }, async t => {
    const f = await fixture(t);
    const session = await f.create();
    const current = await f.store.read(session.id, session.ownerId);
    await f.store.update(session.id, session.ownerId, current!.revision, patch);
    const fenced = await f.store.read(session.id, session.ownerId);
    assert.equal(await f.runtime.status(session.id), "offline");
    await assert.rejects(f.runtime.startTurn(session.id, "stale", "no"));
    await assert.rejects(f.runtime.messages(session.id));
    await assert.rejects(f.runtime.resume(session.id, session.ownerId, { allowStopped: true }));
    await assert.rejects(new CodexAgentRuntime(f.options).connectManaged(session.id, session.ownerId));
    assert.equal((await f.runtime.listManagedSessions(session.ownerId))[0].state, "unavailable");
    assert.deepEqual(await f.store.read(session.id, session.ownerId), fenced);
    assert.deepEqual(await f.calls(), []);
  });
}

for (const state of ["reserved", "aborted", "creating", "bound"] as const) {
  test(`public resume refuses ${state} material instead of cold allocation/replacement`, async t => {
    const f = await fixture(t);
    const identity = { id: "unavailable-id", ownerId: "owner-a", generation: "generation-a" };
    await createPendingCodexSession(f.store, identity, { cwd: f.directory });
    await f.store.withSessionLock(identity.id, identity.ownerId, async lease => {
      const current = await f.store.read(identity.id, identity.ownerId);
      if (state === "reserved" || state === "aborted") {
        const reserved = await lease.reserveWorker(current!.revision, "claim-a");
        if (state === "aborted") await lease.abortWorkerStartup(reserved.revision, "claim-a", process.pid);
      } else {
        const creating = await lease.beginNativeCreation(current!.revision);
        if (state === "bound") await lease.bindNativeThread(creating.revision, "existing-native-thread");
      }
    });
    const before = await f.store.read(identity.id, identity.ownerId);
    await assert.rejects(f.runtime.resume(identity.id, identity.ownerId));
    assert.equal((await f.runtime.listManagedSessions(identity.ownerId))[0].state, "unavailable");
    assert.deepEqual(await f.store.read(identity.id, identity.ownerId), before);
    assert.deepEqual(await f.calls(), []);
  });
}

test("overlapping managed stop calls share one pending confirmation", { timeout: 15_000 }, async t => {
  // A deliberately slow native shutdown gives the signal observation a real
  // pending-native window; this does not raise any existing test deadline.
  const f = await fixture(t, "ignore-term", { shutdownTimeoutMs: 1_000 });
  const session = await f.create();
  await f.runtime.startTurn(session.id, "active-stop", "hello");
  await dispatched(f.calls);
  const request = CodexWorkerClient.prototype.request;
  const nativePid = (await f.calls()).find(call => typeof call.pid === "number")!.pid;
  const confirmation = gate();
  let stops = 0;
  t.mock.method(CodexWorkerClient.prototype, "request", async function<T>(this: CodexWorkerClient, method: CodexWorkerMethod, args?: { turnId?: string; input?: string }): Promise<T> {
    if (method !== "stop") return await request.call(this, method, args) as T;
    stops++;
    const result = await request.call(this, method, args);
    await confirmation.promise;
    return result as T;
  });
  const first = f.runtime.stop(session.id);
  let both!: Promise<PromiseSettledResult<void>[]>;
  try {
    const signalled = (async () => {
      const deadline = Date.now() + 4_000;
      while (Date.now() < deadline) {
        if ((await f.calls()).some(call => call.signal === "SIGTERM")) return;
        await new Promise(resolve => setTimeout(resolve, 5));
      }
      throw new Error("Native shutdown did not begin");
    })();
    await Promise.race([signalled, first.then(() => { throw new Error("Confirmation was not held"); })]);
    assert.equal(exists(nativePid), true, "Native process must still be alive when the repeat is issued");
    const repeated = f.runtime.stop(session.id);
    both = Promise.allSettled([first, repeated]);
    assert.equal(stops, 1);
  } finally { confirmation.release(); }
  assert.deepEqual((await both).map(result => result.status), ["fulfilled", "fulfilled"]);
  await f.runtime.stop(session.id);
  assert.equal(stops, 1);
  assert.equal(await f.runtime.status(session.id), "offline");
});

for (const phase of ["pending", "confirmed"]) {
  test(`same-worker resume preserves ${phase} stop state across a delayed rebind`, { timeout: 15_000 }, async t => {
    const f = await fixture(t);
    const session = await f.create();
    const verify = CodexWorkerClient.prototype.verifyIdentity;
    const authenticated = gate();
    const resumeGate = gate();
    const stopped = gate();
    const stopGate = gate();
    const request = CodexWorkerClient.prototype.request;
    let stops = 0;
    t.mock.method(CodexWorkerClient.prototype, "verifyIdentity", async function(this: CodexWorkerClient) {
      await verify.call(this);
      authenticated.release();
      await resumeGate.promise;
    });
    t.mock.method(CodexWorkerClient.prototype, "request", async function<T>(this: CodexWorkerClient, method: CodexWorkerMethod, args?: { turnId?: string; input?: string }): Promise<T> {
      if (method === "stop") stops++;
      const result = await request.call(this, method, args);
      if (method === "stop") { stopped.release(); if (phase === "pending") await stopGate.promise; }
      return result as T;
    });
    const resuming = f.runtime.resume(session.id, session.ownerId);
    let first!: Promise<void>;
    let both!: Promise<PromiseSettledResult<void>[]>;
    try {
      await Promise.race([authenticated.promise, resuming.then(() => { throw new Error("Resume was not paused"); })]);
      first = f.runtime.stop(session.id);
      await Promise.race([stopped.promise, first.then(() => { throw new Error("Stop did not reach confirmation"); })]);
      if (phase === "confirmed") await first;
      resumeGate.release();
      assert.deepEqual(await resuming, session);
      both = Promise.allSettled([first, f.runtime.stop(session.id)]);
      assert.equal(stops, 1, "Re-authenticating the same worker must preserve shutdown state");
    } finally { resumeGate.release(); stopGate.release(); }
    assert.deepEqual((await both).map(result => result.status), ["fulfilled", "fulfilled"]);
    await f.runtime.stop(session.id);
    assert.equal(stops, 1);
    assert.equal(await f.runtime.status(session.id), "offline");
  });
}

for (const failure of ["rejected", "invalid-confirmation"]) {
  test(`concurrent ${failure} stop results remain failures and allow a later explicit attempt`, { timeout: 15_000 }, async t => {
    const f = await fixture(t);
    const session = await f.create();
    const request = CodexWorkerClient.prototype.request;
    const entered = gate();
    const attempt = gate();
    let stops = 0;
    t.mock.method(CodexWorkerClient.prototype, "request", async function<T>(this: CodexWorkerClient, method: CodexWorkerMethod, args?: { turnId?: string; input?: string }): Promise<T> {
      if (method === "stop" && ++stops === 1) {
        entered.release();
        await attempt.promise;
        if (failure === "rejected") throw new Error("injected unconfirmed stop failure");
        return {} as T; // Malformed transport success is not shutdown confirmation.
      }
      return await request.call(this, method, args) as T;
    });
    const first = f.runtime.stop(session.id);
    let results!: Promise<PromiseSettledResult<void>[]>;
    try {
      await entered.promise;
      results = Promise.allSettled([first, f.runtime.stop(session.id)]);
      assert.equal(stops, 1);
    } finally { attempt.release(); }
    assert.deepEqual((await results).map(result => result.status), ["rejected", "rejected"]);
    assert.equal(await f.runtime.status(session.id), "idle");
    await f.runtime.stop(session.id); // New explicit call, not an automatic retry.
    assert.equal(stops, 2);
    await f.runtime.stop(session.id);
    assert.equal(stops, 2);
  });
}

test("lost stop acknowledgment is not cached as successful shutdown", { timeout: 15_000 }, async t => {
  const f = await fixture(t);
  const session = await f.create();
  const request = CodexWorkerClient.prototype.request;
  let stops = 0;
  t.mock.method(CodexWorkerClient.prototype, "request", async function<T>(this: CodexWorkerClient, method: CodexWorkerMethod, args?: { turnId?: string; input?: string }): Promise<T> {
    if (method === "stop") stops++;
    const result = await request.call(this, method, args);
    if (method === "stop" && stops === 1) throw new Error("injected lost stop acknowledgment");
    return result as T;
  });
  await assert.rejects(f.runtime.stop(session.id), /lost stop acknowledgment/);
  await assert.rejects(f.runtime.stop(session.id));
  assert.equal(stops, 2, "Unreachability must not become cached success");
  assert.equal(await f.runtime.status(session.id), "offline");
});

test("stop confirmation is not reused for a different authorized worker under the same Runtime ID", { timeout: 15_000 }, async t => {
  const first = await fixture(t);
  const session = await first.create();
  await first.runtime.stop(session.id);
  const second = await fixture(t);
  await createPendingCodexSession(second.store, { id: session.id, ownerId: session.ownerId, generation: "second-generation" }, { cwd: second.directory });
  await second.remember(await second.runtime.resume(session.id, session.ownerId));
  const current = await second.store.read(session.id, session.ownerId);
  assert.equal(current?.worker.state, "ready");
  // Fixture-only authoritative descriptor substitution; no production replacement
  // API is added. Both descriptors identify real, separately authenticated workers.
  await writeFile(manifestPath(first.root, session.id, session.ownerId), JSON.stringify(current));
  await first.runtime.resume(session.id, session.ownerId);
  assert.equal(await first.runtime.status(session.id), "idle");
  await first.runtime.stop(session.id);
  if (current?.worker.state === "ready") await gone(current.worker.connection.pid);
  assert.equal(await first.runtime.status(session.id), "offline");
});

test("managed streams normalize live events before native dispatch with stable caller IDs", { timeout: 15_000 }, async t => {
  const f = await fixture(t);
  const session = await f.create();
  const stream = f.runtime.events(session.id);
  const snapshot = (await stream.next()).value;
  assert.equal(snapshot?.type, "status");
  assert.deepEqual(await f.calls(), [], "Observation must not allocate Codex");
  const observed = observeThrough(stream, event => event.type === "turn_completed");
  await f.runtime.startTurn(session.id, "public-operation", "PRIVATE prompt");
  const events = await observed;
  assert.ok(events.every(event => event.sessionId === session.id));
  assert.equal(events.filter(event => event.type === "turn_started" && event.operationId === "public-operation").length, 1);
  assert.equal(events.filter(event => event.type === "turn_completed" && event.operationId === "public-operation").length, 1);
  assert.ok(events.some(event => event.type === "message_delta" && event.delta === "Answer delta"));
  assert.ok(events.some(event => event.type === "tool_started"));
  assert.ok(events.some(event => event.type === "tool_completed"));
  assert.equal(JSON.stringify(events).includes("native-thread"), false);
  assert.equal((await f.calls()).filter(call => call.method === "turn/start").length, 1);
});

test("safe activity failure hides private decoder text through the public API", { timeout: 15_000 }, async t => {
  const f = await fixture(t);
  const session = await f.create();
  const saved = await f.store.read(session.id, session.ownerId);
  assert.ok(saved && saved.worker.state === "ready");
  const c = saved.worker.connection;
  const identity = { version: c.version, ownerId: c.ownerId, sessionId: c.sessionId,
    generation: c.generation, pid: c.pid, claimId: c.claimId };
  const canary = "SECRETVALUE";
  const original = globalThis.fetch;
  let subscriptions = 0;
  t.mock.method(globalThis, "fetch", (url: string | URL | Request, options?: RequestInit) => {
    if (!String(url).endsWith("/events")) return original(url, options);
    subscriptions++;
    return Promise.resolve(new Response(JSON.stringify({ ready: 1, identity }) + "\n" + canary + "\n", {
      headers: { "content-type": "application/x-ndjson", "x-minu-runtime-events": "1" },
    }));
  });
  const activity = f.runtime.activityEvents(session.id, { signal: new AbortController().signal });
  await assert.rejects(activity.next(), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.equal(error.message, "Codex activity observation failed");
    assert.equal(Object.hasOwn(error, "cause"), false);
    assert.equal(String(error.stack).includes(canary), false);
    assert.equal(JSON.stringify(Object.getOwnPropertyDescriptors(error)).includes(canary), false);
    return true;
  });
  await activity.return?.();
  // Raw events remain diagnostic; only the presentation-safe boundary sanitizes.
  const raw = f.runtime.events(session.id);
  await assert.rejects(raw.next(), (error: unknown) => error instanceof Error && error.message.includes(canary));
  await raw.return?.();
  const fresh = new CodexAgentRuntime(f.options);
  assert.throws(() => fresh.events(session.id), /Unknown Codex/);
  const unbound = fresh.activityEvents(session.id, { signal: new AbortController().signal });
  await assert.rejects(unbound.next(), /^Error: Codex activity observation failed$/);
  assert.equal(subscriptions, 2, "Unbound activity must not discover or subscribe");
  assert.equal(await f.runtime.status(session.id), "idle");
  assert.deepEqual(await f.store.read(session.id, session.ownerId), saved);
  assert.deepEqual(await f.calls(), []);
});

test("managed safe activity is coalesced, allowlisted and abortable while idle", { timeout: 15_000 }, async t => {
  const f = await fixture(t);
  const session = await f.create();
  const original = CodexWorkerClient.prototype.events;
  const opened = gate();
  t.mock.method(CodexWorkerClient.prototype, "events", function(this: CodexWorkerClient) {
    const stream = original.call(this); void stream.ready.then(opened.release); return stream;
  });
  const controller = new AbortController();
  const stream = f.runtime.activityEvents(session.id, { signal: controller.signal });
  const first = stream.next();
  await opened.promise;
  assert.deepEqual(await f.calls(), []);
  await f.runtime.startTurn(session.id, "safe-activity", "PRIVATE prompt");
  const activity = [(await first).value!, (await stream.next()).value!, (await stream.next()).value!];
  assert.deepEqual(activity.map(event => event.phase), ["working", "using_tools", "responding"]);
  assert.ok(activity.every(event => Object.keys(event).sort().join(",") === "observedAt,phase"));
  const blocked = stream.next(); controller.abort();
  assert.equal((await blocked).done, true);
  assert.equal((await stream.return?.())?.done, true);
  assert.equal((await settled(f.runtime, session.id, "safe-activity")).status, "completed");
});

test("managed idle return and already-aborted activity release observation without stopping work", { timeout: 15_000 }, async t => {
  const f = await fixture(t, "held");
  const session = await f.create();
  const idle = f.runtime.events(session.id);
  await idle.next();
  const waiting = idle.next();
  await idle.return?.();
  assert.equal((await waiting).done, true);
  const aborted = new AbortController(); aborted.abort();
  assert.equal((await f.runtime.activityEvents(session.id, { signal: aborted.signal }).next()).done, true);
  assert.deepEqual(await f.calls(), []);
  await f.runtime.startTurn(session.id, "still-running", "hello");
  await dispatched(f.calls);
  const live = f.runtime.events(session.id); await live.next();
  await live.return?.();
  assert.equal((await f.runtime.turn(session.id, "still-running"))?.status, "running");
  assert.equal((await f.calls()).filter(call => call.method === "turn/start").length, 1);
});

for (const fence of ["generation", "explicit"]) {
  test(`existing managed stream closes after persisted ${fence} fencing while idle`, { timeout: 15_000 }, async t => {
    const f = await fixture(t);
    const session = await f.create();
    const stream = f.runtime.events(session.id); await stream.next();
    const rejected = assert.rejects(stream.next());
    const path = manifestPath(f.root, session.id, session.ownerId);
    const manifest = JSON.parse(await readFile(path, "utf8"));
    if (fence === "generation") manifest.generation = "changed-generation";
    else manifest.requiresExplicitResume = true;
    await writeFile(path, JSON.stringify(manifest));
    await rejected;
    await stream.return?.();
    assert.deepEqual(await f.calls(), []);
  });
}

test("preparation failure emits one caller-correlated terminal event without native input", { timeout: 15_000 }, async t => {
  const f = await fixture(t, "mismatch-model");
  const session = await f.create({ model: { provider: "openai", id: "selected-model" } });
  const stream = f.runtime.events(session.id); await stream.next();
  const observed = observeThrough(stream, event => event.type === "status" && event.status === "offline");
  await f.runtime.startTurn(session.id, "failed-preparation", "hello");
  const events = await observed;
  assert.equal(events.filter(event => event.type === "turn_started").length, 1);
  assert.equal(events.filter(event => event.type === "turn_completed" && event.operationId === "failed-preparation").length, 1);
  assert.ok(events.some(event => event.type === "error"));
  assert.equal((await f.runtime.turn(session.id, "failed-preparation"))?.status, "failed");
  assert.equal((await f.calls()).filter(call => call.method === "turn/start").length, 0);
});

test("normal managed stop closes an idle stream and retains shared stop confirmation", { timeout: 15_000 }, async t => {
  const f = await fixture(t);
  const session = await f.create();
  const stream = f.runtime.events(session.id); await stream.next();
  const ended = (async () => { try { for await (const _event of stream) {} } catch { /* Explicit connection gap on close is permitted. */ } })();
  await Promise.all([f.runtime.stop(session.id), f.runtime.stop(session.id)]);
  await ended;
  await f.runtime.stop(session.id);
  assert.deepEqual(await f.calls(), []);
});

test("interrupt acknowledgment alone does not emit managed turn completion", { timeout: 15_000 }, async t => {
  const f = await fixture(t, "interrupt-ack-only");
  const session = await f.create();
  const stream = f.runtime.events(session.id); await stream.next();
  const events: AgentEvent[] = [];
  const reading = (async () => { for await (const event of stream) events.push(event); })();
  await f.runtime.startTurn(session.id, "not-settled", "hello");
  await dispatched(f.calls);
  await f.runtime.interrupt(session.id);
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal((await f.runtime.turn(session.id, "not-settled"))?.status, "running");
  assert.equal(events.some(event => event.type === "turn_completed"), false);
  await stream.return?.(); await reading;
});

test("safe managed activity is unverified when a reachable peer lacks the stream endpoint", { timeout: 15_000 }, async t => {
  const f = await fixture(t);
  const session = await f.create();
  const original = globalThis.fetch;
  t.mock.method(globalThis, "fetch", (url: string | URL | Request, options?: RequestInit) => {
    if (String(url).endsWith("/events")) return Promise.resolve(new Response("Not found", { status: 404 }));
    return original(url, options);
  });
  assert.equal((await f.runtime.sessionCapabilities(session.id)).safeActivityEvents, false);
  assert.equal(await f.runtime.status(session.id), "idle");
  assert.deepEqual(await f.calls(), []);
});

test("normal managed stop preserves bound material and refuses cold resume", { timeout: 15_000 }, async t => {
  const f = await fixture(t);
  const session = await f.create();
  await f.runtime.send(session.id, "hello");
  await f.runtime.stop(session.id);
  await f.runtime.stop(session.id);
  assert.equal(await f.runtime.status(session.id), "offline");
  const stopped = await f.store.read(session.id, session.ownerId);
  assert.equal(stopped?.native.state, "bound");
  assert.equal((await f.runtime.listManagedSessions(session.ownerId))[0].state, "unavailable");
  const fresh = new CodexAgentRuntime(f.options);
  await assert.rejects(fresh.resume(session.id, session.ownerId, { allowStopped: true }));
  await assert.rejects(f.runtime.inputCapabilities(session.id));
  assert.deepEqual(await f.store.read(session.id, session.ownerId), stopped);
  assert.equal((await f.calls()).filter(call => call.method === "thread/start").length, 1);
  assert.equal((await f.calls()).filter(call => call.method === "thread/resume").length, 0);
});

for (const unsafe of ["public", "corrupt", "symlink", "missing-manifest"]) {
  test(`inventory and resume surface sanitized failures for ${unsafe} records`, async t => {
    const f = await fixture(t);
    const identity = { id: "unsafe-id", ownerId: "owner-a", generation: "generation-a" };
    await createPendingCodexSession(f.store, identity, { cwd: f.directory, appendSystemPrompt: "PRIVATE_SECRET_PERSONA" });
    const path = manifestPath(f.root, identity.id, identity.ownerId);
    const original = await readFile(path, "utf8");
    if (unsafe === "public") await chmod(path, 0o644);
    else if (unsafe === "corrupt") await writeFile(path, "{corrupt");
    else if (unsafe === "missing-manifest") await rm(path);
    else {
      const target = join(f.directory, "target");
      await writeFile(target, original, { mode: 0o600 }); await rm(path); await symlink(target, path);
    }
    await assert.rejects(f.runtime.listManagedSessions(identity.ownerId), error => {
      assert.match((error as Error).message, /inventory.*unavailable/);
      assert.equal((error as Error).message.includes(f.directory), false);
      assert.equal((error as Error).message.includes("PRIVATE_SECRET_PERSONA"), false);
      return true;
    });
    await assert.rejects(f.runtime.resume(identity.id, identity.ownerId), /unavailable/);
    assert.deepEqual(await f.runtime.listManagedSessions("other-owner"), []);
    if (unsafe === "public") assert.equal((await stat(path)).mode & 0o777, 0o644);
    if (unsafe === "corrupt") assert.equal(await readFile(path, "utf8"), "{corrupt");
    assert.deepEqual(await f.calls(), []);
  });
}

test("inventory detects corruption introduced while live authentication is in flight", { timeout: 15_000 }, async t => {
  const f = await fixture(t);
  const session = await f.create();
  const path = manifestPath(f.root, session.id, session.ownerId);
  const original = await readFile(path, "utf8");
  const verify = CodexWorkerClient.prototype.verifyIdentity;
  let corrupted = false;
  t.mock.method(CodexWorkerClient.prototype, "verifyIdentity", async function(this: CodexWorkerClient) {
    await verify.call(this);
    if (!corrupted) { corrupted = true; await writeFile(path, "{corrupt-during-read"); }
  });
  await assert.rejects(f.runtime.listManagedSessions(session.ownerId), /inventory.*unavailable/);
  assert.equal(await readFile(path, "utf8"), "{corrupt-during-read");
  await writeFile(path, original); // Explicit fixture cleanup, not runtime repair.
});

test("caller-stable retry after a lost start acknowledgment recovers the retained turn", { timeout: 15_000 }, async t => {
  const f = await fixture(t);
  const session = await f.create();
  const request = CodexWorkerClient.prototype.request;
  let lost = false;
  t.mock.method(CodexWorkerClient.prototype, "request", async function<T>(this: CodexWorkerClient, method: CodexWorkerMethod, args?: { turnId?: string; input?: string }): Promise<T> {
    const result = await request.call(this, method, args);
    if (!lost && method === "startTurn") { lost = true; throw new Error("injected lost start acknowledgment"); }
    return result as T;
  });
  await assert.rejects(f.runtime.startTurn(session.id, "caller-stable", "hello"));
  assert.equal((await f.runtime.startTurn(session.id, "caller-stable", "hello")).id, "caller-stable");
  assert.equal((await settled(f.runtime, session.id, "caller-stable")).status, "completed");
  assert.equal((await f.calls()).filter(call => call.method === "turn/start").length, 1);
});

test("managed retained turns honor the documented worker retention window", { timeout: 15_000 }, async t => {
  const f = await fixture(t, "normal", { turnRetentionLimit: 2 });
  const session = await f.create();
  for (const turnId of ["one", "two", "three"]) {
    await f.runtime.startTurn(session.id, turnId, turnId);
    await settled(f.runtime, session.id, turnId);
  }
  assert.equal(await f.runtime.turn(session.id, "one"), undefined);
  assert.equal((await f.runtime.turn(session.id, "two"))?.status, "completed");
  assert.equal((await f.runtime.turn(session.id, "three"))?.status, "completed");
  assert.equal((await f.calls()).filter(call => call.method === "thread/start").length, 1);
});

for (const observation of ["throw", "missing", "lost-ack"] as const) {
  test(`managed send ${observation} uncertainty does not replay accepted input`, { timeout: 15_000 }, async t => {
    const f = await fixture(t);
    const session = await f.create();
    const request = CodexWorkerClient.prototype.request;
    let failed = false;
    t.mock.method(CodexWorkerClient.prototype, "request", async function<T>(this: CodexWorkerClient, method: CodexWorkerMethod, args?: { turnId?: string; input?: string }): Promise<T> {
      if (!failed && method === "turn" && observation !== "lost-ack") {
        failed = true;
        if (observation === "missing") return null as T;
        throw new Error("injected observation failure");
      }
      const result = await request.call(this, method, args);
      if (!failed && method === "startTurn" && observation === "lost-ack") { failed = true; throw new Error("injected lost acknowledgment"); }
      return result as T;
    });
    await assert.rejects(f.runtime.send(session.id, "hello"));
    await dispatched(f.calls);
    assert.equal(failed, true);
    assert.equal((await f.calls()).filter(call => call.method === "turn/start").length, 1);
  });
}

test("live-only managed connection authenticates without allocating and preserves owner binding", async t => {
  const f = await fixture(t), session = await f.create(), fresh = new CodexAgentRuntime(f.options);
  const before = await f.store.read(session.id, session.ownerId);
  await assert.rejects(fresh.connectManaged(session.id, "wrong-owner"));
  assert.deepEqual(await fresh.connectManaged(session.id, session.ownerId), session);
  assert.equal(await fresh.status(session.id), "idle");
  assert.deepEqual(await f.store.read(session.id, session.ownerId), before);
  assert.deepEqual(await f.calls(), []);
  await assert.rejects(fresh.connectManaged(session.id, "wrong-owner"));
  await fresh.send(session.id, "still the original owner");
  assert.equal((await f.calls()).filter(call => call.method === "thread/start").length, 1);
});

test("live-only managed connection never bootstraps saved unattempted metadata", async t => {
  const f = await fixture(t), identity = { id: randomUUID(), ownerId: "owner-a", generation: randomUUID() };
  await createPendingCodexSession(f.store, identity, { cwd: f.directory });
  const before = await f.store.read(identity.id, identity.ownerId);
  await assert.rejects(f.runtime.connectManaged(identity.id, identity.ownerId), /living worker/);
  assert.deepEqual(await f.store.read(identity.id, identity.ownerId), before);
  assert.deepEqual(await f.calls(), []);
});
