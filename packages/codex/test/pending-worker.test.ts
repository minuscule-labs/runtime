import assert from "node:assert/strict";
import { fork, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { syncBuiltinESMExports } from "node:module";
import fsPromises from "node:fs/promises";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test, { type TestContext } from "node:test";
import type { AgentEvent, AgentTurn, RuntimeMessage } from "@minu/runtime-core";
import { createPendingCodexSession } from "../src/managed-native.js";
import { CodexManagedStore, type CodexManifestLease } from "../src/managed-store.js";
import { CodexWorkerClient } from "../src/worker-client.js";
import type { CodexWorkerConnection } from "../src/worker-bridge.js";
import { openPendingCodexWorker } from "../src/pending-worker.js";
import { CodexAgentRuntime, CodexInputRejectedError } from "../src/client.js";

function gate() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}

async function until<T>(read: () => Promise<T>, matches: (value: T) => boolean, message: string): Promise<T> {
  const deadline = Date.now() + 5_000;
  do {
    const value = await read();
    if (matches(value)) return value;
    await new Promise(resolve => setTimeout(resolve, 10));
  } while (Date.now() < deadline);
  throw new Error(message);
}

function exited(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return once(child, "exit").then(() => {});
}

async function fixture(t: TestContext, scenario = "normal", fault?: string, retention = 1_000) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "codex-pending-worker-")));
  const root = join(directory, "managed");
  const logPath = join(directory, "native.jsonl");
  const store = new CodexManagedStore(root);
  const identity = { id: "stable-runtime-id", ownerId: "owner-a", generation: "generation-a" };
  await createPendingCodexSession(store, identity, { cwd: directory, appendSystemPrompt: "Saved reviewer" });
  const workers: Array<{ child: ChildProcess; client?: CodexWorkerClient }> = [];
  const log = async (): Promise<Array<Record<string, any>>> => {
    try { return (await readFile(logPath, "utf8")).trim().split("\n").map(line => JSON.parse(line)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
  };
  t.after(async () => {
    try {
      for (const worker of workers) {
        if (worker.child.exitCode !== null || worker.child.signalCode !== null) continue;
        if (!fault) await worker.client?.request("stop").catch(() => {});
        if (worker.child.exitCode === null && worker.child.signalCode === null) worker.child.kill("SIGTERM");
        let timer: NodeJS.Timeout | undefined;
        const done = await Promise.race([
          exited(worker.child).then(() => true),
          new Promise<false>(resolve => { timer = setTimeout(() => resolve(false), 500); }),
        ]);
        clearTimeout(timer);
        if (!done) { worker.child.kill("SIGKILL"); await exited(worker.child); }
      }
      // Deliberate worker-SIGKILL / unconfirmed-exit probes need test-only cleanup.
      for (const item of await log()) {
        if (typeof item.pid === "number") { try { process.kill(item.pid, "SIGKILL"); } catch {} }
      }
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
  return {
    directory, root, logPath, store, identity, log,
    saved: () => store.read(identity.id, identity.ownerId),
    release: () => writeFile(`${logPath}.release`, "release"),
    async launch(overrides: Record<string, unknown> = {}) {
      const child = fork(new URL(fault ? "./fixtures/pending-worker-fault.js" : "../src/owned-worker.js", import.meta.url),
        fault ? [fault] : [], { stdio: ["ignore", "ignore", "pipe", "ipc"] });
      child.stderr?.resume();
      const worker: { child: ChildProcess; client?: CodexWorkerClient } = { child };
      workers.push(worker);
      const response = once(child, "message");
      child.send({ type: "launch", managedRoot: root,
        identity: { sessionId: identity.id, ownerId: identity.ownerId, generation: identity.generation },
        options: { command: process.execPath,
          args: [fileURLToPath(new URL("./fixtures/app-server.js", import.meta.url)), scenario, logPath],
          requestTimeoutMs: 3_000, shutdownTimeoutMs: 100, turnRetentionLimit: retention,
        }, ...overrides,
      });
      const [message] = await Promise.race([
        response,
        exited(child).then(() => { throw new Error("Worker exited without readiness result"); }),
      ]) as [{ type: string; connection?: CodexWorkerConnection }];
      if (message.type === "ready") worker.client = new CodexWorkerClient(message.connection!);
      return { ...worker, type: message.type, connection: message.connection!, client: worker.client! };
    },
  };
}

async function localWorker(t: TestContext, scenario = "normal", registered = false) {
  let opened: Awaited<ReturnType<typeof openPendingCodexWorker>> | undefined;
  // Close the local runtime before the shared fixture removes its directory.
  t.after(async () => { await opened?.runtime.stop(opened.session.id).catch(() => {}); });
  const f = await fixture(t, scenario);
  const claim = registered ? { claimId: "local-claim", pid: process.pid } : undefined;
  if (claim) await f.store.withSessionLock(f.identity.id, f.identity.ownerId, async lease => {
    const reserved = await lease.reserveWorker((await f.saved())!.revision, claim.claimId);
    await lease.recordWorkerPid(reserved.revision, claim.claimId, claim.pid);
  });
  opened = await openPendingCodexWorker(f.store, f.identity, { command: process.execPath,
    args: [fileURLToPath(new URL("./fixtures/app-server.js", import.meta.url)), scenario, f.logPath],
    requestTimeoutMs: 3_000, shutdownTimeoutMs: 100 }, claim);
  if (claim) await f.store.withSessionLock(f.identity.id, f.identity.ownerId, async lease => {
    await lease.publishWorkerReady((await f.saved())!.revision, { version: 1, ownerId: f.identity.ownerId, generation: f.identity.generation,
      sessionId: f.identity.id, claimId: claim.claimId, pid: claim.pid,
      endpoint: "http://127.0.0.1:12345", token: "a".repeat(64) });
  });
  return { ...f, ...opened,
    manifestPath: join(f.root, createHash("sha256").update(f.identity.ownerId).digest("hex"), `${f.identity.id}.session`, "manifest.json"),
  };
}

async function localTerminal(f: Awaited<ReturnType<typeof localWorker>>, turnId: string) {
  return until(() => f.runtime.turn(f.session.id, turnId), turn => Boolean(turn && turn.status !== "running"), "Local turn did not settle");
}

async function terminal(client: CodexWorkerClient, turnId: string): Promise<AgentTurn> {
  return until(() => client.request<AgentTurn>("turn", { turnId }), turn => turn.status !== "running", "Turn did not settle");
}

function headers(c: CodexWorkerConnection): Record<string, string> {
  return { authorization: `Bearer ${c.token}`, "x-minu-runtime-owner": c.ownerId,
    "x-minu-runtime-session": c.sessionId, "x-minu-runtime-generation": c.generation, "content-type": "application/json" };
}

type IntentPublisher = Parameters<Awaited<ReturnType<typeof openPendingCodexWorker>>["runtime"]["quiesceIdleWithIntent"]>[2];
type IntentContext = Parameters<IntentPublisher>[0];

async function intentWorker(t: TestContext, bound = false, scenario = "normal") {
  const f = await localWorker(t, scenario, true);
  if (bound) { await f.runtime.startTurn(f.session.id, "settled", "hello"); await localTerminal(f, "settled"); }
  const current = (await f.saved())!;
  assert.ok(current.worker.state === "ready");
  if (current.worker.state !== "ready") throw new Error("Expected ready fixture");
  const connection = current.worker.connection;
  await writeFile(f.manifestPath, JSON.stringify({ ...current, version: 5 }));
  const observation = { ioPlatformUuid: "11111111-2222-4333-8444-555555555555", bootSessionUuid: "66666666-7777-4888-8999-aaaaaaaaaaaa" };
  await f.store.withSessionLock(f.session.id, f.identity.ownerId, lease => lease.recordProcessDomain(current.revision,
    { connection, launcher: observation, worker: observation }));
  return { ...f, quiesce: (publisher: IntentPublisher, op = "retire-a") => f.runtime.quiesceIdleWithIntent(f.session.id, op, publisher),
    produce: (publisher: IntentPublisher = publish, op = "retire-a") => f.runtime.quiesceIdleWithNativeFact(f.session.id, op, publisher) };
}

const publish: IntentPublisher = async ({ commitIntent }) => { await commitIntent(); };

for (const bound of [false, true]) {
  test(`native-fact producer ${bound ? "bound" : "pending"} derives private evidence and publishes once`, { timeout: 10_000 }, async t => {
    const f = await intentWorker(t, bound); const before = (await f.saved())!; let callbacks = 0;
    const entered = gate(), released = gate();
    const first = f.produce(async context => { callbacks++; entered.release(); await released.promise; await context.commitIntent(); });
    await entered.promise; const duplicate = f.produce(async () => { callbacks++; }); released.release();
    await Promise.all([first, duplicate]);
    const current = (await f.saved())!;
    assert.equal(current.revision, before.revision + 2); assert.deepEqual(current.native, before.native);
    assert.ok(current.worker.state === "retiring");
    if (current.worker.state === "retiring") assert.deepEqual(current.worker.nativeQuiesce, { kind: bound ? "owned_exit" : "never_started" });
    await f.produce(); assert.deepEqual(await f.saved(), current); assert.equal(callbacks, 1);
    await assert.rejects(f.produce(publish, "other-operation")); await assert.rejects(f.runtime.startTurn(f.session.id, "new", "hello"));
    if (bound) { const [{ pid }] = await f.log(); assert.throws(() => process.kill(pid, 0), { code: "ESRCH" }); }
    else assert.deepEqual(await f.log(), []);
  });
}

test("producer uses evidence already minted by the same qualified intent seal, not a second shutdown", { timeout: 10_000 }, async t => {
  const f = await intentWorker(t, true); await f.quiesce(publish); const before = (await f.saved())!;
  assert.ok(before.worker.state === "retiring" && !before.worker.nativeQuiesce);
  await f.produce(async () => { throw new Error("Publisher must not repeat"); });
  const after = (await f.saved())!; assert.equal(after.revision, before.revision + 1);
  if (after.worker.state === "retiring") assert.equal(after.worker.nativeQuiesce?.kind, "owned_exit");
});

for (const operation of ["stop", "quiesceIdle"] as const) {
  test(`ordinary ${operation} cached success cannot mint native-fact evidence`, { timeout: 10_000 }, async t => {
    const f = await intentWorker(t, true); await f.runtime[operation](f.session.id); const before = await f.saved();
    await assert.rejects(f.produce()); assert.deepEqual(await f.saved(), before);
  });
}

for (const mutation of ["allocation", "runtime", "session", "session-object", "thread"] as const) {
  test(`native-fact evidence rejects changed captured ${mutation} identity`, { timeout: 10_000 }, async t => {
    const f = await intentWorker(t, true); const local = f.runtime as any, allocation = local.allocation;
    const native = allocation.runtime, originalSession = allocation.session, sessionId = allocation.session.id, threadId = allocation.threadId;
    try {
      await assert.rejects(f.produce(async c => {
        await c.commitIntent();
        if (mutation === "allocation") local.allocation = { ...allocation };
        else if (mutation === "runtime") allocation.runtime = { ...native, stop: async () => {} };
        else if (mutation === "session-object") allocation.session = { ...allocation.session };
        else if (mutation === "session") allocation.session.id = "other-session";
        else allocation.threadId = "other-thread";
      }));
      const current = (await f.saved())!; assert.ok(current.worker.state === "retiring" && !current.worker.nativeQuiesce);
    } finally {
      local.allocation = allocation; allocation.runtime = native; allocation.session = originalSession; allocation.session.id = sessionId; allocation.threadId = threadId;
      await native.stop(sessionId); // Exact retained owned fixture, not reconstructed PID authority.
    }
  });
}

for (const point of ["before-rename", "after-rename"] as const) {
  test(`native-fact ${point} uncertainty is terminal independently of confirmed shutdown`, { timeout: 10_000 }, async t => {
    const f = await intentWorker(t, true); let publishing = false, writes = 0;
    const rename = fsPromises.rename;
    const mock = t.mock.method(fsPromises, "rename", async (from: Parameters<typeof rename>[0], to: Parameters<typeof rename>[1]) => {
      if (!publishing) return rename(from, to);
      writes++; if (point === "after-rename") await rename(from, to); throw new Error("Injected native-fact publication uncertainty");
    });
    syncBuiltinESMExports(); t.after(() => { mock.mock.restore(); syncBuiltinESMExports(); });
    await assert.rejects(f.produce(async c => { await c.commitIntent(); publishing = true; }), /publication uncertainty/);
    const current = (await f.saved())!;
    assert.ok(current.worker.state === "retiring");
    if (current.worker.state === "retiring") assert.equal(Boolean(current.worker.nativeQuiesce), point === "after-rename");
    await f.quiesce(publish); await f.runtime.stop(f.session.id); // Shutdown success is not producer completion.
    await assert.rejects(f.produce(), /publication uncertainty/); assert.equal(writes, 1);
    await assert.rejects(f.runtime.startTurn(f.session.id, "new", "hello"));
    const [{ pid }] = await f.log(); assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
    mock.mock.restore(); syncBuiltinESMExports();
  });
}

for (const outcome of ["delay", "error"] as const) {
  test(`native-fact ${outcome} after lock return cannot be stolen by duplicates observing the fact`, { timeout: 10_000 }, async t => {
    const f = await intentWorker(t); const entered = gate(), released = gate(); const lock = f.store.withSessionLock.bind(f.store);
    let writes = 0, finished = 0; const failure = new Error("Injected native-fact lock-return failure");
    t.mock.method(f.store as any, "withSessionLock", async (id: string, owner: string, operation: (lease: CodexManifestLease) => Promise<unknown>, timeout?: number) => {
      let fact = false;
      const value = await lock(id, owner, lease => operation({ ...lease, recordNativeQuiesce: async (...args) => { fact = true; writes++; return lease.recordNativeQuiesce(...args); } }), timeout);
      if (fact) { entered.release(); await released.promise; if (outcome === "error") throw failure; }
      return value;
    });
    const observe = (p: Promise<void>) => p.then(() => { finished++; return true; }, error => { finished++; return error; });
    const first = observe(f.produce()); let duplicate!: Promise<unknown>;
    try {
      await entered.promise; const current = (await f.saved())!;
      assert.ok(current.worker.state === "retiring" && current.worker.nativeQuiesce);
      await f.store.withSessionLock(f.session.id, f.identity.ownerId, async () => {}, 500);
      await f.runtime.stop(f.session.id);
      duplicate = observe(f.produce(async () => { throw new Error("Duplicate publisher ran"); }));
      await Promise.resolve(); await Promise.resolve(); assert.equal(finished, 0);
    } finally { released.release(); }
    const expected = outcome === "error" ? failure : true;
    assert.equal(await first, expected); assert.equal(await duplicate, expected); assert.equal(writes, 1);
    if (outcome === "error") await assert.rejects(f.produce(), error => error === failure);
    else await f.produce(); assert.equal(writes, 1);
  });
}

test("native-fact readback failure remains terminal even after the fact is restored", { timeout: 10_000 }, async t => {
  const f = await intentWorker(t); const lock = f.store.withSessionLock.bind(f.store); let writes = 0;
  t.mock.method(f.store as any, "withSessionLock", (id: string, owner: string, operation: (lease: CodexManifestLease) => Promise<unknown>, timeout?: number) =>
    lock(id, owner, lease => operation({ ...lease, recordNativeQuiesce: async (...args) => {
      writes++; const result = await lease.recordNativeQuiesce(...args);
      const broken = structuredClone(result); if (broken.worker.state === "retiring") delete broken.worker.nativeQuiesce;
      await writeFile(f.manifestPath, JSON.stringify(broken)); return result;
    } }), timeout));
  await assert.rejects(f.produce(), /fact is unavailable/);
  const restored = (await f.saved())!; if (restored.worker.state === "retiring") restored.worker.nativeQuiesce = { kind: "never_started" };
  await writeFile(f.manifestPath, JSON.stringify(restored));
  await assert.rejects(f.produce(), /fact is unavailable/); assert.equal(writes, 1); await f.runtime.stop(f.session.id);
});

for (const change of ["generation", "explicit", "domain", "operation", "native", "connection", "revision"] as const) {
  test(`native-fact rechecks ${change} after confirmed owned shutdown`, { timeout: 10_000 }, async t => {
    const f = await intentWorker(t, true); const stop = CodexAgentRuntime.prototype.stop;
    t.mock.method(CodexAgentRuntime.prototype, "stop", async function(this: CodexAgentRuntime, id: string) {
      await stop.call(this, id); const current = (await f.saved())!;
      if (current.worker.state !== "retiring" || !current.processDomain) throw new Error("Expected intent");
      if (change === "generation") current.generation = "other-generation";
      else if (change === "explicit") current.requiresExplicitResume = true;
      else if (change === "domain") current.processDomain.launcher.bootSessionUuid = current.processDomain.worker.bootSessionUuid = "bbbbbbbb-cccc-4ddd-8eee-ffffffffffff";
      else if (change === "operation") current.worker.retirement.operationId = "other-operation";
      else if (change === "native") current.native = current.worker.retirement.native = { state: "bound", threadId: "other-native" };
      else if (change === "connection") current.worker.connection.token = current.processDomain.connection.token = "b".repeat(64);
      else current.revision++;
      await writeFile(f.manifestPath, JSON.stringify(current));
    });
    if (change === "revision") { await f.produce(); const current = (await f.saved())!; assert.ok(current.worker.state === "retiring" && current.worker.nativeQuiesce); }
    else {
      await assert.rejects(f.produce()); const current = (await f.saved())!;
      assert.ok(current.worker.state === "retiring" && !current.worker.nativeQuiesce); await assert.rejects(f.produce());
    }
    const [{ pid }] = await f.log(); assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
  });
}

for (const change of ["generation", "explicit", "domain", "operation", "native", "connection", "missing-fact", "wrong-fact", "retired"] as const) {
  test(`native-fact cached success rejects fresh ${change}`, { timeout: 10_000 }, async t => {
    const f = await intentWorker(t); await f.produce(); const current = (await f.saved())!;
    if (current.worker.state !== "retiring" || !current.processDomain) throw new Error("Expected fact");
    if (change === "generation") current.generation = "other-generation";
    else if (change === "explicit") current.requiresExplicitResume = true;
    else if (change === "domain") current.processDomain.worker.bootSessionUuid = current.processDomain.launcher.bootSessionUuid = "bbbbbbbb-cccc-4ddd-8eee-ffffffffffff";
    else if (change === "operation") current.worker.retirement.operationId = "other-operation";
    else if (change === "native") current.native = current.worker.retirement.native = { state: "bound", threadId: "other-native" };
    else if (change === "connection") current.worker.connection.token = current.processDomain.connection.token = "b".repeat(64);
    else if (change === "missing-fact") delete current.worker.nativeQuiesce;
    else if (change === "wrong-fact") current.worker.nativeQuiesce = { kind: "owned_exit" };
    else Object.assign(current.worker, { state: "retired", workerAbsence: { pid: current.worker.connection.pid, domain: current.processDomain.worker, result: "pid_absent" } });
    await writeFile(f.manifestPath, JSON.stringify(current));
    await assert.rejects(f.produce()); assert.deepEqual(await readFile(f.manifestPath, "utf8"), JSON.stringify(current));
  });
}

for (const material of ["creating", "bound", "cleanup", "assertion"] as const) {
  test(`native-fact cannot reconstruct evidence from ${material} material`, { timeout: 10_000 }, async t => {
    const f = await intentWorker(t); const current = (await f.saved())!;
    if (material === "cleanup") (f.runtime as any).cleanupStop = async () => {};
    else if (material === "assertion") {
      Object.assign(current.worker, { state: "retiring", retirement: { operationId: "retire-a", native: current.native }, nativeQuiesce: { kind: "never_started" } });
      await writeFile(f.manifestPath, JSON.stringify(current));
    } else { current.native = material === "creating" ? { state: "creating" } : { state: "bound", threadId: "unowned-thread" }; await writeFile(f.manifestPath, JSON.stringify(current)); }
    const before = await readFile(f.manifestPath, "utf8"); await assert.rejects(f.produce()); assert.equal(await readFile(f.manifestPath, "utf8"), before);
  });
}

for (const scenario of ["held", "paused-create"]) {
  test(`native-fact busy ${scenario} rejection leaves work and admission untouched`, { timeout: 10_000 }, async t => {
    const f = await intentWorker(t, false, scenario); let callbacks = 0;
    await f.runtime.startTurn(f.session.id, "busy", "hello");
    await until(f.log, calls => calls.some(c => c.method === (scenario === "held" ? "turn/start" : "thread/start")), "Native did not start");
    const before = await f.saved(); await assert.rejects(f.produce(async () => { callbacks++; }), /working/);
    assert.equal(callbacks, 0); assert.deepEqual(await f.saved(), before); assert.equal((f.runtime as any).retirementSeal, undefined);
    assert.equal((await f.log()).some(c => c.method === "turn/interrupt"), false);
    await f.release(); if (scenario === "held") await f.runtime.interrupt(f.session.id); await localTerminal(f, "busy");
  });
}

test("native-fact shutdown failure produces no assertion and cannot retry shutdown", { timeout: 10_000 }, async t => {
  const f = await intentWorker(t, true); const stop = CodexAgentRuntime.prototype.stop; let owned!: CodexAgentRuntime, session = "", stops = 0;
  const failure = new Error("Injected unconfirmed owned exit");
  const mock = t.mock.method(CodexAgentRuntime.prototype, "stop", async function(this: CodexAgentRuntime, id: string) { owned = this; session = id; stops++; throw failure; });
  await assert.rejects(f.produce(), error => error === failure); await assert.rejects(f.produce(), error => error === failure);
  await assert.rejects(f.runtime.stop(f.session.id), error => error === failure); assert.equal(stops, 1);
  const current = (await f.saved())!; assert.ok(current.worker.state === "retiring" && !current.worker.nativeQuiesce);
  mock.mock.restore(); await stop.call(owned, session);
});

for (const bound of [false, true]) {
  test(`intent seam ${bound ? "bound" : "pending"} commits before stop and releases the lock before shutdown`, { timeout: 10_000 }, async t => {
    const f = await intentWorker(t, bound); const before = (await f.saved())!;
    const stop = CodexAgentRuntime.prototype.stop; let stops = 0, callbacks = 0;
    t.mock.method(CodexAgentRuntime.prototype, "stop", async function(this: CodexAgentRuntime, id: string) {
      stops++;
      await f.store.withSessionLock(f.session.id, f.identity.ownerId, async () => {
        const saved = (await f.saved())!; assert.equal(saved.worker.state, "retiring");
        if (saved.worker.state === "retiring") assert.equal(saved.worker.retirement.operationId, "retire-a");
      }, 500);
      await stop.call(this, id);
    });
    await f.quiesce(async context => { callbacks++; assert.deepEqual(context.current, before); await context.commitIntent(); });
    const after = (await f.saved())!;
    assert.equal(after.revision, before.revision + 1); assert.deepEqual(after.native, before.native);
    assert.equal(after.worker.state, "retiring"); assert.equal(stops, bound ? 1 : 0);
    await f.quiesce(async () => { callbacks++; throw new Error("Duplicate callback ran"); });
    await f.runtime.stop(f.session.id); assert.equal(callbacks, 1);
    await assert.rejects(f.quiesce(publish, "retire-b")); await assert.rejects(f.runtime.quiesceIdle(f.session.id));
    await assert.rejects(f.runtime.startTurn(f.session.id, "new", "hello"));
    assert.equal(await f.runtime.status(f.session.id), "offline");
    if (!bound) assert.deepEqual(await f.log(), []);
  });
}

test("intent capability is one-use, detached from callback metadata, and closed after settlement", { timeout: 10_000 }, async t => {
  const f = await intentWorker(t, true); const before = (await f.saved())!; let retained!: IntentContext;
  await f.quiesce(async context => {
    retained = context; context.current.ownerId = "other-owner"; context.current.generation = "other-generation";
    if (context.current.worker.state === "ready") { context.current.worker.connection.token = "b".repeat(64); context.current.worker.connection.pid++; }
    if (context.current.processDomain) context.current.processDomain.worker.bootSessionUuid = "changed";
    context.intent.operationId = "other-operation";
    if (context.intent.native.state === "bound") context.intent.native.threadId = "other-native";
    const writing = context.commitIntent(); await assert.rejects(context.commitIntent(), /closed or used/); await writing;
  });
  await assert.rejects(retained.commitIntent(), /closed or used/);
  const saved = (await f.saved())!;
  assert.deepEqual(saved.native, before.native); assert.deepEqual(saved.processDomain, before.processDomain);
  assert.equal(saved.ownerId, before.ownerId);
  if (saved.worker.state === "retiring") assert.deepEqual(saved.worker.retirement, { operationId: "retire-a", native: before.native });
});

for (const outcome of ["success", "callback-failure", "commit-failure"] as const) {
  test(`unawaited commit is drained and capability closed before ${outcome} readback/release`, { timeout: 10_000 }, async t => {
    const f = await intentWorker(t); const entered = gate(), released = gate(); const read = f.store.read.bind(f.store);
    let pause = false, retained!: IntentContext, ended = false;
    t.mock.method(f.store, "read", async (id: string, owner: string) => {
      const value = await read(id, owner);
      if (pause) { pause = false; entered.release(); await released.promise; if (outcome === "commit-failure") throw new Error("Injected commit read failure"); }
      return value;
    });
    const operation = f.quiesce(async context => {
      retained = context; pause = true; void context.commitIntent();
      if (outcome === "callback-failure") throw new Error("Injected callback failure");
    });
    const result = operation.then(() => { ended = true; return true; }, () => { ended = true; return false; });
    try {
      await entered.promise; await Promise.resolve(); await Promise.resolve();
      assert.equal(ended, false); await assert.rejects(retained.commitIntent(), /closed or used/);
      assert.equal(await f.runtime.status(f.session.id), "offline");
      await assert.rejects(f.runtime.startTurn(f.session.id, "new", "hello")); assert.deepEqual(await f.log(), []);
    } finally { released.release(); }
    assert.equal(await result, outcome === "success");
    const saved = (await f.saved())!;
    assert.equal(saved.worker.state, outcome === "commit-failure" ? "ready" : "retiring");
    if (outcome !== "success") { await assert.rejects(f.quiesce(publish)); await assert.rejects(f.runtime.stop(f.session.id)); }
    await assert.rejects(retained.commitIntent());
  });
}

for (const point of ["before-rename", "after-rename"] as const) {
  test(`intent ${point} publication uncertainty cannot be swallowed into shutdown success`, { timeout: 10_000 }, async t => {
    const f = await intentWorker(t, true); const before = (await f.saved())!;
    const rename = fsPromises.rename; let publications = 0, stops = 0;
    const renameMock = t.mock.method(fsPromises, "rename", async (from: Parameters<typeof rename>[0], to: Parameters<typeof rename>[1]) => {
      publications++; if (point === "after-rename") await rename(from, to); throw new Error("Injected publication uncertainty");
    });
    syncBuiltinESMExports();
    t.after(() => { renameMock.mock.restore(); syncBuiltinESMExports(); });
    const stop = CodexAgentRuntime.prototype.stop;
    const stopMock = t.mock.method(CodexAgentRuntime.prototype, "stop", async function(this: CodexAgentRuntime, id: string) { stops++; await stop.call(this, id); });
    await assert.rejects(f.quiesce(async ({ commitIntent }) => { await commitIntent().catch(() => {}); }), /publication uncertainty/);
    const saved = (await f.saved())!;
    assert.equal(saved.revision, before.revision + (point === "after-rename" ? 1 : 0));
    assert.equal(saved.worker.state, point === "after-rename" ? "retiring" : "ready");
    await assert.rejects(f.quiesce(publish)); await assert.rejects(f.runtime.stop(f.session.id));
    await assert.rejects(f.runtime.startTurn(f.session.id, "new", "hello"));
    assert.equal(publications, 1); assert.equal(stops, 0); assert.equal(await f.runtime.status(f.session.id), "offline");
    stopMock.mock.restore(); renameMock.mock.restore(); syncBuiltinESMExports();
  });
}

for (const outcome of ["missing", "before-write", "after-write"] as const) {
  test(`publisher ${outcome} failure keeps bound admission closed without native shutdown or continuation`, { timeout: 10_000 }, async t => {
    const f = await intentWorker(t, true); const before = (await f.saved())!;
    const stop = CodexAgentRuntime.prototype.stop; let stops = 0;
    const mock = t.mock.method(CodexAgentRuntime.prototype, "stop", async function(this: CodexAgentRuntime, id: string) { stops++; await stop.call(this, id); });
    await assert.rejects(f.quiesce(async ({ commitIntent }) => {
      if (outcome === "after-write") await commitIntent();
      if (outcome !== "missing") throw new Error("Injected callback failure");
    }));
    await assert.rejects(f.quiesce(publish)); await assert.rejects(f.runtime.stop(f.session.id));
    await assert.rejects(f.runtime.quiesceIdle(f.session.id)); await assert.rejects(f.runtime.startTurn(f.session.id, "new", "hello"));
    assert.equal(stops, 0); assert.equal(await f.runtime.status(f.session.id), "offline");
    const saved = (await f.saved())!; assert.equal(saved.revision, before.revision + (outcome === "after-write" ? 1 : 0));
    const [{ pid }] = await f.log(); process.kill(pid, 0);
    mock.mock.restore(); // Existing fixture cleanup owns the deliberately unquiesced native process.
  });
}

for (const change of ["generation", "explicit", "claim", "pid", "token", "endpoint", "domain", "operation", "native", "retired"] as const) {
  test(`post-publication ${change} mismatch cannot authorize shutdown or cached continuation`, { timeout: 10_000 }, async t => {
    const f = await intentWorker(t, true); let stops = 0;
    const stop = CodexAgentRuntime.prototype.stop;
    const mock = t.mock.method(CodexAgentRuntime.prototype, "stop", async function(this: CodexAgentRuntime, id: string) { stops++; await stop.call(this, id); });
    await assert.rejects(f.quiesce(async ({ commitIntent }) => {
      await commitIntent(); const current = (await f.saved())!;
      assert.ok(current.worker.state === "retiring" && current.processDomain);
      if (current.worker.state !== "retiring" || !current.processDomain) throw new Error("Expected intent");
      if (change === "generation") current.generation = "other-generation";
      else if (change === "explicit") current.requiresExplicitResume = true;
      else if (change === "domain") current.processDomain.launcher.bootSessionUuid = current.processDomain.worker.bootSessionUuid = "bbbbbbbb-cccc-4ddd-8eee-ffffffffffff";
      else if (change === "operation") current.worker.retirement.operationId = "other-operation";
      else if (change === "native") current.native = current.worker.retirement.native = { state: "bound", threadId: "other-native" };
      else if (change === "retired") {
        Object.assign(current.worker, { state: "retired", nativeQuiesce: { kind: "owned_exit" },
          workerAbsence: { pid: current.worker.connection.pid, domain: current.processDomain.launcher, result: "pid_absent" } });
      } else {
        const connection = current.worker.connection;
        if (change === "claim") { current.worker.claimId = "other-claim"; connection.claimId = "other-claim"; }
        else if (change === "pid") connection.pid++;
        else if (change === "token") connection.token = "b".repeat(64);
        else connection.endpoint = "http://127.0.0.1:54321";
        current.processDomain.connection = { ...connection };
      }
      await writeFile(f.manifestPath, JSON.stringify(current));
    }));
    await assert.rejects(f.quiesce(publish)); await assert.rejects(f.runtime.stop(f.session.id));
    assert.equal(stops, 0); const [{ pid }] = await f.log(); process.kill(pid, 0); mock.mock.restore();
  });
}

for (const outcome of ["confirmed", "unconfirmed"] as const) {
  test(`sealed ${outcome} shutdown shares one result with stop/duplicates without self-join`, { timeout: 10_000 }, async t => {
    const f = await intentWorker(t, true); const entered = gate(), released = gate(); const stop = CodexAgentRuntime.prototype.stop;
    let owned!: CodexAgentRuntime, nativeId = "", stops = 0, callbacks = 0; const failure = new Error("Injected native exit failure");
    const mock = t.mock.method(CodexAgentRuntime.prototype, "stop", async function(this: CodexAgentRuntime, id: string) {
      owned = this; nativeId = id; stops++; entered.release(); await released.promise;
      if (outcome === "unconfirmed") throw failure;
      await stop.call(this, id);
    });
    const first = f.quiesce(async c => { callbacks++; await c.commitIntent(); }); const observed = Promise.allSettled([first]);
    let others!: Promise<PromiseSettledResult<void>[]>;
    try {
      await entered.promise; await f.store.withSessionLock(f.session.id, f.identity.ownerId, async () => {}, 500);
      others = Promise.allSettled([f.quiesce(async () => { callbacks++; }), f.runtime.stop(f.session.id)]);
      await assert.rejects(f.quiesce(publish, "different-operation")); await assert.rejects(f.runtime.quiesceIdle(f.session.id));
    } finally { released.release(); }
    const results = [...await observed, ...await others];
    assert.ok(results.every(r => outcome === "confirmed" ? r.status === "fulfilled" : r.status === "rejected" && r.reason === failure));
    assert.equal(stops, 1); assert.equal(callbacks, 1);
    mock.mock.restore(); await stop.call(owned, nativeId);
  });
}

test("stop and input during blocked publication cannot bypass the seal or begin shutdown", { timeout: 10_000 }, async t => {
  const f = await intentWorker(t, true); const entered = gate(), released = gate(); let callbacks = 0, stops = 0;
  const stop = CodexAgentRuntime.prototype.stop;
  t.mock.method(CodexAgentRuntime.prototype, "stop", async function(this: CodexAgentRuntime, id: string) { stops++; await stop.call(this, id); });
  const first = f.quiesce(async c => { callbacks++; entered.release(); await released.promise; await c.commitIntent(); });
  const observed = Promise.allSettled([first]); let others!: Promise<PromiseSettledResult<void>[]>;
  try {
    await entered.promise;
    others = Promise.allSettled([f.runtime.stop(f.session.id), f.quiesce(async () => { callbacks++; })]);
    assert.equal(await f.runtime.status(f.session.id), "offline");
    await assert.rejects(f.runtime.startTurn(f.session.id, "new", "hello")); await assert.rejects(f.runtime.quiesceIdle(f.session.id));
    assert.equal(stops, 0); assert.equal((await f.saved())!.worker.state, "ready");
  } finally { released.release(); }
  assert.ok([...await observed, ...await others].every(r => r.status === "fulfilled")); assert.equal(stops, 1); assert.equal(callbacks, 1);
});

for (const winner of ["input", "seal"] as const) {
  test(`intent admission race: ${winner} wins without replay or hidden allocation`, { timeout: 10_000 }, async t => {
    const f = await intentWorker(t); const entered = gate(), released = gate(); const read = f.store.read.bind(f.store); let pause = true, callbacks = 0;
    t.mock.method(f.store, "read", async (id: string, owner: string) => {
      const value = await read(id, owner); if (pause) { pause = false; entered.release(); await released.promise; } return value;
    });
    const first = winner === "input" ? f.quiesce(async c => { callbacks++; await c.commitIntent(); }) : f.runtime.startTurn(f.session.id, "racing", "hello");
    const rejected = assert.rejects(first);
    try {
      await entered.promise;
      if (winner === "input") await f.runtime.startTurn(f.session.id, "racing", "hello"); else await f.quiesce(publish);
    } finally { released.release(); }
    await rejected; assert.equal(callbacks, 0);
    if (winner === "input") { await localTerminal(f, "racing"); assert.equal((await f.log()).filter(c => c.method === "turn/start").length, 1); }
    else assert.deepEqual(await f.log(), []);
  });
}

for (const change of ["generation", "native", "stop"] as const) {
  test(`intent status-await ${change} race denies publication and new shutdown authority`, { timeout: 10_000 }, async t => {
    const f = await intentWorker(t, true); const entered = gate(), released = gate(); const status = CodexAgentRuntime.prototype.status; let callbacks = 0;
    t.mock.method(CodexAgentRuntime.prototype, "status", async function(this: CodexAgentRuntime, id: string) { const value = await status.call(this, id); entered.release(); await released.promise; return value; });
    const result = assert.rejects(f.quiesce(async c => { callbacks++; await c.commitIntent(); }));
    try {
      await entered.promise;
      if (change === "stop") await f.runtime.stop(f.session.id);
      else { const current = (await f.saved())!; if (change === "generation") current.generation = "other-generation"; else current.native = { state: "bound", threadId: "other-native" }; await writeFile(f.manifestPath, JSON.stringify(current)); }
    } finally { released.release(); }
    await result; assert.equal(callbacks, 0); assert.equal((await f.saved())!.worker.state, "ready");
    if (change !== "stop") { const [{ pid }] = await f.log(); process.kill(pid, 0); }
  });
}

for (const status of ["working", "offline", ["idle"]] as const) {
  test(`intent admission rejects native status ${JSON.stringify(status)}`, { timeout: 10_000 }, async t => {
    const f = await intentWorker(t, true); let callbacks = 0;
    t.mock.method(CodexAgentRuntime.prototype, "status", async () => status as never);
    await assert.rejects(f.quiesce(async () => { callbacks++; })); assert.equal(callbacks, 0); assert.equal((await f.saved())!.worker.state, "ready");
  });
}

for (const scenario of ["held", "paused-create"]) {
  test(`intent rejects ${scenario} preparation/work without seal or interruption`, { timeout: 10_000 }, async t => {
    const f = await intentWorker(t, false, scenario); let callbacks = 0;
    await f.runtime.startTurn(f.session.id, "busy", "hello");
    await until(f.log, calls => calls.some(c => c.method === (scenario === "held" ? "turn/start" : "thread/start")), "Native did not start");
    const before = await f.saved(); await assert.rejects(f.quiesce(async () => { callbacks++; }), /working/);
    assert.equal(callbacks, 0); assert.deepEqual(await f.saved(), before); assert.equal((await f.log()).some(c => c.method === "turn/interrupt"), false);
    await f.release(); if (scenario === "held") await f.runtime.interrupt(f.session.id); await localTerminal(f, "busy");
  });
}

test("intent validates address/operation/callback/v5 correlation before sealing", { timeout: 10_000 }, async t => {
  const f = await intentWorker(t); let callbacks = 0; const callback = async () => { callbacks++; };
  for (const op of ["", "../bad", "x".repeat(129), 1]) await assert.rejects(f.quiesce(callback, op as string));
  await assert.rejects(f.quiesce(null as never)); await assert.rejects(f.runtime.quiesceIdleWithIntent("other-id", "valid", callback));
  assert.equal(await f.runtime.status(f.session.id), "idle");
  const current = (await f.saved())!; const { processDomain: _domain, ...plain } = current;
  await writeFile(f.manifestPath, JSON.stringify({ ...plain, version: 4 }));
  await assert.rejects(f.quiesce(callback)); assert.equal(await f.runtime.status(f.session.id), "idle");
  await writeFile(f.manifestPath, JSON.stringify(plain)); await assert.rejects(f.quiesce(callback)); assert.equal(callbacks, 0);
  await f.runtime.quiesceIdle(f.session.id); // Ordinary v5/v4 quiesce is not enrolled into retirement.
});

for (const fence of ["generation", "explicit", "connection", "operation", "domain", "retired"] as const) {
  test(`fresh ${fence} guard overrides cached intent success`, { timeout: 10_000 }, async t => {
    const f = await intentWorker(t); await f.quiesce(publish); const current = (await f.saved())!;
    if (current.worker.state !== "retiring" || !current.processDomain) throw new Error("Expected intent");
    if (fence === "generation") current.generation = "other-generation";
    else if (fence === "explicit") current.requiresExplicitResume = true;
    else if (fence === "connection") { current.worker.connection.token = "b".repeat(64); current.processDomain.connection.token = current.worker.connection.token; }
    else if (fence === "operation") current.worker.retirement.operationId = "other-operation";
    else if (fence === "domain") current.processDomain.worker.bootSessionUuid = current.processDomain.launcher.bootSessionUuid = "bbbbbbbb-cccc-4ddd-8eee-ffffffffffff";
    else Object.assign(current.worker, { state: "retired", nativeQuiesce: { kind: "never_started" }, workerAbsence: { pid: current.worker.connection.pid, domain: current.processDomain.worker, result: "pid_absent" } });
    await writeFile(f.manifestPath, JSON.stringify(current));
    await assert.rejects(f.quiesce(async () => { throw new Error("Callback must not repeat"); }));
    await assert.rejects(f.runtime.stop(f.session.id)); await assert.rejects(f.runtime.startTurn(f.session.id, "new", "hello"));
  });
}

test("local idle quiesce of a never-used registered worker launches nothing and preserves metadata", { timeout: 10_000 }, async t => {
  const f = await localWorker(t, "normal", true);
  const before = await f.saved();
  const stream = f.runtime.events!(f.session.id)[Symbol.asyncIterator]();
  assert.equal((await stream.next()).value?.type, "status");
  await Promise.all([f.runtime.quiesceIdle(f.session.id), f.runtime.quiesceIdle(f.session.id)]);
  const offline = await stream.next();
  assert.ok(offline.value?.type === "status" && offline.value.status === "offline");
  assert.equal((await stream.next()).done, true);
  assert.deepEqual(await f.log(), []);
  assert.deepEqual(await f.saved(), before);
  assert.equal(await f.runtime.status(f.session.id), "offline");
  await assert.rejects(f.runtime.startTurn(f.session.id, "closed", "hello"));
  await f.runtime.stop(f.session.id);
});

test("local idle bound quiesce confirms native exit and preserves exact binding/history and retained retries", { timeout: 10_000 }, async t => {
  const f = await localWorker(t, "normal", true);
  await f.runtime.startTurn(f.session.id, "settled", "hello");
  const turn = await localTerminal(f, "settled");
  const before = await f.saved();
  const history = await f.runtime.messages(f.session.id);
  await f.runtime.quiesceIdle(f.session.id); // Resolved allocating promise is not busy.
  const [{ pid }] = await f.log();
  assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
  assert.deepEqual(await f.saved(), before);
  assert.deepEqual(await f.runtime.messages(f.session.id), history);
  assert.deepEqual(await f.runtime.startTurn(f.session.id, "settled", "hello"), turn);
  await assert.rejects(f.runtime.startTurn(f.session.id, "new", "hello"));
  await f.runtime.quiesceIdle(f.session.id);
  assert.equal((await f.log()).filter(call => call.method === "turn/start").length, 1);
});

for (const scenario of ["held", "paused-create"]) {
  test(`local quiesce rejects busy ${scenario} without cancelling preparation or native work`, { timeout: 10_000 }, async t => {
    const f = await localWorker(t, scenario);
    await f.runtime.startTurn(f.session.id, "busy", "hello");
    await until(f.log, log => log.some(call => call.method === (scenario === "held" ? "turn/start" : "thread/start")), "Native work did not start");
    const before = await f.saved();
    await assert.rejects(f.runtime.quiesceIdle(f.session.id), /working/);
    assert.deepEqual(await f.saved(), before);
    assert.equal((await f.runtime.turn(f.session.id, "busy"))?.status, "running");
    assert.equal((await f.log()).some(call => call.method === "turn/interrupt"), false);
    await f.release();
    if (scenario === "paused-create") assert.equal((await localTerminal(f, "busy"))?.status, "completed");
    else { await f.runtime.interrupt(f.session.id); await localTerminal(f, "busy"); }
    await f.runtime.quiesceIdle(f.session.id);
  });
}

for (const winner of ["input", "quiesce"]) {
  test(`controlled first-input/quiesce admission race: ${winner} wins`, { timeout: 10_000 }, async t => {
    const f = await localWorker(t);
    const pinned = gate(), released = gate();
    const read = f.store.read.bind(f.store);
    let pause = true;
    t.mock.method(f.store, "read", async (id: string, ownerId: string) => {
      const snapshot = await read(id, ownerId);
      if (pause) { pause = false; pinned.release(); await released.promise; }
      return snapshot;
    });
    const first = winner === "input" ? f.runtime.quiesceIdle(f.session.id) : f.runtime.startTurn(f.session.id, "racing", "hello");
    const rejected = assert.rejects(first);
    try {
      await pinned.promise;
      if (winner === "input") {
        assert.equal((await f.runtime.startTurn(f.session.id, "racing", "hello")).status, "running");
        assert.deepEqual(await f.log(), []); // Allocation waits for quiesce's held lock.
      } else await f.runtime.quiesceIdle(f.session.id);
    } finally { released.release(); }
    await rejected;
    if (winner === "input") {
      assert.equal((await localTerminal(f, "racing"))?.status, "completed");
      await f.runtime.quiesceIdle(f.session.id);
      assert.equal((await f.log()).filter(call => call.method === "turn/start").length, 1);
    } else assert.deepEqual(await f.log(), []);
  });
}

for (const fence of ["generation", "explicit", "claim"]) {
  test(`local quiesce refuses persisted ${fence} fencing without shutdown or mutation`, { timeout: 10_000 }, async t => {
    const f = await localWorker(t, "normal", true);
    const before = (await f.saved())!;
    if (fence === "claim" && before.worker.state === "ready") {
      before.worker.claimId = "other-claim"; before.worker.connection.claimId = "other-claim";
      await writeFile(f.manifestPath, JSON.stringify(before));
    } else await f.store.update(f.session.id, f.identity.ownerId, before.revision,
      fence === "generation" ? { generation: "other-generation" } : { requiresExplicitResume: true });
    const fenced = await f.saved();
    await assert.rejects(f.runtime.quiesceIdle(f.session.id));
    assert.deepEqual(await f.saved(), fenced);
    assert.deepEqual(await f.log(), []);
  });
}

test("local quiesce checks wrong addressed identity and owner before granting shutdown", { timeout: 10_000 }, async t => {
  const f = await localWorker(t);
  const before = await f.saved();
  await assert.rejects(f.runtime.quiesceIdle("other-id"));
  await assert.rejects(openPendingCodexWorker(f.store, { ...f.identity, ownerId: "other-owner" }));
  assert.equal(await f.runtime.status(f.session.id), "idle");
  assert.deepEqual(await f.saved(), before);
  assert.deepEqual(await f.log(), []);
});

for (const material of ["creating", "bound"]) {
  test(`local quiesce rejects ${material} material without an owned allocation`, { timeout: 10_000 }, async t => {
    const f = await localWorker(t);
    await f.store.withSessionLock(f.session.id, f.identity.ownerId, async lease => {
      const creating = await lease.beginNativeCreation((await f.saved())!.revision);
      if (material === "bound") await lease.bindNativeThread(creating.revision, "unowned-native-thread");
    });
    const before = await f.saved();
    await assert.rejects(f.runtime.quiesceIdle(f.session.id));
    assert.deepEqual(await f.saved(), before);
    assert.deepEqual(await f.log(), []);
  });
}

for (const fence of ["generation", "binding"]) {
  test(`fresh authority after native-status await rejects changed persisted ${fence}`, { timeout: 10_000 }, async t => {
    const f = await localWorker(t);
    await f.runtime.startTurn(f.session.id, "settled", "hello"); await localTerminal(f, "settled");
    const pinned = gate(), released = gate();
    const status = CodexAgentRuntime.prototype.status;
    t.mock.method(CodexAgentRuntime.prototype, "status", async function(this: CodexAgentRuntime, id: string) {
      const result = await status.call(this, id); pinned.release(); await released.promise; return result;
    });
    const quiescing = f.runtime.quiesceIdle(f.session.id);
    const rejected = assert.rejects(quiescing);
    let changed;
    try {
      await pinned.promise;
      changed = (await f.saved())!;
      // Deliberate persisted-file fault bypasses the lock held by validation.
      if (fence === "generation") changed.generation = "changed-generation";
      else changed.native = { state: "bound", threadId: "different-thread" };
      await writeFile(f.manifestPath, JSON.stringify(changed));
    } finally { released.release(); }
    await rejected;
    assert.deepEqual(await f.saved(), changed);
    const [{ pid }] = await f.log(); process.kill(pid, 0); // No shutdown authority was granted.
  });
}

for (const outcome of ["confirmed", "unconfirmed"]) {
  test(`admitted ${outcome} quiesce shares its result with repeats/stop and releases the session lock`, { timeout: 10_000 }, async t => {
    const f = await localWorker(t);
    await f.runtime.startTurn(f.session.id, "settled", "hello"); await localTerminal(f, "settled");
    const entered = gate(), released = gate();
    const stop = CodexAgentRuntime.prototype.stop;
    let owned: CodexAgentRuntime | undefined, nativeId = "", stops = 0;
    const failure = new Error("Injected native exit is unconfirmed");
    const mock = t.mock.method(CodexAgentRuntime.prototype, "stop", async function(this: CodexAgentRuntime, id: string) {
      owned = this; nativeId = id; stops++; entered.release(); await released.promise;
      if (outcome === "unconfirmed") throw failure;
      await stop.call(this, id);
    });
    const first = f.runtime.quiesceIdle(f.session.id);
    const firstObserved = Promise.allSettled([first]);
    let results!: Promise<PromiseSettledResult<void>[]>;
    try {
      await entered.promise;
      await f.store.withSessionLock(f.session.id, f.identity.ownerId, async () => {}, 500);
      results = Promise.allSettled([f.runtime.quiesceIdle(f.session.id), f.runtime.stop(f.session.id)]);
      await assert.rejects(f.runtime.startTurn(f.session.id, "closed", "hello"));
    } finally { released.release(); }
    const all = [...await firstObserved, ...await results];
    if (outcome === "confirmed") assert.ok(all.every(result => result.status === "fulfilled"));
    else {
      assert.ok(all.every(result => result.status === "rejected" && result.reason === failure));
      await assert.rejects(f.runtime.quiesceIdle(f.session.id), error => error === failure);
      await assert.rejects(f.runtime.stop(f.session.id), error => error === failure);
      assert.equal(await f.runtime.status(f.session.id), "offline");
      assert.equal((await f.log()).filter(call => call.method === "turn/start").length, 1);
    }
    assert.equal(stops, 1);
    mock.mock.restore();
    if (owned) await stop.call(owned, nativeId); // Exact owned child cleanup despite injected failed confirmation.
  });
}

test("ordinary stop winning during native-status await cannot become idle-quiesce confirmation", { timeout: 10_000 }, async t => {
  const f = await localWorker(t);
  await f.runtime.startTurn(f.session.id, "settled", "hello"); await localTerminal(f, "settled");
  const entered = gate(), released = gate();
  const status = CodexAgentRuntime.prototype.status;
  t.mock.method(CodexAgentRuntime.prototype, "status", async function(this: CodexAgentRuntime, id: string) {
    const result = await status.call(this, id); entered.release(); await released.promise; return result;
  });
  const quiescing = f.runtime.quiesceIdle(f.session.id); const rejected = assert.rejects(quiescing);
  try { await entered.promise; await f.runtime.stop(f.session.id); }
  finally { released.release(); }
  await rejected;
  await assert.rejects(f.runtime.quiesceIdle(f.session.id));
});

test("ready pending worker supports reads and idle stop without launching or mutating native state", { timeout: 10_000 }, async t => {
  const f = await fixture(t);
  const before = await f.saved();
  const w = await f.launch();
  assert.equal(w.type, "ready");
  assert.equal(await w.client.request("status"), "idle");
  assert.deepEqual(await w.client.request("messages"), []);
  assert.equal(await w.client.request("turn", { turnId: "unknown" }), null);
  await assert.rejects(w.client.request("steer", { input: "not active" }), /409/);
  await assert.rejects(w.client.request("interrupt"), /409/);
  assert.deepEqual(await f.log(), []);
  await w.client.request("stop");
  await exited(w.child);
  assert.equal(w.child.exitCode, 0);
  assert.deepEqual(await f.saved(), before);
  const restarted = await f.launch();
  assert.equal(restarted.type, "ready");
  assert.deepEqual(await f.log(), []);
});

for (const failure of ["lock-return", "uncertain-dispatch"] as const) {
  test(`image rejection classification cannot bypass ${failure} uncertainty`, { timeout: 10000 }, async t => {
    const f = await fixture(t), scenario = failure === "lock-return" ? "text-only" : "held";
    const opened = await openPendingCodexWorker(f.store, f.identity, { command: process.execPath,
      args: [fileURLToPath(new URL("./fixtures/app-server.js", import.meta.url)), scenario, f.logPath], requestTimeoutMs: 3000, shutdownTimeoutMs: 100 });
    const start = CodexAgentRuntime.prototype.startTurn, stop = CodexAgentRuntime.prototype.stop;
    let rejected = false, injected = false, stops = 0;
    t.mock.method(CodexAgentRuntime.prototype, "startTurn", async function(this: CodexAgentRuntime, ...args: Parameters<typeof start>) {
      try {
        const result = await start.apply(this, args);
        if (failure === "uncertain-dispatch") {
          await until(f.log, log => log.some(call => call.method === "turn/start"), "Native dispatch not observed");
          throw new Error("Injected uncertain native dispatch result");
        }
        return result;
      } catch (error) { if (error instanceof CodexInputRejectedError) rejected = true; throw error; }
    });
    t.mock.method(CodexAgentRuntime.prototype, "stop", async function(this: CodexAgentRuntime, id: string) { stops++; await stop.call(this, id); });
    const locked = f.store.withSessionLock;
    t.mock.method(f.store, "withSessionLock", (async (...args: Parameters<typeof locked>) => {
      const result = await locked.apply(f.store, args);
      if (rejected && !injected) { injected = true; throw new Error("Injected lock return after rejected input"); }
      return result;
    }) as typeof locked);
    try {
      await opened.runtime.startTurn(opened.session.id, "image", "", [{ type: "image", mimeType: "image/png", data: "YQ==" }]);
      const failed = await until(() => opened.runtime.turn(opened.session.id, "image"), turn => turn?.status === "failed", "Expected failed retained turn");
      assert.match(failed!.error!, /session unavailable/); assert.equal(stops, 1);
      assert.equal(await opened.runtime.status(opened.session.id), "offline");
      await assert.rejects(opened.runtime.startTurn(opened.session.id, "text", "No replacement"));
      assert.equal((await f.log()).filter(call => call.method === "thread/start").length, 1);
      assert.equal((await f.log()).filter(call => call.method === "turn/start").length, failure === "lock-return" ? 0 : 1);
      const [{ pid }] = await f.log(); assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
    } finally { await opened.runtime.stop(opened.session.id); }
  });
}

test("malformed, oversized and unauthorized first input cannot create a native thread", { timeout: 10_000 }, async t => {
  const f = await fixture(t);
  const w = await f.launch();
  const invalid = [
    { method: "startTurn", turnId: "one", input: " " },
    { method: "startTurn", turnId: "x".repeat(257), input: "hello" },
    { method: "startTurn", turnId: "one", input: "x".repeat(1024 * 1024 + 1) },
    { method: "startTurn", turnId: "one", input: "hello", images: [{ type: "image", mimeType: "image/png", data: "bad" }] },
  ];
  for (const body of invalid) {
    const response = await fetch(`${w.connection.endpoint}/rpc`, { method: "POST", headers: headers(w.connection), body: JSON.stringify(body) });
    assert.equal(response.status, body.input.length > 1024 * 1024 ? 413 : 400);
    await response.text();
  }
  for (const patch of [{ token: "f".repeat(64) }, { generation: "wrong-generation" }, { ownerId: "wrong-owner" }]) {
    await assert.rejects(new CodexWorkerClient({ ...w.connection, ...patch }).request("startTurn", { turnId: "one", input: "hello" }), /403/);
  }
  assert.deepEqual((await f.saved())?.native, { state: "pending" });
  assert.deepEqual(await f.log(), []);
});

test("first valid turn returns admission before launch, binds once and deduplicates concurrent/repeated input", { timeout: 10_000 }, async t => {
  const f = await fixture(t, "paused-create");
  const w = await f.launch();
  const args = { turnId: "first-turn", input: "Actual first input" };
  const accepted = await w.client.request<AgentTurn>("startTurn", args);
  assert.equal(accepted.status, "running");
  await until(f.log, log => log.some(call => call.method === "thread/start"), "Native creation did not begin");
  assert.deepEqual((await f.saved())?.native, { state: "creating" });
  assert.equal(await w.client.request("status"), "working");
  const repeated = await Promise.all(Array.from({ length: 5 }, () => w.client.request<AgentTurn>("startTurn", args)));
  assert.ok(repeated.every(turn => turn.id === args.turnId && turn.status === "running"));
  await assert.rejects(w.client.request("startTurn", { ...args, input: "different" }), /400/);
  await assert.rejects(w.client.request("startTurn", { turnId: "other", input: "busy" }), /409/);
  await assert.rejects(w.client.request("steer", { input: "not dispatched yet" }), /409/);
  await f.release();
  const result = await terminal(w.client, args.turnId);
  assert.equal(result.status, "completed");
  assert.equal(result.response?.content, "Answer 1: café 🐈");
  assert.deepEqual((await f.saved())?.native, { state: "bound", threadId: "native-thread" });
  assert.equal((await w.client.request<AgentTurn>("startTurn", args)).status, "completed");
  assert.equal((await f.log()).filter(call => call.method === "thread/start").length, 1);
  assert.equal((await f.log()).filter(call => call.method === "turn/start").length, 1);
  const messages = await w.client.request<RuntimeMessage[]>("messages");
  assert.equal(messages[0].content, args.input);
  await w.client.request("startTurn", { turnId: "next", input: "Next input" });
  assert.equal((await terminal(w.client, "next")).status, "completed");
  assert.equal((await f.log()).filter(call => call.method === "thread/start").length, 1);
});

test("a creating snapshot read in flight cannot falsely fence a newly bound worker", { timeout: 10_000 }, async t => {
  const f = await fixture(t, "paused-create");
  const { runtime, session } = await openPendingCodexWorker(f.store, f.identity, {
    command: process.execPath,
    args: [fileURLToPath(new URL("./fixtures/app-server.js", import.meta.url)), "paused-create", f.logPath],
    requestTimeoutMs: 3_000, shutdownTimeoutMs: 100,
  });
  let releaseSnapshot!: () => void;
  try {
    await runtime.startTurn(session.id, "first", "hello");
    await until(f.log, log => log.some(call => call.method === "thread/start"), "Creation not paused");
    const originalRead = f.store.read.bind(f.store);
    let snapshotRead!: () => void;
    const pinned = new Promise<void>(resolve => { snapshotRead = resolve; });
    const released = new Promise<void>(resolve => { releaseSnapshot = resolve; });
    let pauseOnce = true;
    f.store.read = async (id, ownerId) => {
      const value = await originalRead(id, ownerId);
      if (pauseOnce && value?.native.state === "creating") {
        pauseOnce = false;
        snapshotRead();
        await released;
      }
      return value;
    };
    const status = runtime.status(session.id);
    await pinned;
    await f.release();
    await until(() => runtime.turn(session.id, "first"), turn => turn?.status === "completed", "Turn did not settle");
    releaseSnapshot();
    assert.equal(await status, "idle");
  } finally {
    releaseSnapshot?.();
    await f.release();
    await runtime.stop(session.id);
  }
});

test("two pending workers cannot both allocate/dispatch for one identity", { timeout: 10_000 }, async t => {
  const f = await fixture(t);
  const workers = await Promise.all([f.launch(), f.launch()]);
  await Promise.all(workers.map(w => w.client.request("startTurn", { turnId: "first", input: "hello" })));
  await until(async () => Promise.all(workers.map(w => w.client.request<string>("status"))),
    states => states.includes("offline") && states.includes("idle"), "Pending workers did not settle");
  assert.equal((await f.log()).filter(call => call.method === "thread/start").length, 1);
  assert.equal((await f.log()).filter(call => call.method === "turn/start").length, 1);
});

test("consumer restart reconnects to the same living worker and does not redispatch accepted input", { timeout: 10_000 }, async t => {
  const f = await fixture(t, "held");
  const w = await f.launch();
  await w.client.request("startTurn", { turnId: "held", input: "hello" });
  await until(f.log, log => log.some(call => call.method === "turn/start"), "Turn was not dispatched");
  w.child.disconnect();
  const consumer = fork(new URL("./fixtures/worker-consumer.js", import.meta.url), [], { stdio: ["ignore", "ignore", "ignore", "ipc"] });
  const done = exited(consumer);
  const response = once(consumer, "message");
  consumer.send({ connection: w.connection, method: "startTurn", args: { turnId: "held", input: "hello" } });
  const [message] = await response as [{ result: AgentTurn }];
  await done;
  assert.equal(message.result.status, "running");
  const reconnected = new CodexWorkerClient(w.connection);
  await reconnected.request("steer", { input: "Focus on errors" });
  await reconnected.request("interrupt");
  assert.equal((await terminal(reconnected, "held")).status, "interrupted");
  assert.equal((await f.log()).filter(call => call.method === "turn/start").length, 1);
});

test("interrupt during native creation fences first dispatch and waits for cleanup before settlement", { timeout: 10_000 }, async t => {
  const f = await fixture(t, "paused-create");
  const w = await f.launch();
  const stream = w.client.events(); await stream.ready; await stream.next();
  const events: AgentEvent[] = [];
  const observed = (async () => {
    for await (const event of stream) {
      events.push(event);
      // Offline admission is not settled cleanup; wait for this caller's actual
      // terminal lifecycle event, even if native offline was observed earlier.
      if (event.type === "turn_completed" && event.operationId === "cancelled") break;
    }
  })();
  await w.client.request("startTurn", { turnId: "cancelled", input: "hello" });
  await until(f.log, log => log.some(call => call.method === "thread/start"), "Creation not paused");
  await w.client.request("interrupt");
  assert.equal((await w.client.request<AgentTurn>("turn", { turnId: "cancelled" })).status, "running");
  await f.release();
  assert.equal((await terminal(w.client, "cancelled")).status, "interrupted");
  await observed;
  assert.equal(events.filter(event => event.type === "turn_started" && event.operationId === "cancelled").length, 1);
  assert.equal(events.filter(event => event.type === "turn_completed" && event.operationId === "cancelled").length, 1);
  assert.equal(await w.client.request("status"), "offline");
  const [{ pid }] = await f.log();
  assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
  assert.equal((await f.log()).some(call => call.method === "turn/start"), false);
  await assert.rejects(w.client.request("startTurn", { turnId: "retry", input: "hello" }), /503/);
});

test("disconnected stop and repeated signals during creation cannot dispatch or strand the worker", { timeout: 10_000 }, async t => {
  const f = await fixture(t, "paused-create");
  const w = await f.launch();
  await w.client.request("startTurn", { turnId: "stop-preparation", input: "hello" });
  await until(f.log, log => log.some(call => call.method === "thread/start"), "Creation not paused");
  const request = httpRequest(`${w.connection.endpoint}/rpc`, { method: "POST", headers: headers(w.connection) }, response => response.resume());
  request.on("error", () => {});
  request.end(JSON.stringify({ method: "stop" }));
  w.child.kill("SIGTERM");
  w.child.kill("SIGINT");
  request.destroy();
  await f.release();
  await exited(w.child);
  assert.equal(w.child.exitCode, 0);
  const [{ pid }] = await f.log();
  assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
  assert.equal((await f.log()).some(call => call.method === "turn/start"), false);
});

test("stop caller disconnect alone still closes a worker after pending creation settles", { timeout: 10_000 }, async t => {
  const f = await fixture(t, "paused-create");
  const w = await f.launch();
  await w.client.request("startTurn", { turnId: "disconnect-stop", input: "hello" });
  await until(f.log, log => log.some(call => call.method === "thread/start"), "Creation not paused");
  const request = httpRequest(`${w.connection.endpoint}/rpc`, { method: "POST", headers: headers(w.connection) }, response => response.resume());
  request.on("error", () => {});
  request.end(JSON.stringify({ method: "stop" }));
  await until(async () => {
    try { await w.client.request("status"); return false; }
    catch (error) { return /409/.test(String(error)); }
  }, stopped => stopped, "Stop was not admitted");
  request.destroy();
  await f.release();
  await exited(w.child);
  assert.equal(w.child.exitCode, 0);
  const [{ pid }] = await f.log();
  assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
  assert.equal((await f.log()).some(call => call.method === "turn/start"), false);
});

for (const variant of ["generation", "stopped"]) {
  test(`${variant} fence after readiness blocks first input without native creation`, { timeout: 10_000 }, async t => {
    const f = await fixture(t);
    const w = await f.launch();
    await f.store.update(f.identity.id, f.identity.ownerId, 0, variant === "generation"
      ? { generation: "replacement-generation" } : { requiresExplicitResume: true });
    await assert.rejects(w.client.request("startTurn", { turnId: "fenced", input: "hello" }), /503/);
    assert.equal(await w.client.request("status"), "offline");
    assert.deepEqual(await f.log(), []);
  });
}

test("a changed generation between binding and dispatch cannot authorize native input", { timeout: 10_000 }, async t => {
  const f = await fixture(t, "normal", "fence-before-dispatch");
  const w = await f.launch();
  await w.client.request("startTurn", { turnId: "fenced", input: "hello" });
  await until(() => w.client.request<string>("status"), state => state === "offline", "Worker did not fence stale dispatch");
  const [{ pid }] = await until(f.log, log => log.length > 0, "Native launch not logged");
  await until(async () => { try { process.kill(pid, 0); return false; } catch { return true; } }, done => done, "Stale native process not stopped");
  assert.equal((await f.log()).some(call => call.method === "turn/start"), false);
  assert.equal((await f.saved())?.generation, "replacement-generation");
});

for (const fault of ["startup-cleanup-unconfirmed", "binding-cleanup-unconfirmed"]) {
  test(`${fault} retains shutdown authority and refuses false stop confirmation`, { timeout: 10_000 }, async t => {
    const f = await fixture(t, fault.startsWith("startup") ? "mismatch-policy" : "normal", fault);
    const w = await f.launch();
    await w.client.request("startTurn", { turnId: "failed", input: "hello" });
    await until(() => w.client.request<string>("status"), state => state === "offline", "Failed preparation did not become unavailable");
    const failed = await terminal(w.client, "failed");
    assert.equal(failed.status, "failed");
    assert.match(failed.error!, /native exit is unconfirmed/);
    assert.deepEqual(await w.client.request("turn", { turnId: "failed" }), failed);
    assert.deepEqual(await w.client.request("startTurn", { turnId: "failed", input: "hello" }), failed);
    await assert.rejects(w.client.request("startTurn", { turnId: "failed", input: "changed" }), /400/);
    await assert.rejects(w.client.request("startTurn", { turnId: "new-work", input: "hello" }), /503/);
    const saved = (await f.saved())!;
    assert.deepEqual(saved.native, { state: "creating" });
    // Retained results are recoverable, but never bypass exact identity/fences.
    await f.store.update(f.identity.id, f.identity.ownerId, saved.revision,
      fault.startsWith("startup") ? { requiresExplicitResume: true } : { generation: "replacement-generation" });
    await assert.rejects(w.client.request("turn", { turnId: "failed" }), /503/);
    await assert.rejects(w.client.request("startTurn", { turnId: "failed", input: "hello" }), /503/);
    await assert.rejects(new CodexWorkerClient({ ...w.connection, ownerId: "owner-b" }).request("turn", { turnId: "failed" }), /403/);
    await assert.rejects(w.client.request("stop"), /400/);
    assert.equal(w.child.exitCode, null);
    const [{ pid }] = await f.log();
    process.kill(pid, 0); // Still alive in this deliberately unconfirmed-exit probe.
    assert.equal((await f.log()).some(call => call.method === "turn/start"), false);
  });
}

for (const scenario of ["mismatch-policy", "hang", "hang-turn", "interactive"]) {
  test(`${scenario} is failed/unavailable without a fresh native launch or input replay`, { timeout: 10_000 }, async t => {
    const f = await fixture(t, scenario);
    const w = await f.launch();
    await w.client.request("startTurn", { turnId: "failed", input: "hello" });
    assert.equal((await terminal(w.client, "failed")).status, "failed");
    assert.equal(await w.client.request("status"), "offline");
    assert.equal((await w.client.request<AgentTurn>("startTurn", { turnId: "failed", input: "hello" })).status, "failed");
    await assert.rejects(w.client.request("startTurn", { turnId: "replacement", input: "hello" }), /503/);
    assert.equal((await f.log()).filter(call => call.method === "thread/start").length, scenario === "hang" ? 0 : 1);
  });
}

test("a failed turn keeps a healthy native session available without another allocation", { timeout: 10_000 }, async t => {
  const f = await fixture(t, "failed");
  const w = await f.launch();
  for (const turnId of ["one", "two"]) {
    await w.client.request("startTurn", { turnId, input: turnId });
    assert.equal((await terminal(w.client, turnId)).status, "failed");
    assert.equal(await w.client.request("status"), "idle");
  }
  assert.equal((await f.log()).filter(call => call.method === "thread/start").length, 1);
  assert.equal((await f.log()).filter(call => call.method === "turn/start").length, 2);
});

test("missing executable fails first use, preserves uncertainty and still permits confirmed worker cleanup", { timeout: 10_000 }, async t => {
  const f = await fixture(t);
  const w = await f.launch({ options: { command: "/no-such-codex-worker-executable", requestTimeoutMs: 1_000, shutdownTimeoutMs: 100 } });
  assert.equal(w.type, "ready");
  await w.client.request("startTurn", { turnId: "failed", input: "hello" });
  assert.equal((await terminal(w.client, "failed")).status, "failed");
  assert.deepEqual((await f.saved())?.native, { state: "creating" });
  await w.client.request("stop");
  await exited(w.child);
  assert.equal(w.child.exitCode, 0);
  assert.deepEqual(await f.log(), []);
});

test("worker SIGKILL during creation preserves an uncertain state without replacement or input", { timeout: 10_000 }, async t => {
  const f = await fixture(t, "paused-create");
  const w = await f.launch();
  await w.client.request("startTurn", { turnId: "uncertain", input: "hello" });
  await until(f.log, log => log.some(call => call.method === "thread/start"), "Creation not paused");
  w.child.kill("SIGKILL");
  await exited(w.child);
  const after = await f.launch();
  assert.equal(after.type, "failed");
  await exited(after.child);
  assert.deepEqual((await f.saved())?.native, { state: "creating" });
  assert.equal((await f.log()).filter(call => call.method === "thread/start").length, 1);
  assert.equal((await f.log()).some(call => call.method === "turn/start"), false);
});

test("worker SIGKILL after first dispatch cannot be treated as an empty pending session", { timeout: 10_000 }, async t => {
  const f = await fixture(t, "held");
  const w = await f.launch();
  await w.client.request("startTurn", { turnId: "uncertain", input: "hello" });
  await until(f.log, log => log.some(call => call.method === "turn/start"), "Turn not dispatched");
  w.child.kill("SIGKILL");
  await exited(w.child);
  const after = await f.launch();
  assert.equal(after.type, "failed");
  await exited(after.child);
  assert.deepEqual((await f.saved())?.native, { state: "bound", threadId: "native-thread" });
  assert.equal((await f.log()).filter(call => call.method === "thread/start").length, 1);
  assert.equal((await f.log()).filter(call => call.method === "turn/start").length, 1);
});

test("pending launch cannot override saved config, sandbox, native binding or owner", { timeout: 10_000 }, async t => {
  const f = await fixture(t);
  const overrides = [
    { config: { cwd: f.directory } }, { threadId: "another-thread" },
    { options: { sandbox: "workspace-write" } },
    { identity: { sessionId: f.identity.id, ownerId: "owner-b", generation: f.identity.generation } },
  ];
  for (const override of overrides) {
    const w = await f.launch(override);
    assert.equal(w.type, "failed");
    await exited(w.child);
  }
  assert.deepEqual(await f.log(), []);
  assert.deepEqual((await f.saved())?.native, { state: "pending" });
});

test("worker retains only the configured terminal-turn window", { timeout: 10_000 }, async t => {
  const f = await fixture(t, "normal", undefined, 2);
  const w = await f.launch();
  for (const turnId of ["one", "two", "three"]) {
    await w.client.request("startTurn", { turnId, input: turnId });
    assert.equal((await terminal(w.client, turnId)).status, "completed");
  }
  assert.equal(await w.client.request("turn", { turnId: "one" }), null);
  assert.equal((await w.client.request<AgentTurn>("turn", { turnId: "two" })).status, "completed");
  assert.equal((await f.log()).filter(call => call.method === "thread/start").length, 1);
});
