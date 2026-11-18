import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { fork } from "node:child_process";
import { once } from "node:events";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { chmod, link, mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { CodexManagedStore, CodexManifestConflictError, type CodexManagedManifest, type CodexManifestLease, type CodexProcessDomain, type CodexRetirementIntent, type CodexNativeQuiesce, type CodexWorkerAbsence, assertCodexWorkerClaim } from "../src/managed-store.js";
import { CodexLifecycleBusyError } from "../src/lifecycle-lock.js";

async function fixture(t: TestContext) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "codex-store-")));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const root = join(directory, "managed");
  const store = new CodexManagedStore(root);
  const manifest: CodexManagedManifest = {
    version: 4, runtime: "codex", id: "runtime-id", ownerId: "owner-a", native: { state: "bound", threadId: "native-thread" }, worker: { state: "none" },
    revision: 0, generation: "generation-a", requiresExplicitResume: false,
    launchConfig: { cwd: directory, appendSystemPrompt: "Reviewer", model: { provider: "openai", id: "model" }, reasoningLevel: "high" },
    sandbox: "read-only", createdAt: new Date().toISOString(),
  };
  const path = join(root, createHash("sha256").update(manifest.ownerId).digest("hex"), `${manifest.id}.session`, "manifest.json");
  return { directory, root, store, manifest, path };
}

function copy<T>(value: T): T { return JSON.parse(JSON.stringify(value)) as T; }

async function domainFixture(t: TestContext, version: 4 | 5 = 5) {
  const f = await fixture(t);
  const connection = { version: 1 as const, ownerId: f.manifest.ownerId, sessionId: f.manifest.id,
    generation: f.manifest.generation, claimId: "claim-a", pid: 4242,
    endpoint: "http://127.0.0.1:42420", token: "a".repeat(64) };
  const observation = { ioPlatformUuid: "11111111-2222-5333-8444-555555555555", bootSessionUuid: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee" };
  const domain: CodexProcessDomain = { connection, launcher: { ...observation }, worker: { ...observation } };
  const manifest: CodexManagedManifest = { ...f.manifest, version,
    worker: { state: "ready", generation: connection.generation, claimId: connection.claimId, connection: { ...connection } } };
  await f.store.create(manifest);
  const record = (revision = 0, value = domain, ownerId = manifest.ownerId) => f.store.withSessionLock(manifest.id, ownerId,
    lease => lease.recordProcessDomain(revision, value));
  return { ...f, manifest, domain, record };
}

function renameHook(t: TestContext, handler: (from: string, to: string, original: typeof import("node:fs/promises").rename) => Promise<void>) {
  const fs = createRequire(import.meta.url)("node:fs/promises") as typeof import("node:fs/promises");
  const original = fs.rename;
  const mock = t.mock.method(fs, "rename", async (from: Parameters<typeof fs.rename>[0], to: Parameters<typeof fs.rename>[1]) => handler(String(from), String(to), original));
  syncBuiltinESMExports();
  t.after(() => { mock.mock.restore(); syncBuiltinESMExports(); });
}

async function retirementFixture(t: TestContext, native: "pending" | "bound" = "bound") {
  const f = await domainFixture(t);
  if (native === "pending") await writeFile(f.path, JSON.stringify({ ...f.manifest, native: { state: "pending" } }));
  const correlated = await f.record();
  const intent: CodexRetirementIntent = { operationId: "suspend-a", native: native === "pending" ? { state: "pending" } : { state: "bound", threadId: "native-thread" } };
  const begin = (revision = correlated.revision, connection = f.domain.connection, value = intent, ownerId = f.manifest.ownerId) =>
    f.store.withSessionLock(f.manifest.id, ownerId, lease => lease.beginRetirementIntent(revision, connection, value));
  return { ...f, correlated, intent, begin };
}

async function factFixture(t: TestContext, native: "pending" | "bound" = "bound") {
  const f = await retirementFixture(t, native);
  const retiring = await f.begin();
  const fact: CodexNativeQuiesce = { kind: native === "pending" ? "never_started" : "owned_exit" };
  const absence: CodexWorkerAbsence = { pid: f.domain.connection.pid, domain: { ...f.domain.launcher }, result: "pid_absent" };
  const recordFact = (revision = retiring.revision, value = fact, connection = f.domain.connection, intent = f.intent, ownerId = f.manifest.ownerId) =>
    f.store.withSessionLock(f.manifest.id, ownerId, lease => lease.recordNativeQuiesce(revision, connection, intent, value));
  const finalize = (revision: number, value = absence, connection = f.domain.connection, intent = f.intent, ownerId = f.manifest.ownerId) =>
    f.store.withSessionLock(f.manifest.id, ownerId, lease => lease.finalizeRetirement(revision, connection, intent, value));
  return { ...f, retiring, fact, absence, recordFact, finalize };
}

async function eligibleFixture(t: TestContext) {
  const f = await retirementFixture(t, "bound");
  const checkpoint = { kind: "history" as const, digest: "a".repeat(64), turns: 1, items: 2 };
  const retired = await f.store.withSessionLock(f.manifest.id, f.manifest.ownerId, async lease => {
    const intent = await lease.beginRetirementIntent(f.correlated.revision, f.domain.connection, f.intent, checkpoint);
    const quiesced = await lease.recordNativeQuiesce(intent.revision, f.domain.connection, f.intent, { kind: "owned_exit" });
    return lease.finalizeRetirement(quiesced.revision, f.domain.connection, f.intent,
      { pid: f.domain.connection.pid, domain: f.domain.launcher, result: "pid_absent" });
  });
  const verify = (revision = retired.revision, value = checkpoint) => f.store.withSessionLock(retired.id, retired.ownerId, lease => lease.verifyHistory(revision, value));
  return { ...f, checkpoint, retired, verify };
}

test("verified history gates an atomic cold-resume epoch retaining the exact predecessor", async t => {
  const f = await eligibleFixture(t);
  await assert.rejects(f.store.withSessionLock(f.retired.id, f.retired.ownerId, lease => lease.beginResume(f.retired.revision, "next-generation")));
  const verified = await f.verify(); assert.deepEqual(await f.verify(verified.revision), verified);
  const resumed = await f.store.withSessionLock(verified.id, verified.ownerId, lease => lease.beginResume(verified.revision, "next-generation"));
  assert.deepEqual(resumed.native, verified.native); assert.equal(resumed.worker.state, "none");
  if (resumed.version !== 5) throw new Error("Expected v5");
  assert.deepEqual(resumed.previous, verified); assert.equal(resumed.history, undefined); assert.equal(resumed.processDomain, undefined);
  assert.equal(resumed.generation, "next-generation");
  await assert.rejects(f.store.withSessionLock(resumed.id, resumed.ownerId, lease => lease.beginResume(resumed.revision, "another-generation")));
  const ready = await f.store.withSessionLock(resumed.id, resumed.ownerId, async lease => {
    const reserved = await lease.reserveWorker(resumed.revision, "new-claim");
    const pid = await lease.recordWorkerPid(reserved.revision, "new-claim", 4243);
    return lease.publishWorkerReady(pid.revision, { ...f.domain.connection, generation: resumed.generation, claimId: "new-claim", pid: 4243 });
  });
  assert.equal(ready.worker.state, "ready"); assert.deepEqual(ready.native, f.retired.native);
  const fenced = await f.store.update(ready.id, ready.ownerId, ready.revision, { requiresExplicitResume: true });
  assert.deepEqual(await f.store.read(ready.id, ready.ownerId), fenced); // Predecessor does not block fences/history.
});

for (const value of [null, true, { kind: "pending" }, { kind: "history", digest: ["a".repeat(64)], turns: 1, items: 2 },
  { kind: "history", digest: "b".repeat(64), turns: 1, items: 2 }, { kind: "history", digest: "a".repeat(64), turns: 1, items: 2, extra: true }]) {
  test(`history eligibility rejects mismatched/malformed checkpoint ${JSON.stringify(value)}`, async t => {
    const f = await eligibleFixture(t); await assert.rejects(f.verify(f.retired.revision, value as typeof f.checkpoint));
    assert.deepEqual(await f.store.read(f.retired.id, f.retired.ownerId), f.retired);
  });
}

for (const point of ["before-rename", "after-rename"] as const) {
  test(`resume epoch ${point} uncertainty preserves inspectable old/new material without retry`, async t => {
    const f = await eligibleFixture(t); const verified = await f.verify(); let writes = 0;
    renameHook(t, async (from, to, original) => { writes++; if (point === "after-rename") await original(from, to); throw new Error("Injected epoch publication uncertainty"); });
    await assert.rejects(f.store.withSessionLock(verified.id, verified.ownerId, lease => lease.beginResume(verified.revision, "new-generation")));
    const current = (await f.store.read(verified.id, verified.ownerId))!; assert.equal(writes, 1);
    if (point === "before-rename") assert.deepEqual(current, verified);
    else { assert.equal(current.worker.state, "none"); assert.deepEqual(current.native, verified.native); assert.ok(current.version === 5 && current.previous); }
  });
}

for (const fault of ["generation", "explicit", "stale", "unsafe-predecessor", "changed-binding"] as const) {
  test(`resume eligibility rejects ${fault} without claim reset`, async t => {
    const f = await eligibleFixture(t); const verified = await f.verify();
    if (fault === "generation" || fault === "explicit") {
      const fenced = await f.store.update(verified.id, verified.ownerId, verified.revision, fault === "generation" ? { generation: "fenced" } : { requiresExplicitResume: true });
      await assert.rejects(f.store.withSessionLock(fenced.id, fenced.ownerId, lease => lease.beginResume(fenced.revision, "new-generation")));
    } else if (fault === "stale") await assert.rejects(f.store.withSessionLock(verified.id, verified.ownerId, lease => lease.beginResume(verified.revision - 1, "new-generation")));
    else {
      const epoch = await f.store.withSessionLock(verified.id, verified.ownerId, lease => lease.beginResume(verified.revision, "new-generation"));
      if (epoch.version !== 5 || !epoch.previous) throw new Error("Expected predecessor");
      if (fault === "changed-binding") epoch.native = { state: "bound", threadId: "other-thread" };
      else { const nested = structuredClone(epoch.previous); epoch.previous = { ...epoch.previous, previous: nested } as CodexManagedManifest; }
      await writeFile(f.path, JSON.stringify(epoch)); await assert.rejects(f.store.read(epoch.id, epoch.ownerId));
    }
  });
}

for (const native of ["pending", "bound"] as const) {
  test(`v5 ${native} native-quiesce and full retirement assertions round-trip with guarded replay`, async t => {
    const f = await factFixture(t, native);
    await assert.rejects(f.finalize(f.retiring.revision), CodexManifestConflictError);
    const recorded = await f.recordFact();
    assert.deepEqual(recorded, { ...f.retiring, revision: 3, worker: { ...f.retiring.worker, nativeQuiesce: f.fact } });
    assert.deepEqual(await f.recordFact(recorded.revision), recorded);
    await assert.rejects(f.recordFact(f.retiring.revision), CodexManifestConflictError);
    const retired = await f.finalize(recorded.revision);
    assert.deepEqual(retired, { ...recorded, revision: 4, worker: { ...recorded.worker, state: "retired", workerAbsence: f.absence } });
    assert.deepEqual(await new CodexManagedStore(f.root).read(retired.id, retired.ownerId), retired);
    assert.deepEqual(await f.store.list(retired.ownerId), [retired]);
    let renames = 0;
    renameHook(t, async (from, to, original) => { renames++; await original(from, to); });
    assert.deepEqual(await f.finalize(retired.revision), retired);
    await assert.rejects(f.finalize(recorded.revision), CodexManifestConflictError);
    await assert.rejects(f.recordFact(retired.revision), CodexManifestConflictError);
    await assert.rejects(f.begin(retired.revision), CodexManifestConflictError);
    assert.equal(renames, 0);
  });
}

for (const fact of [null, true, {}, [], { kind: "unknown" }, { kind: "owned_exit", verified: true }]) {
  test(`native-quiesce assertion strictly rejects ${JSON.stringify(fact)}`, async t => {
    const f = await factFixture(t);
    await assert.rejects(f.recordFact(f.retiring.revision, fact as CodexNativeQuiesce));
    await writeFile(f.path, JSON.stringify({ ...f.retiring, worker: { ...f.retiring.worker, nativeQuiesce: fact } }));
    await assert.rejects(f.store.read(f.retiring.id, f.retiring.ownerId));
  });
}

for (const native of ["pending", "bound"] as const) {
  test(`native-quiesce kind cannot contradict ${native} binding or replace recorded data`, async t => {
    const f = await factFixture(t, native);
    const wrong: CodexNativeQuiesce = { kind: native === "pending" ? "owned_exit" : "never_started" };
    await assert.rejects(f.recordFact(f.retiring.revision, wrong));
    const recorded = await f.recordFact();
    await assert.rejects(f.recordFact(recorded.revision, wrong));
    assert.deepEqual(await f.store.read(recorded.id, recorded.ownerId), recorded);
  });
}

for (const [name, change] of [
  ["null", (_a: any) => null], ["boolean", (_a: any) => true], ["array", (a: any) => [a]],
  ["missing result", (a: any) => { delete a.result; return a; }],
  ["present", (a: any) => ({ ...a, result: "pid_present" })], ["unknown", (a: any) => ({ ...a, result: "unconfirmed" })],
  ["zero", (a: any) => ({ ...a, pid: 0 })], ["negative", (a: any) => ({ ...a, pid: -1 })],
  ["fractional", (a: any) => ({ ...a, pid: 1.5 })], ["string PID", (a: any) => ({ ...a, pid: "4242" })],
  ["out of range", (a: any) => ({ ...a, pid: 0x80000000 })], ["wrong target", (a: any) => ({ ...a, pid: 4243 })],
  ["extra flag", (a: any) => ({ ...a, verified: true })], ["missing domain", (a: any) => { delete a.domain; return a; }],
  ["malformed domain", (a: any) => ({ ...a, domain: { ioPlatformUuid: "PRIVATE", bootSessionUuid: "PRIVATE" } })],
  ["extra domain flag", (a: any) => ({ ...a, domain: { ...a.domain, verified: true } })],
  ["wrong host", (a: any) => ({ ...a, domain: { ...a.domain, ioPlatformUuid: "99999999-8888-4777-8666-555555555555" } })],
  ["wrong boot", (a: any) => ({ ...a, domain: { ...a.domain, bootSessionUuid: "99999999-8888-4777-8666-555555555555" } })],
] as const) {
  test(`finalization and strict retired parsing reject ${name} absence data`, async t => {
    const f = await factFixture(t); const recorded = await f.recordFact();
    const wrong = change(copy(f.absence)) as CodexWorkerAbsence;
    await assert.rejects(f.finalize(recorded.revision, wrong));
    assert.deepEqual(await f.store.read(recorded.id, recorded.ownerId), recorded);
    await writeFile(f.path, JSON.stringify({ ...recorded, worker: { ...recorded.worker, state: "retired", workerAbsence: wrong } }));
    await assert.rejects(f.store.read(recorded.id, recorded.ownerId));
    await assert.rejects(f.store.list(recorded.ownerId));
  });
}

for (const stage of ["native", "final"] as const) {
  test(`${stage} assertions require exact owner/operation/native/full connection before new writes and replay`, async t => {
    const f = await factFixture(t);
    const before = stage === "native" ? f.retiring : await f.recordFact();
    const invoke = (revision: number, connection = f.domain.connection, intent = f.intent, owner = f.manifest.ownerId) => stage === "native"
      ? f.recordFact(revision, f.fact, connection, intent, owner) : f.finalize(revision, f.absence, connection, intent, owner);
    const badConnections = [
      { version: 2 }, { ownerId: "other-owner" }, { sessionId: "other-session" }, { generation: "other-generation" },
      { claimId: "other-claim" }, { pid: 4243 }, { endpoint: "http://127.0.0.1:42421" }, { token: "b".repeat(64) },
    ];
    await assert.rejects(invoke(before.revision, f.domain.connection, f.intent, "other-owner"));
    for (const patch of badConnections) await assert.rejects(invoke(before.revision, { ...f.domain.connection, ...patch } as typeof f.domain.connection));
    await assert.rejects(invoke(before.revision, f.domain.connection, { ...f.intent, operationId: "other-operation" }));
    await assert.rejects(invoke(before.revision, f.domain.connection, { ...f.intent, native: { state: "pending" } }));
    const recorded = await invoke(before.revision);
    await assert.rejects(invoke(before.revision), CodexManifestConflictError);
    for (const patch of badConnections) await assert.rejects(invoke(recorded.revision, { ...f.domain.connection, ...patch } as typeof f.domain.connection));
    await assert.rejects(invoke(recorded.revision, f.domain.connection, { ...f.intent, operationId: "other-operation" }));
    await assert.rejects(invoke(recorded.revision, f.domain.connection, { ...f.intent, native: { state: "bound", threadId: "different-native" } }));
    const bytes = await readFile(f.path, "utf8");
    let renames = 0; renameHook(t, async (from, to, original) => { renames++; await original(from, to); });
    assert.deepEqual(await invoke(recorded.revision), recorded);
    assert.equal(renames, 0); assert.equal(await readFile(f.path, "utf8"), bytes);
  });
}

for (const stage of ["intent", "native", "retired"] as const) {
  for (const fence of ["generation", "explicit"] as const) {
    test(`historical ${stage} facts remain readable but ${fence} fences deny new/cached assertions`, async t => {
      const f = await factFixture(t);
      const recorded = stage === "intent" ? f.retiring : await f.recordFact();
      const before = stage === "retired" ? await f.finalize(recorded.revision) : recorded;
      const fenced = await f.store.update(before.id, before.ownerId, before.revision,
        fence === "generation" ? { generation: "fenced-generation" } : { requiresExplicitResume: true });
      assert.deepEqual(await f.store.read(before.id, before.ownerId), fenced);
      assert.deepEqual(await f.store.list(before.ownerId), [fenced]);
      await assert.rejects(f.recordFact(fenced.revision)); await assert.rejects(f.finalize(fenced.revision));
      assert.deepEqual(await f.store.read(before.id, before.ownerId), fenced);
    });
  }
}

test("fact/finalization require v5 retirement stage and reject missing native assertions", async t => {
  const f = await factFixture(t);
  await assert.rejects(f.finalize(f.retiring.revision), CodexManifestConflictError);
  await writeFile(f.path, JSON.stringify(f.correlated));
  await assert.rejects(f.recordFact(f.correlated.revision)); await assert.rejects(f.finalize(f.correlated.revision));
  const { processDomain: _domain, ...ready } = f.correlated;
  const v4 = { ...ready, version: 4 };
  await writeFile(f.path, JSON.stringify(v4));
  await assert.rejects(f.recordFact(v4.revision)); await assert.rejects(f.finalize(v4.revision));
  assert.deepEqual(await f.store.read(v4.id, v4.ownerId), v4);
  const recorded = { ...f.retiring, worker: { ...f.retiring.worker, nativeQuiesce: f.fact } };
  for (const bad of [
    { ...recorded, version: 4 },
    { ...recorded, version: 4, worker: { ...recorded.worker, state: "retired", workerAbsence: f.absence } },
    { ...recorded, processDomain: undefined },
    { ...recorded, worker: { ...recorded.worker, state: "retired" } },
    { ...recorded, worker: { ...recorded.worker, state: "retired", nativeQuiesce: undefined, workerAbsence: f.absence } },
    { ...recorded, worker: { ...recorded.worker, state: "retired", workerAbsence: f.absence, extraProof: true } },
    { ...recorded, worker: { ...recorded.worker, workerAbsence: f.absence } },
    { ...recorded, native: { state: "creating" } },
  ]) {
    await writeFile(f.path, JSON.stringify(bad)); await assert.rejects(f.store.read(f.retiring.id, f.retiring.ownerId));
  }
});

for (const pid of [1, 0x7fffffff]) {
  test(`retirement accepts exact signed-pid_t boundary ${pid}`, async t => {
    const f = await factFixture(t);
    const connection = { ...f.domain.connection, pid };
    const current = { ...f.retiring, worker: { ...f.retiring.worker, connection }, processDomain: { ...f.domain, connection } };
    await writeFile(f.path, JSON.stringify(current));
    const recorded = await f.recordFact(current.revision, f.fact, connection);
    const retired = await f.finalize(recorded.revision, { ...f.absence, pid }, connection);
    assert.equal(retired.worker.state, "retired");
    assert.deepEqual(await f.store.read(retired.id, retired.ownerId), retired);
  });
}

for (const native of ["pending", "bound"] as const) {
  test(`retired ${native} denies stage regression, native/registration/enrollment/claim/cleanup bypasses`, async t => {
    const f = await factFixture(t, native); const recorded = await f.recordFact(); const retired = await f.finalize(recorded.revision);
    const claim = { claimId: f.domain.connection.claimId!, pid: f.domain.connection.pid };
    for (const state of ["ready", "reserved"] as const) assert.throws(() => assertCodexWorkerClaim(retired, claim, state));
    assert.throws(() => assertCodexWorkerClaim(retired));
    assert.equal(await f.store.claimPreReadyCleanup({ id: retired.id, ownerId: retired.ownerId, generation: retired.generation }, claim), false);
    await f.store.withSessionLock(retired.id, retired.ownerId, async lease => {
      for (const invoke of [
        () => lease.beginNativeCreation(retired.revision), () => lease.bindNativeThread(retired.revision, "different"),
        () => lease.reserveWorker(retired.revision, "different"), () => lease.recordWorkerPid(retired.revision, claim.claimId, claim.pid),
        () => lease.publishWorkerReady(retired.revision, f.domain.connection), () => lease.abortWorkerStartup(retired.revision, claim.claimId, claim.pid),
        () => lease.recordProcessDomain(retired.revision, f.domain), () => lease.beginRetirementIntent(retired.revision, f.domain.connection, f.intent),
        () => lease.recordNativeQuiesce(retired.revision, f.domain.connection, f.intent, f.fact),
      ]) await assert.rejects(invoke());
    });
    assert.deepEqual(await f.store.read(retired.id, retired.ownerId), retired);
  });
}

for (const stage of ["native", "final"] as const) {
  test(`${stage} recording snapshots all expected inputs before awaits`, async t => {
    const f = await factFixture(t); const before = stage === "native" ? f.retiring : await f.recordFact();
    const expectedFact = copy(f.fact), expectedAbsence = copy(f.absence);
    const result = await f.store.withSessionLock(before.id, before.ownerId, async lease => {
      const writing = stage === "native" ? lease.recordNativeQuiesce(before.revision, f.domain.connection, f.intent, f.fact)
        : lease.finalizeRetirement(before.revision, f.domain.connection, f.intent, f.absence);
      f.domain.connection.token = "b".repeat(64); f.intent.operationId = "changed";
      if (f.intent.native.state === "bound") f.intent.native.threadId = "changed-native";
      f.fact.kind = "never_started"; f.absence.pid++; f.absence.domain.bootSessionUuid = "changed";
      return writing;
    });
    assert.ok(result.worker.state === "retiring" || result.worker.state === "retired");
    if (result.worker.state === "retiring" || result.worker.state === "retired") assert.deepEqual(result.worker.nativeQuiesce, expectedFact);
    if (result.worker.state === "retired") assert.deepEqual(result.worker.workerAbsence, expectedAbsence);
  });

  test(`${stage} assertions preserve lease concurrency/lifetime and cross-store CAS`, async t => {
    const f = await factFixture(t); const before = stage === "native" ? f.retiring : await f.recordFact();
    const invoke = (lease: CodexManifestLease) => stage === "native" ? lease.recordNativeQuiesce(before.revision, f.domain.connection, f.intent, f.fact)
      : lease.finalizeRetirement(before.revision, f.domain.connection, f.intent, f.absence);
    let retained!: CodexManifestLease, writing!: Promise<CodexManagedManifest>;
    await f.store.withSessionLock(before.id, before.ownerId, async lease => {
      retained = lease; writing = invoke(lease); await assert.rejects(invoke(lease), /already mutating/);
    });
    await writing; await assert.rejects(invoke(retained), /inactive/);
    const g = await factFixture(t); const current = stage === "native" ? g.retiring : await g.recordFact();
    const call = (store: CodexManagedStore) => store.withSessionLock(current.id, current.ownerId, lease => stage === "native"
      ? lease.recordNativeQuiesce(current.revision, g.domain.connection, g.intent, g.fact)
      : lease.finalizeRetirement(current.revision, g.domain.connection, g.intent, g.absence));
    const results = await Promise.allSettled([call(g.store), call(new CodexManagedStore(g.root))]);
    assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
  });

  for (const point of ["before-rename", "after-rename"] as const) {
    test(`${stage} publication ${point} failure keeps inspectable old/new assertion state without retry`, async t => {
      const f = await factFixture(t); const before = stage === "native" ? f.retiring : await f.recordFact();
      let renames = 0; renameHook(t, async (from, to, original) => { renames++; if (point === "after-rename") await original(from, to); throw new Error("Injected assertion publication failure"); });
      await assert.rejects(stage === "native" ? f.recordFact(before.revision) : f.finalize(before.revision));
      const updated = { ...before, revision: before.revision + 1, worker: stage === "native" ? { ...before.worker, nativeQuiesce: f.fact }
        : { ...before.worker, state: "retired", workerAbsence: f.absence } };
      const expected = point === "before-rename" ? before : updated;
      assert.deepEqual(await new CodexManagedStore(f.root).read(before.id, before.ownerId), expected);
      assert.deepEqual(await f.store.list(before.ownerId), [expected]); assert.equal(renames, 1);
    });
  }

  test(`${stage} assertion preserves the unchanged byte budget`, async t => {
    const f = await factFixture(t); const before = stage === "native" ? f.retiring : await f.recordFact();
    const large = { ...before, launchConfig: { ...before.launchConfig, appendSystemPrompt: "" } };
    large.launchConfig.appendSystemPrompt = "x".repeat(65536 - Buffer.byteLength(JSON.stringify(large) + "\n"));
    await writeFile(f.path, JSON.stringify(large) + "\n");
    await assert.rejects(stage === "native" ? f.recordFact(before.revision) : f.finalize(before.revision), /too large/);
    assert.deepEqual(await f.store.read(before.id, before.ownerId), large);
  });
}

for (const fault of ["public", "symlink", "hardlink", "corrupt", "oversized"] as const) {
  test(`retired assertions retain ${fault} private-file safeguards`, async t => {
    const f = await factFixture(t); const recorded = await f.recordFact(); const retired = await f.finalize(recorded.revision);
    if (fault === "public") await chmod(f.path, 0o644);
    else if (fault === "symlink") { const target = join(f.directory, "fact-target"); await writeFile(target, await readFile(f.path), { mode: 0o600 }); await rm(f.path); await symlink(target, f.path); }
    else if (fault === "hardlink") await link(f.path, join(f.directory, "fact-alias"));
    else await writeFile(f.path, fault === "corrupt" ? "{broken" : "x".repeat(65537));
    await assert.rejects(f.store.read(retired.id, retired.ownerId)); await assert.rejects(f.finalize(retired.revision));
  });
}

for (const native of ["pending", "bound"] as const) {
  test(`v5 ${native} retirement intent round-trips without changing other material`, async t => {
    const f = await retirementFixture(t, native);
    const retiring = await f.begin();
    assert.deepEqual(retiring, { ...f.correlated, revision: 2, worker: { ...f.correlated.worker, state: "retiring", retirement: f.intent } });
    assert.deepEqual(await new CodexManagedStore(f.root).read(retiring.id, retiring.ownerId), retiring);
    assert.deepEqual(await f.store.list(retiring.ownerId), [retiring]);
    let renames = 0;
    renameHook(t, async (from, to, original) => { renames++; await original(from, to); });
    assert.deepEqual(await f.begin(retiring.revision), retiring);
    assert.equal(renames, 0);
    await assert.rejects(f.begin(f.correlated.revision), CodexManifestConflictError);
    await assert.rejects(f.begin(retiring.revision, f.domain.connection, { ...f.intent, operationId: "different-operation" }), CodexManifestConflictError);
    assert.equal(renames, 0);
  });
}

for (const [field, replacement] of [
  ["version", 2], ["ownerId", "owner-b"], ["sessionId", "other-session"], ["generation", "generation-b"],
  ["claimId", "other-claim"], ["pid", 4243], ["endpoint", "http://127.0.0.1:42421"], ["token", "b".repeat(64)],
] as const) {
  test(`retirement intent rejects wrong expected connection ${field} before recording or replay`, async t => {
    const f = await retirementFixture(t);
    const wrong = { ...f.domain.connection, [field]: replacement } as typeof f.domain.connection;
    await assert.rejects(f.begin(f.correlated.revision, wrong));
    assert.deepEqual(await f.store.read(f.manifest.id, f.manifest.ownerId), f.correlated);
    const retiring = await f.begin();
    await assert.rejects(f.begin(retiring.revision, wrong));
    assert.deepEqual(await f.store.read(retiring.id, retiring.ownerId), retiring);
  });
}

for (const [name, intent] of [
  ["null", null], ["array", []], ["missing operation", { native: { state: "pending" } }],
  ["empty operation", { operationId: "", native: { state: "pending" } }],
  ["invalid operation", { operationId: "../operation", native: { state: "pending" } }],
  ["oversized operation", { operationId: "x".repeat(129), native: { state: "pending" } }],
  ["non-string operation", { operationId: 1, native: { state: "pending" } }],
  ["missing snapshot", { operationId: "suspend-a" }], ["null snapshot", { operationId: "suspend-a", native: null }],
  ["creating snapshot", { operationId: "suspend-a", native: { state: "creating" } }],
  ["extra pending data", { operationId: "suspend-a", native: { state: "pending", threadId: "hidden" } }],
  ["invalid thread", { operationId: "suspend-a", native: { state: "bound", threadId: "../thread" } }],
  ["extra bound data", { operationId: "suspend-a", native: { state: "bound", threadId: "native-thread", confirmed: true } }],
  ["unsupported native fact", { operationId: "suspend-a", native: { state: "pending" }, nativeQuiesce: true }],
] as const) {
  test(`strict retirement intent rejects ${name} in the mutator and stored format`, async t => {
    const f = await retirementFixture(t);
    await assert.rejects(f.begin(f.correlated.revision, f.domain.connection, intent as unknown as CodexRetirementIntent));
    const bad = { ...f.correlated, worker: { ...f.correlated.worker, state: "retiring", retirement: intent } };
    await writeFile(f.path, JSON.stringify(bad));
    await assert.rejects(f.store.read(f.manifest.id, f.manifest.ownerId));
    await assert.rejects(f.store.list(f.manifest.ownerId));
  });
}

test("retirement refuses mismatched native snapshots and creating material without publication", async t => {
  const f = await retirementFixture(t);
  for (const native of [{ state: "pending" } as const, { state: "bound", threadId: "other-thread" } as const]) {
    await assert.rejects(f.begin(f.correlated.revision, f.domain.connection, { ...f.intent, native }), CodexManifestConflictError);
    assert.deepEqual(await f.store.read(f.manifest.id, f.manifest.ownerId), f.correlated);
  }
  await writeFile(f.path, JSON.stringify({ ...f.correlated, native: { state: "creating" } }));
  await assert.rejects(f.begin(), CodexManifestConflictError);
});

for (const state of ["none", "reserved", "aborted"] as const) {
  test(`retirement rejects non-ready ${state} material without changing it`, async t => {
    const f = await retirementFixture(t, "pending");
    const { processDomain: _domain, ...base } = f.correlated;
    const worker = state === "none" ? { state } : { state, claimId: "claim-a", generation: base.generation, pid: 4242 };
    const material = { ...base, worker };
    await writeFile(f.path, JSON.stringify(material));
    await assert.rejects(f.begin(), CodexManifestConflictError);
    assert.deepEqual(await f.store.read(base.id, base.ownerId), material);
  });
}

test("retirement rejects v4, missing correlation, other owners and unsupported stored states/facts", async t => {
  const f = await domainFixture(t, 4);
  const intent: CodexRetirementIntent = { operationId: "suspend-a", native: { state: "bound", threadId: "native-thread" } };
  await assert.rejects(f.store.withSessionLock(f.manifest.id, f.manifest.ownerId, lease => lease.beginRetirementIntent(0, f.domain.connection, intent)), CodexManifestConflictError);
  const g = await retirementFixture(t);
  await assert.rejects(g.begin(g.correlated.revision, g.domain.connection, g.intent, "owner-b"), CodexManifestConflictError);
  const retiring = await g.begin();
  for (const malformed of [
    { ...retiring, version: 4 },
    { ...retiring, processDomain: null },
    { ...retiring, worker: { ...retiring.worker, state: "retired" } },
    { ...retiring, worker: { ...retiring.worker, workerExited: true } },
    { ...retiring, native: { state: "bound", threadId: "changed-thread" } },
    { ...retiring, processDomain: { ...g.domain, connection: { ...g.domain.connection, token: "b".repeat(64) } } },
  ]) {
    await writeFile(g.path, JSON.stringify(malformed));
    await assert.rejects(g.store.read(retiring.id, retiring.ownerId));
  }
  const { processDomain: _domain, ...uncorrelated } = g.correlated;
  await writeFile(g.path, JSON.stringify(uncorrelated));
  await assert.rejects(g.begin(), CodexManifestConflictError);
  await writeFile(g.path, JSON.stringify({ ...retiring, processDomain: undefined }));
  await assert.rejects(g.store.read(retiring.id, retiring.ownerId));
});

for (const admitted of [false, true]) {
  for (const fence of ["generation", "explicit"] as const) {
    test(`retirement ${admitted ? "replay" : "admission"} rejects ${fence} fencing while retaining readable history`, async t => {
      const f = await retirementFixture(t);
      const before = admitted ? await f.begin() : f.correlated;
      const fenced = await f.store.update(before.id, before.ownerId, before.revision,
        fence === "generation" ? { generation: "generation-b" } : { requiresExplicitResume: true });
      assert.deepEqual(await f.store.read(before.id, before.ownerId), fenced);
      assert.deepEqual(await f.store.list(before.ownerId), [fenced]);
      await assert.rejects(f.begin(fenced.revision), CodexManifestConflictError);
      assert.deepEqual(await f.store.read(before.id, before.ownerId), fenced);
    });
  }
}

for (const native of ["pending", "bound"] as const) {
  test(`retiring ${native} rejects ordinary authorization and all native/registration/enrollment bypasses`, async t => {
    const f = await retirementFixture(t, native);
    const retiring = await f.begin();
    const claim = { claimId: f.domain.connection.claimId!, pid: f.domain.connection.pid };
    for (const state of ["ready", "reserved"] as const) assert.throws(() => assertCodexWorkerClaim(retiring, claim, state), CodexManifestConflictError);
    assert.throws(() => assertCodexWorkerClaim(retiring), CodexManifestConflictError);
    assert.equal(await f.store.claimPreReadyCleanup({ id: retiring.id, ownerId: retiring.ownerId, generation: retiring.generation }, claim), false);
    await f.store.withSessionLock(retiring.id, retiring.ownerId, async lease => {
      for (const mutate of [
        () => lease.beginNativeCreation(retiring.revision),
        () => lease.bindNativeThread(retiring.revision, "other-native"),
        () => lease.reserveWorker(retiring.revision, "new-claim"),
        () => lease.recordWorkerPid(retiring.revision, claim.claimId, claim.pid),
        () => lease.publishWorkerReady(retiring.revision, f.domain.connection),
        () => lease.abortWorkerStartup(retiring.revision, claim.claimId, claim.pid),
        () => lease.recordProcessDomain(retiring.revision, f.domain),
        () => lease.update(retiring.revision, { worker: { state: "none" } } as any),
      ]) await assert.rejects(mutate());
    });
    assert.deepEqual(await f.store.read(retiring.id, retiring.ownerId), retiring);
  });
}

test("retirement snapshots connection, operation and native binding before awaits", async t => {
  const f = await retirementFixture(t);
  const expected = copy(f.intent);
  const result = await f.store.withSessionLock(f.manifest.id, f.manifest.ownerId, async lease => {
    const pending = lease.beginRetirementIntent(f.correlated.revision, f.domain.connection, f.intent);
    f.domain.connection.token = "b".repeat(64); f.intent.operationId = "changed"; f.intent.native = { state: "pending" };
    return pending;
  });
  assert.ok(result.worker.state === "retiring");
  if (result.worker.state === "retiring") assert.deepEqual(result.worker.retirement, expected);
  assert.equal(result.worker.state === "retiring" && result.worker.connection.token, "a".repeat(64));
});

test("retirement CAS contention and lease lifetime/concurrency preserve one intent", async t => {
  const f = await retirementFixture(t);
  let retained!: CodexManifestLease;
  let pending!: Promise<CodexManagedManifest>;
  await f.store.withSessionLock(f.manifest.id, f.manifest.ownerId, async lease => {
    retained = lease;
    pending = lease.beginRetirementIntent(f.correlated.revision, f.domain.connection, f.intent);
    await assert.rejects(lease.beginRetirementIntent(f.correlated.revision, f.domain.connection, f.intent), /already mutating/);
  });
  const retiring = await pending;
  await assert.rejects(retained.beginRetirementIntent(retiring.revision, f.domain.connection, f.intent), /inactive/);
  const g = await retirementFixture(t);
  const other = new CodexManagedStore(g.root);
  const results = await Promise.allSettled([g.begin(), other.withSessionLock(g.manifest.id, g.manifest.ownerId,
    lease => lease.beginRetirementIntent(g.correlated.revision, g.domain.connection, { ...g.intent, operationId: "competing" }))]);
  assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
  assert.equal(results.filter(result => result.status === "rejected" && result.reason instanceof CodexManifestConflictError).length, 1);
});

for (const point of ["before-rename", "after-rename"] as const) {
  test(`retirement intent publication failure ${point} leaves complete inspectable state without retry`, async t => {
    const f = await retirementFixture(t);
    let renames = 0;
    renameHook(t, async (from, to, original) => { renames++; if (point === "after-rename") await original(from, to); throw new Error("Injected intent publication failure"); });
    await assert.rejects(f.begin());
    const expected = point === "before-rename" ? f.correlated
      : { ...f.correlated, revision: f.correlated.revision + 1, worker: { ...f.correlated.worker, state: "retiring", retirement: f.intent } };
    const restarted = new CodexManagedStore(f.root);
    assert.deepEqual(await restarted.read(expected.id, expected.ownerId), expected);
    assert.deepEqual(await restarted.list(expected.ownerId), [expected]);
    assert.equal(renames, 1);
  });
}

for (const fault of ["public", "symlink", "hardlink", "corrupt", "oversized"] as const) {
  test(`retirement intent preserves ${fault} private-file protection`, async t => {
    const f = await retirementFixture(t); await f.begin();
    if (fault === "public") await chmod(f.path, 0o644);
    else if (fault === "symlink") { const target = join(f.directory, "intent-target"); await writeFile(target, await readFile(f.path), { mode: 0o600 }); await rm(f.path); await symlink(target, f.path); }
    else if (fault === "hardlink") await link(f.path, join(f.directory, "intent-alias"));
    else await writeFile(f.path, fault === "corrupt" ? "{broken" : "x".repeat(65537));
    await assert.rejects(f.store.read(f.manifest.id, f.manifest.ownerId));
    await assert.rejects(f.begin(2));
  });
}

test("retirement intent cannot exceed the unchanged manifest byte budget", async t => {
  const f = await retirementFixture(t);
  const large = { ...f.correlated, launchConfig: { ...f.correlated.launchConfig, appendSystemPrompt: "" } };
  large.launchConfig.appendSystemPrompt = "x".repeat(65536 - Buffer.byteLength(JSON.stringify(large) + "\n"));
  await writeFile(f.path, JSON.stringify(large) + "\n");
  await assert.rejects(f.begin(), /too large/);
  assert.deepEqual(await f.store.read(large.id, large.ownerId), large);
});

test("v5 domain correlation round-trips privately without changing native binding or launch policy", async t => {
  const f = await domainFixture(t);
  assert.deepEqual(await f.store.read(f.manifest.id, f.manifest.ownerId), f.manifest);
  const recorded = await f.record();
  assert.deepEqual(recorded, { ...f.manifest, revision: 1, processDomain: f.domain });
  const restarted = new CodexManagedStore(f.root);
  assert.deepEqual(await restarted.read(f.manifest.id, f.manifest.ownerId), recorded);
  assert.deepEqual(await restarted.list(f.manifest.ownerId), [recorded]);
  assert.equal((await stat(f.path)).mode & 0o777, 0o600);
  assert.equal((await stat(f.path)).nlink, 1);
});

test("v4 remains v4 and refuses enrollment and raw correlation fields without implicit migration", async t => {
  const f = await domainFixture(t, 4);
  await assert.rejects(f.record(), CodexManifestConflictError);
  assert.deepEqual(await f.store.read(f.manifest.id, f.manifest.ownerId), f.manifest);
  await writeFile(f.path, JSON.stringify({ ...f.manifest, processDomain: f.domain }));
  await assert.rejects(f.store.read(f.manifest.id, f.manifest.ownerId));
  await assert.rejects(f.store.list(f.manifest.ownerId));
});

test("v5 accepts an already-correlated complete record through strict create/read", async t => {
  const f = await domainFixture(t);
  await rm(join(f.path, ".."), { recursive: true });
  const manifest = { ...f.manifest, version: 5 as const, processDomain: f.domain };
  await f.store.create(manifest);
  assert.deepEqual(await f.store.read(manifest.id, manifest.ownerId), manifest);
});

for (const version of [3, 6, "5"]) {
  test(`unsupported manifest version ${JSON.stringify(version)} is not v5`, async t => {
    const f = await domainFixture(t);
    await writeFile(f.path, JSON.stringify({ ...f.manifest, version }));
    await assert.rejects(f.store.read(f.manifest.id, f.manifest.ownerId));
  });
}

for (const [field, replacement] of [
  ["version", 2], ["ownerId", "owner-b"], ["sessionId", "other-session"], ["generation", "generation-b"],
  ["claimId", "other-claim"], ["pid", 4243], ["endpoint", "http://127.0.0.1:42421"], ["token", "b".repeat(64)],
] as const) {
  test(`domain recording rejects wrong connection ${field} without publication`, async t => {
    const f = await domainFixture(t); const domain = copy(f.domain);
    Object.assign(domain.connection, { [field]: replacement });
    await assert.rejects(f.record(0, domain));
    assert.deepEqual(await f.store.read(f.manifest.id, f.manifest.ownerId), f.manifest);
  });
}

for (const part of ["launcher", "worker"] as const) {
  for (const field of ["ioPlatformUuid", "bootSessionUuid"] as const) {
    test(`domain recording rejects mismatched ${part}.${field}`, async t => {
      const f = await domainFixture(t); const domain = copy(f.domain);
      domain[part][field] = "99999999-8888-4777-8666-555555555555";
      await assert.rejects(f.record(0, domain));
      assert.deepEqual(await f.store.read(f.manifest.id, f.manifest.ownerId), f.manifest);
    });
  }
}

for (const [name, change] of [
  ["null record", (d: any) => null], ["array record", (d: any) => [d]],
  ["extra root flag", (d: any) => ({ ...d, verified: true })],
  ["missing worker", (d: any) => { delete d.worker; return d; }],
  ["null observation", (d: any) => { d.launcher = null; return d; }],
  ["array observation", (d: any) => { d.worker = [d.launcher]; return d; }],
  ["extra observation field", (d: any) => { d.launcher.verified = true; return d; }],
  ["missing UUID", (d: any) => { delete d.worker.ioPlatformUuid; return d; }],
  ["non-string UUID", (d: any) => { d.worker.ioPlatformUuid = 1; return d; }],
  ["malformed UUID", (d: any) => { d.worker.bootSessionUuid = "PRIVATE"; return d; }],
  ["non-normalized UUID", (d: any) => { d.worker.bootSessionUuid = d.worker.bootSessionUuid.toUpperCase(); return d; }],
  ["nil UUID", (d: any) => { d.worker.bootSessionUuid = "00000000-0000-0000-0000-000000000000"; return d; }],
  ["placeholder UUID", (d: any) => { d.worker.bootSessionUuid = "ffffffff-ffff-ffff-ffff-ffffffffffff"; return d; }],
  ["extra connection field", (d: any) => { d.connection.privateExtra = true; return d; }],
] as const) {
  test(`strict v5 parsing and mutation reject ${name}`, async t => {
    const f = await domainFixture(t);
    const bad = change(copy(f.domain)) as CodexProcessDomain;
    await assert.rejects(f.record(0, bad));
    assert.deepEqual(await f.store.read(f.manifest.id, f.manifest.ownerId), f.manifest);
    await writeFile(f.path, JSON.stringify({ ...f.manifest, processDomain: bad }));
    await assert.rejects(f.store.read(f.manifest.id, f.manifest.ownerId));
    await assert.rejects(f.store.list(f.manifest.ownerId));
  });
}

for (const state of ["none", "reserved", "aborted"] as const) {
  test(`process-domain evidence requires a ready registration, not ${state}`, async t => {
    const f = await domainFixture(t);
    const worker = state === "none" ? { state } : { state, claimId: "claim-a", generation: f.manifest.generation, pid: 4242 };
    const material = { ...f.manifest, native: { state: "pending" }, worker };
    await writeFile(f.path, JSON.stringify(material));
    await assert.rejects(f.record(), CodexManifestConflictError);
    assert.deepEqual(await f.store.read(f.manifest.id, f.manifest.ownerId), material);
    await writeFile(f.path, JSON.stringify({ ...material, processDomain: f.domain }));
    await assert.rejects(f.store.read(f.manifest.id, f.manifest.ownerId));
  });
}

test("current revision is required even for identical replay, which performs no publication", async t => {
  const f = await domainFixture(t);
  const recorded = await f.record();
  const bytes = await readFile(f.path, "utf8");
  let renames = 0;
  renameHook(t, async (from, to, original) => { renames++; await original(from, to); });
  await assert.rejects(f.record(0), CodexManifestConflictError);
  for (const revision of [-1, 0.5, NaN, Number.MAX_SAFE_INTEGER]) await assert.rejects(f.record(revision));
  assert.deepEqual(await f.record(recorded.revision), recorded);
  assert.equal(renames, 0); assert.equal(await readFile(f.path, "utf8"), bytes);
  const reordered = { worker: { ...f.domain.worker }, launcher: { ...f.domain.launcher }, connection: { ...f.domain.connection } };
  assert.deepEqual(await f.record(recorded.revision, reordered), recorded);
  assert.equal(renames, 0);
});

test("correlation is immutable even when conflicting replacement observations match each other", async t => {
  const f = await domainFixture(t);
  const recorded = await f.record();
  const changed = copy(f.domain);
  changed.launcher.ioPlatformUuid = changed.worker.ioPlatformUuid = "99999999-8888-4777-8666-555555555555";
  await assert.rejects(f.record(recorded.revision, changed), CodexManifestConflictError);
  assert.deepEqual(await f.store.read(f.manifest.id, f.manifest.ownerId), recorded);
});

for (const recorded of [false, true]) {
  for (const fence of ["generation", "explicit"] as const) {
    test(`fenced v5 history stays readable/listable and denies ${recorded ? "replay" : "new recording"}: ${fence}`, async t => {
      const f = await domainFixture(t);
      const before = recorded ? await f.record() : f.manifest;
      const fenced = await f.store.update(before.id, before.ownerId, before.revision,
        fence === "generation" ? { generation: "generation-b" } : { requiresExplicitResume: true });
      assert.deepEqual(fenced.processDomain, recorded ? f.domain : undefined);
      assert.deepEqual(await new CodexManagedStore(f.root).read(before.id, before.ownerId), fenced);
      assert.deepEqual(await f.store.list(before.ownerId), [fenced]);
      await assert.rejects(f.record(fenced.revision), CodexManifestConflictError);
      assert.deepEqual(await f.store.read(before.id, before.ownerId), fenced);
    });
  }
}

test("wrong addressed owner and stale ready generation cannot record or mutate v5 data", async t => {
  const f = await domainFixture(t);
  await assert.rejects(f.record(0, f.domain, "owner-b"), CodexManifestConflictError);
  assert.deepEqual(await f.store.read(f.manifest.id, f.manifest.ownerId), f.manifest);
  assert.equal(await f.store.read(f.manifest.id, "owner-b"), undefined);
  const fenced = await f.store.update(f.manifest.id, f.manifest.ownerId, 0, { generation: "generation-b" });
  await assert.rejects(f.record(fenced.revision), CodexManifestConflictError);
});

test("domain lease snapshots every nested caller field before asynchronous reads", async t => {
  const f = await domainFixture(t);
  const expected = copy(f.domain);
  const result = await f.store.withSessionLock(f.manifest.id, f.manifest.ownerId, async lease => {
    const recording = lease.recordProcessDomain(0, f.domain);
    f.domain.connection.token = "b".repeat(64); f.domain.connection.pid++;
    f.domain.launcher.ioPlatformUuid = "changed"; f.domain.worker.bootSessionUuid = "changed";
    return recording;
  });
  assert.deepEqual(result.processDomain, expected);
  expected.connection.token = "c".repeat(64); // Returned/supplied objects are not the persisted object.
  assert.notDeepEqual((await f.store.read(f.manifest.id, f.manifest.ownerId))?.processDomain, expected);
});

test("domain mutation respects lease concurrency, lifetime and unawaited-operation settlement", async t => {
  const f = await domainFixture(t);
  let retained!: CodexManifestLease;
  let pending!: Promise<CodexManagedManifest>;
  await f.store.withSessionLock(f.manifest.id, f.manifest.ownerId, async lease => {
    retained = lease;
    pending = lease.recordProcessDomain(0, f.domain);
    await assert.rejects(lease.recordProcessDomain(0, f.domain), /already mutating/);
    // Deliberately do not await pending: lock ownership must extend through it.
  });
  assert.equal((await pending).revision, 1);
  await assert.rejects(retained.recordProcessDomain(1, f.domain), /inactive/);
  assert.deepEqual((await f.store.read(f.manifest.id, f.manifest.ownerId))?.processDomain, f.domain);
});

test("competing domain CAS across store instances acknowledges one revision writer", async t => {
  const f = await domainFixture(t);
  const other = new CodexManagedStore(f.root);
  const results = await Promise.allSettled([f.record(), other.withSessionLock(f.manifest.id, f.manifest.ownerId,
    lease => lease.recordProcessDomain(0, copy(f.domain)))]);
  assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
  assert.equal(results.filter(result => result.status === "rejected" && result.reason instanceof CodexManifestConflictError).length, 1);
  assert.equal((await f.store.read(f.manifest.id, f.manifest.ownerId))?.revision, 1);
});

for (const point of ["before-rename", "after-rename"] as const) {
  test(`domain publication failure ${point} preserves inspectable old/new state without retry`, async t => {
    const f = await domainFixture(t);
    let renames = 0;
    renameHook(t, async (from, to, original) => {
      renames++;
      if (point === "after-rename") await original(from, to);
      throw new Error("Injected publication failure");
    });
    await assert.rejects(f.record());
    assert.equal(renames, 1);
    const expected = point === "after-rename" ? { ...f.manifest, revision: 1, processDomain: f.domain } : f.manifest;
    const restarted = new CodexManagedStore(f.root);
    assert.deepEqual(await restarted.read(f.manifest.id, f.manifest.ownerId), expected);
    assert.deepEqual(await restarted.list(f.manifest.ownerId), [expected]);
    assert.equal(renames, 1, "Inspection must not retry the mutation");
    assert.equal((await stat(f.path)).nlink, 1);
    assert.equal((await stat(f.path)).mode & 0o777, 0o600);
  });
}

for (const fault of ["public", "symlink", "hardlink", "corrupt", "oversized"] as const) {
  test(`v5 correlation cannot bypass ${fault} saved-file safeguards`, async t => {
    const f = await domainFixture(t); await f.record();
    if (fault === "public") await chmod(f.path, 0o644);
    else if (fault === "symlink") { const target = join(f.directory, "target"); await writeFile(target, await readFile(f.path), { mode: 0o600 }); await rm(f.path); await symlink(target, f.path); }
    else if (fault === "hardlink") await link(f.path, join(f.directory, "alias"));
    else await writeFile(f.path, fault === "corrupt" ? "{broken" : "x".repeat(65537));
    await assert.rejects(f.store.read(f.manifest.id, f.manifest.ownerId));
    await assert.rejects(f.store.list(f.manifest.ownerId));
    await assert.rejects(f.record(1));
  });
}

test("correlation addition retains the manifest byte budget without changing old data on overflow", async t => {
  const f = await domainFixture(t);
  const large = { ...f.manifest, launchConfig: { ...f.manifest.launchConfig, appendSystemPrompt: "" } };
  const padding = 65536 - Buffer.byteLength(JSON.stringify(large) + "\n");
  large.launchConfig.appendSystemPrompt = "x".repeat(padding);
  await writeFile(f.path, JSON.stringify(large) + "\n");
  assert.deepEqual(await f.store.read(large.id, large.ownerId), large);
  await assert.rejects(f.record(), /too large/);
  assert.deepEqual(await f.store.read(large.id, large.ownerId), large);
});

test("persists private Codex resume material across store instances without native transcript files", async t => {
  const f = await fixture(t);
  await f.store.create(f.manifest);
  const restarted = new CodexManagedStore(f.root);
  assert.deepEqual(await restarted.read(f.manifest.id, f.manifest.ownerId), f.manifest);
  assert.deepEqual(await restarted.list(f.manifest.ownerId), [f.manifest]);
  assert.equal((await stat(f.root)).mode & 0o777, 0o700);
  assert.equal((await stat(f.path)).mode & 0o777, 0o600);
  assert.equal((await stat(f.path)).nlink, 1);
});

test("exact owner isolation and traversal rejection", async t => {
  const f = await fixture(t);
  await f.store.create(f.manifest);
  assert.equal(await f.store.read(f.manifest.id, "owner-b"), undefined);
  assert.deepEqual(await f.store.list("owner-b"), []);
  for (const invalid of ["../owner-a", "", "a/b", "a\\b", ".", "x".repeat(129)]) {
    await assert.rejects(f.store.read(invalid, "owner-a"));
    await assert.rejects(f.store.list(invalid));
  }
});

test("concurrent creates cannot overwrite an identity", async t => {
  const f = await fixture(t);
  const results = await Promise.allSettled([
    f.store.create(f.manifest), f.store.create({ ...f.manifest, native: { state: "bound", threadId: "other-thread" } }),
  ]);
  assert.equal(results.filter(r => r.status === "fulfilled").length, 1);
  const saved = await readFile(f.path, "utf8");
  await assert.rejects(f.store.create(f.manifest));
  assert.equal(await readFile(f.path, "utf8"), saved);
});

for (const point of ["before-rename", "after-rename"]) {
  test(`readers and restart tolerate writer SIGKILL ${point}`, { timeout: 10_000 }, async t => {
    const f = await fixture(t);
    const child = fork(new URL("./fixtures/store-crash.js", import.meta.url),
      [f.root, JSON.stringify(f.manifest), point], { stdio: ["ignore", "ignore", "pipe", "ipc"] });
    t.after(() => { child.kill("SIGKILL"); });
    const exited = once(child, "exit");
    await Promise.race([
      once(child, "message"),
      exited.then(() => { throw new Error("Writer exited before publication pause"); }),
    ]);
    const expected = point === "after-rename" ? f.manifest : undefined;
    // Read while the writer is stopped exactly at the publication boundary.
    for (let i = 0; i < 10; i++) {
      assert.deepEqual(await f.store.read(f.manifest.id, f.manifest.ownerId), expected);
      assert.deepEqual(await f.store.list(f.manifest.ownerId), expected ? [expected] : []);
    }
    child.kill("SIGKILL");
    await exited;
    const restarted = new CodexManagedStore(f.root);
    assert.deepEqual(await restarted.read(f.manifest.id, f.manifest.ownerId), expected);
    if (expected) await assert.rejects(restarted.create(f.manifest));
    else await restarted.create(f.manifest);
    assert.deepEqual(await restarted.list(f.manifest.ownerId), [f.manifest]);
    assert.equal((await stat(f.path)).nlink, 1);
  });
}

test("concurrent readers see only complete single-link published manifests", async t => {
  const f = await fixture(t);
  let finished = false;
  const writing = (async () => {
    try {
      for (let i = 0; i < 20; i++) await f.store.create({ ...f.manifest, id: `session-${i}` });
    } finally { finished = true; }
  })();
  const reading = (async () => {
    do {
      for (const manifest of await f.store.list(f.manifest.ownerId)) {
        assert.deepEqual(manifest, { ...f.manifest, id: manifest.id });
        assert.deepEqual(await f.store.read(manifest.id, f.manifest.ownerId), manifest);
      }
    } while (!finished);
  })();
  await Promise.all([writing, reading]);
  assert.equal((await f.store.list(f.manifest.ownerId)).length, 20);
});

test("snapshots launch policy before asynchronous writes", async t => {
  const f = await fixture(t);
  const pending = f.store.create(f.manifest);
  f.manifest.launchConfig.appendSystemPrompt = "changed";
  await pending;
  assert.equal((await f.store.read(f.manifest.id, f.manifest.ownerId))?.launchConfig.appendSystemPrompt, "Reviewer");
});

test("rejects unsupported or malformed saved launch policies", async t => {
  const f = await fixture(t);
  const variants = [
    { runtime: "pi" }, { version: 1 }, { version: 2 }, { native: { state: "bound", threadId: "../thread" } },
    { native: null }, { native: { state: "bound" } }, { native: { state: "pending", threadId: "hidden" } },
    { native: { state: "creating", threadId: "hidden" } }, { native: { state: "unknown" } },
    { threadId: "legacy-identity" }, { sandbox: "danger-full-access" },
    { revision: -1 }, { revision: 0.5 }, { generation: "../generation" }, { requiresExplicitResume: "yes" },
    { createdAt: "invalid" }, { launchConfig: { cwd: "relative" } },
    { launchConfig: { cwd: f.directory, skillIds: ["invalid"] } },
    { launchConfig: { cwd: f.directory, reasoningLevel: "unsupported" } },
    { launchConfig: { cwd: f.directory, systemPrompt: "one", appendSystemPrompt: "two" } },
    { launchConfig: { cwd: f.directory, approvalPolicy: "always" } },
    { launchConfig: { cwd: f.directory, model: { provider: "", id: "model" } } },
    { launchConfig: { cwd: f.directory, systemPrompt: "x".repeat(65536) } },
  ];
  for (const variant of variants) {
    await assert.rejects(f.store.create({ ...f.manifest, ...variant } as CodexManagedManifest));
  }
  assert.deepEqual(await f.store.list(f.manifest.ownerId), []);
});

test("rejects symlinked or non-private storage without changing permissions", async t => {
  const f = await fixture(t);
  await mkdir(f.root, { mode: 0o755 });
  await assert.rejects(f.store.create(f.manifest), /private/);
  assert.equal((await stat(f.root)).mode & 0o777, 0o755);
  await rm(f.root, { recursive: true });
  await symlink(f.directory, f.root);
  await assert.rejects(f.store.create(f.manifest), /private/);
});

test("rejects redirected ancestors", async t => {
  const f = await fixture(t);
  const alias = join(f.directory, "alias");
  await symlink(f.directory, alias);
  const redirected = new CodexManagedStore(join(alias, "managed"));
  await assert.rejects(redirected.create(f.manifest), /redirected/);
});

test("rejects symlink, hardlink, oversized, public, and corrupt manifests", async t => {
  const f = await fixture(t);
  await f.store.create(f.manifest);
  const original = await readFile(f.path, "utf8");
  const target = join(f.directory, "target");
  await writeFile(target, original, { mode: 0o600 });
  await rm(f.path);
  await symlink(target, f.path);
  await assert.rejects(f.store.read(f.manifest.id, f.manifest.ownerId));
  await rm(f.path);
  await link(target, f.path);
  await assert.rejects(f.store.read(f.manifest.id, f.manifest.ownerId));
  await rm(f.path);
  await writeFile(f.path, "x".repeat(65537), { mode: 0o600 });
  await assert.rejects(f.store.read(f.manifest.id, f.manifest.ownerId));
  await writeFile(f.path, original);
  await chmod(f.path, 0o644);
  await assert.rejects(f.store.read(f.manifest.id, f.manifest.ownerId));
  await chmod(f.path, 0o600);
  await writeFile(f.path, "{broken");
  await assert.rejects(f.store.list(f.manifest.ownerId));
  assert.equal(await readFile(f.path, "utf8"), "{broken");
});

test("rejects a valid manifest stored under another owner or identity", async t => {
  const f = await fixture(t);
  await f.store.create(f.manifest);
  await writeFile(f.path, JSON.stringify({ ...f.manifest, ownerId: "owner-b" }));
  await assert.rejects(f.store.read(f.manifest.id, f.manifest.ownerId), /ownership/);
});

test("revision-checked updates preserve immutable launch material and reject stale writes", async t => {
  const f = await fixture(t);
  await f.store.create(f.manifest);
  const next = await f.store.update(f.manifest.id, f.manifest.ownerId, 0, { generation: "generation-b", requiresExplicitResume: true });
  assert.deepEqual(next, { ...f.manifest, revision: 1, generation: "generation-b", requiresExplicitResume: true });
  await assert.rejects(f.store.update(f.manifest.id, f.manifest.ownerId, 0, { generation: "stale" }), CodexManifestConflictError);
  await assert.rejects(f.store.update(f.manifest.id, "owner-b", 1, { generation: "foreign" }), CodexManifestConflictError);
  for (const patch of [{}, { generation: "../bad" }, { revision: 10 }, { launchConfig: {} }, { requiresExplicitResume: "yes" }]) {
    await assert.rejects(f.store.update(f.manifest.id, f.manifest.ownerId, 1, patch as any));
  }
  assert.deepEqual(await f.store.read(f.manifest.id, f.manifest.ownerId), next);
});

test("updates cannot overflow the persisted manifest bound or revision counter", async t => {
  const f = await fixture(t);
  const empty = { ...f.manifest, launchConfig: { cwd: f.directory, systemPrompt: "" } };
  empty.launchConfig.systemPrompt = "x".repeat(65536 - Buffer.byteLength(`${JSON.stringify(empty)}\n`));
  await f.store.create(empty);
  await assert.rejects(f.store.update(empty.id, empty.ownerId, 0, { generation: "g".repeat(128) }), /too large/);
  assert.deepEqual(await f.store.read(empty.id, empty.ownerId), empty);
  const exhausted = { ...f.manifest, id: "exhausted", revision: Number.MAX_SAFE_INTEGER - 1 };
  await f.store.create(exhausted);
  await assert.rejects(f.store.update(exhausted.id, exhausted.ownerId, exhausted.revision, { generation: "new" }));
  assert.deepEqual(await f.store.read(exhausted.id, exhausted.ownerId), exhausted);
});

test("native creation requires locked pending intent, binds once and preserves exact identity", async t => {
  const f = await fixture(t);
  await f.store.create({ ...f.manifest, native: { state: "pending" } });
  let retained!: CodexManifestLease;
  await f.store.withSessionLock(f.manifest.id, f.manifest.ownerId, async lease => {
    retained = lease;
    await assert.rejects(lease.bindNativeThread(0, "native-thread"), CodexManifestConflictError);
    const creating = await lease.beginNativeCreation(0);
    assert.deepEqual(creating.native, { state: "creating" });
    assert.equal(creating.revision, 1);
    await assert.rejects(lease.beginNativeCreation(1), CodexManifestConflictError);
    await assert.rejects(lease.bindNativeThread(0, "native-thread"), CodexManifestConflictError);
    await assert.rejects(lease.bindNativeThread(1, "../invalid"));
    assert.deepEqual(await f.store.read(f.manifest.id, f.manifest.ownerId), creating);
    const bound = await lease.bindNativeThread(1, "native-thread");
    assert.deepEqual(bound, { ...f.manifest, revision: 2 });
    await assert.rejects(lease.bindNativeThread(2, "replacement-thread"), CodexManifestConflictError);
    await assert.rejects(lease.beginNativeCreation(2), CodexManifestConflictError);
  });
  await assert.rejects(retained.beginNativeCreation(2), /inactive/);
  await assert.rejects(retained.bindNativeThread(2, "escaped-thread"), /inactive/);
  await assert.rejects(f.store.update(f.manifest.id, f.manifest.ownerId, 2, { native: { state: "pending" } } as any));
  assert.deepEqual((await f.store.read(f.manifest.id, f.manifest.ownerId))?.native, f.manifest.native);
});

test("native allocation refuses stopped-session fences without changing the saved intent", async t => {
  const f = await fixture(t);
  const pending = { ...f.manifest, native: { state: "pending" } as const, requiresExplicitResume: true };
  await f.store.create(pending);
  await f.store.withSessionLock(pending.id, pending.ownerId, async lease => {
    await assert.rejects(lease.beginNativeCreation(0), CodexManifestConflictError);
  });
  assert.deepEqual(await f.store.read(pending.id, pending.ownerId), pending);
});

test("same-owner locks contend across store instances, other owners remain independent, and throws release", async t => {
  const f = await fixture(t);
  let release!: () => void;
  let entered!: () => void;
  const enteredPromise = new Promise<void>(resolve => { entered = resolve; });
  const held = f.store.withSessionLock(f.manifest.id, f.manifest.ownerId, async () => {
    entered();
    await new Promise<void>(resolve => { release = resolve; });
  });
  await enteredPromise;
  try {
    const other = new CodexManagedStore(f.root);
    await assert.rejects(other.withSessionLock(f.manifest.id, f.manifest.ownerId, async () => { assert.fail("Must not enter"); }, 50), CodexLifecycleBusyError);
    await other.withSessionLock(f.manifest.id, "owner-b", async () => {});
  } finally { release(); await held; }
  await assert.rejects(f.store.withSessionLock(f.manifest.id, f.manifest.ownerId, async () => { throw new Error("callback failed"); }), /callback failed/);
  await f.store.withSessionLock(f.manifest.id, f.manifest.ownerId, async () => {});
});

test("lease rejects concurrent mutations and use after release", async t => {
  const f = await fixture(t);
  await f.store.create(f.manifest);
  let retained!: CodexManifestLease;
  await f.store.withSessionLock(f.manifest.id, f.manifest.ownerId, async lease => {
    retained = lease;
    const first = lease.update(0, { generation: "generation-b" });
    await assert.rejects(lease.update(0, { generation: "competing" }), /already mutating/);
    await first;
    await lease.update(1, { requiresExplicitResume: true });
  });
  await assert.rejects(retained.update(2, { generation: "escaped" }), /inactive/);
  assert.equal((await f.store.read(f.manifest.id, f.manifest.ownerId))?.revision, 2);
});

test("mutation started by a callback settles before its lock is released", async t => {
  const f = await fixture(t);
  await f.store.create(f.manifest);
  let pending!: Promise<CodexManagedManifest>;
  await f.store.withSessionLock(f.manifest.id, f.manifest.ownerId, async lease => {
    pending = lease.update(0, { generation: "generation-b" });
  });
  assert.equal((await pending).revision, 1);
  assert.equal((await f.store.read(f.manifest.id, f.manifest.ownerId))?.revision, 1);
});

test("SIGKILL releases another process's lifecycle lock without stale-lock deletion", { timeout: 10_000 }, async t => {
  const f = await fixture(t);
  const child = fork(new URL("./fixtures/store-lock.js", import.meta.url), [f.root, f.manifest.id, f.manifest.ownerId, "hold"],
    { stdio: ["ignore", "ignore", "ignore", "ipc"] });
  t.after(() => { child.kill("SIGKILL"); });
  const exited = once(child, "exit");
  const [message] = await once(child, "message");
  assert.equal(message.type, "held");
  await assert.rejects(f.store.withSessionLock(f.manifest.id, f.manifest.ownerId, async () => {}, 50), CodexLifecycleBusyError);
  const acquired = f.store.withSessionLock(f.manifest.id, f.manifest.ownerId, async () => "acquired");
  child.kill("SIGKILL");
  await exited;
  assert.equal(await acquired, "acquired");
});

test("cross-process compare-and-swap admits only one writer for a revision", { timeout: 10_000 }, async t => {
  const f = await fixture(t);
  await f.store.create(f.manifest);
  const run = async () => {
    const child = fork(new URL("./fixtures/store-lock.js", import.meta.url), [f.root, f.manifest.id, f.manifest.ownerId, "update", "0"],
      { stdio: ["ignore", "ignore", "ignore", "ipc"] });
    t.after(() => { child.kill("SIGKILL"); });
    const exited = once(child, "exit");
    const [message] = await once(child, "message");
    await exited;
    return message;
  };
  const results = await Promise.all([run(), run()]);
  assert.deepEqual(results.map(r => r.type).sort(), ["failed", "updated"]);
  assert.equal(results.find(r => r.type === "failed").name, "CodexManifestConflictError");
  assert.equal((await f.store.read(f.manifest.id, f.manifest.ownerId))?.revision, 1);
});

for (const point of ["before-rename", "after-rename"]) {
  test(`manifest update survives SIGKILL ${point}`, { timeout: 10_000 }, async t => {
    const f = await fixture(t);
    await f.store.create(f.manifest);
    const child = fork(new URL("./fixtures/store-crash.js", import.meta.url), [f.root, JSON.stringify(f.manifest), point, "update"],
      { stdio: ["ignore", "ignore", "ignore", "ipc"] });
    t.after(() => { child.kill("SIGKILL"); });
    const exited = once(child, "exit");
    await once(child, "message");
    const expectedRevision = point === "after-rename" ? 1 : 0;
    assert.equal((await f.store.read(f.manifest.id, f.manifest.ownerId))?.revision, expectedRevision);
    child.kill("SIGKILL");
    await exited;
    const restarted = new CodexManagedStore(f.root);
    assert.equal((await restarted.read(f.manifest.id, f.manifest.ownerId))?.revision, expectedRevision);
    const next = await restarted.update(f.manifest.id, f.manifest.ownerId, expectedRevision, { requiresExplicitResume: true });
    assert.equal(next.revision, expectedRevision + 1);
  });
}

for (const version of [4, 5] as const) {
  test(`metadata destruction v${version} keeps native data and the existing lock domain`, async t => {
    const f = await fixture(t);
    await f.store.create({ ...f.manifest, version, native: { state: "pending" } });
    const owner = join(f.root, createHash("sha256").update(f.manifest.ownerId).digest("hex"));
    const native = join(f.directory, "native-history.json"); await writeFile(native, "untouched native history");
    await f.store.withSessionLock(f.manifest.id, f.manifest.ownerId, async () => {});
    const lock = join(owner, `.lifecycle-${f.manifest.id}.sqlite`), before = await stat(lock);
    await f.store.withSessionLock(f.manifest.id, f.manifest.ownerId, lease => lease.removeResumeMetadata(0));
    assert.equal(await f.store.read(f.manifest.id, f.manifest.ownerId), undefined);
    assert.deepEqual(await f.store.list(f.manifest.ownerId), []);
    assert.equal(await readFile(native, "utf8"), "untouched native history");
    assert.equal((await stat(lock)).ino, before.ino);
    await assert.rejects(f.store.update(f.manifest.id, f.manifest.ownerId, 0, { requiresExplicitResume: true }));
  });
}

test("metadata destruction rejects unconfirmed, fenced, stale, wrong-owner and non-metadata material", async t => {
  const f = await fixture(t);
  await f.store.create({ ...f.manifest, id: "bound-other" });
  await assert.rejects(f.store.withSessionLock("bound-other", f.manifest.ownerId, lease => lease.removeResumeMetadata(0)));
  await f.store.create({ ...f.manifest, native: { state: "pending" } });
  const remove = (revision: number, owner = f.manifest.ownerId) => f.store.withSessionLock(f.manifest.id, owner, lease => lease.removeResumeMetadata(revision));
  await assert.rejects(remove(0, "other-owner"));
  const pending = await f.store.update(f.manifest.id, f.manifest.ownerId, 0, { requiresExplicitResume: true });
  await assert.rejects(remove(pending.revision));
  const unfenced = await f.store.update(f.manifest.id, f.manifest.ownerId, pending.revision, { requiresExplicitResume: false });
  await assert.rejects(remove(pending.revision));
  const directory = join(f.root, createHash("sha256").update(f.manifest.ownerId).digest("hex"), `${f.manifest.id}.session`);
  const native = join(directory, "native-history.json"); await writeFile(native, "never remove unknown data");
  await assert.rejects(remove(unfenced.revision), /non-metadata/);
  assert.deepEqual(await f.store.read(f.manifest.id, f.manifest.ownerId), unfenced);
  assert.equal(await readFile(native, "utf8"), "never remove unknown data");
});

for (const point of ["before", "after"] as const) {
  test(`metadata destruction ${point}-rename failure is terminal, never retried or rebased`, async t => {
    const f = await fixture(t); await f.store.create({ ...f.manifest, native: { state: "pending" } });
    const fs = createRequire(import.meta.url)("node:fs/promises") as typeof import("node:fs/promises"), rename = fs.rename;
    let calls = 0;
    const mock = t.mock.method(fs, "rename", (async (from, to) => {
      if (!String(to).includes("/.destroy-")) return rename(from, to);
      calls++; if (point === "after") await rename(from, to);
      throw new Error(`Injected ${point}-rename destruction failure`);
    }) as typeof rename);
    syncBuiltinESMExports();
    try {
      await assert.rejects(f.store.withSessionLock(f.manifest.id, f.manifest.ownerId, lease => lease.removeResumeMetadata(0)), /Injected/);
      assert.equal(calls, 1);
      assert.equal(Boolean(await f.store.read(f.manifest.id, f.manifest.ownerId)), point === "before");
      assert.equal((await f.store.list(f.manifest.ownerId)).length, point === "before" ? 1 : 0);
    } finally { mock.mock.restore(); syncBuiltinESMExports(); }
  });
}

test("pinned readers can finish an old snapshot after atomic replacement unlinks it", { timeout: 10_000 }, async t => {
  const f = await fixture(t);
  await f.store.create(f.manifest);
  const child = fork(new URL("./fixtures/store-reader.js", import.meta.url), [f.root, f.manifest.id, f.manifest.ownerId],
    { stdio: ["ignore", "ignore", "ignore", "ipc"] });
  t.after(() => { child.kill("SIGKILL"); });
  const exited = once(child, "exit");
  const [pinned] = await once(child, "message");
  assert.equal(pinned.type, "pinned");
  await f.store.update(f.manifest.id, f.manifest.ownerId, 0, { generation: "generation-b" });
  const reply = once(child, "message");
  child.send("continue");
  const [message] = await reply;
  assert.deepEqual(message.manifest, f.manifest);
  await exited;
});

test("lock storage refuses public, symlinked, hardlinked and corrupt lock files without repair", async t => {
  const f = await fixture(t);
  await f.store.create(f.manifest);
  const owner = join(f.root, createHash("sha256").update(f.manifest.ownerId).digest("hex"));
  const lock = join(owner, `.lifecycle-${f.manifest.id}.sqlite`);
  const target = join(f.directory, "target-lock");
  await writeFile(target, "", { mode: 0o600 });
  await symlink(target, lock);
  await assert.rejects(f.store.withSessionLock(f.manifest.id, f.manifest.ownerId, async () => {}));
  await rm(lock);
  await link(target, lock);
  await assert.rejects(f.store.withSessionLock(f.manifest.id, f.manifest.ownerId, async () => {}));
  await rm(lock);
  await writeFile(lock, "", { mode: 0o644 });
  await assert.rejects(f.store.withSessionLock(f.manifest.id, f.manifest.ownerId, async () => {}));
  assert.equal((await stat(lock)).mode & 0o777, 0o644);
  await chmod(lock, 0o600);
  await writeFile(lock, "corrupt database");
  await assert.rejects(f.store.withSessionLock(f.manifest.id, f.manifest.ownerId, async () => {}));
  assert.equal(await readFile(lock, "utf8"), "corrupt database");
});

test("local timeouts and ASCII case aliases cannot release a holder or permit a lost CAS update", { timeout: 10_000 }, async t => {
  const f = await fixture(t);
  await f.store.create(f.manifest);
  // Writer A and its timed-out contenders share a process; this test's store
  // is writer B in a different process, using the same on-disk lock identity.
  const child = fork(new URL("./fixtures/store-local-contender.js", import.meta.url), [f.root, JSON.stringify(f.manifest)],
    { stdio: ["ignore", "ignore", "ignore", "ipc"] });
  t.after(() => { child.kill("SIGKILL"); });
  const exited = once(child, "exit");
  const [paused] = await once(child, "message");
  assert.equal(paused.type, "paused");
  try {
    const ownerDirectory = join(f.root, createHash("sha256").update(f.manifest.ownerId).digest("hex"));
    const canonicalLock = await stat(join(ownerDirectory, `.lifecycle-${f.manifest.id}.sqlite`));
    const aliasLock = await stat(join(ownerDirectory, `.lifecycle-${f.manifest.id.toUpperCase()}.sqlite`)).catch(error => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    });
    if (aliasLock) {
      assert.equal(aliasLock.ino, canonicalLock.ino);
      assert.equal(aliasLock.dev, canonicalLock.dev);
      t.diagnostic("Case-insensitive filesystem: uppercase ID aliases the active lock inode");
    } else t.diagnostic("Case-sensitive filesystem: conservative case-folded queue regression");
    // Owners remain exact scopes: case folding the queue never changes the
    // original owner ID or its hashed namespace.
    await f.store.withSessionLock(f.manifest.id, f.manifest.ownerId.toUpperCase(), async () => {}, 75);
    const contenders = [];
    // Multiple timeouts also ensure a canceled tail cannot erase the queue and
    // allow a subsequent local caller to bypass the still-paused writer.
    for (const command of ["contend", "contend-alias", "contend-alias"]) {
      const reply = once(child, "message");
      child.send(command);
      const [message] = await reply;
      assert.equal(message.type, "contender-failed");
      assert.equal(message.name, "CodexLifecycleBusyError");
      contenders.push(message);
    }
    await assert.rejects(f.store.withSessionLock(f.manifest.id, f.manifest.ownerId,
      lease => lease.update(0, { generation: "writer-b" }), 75), CodexLifecycleBusyError);
    assert.ok(contenders.every(message => message.opens === 0), "Local timeouts must not open any lock-file descriptors");
    assert.equal((await f.store.read(f.manifest.id, f.manifest.ownerId))?.revision, 0);
    // B can wait, but after A publishes it must conflict instead of also
    // acknowledging a successful revision-0 -> revision-1 write.
    const rejectedB = assert.rejects(f.store.update(f.manifest.id, f.manifest.ownerId, 0, { generation: "writer-b" }), CodexManifestConflictError);
    const published = once(child, "message");
    child.send("release");
    const [message] = await published;
    assert.equal(message.type, "updated");
    assert.equal(message.next.revision, 1);
    await rejectedB;
    await exited;
    assert.deepEqual(await f.store.read(f.manifest.id, f.manifest.ownerId), { ...f.manifest, revision: 1, generation: "writer-a" });
  } finally {
    if (child.connected) child.send("release");
  }
});
