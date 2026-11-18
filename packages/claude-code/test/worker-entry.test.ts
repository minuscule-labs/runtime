import assert from "node:assert/strict";
import { execFileSync, fork } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { test, type TestContext } from "node:test";
import { ClaudeCodeManagedStore, type ClaudeCodeManagedManifest } from "../src/managed-store.js";
import { claudeCodeNativeProjectKey } from "../src/native-history.js";
import { ClaudeCodeWorkerClient } from "../src/worker-client.js";
import { CLAUDE_CODE_BOOTSTRAP_MAX_BYTES, type ClaudeCodeWorkerBootstrap } from "../src/worker-entry.js";
import { decodeClaudeCodeWorkerRegistration as decode, type ClaudeCodeWorkerRegistrationScope } from "../src/worker-registration.js";

async function until<T>(read: () => Promise<T>, done: (value: T) => boolean): Promise<T> {
  const end = performance.now() + 8_000;
  while (true) {
    const value = await read(); if (done(value)) return value;
    if (performance.now() >= end) throw new Error("Worker entry test timed out");
    await delay(10);
  }
}
async function missing(path: string): Promise<void> { await assert.rejects(readFile(path), { code: "ENOENT" }); }
async function fixture(t: TestContext, options: { bound?: boolean; isolated?: boolean; recordPid?: boolean; direct?: boolean; mode?: string; publicationTimeoutMs?: number } = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "claude-worker-entry-")));
  const cwd = join(root, "workspace"), nativeRoot = join(root, "native"), storeRoot = join(root, "managed");
  await mkdir(cwd, { mode: 0o700 }); await mkdir(nativeRoot, { mode: 0o700 });
  const store = new ClaudeCodeManagedStore(storeRoot);
  const initial: ClaudeCodeManagedManifest = { version: 3, runtime: "claude-code", id: "entry-session", ownerId: "owner",
    revision: 0, generation: "generation", requiresExplicitResume: false, native: { state: "pending" },
    worker: { state: "none" }, lastDispatch: { state: "none" }, launchConfig: { cwd },
    policy: { configuration: "isolated", permissionMode: "default", nativeConfigRoot: nativeRoot, tools: [] }, createdAt: new Date().toISOString() };
  await store.create(initial);
  const read = async () => (await store.read(initial.id, initial.ownerId))!;
  if (options.bound) {
    const nativeId = randomUUID(), user = randomUUID(), directory = join(nativeRoot, "projects", claudeCodeNativeProjectKey(cwd));
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const rows = [
      { type: "user", message: { role: "user", content: "prior input" }, uuid: user, parentUuid: null },
      { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "prior answer" }] }, uuid: randomUUID(), parentUuid: user },
    ].map(row => ({ ...row, sessionId: nativeId, cwd, version: "2.1.321", isSidechain: false, timestamp: new Date().toISOString() }));
    await writeFile(join(directory, `${nativeId}.jsonl`), rows.map(row => JSON.stringify(row)).join("\n") + "\n", { mode: 0o600 });
    await store.withSessionLock(initial.id, initial.ownerId, async lease => {
      await lease.beginNativeCreation(0, nativeId); await lease.bindNativeSession(1, nativeId);
      const identity = { turnId: "prior", fingerprint: createHash("sha256").update("prior input").digest("hex"), nativeMessageId: user };
      await lease.beginDispatch(2, initial.generation, identity); await lease.settleDispatch(3, initial.generation, identity, "completed");
    });
  }
  const scope: ClaudeCodeWorkerRegistrationScope = { sessionId: initial.id, ownerId: initial.ownerId, generation: initial.generation,
    reservationId: randomUUID(), workerExecutable: fileURLToPath(new URL(options.direct ? "../src/worker-entry.js" : "./fixtures/worker-entry.js", import.meta.url)), cwd, nativeConfigRoot: nativeRoot };
  await store.withSessionLock(initial.id, initial.ownerId, async lease => {
    let current = await read(); current = await lease.reserveWorker(current.revision, scope.generation, scope.reservationId, scope.workerExecutable);
    await lease.beginWorkerStart(current.revision, scope.generation, scope.reservationId);
  });
  const child = fork(scope.workerExecutable, [], { cwd, execPath: process.execPath, execArgv: [],
    env: { PATH: process.env.PATH, HOME: root, TMPDIR: root }, detached: options.isolated ?? false, stdio: ["pipe", "ignore", "pipe", "ipc"] });
  const exited = new Promise<number | null>(done => child.once("exit", done));
  const messages: { version: number; type: string; registration?: string }[] = [];
  let stderr = "";
  child.on("message", message => messages.push(message as typeof messages[number]));
  child.stderr!.on("data", chunk => { stderr = (stderr + chunk).slice(-16_384); });
  const pidFile = join(root, "native-pid"), inputFile = join(root, "native-input");
  t.after(async () => {
    if (child.exitCode === null) child.stdin!.end("dispose-owned-fixture\n");
    let timer: ReturnType<typeof setTimeout> | undefined;
    let code: number | null;
    try { code = await Promise.race([exited, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`Fixture did not exit: ${stderr}`)), 12_000); })]); }
    finally { clearTimeout(timer); }
    assert.ok(options.direct ? code === 1 : code === 0 || code === 2, stderr);
    try {
      const pid = Number(await readFile(pidFile, "utf8"));
      await until(async () => { try { process.kill(pid, 0); return false; } catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") return true; throw error; } }, Boolean);
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    await rm(root, { recursive: true, force: true });
  });
  const wait = (type: string) => until(async () => messages.find(message => message.type === type), Boolean);
  await wait("bootstrap_required");
  if (options.recordPid !== false) await store.withSessionLock(initial.id, initial.ownerId, async lease => {
    await lease.recordWorkerProcess((await read()).revision, scope.generation, scope.reservationId, child.pid!, options.isolated ? child.pid! : null);
  });
  const bootstrap: ClaudeCodeWorkerBootstrap = { version: 1, type: "bootstrap", scope, storeRoot,
    publicationTimeoutMs: options.publicationTimeoutMs ?? 5_000,
    nativeOptions: { executable: fileURLToPath(new URL("./fixtures/claude.js", import.meta.url)),
      startupTimeoutMs: options.mode === "startup-hang" ? 250 : 2_000, shutdownTimeoutMs: 1_000, controlTimeoutMs: 1_000,
      env: { PATH: process.env.PATH!, HOME: root, CLAUDE_CONFIG_DIR: nativeRoot, ANTHROPIC_API_KEY: "PRIVATE_BOOTSTRAP_AUTH",
        ANTHROPIC_BASE_URL: "http://127.0.0.1:1", MINU_CLAUDE_FIXTURE_PID: pidFile, MINU_CLAUDE_FIXTURE_INPUT: inputFile,
        ...(options.mode ? { MINU_CLAUDE_FIXTURE_MODE: options.mode } : {}) } } };
  const send = (message: unknown = JSON.stringify(bootstrap)) => new Promise<void>((done, reject) => child.send(message as string, error => error ? reject(error) : done()));
  const prepare = async () => {
    await send(); const message = (await wait("prepared"))!;
    const bytes = Buffer.from(message.registration!, "utf8"), registration = decode(bytes, scope);
    return { bytes, registration, client: new ClaudeCodeWorkerClient(registration, 1_000) };
  };
  const publish = (bytes: Uint8Array) => store.withSessionLock(initial.id, initial.ownerId, async lease =>
    lease.publishWorker((await read()).revision, scope.generation, scope.reservationId, bytes));
  const unavailable = async (client: ClaudeCodeWorkerClient) => {
    await assert.rejects(client.status(), /http_503/);
    await missing(pidFile); await missing(inputFile);
  };
  return { root, store, scope, read, child, exited, bootstrap, send, prepare, publish, wait, messages, stderr: () => stderr,
    pidFile, inputFile, unavailable };
}

test("dormant bootstrap requires recorded PID and publication; ready pending stays native-lazy", async t => {
  const f = await fixture(t), before = await f.read(), { bytes, registration, client } = await f.prepare();
  assert.equal(registration.pid, f.child.pid); assert.equal(registration.processGroupId, null);
  await f.unavailable(client);
  await assert.rejects(client.startTurn("early", "never dispatch")); await missing(f.inputFile);
  assert.deepEqual(await f.read(), before);
  assert.ok(!JSON.stringify(f.child.spawnargs).includes("PRIVATE_BOOTSTRAP_AUTH"));
  const published = await f.publish(bytes); await f.wait("ready");
  assert.equal(await client.status(), "idle"); await missing(f.pidFile);
  assert.deepEqual(await f.read(), published);
  assert.equal(published.native.state, "pending"); assert.equal(published.lastDispatch.state, "none");
  assert.ok(!JSON.stringify(published).includes("PRIVATE_BOOTSTRAP_AUTH"));
  await f.send(); await delay(60);
  assert.equal(f.messages.filter(message => message.type === "prepared").length, 1);
  assert.equal(f.messages.filter(message => message.type === "ready").length, 1);
  assert.deepEqual(Buffer.from(f.messages.find(message => message.type === "ready")!.registration!), bytes);
});

test("fresh POSIX group remains exact through dormant bootstrap, publication and readiness", async t => {
  const f = await fixture(t, { isolated: true }), before = await f.read(), { bytes, registration, client } = await f.prepare();
  assert.equal(registration.pid, f.child.pid); assert.equal(registration.processGroupId, f.child.pid);
  const observed = execFileSync("/bin/ps", ["-o", "pid=,pgid=", "-p", String(f.child.pid)], { encoding: "utf8", timeout: 2_000 });
  assert.deepEqual(observed.trim().split(/\s+/).map(Number), [f.child.pid, f.child.pid]);
  await f.unavailable(client); assert.deepEqual(await f.read(), before);
  const published = await f.publish(bytes); await f.wait("ready");
  assert.equal(await client.status(), "idle"); await missing(f.pidFile); await missing(f.inputFile);
  assert.equal(published.worker.state, "live");
  if (published.worker.state === "live") assert.deepEqual(published.worker.registration, registration);
  assert.deepEqual(await f.read(), published);
});

for (const bound of [false, true]) test(`isolated ${bound ? "bound" : "pending"} worker self-retires after confirmed idle quiesce without clearing metadata`, async t => {
  const f = await fixture(t, { isolated: true, bound }), { bytes, client } = await f.prepare();
  await f.publish(bytes); await f.wait("ready");
  if (bound) {
    await client.startTurn("retire-turn", "hello");
    const turn = await until(() => client.turn("retire-turn"), value => !!value && value.status !== "running");
    assert.equal(turn?.status, "completed"); assert.equal(turn.response?.content, "reply: hello");
  }
  const before = await f.read(), pid = bound ? Number(await readFile(f.pidFile, "utf8")) : undefined;
  if (bound) assert.equal(before.lastDispatch.state, "settled"); else await missing(f.pidFile);
  await client.requestQuiesceIdle();
  await until(async () => f.child.exitCode, value => value !== null);
  assert.equal(await f.exited, 0);
  assert.throws(() => process.kill(-f.child.pid!, 0), { code: "ESRCH" });
  if (pid) assert.throws(() => process.kill(pid, 0), { code: "ESRCH" }); else await missing(f.pidFile);
  assert.deepEqual(await f.read(), before); assert.equal(before.worker.state, "live");
  await assert.rejects(client.status());
  // The protocol peer does not persist this latest turn: no history-eligibility claim.
});

for (const control of ["legacy-null-quiesce", "generic-stop"] as const) test(`${control} does not opt into self-retirement`, async t => {
  const f = await fixture(t, { isolated: control === "generic-stop" }), { bytes, client } = await f.prepare();
  await f.publish(bytes); await f.wait("ready"); const before = await f.read();
  if (control === "generic-stop") await client.requestStop(); else await client.requestQuiesceIdle();
  assert.equal(await client.status(), "offline"); assert.equal(f.child.exitCode, null);
  assert.deepEqual(await f.read(), before); await missing(f.pidFile);
});

test("starting without a recorded PID refuses bootstrap without metadata repair", async t => {
  const f = await fixture(t, { recordPid: false }), before = await f.read();
  await f.send(); await f.wait("unavailable");
  assert.ok(!f.messages.some(message => message.type === "prepared"));
  await missing(f.pidFile); assert.deepEqual(await f.read(), before);
});

for (const field of ["workerExecutable", "cwd", "nativeConfigRoot", "generation", "reservationId"] as const) {
  test(`bootstrap rejects mismatched ${field} without native launch or private diagnostic echo`, async t => {
    const f = await fixture(t), before = await f.read();
    f.bootstrap.scope = { ...f.scope, [field]: field === "generation" ? "other-generation" : field === "reservationId" ? randomUUID() : join(f.root, "other") };
    await f.send(); await f.wait("unavailable");
    assert.ok(!f.messages.some(message => message.type === "prepared")); await missing(f.pidFile);
    assert.deepEqual(await f.read(), before);
    assert.ok(!JSON.stringify(f.messages).includes("PRIVATE_BOOTSTRAP_AUTH")); assert.ok(!f.stderr().includes("PRIVATE_BOOTSTRAP_AUTH"));
  });
}

test("adoption is not readiness: parent-held lease blocks initialization, not pre-ready refusal", async t => {
  const f = await fixture(t, { bound: true }), { bytes, client } = await f.prepare();
  const published = await f.store.withSessionLock(f.scope.sessionId, f.scope.ownerId, async lease => {
    const next = await lease.publishWorker((await f.read()).revision, f.scope.generation, f.scope.reservationId, bytes);
    await delay(100); await f.unavailable(client);
    assert.ok(!f.messages.some(message => message.type === "ready"));
    return next;
  });
  await f.wait("ready"); assert.equal(await client.status(), "idle");
  assert.deepEqual(await f.read(), published); await missing(f.inputFile);
  assert.ok(Number(await readFile(f.pidFile, "utf8")) > 0);
});

test("lost publication acknowledgment and genuine creator IPC loss do not prevent exact adoption", async t => {
  const f = await fixture(t), { bytes, registration, client } = await f.prepare();
  f.child.disconnect(); await delay(60); await f.unavailable(client); assert.equal(f.child.exitCode, null);
  await assert.rejects(f.store.withSessionLock(f.scope.sessionId, f.scope.ownerId, async lease => {
    await lease.publishWorker((await f.read()).revision, f.scope.generation, f.scope.reservationId, bytes);
    throw new Error("lost publication confirmation");
  }), /lost publication confirmation/);
  const published = await f.read();
  await until(() => client.status().catch(() => "unavailable"), value => value === "idle");
  assert.equal(published.worker.state, "live");
  if (published.worker.state === "live") assert.deepEqual(published.worker.registration, registration);
  assert.deepEqual(await f.read(), published); await missing(f.pidFile);
  assert.equal(f.child.exitCode, null);
});

for (const fence of ["generation", "human"] as const) {
  test(`${fence} fence while publication admission is queued prevents activation`, async t => {
    const f = await fixture(t, { bound: true }), { bytes, client } = await f.prepare();
    const fenced = await f.store.withSessionLock(f.scope.sessionId, f.scope.ownerId, async lease => {
      const published = await lease.publishWorker((await f.read()).revision, f.scope.generation, f.scope.reservationId, bytes);
      await delay(100); await f.unavailable(client);
      return lease.update(published.revision, fence === "generation" ? { generation: "new-generation" } : { requiresExplicitResume: true });
    });
    await f.wait("unavailable"); await f.unavailable(client);
    assert.deepEqual(await f.read(), fenced); assert.equal(f.child.exitCode, null);
  });
}

test("publication must match the frozen candidate, not merely its scope/PID", async t => {
  const f = await fixture(t), { registration, client } = await f.prepare();
  const published = await f.publish(Buffer.from(JSON.stringify({ ...registration, token: "b".repeat(64) })));
  await f.wait("unavailable"); await f.unavailable(client);
  assert.deepEqual(await f.read(), published); assert.ok(!f.messages.some(message => message.type === "ready"));
});

test("publication deadline is terminal; late authentic publication cannot silently activate", async t => {
  const f = await fixture(t, { publicationTimeoutMs: 150 }), { bytes, client } = await f.prepare();
  const before = await f.read(); await f.wait("unavailable");
  await f.unavailable(client); assert.deepEqual(await f.read(), before);
  const published = await f.publish(bytes); await delay(80);
  await f.unavailable(client); assert.deepEqual(await f.read(), published);
  assert.ok(!f.messages.some(message => message.type === "ready")); assert.equal(f.child.exitCode, null);
});

test("failed bound initialization is terminal and unavailable, not retried or cleared", async t => {
  const f = await fixture(t, { bound: true, mode: "startup-hang" }), { bytes, client } = await f.prepare();
  const published = await f.publish(bytes); await f.wait("unavailable");
  await assert.rejects(client.status(), /http_503/); await missing(f.inputFile);
  const pid = await readFile(f.pidFile, "utf8");
  await f.send(); await delay(80);
  assert.equal(await readFile(f.pidFile, "utf8"), pid); assert.deepEqual(await f.read(), published);
  assert.ok(!f.messages.some(message => message.type === "ready")); assert.equal(f.child.exitCode, null);
});

test("bootstrap does not inherit a missing native environment or ignore unsupported callbacks", async t => {
  for (const change of [ { env: undefined }, { canUseTool: "PRIVATE_BOOTSTRAP_AUTH" } ]) {
    const f = await fixture(t), before = await f.read();
    await f.send(JSON.stringify({ ...f.bootstrap, nativeOptions: { ...f.bootstrap.nativeOptions, ...change } }));
    await f.wait("unavailable"); await missing(f.pidFile); assert.deepEqual(await f.read(), before);
    assert.ok(!f.messages.some(message => message.type === "prepared"));
    assert.ok(!JSON.stringify(f.messages).includes("PRIVATE_BOOTSTRAP_AUTH"));
  }
});

for (const message of ["not-json-PRIVATE_BOOTSTRAP_AUTH", "x".repeat(CLAUDE_CODE_BOOTSTRAP_MAX_BYTES + 1), { type: "bootstrap", private: "PRIVATE_BOOTSTRAP_AUTH" }]) {
  test(`malformed/non-string/oversized private bootstrap rejects (${typeof message}/${JSON.stringify(message).length})`, async t => {
    const f = await fixture(t, { direct: true }), before = await f.read(); await f.send(message);
    assert.equal(await f.exited, 1);
    await missing(f.pidFile); assert.deepEqual(await f.read(), before);
    assert.ok(!JSON.stringify(f.messages).includes("PRIVATE_BOOTSTRAP_AUTH")); assert.ok(!f.stderr().includes("PRIVATE_BOOTSTRAP_AUTH"));
  });
}
