import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { fork } from "node:child_process";
import { once } from "node:events";
import { chmod, link, mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { ClaudeCodeManagedStore, ClaudeCodeManifestConflictError, type ClaudeCodeManagedManifest, type ClaudeCodeManifestLease } from "../src/managed-store.js";
import { ClaudeCodeLifecycleBusyError } from "../src/lifecycle-lock.js";

async function fixture(t: TestContext) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "claude-code-store-")));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const root = join(directory, "managed");
  const store = new ClaudeCodeManagedStore(root);
  const manifest: ClaudeCodeManagedManifest = {
    version: 3, runtime: "claude-code", id: "runtime-id", ownerId: "owner-a", native: { state: "pending" }, worker: { state: "none" }, lastDispatch: { state: "none" },
    revision: 0, generation: "generation-a", requiresExplicitResume: false,
    launchConfig: { cwd: directory, appendSystemPrompt: "Reviewer", model: { provider: "anthropic", id: "model" }, reasoningLevel: "high" },
    policy: { configuration: "native", permissionMode: "default", nativeConfigRoot: join(directory, "native"), tools: ["Read"] }, createdAt: new Date().toISOString(),
  };
  const path = join(root, createHash("sha256").update(manifest.ownerId).digest("hex"), `${manifest.id}.session`, "manifest.json");
  return { directory, root, store, manifest, path };
}

test("persists private ClaudeCode resume material across store instances without native transcript files", async t => {
  const f = await fixture(t);
  await f.store.create(f.manifest);
  const restarted = new ClaudeCodeManagedStore(f.root);
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
    f.store.create(f.manifest), f.store.create({ ...f.manifest, launchConfig: { cwd: f.directory, appendSystemPrompt: "Other intent" } }),
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
    const restarted = new ClaudeCodeManagedStore(f.root);
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
    { runtime: "pi" }, { version: 0 }, { version: 1 }, { version: 2 }, { native: { state: "creating", sessionId: "../native" } },
    { native: null }, { native: { state: "bound" } }, { native: { state: "pending", sessionId: "hidden" } },
    { native: { state: "unknown" } }, { sessionId: "legacy-identity" },
    { revision: -1 }, { revision: 0.5 }, { revision: 1 }, { generation: "../generation" },
    { requiresExplicitResume: "yes" }, { requiresExplicitResume: true },
    { createdAt: "invalid" }, { launchConfig: { cwd: "relative" } },
    { policy: { ...f.manifest.policy, permissionMode: "bypassPermissions", tools: null } },
    { policy: { ...f.manifest.policy, tools: ["Read", "Read"] } },
    { policy: { ...f.manifest.policy, tools: null, env: { KEY: "secret" } } },
    { policy: { ...f.manifest.policy, nativeConfigRoot: "relative" } },
    { launchConfig: { cwd: f.directory, skillIds: ["duplicate", "duplicate"] } },
    { launchConfig: { cwd: f.directory, reasoningLevel: "imagined-level" } },
    { launchConfig: { cwd: f.directory, systemPrompt: "one", appendSystemPrompt: "two" } },
    { launchConfig: { cwd: f.directory, approvalPolicy: "always" } },
    { launchConfig: { cwd: f.directory, model: { provider: "", id: "model" } } },
    { launchConfig: { cwd: f.directory, model: { provider: "anthropic", id: "model", apiKey: "secret" } } },
    { launchConfig: { cwd: f.directory, systemPrompt: "x".repeat(65536) } },
  ];
  for (const variant of variants) {
    await assert.rejects(f.store.create({ ...f.manifest, ...variant } as ClaudeCodeManagedManifest));
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
  const redirected = new ClaudeCodeManagedStore(join(alias, "managed"));
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

test("rejects malformed UTF8, BOM and JSON bytes without repair or parser diagnostics", async t => {
  const f = await fixture(t); await f.store.create(f.manifest);
  const valid = await readFile(f.path);
  const malformed = Buffer.from(valid);
  const persona = malformed.indexOf("Reviewer"); assert.ok(persona >= 0);
  malformed[persona] = 0xff;
  for (const data of [malformed, Buffer.concat([valid, Buffer.from([0xe2, 0x82])]),
    Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), valid]), Buffer.from('{"token":"PRIVATE_MANIFEST_BODY"} trailing')]) {
    await writeFile(f.path, data);
    const rejected = (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(error.message, "Invalid Claude Code manifest encoding");
      assert.equal(error.cause, undefined);
      return true;
    };
    await assert.rejects(f.store.read(f.manifest.id, f.manifest.ownerId), rejected);
    await assert.rejects(f.store.list(f.manifest.ownerId), rejected);
    await assert.rejects(f.store.update(f.manifest.id, f.manifest.ownerId, 0, { generation: "must-not-repair" }), rejected);
    assert.deepEqual(await readFile(f.path), data);
  }
  await writeFile(f.path, valid);
  assert.deepEqual(await f.store.read(f.manifest.id, f.manifest.ownerId), f.manifest);
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
  await assert.rejects(f.store.update(f.manifest.id, f.manifest.ownerId, 0, { generation: "stale" }), ClaudeCodeManifestConflictError);
  await assert.rejects(f.store.update(f.manifest.id, "owner-b", 1, { generation: "foreign" }), ClaudeCodeManifestConflictError);
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
  const exhausted = { ...f.manifest, revision: Number.MAX_SAFE_INTEGER - 1 };
  await writeFile(f.path, JSON.stringify(exhausted));
  await assert.rejects(f.store.update(exhausted.id, exhausted.ownerId, exhausted.revision, { generation: "new" }));
  assert.deepEqual(await f.store.read(exhausted.id, exhausted.ownerId), exhausted);
});

test("native intent records the attempted UUID before launch and can bind only that UUID once", async t => {
  const f = await fixture(t);
  await f.store.create(f.manifest);
  const nativeId = "11111111-1111-4111-8111-111111111111";
  const otherId = "22222222-2222-4222-8222-222222222222";
  let retained!: ClaudeCodeManifestLease;
  await f.store.withSessionLock(f.manifest.id, f.manifest.ownerId, async lease => {
    retained = lease;
    await assert.rejects(lease.bindNativeSession(0, nativeId), ClaudeCodeManifestConflictError);
    await assert.rejects(lease.beginNativeCreation(0, "../invalid"));
    const creating = await lease.beginNativeCreation(0, nativeId);
    assert.deepEqual(creating.native, { state: "creating", sessionId: nativeId });
    assert.equal(creating.revision, 1);
    await assert.rejects(lease.beginNativeCreation(1, otherId), ClaudeCodeManifestConflictError);
    await assert.rejects(lease.bindNativeSession(0, nativeId), ClaudeCodeManifestConflictError);
    await assert.rejects(lease.bindNativeSession(1, otherId), ClaudeCodeManifestConflictError);
    assert.deepEqual(await f.store.read(f.manifest.id, f.manifest.ownerId), creating);
    const bound = await lease.bindNativeSession(1, nativeId);
    assert.deepEqual(bound.native, { state: "bound", sessionId: nativeId });
    await assert.rejects(lease.bindNativeSession(2, otherId), ClaudeCodeManifestConflictError);
    await assert.rejects(lease.beginNativeCreation(2, otherId), ClaudeCodeManifestConflictError);
  });
  await assert.rejects(retained.beginNativeCreation(2, otherId), /inactive/);
  await assert.rejects(retained.bindNativeSession(2, otherId), /inactive/);
  await assert.rejects(f.store.update(f.manifest.id, f.manifest.ownerId, 2, { native: { state: "pending" } } as any));
  assert.deepEqual((await f.store.read(f.manifest.id, f.manifest.ownerId))?.native, { state: "bound", sessionId: nativeId });
});

test("stopped-session fences prevent allocation without changing saved intent", async t => {
  const f = await fixture(t);
  await f.store.create(f.manifest);
  const fenced = await f.store.update(f.manifest.id, f.manifest.ownerId, 0, { requiresExplicitResume: true });
  await f.store.withSessionLock(f.manifest.id, f.manifest.ownerId, async lease => {
    await assert.rejects(lease.beginNativeCreation(1, "11111111-1111-4111-8111-111111111111"), ClaudeCodeManifestConflictError);
  });
  assert.deepEqual(await f.store.read(f.manifest.id, f.manifest.ownerId), fenced);
});

test("empty/corrupt pre-existing registrations are not overwritten or silently omitted", async t => {
  const f = await fixture(t);
  await f.store.withSessionLock(f.manifest.id, f.manifest.ownerId, async () => {});
  const directory = join(f.root, createHash("sha256").update(f.manifest.ownerId).digest("hex"), `${f.manifest.id}.session`);
  await mkdir(directory, { mode: 0o700 });
  await assert.rejects(f.store.create(f.manifest), ClaudeCodeManifestConflictError);
  await assert.rejects(f.store.read(f.manifest.id, f.manifest.ownerId));
  await assert.rejects(f.store.list(f.manifest.ownerId));
  assert.deepEqual(await import("node:fs/promises").then(fs => fs.readdir(directory)), []);
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
    const other = new ClaudeCodeManagedStore(f.root);
    await assert.rejects(other.withSessionLock(f.manifest.id, f.manifest.ownerId, async () => { assert.fail("Must not enter"); }, 50), ClaudeCodeLifecycleBusyError);
    await other.withSessionLock(f.manifest.id, "owner-b", async () => {});
  } finally { release(); await held; }
  await assert.rejects(f.store.withSessionLock(f.manifest.id, f.manifest.ownerId, async () => { throw new Error("callback failed"); }), /callback failed/);
  await f.store.withSessionLock(f.manifest.id, f.manifest.ownerId, async () => {});
});

test("lease rejects concurrent mutations and use after release", async t => {
  const f = await fixture(t);
  await f.store.create(f.manifest);
  let retained!: ClaudeCodeManifestLease;
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
  let pending!: Promise<ClaudeCodeManagedManifest>;
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
  await assert.rejects(f.store.withSessionLock(f.manifest.id, f.manifest.ownerId, async () => {}, 50), ClaudeCodeLifecycleBusyError);
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
  assert.equal(results.find(r => r.type === "failed").name, "ClaudeCodeManifestConflictError");
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
    const restarted = new ClaudeCodeManagedStore(f.root);
    assert.equal((await restarted.read(f.manifest.id, f.manifest.ownerId))?.revision, expectedRevision);
    const next = await restarted.update(f.manifest.id, f.manifest.ownerId, expectedRevision, { requiresExplicitResume: true });
    assert.equal(next.revision, expectedRevision + 1);
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
  await rm(lock); // Inject corruption only after this fixture has stopped using the lock.
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
      assert.equal(message.name, "ClaudeCodeLifecycleBusyError");
      contenders.push(message);
    }
    await assert.rejects(f.store.withSessionLock(f.manifest.id, f.manifest.ownerId,
      lease => lease.update(0, { generation: "writer-b" }), 75), ClaudeCodeLifecycleBusyError);
    assert.ok(contenders.every(message => message.opens === 0), "Local timeouts must not open any lock-file descriptors");
    assert.equal((await f.store.read(f.manifest.id, f.manifest.ownerId))?.revision, 0);
    // B can wait, but after A publishes it must conflict instead of also
    // acknowledging a successful revision-0 -> revision-1 write.
    const rejectedB = assert.rejects(f.store.update(f.manifest.id, f.manifest.ownerId, 0, { generation: "writer-b" }), ClaudeCodeManifestConflictError);
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

const RESERVATION = "11111111-2222-4333-8444-555555555555", BOOT = "linux:0123456789abcdef0123456789abcdef";
async function started(f: Awaited<ReturnType<typeof fixture>>, launch?: { bootIdentity?: string }, group: number | null = 4242) {
  await f.store.create({ ...f.manifest, version: 4 });
  return f.store.withSessionLock(f.manifest.id, f.manifest.ownerId, async lease => {
    let m = await lease.reserveWorker(0, "generation-a", RESERVATION, join(f.directory, "entry.js"), launch);
    m = await lease.beginWorkerStart(m.revision, "generation-a", RESERVATION);
    return lease.recordWorkerProcess(m.revision, "generation-a", RESERVATION, 4242, group);
  });
}

test("v4 launch identity is recorded on the worker; v3 manifests stay readable and cannot carry it", async t => {
  const f = await fixture(t);
  const m = await started(f, { bootIdentity: BOOT });
  assert.equal(m.version, 4);
  assert.deepEqual([m.worker.state === "starting" && m.worker.marked, m.worker.state === "starting" && m.worker.bootIdentity], [true, BOOT]);
  assert.deepEqual(await new ClaudeCodeManagedStore(f.root).read(f.manifest.id, f.manifest.ownerId), m);
  const g = await fixture(t); // a version 3 record with no identity still reads and reserves as before
  await g.store.create(g.manifest);
  assert.equal((await g.store.read(g.manifest.id, g.manifest.ownerId))!.version, 3);
  const bytes = JSON.parse(await readFile(f.path, "utf8"));
  bytes.version = 3; await writeFile(f.path, JSON.stringify(bytes) + "\n", { mode: 0o600 });
  await assert.rejects(f.store.read(f.manifest.id, f.manifest.ownerId), "v3 cannot carry launch identity");
});

test("a launch without readable boot identity records marked but no boot proof", async t => {
  const f = await fixture(t), m = await started(f, {});
  assert.equal(m.worker.state === "starting" && m.worker.marked, true);
  assert.equal(m.worker.state === "starting" && m.worker.bootIdentity, undefined);
});

test("forceClearWorker requires the fence and a coherent proof, keeps binding and dispatch, and rotates the generation", async t => {
  const f = await fixture(t), m = await started(f, { bootIdentity: BOOT });
  await f.store.withSessionLock(f.manifest.id, f.manifest.ownerId, async lease => {
    await assert.rejects(lease.forceClearWorker(m.revision, "generation-a", RESERVATION, "group"), ClaudeCodeManifestConflictError, "unfenced");
    const fenced = await lease.update(m.revision, { requiresExplicitResume: true });
    await assert.rejects(lease.forceClearWorker(fenced.revision, "generation-a", RESERVATION, "unstarted"), ClaudeCodeManifestConflictError, "started worker");
    await assert.rejects(lease.forceClearWorker(fenced.revision, "generation-a", "99999999-2222-4333-8444-555555555555", "group"), ClaudeCodeManifestConflictError);
    const cleared = await lease.forceClearWorker(fenced.revision, "generation-a", RESERVATION, "group");
    assert.deepEqual(cleared.worker, { state: "none" }); assert.equal(cleared.requiresExplicitResume, true);
    assert.notEqual(cleared.generation, "generation-a"); assert.deepEqual(cleared.native, m.native); assert.deepEqual(cleared.lastDispatch, m.lastDispatch);
  });
});

test("forceClearWorker proofs must match the record: no group for group proof, no boot identity for boot proof", async t => {
  const f = await fixture(t), m = await started(f, {}, null);
  await f.store.withSessionLock(f.manifest.id, f.manifest.ownerId, async lease => {
    const fenced = await lease.update(m.revision, { requiresExplicitResume: true });
    await assert.rejects(lease.forceClearWorker(fenced.revision, "generation-a", RESERVATION, "group"), ClaudeCodeManifestConflictError);
    await assert.rejects(lease.forceClearWorker(fenced.revision, "generation-a", RESERVATION, "boot"), ClaudeCodeManifestConflictError);
  });
  const g = await fixture(t), n = await started(g, { bootIdentity: BOOT }, null);
  await g.store.withSessionLock(g.manifest.id, g.manifest.ownerId, async lease => {
    const fenced = await lease.update(n.revision, { requiresExplicitResume: true });
    assert.equal((await lease.forceClearWorker(fenced.revision, "generation-a", RESERVATION, "boot")).worker.state, "none");
  });
});

test("a reserved slot that never forked clears with the unstarted proof", async t => {
  const f = await fixture(t);
  await f.store.create({ ...f.manifest, version: 4 });
  await f.store.withSessionLock(f.manifest.id, f.manifest.ownerId, async lease => {
    const m = await lease.reserveWorker(0, "generation-a", RESERVATION, join(f.directory, "entry.js"), {});
    const fenced = await lease.update(m.revision, { requiresExplicitResume: true });
    assert.equal((await lease.forceClearWorker(fenced.revision, "generation-a", RESERVATION, "unstarted")).worker.state, "none");
  });
});
