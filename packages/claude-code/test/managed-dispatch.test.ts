import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { fork } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import {
  ClaudeCodeManagedStore, ClaudeCodeManifestConflictError,
  type ClaudeCodeManagedManifest, type ClaudeCodeDispatchIdentity,
} from "../src/managed-store.js";

const input: ClaudeCodeDispatchIdentity = {
  turnId: "turn-a", fingerprint: "a".repeat(64), nativeMessageId: "11111111-1111-4111-8111-111111111111",
};
const nextInput: ClaudeCodeDispatchIdentity = { turnId: "turn-b", fingerprint: "b".repeat(64), nativeMessageId: "22222222-2222-4222-8222-222222222222" };

async function fixture(t: TestContext) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "claude-code-dispatch-")));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const root = join(directory, "managed");
  const store = new ClaudeCodeManagedStore(root);
  const manifest: ClaudeCodeManagedManifest = {
    version: 3, runtime: "claude-code", id: "managed-id", ownerId: "owner-a",
    native: { state: "pending" }, worker: { state: "none" }, lastDispatch: { state: "none" },
    revision: 0, generation: "generation-a", requiresExplicitResume: false,
    launchConfig: { cwd: directory }, policy: { configuration: "isolated", permissionMode: "default", nativeConfigRoot: join(directory, "native"), tools: [] },
    createdAt: new Date().toISOString(),
  };
  const path = join(root, createHash("sha256").update(manifest.ownerId).digest("hex"), `${manifest.id}.session`, "manifest.json");
  await store.create(manifest);
  const bind = () => store.withSessionLock(manifest.id, manifest.ownerId, async lease => {
    await lease.beginNativeCreation(0, randomUUID());
    const creating = (await store.read(manifest.id, manifest.ownerId))!;
    if (creating.native.state !== "creating") throw new Error("Expected creation intent");
    return lease.bindNativeSession(1, creating.native.sessionId);
  });
  const begin = (revision = 2, generation = manifest.generation, identity = input) =>
    store.withSessionLock(manifest.id, manifest.ownerId, lease => lease.beginDispatch(revision, generation, identity));
  const settle = (revision = 3, generation = manifest.generation, identity = input, outcome: "completed" | "failed" | "interrupted" = "completed") =>
    store.withSessionLock(manifest.id, manifest.ownerId, lease => lease.settleDispatch(revision, generation, identity, outcome));
  const read = () => store.read(manifest.id, manifest.ownerId);
  return { root, path, store, manifest, bind, begin, settle, read };
}

test("bound identity alone is not input settlement; persisted dispatch survives controller recreation", async t => {
  const f = await fixture(t);
  await f.bind();
  const admitted = await f.begin();
  assert.equal(admitted.revision, 3);
  assert.deepEqual(admitted.lastDispatch, { ...input, state: "dispatching", generation: f.manifest.generation });
  const restarted = new ClaudeCodeManagedStore(f.root);
  assert.deepEqual(await restarted.read(f.manifest.id, f.manifest.ownerId), admitted);
  await assert.rejects(f.begin(3), ClaudeCodeManifestConflictError);
  await assert.rejects(f.begin(3, f.manifest.generation, nextInput), ClaudeCodeManifestConflictError);
  await assert.rejects(f.store.update(f.manifest.id, f.manifest.ownerId, 3, { lastDispatch: { state: "none" } } as any));
  assert.deepEqual(await f.read(), admitted);
});

for (const outcome of ["completed", "failed", "interrupted"] as const) {
  test(`only observed matching ${outcome} settlement clears dispatch uncertainty`, async t => {
    const f = await fixture(t);
    await f.bind(); await f.begin();
    const terminal = await f.settle(3, f.manifest.generation, input, outcome);
    assert.equal(terminal.revision, 4);
    assert.deepEqual(terminal.lastDispatch, { ...input, state: "settled", generation: f.manifest.generation, outcome });
    await assert.rejects(f.settle(4), ClaudeCodeManifestConflictError);
    await assert.rejects(f.begin(4), ClaudeCodeManifestConflictError);
    await assert.rejects(f.begin(4, f.manifest.generation, { ...nextInput, nativeMessageId: input.nativeMessageId }), ClaudeCodeManifestConflictError);
    await assert.rejects(f.begin(4, f.manifest.generation, { ...nextInput, turnId: input.turnId }), ClaudeCodeManifestConflictError);
    const next = await f.begin(4, f.manifest.generation, nextInput);
    assert.deepEqual(next.lastDispatch, { ...nextInput, state: "dispatching", generation: f.manifest.generation });
    // Even with the current revision, a late old result cannot settle the new execution.
    await assert.rejects(f.settle(5, f.manifest.generation, input), ClaudeCodeManifestConflictError);
    assert.deepEqual(await f.read(), next);
  });
}

test("wrong owners/generations, unbound sessions and stale revisions cannot admit native input", async t => {
  const f = await fixture(t);
  await assert.rejects(f.begin(0), ClaudeCodeManifestConflictError);
  await f.bind();
  await assert.rejects(f.store.withSessionLock(f.manifest.id, "owner-b", lease => lease.beginDispatch(2, f.manifest.generation, input)), ClaudeCodeManifestConflictError);
  await assert.rejects(f.begin(2, "wrong-generation"), ClaudeCodeManifestConflictError);
  await assert.rejects(f.begin(1), ClaudeCodeManifestConflictError);
  assert.equal((await f.read())?.revision, 2);
});

test("recovery fence and generation replacement preserve uncertainty and refuse late terminal results", async t => {
  const f = await fixture(t);
  await f.bind(); const admitted = await f.begin();
  const fenced = await f.store.update(f.manifest.id, f.manifest.ownerId, 3, { requiresExplicitResume: true });
  await assert.rejects(f.settle(4), ClaudeCodeManifestConflictError);
  const replaced = await f.store.update(f.manifest.id, f.manifest.ownerId, 4, { generation: "generation-b", requiresExplicitResume: false });
  assert.deepEqual(replaced.lastDispatch, admitted.lastDispatch);
  assert.deepEqual(fenced.lastDispatch, admitted.lastDispatch);
  await assert.rejects(f.settle(5), ClaudeCodeManifestConflictError);
  await assert.rejects(f.settle(5, "generation-b"), ClaudeCodeManifestConflictError);
  await assert.rejects(f.begin(5, "generation-b", nextInput), ClaudeCodeManifestConflictError);
  assert.deepEqual(await f.read(), replaced);
});

test("malformed identity, secret-bearing additions and undefined terminal outcome are rejected", async t => {
  const f = await fixture(t);
  await f.bind();
  for (const identity of [null, {}, { ...input, input: "private text" }, { ...input, fingerprint: "not-a-digest" },
    { ...input, nativeMessageId: "../native" }, { ...input, turnId: "x".repeat(257) }, { ...input, turnId: "\0" }]) {
    await assert.rejects(f.begin(2, f.manifest.generation, identity as any));
  }
  await f.store.withSessionLock(f.manifest.id, f.manifest.ownerId, async lease => {
    await assert.rejects(lease.settleDispatch(2, f.manifest.generation, input, undefined as any));
    await assert.rejects(lease.settleDispatch(2, f.manifest.generation, input, "running" as any));
  });
  assert.deepEqual((await f.read())?.lastDispatch, { state: "none" });
  const saved = await f.store.withSessionLock(f.manifest.id, f.manifest.ownerId, async lease => {
    const supplied = { ...input };
    const pending = lease.beginDispatch(2, f.manifest.generation, supplied);
    supplied.turnId = "changed-before-publication";
    return pending;
  });
  if (saved.lastDispatch.state !== "dispatching") assert.fail("Expected dispatch intent");
  saved.lastDispatch.turnId = "changed-after-publication";
  assert.deepEqual((await f.read())?.lastDispatch, { ...input, state: "dispatching", generation: f.manifest.generation });
});

test("v1/v2 and contradictory dispatch records are refused rather than migrated or repaired", async t => {
  const f = await fixture(t);
  const original = await f.read();
  for (const patch of [
    { version: 1 }, { version: 2 }, { lastDispatch: undefined }, { lastDispatch: { state: "none", input: "secret" } },
    { lastDispatch: { ...input, state: "dispatching", generation: f.manifest.generation } },
  ]) {
    await writeFile(f.path, JSON.stringify({ ...original, ...patch }));
    await assert.rejects(f.read());
  }
  await writeFile(f.path, JSON.stringify(original));
  assert.deepEqual(await f.read(), original);
});

for (const mode of ["dispatch", "settle"]) for (const point of ["before-rename", "after-rename"]) {
  test(`SIGKILL ${point} ${mode} publication never fabricates settlement or resets intent`, { timeout: 10_000 }, async t => {
    const f = await fixture(t);
    let before = await f.bind();
    if (mode === "settle") before = await f.begin();
    const child = fork(new URL("./fixtures/store-crash.js", import.meta.url), [f.root, JSON.stringify(before), point, mode],
      { stdio: ["ignore", "ignore", "ignore", "ipc"] });
    const exited = once(child, "exit");
    try {
      await Promise.race([once(child, "message"), exited.then(() => { throw new Error("Child exited before fault checkpoint"); })]);
      const expectedState = point === "before-rename" ? before.lastDispatch.state : mode === "dispatch" ? "dispatching" : "settled";
      assert.equal((await f.read())?.lastDispatch.state, expectedState);
      child.kill("SIGKILL"); await exited;
      const recovered = await new ClaudeCodeManagedStore(f.root).read(before.id, before.ownerId);
      assert.equal(recovered?.lastDispatch.state, expectedState);
      assert.equal(recovered?.revision, before.revision + (point === "after-rename" ? 1 : 0));
      if (expectedState === "dispatching") {
        await assert.rejects(f.begin(recovered!.revision, before.generation, nextInput), ClaudeCodeManifestConflictError);
      }
      if (mode === "settle" && point === "before-rename") {
        assert.doesNotMatch(await readFile(f.path, "utf8"), /"outcome"/);
      }
    } finally { child.kill("SIGKILL"); await exited; }
  });
}
