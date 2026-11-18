import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { fork } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { ClaudeCodeManagedStore, ClaudeCodeManifestConflictError, type ClaudeCodeManagedManifest, type ClaudeCodeManifestLease } from "../src/managed-store.js";
import { ClaudeCodeLifecycleBusyError } from "../src/lifecycle-lock.js";
import { encodeClaudeCodeWorkerRegistration as encode, type ClaudeCodeWorkerRegistrationScope, type ClaudeCodeWorkerRegistration } from "../src/worker-registration.js";
import { Queue } from "../src/queue.js";
import { createClaudeCodeWorkerBridge } from "../src/worker-bridge.js";
import { ClaudeCodeWorkerClient } from "../src/worker-client.js";
import type { AgentEvent, AgentRuntime } from "@minu/runtime-core";

async function fixture(t: TestContext, workspaceName?: string) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "claude-managed-worker-")));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const root = join(directory, "managed");
  const store = new ClaudeCodeManagedStore(root);
  const manifest: ClaudeCodeManagedManifest = {
    version: 3, runtime: "claude-code", id: "runtime-id", ownerId: "owner-a", revision: 0,
    generation: "generation-a", requiresExplicitResume: false, native: { state: "pending" }, worker: { state: "none" },
    lastDispatch: { state: "none" }, launchConfig: { cwd: workspaceName ? join(directory, workspaceName) : directory },
    policy: { configuration: "isolated", permissionMode: "default", nativeConfigRoot: join(directory, "native"), tools: [] },
    createdAt: new Date().toISOString(),
  };
  await store.create(manifest);
  const scope: ClaudeCodeWorkerRegistrationScope = { sessionId: manifest.id, ownerId: manifest.ownerId,
    generation: manifest.generation, reservationId: randomUUID(), workerExecutable: join(directory, "owned-worker.js"),
    cwd: manifest.launchConfig.cwd, nativeConfigRoot: manifest.policy.nativeConfigRoot };
  // Synthetic descriptor only: these tests never signal or infer liveness from this PID.
  const registration: ClaudeCodeWorkerRegistration = { version: 1, runtime: "claude-code", ownership: "owned", ...scope,
    pid: 12345, processGroupId: 12345, endpoint: "http://127.0.0.1:34567", token: "a".repeat(64), createdAt: new Date().toISOString() };
  const path = join(root, createHash("sha256").update(manifest.ownerId).digest("hex"), `${manifest.id}.session`, "manifest.json");
  const mutate = (operation: (lease: ClaudeCodeManifestLease) => Promise<ClaudeCodeManagedManifest>) => store.withSessionLock(manifest.id, manifest.ownerId, operation);
  const read = async () => (await store.read(manifest.id, manifest.ownerId))!;
  const reserve = (revision = 0) => mutate(lease => lease.reserveWorker(revision, scope.generation, scope.reservationId, scope.workerExecutable));
  const begin = (revision = 1) => mutate(lease => lease.beginWorkerStart(revision, scope.generation, scope.reservationId));
  const process = (revision = 2) => mutate(lease => lease.recordWorkerProcess(revision, scope.generation, scope.reservationId, registration.pid, registration.processGroupId));
  const publish = (revision = 3, record = registration) => mutate(lease => lease.publishWorker(revision, scope.generation, scope.reservationId, encode(record, scope)));
  const prepare = async (stage: "reserve" | "begin" | "process" | "publish" = "process") => {
    let current = await reserve(); if (stage === "reserve") return current;
    current = await begin(); if (stage === "begin") return current;
    current = await process(); if (stage === "process") return current;
    return publish();
  };
  return { directory, root, path, store, manifest, scope, registration, mutate, read, reserve, begin, process, publish, prepare };
}

test("private reservation/start/PID/ready publication is durable, scoped and does not fabricate native readiness", async t => {
  const f = await fixture(t);
  assert.equal((await f.reserve()).worker.state, "reserved");
  assert.deepEqual((await f.begin()).worker, { state: "starting", generation: f.scope.generation,
    reservationId: f.scope.reservationId, workerExecutable: f.scope.workerExecutable, process: null });
  const process = await f.process();
  assert.equal(process.worker.state, "starting");
  const live = await f.publish();
  assert.equal(live.revision, 4); assert.equal(live.worker.state, "live");
  if (live.worker.state === "live") assert.deepEqual(live.worker.registration, f.registration);
  assert.deepEqual(await new ClaudeCodeManagedStore(f.root).read(f.manifest.id, f.manifest.ownerId), live);
  assert.deepEqual(live.native, { state: "pending" }); assert.deepEqual(live.lastDispatch, { state: "none" });
  assert.equal((await stat(f.path)).mode & 0o777, 0o600);
  assert.equal((await stat(f.root)).mode & 0o777, 0o700);
  await assert.rejects(f.publish(4), ClaudeCodeManifestConflictError);
  await assert.rejects(f.reserve(4), ClaudeCodeManifestConflictError);
});

test("reservation CAS permits one contender and stale/wrong-owner/generation attempts do not mutate it", async t => {
  const f = await fixture(t);
  const results = await Promise.allSettled([f.reserve(), f.reserve()]);
  assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
  await assert.rejects(f.mutate(lease => lease.beginWorkerStart(1, "other-generation", f.scope.reservationId)), ClaudeCodeManifestConflictError);
  await assert.rejects(f.mutate(lease => lease.beginWorkerStart(1, f.scope.generation, randomUUID())), ClaudeCodeManifestConflictError);
  await assert.rejects(f.store.withSessionLock(f.manifest.id, "owner-b", lease => lease.beginWorkerStart(1, f.scope.generation, f.scope.reservationId)), ClaudeCodeManifestConflictError);
  await assert.rejects(f.begin(0), ClaudeCodeManifestConflictError);
  assert.equal((await f.read()).revision, 1);
});

test("only pre-fork reservation release is reversible; uncertain starting-without-PID cannot be cleared", async t => {
  const f = await fixture(t); await f.reserve();
  const released = await f.mutate(lease => lease.releaseWorkerReservation(1, f.scope.generation, f.scope.reservationId));
  assert.equal(released.worker.state, "none"); assert.notEqual(released.generation, f.scope.generation);
  await assert.rejects(f.mutate(lease => lease.reserveWorker(2, f.scope.generation, randomUUID(), f.scope.workerExecutable)), ClaudeCodeManifestConflictError);
  const reserved = await f.mutate(lease => lease.reserveWorker(2, released.generation, f.scope.reservationId, f.scope.workerExecutable));
  const starting = await f.mutate(lease => lease.beginWorkerStart(3, released.generation, f.scope.reservationId));
  assert.equal(reserved.worker.state, "reserved");
  await assert.rejects(f.mutate(lease => lease.releaseWorkerReservation(4, released.generation, f.scope.reservationId)), ClaudeCodeManifestConflictError);
  await assert.rejects(f.mutate(lease => lease.clearWorkerAfterExit(4, released.generation, f.scope.reservationId, 12345)), ClaudeCodeManifestConflictError);
  await assert.rejects(f.mutate(lease => lease.beginWorkerStart(4, released.generation, f.scope.reservationId)), ClaudeCodeManifestConflictError);
  assert.deepEqual(await f.read(), starting);
});

test("pre-fork release cannot mutate a human-fenced attempt or adopt a later generation", async t => {
  for (const patch of [{ requiresExplicitResume: true }, { generation: "new-controller-generation" }]) {
    const f = await fixture(t); await f.reserve();
    const fenced = await f.store.update(f.manifest.id, f.manifest.ownerId, 1, patch);
    // Fresh revision/current top-level generation must not launder old attempt authority.
    await assert.rejects(f.mutate(lease => lease.releaseWorkerReservation(2, fenced.generation, f.scope.reservationId)), ClaudeCodeManifestConflictError);
    assert.deepEqual(await f.read(), fenced);
  }
});

test("PID/group registration is bound once and ready publication validates exact scope and process", async t => {
  const f = await fixture(t); await f.prepare("begin");
  await assert.rejects(f.publish(2), ClaudeCodeManifestConflictError);
  for (const [pid, group] of [[0, 0], [12345, 12346], [2_147_483_648, null]] as const) {
    await assert.rejects(f.mutate(lease => lease.recordWorkerProcess(2, f.scope.generation, f.scope.reservationId, pid, group)));
  }
  await f.process();
  await assert.rejects(f.process(3), ClaudeCodeManifestConflictError);
  for (const record of [
    { ...f.registration, pid: 12346, processGroupId: 12346 }, { ...f.registration, processGroupId: null },
  ]) await assert.rejects(f.publish(3, record), ClaudeCodeManifestConflictError);
  const foreign = { ...f.registration, ownerId: "owner-b" };
  await assert.rejects(f.mutate(lease => lease.publishWorker(3, f.scope.generation, f.scope.reservationId,
    new TextEncoder().encode(JSON.stringify(foreign)))));
  assert.equal((await f.read()).revision, 3);
});

test("registered payload is snapshotted before IO and oversize/malformed payloads never publish", async t => {
  const f = await fixture(t); await f.prepare();
  for (const payload of [new Uint8Array(16 * 1024 + 1), new TextEncoder().encode("{broken")]) {
    await assert.rejects(f.mutate(lease => lease.publishWorker(3, f.scope.generation, f.scope.reservationId, payload)));
  }
  const saved = await f.mutate(lease => {
    const payload = encode(f.registration, f.scope);
    const pending = lease.publishWorker(3, f.scope.generation, f.scope.reservationId, payload);
    payload.fill(0);
    return pending;
  });
  assert.equal(saved.worker.state, "live");
  if (saved.worker.state === "live") assert.equal(saved.worker.registration.token, f.registration.token);
});

test("native/config identities and registration state cannot be rewritten through metadata patches", async t => {
  const f = await fixture(t); const live = await f.prepare("publish");
  for (const patch of [{ worker: { state: "none" } }, { policy: { ...f.manifest.policy, nativeConfigRoot: "/other" } }]) {
    await assert.rejects(f.store.update(f.manifest.id, f.manifest.ownerId, 4, patch as any));
  }
  for (const patch of [
    { version: 2 }, { worker: undefined }, { worker: { state: "none", token: "PRIVATE" } },
    { worker: { state: "live" } }, { policy: { ...live.policy, nativeConfigRoot: "/other" } },
    { worker: { ...live.worker, workerExecutable: "/other-worker.js" } },
  ]) {
    await writeFile(f.path, JSON.stringify({ ...live, ...patch }));
    await assert.rejects(f.read());
  }
  await writeFile(f.path, JSON.stringify(live));
  assert.deepEqual(await f.read(), live);
});

test("invalid manifest UTF8 cannot repair matching live scopes; valid Unicode paths remain exact", async t => {
  // A genuine encoded replacement character is valid; byte repair is not.
  const f = await fixture(t, "CWD_MARKER-é-日本-\ufffd");
  const live = await f.prepare("publish");
  assert.deepEqual(await f.read(), live);
  const valid = await readFile(f.path), corrupt = Buffer.from(valid);
  let index = 0, replacements = 0;
  while ((index = corrupt.indexOf("CWD_MARKER", index)) >= 0) { corrupt[index++] = 0xff; replacements++; }
  assert.equal(replacements, 2, "Corrupt both launch and registration cwd scopes identically");
  assert.throws(() => new TextDecoder("utf-8", { fatal: true }).decode(corrupt));
  await writeFile(f.path, corrupt);
  await assert.rejects(f.read(), /^Error: Invalid Claude Code manifest encoding$/);
  await assert.rejects(f.store.list(f.manifest.ownerId), /^Error: Invalid Claude Code manifest encoding$/);
  let entered = false;
  await assert.rejects(f.store.withWorkerAdmission(f.scope, encode(f.registration, f.scope), async () => { entered = true; }),
    /^Error: Invalid Claude Code manifest encoding$/);
  assert.equal(entered, false);
  assert.deepEqual(await readFile(f.path), corrupt, "Do not repair or republish corrupt storage");
  await writeFile(f.path, valid);
  assert.deepEqual(await f.read(), live);
});

test("uncertain allocation/input, empty bound history and explicit-resume fences refuse replacement reservations", async t => {
  const f = await fixture(t);
  const blocked = async (manifest: ClaudeCodeManagedManifest) => {
    await writeFile(f.path, JSON.stringify(manifest));
    await assert.rejects(f.mutate(lease => lease.reserveWorker(manifest.revision, manifest.generation, f.scope.reservationId, f.scope.workerExecutable)), ClaudeCodeManifestConflictError);
    assert.deepEqual(await f.read(), manifest);
  };
  await blocked({ ...f.manifest, requiresExplicitResume: true });
  await blocked({ ...f.manifest, native: { state: "creating", sessionId: randomUUID() } });
  const bound = { ...f.manifest, native: { state: "bound" as const, sessionId: randomUUID() } };
  await blocked(bound);
  await blocked({ ...bound, lastDispatch: { state: "dispatching", turnId: "uncertain", fingerprint: "a".repeat(64), nativeMessageId: randomUUID(), generation: bound.generation } });
  await writeFile(f.path, JSON.stringify({ ...bound, lastDispatch: { state: "settled", turnId: "completed", fingerprint: "a".repeat(64), nativeMessageId: randomUUID(), generation: bound.generation, outcome: "completed" } }));
  assert.equal((await f.reserve()).worker.state, "reserved");
});

test("clear requires exact recorded PID/nonce, rotates generation and preserves recovery/input/native material", async t => {
  const f = await fixture(t); const live = await f.prepare("publish");
  const intent = { state: "dispatching" as const, generation: live.generation, turnId: "uncertain", fingerprint: "a".repeat(64), nativeMessageId: randomUUID() };
  const busy = { ...live, native: { state: "bound" as const, sessionId: randomUUID() }, lastDispatch: intent };
  await writeFile(f.path, JSON.stringify(busy));
  const fenced = await f.store.update(f.manifest.id, f.manifest.ownerId, 4, { generation: "recovery-generation", requiresExplicitResume: true });
  await assert.rejects(f.mutate(lease => lease.clearWorkerAfterExit(5, fenced.generation, randomUUID(), f.registration.pid)), ClaudeCodeManifestConflictError);
  await assert.rejects(f.mutate(lease => lease.clearWorkerAfterExit(5, fenced.generation, f.scope.reservationId, f.registration.pid + 1)), ClaudeCodeManifestConflictError);
  // Synthetic PID: this is state-transition testing, NOT OS/worker exit verification.
  const cleared = await f.mutate(lease => lease.clearWorkerAfterExit(5, fenced.generation, f.scope.reservationId, f.registration.pid));
  assert.equal(cleared.worker.state, "none"); assert.notEqual(cleared.generation, fenced.generation);
  assert.equal(cleared.requiresExplicitResume, true); assert.deepEqual(cleared.native, busy.native); assert.deepEqual(cleared.lastDispatch, intent);
  await assert.rejects(f.mutate(lease => lease.reserveWorker(6, cleared.generation, randomUUID(), f.scope.workerExecutable)), ClaudeCodeManifestConflictError);
});

test("metadata-backed admission holds its lease and rejects stale generation, token and PID descriptors", async t => {
  const f = await fixture(t); await f.prepare("publish");
  const payload = encode(f.registration, f.scope);
  assert.equal(await f.store.withWorkerAdmission(f.scope, payload, async (_lease, manifest) => manifest.id), f.manifest.id);
  for (const patch of [{ token: "b".repeat(64) }, { pid: 12346, processGroupId: 12346 }]) {
    await assert.rejects(f.store.withWorkerAdmission(f.scope, encode({ ...f.registration, ...patch }, f.scope), async () => { assert.fail("Must not enter"); }), ClaudeCodeManifestConflictError);
  }
  let entered!: () => void, release!: () => void;
  const ready = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const held = f.store.withWorkerAdmission(f.scope, payload, async () => { entered(); await gate; });
  await ready;
  try {
    await assert.rejects(new ClaudeCodeManagedStore(f.root).withSessionLock(f.manifest.id, f.manifest.ownerId,
      lease => lease.update(4, { generation: "blocked" }), 50), ClaudeCodeLifecycleBusyError);
  } finally { release(); await held; }
  await f.store.update(f.manifest.id, f.manifest.ownerId, 4, { generation: "replacement" });
  await assert.rejects(f.store.withWorkerAdmission(f.scope, payload, async () => { assert.fail("Must not enter"); }), ClaudeCodeManifestConflictError);
});

test("real loopback streams stop delivery after the private registration generation is revoked", async t => {
  const f = await fixture(t); await f.prepare();
  const events = new Queue<AgentEvent>(64);
  const runtime: AgentRuntime = {
    async start() { throw new Error("Unused"); }, async send() {}, async startTurn() { throw new Error("Unused"); },
    async turn() { return undefined; }, async status() { return "idle"; }, async messages() { return []; },
    async steer() {}, async interrupt() {}, events() { return events; }, async stop() { events.end(); },
  };
  let payload = encode(f.registration, f.scope), cleanup = false;
  const bridge = await createClaudeCodeWorkerBridge({ ...f.scope, token: f.registration.token, nativeSessionId: "native", runtime,
    admit: operation => cleanup ? operation() : f.store.withWorkerAdmission(f.scope, payload, () => operation()) });
  const abort = new AbortController();
  const reader = new ClaudeCodeWorkerClient(bridge.connection).events(abort.signal)[Symbol.asyncIterator]();
  try {
    f.registration.endpoint = bridge.connection.endpoint; payload = encode(f.registration, f.scope);
    await f.publish();
    assert.equal((await reader.next()).value?.type, "status");
    await f.store.update(f.manifest.id, f.manifest.ownerId, 4, { generation: "revoked", requiresExplicitResume: true });
    const next = assert.rejects(reader.next());
    events.push({ type: "message_delta", sessionId: "native", timestamp: new Date().toISOString(), delta: "PRIVATE_REVOKED" });
    await next;
  } finally {
    abort.abort(); await reader.return?.();
    cleanup = true; // Fixture supervisor owns listener cleanup; not a remote admission bypass.
    await bridge.close();
  }
});

test("ready publication overflow preserves the starting registration without partial token publication", async t => {
  const f = await fixture(t); const starting = await f.prepare();
  const large = { ...starting, launchConfig: { ...starting.launchConfig, systemPrompt: "" } };
  large.launchConfig.systemPrompt = "z".repeat(64 * 1024 - Buffer.byteLength(`${JSON.stringify(large)}\n`) - 50);
  await writeFile(f.path, JSON.stringify(large) + "\n");
  await assert.rejects(f.publish(), /too large/);
  assert.deepEqual(await f.read(), large);
  assert.ok(!(await readFile(f.path, "utf8")).includes(f.registration.token));
});

for (const operation of ["reserve", "begin", "process", "publish", "clear"] as const) for (const point of ["before-rename", "after-rename"]) {
  test(`worker ${operation} survives controller SIGKILL ${point} without implicit replacement`, { timeout: 10_000 }, async t => {
    const f = await fixture(t);
    const before = operation === "reserve" ? await f.read() : operation === "begin" ? await f.prepare("reserve")
      : operation === "process" ? await f.prepare("begin") : operation === "publish" ? await f.prepare() : await f.prepare("publish");
    const child = fork(new URL("./fixtures/store-worker-crash.js", import.meta.url),
      [f.root, JSON.stringify(before), point, operation, JSON.stringify(f.registration)], {
        stdio: ["ignore", "ignore", "ignore", "ipc"], execArgv: [], cwd: f.directory,
        env: { PATH: globalThis.process.env.PATH, HOME: f.directory, CLAUDE_CONFIG_DIR: f.scope.nativeConfigRoot,
          ANTHROPIC_API_KEY: "runtime-test-key", ANTHROPIC_BASE_URL: "http://127.0.0.1:1", CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1" },
      });
    const exited = once(child, "exit");
    try {
      await Promise.race([once(child, "message"), exited.then(() => { throw new Error("Writer exited before checkpoint"); })]);
      const publishedState = operation === "reserve" ? "reserved" : operation === "begin" || operation === "process" ? "starting" : operation === "publish" ? "live" : "none";
      const expectedState = point === "before-rename" ? before.worker.state : publishedState;
      assert.equal((await f.read()).worker.state, expectedState);
      child.kill("SIGKILL"); await exited;
      const restarted = (await new ClaudeCodeManagedStore(f.root).read(before.id, before.ownerId))!;
      assert.equal(restarted.worker.state, expectedState);
      assert.equal(restarted.revision, before.revision + (point === "after-rename" ? 1 : 0));
      assert.deepEqual(restarted.native, before.native); assert.deepEqual(restarted.lastDispatch, before.lastDispatch);
      if (operation === "clear" && point === "after-rename") assert.notEqual(restarted.generation, before.generation);
      if (expectedState !== "none") await assert.rejects(f.mutate(lease => lease.reserveWorker(restarted.revision, restarted.generation, randomUUID(), f.scope.workerExecutable)), ClaudeCodeManifestConflictError);
      if (expectedState === "starting" && restarted.worker.state === "starting" && restarted.worker.process === null) {
        await assert.rejects(f.mutate(lease => lease.clearWorkerAfterExit(restarted.revision, restarted.generation, f.scope.reservationId, f.registration.pid)), ClaudeCodeManifestConflictError);
      }
    } finally { child.kill("SIGKILL"); await exited; }
  });
}
