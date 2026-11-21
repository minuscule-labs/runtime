import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { test, type TestContext } from "node:test";
import { processGroupAbsent } from "@minu/runtime-core";

// Temporary diagnosis of the macOS exact-main recovery failure; fixtures only.
process.env.MINU_RECOVERY_DIAGNOSTIC = "1";
import { ClaudeCodeManagedRuntime, type ClaudeCodeManagedRuntimeOptions } from "../src/managed-runtime.js";
import { ClaudeCodeManagedStore, type ClaudeCodeManagedManifest } from "../src/managed-store.js";
import { claudeCodeNativeProjectKey } from "../src/native-history.js";
import { recoverClaudeCodeWorker } from "../src/worker-recovery.js";

async function until<T>(read: () => Promise<T>, done: (value: T) => boolean) {
  const end = performance.now() + 8_000;
  while (true) { const value = await read(); if (done(value)) return value; if (performance.now() > end) throw Error("Recovery test timed out"); await delay(10); }
}
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; } };
const groupOf = (m: ClaudeCodeManagedManifest) => m.worker.state === "live" ? m.worker.registration.processGroupId : m.worker.state === "starting" ? m.worker.process?.processGroupId ?? null : null;

async function fixture(t: TestContext, workerFixture = "worker-entry", extraEnv: Record<string, string> = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "claude-recovery-")));
  const cwd = join(root, "workspace"), native = join(root, "native"), state = join(root, "managed");
  await mkdir(cwd, { mode: 0o700 }); await mkdir(native, { mode: 0o700 });
  const options: ClaudeCodeManagedRuntimeOptions = { ownerId: "owner", storeRoot: state, nativeConfigRoot: native, timeoutMs: 4_000,
    workerExecutable: fileURLToPath(new URL(`./fixtures/${workerFixture}.js`, import.meta.url)),
    nativeOptions: { executable: fileURLToPath(new URL("./fixtures/persistent-native.js", import.meta.url)),
      startupTimeoutMs: 2_000, shutdownTimeoutMs: 1_000, controlTimeoutMs: 1_000,
      env: { HOME: root, PATH: process.env.PATH!, TMPDIR: root, CLAUDE_CONFIG_DIR: native,
        ANTHROPIC_API_KEY: "PRIVATE_RECOVERY_DUMMY", MINU_CLAUDE_FIXTURE_PID: join(root, "native-pid"), ...extraEnv } } };
  const store = new ClaudeCodeManagedStore(state), runtime = new ClaudeCodeManagedRuntime(options);
  const seen = new Set<number>();
  // Teardown: no test may leave a live worker/native group, whatever happened.
  t.after(async () => {
    for (const m of await store.list("owner").catch(() => [])) { const g = groupOf(m); if (g) seen.add(g); }
    for (const group of seen) { try { process.kill(-group, "SIGKILL"); } catch { /* Gone. */ } }
    for (const group of seen) await until(async () => processGroupAbsent(group), state => state === "absent");
    await rm(root, { recursive: true, force: true });
  });
  const track = (m: ClaudeCodeManagedManifest) => { const g = groupOf(m); if (g) seen.add(g); return m; };
  const manifestPath = (id: string) => join(state, createHash("sha256").update("owner").digest("hex"), `${id}.session`, "manifest.json");
  return { root, cwd, native, state, runtime, store, options, track, manifestPath,
    controller: () => new ClaudeCodeManagedRuntime(options),
    read: async (id: string) => (await store.read(id, "owner"))!,
    nativePid: async () => Number(await readFile(join(root, "native-pid"), "utf8")),
    history: (id: string) => join(native, "projects", claudeCodeNativeProjectKey(cwd), id + ".jsonl") };
}

test("forceStopManaged recovers a BUSY session: fence, native gone, suspended, idempotent; destroy then removes metadata only", { timeout: 30_000 }, async t => {
  const f = await fixture(t), session = await f.runtime.start({ cwd: f.cwd });
  await f.runtime.startTurn(session.id, "busy", "hold");
  const busy = f.track(await f.read(session.id)), group = groupOf(busy)!, nativePid = await f.nativePid();
  assert.ok(alive(nativePid)); assert.equal(await f.runtime.status(session.id), "working");
  await assert.rejects(f.runtime.stop(session.id)); // Normal stop keeps its strict refusal.
  assert.deepEqual(await f.read(session.id), busy);
  await assert.rejects(f.runtime.forceStopManaged(session.id, "wrong-owner"));
  await f.runtime.forceStopManaged(session.id, "owner");
  const stopped = await f.read(session.id);
  assert.equal(stopped.worker.state, "none"); assert.equal(stopped.requiresExplicitResume, true);
  assert.notEqual(stopped.generation, busy.generation);
  assert.deepEqual(stopped.native, busy.native); assert.deepEqual(stopped.lastDispatch, busy.lastDispatch);
  assert.equal(processGroupAbsent(group), "absent"); assert.equal(alive(nativePid), false);
  assert.equal((await f.runtime.getManagedSession(session.id, "owner"))?.state, "suspended");
  assert.equal(await f.runtime.status(session.id), "offline");
  await f.runtime.forceStopManaged(session.id, "owner"); assert.deepEqual(await f.read(session.id), stopped, "second call is a no-op");
  // Interrupted input is uncertain: resume re-checks history after absence and refuses, staying fenced and suspended.
  await assert.rejects(f.controller().resume(session.id, "owner", { allowStopped: true }));
  assert.deepEqual(await f.read(session.id), stopped);
  assert.equal(busy.native.state === "bound" && (await stat(f.history(busy.native.sessionId))).isFile(), true);
  await f.runtime.destroy(session.id, "owner");
  assert.equal(await f.store.read(session.id, "owner"), undefined);
  assert.equal(busy.native.state === "bound" && (await stat(f.history(busy.native.sessionId))).isFile(), true, "native history is not deleted");
  await f.runtime.destroy(session.id, "owner"); // Never-existing/already-destroyed is a no-op.
  assert.deepEqual(await f.runtime.listManagedSessions("owner"), []);
});

test("an externally SIGKILLed worker group is cleared through group-absence proof, then resumes after a clean turn", { timeout: 30_000 }, async t => {
  const f = await fixture(t), session = await f.runtime.start({ cwd: f.cwd });
  await f.runtime.send(session.id, "clean first turn");
  const before = f.track(await f.read(session.id)), group = groupOf(before)!, nativePid = await f.nativePid();
  process.kill(-group, "SIGKILL");
  await until(async () => processGroupAbsent(group), state => state === "absent");
  assert.equal((await f.runtime.getManagedSession(session.id, "owner"))?.state, "unavailable");
  await f.runtime.forceStopManaged(session.id, "owner");
  const stopped = await f.read(session.id);
  assert.equal(stopped.worker.state, "none"); assert.equal(stopped.requiresExplicitResume, true);
  assert.deepEqual(stopped.native, before.native); assert.deepEqual(stopped.lastDispatch, before.lastDispatch);
  assert.equal(alive(nativePid), false);
  const next = f.controller();
  assert.equal((await next.resume(session.id, "owner", { allowStopped: true })).id, session.id);
  f.track(await f.read(session.id)); await next.send(session.id, "after recovery"); await next.stop(session.id);
});

test("a corrupt registration or dead endpoint falls through to verified termination of the marked group", { timeout: 30_000 }, async t => {
  const f = await fixture(t), session = await f.runtime.start({ cwd: f.cwd });
  const before = f.track(await f.read(session.id)), group = groupOf(before)!, nativePid = await f.nativePid().catch(() => 0);
  assert.equal(before.worker.state === "live" && before.worker.marked, true);
  process.kill(group, "SIGSTOP"); // The worker can neither answer the stop request nor handle TERM.
  await recoverClaudeCodeWorker(f.store, session.id, "owner", { timeouts: { requestMs: 200, graceMs: 300, termMs: 300, killMs: 3_000 } });
  assert.equal(processGroupAbsent(group), "absent"); if (nativePid) assert.equal(alive(nativePid), false);
  const stopped = await f.read(session.id); assert.equal(stopped.worker.state, "none"); assert.equal(stopped.requiresExplicitResume, true);
});

test("a legacy unmarked worker is never signalled: it stays fenced until absence is proven", { timeout: 30_000 }, async t => {
  const f = await fixture(t), session = await f.runtime.start({ cwd: f.cwd });
  const before = f.track(await f.read(session.id)), group = groupOf(before)!;
  const record = JSON.parse(await readFile(f.manifestPath(session.id), "utf8"));
  delete record.worker.marked; delete record.worker.bootIdentity; record.version = 3;
  // A genuinely legacy record also predates the permission policy fields.
  record.policy = { configuration: "isolated", permissionMode: "default", nativeConfigRoot: record.policy.nativeConfigRoot, tools: ["Read", "Grep", "Glob"] };
  await writeFile(f.manifestPath(session.id), JSON.stringify(record) + "\n", { mode: 0o600 });
  process.kill(group, "SIGSTOP");
  await assert.rejects(recoverClaudeCodeWorker(f.store, session.id, "owner", { timeouts: { requestMs: 100, graceMs: 200, termMs: 100, killMs: 100 } }));
  assert.equal(processGroupAbsent(group), "present", "no signal may reach an unmarked worker");
  const fenced = await f.read(session.id);
  assert.equal(fenced.requiresExplicitResume, true); assert.equal(fenced.worker.state, "live");
  assert.equal((await f.runtime.getManagedSession(session.id, "owner"))?.state, "unavailable");
  await assert.rejects(f.controller().resume(session.id, "owner", { allowStopped: true }));
  await assert.rejects(f.runtime.destroy(session.id, "owner"));
  assert.equal((await f.read(session.id)).worker.state, "live", "destroy must not remove an unproven worker's metadata");
  process.kill(-group, "SIGKILL"); await until(async () => processGroupAbsent(group), state => state === "absent");
  await f.runtime.forceStopManaged(session.id, "owner"); // Group ESRCH is still proof for a legacy own-group worker.
  assert.equal((await f.read(session.id)).worker.state, "none");
});

test("reserved, starting-without-process and legacy group:null slots: only proof clears them", { timeout: 30_000 }, async t => {
  const f = await fixture(t);
  const make = async (launch: { bootIdentity?: string } | undefined, advance: "reserved" | "starting") => {
    const id = `slot-${Math.random().toString(36).slice(2)}`, generation = "gen-" + id, reservation = "11111111-2222-4333-8444-555555555555";
    await f.store.create({ version: 4, runtime: "claude-code", id, ownerId: "owner", revision: 0, generation, requiresExplicitResume: false,
      native: { state: "pending" }, worker: { state: "none" }, lastDispatch: { state: "none" }, launchConfig: { cwd: f.cwd },
      policy: { configuration: "isolated", permissionMode: "default", nativeConfigRoot: f.native, tools: ["Read", "Grep", "Glob"] }, createdAt: new Date().toISOString() });
    await f.store.withSessionLock(id, "owner", async lease => {
      let m = await lease.reserveWorker(0, generation, reservation, f.options.workerExecutable!, launch);
      if (advance === "starting") m = await lease.beginWorkerStart(m.revision, generation, reservation);
    });
    return id;
  };
  const reserved = await make({}, "reserved");
  await f.runtime.forceStopManaged(reserved, "owner");
  assert.equal((await f.read(reserved)).worker.state, "none");
  assert.equal((await f.runtime.getManagedSession(reserved, "owner"))?.state, "suspended");
  const relaunched = await f.controller().resume(reserved, "owner", { allowStopped: true }); // Pending native: clean, relaunches.
  f.track(await f.read(relaunched.id)); await f.runtime.stop(reserved);

  const noProof = await make({}, "starting");
  await assert.rejects(f.runtime.forceStopManaged(noProof, "owner"));
  const stuck = await f.read(noProof);
  assert.equal(stuck.requiresExplicitResume, true); assert.equal(stuck.worker.state, "starting", "no boot identity and no group: stays fenced");
  assert.equal((await f.runtime.getManagedSession(noProof, "owner"))?.state, "unavailable");
  await assert.rejects(f.runtime.destroy(noProof, "owner"));

  // A rebooted machine proves every earlier process gone, even for a process-less starting record.
  const rebooted = await make({ bootIdentity: "linux:00000000000000000000000000000000" }, "starting");
  await f.runtime.forceStopManaged(rebooted, "owner");
  assert.equal((await f.read(rebooted)).worker.state, "none");
  await f.runtime.destroy(rebooted, "owner"); assert.equal(await f.store.read(rebooted, "owner"), undefined);
});

test("startManaged failure after manifest creation stops the worker group and removes the record only after proven absence", { timeout: 30_000 }, async t => {
  // This peer adopts nothing and never answers: launch fails with a real, marked, live process group.
  const f = await fixture(t, "worker-launch-peer", { MINU_PRODUCER_PEER: "hang" });
  await assert.rejects(f.runtime.startManaged({ cwd: f.cwd }, "owner"));
  assert.deepEqual(await f.store.list("owner"), [], "record removed once the group was proven gone");
  assert.deepEqual(await f.runtime.listManagedSessions("owner"), []);
});
