import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { test, type TestContext } from "node:test";
import { ClaudeCodeManagedRuntime, type ClaudeCodeManagedRuntimeOptions } from "../src/managed-runtime.js";
import { ClaudeCodeManagedStore } from "../src/managed-store.js";
import { claudeCodeNativeProjectKey } from "../src/native-history.js";
import { ClaudeCodeWorkerClient } from "../src/worker-client.js";
import { nativeHistoryProvider } from "./fixtures/native-history-provider.js";
import { suspendClaudeCodeWorker } from "../src/worker-lifecycle.js";

async function until<T>(read: () => Promise<T>, done: (value: T) => boolean) {
  const end = performance.now() + 8_000;
  while (true) { const value = await read(); if (done(value)) return value; if (performance.now() > end) throw Error("Managed test timed out"); await delay(10); }
}
async function fixture(t: TestContext, extraEnv: Record<string, string> = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "claude-managed-api-")));
  const cwd = join(root, "workspace"), native = join(root, "native"), state = join(root, "managed");
  await mkdir(cwd, { mode: 0o700 }); await mkdir(native, { mode: 0o700 });
  const options: ClaudeCodeManagedRuntimeOptions = { ownerId: "owner", storeRoot: state, nativeConfigRoot: native, timeoutMs: 4_000,
    workerExecutable: fileURLToPath(new URL("./fixtures/worker-entry.js", import.meta.url)),
    nativeOptions: { executable: fileURLToPath(new URL("./fixtures/persistent-native.js", import.meta.url)),
      startupTimeoutMs: 2_000, shutdownTimeoutMs: 1_000, controlTimeoutMs: 1_000,
      env: { HOME: root, PATH: process.env.PATH!, TMPDIR: root, CLAUDE_CONFIG_DIR: native,
        ANTHROPIC_API_KEY: "PRIVATE_MANAGED_DUMMY", MINU_CLAUDE_FIXTURE_PID: join(root, "native-pid"), ...extraEnv } } };
  const instances: ClaudeCodeManagedRuntime[] = []; let preserve = false;
  const controller = () => { const runtime = new ClaudeCodeManagedRuntime(options); instances.push(runtime); return runtime; };
  const store = new ClaudeCodeManagedStore(state), runtime = controller();
  t.after(async () => {
    const children = instances.flatMap(instance => [...(instance as unknown as { ownedChildren: Map<string, ChildProcess> }).ownedChildren.values()]);
    for (const child of children) {
      if (child.exitCode === null && child.stdin?.writable) child.stdin.end("dispose-owned-fixture\n");
      await until(async () => child.exitCode, code => code !== null); assert.equal(child.exitCode, 0);
    }
    if (preserve) t.diagnostic(`Private native integration artifacts: ${root}`);
    else await rm(root, { recursive: true, force: true });
  });
  return { root, cwd, native, state, runtime, controller, store, options, preserve: () => { preserve = true; },
    read: (id: string) => store.read(id, "owner"),
    history: (id: string) => join(native, "projects", claudeCodeNativeProjectKey(cwd), id + ".jsonl") };
}

test("durable managed path: text/streams, living reconnect, clean stop and exact-history resume without replay", async t => {
  const f = await fixture(t), session = await f.runtime.startManaged({ cwd: f.cwd }, "owner");
  const initial = (await f.read(session.id))!; assert.equal(initial.native.state, "pending");
  await assert.rejects(readFile(join(f.root, "native-pid")), { code: "ENOENT" });
  const abort = new AbortController(), iterator = f.runtime.events(session.id, abort.signal)[Symbol.asyncIterator]();
  assert.equal((await iterator.next()).value?.type, "status");
  const events: unknown[] = []; const pumping = (async () => { for await (const event of { [Symbol.asyncIterator]: () => iterator }) events.push(event); })();
  await f.runtime.send(session.id, "first literal input");
  await f.runtime.startTurn(session.id, "stable-turn", "second literal input");
  const turn = await until(() => f.runtime.turn(session.id, "stable-turn"), value => value?.status === "completed");
  assert.equal(turn?.response?.content, "reply: second literal input");
  const beforeRetry = await f.read(session.id);
  const restartedApp = f.controller();
  assert.equal((await restartedApp.resume(session.id, "owner")).id, session.id);
  assert.deepEqual(await restartedApp.startTurn(session.id, "stable-turn", "second literal input"), turn);
  assert.deepEqual(await f.read(session.id), beforeRetry);
  await assert.rejects(restartedApp.startTurn(session.id, "stable-turn", "different"));
  assert.equal((await restartedApp.getManagedSession(session.id, "owner"))?.state, "active");
  const safe = JSON.stringify(await restartedApp.listManagedSessions("owner"));
  assert.doesNotMatch(safe, /PRIVATE_|native|token|fingerprint|workspace|literal input/);
  abort.abort(); await pumping; await iterator.return?.(); assert.ok(events.length > 0);
  const bound = (await f.read(session.id))!; assert.equal(bound.native.state, "bound"); if (bound.native.state !== "bound") return;
  const transcript = await readFile(f.history(bound.native.sessionId));
  await restartedApp.suspend(session.id, "owner");
  const stopped = (await f.read(session.id))!;
  assert.equal(stopped.worker.state, "none"); assert.equal(stopped.requiresExplicitResume, true);
  assert.notEqual(stopped.generation, bound.generation); assert.deepEqual(stopped.native, bound.native); assert.deepEqual(stopped.lastDispatch, bound.lastDispatch);
  assert.deepEqual(await readFile(f.history(bound.native.sessionId)), transcript);
  assert.equal((await f.runtime.getManagedSession(session.id, "owner"))?.state, "suspended");
  assert.equal(await f.runtime.status(session.id), "offline");
  assert.equal((await f.runtime.messages(session.id)).filter(m => m.role === "assistant").length, 2);
  const freshApp = f.controller();
  await assert.rejects(freshApp.resume(session.id, "owner")); assert.deepEqual(await f.read(session.id), stopped);
  assert.equal((await freshApp.resume(session.id, "owner", { allowStopped: true })).id, session.id);
  assert.deepEqual((await f.read(session.id))!.native, bound.native);
  assert.deepEqual(await readFile(f.history(bound.native.sessionId)), transcript, "resume must not inject input");
  assert.equal(await freshApp.turn(session.id, "stable-turn"), undefined, "history is not a durable caller-result ledger");
  await assert.rejects(freshApp.startTurn(session.id, "stable-turn", "second literal input"));
  await freshApp.send(session.id, "after explicit resume"); await freshApp.stop(session.id);
  assert.deepEqual((await f.read(session.id))!.native, bound.native);
});

test("first input permits healthy lazy native initialization beyond short status deadlines", async t => {
  const f = await fixture(t, { MINU_PERSIST_INIT_DELAY_MS: "2_300" });
  f.options.nativeOptions.startupTimeoutMs = 4_000;
  const runtime = f.controller(), session = await runtime.start({ cwd: f.cwd });
  await runtime.send(session.id, "delayed healthy startup");
  assert.equal(await runtime.status(session.id), "idle"); await runtime.stop(session.id);
});

test("busy/interrupted latest dispatch cannot be cleared; a subsequent confirmed clean turn makes normal stop eligible", async t => {
  const f = await fixture(t), session = await f.runtime.start({ cwd: f.cwd });
  await f.runtime.startTurn(session.id, "busy", "hold"); const busy = await f.read(session.id);
  await assert.rejects(f.runtime.stop(session.id)); assert.deepEqual(await f.read(session.id), busy);
  assert.equal(await f.runtime.status(session.id), "working"); await f.runtime.interrupt(session.id);
  await until(() => f.runtime.turn(session.id, "busy"), value => value?.status === "interrupted");
  const interrupted = await f.read(session.id); await assert.rejects(f.runtime.stop(session.id)); assert.deepEqual(await f.read(session.id), interrupted);
  await f.runtime.send(session.id, "clean completion"); await f.runtime.stop(session.id);
  assert.equal((await f.read(session.id))!.worker.state, "none");
});

test("committed native success with missing final materialization never grants clear/resume or replacement", async t => {
  const f = await fixture(t, { MINU_PERSIST_DROP_FINAL: "1" }), session = await f.runtime.start({ cwd: f.cwd });
  await f.runtime.send(session.id, "not fully persisted"); const before = (await f.read(session.id))!;
  assert.equal(before.lastDispatch.state, "settled"); await assert.rejects(f.runtime.stop(session.id));
  assert.deepEqual(await f.read(session.id), before);
  assert.equal((await f.runtime.getManagedSession(session.id, "owner"))?.state, "unavailable");
  await assert.rejects(f.controller().resume(session.id, "owner", { allowStopped: true }));
  assert.deepEqual(await f.read(session.id), before);
});

for (const action of ["stop", "resume"]) test(`hidden uncompleted input plus snapshot cannot grant ${action} or mutate its checkpoint`, async t => {
  const f = await fixture(t), session = await f.runtime.start({ cwd: f.cwd });
  await f.runtime.send(session.id, "completed input");
  if (action === "resume") await f.runtime.stop(session.id);
  const before = (await f.read(session.id))!; assert.equal(before.native.state, "bound");
  if (before.native.state !== "bound") return;
  const path = f.history(before.native.sessionId), rows = (await readFile(path, "utf8")).trimEnd().split("\n").map(line => JSON.parse(line));
  const parent = rows.filter(row => ["user", "assistant", "attachment"].includes(row.type)).at(-1);
  const hidden = { ...parent, type: "user", uuid: randomUUID(), parentUuid: parent.uuid, isMeta: true,
    message: { role: "user", content: "PRIVATE_UNCOMPLETED_TAIL" } };
  const snapshot: Record<string, any> = { ...hidden, type: "attachment", uuid: randomUUID(), parentUuid: hidden.uuid, attachment: { type: "prompt_snapshot" } };
  delete snapshot.message;
  rows.push(hidden, snapshot, { type: "last-prompt", sessionId: before.native.sessionId, leafUuid: snapshot.uuid });
  await writeFile(path, rows.map(row => JSON.stringify(row)).join("\n") + "\n");
  const bytes = await readFile(path), next = f.controller();
  await assert.rejects(action === "stop" ? f.runtime.stop(session.id) : next.resume(session.id, "owner", { allowStopped: true }));
  assert.deepEqual(await f.read(session.id), before); assert.deepEqual(await readFile(path), bytes);
  await assert.rejects(next.resume(session.id, "owner", { allowStopped: true })); assert.deepEqual(await f.read(session.id), before);
  assert.equal((next as unknown as { ownedChildren: Map<string, ChildProcess> }).ownedChildren.size, 0, "rejection must not launch replacement");
});

test("late clear confirmation preserves the actual committed checkpoint but cannot report deadline success", async t => {
  const f = await fixture(t), session = await f.runtime.start({ cwd: f.cwd });
  const lock = f.store.withSessionLock.bind(f.store); let clears = 0, committed: Awaited<ReturnType<typeof f.read>>;
  f.store.withSessionLock = (id, owner, operation, timeout) => lock(id, owner, lease => operation({ ...lease,
    clearWorkerAfterExit: async (...args) => {
      clears++; committed = await lease.clearWorkerAfterExit(...args);
      const end = performance.now() + 1_200; while (performance.now() < end) { /* Scoped timer-starvation fault after real commit. */ }
      return committed;
    },
  }), timeout);
  try { await assert.rejects(suspendClaudeCodeWorker(f.store, session.id, "owner", f.options.workerExecutable!, 1_000)); }
  finally { f.store.withSessionLock = lock; }
  assert.equal(clears, 1); assert.ok(committed); assert.equal(committed.worker.state, "none");
  assert.equal(committed.requiresExplicitResume, true); assert.deepEqual(await f.read(session.id), committed);
});

test("generation/human fence after quiesce wins over physical absence; exact changed state is never rebased", async t => {
  const f = await fixture(t), session = await f.runtime.start({ cwd: f.cwd }); await f.runtime.send(session.id, "completed");
  const original = ClaudeCodeWorkerClient.prototype.requestQuiesceIdle; let changed: unknown;
  ClaudeCodeWorkerClient.prototype.requestQuiesceIdle = async function(...args) {
    await original.apply(this, args);
    await f.store.withSessionLock(session.id, "owner", async lease => {
      changed = await lease.update((await f.read(session.id))!.revision, { generation: randomUUID(), requiresExplicitResume: true });
    });
  };
  try { await assert.rejects(f.runtime.stop(session.id)); } finally { ClaudeCodeWorkerClient.prototype.requestQuiesceIdle = original; }
  assert.ok(changed); assert.deepEqual(await f.read(session.id), changed);
  await assert.rejects(f.runtime.resume(session.id, "owner", { allowStopped: true })); assert.deepEqual(await f.read(session.id), changed);
});

test("bundled native managed stop/resume preserves materialized history without replay (two local requests)", { timeout: 45_000 }, async t => {
  const f = await fixture(t), provider = await nativeHistoryProvider(2, true); f.preserve();
  t.after(() => provider.close());
  delete f.options.nativeOptions.executable;
  Object.assign(f.options.nativeOptions.env, { ANTHROPIC_BASE_URL: provider.url, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", NO_PROXY: "127.0.0.1,localhost" });
  Object.assign(f.options.nativeOptions, { startupTimeoutMs: 10_000, controlTimeoutMs: 5_000, shutdownTimeoutMs: 5_000 });
  f.options.timeoutMs = 15_000;
  const runtime = f.controller(), session = await runtime.start({ cwd: f.cwd });
  await runtime.send(session.id, "native before app restart"); assert.equal(provider.calls(), 1);
  assert.doesNotMatch(JSON.stringify(await runtime.messages(session.id)), /PRIVATE_SYNTHETIC_REASONING/);
  await runtime.stop(session.id);
  const stopped = (await f.read(session.id))!; assert.equal(stopped.native.state, "bound"); if (stopped.native.state !== "bound") return;
  const bytes = await readFile(f.history(stopped.native.sessionId));
  const next = f.controller(); await next.resume(session.id, "owner", { allowStopped: true });
  assert.equal(provider.calls(), 1, "initialization must not replay a prior prompt");
  assert.ok(bytes.length > 0);
  assert.deepEqual((await next.messages(session.id)).map(m => [m.role, m.content]), [["user", "native before app restart"], ["assistant", "history reply 1"]]);
  await next.send(session.id, "native after explicit resume"); assert.equal(provider.calls(), 2);
  await next.stop(session.id); assert.deepEqual((await f.read(session.id))!.native, stopped.native);
  assert.deepEqual((await next.messages(session.id)).filter(m => m.role === "assistant").map(m => m.content), ["history reply 1", "history reply 2"]);
});

test("owner/config/input preflight and inventory stay private and do not start or resume anything", async t => {
  const f = await fixture(t);
  assert.throws(() => new ClaudeCodeManagedRuntime({ ...f.options, storeRoot: undefined as any }));
  await assert.rejects(f.runtime.startManaged({ cwd: f.cwd }, "wrong-owner"));
  await assert.rejects(f.runtime.start({ cwd: f.cwd, model: { provider: "x", id: "x" } }));
  const file = join(f.cwd, "file"); await writeFile(file, "fixture"); await assert.rejects(f.runtime.start({ cwd: file }));
  assert.deepEqual(await f.runtime.listManagedSessions("owner"), []);
  assert.equal(await f.runtime.getManagedSession("absent", "owner"), undefined);
  const session = await f.runtime.start({ cwd: f.cwd }), before = await f.read(session.id);
  await assert.rejects(f.runtime.startTurn(session.id, "image", "x", [{ type: "image", mimeType: "image/png", data: "AA==" }] as any));
  await assert.rejects(f.runtime.startTurn(session.id, "invalid-unicode", "\ud800"));
  await assert.rejects(f.runtime.resume(session.id, "wrong-owner")); await assert.rejects(f.runtime.suspend(session.id, "wrong-owner"));
  const abort = new AbortController(); abort.abort(new Error("PRIVATE_CANCEL_REASON"));
  await assert.rejects(f.runtime.listManagedSessions("owner", { signal: abort.signal }), error => !String(error).includes("PRIVATE_"));
  assert.deepEqual(await f.read(session.id), before); await f.runtime.stop(session.id);
  const stopped = await f.read(session.id), otherRoot = join(f.root, "other-native"); await mkdir(otherRoot, { mode: 0o700 });
  const mismatched = new ClaudeCodeManagedRuntime({ ...f.options, nativeConfigRoot: otherRoot, nativeOptions: {
    ...f.options.nativeOptions, env: { ...f.options.nativeOptions.env, CLAUDE_CONFIG_DIR: otherRoot },
  } });
  await assert.rejects(mismatched.resume(session.id, "owner", { allowStopped: true })); assert.deepEqual(await f.read(session.id), stopped);
  for (const patch of [{ startupTimeoutMs: 0 }, { turnRetentionLimit: 1_001 }, { eventBufferLimit: 4_097 }, { executable: join(f.root, "missing-native") }]) {
    const invalid = new ClaudeCodeManagedRuntime({ ...f.options, nativeOptions: { ...f.options.nativeOptions, ...patch } });
    await assert.rejects(invalid.resume(session.id, "owner", { allowStopped: true }));
    assert.deepEqual(await f.read(session.id), stopped, "configuration errors must not clear the explicit-resume fence");
  }
  await f.runtime.resume(session.id, "owner", { allowStopped: true }); await f.runtime.stop(session.id);
});
