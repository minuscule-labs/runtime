import assert from "node:assert/strict";
import { execFileSync, type ChildProcess, type ForkOptions } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { lstat, mkdir, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { test, type TestContext } from "node:test";
import { ClaudeCodeManagedStore, type ClaudeCodeManagedManifest, type ClaudeCodeManifestLease } from "../src/managed-store.js";
import { launchClaudeCodeWorker, type ClaudeCodeWorkerLaunchOptions } from "../src/worker-launch.js";
import { decodeClaudeCodeWorkerRegistration as decode, encodeClaudeCodeWorkerRegistration as encode } from "../src/worker-registration.js";
import { ClaudeCodeWorkerClient } from "../src/worker-client.js";
import { waitForClaudeCodeWorkerReady } from "../src/worker-readiness.js";

async function until<T>(read: () => Promise<T>, done: (value: T) => boolean): Promise<T> {
  const end = performance.now() + 8_000;
  while (true) { const value = await read(); if (done(value)) return value; if (performance.now() >= end) throw new Error("Launch test timed out"); await delay(10); }
}
async function fixture(t: TestContext, mode?: string) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "claude-worker-launch-")));
  const cwd = join(root, "workspace"), nativeRoot = join(root, "native"), storeRoot = join(root, "managed");
  await mkdir(cwd, { mode: 0o700 }); await mkdir(nativeRoot, { mode: 0o700 });
  const store = new ClaudeCodeManagedStore(storeRoot);
  const manifest: ClaudeCodeManagedManifest = { version: 3, runtime: "claude-code", id: "launch-session", ownerId: "owner",
    revision: 0, generation: "generation", requiresExplicitResume: false, native: { state: "pending" }, worker: { state: "none" },
    lastDispatch: { state: "none" }, launchConfig: { cwd },
    policy: { configuration: "isolated", permissionMode: "default", nativeConfigRoot: nativeRoot, tools: [] }, createdAt: new Date().toISOString() };
  await store.create(manifest);
  const path = join(storeRoot, createHash("sha256").update(manifest.ownerId).digest("hex"), `${manifest.id}.session`, "manifest.json");
  const pidFile = join(root, "native-pid");
  const options: ClaudeCodeWorkerLaunchOptions = { storeRoot, sessionId: manifest.id, ownerId: manifest.ownerId,
    workerExecutable: fileURLToPath(new URL(mode ? "./fixtures/worker-launch-peer.js" : "./fixtures/worker-entry.js", import.meta.url)),
    preparationTimeoutMs: 5_000, publicationTimeoutMs: 5_000,
    nativeOptions: { executable: fileURLToPath(new URL("./fixtures/claude.js", import.meta.url)),
      startupTimeoutMs: 2_000, shutdownTimeoutMs: 1_000,
      env: { PATH: process.env.PATH!, HOME: root, TMPDIR: root, CLAUDE_CONFIG_DIR: nativeRoot,
        ANTHROPIC_API_KEY: "PRIVATE_PRODUCER_AUTH", ANTHROPIC_BASE_URL: "http://127.0.0.1:1", MINU_CLAUDE_FIXTURE_PID: pidFile,
        ...(mode ? { MINU_PRODUCER_PEER: mode } : {}) } } };
  const children: { child: ChildProcess; closed: Promise<void> }[] = [];
  const forks: { manifest: ClaudeCodeManagedManifest; entry: string; options: ForkOptions; args: string[] }[] = [];
  let failFork = false;
  // Scoped builtin interception observes the real manifest AT the physical fork call,
  // rather than inferring order from a later child's asynchronously read snapshot.
  const childProcess = createRequire(import.meta.url)("node:child_process") as typeof import("node:child_process");
  const original = childProcess.fork;
  childProcess.fork = ((entry: string, args: string[], spawnOptions: ForkOptions) => {
    const atFork = JSON.parse(readFileSync(path, "utf8")) as ClaudeCodeManagedManifest;
    assert.equal(atFork.worker.state, "starting");
    if (atFork.worker.state === "starting") assert.equal(atFork.worker.process, null);
    forks.push({ manifest: atFork, entry, args, options: spawnOptions });
    if (failFork) throw new Error("PRIVATE_PRODUCER_AUTH fork fault");
    const child = original(entry, args, spawnOptions);
    children.push({ child, closed: new Promise<void>(done => child.once("exit", () => done())) });
    return child;
  }) as typeof original;
  syncBuiltinESMExports();
  t.after(async () => {
    childProcess.fork = original; syncBuiltinESMExports();
    for (const { child, closed } of children) {
      // Explicit TEST disposal, not a producer abort or proof permitting metadata clear.
      try { if (child.connected) child.disconnect(); } catch { /* Already closed. */ }
      if (child.exitCode === null && child.stdin?.writable) child.stdin.end("dispose-owned-fixture\n");
      let timer: ReturnType<typeof setTimeout> | undefined;
      try { await Promise.race([closed, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`Owned launch fixture did not exit (code=${child.exitCode}, stdin=${child.stdin?.writable})`)), 10_000); })]); }
      finally { clearTimeout(timer); }
    }
    await assert.rejects(readFile(pidFile), { code: "ENOENT" });
    await rm(root, { recursive: true, force: true });
  });
  return { root, store, manifest, options, forks, children, pidFile, path, failFork: () => { failFork = true; },
    read: async () => (await store.read(manifest.id, manifest.ownerId))!, launch: () => launchClaudeCodeWorker(options) };
}
function loseConfirmation(t: TestContext, method: "beginWorkerStart" | "recordWorkerProcess" | "publishWorker", beforeReturn?: (lease: ClaudeCodeManifestLease, committed: ClaudeCodeManagedManifest) => Promise<void>) {
  const original = ClaudeCodeManagedStore.prototype.withSessionLock;
  let calls = 0;
  ClaudeCodeManagedStore.prototype.withSessionLock = function<T>(id: string, owner: string, operation: (lease: ClaudeCodeManifestLease) => Promise<T>, timeout?: number) {
    return original.call(this, id, owner, async lease => {
      const actual = lease[method] as (...args: unknown[]) => Promise<ClaudeCodeManagedManifest>;
      Object.assign(lease, { [method]: async (...args: unknown[]) => {
        calls++; const committed = await actual(...args); await beforeReturn?.(lease, committed);
        throw new Error("PRIVATE_PRODUCER_AUTH lost mutation confirmation");
      } });
      return operation(lease);
    }, timeout) as Promise<T>;
  };
  t.after(() => { ClaudeCodeManagedStore.prototype.withSessionLock = original; });
  return Object.assign(() => calls, { restore: () => { ClaudeCodeManagedStore.prototype.withSessionLock = original; } });
}

test("producer commits before real fork, records before private bootstrap, publishes without claiming readiness", async t => {
  const f = await fixture(t, "valid"), attempt = await f.launch();
  assert.equal(attempt.state, "adopted"); assert.equal(f.forks.length, 1); assert.equal(attempt.child, f.children[0].child);
  const observed = JSON.parse(await readFile(join(f.root, "peer-observed.json"), "utf8"));
  assert.equal(observed.manifest.worker.state, "starting"); assert.equal(observed.manifest.worker.process.pid, attempt.child!.pid);
  assert.equal(observed.manifest.worker.process.processGroupId, attempt.child!.pid);
  assert.deepEqual(observed.execArgv, []); assert.equal(observed.argv.length, 2);
  assert.equal(observed.environment.ANTHROPIC_API_KEY, undefined); assert.equal(observed.environment.NODE_OPTIONS, undefined);
  assert.deepEqual(Object.keys(observed.environment).filter(key => key !== "__CF_USER_TEXT_ENCODING").sort(), ["CLAUDE_CONFIG_DIR", "HOME", "PATH", "TMPDIR"]);
  assert.deepEqual(Object.keys(f.forks[0].options.env!).sort(), ["CLAUDE_CONFIG_DIR", "HOME", "PATH", "TMPDIR"]);
  assert.deepEqual(f.forks[0].options.execArgv, []); assert.deepEqual(f.forks[0].args, []); assert.equal(f.forks[0].options.detached, true);
  assert.ok(!JSON.stringify(f.forks[0]).includes("PRIVATE_PRODUCER_AUTH"));
  const published = await f.read(), registration = decode(attempt.registration!, attempt.scope);
  assert.equal(published.worker.state, "live"); assert.equal(published.revision, 4);
  if (published.worker.state === "live") assert.deepEqual(published.worker.registration, registration);
  assert.ok(!JSON.stringify(published).includes("PRIVATE_PRODUCER_AUTH"));
  // This peer deliberately has NO listener/ready flag. Adoption is NOT readiness.
  await assert.rejects(new ClaudeCodeWorkerClient(registration, 100).status());
  assert.equal(attempt.child!.connected, false); assert.equal(attempt.child!.exitCode, null);
});

test("fresh launch records its actual POSIX group through real bootstrap without native allocation", async t => {
  const f = await fixture(t), attempt = await f.launch(); assert.equal(attempt.state, "adopted");
  const child = attempt.child!, pid = child.pid!, registration = decode(attempt.registration!, attempt.scope);
  assert.equal(registration.pid, pid); assert.equal(registration.processGroupId, pid);
  // Known freshly retained child ONLY; no process-table sweep or recovered control.
  const observed = execFileSync("/bin/ps", ["-o", "pid=,pgid=", "-p", String(pid)], { encoding: "utf8", timeout: 2_000 });
  assert.deepEqual(observed.trim().split(/\s+/).map(Number), [pid, pid]);
  assert.deepEqual(await waitForClaudeCodeWorkerReady({ store: f.store, scope: attempt.scope,
    registration: attempt.registration!, timeoutMs: 2_000 }), { state: "ready", status: "idle" });
  const before = await f.read(); assert.equal(before.worker.state, "live"); assert.equal(before.native.state, "pending");
  if (before.worker.state === "live") assert.deepEqual(before.worker.registration, registration);
  assert.equal(child.connected, false); await assert.rejects(readFile(f.pidFile), { code: "ENOENT" });
  // Cooperative test disposal, not production retirement or permission to clear.
  child.stdin!.end("dispose-owned-fixture\n"); await f.children[0].closed;
  assert.equal(child.exitCode, 0);
  assert.throws(() => process.kill(-pid, 0), { code: "ESRCH" });
  assert.deepEqual(await f.read(), before, "exit alone must not clear or rewrite metadata");
});

test("Windows refuses POSIX-group launch before metadata mutation or fork", async t => {
  const f = await fixture(t), before = await readFile(f.path);
  const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
  try {
    Object.defineProperty(process, "platform", { ...platform, value: "win32" });
    await assert.rejects(f.launch(), /^Error: Claude Code worker launch unavailable$/);
  } finally { Object.defineProperty(process, "platform", platform); }
  assert.equal(f.forks.length, 0); assert.deepEqual(await readFile(f.path), before);
});

for (const state of ["starting", "live"] as const) test(`bound legacy ${state} group:null metadata is never migrated or replaced`, async t => {
  const f = await fixture(t), nativeId = randomUUID(), reservationId = randomUUID();
  const identity = { turnId: "prior", fingerprint: createHash("sha256").update("prior input").digest("hex"), nativeMessageId: randomUUID() };
  // Logical legacy metadata fixture only: this PID is never probed or signaled.
  await f.store.withSessionLock(f.manifest.id, f.manifest.ownerId, async lease => {
    let m = await lease.beginNativeCreation(0, nativeId); m = await lease.bindNativeSession(m.revision, nativeId);
    m = await lease.beginDispatch(m.revision, m.generation, identity); m = await lease.settleDispatch(m.revision, m.generation, identity, "completed");
    m = await lease.reserveWorker(m.revision, m.generation, reservationId, f.options.workerExecutable!);
    m = await lease.beginWorkerStart(m.revision, m.generation, reservationId);
    m = await lease.recordWorkerProcess(m.revision, m.generation, reservationId, process.pid, null);
    if (state === "live") {
      const scope = { sessionId: m.id, ownerId: m.ownerId, generation: m.generation, reservationId,
        workerExecutable: f.options.workerExecutable!, cwd: f.manifest.launchConfig.cwd,
        nativeConfigRoot: m.policy.nativeConfigRoot };
      await lease.publishWorker(m.revision, m.generation, reservationId, encode({ version: 1, runtime: "claude-code", ownership: "owned", ...scope,
        pid: process.pid, processGroupId: null, endpoint: "http://127.0.0.1:1", token: "a".repeat(64), createdAt: new Date().toISOString() }, scope));
    }
  });
  const before = await readFile(f.path), attempt = await f.launch();
  assert.equal(attempt.state, "unavailable"); assert.equal(attempt.child, undefined); assert.equal(f.forks.length, 0);
  assert.deepEqual(await readFile(f.path), before); await assert.rejects(readFile(f.pidFile), { code: "ENOENT" });
});

test("real bootstrap activates independently after producer releases the lease and disconnects", async t => {
  const f = await fixture(t), attempt = await f.launch(); assert.equal(attempt.state, "adopted");
  const client = new ClaudeCodeWorkerClient(decode(attempt.registration!, attempt.scope), 1_000);
  await until(() => client.status().catch(() => "unavailable"), value => value === "idle");
  const published = await f.read(); assert.equal(published.revision, 4); assert.equal(published.native.state, "pending");
  assert.equal(published.lastDispatch.state, "none"); assert.equal(attempt.child!.connected, false);
  await assert.rejects(readFile(f.pidFile), { code: "ENOENT" });
});

test("readiness confirms the real adopted bootstrap without native allocation or another launch", async t => {
  const f = await fixture(t), attempt = await f.launch(); assert.equal(attempt.state, "adopted");
  const before = await f.read();
  assert.deepEqual(await waitForClaudeCodeWorkerReady({ store: f.store, scope: attempt.scope,
    registration: attempt.registration!, timeoutMs: 2_000 }), { state: "ready", status: "idle" });
  assert.equal(f.forks.length, 1); assert.equal(attempt.child!.connected, false);
  assert.deepEqual(await f.read(), before); await assert.rejects(readFile(f.pidFile), { code: "ENOENT" });
});

test("concurrent producers fork once; existing live worker cannot authorize a replacement", async t => {
  const f = await fixture(t), attempts = await Promise.all([f.launch(), f.launch()]);
  assert.equal(attempts.filter(attempt => attempt.state === "adopted").length, 1);
  assert.equal(attempts.filter(attempt => attempt.state === "unavailable" && !attempt.child).length, 1);
  assert.equal(f.forks.length, 1); assert.equal((await f.read()).revision, 4);
});

for (const method of ["beginWorkerStart", "recordWorkerProcess", "publishWorker"] as const) {
  test(`lost ${method} acknowledgment never rolls back or repeats a mutation`, async t => {
    const f = await fixture(t), calls = loseConfirmation(t, method), attempt = await f.launch().finally(calls.restore), current = await f.read();
    assert.equal(calls(), 1);
    if (method === "beginWorkerStart") {
      assert.equal(attempt.state, "unavailable"); assert.equal(attempt.child, undefined); assert.equal(f.forks.length, 0);
      assert.equal(current.revision, 2); assert.equal(current.worker.state, "starting");
      if (current.worker.state === "starting") assert.equal(current.worker.process, null);
    } else if (method === "recordWorkerProcess") {
      assert.equal(attempt.state, "unavailable"); assert.equal(f.forks.length, 1); assert.equal(attempt.registration, undefined);
      assert.equal(current.revision, 3); assert.equal(current.worker.state, "starting");
      if (current.worker.state === "starting") assert.equal(current.worker.process!.pid, attempt.child!.pid);
    } else {
      assert.equal(attempt.state, "adopted"); assert.equal(f.forks.length, 1); assert.equal(current.revision, 4); assert.equal(current.worker.state, "live");
      const client = new ClaudeCodeWorkerClient(decode(attempt.registration!, attempt.scope), 1_000);
      await until(() => client.status().catch(() => "unavailable"), value => value === "idle");
    }
    assert.equal(current.native.state, "pending"); assert.equal(current.lastDispatch.state, "none");
  });
}

test("known synchronous fork failure still retains committed starting/no-PID uncertainty", async t => {
  const f = await fixture(t); f.failFork(); const attempt = await f.launch(), current = await f.read();
  assert.equal(attempt.state, "unavailable"); assert.equal(attempt.child, undefined); assert.equal(f.children.length, 0);
  assert.equal(current.revision, 2); assert.equal(current.worker.state, "starting");
  if (current.worker.state === "starting") assert.equal(current.worker.process, null);
  assert.ok(!JSON.stringify(attempt).includes("PRIVATE_PRODUCER_AUTH"));
});

for (const mode of ["wrong-pid", "wrong-group", "wrong-scope", "oversized", "hang", "ready-only"]) {
  test(`${mode} candidate cannot cause publication, replacement or startup reset`, async t => {
    const f = await fixture(t, mode); if (["hang", "ready-only"].includes(mode)) f.options.preparationTimeoutMs = 1_000;
    const attempt = await f.launch(), current = await f.read();
    assert.equal(attempt.state, "unavailable"); assert.equal(f.forks.length, 1); assert.equal(attempt.registration, undefined);
    assert.equal(current.revision, 3); assert.equal(current.worker.state, "starting");
    if (current.worker.state === "starting") assert.equal(current.worker.process!.pid, attempt.child!.pid);
    assert.equal(current.native.state, "pending"); assert.equal(current.lastDispatch.state, "none");
    const observed = JSON.parse(await readFile(join(f.root, "peer-observed.json"), "utf8"));
    assert.equal(observed.manifest.worker.process.pid, attempt.child!.pid);
  });
}

test("generation/human fence after PID commit refuses startup and is never cleared", async t => {
  const f = await fixture(t);
  const injection = loseConfirmation(t, "recordWorkerProcess", async (lease, committed) => {
    await lease.update(committed.revision, { generation: "new-generation", requiresExplicitResume: true });
  });
  const attempt = await f.launch().finally(injection.restore), current = await f.read();
  assert.equal(attempt.state, "unavailable"); assert.equal(f.forks.length, 1); assert.equal(attempt.registration, undefined);
  assert.equal(current.revision, 4); assert.equal(current.generation, "new-generation"); assert.equal(current.requiresExplicitResume, true);
  assert.equal(current.worker.state, "starting"); assert.equal(current.native.state, "pending");
});

test("missing explicit store root cannot select or create a host default", async t => {
  const f = await fixture(t), before = await f.read(), previousHome = process.env.HOME;
  // Isolate the constructor's possible fallback; never inspect/create the real host root.
  const defaultRoot = join(f.root, ".minu", "runtime-claude-code", "managed");
  process.env.HOME = f.root;
  try {
    await assert.rejects(lstat(defaultRoot), { code: "ENOENT" }); Reflect.deleteProperty(f.options, "storeRoot");
    await assert.rejects(f.launch(), /^Error: Claude Code worker launch unavailable$/);
    assert.equal(f.forks.length, 0); assert.deepEqual(await f.read(), before);
    await assert.rejects(lstat(defaultRoot), { code: "ENOENT" });
  } finally { if (previousHome === undefined) delete process.env.HOME; else process.env.HOME = previousHome; }
});

test("managed limit ceilings remain valid through real bootstrap initialization", async t => {
  const f = await fixture(t);
  f.options.nativeOptions.turnRetentionLimit = 1_000;
  f.options.nativeOptions.eventBufferLimit = 4_096;
  const attempt = await f.launch(); assert.equal(attempt.state, "adopted");
  const client = new ClaudeCodeWorkerClient(decode(attempt.registration!, attempt.scope), 1_000);
  await until(() => client.status().catch(() => "unavailable"), value => value === "idle");
  assert.equal(f.forks.length, 1); assert.equal((await f.read()).revision, 4);
  await assert.rejects(readFile(f.pidFile), { code: "ENOENT" });
});

for (const invalid of ["missing-env", "callback", "oversized", "limit", "retention-ceiling", "buffer-ceiling"] as const) {
  test(`invalid private ${invalid} fails preflight before metadata mutation or fork`, async t => {
    const f = await fixture(t), before = await f.read();
    if (invalid === "missing-env") Reflect.deleteProperty(f.options.nativeOptions, "env");
    if (invalid === "callback") Object.assign(f.options.nativeOptions, { canUseTool: async () => ({ behavior: "allow" }) });
    if (invalid === "oversized") f.options.nativeOptions.env.SECRET = "x".repeat(65_536);
    if (invalid === "limit") f.options.nativeOptions.startupTimeoutMs = 0;
    if (invalid === "retention-ceiling") f.options.nativeOptions.turnRetentionLimit = 1_001;
    if (invalid === "buffer-ceiling") f.options.nativeOptions.eventBufferLimit = 4_097;
    await assert.rejects(f.launch(), /^Error: Claude Code worker launch unavailable$/);
    assert.equal(f.forks.length, 0); assert.deepEqual(await f.read(), before);
  });
}
