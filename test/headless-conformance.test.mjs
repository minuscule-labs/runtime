// Shared assertions over public Runtime APIs; native protocol details stay in this fixture factory.
import assert from "node:assert/strict";
import test from "node:test";
import { access, copyFile, chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { isAbsolute, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { ClaudeCodeAgentRuntime, ClaudeCodeManagedRuntime } from "../packages/claude-code/dist/src/index.js";
import { ClaudeCodeManagedStore } from "../packages/claude-code/dist/src/managed-store.js";
import { readManagedSessionManifest } from "../packages/pi/dist/src/managed-sessions.js";
import { PiAgentRuntime } from "../packages/pi/dist/src/index.js";
import { scriptedProvider } from "../packages/claude-code/dist/test/fixtures/scripted-provider.js";

const root = fileURLToPath(new URL("../", import.meta.url));
const codexRoot = process.env.MINU_RUNTIME_CODEX_TEST_ROOT ?? root;
assert.ok(isAbsolute(codexRoot), "MINU_RUNTIME_CODEX_TEST_ROOT must be an explicit absolute artifact root");
const codexModule = join(codexRoot, "packages/codex/dist/src/index.js");
try { await access(codexModule); }
catch { throw new Error("Build all three adapters, or set MINU_RUNTIME_CODEX_TEST_ROOT to an explicit built Codex snapshot; no adapter is skipped"); }
const { CodexAgentRuntime } = await import(pathToFileURL(codexModule));
const { CodexManagedStore } = await import(pathToFileURL(join(codexRoot, "packages/codex/dist/src/managed-store.js")));

async function until(check) {
  const expiry = performance.now() + 5_000;
  while (!await check()) {
    assert.ok(performance.now() < expiry, "headless condition exceeded its bounded wait");
    await delay(10);
  }
}
async function bounded(task, ms = 5_000) {
  let timer;
  try {
    return await Promise.race([task, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error("headless operation exceeded its bounded wait")), ms);
    })]);
  } finally { clearTimeout(timer); }
}
function alive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { if (error.code === "ESRCH") return false; throw error; }
}
async function jsonLines(path) {
  try { return (await readFile(path, "utf8")).trim().split("\n").filter(Boolean).map(line => JSON.parse(line)); }
  catch (error) { if (error.code === "ENOENT") return []; throw error; }
}
const outcome = task => task.then(() => ({ success: true }), error => ({ success: false, error }));

async function open(adapter, scenario) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "runtime-headless-case-")));
  const inputFile = join(directory, "input"), logFile = join(directory, "native-input.jsonl");
  let runtime, input, diagnostic, pid, replies, dispatched;
  if (adapter === "claude-code") {
    runtime = new ClaudeCodeAgentRuntime({
      executable: join(root, "packages/claude-code/dist/test/fixtures/claude.js"),
      permissions: "full", startupTimeoutMs: 10_000,
      env: { PATH: process.env.PATH, HOME: directory, CLAUDE_CONFIG_DIR: join(directory, "config"),
        MINU_CLAUDE_FIXTURE_PID: join(directory, "pid"), MINU_CLAUDE_FIXTURE_INPUT: inputFile,
        MINU_CLAUDE_FIXTURE_REPLIES: logFile },
    });
    input = scenario === "question" ? "user-dialog:refusal_fallback_prompt"
      : scenario === "unknown" ? "user-dialog:future-runtime-dialog" : scenario === "stop" ? "hold" : "tool";
    diagnostic = "Claude Code requested unsupported interactive input";
    pid = async () => Number(await readFile(join(directory, "pid"), "utf8"));
    replies = () => jsonLines(logFile);
    dispatched = async () => {
      try { return await readFile(inputFile, "utf8"); }
      catch (error) { if (error.code === "ENOENT") return ""; throw error; }
    };
  } else if (adapter === "pi") {
    const command = join(directory, "pi.mjs");
    await copyFile(new URL("./fixtures/pi-headless.mjs", import.meta.url), command);
    await chmod(command, 0o700);
    // This test file runs sequentially in the launcher's isolated process. One private registry
    // holds multiple sessions; changing the command here cannot alter an already-running child.
    process.env.PI_COMMAND = command;
    runtime = new PiAgentRuntime({ controlRequestTimeoutMs: 3_000 });
    input = scenario === "stop" ? "hold" : scenario;
    diagnostic = "Pi requested unsupported interactive input";
    pid = async () => {
      const meta = JSON.parse(await readFile(join(directory, "native-meta.json"), "utf8"));
      assert.deepEqual(meta.args, ["--approve", "--mode", "rpc"], "project trust must remain unchanged");
      return meta.pid;
    };
    replies = async () => (await jsonLines(logFile)).filter(r => r.type === "extension_ui_response");
    dispatched = async () => (await jsonLines(logFile)).filter(r => r.type === "prompt");
  } else {
    let peer = join(codexRoot, "packages/codex/dist/test/fixtures/app-server.js");
    if (scenario === "unknown") {
      const body = await readFile(peer, "utf8");
      const method = "item/commandExecution/requestApproval";
      assert.equal(body.split(method).length, 2, "Codex fixture's known request method changed");
      // The copy leaves the package, so pin its bare workspace import to the snapshot's own core.
      const core = pathToFileURL(createRequire(join(codexRoot, "packages/codex/package.json")).resolve("@minu/runtime-core")).href;
      peer = join(directory, "app-server.mjs");
      await writeFile(peer, body.replace(method, "future/interactive").replaceAll('from "@minu/runtime-core"', `from ${JSON.stringify(core)}`));
    }
    runtime = new CodexAgentRuntime({ command: process.execPath,
      args: [peer, ["question", "unknown"].includes(scenario) ? "interactive" : scenario === "stop" ? "held" : "normal", logFile],
      requestTimeoutMs: 2_000, shutdownTimeoutMs: 100 });
    input = "hello";
    diagnostic = "Codex requested an unsupported interactive operation; session stopped";
    pid = async () => (await jsonLines(logFile))[0].pid;
    replies = async () => (await jsonLines(logFile)).filter(r => r.id === "server-request" && r.method === undefined);
    dispatched = async () => (await jsonLines(logFile)).filter(r => r.method === "turn/start");
  }
  const session = await runtime.start({ cwd: directory });
  const nativePid = await pid();
  assert.ok(Number.isSafeInteger(nativePid) && nativePid > 0 && alive(nativePid));
  const events = [], iterator = runtime.events(session.id)[Symbol.asyncIterator]();
  // Pi establishes an HTTP subscription asynchronously; its initial status confirms readiness.
  if (adapter === "pi") events.push((await iterator.next()).value);
  let streamError, streamClosed = false;
  const observing = (async () => { for await (const event of { [Symbol.asyncIterator]: () => iterator }) events.push(event); })()
    .catch(error => { streamError = error; }).finally(() => { streamClosed = true; });
  return {
    runtime, id: session.id, nativePid, input, diagnostic, events, dispatched,
    async noAnswers() {
      const frames = await replies();
      if (adapter === "claude-code") assert.equal(frames.some(r => r.subtype === "success"), false);
      else if (adapter === "pi") assert.deepEqual(frames, []);
      else assert.equal(frames.some(r => Object.hasOwn(r, "result")), false);
    },
    async finishedObserving() {
      await until(() => streamClosed);
      assert.equal(streamError, undefined);
    },
    async close() {
      try { await runtime.stop(session.id); }
      catch (error) {
        // Pi deregisters failed sessions. That is acceptable only after actual native exit.
        if (adapter !== "pi" || alive(nativePid) || await runtime.status(session.id) !== "offline") throw error;
      }
      await bounded(observing);
      await rm(directory, { recursive: true, force: true });
    },
  };
}

for (const adapter of ["claude-code", "pi", "codex"]) {
  for (const scenario of ["question", "unknown"]) {
    test(`${adapter}: shared refusal contract (${scenario})`, { timeout: 30_000 }, async () => {
      const f = await open(adapter, scenario);
      let other;
      try {
        other = await open(adapter, "healthy");
        const result = await bounded(outcome(f.runtime.send(f.id, f.input)));
        assert.equal(result.success, false, "unsupported interaction must not become a successful send");
        await until(async () => await f.runtime.status(f.id) === "offline");
        await until(() => !alive(f.nativePid)); // BEFORE any explicit stop cleanup.
        await f.finishedObserving();
        const publicMessages = [result.error.message, ...f.events.filter(e => e.type === "error").map(e => e.message)];
        assert.ok(publicMessages.includes(f.diagnostic), "a fixed unsupported-interaction reason must be observable");
        assert.doesNotMatch(JSON.stringify({ publicMessages, events: f.events }), /PRIVATE[ _]/);
        await f.noAnswers();
        const before = await f.dispatched();
        await assert.rejects(f.runtime.send(f.id, "must-not-dispatch"));
        assert.deepEqual(await f.dispatched(), before);
        await bounded(other.runtime.send(other.id, other.input));
        assert.equal(await other.runtime.status(other.id), "idle");
        assert.equal(alive(other.nativePid), true);
      } finally { await other?.close(); await f.close(); }
    });
  }

  test(`${adapter}: shared nonblocking native-activity contract`, { timeout: 30_000 }, async () => {
    const f = await open(adapter, "healthy");
    try {
      await bounded(f.runtime.send(f.id, f.input));
      assert.equal(await f.runtime.status(f.id), "idle");
      assert.equal(alive(f.nativePid), true);
      await until(() => f.events.some(e => e.type === "tool_started"));
      await f.noAnswers();
    } finally { await f.close(); }
  });

  test(`${adapter}: shared explicit-stop cancellation contract`, { timeout: 30_000 }, async () => {
    const f = await open(adapter, "stop");
    try {
      const sending = outcome(f.runtime.send(f.id, f.input));
      await until(async () => (await f.dispatched()).length > 0);
      await bounded(f.runtime.stop(f.id));
      assert.equal((await bounded(sending)).success, false, "cancellation must not manufacture completion");
      assert.equal(await f.runtime.status(f.id), "offline");
      await until(() => !alive(f.nativePid));
      await f.noAnswers();
    } finally { await f.close(); }
  });
}

// Shared forced-recovery contract over managed sessions. Native protocol details stay in this factory.
const OWNER = "headless-owner";
const groupAbsent = group => { try { process.kill(-group, 0); return false; } catch (error) { return error.code === "ESRCH"; } };
async function openManaged(adapter) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "runtime-headless-managed-")));
  const logFile = join(directory, "native-input.jsonl");
  let runtime, nativePid, workerGroup, busy;
  const cwd = join(directory, "workspace"); await mkdir(cwd);
  if (adapter === "claude-code") {
    const native = join(directory, "config"), storeRoot = join(directory, "managed"); await mkdir(native, { mode: 0o700 });
    // Owner-per-call managed API on the runtime itself, constructed like Channels will: no owner, just a root and policy.
    runtime = new ClaudeCodeAgentRuntime({ managedRoot: storeRoot, nativeConfigRoot: native, managedTimeoutMs: 8_000, permissions: "full",
      workerExecutable: join(root, "packages/claude-code/dist/test/fixtures/worker-entry.js"),
      executable: join(root, "packages/claude-code/dist/test/fixtures/persistent-native.js"),
      startupTimeoutMs: 4_000, shutdownTimeoutMs: 1_000, controlTimeoutMs: 1_000,
      env: { PATH: process.env.PATH, HOME: directory, TMPDIR: directory, CLAUDE_CONFIG_DIR: native, MINU_CLAUDE_FIXTURE_PID: join(directory, "pid") } });
    const store = new ClaudeCodeManagedStore(storeRoot);
    nativePid = async () => Number(await readFile(join(directory, "pid"), "utf8"));
    workerGroup = async id => (await store.read(id, OWNER)).worker.registration.processGroupId;
    busy = (id) => runtime.startTurn(id, "held-turn", "hold");
  } else if (adapter === "pi") {
    const command = join(directory, "pi.mjs");
    await copyFile(new URL("./fixtures/pi-headless.mjs", import.meta.url), command); await chmod(command, 0o700);
    process.env.PI_COMMAND = command;
    runtime = new PiAgentRuntime({ controlRequestTimeoutMs: 3_000 });
    nativePid = async () => JSON.parse(await readFile(join(cwd, "native-meta.json"), "utf8")).pid;
    workerGroup = async id => (await readManagedSessionManifest(id, OWNER)).workerProcessGroup;
    busy = id => { void runtime.send(id, "hold").catch(() => {}); return delay(300); };
  } else {
    const root_ = join(directory, "managed"), peer = join(codexRoot, "packages/codex/dist/test/fixtures/app-server.js");
    runtime = new CodexAgentRuntime({ managedRoot: root_, command: process.execPath, args: [peer, "held", logFile], requestTimeoutMs: 2_000, shutdownTimeoutMs: 100 });
    const store = new CodexManagedStore(root_);
    nativePid = async () => (await jsonLines(logFile))[0].pid;
    workerGroup = async id => (await store.read(id, OWNER)).worker.pgid;
    busy = async id => { await runtime.startTurn(id, "held-turn", "hello"); await until(async () => (await jsonLines(logFile)).some(r => r.method === "turn/start")); };
  }
  const session = await runtime.startManaged({ cwd: adapter === "pi" ? cwd : adapter === "codex" ? directory : cwd }, OWNER);
  const groups = new Set();
  return { runtime, id: session.id, directory, cwd, busy: () => busy(session.id), nativePid, async group() { const g = await workerGroup(session.id); groups.add(g); return g; },
    async close() {
      for (const g of groups) { try { process.kill(-g, "SIGKILL"); } catch { /* Gone. */ } }
      for (const g of groups) await until(() => groupAbsent(g));
      await rm(directory, { recursive: true, force: true });
    } };
}

for (const adapter of ["claude-code", "pi", "codex"]) {
  test(`${adapter}: shared forceStopManaged contract (busy session)`, { timeout: 60_000 }, async () => {
    const f = await openManaged(adapter);
    try {
      await bounded(f.busy());
      const group = await f.group(), native = await f.nativePid();
      assert.ok(alive(native), "native process must be running before force-stop");
      await f.runtime.forceStopManaged(f.id, OWNER);
      await until(() => !alive(native)); assert.equal(groupAbsent(group), true, "no live worker group may remain");
      assert.equal((await f.runtime.getManagedSession(f.id, OWNER))?.state, "suspended");
      await f.runtime.forceStopManaged(f.id, OWNER); // A second call is a no-op.
      assert.equal((await f.runtime.getManagedSession(f.id, OWNER))?.state, "suspended");
      await f.runtime.destroy(f.id, OWNER);
      assert.equal(await f.runtime.getManagedSession(f.id, OWNER), undefined);
    } finally { await f.close(); }
  });

  test(`${adapter}: shared forceStopManaged contract (worker killed externally)`, { timeout: 60_000 }, async () => {
    const f = await openManaged(adapter);
    try {
      const group = await f.group(), native = await f.nativePid().catch(() => undefined);
      process.kill(-group, "SIGKILL"); await until(() => groupAbsent(group));
      await f.runtime.forceStopManaged(f.id, OWNER); // Succeeds through group-absence proof.
      if (native !== undefined) await until(() => !alive(native));
      assert.equal((await f.runtime.getManagedSession(f.id, OWNER))?.state, "suspended");
      await f.runtime.destroy(f.id, OWNER);
      assert.equal(await f.runtime.getManagedSession(f.id, OWNER), undefined);
    } finally { await f.close(); }
  });
}

// Full-permission tool turns through the REAL bundled engine against a local synthetic provider (no credentials, no network).
async function bundled(name) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), `runtime-headless-${name}-`)));
  const cwd = join(directory, "workspace"), config = join(directory, "config"), storeRoot = join(directory, "managed");
  await mkdir(cwd); await mkdir(config, { mode: 0o700 });
  const target = join(cwd, "edited.txt");
  const provider = await scriptedProvider([
    [{ type: "tool_use", name: "Write", input: { file_path: target, content: "written by the full-permission turn\n" } }],
    [{ type: "tool_use", name: "Bash", input: { command: "echo bash-ran >> edited.txt" } }],
    [{ type: "text", text: "tools finished" }],
    [{ type: "text", text: "second turn after resume" }],
  ]);
  const env = { PATH: process.env.PATH, HOME: directory, TMPDIR: directory, CLAUDE_CONFIG_DIR: config, ANTHROPIC_API_KEY: "dummy-local-only",
    ANTHROPIC_BASE_URL: provider.url, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", NO_PROXY: "127.0.0.1,localhost" };
  return { directory, cwd, config, storeRoot, target, provider, env,
    async close() { await provider.close(); await rm(directory, { recursive: true, force: true }); } };
}

test("claude-code: full permissions run Write and Bash through the bundled engine; events and history are public", { timeout: 60_000 }, async () => {
  const f = await bundled("tools");
  const runtime = new ClaudeCodeAgentRuntime({ permissions: "full", env: f.env, startupTimeoutMs: 20_000 });
  const session = await runtime.start({ cwd: f.cwd });
  const events = [], iterator = runtime.events(session.id)[Symbol.asyncIterator]();
  const observing = (async () => { for await (const event of { [Symbol.asyncIterator]: () => iterator }) events.push(event); })().catch(() => {});
  try {
    await bounded(runtime.send(session.id, "edit the file"), 30_000);
    assert.equal(await readFile(f.target, "utf8"), "written by the full-permission turn\nbash-ran\n");
    for (const tool of ["Write", "Bash"]) {
      await until(() => events.some(e => e.type === "tool_started" && e.toolName === tool));
      await until(() => events.some(e => e.type === "tool_completed" && e.toolName === tool && e.isError === false));
    }
    assert.equal((await runtime.messages(session.id)).at(-1).content, "tools finished");
    assert.equal(await runtime.status(session.id), "idle");
  } finally { await runtime.stop(session.id); await bounded(observing); await f.close(); }
});

test("claude-code: read-only (the library default) cannot run Write", { timeout: 60_000 }, async () => {
  const f = await bundled("readonly");
  const runtime = new ClaudeCodeAgentRuntime({ env: f.env, startupTimeoutMs: 20_000 });
  const session = await runtime.start({ cwd: f.cwd });
  try {
    await bounded(runtime.send(session.id, "edit the file").catch(() => {}), 30_000);
    await assert.rejects(access(f.target), { code: "ENOENT" });
  } finally { await runtime.stop(session.id); await f.close(); }
});

test("claude-code: a managed full-permission tool turn survives stop and resume (real engine history)", { timeout: 90_000 }, async () => {
  const f = await bundled("managed");
  const options = { ownerId: OWNER, storeRoot: f.storeRoot, nativeConfigRoot: f.config, timeoutMs: 20_000, permissions: "full",
    nativeOptions: { startupTimeoutMs: 20_000, shutdownTimeoutMs: 5_000, controlTimeoutMs: 5_000, env: f.env } };
  const runtime = new ClaudeCodeManagedRuntime(options);
  let session;
  try {
    session = await runtime.startManaged({ cwd: f.cwd }, OWNER);
    await bounded(runtime.send(session.id, "edit the file").catch(error => { throw error; }), 30_000);
    assert.equal(await readFile(f.target, "utf8"), "written by the full-permission turn\nbash-ran\n");
    await runtime.suspend(session.id, OWNER);
    assert.equal((await runtime.getManagedSession(session.id, OWNER))?.state, "suspended");
    const history = await runtime.messages(session.id);
    assert.ok(history.some(m => m.role === "tool" && m.toolName === "Write") && history.some(m => m.role === "tool" && m.toolName === "Bash"));
    const next = new ClaudeCodeManagedRuntime(options);
    await next.resume(session.id, OWNER, { allowStopped: true });
    await bounded(next.send(session.id, "after resume"), 30_000);
    assert.equal((await next.messages(session.id)).at(-1).content, "second turn after resume");
    await next.suspend(session.id, OWNER);
  } finally {
    if (session) await runtime.forceStopManaged(session.id, OWNER).catch(() => {});
    if (session) await runtime.destroy(session.id, OWNER).catch(() => {});
    await f.close();
  }
});

test("claude-code: one runtime built without an owner serves several owners per call, isolated and durable across instances", { timeout: 60_000 }, async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "runtime-headless-owners-")));
  const native = join(directory, "config"), managedRoot = join(directory, "managed");
  await mkdir(native, { mode: 0o700 }); await mkdir(join(directory, "a")); await mkdir(join(directory, "b"));
  const options = { managedRoot, nativeConfigRoot: native, managedTimeoutMs: 8_000, permissions: "full",
    workerExecutable: join(root, "packages/claude-code/dist/test/fixtures/worker-entry.js"),
    executable: join(root, "packages/claude-code/dist/test/fixtures/persistent-native.js"),
    startupTimeoutMs: 4_000, shutdownTimeoutMs: 1_000, controlTimeoutMs: 1_000,
    env: { PATH: process.env.PATH, HOME: directory, TMPDIR: directory, CLAUDE_CONFIG_DIR: native } };
  const runtime = new ClaudeCodeAgentRuntime(options), groups = [];
  const store = new ClaudeCodeManagedStore(managedRoot);
  try {
    const a = await runtime.startManaged({ cwd: join(directory, "a") }, "owner-a"), b = await runtime.startManaged({ cwd: join(directory, "b") }, "owner-b");
    assert.equal(a.ownerId, "owner-a"); assert.equal(b.ownerId, "owner-b");
    for (const [id, owner] of [[a.id, "owner-a"], [b.id, "owner-b"]]) groups.push((await store.read(id, owner)).worker.registration.processGroupId);
    await bounded(runtime.send(a.id, "hello from a")); await bounded(runtime.send(b.id, "hello from b"));
    assert.equal(await runtime.status(a.id), "idle");
    assert.equal((await runtime.messages(a.id)).at(-1).content, "reply: hello from a");
    assert.equal((await runtime.messages(b.id)).at(-1).content, "reply: hello from b");
    // Owners never see or touch each other's sessions.
    assert.deepEqual((await runtime.listManagedSessions("owner-a")).map(s => s.id), [a.id]);
    assert.deepEqual((await runtime.listManagedSessions("owner-b")).map(s => s.id), [b.id]);
    assert.equal(await runtime.getManagedSession(a.id, "owner-b"), undefined);
    await assert.rejects(runtime.suspend(a.id, "owner-b"));
    await runtime.destroy(a.id, "owner-b"); // Another owner's destroy finds nothing and must not touch it.
    assert.equal((await runtime.getManagedSession(a.id, "owner-a")).state, "active");
    await runtime.suspend(a.id, "owner-a");
    assert.equal((await runtime.getManagedSession(a.id, "owner-a")).state, "suspended");
    // A fresh instance (an app restart) resumes durable sessions without replaying input.
    const restarted = new ClaudeCodeAgentRuntime(options);
    assert.equal((await restarted.getManagedSession(b.id, "owner-b")).state, "active");
    await restarted.resume(a.id, "owner-a", { allowStopped: true });
    await bounded(restarted.send(a.id, "after restart"));
    assert.deepEqual((await restarted.messages(a.id)).map(m => m.content), ["hello from a", "reply: hello from a", "after restart", "reply: after restart"]);
    await restarted.suspend(a.id, "owner-a"); await runtime.suspend(b.id, "owner-b");
    await restarted.destroy(a.id, "owner-a"); await runtime.destroy(b.id, "owner-b");
    assert.deepEqual(await runtime.listManagedSessions("owner-a"), []);
  } finally {
    for (const g of groups) { try { process.kill(-g, "SIGKILL"); } catch { /* Gone. */ } }
    for (const g of groups) await until(() => groupAbsent(g));
    await rm(directory, { recursive: true, force: true });
  }
});
