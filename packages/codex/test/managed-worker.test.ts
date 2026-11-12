import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, realpath, rm, stat, writeFile, chmod, symlink } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import test, { type TestContext } from "node:test";
import type { AddressInfo } from "node:net";
import type { AgentTurn } from "@minu/runtime-core";
import { CodexManagedStore, assertCodexWorkerClaim } from "../src/managed-store.js";
import { createPendingCodexSession, allocatePendingCodexThread } from "../src/managed-native.js";
import { launchOrReconnectCodexWorker, reconnectCodexWorker, finalizeCodexWorkerRetirement } from "../src/managed-worker.js";
import { openPendingCodexWorker } from "../src/pending-worker.js";
import { CodexWorkerClient } from "../src/worker-client.js";
import type { CodexWorkerConnection } from "../src/worker-identity.js";

function exists(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

async function waitGone(pid: number): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (exists(pid) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(exists(pid), false, "Fixture process must exit");
}

async function fixture(t: TestContext, scenario = "normal") {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "codex-registration-")));
  const root = join(directory, "managed");
  const store = new CodexManagedStore(root);
  const identity = { id: "managed-id", ownerId: "owner-a", generation: "generation-a" };
  const log = join(directory, "native.jsonl");
  const native = { command: process.execPath,
    args: [fileURLToPath(new URL("./fixtures/app-server.js", import.meta.url)), scenario, log],
    requestTimeoutMs: 2_000, shutdownTimeoutMs: 100 };
  const connections: CodexWorkerConnection[] = [];
  const pids = new Set<number>();
  const failedBarrierPids = new Set<number>();
  t.after(async () => {
    for (const connection of connections) {
      try { await new CodexWorkerClient(connection).request("stop"); }
      catch { if (exists(connection.pid)) process.kill(connection.pid, "SIGTERM"); }
    }
    // Test-only cleanup of exact processes reported by our fixture/controller,
    // not production liveness inference or authority to replace a registration.
    for (const pid of pids) {
      // Only explicitly marked owned fault fixtures whose intentional barrier
      // rejection forbids graceful exit; never a production recovery path.
      if (failedBarrierPids.has(pid) && exists(pid)) process.kill(pid, "SIGKILL");
      if (exists(pid)) process.kill(pid, "SIGTERM");
      await waitGone(pid);
    }
    await rm(directory, { recursive: true, force: true });
  });
  await createPendingCodexSession(store, identity, { cwd: directory });
  return { directory, root, store, identity, native, log, connections, pids, failedBarrierPids,
    async launch() {
      const connection = await launchOrReconnectCodexWorker(root, identity, { native });
      connections.push(connection); pids.add(connection.pid); return connection;
    },
    async calls(): Promise<Array<Record<string, any>>> {
      try {
        const text = (await readFile(log, "utf8")).trim();
        return text ? text.split("\n").map(line => JSON.parse(line)) : [];
      }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
    },
  };
}

async function settle(client: CodexWorkerClient, turnId: string): Promise<AgentTurn> {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    const turn = await client.request<AgentTurn>("turn", { turnId });
    if (turn.status !== "running") return turn;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error("Turn did not settle");
}

async function explicitV5(f: Awaited<ReturnType<typeof fixture>>) {
  const path = join(f.root, createHash("sha256").update(f.identity.ownerId).digest("hex"), `${f.identity.id}.session`, "manifest.json");
  const current = (await f.store.read(f.identity.id, f.identity.ownerId))!;
  await writeFile(path, JSON.stringify({ ...current, version: 5 }));
}

function domainController(t: TestContext, f: Awaited<ReturnType<typeof fixture>>, mode: string, target?: Parameters<typeof finalizeCodexWorkerRetirement>[1]) {
  const controller = fork(new URL("./fixtures/registration-controller.js", import.meta.url), [], { stdio: ["ignore", "ignore", "ignore", "ipc"] });
  t.after(() => { controller.kill("SIGKILL"); });
  const exited = once(controller, "exit"); let adopted!: () => void, visible!: () => void;
  const finalizedVisible = new Promise<void>(resolve => { visible = resolve; });
  const adoptable = new Promise<void>(resolve => { adopted = resolve; });
  const result = new Promise<any>(resolve => controller.on("message", (message: any) => {
    if (message.type === "spawned") f.pids.add(message.pid);
    if (message.type === "adoptable") adopted();
    if (message.type === "finalized-visible") visible();
    if (message.type === "done") resolve(message);
  }));
  controller.send({ root: f.root, identity: f.identity, mode, native: f.native, ...(target ? { target } : {}) });
  const queries = async (): Promise<string[]> => {
    try { return (await readFile(join(f.root, ".domain-queries"), "utf8")).trim().split("\n").filter(Boolean); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
  };
  return { controller, result, exited, adoptable, finalizedVisible, queries };
}

async function untilQueries(c: ReturnType<typeof domainController>, actor: string) {
  const deadline = Date.now() + 3_000;
  while (!(await c.queries()).some(line => line.startsWith(actor + ":"))) {
    if (Date.now() >= deadline) throw new Error("Fixture query boundary not reached");
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

type FinalizationTarget = Parameters<typeof finalizeCodexWorkerRetirement>[1];
async function finalizationFixture(t: TestContext, bound = false) {
  const f = await fixture(t); await explicitV5(f);
  const connection: CodexWorkerConnection = { version: 1, ownerId: f.identity.ownerId, generation: f.identity.generation,
    sessionId: f.identity.id, claimId: "fixture-claim", pid: 4242, endpoint: "http://127.0.0.1:12345", token: "a".repeat(64) };
  const obs = { ioPlatformUuid: "11111111-2222-4333-8444-555555555555", bootSessionUuid: "66666666-7777-4888-8999-aaaaaaaaaaaa" };
  const current = await f.store.withSessionLock(f.identity.id, f.identity.ownerId, async lease => {
    let value = (await f.store.read(f.identity.id, f.identity.ownerId))!;
    value = await lease.reserveWorker(value.revision, connection.claimId!); value = await lease.recordWorkerPid(value.revision, connection.claimId!, connection.pid);
    value = await lease.publishWorkerReady(value.revision, connection);
    value = await lease.recordProcessDomain(value.revision, { connection, launcher: obs, worker: obs });
    if (bound) { value = await lease.beginNativeCreation(value.revision); value = await lease.bindNativeThread(value.revision, "captured-native"); }
    const intent = { operationId: "retire-a", native: bound ? { state: "bound" as const, threadId: "captured-native" } : { state: "pending" as const } };
    value = await lease.beginRetirementIntent(value.revision, connection, intent);
    return lease.recordNativeQuiesce(value.revision, connection, intent, { kind: bound ? "owned_exit" : "never_started" });
  });
  if (current.worker.state !== "retiring") throw new Error("Expected synthetic retiring fixture");
  const target: FinalizationTarget = { identity: { ...f.identity }, expectedRevision: current.revision, connection: { ...connection }, intent: structuredClone(current.worker.retirement) };
  const path = join(f.root, createHash("sha256").update(f.identity.ownerId).digest("hex"), `${f.identity.id}.session`, "manifest.json");
  const count = async (name: string) => {
    try { return (await readFile(join(f.root, name), "utf8")).trim().split("\n").filter(Boolean).length; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0; throw error; }
  };
  return { ...f, current, target, path, count };
}

for (const bound of [false, true]) {
  test(`controller finalization ${bound ? "bound" : "pending"} preserves binding and exposes read-only retired inspection`, { timeout: 15_000 }, async t => {
    const f = await finalizationFixture(t, bound); const c = domainController(t, f, "domain-finalize-absent", f.target);
    const result = await c.result; assert.equal(result.ok, true); await c.exited;
    assert.deepEqual(result.result, { status: "finalized", revision: f.current.revision + 1 });
    const retired = (await f.store.read(f.identity.id, f.identity.ownerId))!;
    assert.deepEqual(retired.native, f.current.native); assert.deepEqual(retired.launchConfig, f.current.launchConfig);
    assert.equal(retired.worker.state, "retired"); assert.equal(await f.count(".finalize-attempts"), 1);
    assert.equal(await f.count(".domain-signals"), 1); assert.equal((await c.queries()).length, 2); assert.equal(f.pids.size, 0); assert.deepEqual(await f.calls(), []);
    await assert.rejects(finalizeCodexWorkerRetirement(f.root, f.target));
    assert.deepEqual(await finalizeCodexWorkerRetirement(f.root, { ...f.target, expectedRevision: retired.revision }), { status: "already_retired", revision: retired.revision });
    const inspector = domainController(t, f, "domain-finalize-absent", { ...f.target, expectedRevision: retired.revision });
    const inspected = await inspector.result; assert.equal(inspected.ok, true); await inspector.exited;
    assert.deepEqual(inspected.result, { status: "already_retired", revision: retired.revision }); assert.equal((await inspector.queries()).length, 2);
    assert.deepEqual(await f.store.read(f.identity.id, f.identity.ownerId), retired);
    assert.equal(await f.count(".finalize-attempts"), 1); assert.equal(await f.count(".domain-signals"), 1);
    await f.store.update(retired.id, retired.ownerId, retired.revision, { requiresExplicitResume: true });
    await assert.rejects(finalizeCodexWorkerRetirement(f.root, { ...f.target, expectedRevision: retired.revision + 1 }));
    assert.equal((await f.store.list(retired.ownerId))[0].worker.state, "retired");
  });
}

for (const [name, change] of [
  ["revision", (v: any) => { v.expectedRevision--; }], ["revision type", (v: any) => { v.expectedRevision = "6"; }],
  ["owner", (v: any) => { v.identity.ownerId = "other-owner"; }], ["session", (v: any) => { v.identity.id = "other-session"; }],
  ["generation", (v: any) => { v.identity.generation = "other-generation"; }], ["extra identity", (v: any) => { v.identity.extra = true; }],
  ["connection version", (v: any) => { v.connection.version = 2; }], ["connection owner", (v: any) => { v.connection.ownerId = "other-owner"; }],
  ["connection session", (v: any) => { v.connection.sessionId = "other-session"; }], ["connection generation", (v: any) => { v.connection.generation = "other-generation"; }],
  ["claim", (v: any) => { v.connection.claimId = "other-claim"; }], ["PID", (v: any) => { v.connection.pid++; }],
  ["PID range", (v: any) => { v.connection.pid = 0x80000000; }], ["token", (v: any) => { v.connection.token = "b".repeat(64); }],
  ["endpoint", (v: any) => { v.connection.endpoint = "http://127.0.0.1:12346"; }], ["operation", (v: any) => { v.intent.operationId = "other-operation"; }],
  ["malformed operation", (v: any) => { v.intent.operationId = "../bad"; }], ["native", (v: any) => { v.intent.native = { state: "bound", threadId: "other-native" }; }],
  ["creating", (v: any) => { v.intent.native = { state: "creating" }; }], ["extra native", (v: any) => { v.intent.native.extra = true; }],
  ["caller fact", (v: any) => { v.nativeFact = true; }], ["caller absence", (v: any) => { v.absence = true; }],
] as const) {
  test(`controller finalization rejects expected ${name} before observation`, { timeout: 15_000 }, async t => {
    const f = await finalizationFixture(t); const input = structuredClone(f.target); change(input);
    const c = domainController(t, f, "domain-finalize-absent", input); const result = await c.result;
    assert.equal(result.ok, false); assert.equal(result.name, "CodexWorkerUnavailableError"); assert.equal(result.hasCause, false); await c.exited;
    assert.equal((await c.queries()).length, 0); assert.equal(await f.count(".domain-signals"), 0); assert.equal(await f.count(".finalize-attempts"), 0);
    assert.deepEqual(await f.store.read(f.identity.id, f.identity.ownerId), f.current);
  });
}

for (const change of ["v4", "ready", "uncorrelated", "missing-native-fact", "wrong-native-fact", "domain", "explicit", "generation"] as const) {
  test(`controller finalization rejects stored ${change} before observation`, { timeout: 15_000 }, async t => {
    const f = await finalizationFixture(t); const invalid = structuredClone(f.current) as any;
    if (change === "v4") { invalid.version = 4; delete invalid.processDomain; }
    else if (change === "ready") { invalid.worker.state = "ready"; delete invalid.worker.retirement; delete invalid.worker.nativeQuiesce; }
    else if (change === "uncorrelated") delete invalid.processDomain;
    else if (change === "missing-native-fact") delete invalid.worker.nativeQuiesce;
    else if (change === "wrong-native-fact") invalid.worker.nativeQuiesce = { kind: "owned_exit" };
    else if (change === "domain") invalid.processDomain.worker.bootSessionUuid = "bbbbbbbb-cccc-4ddd-8eee-ffffffffffff";
    else if (change === "explicit") invalid.requiresExplicitResume = true; else invalid.generation = "other-generation";
    const bytes = JSON.stringify(invalid); await writeFile(f.path, bytes);
    const c = domainController(t, f, "domain-finalize-absent", f.target); assert.equal((await c.result).ok, false); await c.exited;
    assert.equal((await c.queries()).length, 0); assert.equal(await f.count(".domain-signals"), 0); assert.equal(await readFile(f.path, "utf8"), bytes);
  });
}

for (const outcome of ["present", "permission", "unknown", "unsupported", "unconfirmed"] as const) {
  test(`controller finalization ${outcome} is unavailable without mutation`, { timeout: 15_000 }, async t => {
    const f = await finalizationFixture(t); const c = domainController(t, f, `domain-finalize-${outcome}`, f.target);
    const result = await c.result; assert.equal(result.ok, true); await c.exited;
    assert.deepEqual(result.result, { status: outcome === "present" ? "pid_present" : "unconfirmed", revision: f.current.revision });
    assert.deepEqual(await f.store.read(f.identity.id, f.identity.ownerId), f.current); assert.equal(await f.count(".finalize-attempts"), 0);
    assert.equal(await f.count(".domain-signals"), outcome === "unsupported" || outcome === "unconfirmed" ? 0 : 1);
  });
}

for (const outcome of ["absent", "present", "unconfirmed"] as const) {
  const changes = outcome === "absent" ? ["revision", "generation", "explicit", "domain", "operation", "connection", "native", "fact", "retired"] : ["revision", "explicit", "domain"];
  for (const change of changes) {
    test(`controller finalization revalidates ${change} after ${outcome} observation outside lock`, { timeout: 15_000 }, async t => {
      const f = await finalizationFixture(t); const c = domainController(t, f, `domain-finalize-pause-${outcome}`, f.target);
      await untilQueries(c, "launcher");
      await f.store.withSessionLock(f.identity.id, f.identity.ownerId, async lease => {
        const current = structuredClone(f.current) as any;
        if (change === "revision") await lease.update(current.revision, { requiresExplicitResume: false });
        else {
          if (change === "generation") current.generation = "other-generation";
          else if (change === "explicit") current.requiresExplicitResume = true;
          else if (change === "domain") current.processDomain.launcher.bootSessionUuid = current.processDomain.worker.bootSessionUuid = "bbbbbbbb-cccc-4ddd-8eee-ffffffffffff";
          else if (change === "operation") current.worker.retirement.operationId = "other-operation";
          else if (change === "connection") current.worker.connection.token = current.processDomain.connection.token = "b".repeat(64);
          else if (change === "native") { current.native = current.worker.retirement.native = { state: "bound", threadId: "other-native" }; current.worker.nativeQuiesce = { kind: "owned_exit" }; }
          else if (change === "fact") delete current.worker.nativeQuiesce;
          else { current.worker.state = "retired"; current.worker.workerAbsence = { pid: f.target.connection.pid, domain: current.processDomain.launcher, result: "pid_absent" }; }
          await writeFile(f.path, JSON.stringify(current));
        }
      }, 500);
      const before = await readFile(f.path, "utf8"); c.controller.send("trigger");
      assert.equal((await c.result).ok, false); await c.exited; assert.equal(await readFile(f.path, "utf8"), before); assert.equal(await f.count(".finalize-attempts"), 0);
    });
  }
}

test("controller finalization snapshots nested expected inputs before awaits", { timeout: 15_000 }, async t => {
  const f = await finalizationFixture(t, true); const c = domainController(t, f, "domain-finalize-mutate", f.target);
  const result = await c.result; assert.equal(result.ok, true); await c.exited; assert.equal(result.result.status, "finalized");
  assert.deepEqual((await f.store.read(f.identity.id, f.identity.ownerId))!.native, f.current.native);
});

for (const point of ["before-rename", "after-rename", "readback"] as const) {
  test(`controller finalization ${point} failure is not relabeled/retried`, { timeout: 15_000 }, async t => {
    const f = await finalizationFixture(t); const c = domainController(t, f, `domain-finalize-${point}`, f.target);
    const result = await c.result; assert.equal(result.ok, false); assert.equal(result.hasCause, false); await c.exited;
    const current = (await f.store.read(f.identity.id, f.identity.ownerId))!; assert.equal(current.worker.state, point === "before-rename" ? "retiring" : "retired");
    assert.equal(await f.count(".finalize-attempts"), 1); assert.equal(await f.count(".domain-signals"), 1);
    if (point !== "before-rename") {
      await assert.rejects(finalizeCodexWorkerRetirement(f.root, f.target));
      assert.deepEqual(await finalizeCodexWorkerRetirement(f.root, { ...f.target, expectedRevision: current.revision }), { status: "already_retired", revision: current.revision });
    }
    assert.equal(await f.count(".finalize-attempts"), 1);
  });
}

for (const outcome of ["delay", "error"] as const) {
  test(`controller finalization lock-return ${outcome} cannot be stolen by retired inspection`, { timeout: 15_000 }, async t => {
    const f = await finalizationFixture(t); const c = domainController(t, f, `domain-finalize-lock-${outcome}`, f.target); let done = false;
    void c.result.then(() => { done = true; }); await c.finalizedVisible;
    try {
      const current = (await f.store.read(f.identity.id, f.identity.ownerId))!; assert.equal(current.worker.state, "retired"); assert.equal(done, false);
      await assert.rejects(finalizeCodexWorkerRetirement(f.root, f.target));
      assert.deepEqual(await finalizeCodexWorkerRetirement(f.root, { ...f.target, expectedRevision: current.revision }), { status: "already_retired", revision: current.revision });
      assert.equal(done, false);
    } finally { c.controller.send("trigger"); }
    const result = await c.result; assert.equal(result.ok, outcome === "delay"); await c.exited;
    if (result.ok) assert.equal(result.result.status, "finalized"); else assert.equal(result.name, "CodexWorkerUnavailableError");
    assert.equal(await f.count(".finalize-attempts"), 1);
  });
}

test("concurrent controller finalizers cannot silently adopt the winner revision", { timeout: 15_000 }, async t => {
  const f = await finalizationFixture(t); const controllers = [domainController(t, f, "domain-finalize-absent", f.target), domainController(t, f, "domain-finalize-absent", f.target)];
  const results = await Promise.all(controllers.map(c => c.result)); await Promise.all(controllers.map(c => c.exited));
  assert.equal(results.filter(result => result.ok).length, 1); assert.equal(results.filter(result => !result.ok).length, 1);
  assert.equal(await f.count(".finalize-attempts"), 1); assert.equal((await f.store.read(f.identity.id, f.identity.ownerId))!.revision, f.current.revision + 1);
});

test("unmocked Darwin retirement absence/finalization round trip (private identifiers redacted)", { timeout: 15_000, skip: process.platform !== "darwin" }, async t => {
  const f = await fixture(t); await explicitV5(f); const connection = await f.launch(); const client = new CodexWorkerClient(connection);
  await client.retire("retire-a"); await waitGone(connection.pid);
  const retiring = (await f.store.read(f.identity.id, f.identity.ownerId))!;
  assert.ok(retiring.worker.state === "retiring" && retiring.worker.nativeQuiesce, "Recorded native fact [redacted]");
  if (retiring.worker.state !== "retiring") throw new Error("Expected private retiring material [redacted]");
  const result = await finalizeCodexWorkerRetirement(f.root, { identity: f.identity, expectedRevision: retiring.revision, connection, intent: retiring.worker.retirement });
  assert.ok(result.status === "finalized" && result.revision === retiring.revision + 1, "Fresh Darwin observation and final CAS [redacted]");
  const current = (await f.store.read(f.identity.id, f.identity.ownerId))!;
  assert.ok(current.worker.state === "retired" && current.native.state === "pending", "Private retired binding [redacted]"); assert.equal((await f.calls()).length, 0);
});

async function retiringWorker(t: TestContext, mode = "domain-normal", scenario = "normal") {
  const f = await fixture(t, scenario); await explicitV5(f); const c = domainController(t, f, mode);
  const result = await c.result; assert.equal(result.ok, true); await c.exited;
  const connection = result.connection as CodexWorkerConnection; f.connections.push(connection);
  if (["domain-retire-before", "domain-retire-after", "domain-retire-lock-error", "domain-retire-close-error", "domain-retire-visible"].includes(mode)) f.failedBarrierPids.add(connection.pid);
  return { ...f, connection, client: new CodexWorkerClient(connection) };
}

async function factVisible(f: Awaited<ReturnType<typeof retiringWorker>>) {
  const deadline = Date.now() + 3_000;
  while (true) {
    try { await readFile(join(f.root, ".retirement-fact-visible")); return; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    if (Date.now() >= deadline) throw new Error("Native-fact fixture gate not reached");
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

for (const bound of [false, true]) {
  test(`private retirement ${bound ? "bound" : "pending"} publishes before separately observed worker exit`, { timeout: 15_000 }, async t => {
    const f = await retiringWorker(t);
    if (bound) { await f.client.request("startTurn", { turnId: "settled", input: "hello" }); await settle(f.client, "settled"); }
    const before = (await f.store.read(f.identity.id, f.identity.ownerId))!;
    const ack = await f.client.retire("retire-a"); assert.deepEqual(ack, { operationId: "retire-a", phase: "native_fact_published" });
    const current = (await f.store.read(f.identity.id, f.identity.ownerId))!;
    assert.equal(current.worker.state, "retiring"); assert.deepEqual(current.native, before.native);
    if (current.worker.state === "retiring") assert.deepEqual(current.worker.nativeQuiesce, { kind: bound ? "owned_exit" : "never_started" });
    await waitGone(f.connection.pid); // Separate fixture observation; acknowledgment is not exit.
    if (bound) await waitGone((await f.calls())[0].pid); else assert.deepEqual(await f.calls(), []);
    await assert.rejects(f.launch());
  });
}

for (const scenario of ["held", "paused-create"]) {
  test(`private retirement rejects busy ${scenario} and allows a later explicit idle request`, { timeout: 15_000 }, async t => {
    const f = await retiringWorker(t, "domain-normal", scenario);
    await f.client.request("startTurn", { turnId: "busy", input: "hello" });
    const deadline = Date.now() + 3_000;
    while (!(await f.calls()).some(call => call.method === (scenario === "held" ? "turn/start" : "thread/start")) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
    const before = await f.store.read(f.identity.id, f.identity.ownerId);
    await assert.rejects(f.client.retire("busy-op")); assert.deepEqual(await f.store.read(f.identity.id, f.identity.ownerId), before);
    assert.ok(exists(f.connection.pid));
    if (scenario === "held") await f.client.request("interrupt"); else await writeFile(`${f.log}.release`, "release");
    await settle(f.client, "busy");
    assert.equal((await f.client.retire("idle-op")).phase, "native_fact_published"); await waitGone(f.connection.pid);
    await waitGone((await f.calls())[0].pid);
  });
}

for (const signal of [false, true]) {
  test(`visible native fact does not steal duplicate acknowledgment/closure${signal ? " during SIGTERM" : ""}`, { timeout: 15_000 }, async t => {
    const f = await retiringWorker(t, "domain-retire-visible"); let finished = 0;
    const observe = (p: Promise<unknown>) => p.then(value => { finished++; return value; }, error => { finished++; return error; });
    const first = observe(f.client.retire("retire-a")); let duplicate!: Promise<unknown>;
    try {
      await factVisible(f); const current = (await f.store.read(f.identity.id, f.identity.ownerId))!;
      assert.ok(current.worker.state === "retiring" && current.worker.nativeQuiesce);
      duplicate = observe(f.client.retire("retire-a")); await assert.rejects(f.client.retire("wrong-operation"));
      if (signal) process.kill(f.connection.pid, "SIGTERM");
      await new Promise(resolve => setTimeout(resolve, 20)); assert.equal(finished, 0); assert.ok(exists(f.connection.pid));
      await assert.rejects(f.client.request("status")); // Ordinary ready authorization stays fenced.
    } finally { await writeFile(join(f.root, ".retirement-release"), "release"); }
    const values = [await first, await duplicate]; if (!signal) assert.ok(values.some(value => !(value instanceof Error)));
    await waitGone(f.connection.pid);
  });
}

for (const mode of ["domain-retire-before", "domain-retire-after", "domain-retire-lock-error"]) {
  test(`${mode} remains terminal even with visible facts and explicit signal/duplicate closure attempts`, { timeout: 15_000 }, async t => {
    const f = await retiringWorker(t, mode); const first = f.client.retire("retire-a"); const rejection = assert.rejects(first);
    if (mode === "domain-retire-lock-error") { await factVisible(f); await writeFile(join(f.root, ".retirement-release"), "release"); }
    await rejection; const current = (await f.store.read(f.identity.id, f.identity.ownerId))!;
    assert.ok(current.worker.state === "retiring");
    if (current.worker.state === "retiring") assert.equal(Boolean(current.worker.nativeQuiesce), mode !== "domain-retire-before");
    await assert.rejects(f.client.retire("retire-a")); await assert.rejects(f.client.retire("other-operation")); await assert.rejects(f.client.request("stop"));
    process.kill(f.connection.pid, "SIGTERM"); await new Promise(resolve => setTimeout(resolve, 20)); assert.ok(exists(f.connection.pid));
    await assert.rejects(f.client.retire("retire-a")); assert.deepEqual(await f.store.read(f.identity.id, f.identity.ownerId), current);
  });
}

test("retirement publication acknowledgment does not claim successful bridge closure", { timeout: 15_000 }, async t => {
  const f = await retiringWorker(t, "domain-retire-close-error");
  assert.equal((await f.client.retire("retire-a")).phase, "native_fact_published");
  await new Promise(resolve => setTimeout(resolve, 20)); assert.ok(exists(f.connection.pid));
  const current = (await f.store.read(f.identity.id, f.identity.ownerId))!; assert.ok(current.worker.state === "retiring" && current.worker.nativeQuiesce);
});

test("lost retirement acknowledgment still publishes and exits without a resend", { timeout: 15_000 }, async t => {
  const f = await retiringWorker(t, "domain-retire-visible");
  const request = (await import("node:http")).request(`${f.connection.endpoint}/retire`, { method: "POST", headers: {
    authorization: `Bearer ${f.connection.token}`, "x-minu-runtime-owner": f.connection.ownerId, "x-minu-runtime-session": f.connection.sessionId,
    "x-minu-runtime-generation": f.connection.generation, "content-type": "application/json" } }); request.on("error", () => {});
  request.end(JSON.stringify({ operationId: "retire-a", version: f.connection.version, pid: f.connection.pid, claimId: f.connection.claimId }));
  await factVisible(f); request.destroy(); await writeFile(join(f.root, ".retirement-release"), "release");
  await waitGone(f.connection.pid); const current = (await f.store.read(f.identity.id, f.identity.ownerId))!;
  assert.ok(current.worker.state === "retiring" && current.worker.nativeQuiesce);
});

test("worker loss after visible native fact is not a controlled exit acknowledgment or replacement grant", { timeout: 15_000 }, async t => {
  const f = await retiringWorker(t, "domain-retire-visible"); const rejection = assert.rejects(f.client.retire("retire-a"));
  await factVisible(f); process.kill(f.connection.pid, "SIGKILL"); await rejection; await waitGone(f.connection.pid);
  const current = (await f.store.read(f.identity.id, f.identity.ownerId))!; assert.ok(current.worker.state === "retiring" && current.worker.nativeQuiesce);
  await assert.rejects(f.launch()); assert.deepEqual(await f.store.read(f.identity.id, f.identity.ownerId), current);
});

test("fencing after publication prevents cached retirement success and controlled closure", { timeout: 15_000 }, async t => {
  const f = await retiringWorker(t, "domain-retire-visible"); const rejection = assert.rejects(f.client.retire("retire-a"));
  await factVisible(f); const current = (await f.store.read(f.identity.id, f.identity.ownerId))!;
  await f.store.update(current.id, current.ownerId, current.revision, { requiresExplicitResume: true });
  await writeFile(join(f.root, ".retirement-release"), "release"); await rejection;
  await assert.rejects(f.client.retire("retire-a")); assert.ok(exists(f.connection.pid));
});

for (const stop of ["ordinary", "SIGTERM"] as const) {
  test(`${stop} winning before retirement leaves no retirement intent or fact`, { timeout: 15_000 }, async t => {
    const f = await retiringWorker(t); const before = await f.store.read(f.identity.id, f.identity.ownerId);
    if (stop === "ordinary") await f.client.request("stop"); else process.kill(f.connection.pid, "SIGTERM");
    await waitGone(f.connection.pid); await assert.rejects(f.client.retire("retire-a"));
    assert.deepEqual(await f.store.read(f.identity.id, f.identity.ownerId), before);
  });
}

test("v4 and uncorrelated v5 reject retirement without changing ordinary controls", { timeout: 15_000 }, async t => {
  const f = await fixture(t); const connection = await f.launch(); const client = new CodexWorkerClient(connection);
  const before = await f.store.read(f.identity.id, f.identity.ownerId); await assert.rejects(client.retire("retire-a"));
  assert.deepEqual(await f.store.read(f.identity.id, f.identity.ownerId), before); assert.equal(await client.request("status"), "idle");
  await explicitV5(f); const snapshot = await f.store.read(f.identity.id, f.identity.ownerId); await assert.rejects(client.retire("retire-a"));
  assert.deepEqual(await f.store.read(f.identity.id, f.identity.ownerId), snapshot); assert.equal(await client.request("status"), "idle");
});

test("explicit v5 independently collects in launcher/worker and binds the exact authenticated child", { timeout: 15_000 }, async t => {
  const f = await fixture(t); await explicitV5(f); const c = domainController(t, f, "domain-normal");
  const result = await c.result; assert.equal(result.ok, true); await c.exited;
  const connection = result.connection as CodexWorkerConnection; f.connections.push(connection);
  const current = (await f.store.read(f.identity.id, f.identity.ownerId))!;
  assert.equal(current.version, 5); assert.equal(current.worker.state, "ready"); assert.ok(f.pids.has(connection.pid));
  assert.deepEqual(current.processDomain, { connection,
    launcher: { ioPlatformUuid: "11111111-2222-4333-8444-555555555555", bootSessionUuid: "66666666-7777-4888-8999-aaaaaaaaaaaa" },
    worker: { ioPlatformUuid: "11111111-2222-4333-8444-555555555555", bootSessionUuid: "66666666-7777-4888-8999-aaaaaaaaaaaa" } });
  assert.deepEqual((await c.queries()).sort(), ["launcher:ioreg", "launcher:sysctl", "worker:ioreg", "worker:sysctl"]);
  assert.equal(await readFile(join(f.root, ".domain-protocol"), "utf8"), "no-inherited-observation\n");
  const before = await f.store.read(f.identity.id, f.identity.ownerId);
  assert.deepEqual(await f.launch(), connection); assert.deepEqual(await reconnectCodexWorker(f.root, f.identity), connection);
  assert.deepEqual(await f.store.read(f.identity.id, f.identity.ownerId), before); assert.equal((await c.queries()).length, 4);
  assert.deepEqual(await f.calls(), []);
});

test("unmocked Darwin v5 launcher/worker correlation round trip (identifiers redacted)", { timeout: 15_000, skip: process.platform !== "darwin" }, async t => {
  const f = await fixture(t); await explicitV5(f);
  const connection = await f.launch(); const current = await f.store.read(f.identity.id, f.identity.ownerId);
  const domain = current?.processDomain;
  assert.ok(current?.version === 5 && current.worker.state === "ready" && domain, "Private v5 correlation must exist [redacted]");
  assert.ok(domain && (["version", "ownerId", "sessionId", "generation", "claimId", "pid", "endpoint", "token"] as const)
    .every(key => domain.connection[key] === connection[key]), "Exact connection correlation [redacted]");
  assert.ok(domain && domain.launcher.ioPlatformUuid === domain.worker.ioPlatformUuid
    && domain.launcher.bootSessionUuid === domain.worker.bootSessionUuid, "Independent Darwin observations agree [redacted]");
  assert.equal((await f.calls()).length, 0);
  await new CodexWorkerClient(connection).request("stop"); await waitGone(connection.pid);
});

for (const mode of ["domain-launcher-unavailable", "domain-worker-unavailable", "domain-worker-malformed"]) {
  test(`${mode} fails closed without ready enrollment or native allocation`, { timeout: 15_000 }, async t => {
    const f = await fixture(t); await explicitV5(f); const c = domainController(t, f, mode);
    assert.equal((await c.result).ok, false); await c.exited;
    const current = (await f.store.read(f.identity.id, f.identity.ownerId))!;
    assert.equal(current.worker.state, mode === "domain-launcher-unavailable" ? "none" : "aborted");
    assert.equal(current.processDomain, undefined); assert.deepEqual(await f.calls(), []);
    if (mode === "domain-launcher-unavailable") assert.equal(f.pids.size, 0);
    for (const pid of f.pids) await waitGone(pid);
  });
}

for (const mode of ["domain-mismatch", "domain-missing-report", "domain-array-report", "domain-boolean-report", "domain-nil-report", "domain-extra-report", "domain-uppercase-report", "domain-lost-ack",
  "domain-wrong-pid", "domain-wrong-owner", "domain-wrong-session", "domain-wrong-generation", "domain-wrong-claim", "domain-wrong-token", "domain-wrong-endpoint", "domain-wrong-version",
  "domain-record-before", "domain-record-after"]) {
  test(`${mode} preserves durable readiness and never retries correlation on adoption`, { timeout: 15_000 }, async t => {
    const f = await fixture(t); await explicitV5(f); const c = domainController(t, f, mode);
    const result = await c.result; assert.equal(result.ok, false); assert.equal(result.name, "CodexWorkerUnavailableError"); await c.exited;
    const before = (await f.store.read(f.identity.id, f.identity.ownerId))!;
    assert.equal(before.worker.state, "ready"); assert.equal(Boolean(before.processDomain), mode === "domain-record-after");
    const connection = await f.launch(); assert.ok(f.pids.has(connection.pid));
    assert.deepEqual(await f.store.read(f.identity.id, f.identity.ownerId), before);
    assert.equal((await c.queries()).length, 4); assert.deepEqual(await f.calls(), []);
  });
}

test("v4 launch/reconnect performs no queries or enrollment even with fixture observation controls installed", { timeout: 15_000 }, async t => {
  const f = await fixture(t); const c = domainController(t, f, "domain-v4"); const result = await c.result;
  assert.equal(result.ok, true); await c.exited; f.connections.push(result.connection);
  assert.deepEqual(await c.queries(), []); const before = (await f.store.read(f.identity.id, f.identity.ownerId))!;
  assert.equal(before.version, 4); assert.equal(before.processDomain, undefined);
  assert.deepEqual(await f.launch(), result.connection); assert.deepEqual(await f.store.read(f.identity.id, f.identity.ownerId), before);
});

for (const actor of ["launcher", "worker"] as const) {
  for (const fence of ["revision", "generation", "explicit"] as const) {
    test(`v5 ${actor} collection outside lock revalidates ${fence} before publication`, { timeout: 15_000 }, async t => {
      const f = await fixture(t); await explicitV5(f); const c = domainController(t, f, `domain-${actor}-pause`);
      await untilQueries(c, actor);
      await f.store.withSessionLock(f.identity.id, f.identity.ownerId, async lease => {
        const current = (await f.store.read(f.identity.id, f.identity.ownerId))!;
        await lease.update(current.revision, fence === "generation" ? { generation: "other-generation" } : { requiresExplicitResume: fence === "explicit" });
      }, 500);
      c.controller.send("trigger"); assert.equal((await c.result).ok, false); await c.exited;
      const current = (await f.store.read(f.identity.id, f.identity.ownerId))!;
      assert.notEqual(current.worker.state, "ready"); assert.equal(current.processDomain, undefined); assert.deepEqual(await f.calls(), []);
      if (actor === "launcher") assert.equal(f.pids.size, 0);
    });
  }
}

test("v5 concurrent ready winner is authenticated without applying the losing launch observation", { timeout: 15_000 }, async t => {
  const f = await fixture(t); await explicitV5(f); const loser = domainController(t, f, "domain-launcher-pause");
  await untilQueries(loser, "launcher"); const winner = domainController(t, f, "domain-normal");
  const result = await winner.result; assert.equal(result.ok, true); await winner.exited; f.connections.push(result.connection);
  const before = await f.store.read(f.identity.id, f.identity.ownerId);
  loser.controller.send("trigger"); const recovered = await loser.result; assert.equal(recovered.ok, true); await loser.exited;
  assert.deepEqual(recovered.connection, result.connection); assert.equal(f.pids.size, 1);
  assert.deepEqual(await f.store.read(f.identity.id, f.identity.ownerId), before);
});

for (const mode of ["domain-injected", "domain-auth-revision"]) {
  test(`${mode} cannot retarget independently collected observations and uses fresh correlation revision`, { timeout: 15_000 }, async t => {
    const f = await fixture(t); await explicitV5(f); const c = domainController(t, f, mode);
    const result = await c.result; assert.equal(result.ok, true); await c.exited; f.connections.push(result.connection);
    const current = (await f.store.read(f.identity.id, f.identity.ownerId))!;
    assert.equal(current.processDomain?.launcher.bootSessionUuid, "66666666-7777-4888-8999-aaaaaaaaaaaa");
    assert.equal(current.processDomain?.worker.bootSessionUuid, "66666666-7777-4888-8999-aaaaaaaaaaaa");
    assert.equal(current.revision, mode === "domain-auth-revision" ? 5 : 4); assert.equal((await c.queries()).length, 4);
  });
}

test("v5 parent loss during worker collection uses existing pre-ready abort arbitration", { timeout: 15_000 }, async t => {
  const f = await fixture(t); await explicitV5(f); const c = domainController(t, f, "domain-worker-pause");
  await untilQueries(c, "worker"); c.controller.kill("SIGKILL"); await c.exited;
  for (const pid of f.pids) await waitGone(pid);
  const current = (await f.store.read(f.identity.id, f.identity.ownerId))!;
  assert.equal(current.worker.state, "aborted"); assert.equal(current.processDomain, undefined); assert.deepEqual(await f.calls(), []);
});

test("v5 authentication fence prevents correlation without revoking readiness", { timeout: 15_000 }, async t => {
  const f = await fixture(t); await explicitV5(f); const c = domainController(t, f, "domain-auth-fence");
  assert.equal((await c.result).ok, false); await c.exited;
  const current = (await f.store.read(f.identity.id, f.identity.ownerId))!;
  assert.equal(current.worker.state, "ready"); assert.equal(current.requiresExplicitResume, true); assert.equal(current.processDomain, undefined);
  assert.equal(f.pids.size, 1); assert.ok([...f.pids].every(exists)); await assert.rejects(f.launch());
});

test("concurrent explicit-v5 launches preserve one reservation/worker", { timeout: 15_000 }, async t => {
  const f = await fixture(t); await explicitV5(f);
  const controllers = [domainController(t, f, "domain-normal"), domainController(t, f, "domain-normal")];
  const results = await Promise.all(controllers.map(c => c.result)); await Promise.all(controllers.map(c => c.exited));
  assert.ok(results.some(result => result.ok)); assert.equal(f.pids.size, 1);
  const connection = await f.launch(); assert.ok(f.pids.has(connection.pid));
  for (const result of results.filter(result => result.ok)) assert.deepEqual(result.connection, connection);
  assert.ok((await f.store.read(f.identity.id, f.identity.ownerId))?.processDomain); assert.deepEqual(await f.calls(), []);
});

for (const loss of ["correlation-failure", "parent-loss", "correlation-success"] as const) {
  test(`v5 ${loss} preserves actual work adopted before correlation publication`, { timeout: 15_000 }, async t => {
    const f = await fixture(t, "held"); await explicitV5(f); const c = domainController(t, f, loss === "correlation-success" ? "domain-adopt-success" : "domain-adopt-failure");
    await Promise.race([c.adoptable, c.result.then(() => { throw new Error("Failed before adoption boundary"); })]);
    const connection = await reconnectCodexWorker(f.root, f.identity); f.connections.push(connection);
    const client = new CodexWorkerClient(connection);
    await client.request("startTurn", { turnId: "adopted-v5", input: "keep this work" });
    const deadline = Date.now() + 3_000;
    while (!(await f.calls()).some(call => call.method === "turn/start") && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal((await f.calls()).filter(call => call.method === "turn/start").length, 1);
    const before = (await f.store.read(f.identity.id, f.identity.ownerId))!;
    assert.equal(before.native.state, "bound");
    if (loss === "parent-loss") c.controller.kill("SIGKILL");
    else { c.controller.send("trigger"); assert.equal((await c.result).ok, loss === "correlation-success"); }
    await c.exited; assert.ok(exists(connection.pid));
    const recovered = new CodexWorkerClient(await f.launch());
    assert.equal((await recovered.request<AgentTurn>("startTurn", { turnId: "adopted-v5", input: "keep this work" })).status, "running");
    const after = (await f.store.read(f.identity.id, f.identity.ownerId))!;
    if (loss === "correlation-success") {
      assert.equal(after.revision, before.revision + 1); assert.ok(after.processDomain);
      assert.deepEqual(after.worker, before.worker); assert.deepEqual(after.native, before.native);
    } else assert.deepEqual(after, before);
    assert.equal((await f.calls()).filter(call => call.method === "turn/start").length, 1);
    await recovered.request("interrupt"); const retained = await settle(recovered, "adopted-v5");
    assert.deepEqual(await recovered.request("startTurn", { turnId: "adopted-v5", input: "keep this work" }), retained);
    await recovered.request("stop"); await waitGone(connection.pid); await waitGone((await f.calls())[0].pid);
  });
}

test("v5 worker loss during collection cannot enroll or authorize replacement", { timeout: 15_000 }, async t => {
  const f = await fixture(t); await explicitV5(f); const c = domainController(t, f, "domain-worker-pause");
  await untilQueries(c, "worker"); const [pid] = f.pids; assert.ok(pid); process.kill(pid, "SIGKILL");
  assert.equal((await c.result).ok, false); await c.exited; await waitGone(pid);
  const current = (await f.store.read(f.identity.id, f.identity.ownerId))!;
  assert.equal(current.worker.state, "aborted"); assert.equal(current.processDomain, undefined);
  await assert.rejects(f.launch()); assert.deepEqual(await f.calls(), []);
});

test("durable registration publishes private exact identity without allocating Codex; reconnect reuses it", { timeout: 15_000 }, async t => {
  const f = await fixture(t);
  const connection = await f.launch();
  const manifest = await f.store.read(f.identity.id, f.identity.ownerId);
  assert.equal(manifest?.worker.state, "ready");
  assert.equal(manifest?.native.state, "pending");
  assert.ok(connection.claimId);
  assertCodexWorkerClaim(manifest!, { claimId: connection.claimId!, pid: connection.pid });
  assert.deepEqual(await f.calls(), []);
  const recovered = await reconnectCodexWorker(f.root, f.identity);
  assert.deepEqual(recovered, connection);
  assert.deepEqual(await launchOrReconnectCodexWorker(f.root, f.identity, { native: { command: "/must-not-be-launched" } }), connection);
  const path = join(f.root, createHash("sha256").update(f.identity.ownerId).digest("hex"), `${f.identity.id}.session`, "manifest.json");
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  await new CodexWorkerClient(connection).verifyIdentity();
});

test("concurrent controllers cannot reserve two workers and can subsequently reconnect", { timeout: 15_000 }, async t => {
  const f = await fixture(t);
  const results = await Promise.allSettled([f.launch(), f.launch()]);
  const fulfilled = results.filter(result => result.status === "fulfilled");
  assert.ok(fulfilled.length >= 1);
  if (fulfilled.length === 2) assert.deepEqual(fulfilled[0].value, fulfilled[1].value);
  assert.equal(new Set(f.connections.map(c => c.pid)).size, 1);
  assert.deepEqual(await reconnectCodexWorker(f.root, f.identity), f.connections[0]);
  assert.deepEqual(await f.calls(), []);
});

test("controller SIGKILL preserves rediscovery of retained native work without redispatch", { timeout: 15_000 }, async t => {
  const f = await fixture(t, "held");
  const controller = fork(new URL("./fixtures/registration-controller.js", import.meta.url), [], { stdio: ["ignore", "ignore", "ignore", "ipc"] });
  t.after(() => { controller.kill("SIGKILL"); });
  const exited = once(controller, "exit");
  const result = new Promise<CodexWorkerConnection>((resolve, reject) => {
    controller.on("message", (message: any) => {
      if (message.type === "spawned") f.pids.add(message.pid);
      if (message.type === "done") message.ok ? resolve(message.connection) : reject(new Error("Controller launch failed"));
    });
  });
  controller.send({ root: f.root, identity: f.identity, mode: "controller-ready", native: f.native });
  const connection = await result;
  f.connections.push(connection);
  const client = new CodexWorkerClient(connection);
  await client.request("startTurn", { turnId: "stable-turn", input: "hello" });
  controller.kill("SIGKILL");
  await exited;
  assert.equal(controller.signalCode, "SIGKILL");
  const reconnected = new CodexWorkerClient(await reconnectCodexWorker(f.root, f.identity));
  assert.equal((await reconnected.request<AgentTurn>("startTurn", { turnId: "stable-turn", input: "hello" })).status, "running");
  await reconnected.request("interrupt");
  assert.equal((await settle(reconnected, "stable-turn")).status, "interrupted");
  assert.equal((await f.calls()).filter(call => call.method === "turn/start").length, 1);
});

test("a post-ready controller probe failure does not terminate the published worker", { timeout: 15_000 }, async t => {
  const f = await fixture(t);
  const controller = fork(new URL("./fixtures/registration-controller.js", import.meta.url), [], { stdio: ["ignore", "ignore", "ignore", "ipc"] });
  t.after(() => { controller.kill("SIGKILL"); });
  const exited = once(controller, "exit");
  const result = new Promise<any>(resolve => {
    controller.on("message", (message: any) => {
      if (message.type === "spawned") f.pids.add(message.pid);
      if (message.type === "done") resolve(message);
    });
  });
  controller.send({ root: f.root, identity: f.identity, mode: "post-ready-auth", native: f.native });
  assert.equal((await result).ok, false);
  await exited;
  const recovered = await reconnectCodexWorker(f.root, f.identity);
  assert.ok(f.pids.has(recovered.pid));
  f.connections.push(recovered);
  await new CodexWorkerClient(recovered).verifyIdentity();
  assert.deepEqual(await f.calls(), []);
});

test("generation and explicit-resume fences deny old connections and prevent replacement", { timeout: 15_000 }, async t => {
  const f = await fixture(t);
  const connection = await f.launch();
  const before = await f.store.read(f.identity.id, f.identity.ownerId);
  await f.store.update(f.identity.id, f.identity.ownerId, before!.revision, { generation: "generation-b", requiresExplicitResume: true });
  await assert.rejects(new CodexWorkerClient(connection).verifyIdentity());
  await assert.rejects(new CodexWorkerClient(connection).request("startTurn", { turnId: "stale", input: "no" }));
  for (const identity of [f.identity, { ...f.identity, ownerId: "owner-b" }, { ...f.identity, generation: "generation-b" }]) {
    await assert.rejects(reconnectCodexWorker(f.root, identity));
    await assert.rejects(launchOrReconnectCodexWorker(f.root, identity, { native: f.native }));
  }
  assert.equal((await f.store.read(f.identity.id, f.identity.ownerId))?.worker.state, "ready");
  assert.deepEqual(await f.calls(), []);
});

test("registered offline worker preserves failed first-turn lookup and matching retries", { timeout: 15_000 }, async t => {
  const f = await fixture(t);
  f.native.command = "/missing-codex-registration-fixture";
  const connection = await f.launch();
  const client = new CodexWorkerClient(connection);
  await client.request("startTurn", { turnId: "failed-first", input: "hello" });
  const failed = await settle(client, "failed-first");
  assert.equal(failed.status, "failed");
  const reconnected = new CodexWorkerClient(await reconnectCodexWorker(f.root, f.identity));
  assert.deepEqual(await reconnected.request("turn", { turnId: "failed-first" }), failed);
  assert.deepEqual(await reconnected.request("startTurn", { turnId: "failed-first", input: "hello" }), failed);
  await assert.rejects(reconnected.request("startTurn", { turnId: "new-work", input: "no" }));
  assert.equal((await f.store.read(f.identity.id, f.identity.ownerId))?.native.state, "creating");
});

test("claimed manifests refuse unregistered workers and allocator bypass", { timeout: 15_000 }, async t => {
  const f = await fixture(t);
  await f.launch();
  await assert.rejects(openPendingCodexWorker(f.store, f.identity, f.native));
  await assert.rejects(allocatePendingCodexThread(f.store, f.identity, f.native));
  assert.equal((await f.store.read(f.identity.id, f.identity.ownerId))?.native.state, "pending");
  assert.deepEqual(await f.calls(), []);
});

test("stopped worker registration is preserved rather than authorizing replacement", { timeout: 15_000 }, async t => {
  const f = await fixture(t);
  const connection = await f.launch();
  await new CodexWorkerClient(connection).request("stop");
  await waitGone(connection.pid);
  const before = await f.store.read(f.identity.id, f.identity.ownerId);
  await assert.rejects(reconnectCodexWorker(f.root, f.identity));
  await assert.rejects(f.launch());
  assert.deepEqual(await f.store.read(f.identity.id, f.identity.ownerId), before);
});

test("a live PID and generic HTTP success are not authenticated worker identity", { timeout: 15_000 }, async t => {
  const f = await fixture(t);
  const server = createServer((request, response) => { request.resume(); response.end('{"result":"idle"}'); });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const connection: CodexWorkerConnection = { version: 1, ownerId: f.identity.ownerId, sessionId: f.identity.id,
    generation: f.identity.generation, claimId: "test-claim", pid: process.pid, token: "a".repeat(64),
    endpoint: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
  await f.store.withSessionLock(f.identity.id, f.identity.ownerId, async lease => {
    const current = await f.store.read(f.identity.id, f.identity.ownerId);
    const reserved = await lease.reserveWorker(current!.revision, connection.claimId!);
    const spawned = await lease.recordWorkerPid(reserved.revision, connection.claimId!, connection.pid);
    await lease.publishWorkerReady(spawned.revision, connection);
  });
  const before = await f.store.read(f.identity.id, f.identity.ownerId);
  await assert.rejects(reconnectCodexWorker(f.root, f.identity));
  await assert.rejects(f.launch());
  assert.deepEqual(await f.store.read(f.identity.id, f.identity.ownerId), before);
});

test("pre-ready cleanup commits an irrevocable abort before teardown can be authorized", async t => {
  const f = await fixture(t);
  const claim = { claimId: "claim-a", pid: process.pid };
  await f.store.withSessionLock(f.identity.id, f.identity.ownerId, async lease => {
    const current = await f.store.read(f.identity.id, f.identity.ownerId);
    const reserved = await lease.reserveWorker(current!.revision, claim.claimId);
    await lease.recordWorkerPid(reserved.revision, claim.claimId, claim.pid);
  });
  assert.equal(await f.store.claimPreReadyCleanup({ ...f.identity, ownerId: "other-owner" }, claim), false);
  assert.equal(await f.store.claimPreReadyCleanup({ ...f.identity, generation: "stale-generation" }, claim), false);
  assert.equal(await f.store.claimPreReadyCleanup(f.identity, { ...claim, pid: process.pid + 1 }), false);
  assert.equal(await f.store.claimPreReadyCleanup(f.identity, claim), true);
  const aborted = await f.store.read(f.identity.id, f.identity.ownerId);
  assert.equal(aborted?.worker.state, "aborted");
  assert.equal(aborted?.native.state, "pending");
  assert.equal(await f.store.claimPreReadyCleanup(f.identity, claim), true);
  await f.store.withSessionLock(f.identity.id, f.identity.ownerId, async lease => {
    await assert.rejects(lease.publishWorkerReady(aborted!.revision, { version: 1, ...claim,
      ownerId: f.identity.ownerId, sessionId: f.identity.id, generation: f.identity.generation,
      token: "a".repeat(64), endpoint: "http://127.0.0.1:1234" }));
  });
  await assert.rejects(openPendingCodexWorker(f.store, f.identity, f.native, claim));
  await assert.rejects(allocatePendingCodexThread(f.store, f.identity, f.native, claim));
  await assert.rejects(f.launch());
  assert.deepEqual(await f.store.read(f.identity.id, f.identity.ownerId), aborted);
  assert.deepEqual(await f.calls(), []);
});

for (const fence of [
  { name: "persisted generation", patch: { generation: "generation-b" } },
  { name: "persisted explicit-resume", patch: { requiresExplicitResume: true } },
]) {
  test(`fresh abort respects ${fence.name} in selector and latest-revision lease`, async t => {
    const f = await fixture(t);
    const claim = { claimId: "claim-a", pid: process.pid };
    await f.store.withSessionLock(f.identity.id, f.identity.ownerId, async lease => {
      const current = await f.store.read(f.identity.id, f.identity.ownerId);
      const reserved = await lease.reserveWorker(current!.revision, claim.claimId);
      await lease.recordWorkerPid(reserved.revision, claim.claimId, claim.pid);
    });
    const reserved = await f.store.read(f.identity.id, f.identity.ownerId);
    await f.store.update(f.identity.id, f.identity.ownerId, reserved!.revision, fence.patch);
    const before = await f.store.read(f.identity.id, f.identity.ownerId);
    assert.equal(before?.worker.state, "reserved");
    assert.equal(await f.store.claimPreReadyCleanup(f.identity, claim), false);
    assert.deepEqual(await f.store.read(f.identity.id, f.identity.ownerId), before);
    await f.store.withSessionLock(f.identity.id, f.identity.ownerId, async lease => {
      const latest = await f.store.read(f.identity.id, f.identity.ownerId);
      assert.equal(latest!.revision, before!.revision);
      // A fresh CAS revision must still be refused by the persisted fence.
      await assert.rejects(lease.abortWorkerStartup(latest!.revision, claim.claimId, claim.pid), /not eligible for pre-ready cleanup/);
    });
    assert.deepEqual(await f.store.read(f.identity.id, f.identity.ownerId), before);
    assert.deepEqual(await f.calls(), []);
  });

  test(`already committed abort remains idempotent after ${fence.name} changes`, async t => {
    const f = await fixture(t);
    const claim = { claimId: "claim-a", pid: process.pid };
    await f.store.withSessionLock(f.identity.id, f.identity.ownerId, async lease => {
      const current = await f.store.read(f.identity.id, f.identity.ownerId);
      const reserved = await lease.reserveWorker(current!.revision, claim.claimId);
      await lease.recordWorkerPid(reserved.revision, claim.claimId, claim.pid);
    });
    assert.equal(await f.store.claimPreReadyCleanup(f.identity, claim), true);
    const aborted = await f.store.read(f.identity.id, f.identity.ownerId);
    await f.store.update(f.identity.id, f.identity.ownerId, aborted!.revision, fence.patch);
    const before = await f.store.read(f.identity.id, f.identity.ownerId);
    assert.equal(before?.worker.state, "aborted");
    assert.equal(await f.store.claimPreReadyCleanup(f.identity, claim), true);
    assert.deepEqual(await f.store.read(f.identity.id, f.identity.ownerId), before);
  });
}

test("durable readiness or unreadable state cannot authorize failed-startup teardown", async t => {
  const f = await fixture(t);
  const claim = { claimId: "claim-a", pid: process.pid };
  await f.store.withSessionLock(f.identity.id, f.identity.ownerId, async lease => {
    const current = await f.store.read(f.identity.id, f.identity.ownerId);
    const reserved = await lease.reserveWorker(current!.revision, claim.claimId);
    const spawned = await lease.recordWorkerPid(reserved.revision, claim.claimId, claim.pid);
    await lease.publishWorkerReady(spawned.revision, { version: 1, ...claim,
      ownerId: f.identity.ownerId, sessionId: f.identity.id, generation: f.identity.generation,
      token: "a".repeat(64), endpoint: "http://127.0.0.1:1234" });
  });
  const ready = await f.store.read(f.identity.id, f.identity.ownerId);
  assert.equal(await f.store.claimPreReadyCleanup(f.identity, claim), false);
  assert.deepEqual(await f.store.read(f.identity.id, f.identity.ownerId), ready);
  const path = join(f.root, createHash("sha256").update(f.identity.ownerId).digest("hex"), `${f.identity.id}.session`, "manifest.json");
  const original = await readFile(path, "utf8");
  await chmod(path, 0o644);
  assert.equal(await f.store.claimPreReadyCleanup(f.identity, claim), false);
  assert.equal((await stat(path)).mode & 0o777, 0o644);
  await chmod(path, 0o600);
  assert.equal(await readFile(path, "utf8"), original);
});

test("registration mutations reject stale revisions, wrong claims/PIDs and policy overrides", async t => {
  const f = await fixture(t);
  const connection: CodexWorkerConnection = { version: 1, ownerId: f.identity.ownerId, sessionId: f.identity.id,
    generation: f.identity.generation, claimId: "claim-a", pid: process.pid, token: "a".repeat(64), endpoint: "http://127.0.0.1:1234" };
  await f.store.withSessionLock(f.identity.id, f.identity.ownerId, async lease => {
    const initial = await f.store.read(f.identity.id, f.identity.ownerId);
    const reserved = await lease.reserveWorker(initial!.revision, "claim-a");
    await assert.rejects(lease.reserveWorker(reserved.revision, "second-claim"));
    await assert.rejects(lease.recordWorkerPid(reserved.revision, "wrong-claim", process.pid));
    const spawned = await lease.recordWorkerPid(reserved.revision, "claim-a", process.pid);
    await assert.rejects(lease.recordWorkerPid(spawned.revision, "claim-a", process.pid + 1));
    await assert.rejects(lease.publishWorkerReady(reserved.revision, connection));
    for (const override of [{ claimId: "wrong" }, { pid: process.pid + 1 }, { generation: "stale" }, { ownerId: "owner-b" },
      { sessionId: "other-id" }, { endpoint: "http://external.example:1234" }, { token: "invalid" }]) {
      await assert.rejects(lease.publishWorkerReady(spawned.revision, { ...connection, ...override }));
    }
    const ready = await lease.publishWorkerReady(spawned.revision, connection);
    await assert.rejects(lease.publishWorkerReady(ready.revision, connection));
    await assert.rejects(lease.update(ready.revision, { worker: { state: "none" } } as any));
  });
  assert.equal((await f.store.read(f.identity.id, f.identity.ownerId))?.worker.state, "ready");
});

test("reconnect revalidates the persisted fence after an authenticated identity response", { timeout: 15_000 }, async t => {
  const f = await fixture(t);
  let connection: CodexWorkerConnection;
  const server = createServer((request, response) => {
    request.resume();
    void (async () => {
      assert.equal(request.headers.authorization, `Bearer ${connection.token}`);
      const current = await f.store.read(f.identity.id, f.identity.ownerId);
      await f.store.update(f.identity.id, f.identity.ownerId, current!.revision, { requiresExplicitResume: true });
      response.end(JSON.stringify({ result: { version: 1, ownerId: connection.ownerId, sessionId: connection.sessionId,
        generation: connection.generation, pid: connection.pid, claimId: connection.claimId } }));
    })().catch(() => { response.statusCode = 500; response.end("{}"); });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  connection = { version: 1, ownerId: f.identity.ownerId, sessionId: f.identity.id, generation: f.identity.generation,
    claimId: "claim-a", pid: process.pid, token: "a".repeat(64), endpoint: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
  await f.store.withSessionLock(f.identity.id, f.identity.ownerId, async lease => {
    const current = await f.store.read(f.identity.id, f.identity.ownerId);
    const reserved = await lease.reserveWorker(current!.revision, connection.claimId!);
    const spawned = await lease.recordWorkerPid(reserved.revision, connection.claimId!, connection.pid);
    await lease.publishWorkerReady(spawned.revision, connection);
  });
  await assert.rejects(reconnectCodexWorker(f.root, f.identity));
  assert.equal((await f.store.read(f.identity.id, f.identity.ownerId))?.requiresExplicitResume, true);
});

for (const mode of ["adopt-timeout", "adopt-ipc", "adopt-post-publication"]) {
  test(`${mode} cannot tear down work adopted before IPC confirmation`, { timeout: 15_000 }, async t => {
    const f = await fixture(t, "held");
    const controller = fork(new URL("./fixtures/registration-controller.js", import.meta.url), [], { stdio: ["ignore", "ignore", "ignore", "ipc"] });
    t.after(() => { controller.kill("SIGKILL"); });
    const exited = once(controller, "exit");
    let complete = false;
    let published!: () => void;
    const adoptable = new Promise<void>(resolve => { published = resolve; });
    const result = new Promise<any>(resolve => {
      controller.on("message", (message: any) => {
        if (message.type === "spawned") f.pids.add(message.pid);
        if (message.type === "adoptable") published();
        if (message.type === "done") { complete = true; resolve(message); }
      });
    });
    controller.send({ root: f.root, identity: f.identity, mode, native: f.native });
    await Promise.race([adoptable, result.then(() => { throw new Error("Launcher failed before controlled adoption"); })]);
    const connection = await reconnectCodexWorker(f.root, f.identity);
    f.connections.push(connection);
    const adopter = new CodexWorkerClient(connection);
    await adopter.request("startTurn", { turnId: "adopted-turn", input: "Retain adopted work" });
    const deadline = Date.now() + 3_000;
    while (!(await f.calls()).some(call => call.method === "turn/start") && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.equal((await f.calls()).filter(call => call.method === "turn/start").length, 1);
    assert.equal((await adopter.request<AgentTurn>("turn", { turnId: "adopted-turn" })).status, "running");
    const before = await f.store.read(f.identity.id, f.identity.ownerId);
    assert.equal(before?.native.state, "bound");
    assert.equal(complete, false, "Do not trigger failure until after independent dispatch");
    controller.send("trigger");
    assert.equal((await result).ok, false);
    await exited;
    assert.equal(exists(connection.pid), true);
    const recovered = new CodexWorkerClient(await reconnectCodexWorker(f.root, f.identity));
    assert.equal((await recovered.request<AgentTurn>("turn", { turnId: "adopted-turn" })).status, "running");
    assert.equal((await recovered.request<AgentTurn>("startTurn", { turnId: "adopted-turn", input: "Retain adopted work" })).status, "running");
    const after = await f.store.read(f.identity.id, f.identity.ownerId);
    assert.deepEqual(after?.worker, before?.worker);
    assert.deepEqual(after?.native, before?.native);
    assert.equal((await f.calls()).filter(call => call.method === "turn/start").length, 1);
    await recovered.request("interrupt");
    const retained = await settle(recovered, "adopted-turn");
    assert.equal(retained.status, "interrupted");
    assert.deepEqual(await recovered.request("startTurn", { turnId: "adopted-turn", input: "Retain adopted work" }), retained);
    await recovered.request("stop");
    await waitGone(connection.pid);
    await waitGone((await f.calls())[0].pid);
  });
}

for (const mode of ["reserve-before", "reserve-after", "pid-before", "pid-after", "ready-before", "ready-after", "ready-fsync", "ready-delay", "ready-disconnect"]) {
  test(`registration fault ${mode} preserves durable authority and only cleans up pre-ready workers`, { timeout: 15_000 }, async t => {
    const f = await fixture(t);
    const controller = fork(new URL("./fixtures/registration-controller.js", import.meta.url), [], { stdio: ["ignore", "ignore", "ignore", "ipc"] });
    t.after(() => { controller.kill("SIGKILL"); });
    const exited = once(controller, "exit");
    const result = new Promise<any>(resolve => {
      controller.on("message", (message: any) => {
        if (message.type === "spawned") f.pids.add(message.pid);
        if (message.type === "done") resolve(message);
      });
    });
    controller.send({ root: f.root, identity: f.identity, mode, native: f.native });
    assert.equal((await result).ok, false);
    await exited;
    const current = await f.store.read(f.identity.id, f.identity.ownerId);
    assert.equal(current?.native.state, "pending");
    if (current?.worker.state === "ready") {
      const adopted = await reconnectCodexWorker(f.root, f.identity);
      assert.ok(f.pids.has(adopted.pid));
      f.connections.push(adopted);
      assert.deepEqual(await f.launch(), adopted);
    } else {
      for (const pid of f.pids) await waitGone(pid);
      if (mode !== "reserve-before") {
        assert.notEqual(current?.worker.state, "none");
        await assert.rejects(f.launch());
      } else assert.equal(current?.worker.state, "none");
    }
    assert.deepEqual(await f.store.read(f.identity.id, f.identity.ownerId), current);
    assert.deepEqual(await f.calls(), []);
  });
}

for (const mode of ["pause-reserve", "pause-pid"]) {
  test(`controller SIGKILL at ${mode} preserves reservation without replacement`, { timeout: 15_000 }, async t => {
    const f = await fixture(t);
    const controller = fork(new URL("./fixtures/registration-controller.js", import.meta.url), [], { stdio: ["ignore", "ignore", "ignore", "ipc"] });
    t.after(() => { controller.kill("SIGKILL"); });
    const exited = once(controller, "exit");
    const paused = new Promise<void>(resolve => {
      controller.on("message", (message: any) => {
        if (message.type === "spawned") f.pids.add(message.pid);
        if (message.type === "paused") resolve();
      });
    });
    controller.send({ root: f.root, identity: f.identity, mode, native: f.native });
    await paused;
    controller.kill("SIGKILL");
    await exited;
    for (const pid of f.pids) await waitGone(pid);
    const current = await f.store.read(f.identity.id, f.identity.ownerId);
    assert.equal(current?.worker.state, "reserved");
    assert.equal(current?.native.state, "pending");
    await assert.rejects(f.launch());
    assert.deepEqual(await f.store.read(f.identity.id, f.identity.ownerId), current);
    assert.deepEqual(await f.calls(), []);
  });
}

test("worker SIGKILL after ready publication leaves an unavailable registration, not a new worker", { timeout: 15_000 }, async t => {
  const f = await fixture(t);
  const controller = fork(new URL("./fixtures/registration-controller.js", import.meta.url), [], { stdio: ["ignore", "ignore", "ignore", "ipc"] });
  t.after(() => { controller.kill("SIGKILL"); });
  const exited = once(controller, "exit");
  const result = new Promise<any>(resolve => {
    controller.on("message", (message: any) => {
      if (message.type === "spawned") f.pids.add(message.pid);
      if (message.type === "done") resolve(message);
    });
  });
  controller.send({ root: f.root, identity: f.identity, mode: "ready-pause", native: f.native });
  const deadline = Date.now() + 3_000;
  let pid: number | undefined;
  while (Date.now() < deadline && !pid) {
    try { pid = Number(await readFile(join(f.root, ".test-ready-paused"), "utf8")); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    if (!pid) await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.ok(pid && f.pids.has(pid));
  const before = await f.store.read(f.identity.id, f.identity.ownerId);
  assert.equal(before?.worker.state, "ready");
  process.kill(pid, "SIGKILL"); // Exact paused test fixture; no native child exists.
  assert.equal((await result).ok, false);
  await exited;
  await waitGone(pid);
  await assert.rejects(f.launch());
  assert.deepEqual(await f.store.read(f.identity.id, f.identity.ownerId), before);
  assert.deepEqual(await f.calls(), []);
});

test("unsafe or corrupt registration files are refused without repair", async t => {
  const f = await fixture(t);
  const path = join(f.root, createHash("sha256").update(f.identity.ownerId).digest("hex"), `${f.identity.id}.session`, "manifest.json");
  const original = await readFile(path, "utf8");
  await chmod(path, 0o644);
  await assert.rejects(reconnectCodexWorker(f.root, f.identity));
  assert.equal((await stat(path)).mode & 0o777, 0o644);
  await chmod(path, 0o600);
  await writeFile(path, "{corrupt");
  await assert.rejects(reconnectCodexWorker(f.root, f.identity));
  assert.equal(await readFile(path, "utf8"), "{corrupt");
  await writeFile(path, original);
  const target = join(f.directory, "target");
  await writeFile(target, original, { mode: 0o600 });
  await rm(path); await symlink(target, path);
  await assert.rejects(reconnectCodexWorker(f.root, f.identity));
});
