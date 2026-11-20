import assert from "node:assert/strict";
import { fork, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test, { type TestContext } from "node:test";
import type { AgentStartConfig } from "@minu/runtime-core";
import { CodexManagedStore, CodexManifestConflictError } from "../src/managed-store.js";
import { allocatePendingCodexThread, createPendingCodexSession, type CodexNativeAllocation } from "../src/managed-native.js";

const appServer = fileURLToPath(new URL("./fixtures/app-server.js", import.meta.url));

async function fixture(t: TestContext, scenario = "normal") {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "codex-pending-")));
  const root = join(directory, "managed");
  const logPath = join(directory, "native.jsonl");
  const store = new CodexManagedStore(root);
  const identity = { id: "runtime-id", ownerId: "owner-a", generation: "generation-a" };
  const config: AgentStartConfig = { cwd: directory, appendSystemPrompt: "Reviewer", model: { provider: "openai", id: "selected-model" }, reasoningLevel: "high" };
  const options = { command: process.execPath, args: [appServer, scenario, logPath], requestTimeoutMs: 1_000, shutdownTimeoutMs: 100 };
  const allocations: CodexNativeAllocation[] = [];
  const children: ChildProcess[] = [];
  const log = async (): Promise<Array<Record<string, any>>> => {
    try { return (await readFile(logPath, "utf8")).trim().split("\n").map(line => JSON.parse(line)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
  };
  t.after(async () => {
    try {
      await Promise.all(allocations.map(({ runtime, session }) => runtime.stop(session.id)));
      for (const child of children) {
        if (child.exitCode === null && child.signalCode === null) {
          const exited = once(child, "exit");
          child.kill("SIGKILL");
          await exited;
        }
      }
      // Test-only cleanup of fixture processes after deliberate controller SIGKILL.
      for (const item of await log()) {
        if (typeof item.pid === "number") { try { process.kill(item.pid, "SIGKILL"); } catch {} }
      }
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
  return {
    root, store, identity, config, options, logPath, directory, children, log,
    create: () => createPendingCodexSession(store, identity, config),
    read: () => store.read(identity.id, identity.ownerId),
    async allocate() {
      const allocation = await allocatePendingCodexThread(store, identity, options);
      allocations.push(allocation);
      return allocation;
    },
  };
}

async function childResult(child: ChildProcess): Promise<{ type: string }> {
  const [message] = await Promise.race([
    once(child, "message"),
    once(child, "exit").then(() => { throw new Error("Allocation process exited before reporting its result"); }),
  ]);
  return message;
}

function spawnPublication(t: TestContext, f: Awaited<ReturnType<typeof fixture>>, point: string): ChildProcess {
  const child = fork(new URL("./fixtures/managed-native-publication.js", import.meta.url),
    [f.root, f.identity.id, f.identity.ownerId, f.identity.generation, f.logPath, point],
    { stdio: ["ignore", "ignore", "ignore", "ipc"] });
  f.children.push(child);
  return child;
}

test("persists an empty Runtime identity without creating any native process or thread", async t => {
  const f = await fixture(t);
  const session = await f.create();
  assert.deepEqual(session, { id: f.identity.id, ownerId: f.identity.ownerId, runtime: "codex", ownership: "owned", cwd: f.directory });
  const restored = await new CodexManagedStore(f.root).read(session.id, f.identity.ownerId);
  assert.deepEqual(restored?.native, { state: "pending" });
  assert.deepEqual(restored?.launchConfig, f.config);
  assert.equal(restored?.generation, f.identity.generation);
  assert.deepEqual(await f.log(), []);
  await assert.rejects(f.create());
  assert.deepEqual(await f.read(), restored);
});

test("pending creation snapshots caller identity/config and preserves owner separation", async t => {
  const f = await fixture(t);
  const pending = f.create();
  f.identity.generation = "mutated";
  f.config.appendSystemPrompt = "mutated";
  await pending;
  assert.equal((await f.read())?.generation, "generation-a");
  assert.equal((await f.read())?.launchConfig.appendSystemPrompt, "Reviewer");
  assert.equal(await f.store.read(f.identity.id, "owner-b"), undefined);
  assert.deepEqual(await f.log(), []);
});

test("one-shot allocation validates saved launch policy and binds before any user input", async t => {
  const f = await fixture(t);
  await f.create();
  const { runtime, session } = await f.allocate();
  const bound = await f.read();
  assert.equal(bound?.revision, 2);
  assert.deepEqual(bound?.native, { state: "bound", threadId: "native-thread" });
  assert.equal(await runtime.status(session.id), "idle");
  const calls = await f.log();
  const launch = calls.find(call => call.method === "thread/start")!.params;
  assert.equal(launch.ephemeral, false);
  assert.equal(launch.developerInstructions, "Reviewer");
  assert.equal(launch.model, "selected-model");
  assert.equal(launch.approvalPolicy, "never");
  assert.equal(launch.sandbox, "read-only");
  assert.equal(calls.some(call => call.method === "turn/start"), false);
  await runtime.send(session.id, "Actual first input");
  assert.equal((await f.log()).filter(call => call.method === "turn/start").length, 1);
  await runtime.stop(session.id);
  await assert.rejects(f.allocate(), /already bound or uncertain/);
  assert.deepEqual(await f.read(), bound);
  assert.equal((await f.log()).filter(call => call.method === "thread/start").length, 1);
});

test("concurrent local allocations admit only one native launch", async t => {
  const f = await fixture(t);
  await f.create();
  const results = await Promise.allSettled([f.allocate(), f.allocate(), f.allocate()]);
  assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
  assert.equal((await f.log()).filter(call => call.method === "thread/start").length, 1);
});

test("concurrent separate allocation processes admit only one native launch", { timeout: 10_000 }, async t => {
  const f = await fixture(t);
  await f.create();
  const children = [spawnPublication(t, f, "complete"), spawnPublication(t, f, "complete")];
  const exits = children.map(child => once(child, "exit"));
  const results = await Promise.all(children.map(childResult));
  await Promise.all(exits);
  assert.deepEqual(results.map(result => result.type).sort(), ["allocated", "failed"]);
  assert.equal((await f.log()).filter(call => call.method === "thread/start").length, 1);
  assert.deepEqual((await f.read())?.native, { state: "bound", threadId: "native-thread" });
});

for (const variant of ["missing", "foreign", "stale-generation", "stopped"]) {
  test(`${variant} identity is refused before native launch`, async t => {
    const f = await fixture(t);
    await f.create();
    const identity = { ...f.identity };
    if (variant === "missing") identity.id = "absent-id";
    if (variant === "foreign") identity.ownerId = "owner-b";
    if (variant === "stale-generation") identity.generation = "old-generation";
    if (variant === "stopped") await f.store.update(identity.id, identity.ownerId, 0, { requiresExplicitResume: true });
    const before = await f.read();
    await assert.rejects(allocatePendingCodexThread(f.store, identity, f.options), CodexManifestConflictError);
    assert.deepEqual(await f.read(), before);
    assert.deepEqual(await f.log(), []);
  });
}

for (const scenario of ["mismatch-policy", "mismatch-model", "mismatch-reasoning", "resume-response-cwd", "resume-response-ephemeral", "resume-response-active"]) {
  test(`first-use launch validation refuses ${scenario}, cleans up, and never resets uncertain intent`, async t => {
    const f = await fixture(t, scenario);
    await f.create(); // Persisting configuration is not proof of native launch validity.
    await assert.rejects(f.allocate());
    const uncertain = await f.read();
    assert.equal(uncertain?.revision, 1);
    assert.deepEqual(uncertain?.native, { state: "creating" });
    const [{ pid }] = await f.log();
    assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
    await assert.rejects(f.allocate(), /already bound or uncertain/);
    assert.deepEqual(await f.read(), uncertain);
    assert.equal((await f.log()).filter(call => call.method === "thread/start").length, 1);
    assert.equal((await f.log()).some(call => call.method === "turn/start"), false);
  });
}

test("a redirected workspace cannot be silently used or rebound", async t => {
  const f = await fixture(t);
  const alias = join(f.directory, "alias");
  await symlink(f.directory, alias);
  f.config.cwd = alias;
  // createPendingCodexSession now canonicalizes the workspace, so a redirected record can only exist from older
  // metadata: persist one directly. Allocation must still refuse it (unchanged assertions below).
  await f.store.create({ ...f.identity, version: 4, runtime: "codex", revision: 0, requiresExplicitResume: false, native: { state: "pending" },
    worker: { state: "none" }, launchConfig: { ...f.config, cwd: alias }, sandbox: "read-only", createdAt: new Date().toISOString() });
  await assert.rejects(f.allocate(), /redirected/);
  assert.deepEqual((await f.read())?.native, { state: "creating" });
  assert.deepEqual(await f.log(), []);
});

for (const [point, state] of [["after-intent", "creating"], ["before-binding", "creating"], ["after-binding", "bound"]] as const) {
  test(`SIGKILL ${point} preserves uncertainty and forbids replacement or first-turn replay`, { timeout: 10_000 }, async t => {
    const f = await fixture(t);
    await f.create();
    const child = spawnPublication(t, f, point);
    const exited = once(child, "exit");
    assert.equal((await childResult(child)).type, "paused");
    assert.equal((await f.read())?.native.state, state);
    child.kill("SIGKILL");
    await exited;
    const snapshot = await new CodexManagedStore(f.root).read(f.identity.id, f.identity.ownerId);
    assert.equal(snapshot?.native.state, state);
    const previousCalls = (await f.log()).filter(call => call.method === "thread/start").length;
    await assert.rejects(f.allocate(), /already bound or uncertain/);
    assert.deepEqual(await f.read(), snapshot);
    assert.equal((await f.log()).filter(call => call.method === "thread/start").length, previousCalls);
    assert.equal((await f.log()).some(call => call.method === "turn/start"), false);
  });
}

for (const [point, state] of [["binding-failure", "creating"], ["post-binding-failure", "bound"]] as const) {
  test(`${point} confirms process cleanup without rolling back published intent`, { timeout: 10_000 }, async t => {
    const f = await fixture(t);
    await f.create();
    const child = spawnPublication(t, f, point);
    const exited = once(child, "exit");
    assert.equal((await childResult(child)).type, "failed");
    await exited;
    assert.equal((await f.read())?.native.state, state);
    const [{ pid }] = await f.log();
    assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
    await assert.rejects(f.allocate(), /already bound or uncertain/);
    assert.equal((await f.log()).some(call => call.method === "turn/start"), false);
  });
}

test("a symlinked workspace is canonicalized before anything is persisted (macOS /tmp is a symlink)", async t => {
  const f = await fixture(t), real = join(f.directory, "real-workspace"), link = join(f.directory, "linked-workspace");
  await (await import("node:fs/promises")).mkdir(real); await symlink(real, link);
  const session = await createPendingCodexSession(f.store, { id: "link-session", ownerId: "owner-a", generation: "generation-a" }, { cwd: link });
  assert.equal(session.cwd, real);
  assert.equal((await f.store.read("link-session", "owner-a"))!.launchConfig.cwd, real);
  // A missing workspace fails before any metadata exists.
  await assert.rejects(createPendingCodexSession(f.store, { id: "missing-cwd", ownerId: "owner-a", generation: "generation-a" }, { cwd: join(f.directory, "absent") }));
  assert.equal(await f.store.read("missing-cwd", "owner-a"), undefined);
});
