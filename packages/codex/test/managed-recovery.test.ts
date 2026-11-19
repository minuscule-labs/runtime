import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { test, type TestContext } from "node:test";
import { processGroupAbsent } from "@minu/runtime-core";
import { CodexAgentRuntime, type CodexAgentRuntimeOptions } from "../src/index.js";
import { CodexManagedStore, type CodexManagedManifest } from "../src/managed-store.js";
import { createPendingCodexSession } from "../src/managed-native.js";
import { recoverCodexWorker } from "../src/worker-recovery.js";

const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; } };
async function until<T>(read: () => Promise<T>, done: (value: T) => boolean) {
  const end = Date.now() + 8_000;
  while (true) { const value = await read(); if (done(value)) return value; if (Date.now() > end) throw new Error("Recovery test timed out"); await delay(10); }
}
const groupOf = (m: CodexManagedManifest) => m.worker.state === "none" ? undefined : m.worker.pgid;

async function fixture(t: TestContext, scenario = "normal") {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "codex-recovery-")));
  const root = join(directory, "managed"), log = join(directory, "native.jsonl"), store = new CodexManagedStore(root);
  const options: CodexAgentRuntimeOptions = { managedRoot: root, command: process.execPath,
    args: [fileURLToPath(new URL("./fixtures/app-server.js", import.meta.url)), scenario, log], requestTimeoutMs: 2_000, shutdownTimeoutMs: 100 };
  const runtime = new CodexAgentRuntime(options), groups = new Set<number>();
  // Teardown: no test may leave a live worker/native group, whatever happened.
  t.after(async () => {
    for (const m of await store.list("owner").catch(() => [])) { const g = groupOf(m); if (g) groups.add(g); }
    for (const g of groups) { try { process.kill(-g, "SIGKILL"); } catch { /* Gone. */ } }
    for (const g of groups) await until(async () => processGroupAbsent(g), state => state === "absent");
    await rm(directory, { recursive: true, force: true });
  });
  const manifestPath = (id: string) => join(root, createHash("sha256").update("owner").digest("hex"), `${id}.session`, "manifest.json");
  return { directory, root, store, options, runtime, log, groups, manifestPath,
    track: (m: CodexManagedManifest) => { const g = groupOf(m); if (g) groups.add(g); return m; },
    read: async (id: string) => (await store.read(id, "owner"))!,
    calls: async () => { try { return (await readFile(log, "utf8")).trim().split("\n").filter(Boolean).map(l => JSON.parse(l)); } catch { return []; } },
    nativePids: async () => [...new Set((await (async () => { try { return (await readFile(log, "utf8")).trim().split("\n").filter(Boolean).map(l => JSON.parse(l)); } catch { return []; } })())
      .map((c: { pid?: number }) => c.pid).filter((p: number | undefined): p is number => typeof p === "number"))],
    state: async (id: string) => (await runtime.listManagedSessions("owner")).find(s => s.id === id)?.state };
}
/** A pid that definitely exited, together with its (now empty) own group. */
async function deadGroup(): Promise<number> {
  const child = spawn(process.execPath, ["-e", ""], { detached: true, stdio: "ignore" });
  const pid = child.pid!; await new Promise(resolve => child.once("exit", resolve));
  await until(async () => processGroupAbsent(pid), state => state === "absent"); return pid;
}

test("workers are forked in their own verified group with identity markers and a boot identity", { timeout: 20_000 }, async t => {
  const f = await fixture(t), session = await f.runtime.startManaged({ cwd: f.directory }, "owner");
  const m = f.track(await f.read(session.id));
  assert.equal(m.worker.state, "ready"); if (m.worker.state !== "ready") return;
  assert.equal(m.worker.pgid, m.worker.connection.pid); assert.equal(m.worker.marked, true);
  if (process.platform === "darwin" || process.platform === "linux") assert.match(m.worker.bootIdentity ?? "", /^(darwin|linux):[0-9a-f-]{32,36}$/);
  assert.equal(processGroupAbsent(m.worker.pgid!), "present");
  await f.runtime.forceStopManaged(session.id, "owner");
});

test("forceStopManaged recovers a BUSY session: fence, native gone, suspended, idempotent; destroy then removes metadata only", { timeout: 30_000 }, async t => {
  const f = await fixture(t, "held"), session = await f.runtime.startManaged({ cwd: f.directory }, "owner");
  await f.runtime.startTurn(session.id, "busy", "hello");
  await until(f.calls, calls => calls.some(c => c.method === "turn/start"));
  const busy = f.track(await f.read(session.id)), group = groupOf(busy)!, natives = await f.nativePids();
  assert.ok(natives.length > 0 && natives.every(alive)); assert.equal(await f.runtime.status(session.id), "working");
  await assert.rejects(f.runtime.forceStopManaged(session.id, "other-owner"));
  await f.runtime.forceStopManaged(session.id, "owner");
  const stopped = await f.read(session.id);
  assert.equal(stopped.worker.state, "none"); assert.equal(stopped.requiresExplicitResume, true);
  assert.notEqual(stopped.generation, busy.generation); assert.deepEqual(stopped.native, busy.native);
  assert.equal(processGroupAbsent(group), "absent"); for (const pid of natives) assert.equal(alive(pid), false);
  assert.equal(await f.state(session.id), "suspended"); assert.equal(await f.runtime.status(session.id), "offline");
  await f.runtime.forceStopManaged(session.id, "owner"); assert.deepEqual(await f.read(session.id), stopped, "second call is a no-op");
  // A bound thread has no verified resume epoch: resume refuses and stays fenced/suspended.
  await assert.rejects(new CodexAgentRuntime(f.options).resume(session.id, "owner", { allowStopped: true }));
  assert.deepEqual(await f.read(session.id), stopped);
  const history = await readFile(f.log, "utf8");
  await f.runtime.destroy(session.id, "owner");
  assert.equal(await f.store.read(session.id, "owner"), undefined); assert.equal(await readFile(f.log, "utf8"), history);
});

test("an externally SIGKILLed worker group is cleared through group-absence proof", { timeout: 30_000 }, async t => {
  const f = await fixture(t), session = await f.runtime.startManaged({ cwd: f.directory }, "owner");
  await f.runtime.send(session.id, "first");
  const before = f.track(await f.read(session.id)), group = groupOf(before)!, natives = await f.nativePids();
  process.kill(-group, "SIGKILL"); await until(async () => processGroupAbsent(group), state => state === "absent");
  assert.equal(await f.state(session.id), "unavailable");
  await f.runtime.forceStopManaged(session.id, "owner");
  const stopped = await f.read(session.id);
  assert.equal(stopped.worker.state, "none"); assert.equal(stopped.requiresExplicitResume, true); assert.deepEqual(stopped.native, before.native);
  for (const pid of natives) assert.equal(alive(pid), false);
  assert.equal(await f.state(session.id), "suspended");
  await f.runtime.destroy(session.id, "owner"); assert.equal(await f.store.read(session.id, "owner"), undefined);
});

test("an unresponsive marked worker falls through to verified termination; an unmarked one is never signalled", { timeout: 40_000 }, async t => {
  const f = await fixture(t), session = await f.runtime.startManaged({ cwd: f.directory }, "owner");
  const before = f.track(await f.read(session.id)); if (before.worker.state !== "ready") return;
  const group = before.worker.pgid!, pid = before.worker.connection.pid;
  process.kill(pid, "SIGSTOP"); // Can neither answer the stop request nor handle TERM.
  const record = JSON.parse(await readFile(f.manifestPath(session.id), "utf8"));
  const marked = JSON.stringify(record); delete record.worker.marked;
  await writeFile(f.manifestPath(session.id), JSON.stringify(record) + "\n", { mode: 0o600 });
  const quick = { requestMs: 100, graceMs: 200, termMs: 200, killMs: 3_000 };
  await assert.rejects(recoverCodexWorker(f.store, session.id, "owner", { timeouts: quick }));
  assert.equal(processGroupAbsent(group), "present", "no signal may reach an unmarked worker");
  const fenced = await f.read(session.id); assert.equal(fenced.requiresExplicitResume, true); assert.equal(fenced.worker.state, "ready");
  await assert.rejects(f.runtime.destroy(session.id, "owner")); assert.equal((await f.read(session.id)).worker.state, "ready");
  await writeFile(f.manifestPath(session.id), marked + "\n", { mode: 0o600 });
  await recoverCodexWorker(f.store, session.id, "owner", { timeouts: quick });
  assert.equal(processGroupAbsent(group), "absent"); assert.equal((await f.read(session.id)).worker.state, "none");
});

test("reserved and aborted slots clear only on proof; a legacy pid without a group does not; resume then relaunches", { timeout: 40_000 }, async t => {
  const f = await fixture(t);
  const make = async (launch: { bootIdentity?: string } | undefined, pid?: number, pgid?: number, abort = false) => {
    const pending = await createPendingCodexSession(f.store, { id: `slot-${randomUUID()}`, ownerId: "owner", generation: randomUUID() }, { cwd: f.directory });
    const claim = `claim-${randomUUID()}`;
    await f.store.withSessionLock(pending.id, "owner", async lease => {
      let m = await lease.reserveWorker((await f.store.read(pending.id, "owner"))!.revision, claim, launch);
      if (pid !== undefined) m = await lease.recordWorkerPid(m.revision, claim, pid, pgid);
      if (abort) await lease.abortWorkerStartup(m.revision, claim, pid!);
    });
    return pending.id;
  };
  // aborted + recorded own group that is gone: cleared by group absence.
  const dead = await deadGroup(), aborted = await make({}, dead, dead, true);
  assert.equal((await f.read(aborted)).worker.state, "aborted");
  await f.runtime.forceStopManaged(aborted, "owner");
  const cleared = await f.read(aborted); assert.equal(cleared.worker.state, "none"); assert.equal(cleared.requiresExplicitResume, true);
  assert.equal(await f.state(aborted), "suspended");
  const relaunched = await f.runtime.resume(aborted, "owner", { allowStopped: true });
  f.track(await f.read(relaunched.id)); assert.equal((await f.read(aborted)).worker.state, "ready");
  assert.equal(await f.runtime.status(aborted), "idle"); await f.runtime.destroy(aborted, "owner");
  // reserved, no pid, no boot proof: stays fenced. With a different boot identity it clears.
  const stuck = await make({}); await assert.rejects(f.runtime.forceStopManaged(stuck, "owner"));
  assert.equal((await f.read(stuck)).worker.state, "reserved"); assert.equal((await f.read(stuck)).requiresExplicitResume, true);
  await assert.rejects(f.runtime.destroy(stuck, "owner"));
  const rebooted = await make({ bootIdentity: "linux:00000000000000000000000000000000" });
  await f.runtime.forceStopManaged(rebooted, "owner"); assert.equal((await f.read(rebooted)).worker.state, "none");
  await f.runtime.destroy(rebooted, "owner"); assert.equal(await f.store.read(rebooted, "owner"), undefined);
  // legacy: a recorded pid with no group is never proven by a bare-PID probe.
  const legacy = await make(undefined, dead, undefined, true);
  await assert.rejects(f.runtime.forceStopManaged(legacy, "owner")); assert.equal((await f.read(legacy)).worker.state, "aborted");
});

test("destroy removes a live healthy session through the recovery path and leaves no process group", { timeout: 30_000 }, async t => {
  const f = await fixture(t), session = await f.runtime.startManaged({ cwd: f.directory }, "owner");
  await f.runtime.send(session.id, "x"); const live = f.track(await f.read(session.id)), group = groupOf(live)!;
  await f.runtime.destroy(session.id, "owner");
  assert.equal(await f.store.read(session.id, "owner"), undefined); assert.equal(processGroupAbsent(group), "absent");
  await assert.rejects(f.runtime.destroy(session.id, "owner"), "a session that does not exist for this owner is not destroyable twice");
});
