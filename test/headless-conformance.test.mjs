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
async function bounded(task) {
  let timer;
  try {
    return await Promise.race([task, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error("headless operation exceeded its bounded wait")), 5_000);
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
      startupTimeoutMs: 10_000,
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
    runtime = new ClaudeCodeManagedRuntime({ ownerId: OWNER, storeRoot, nativeConfigRoot: native, timeoutMs: 8_000,
      workerExecutable: join(root, "packages/claude-code/dist/test/fixtures/worker-entry.js"),
      nativeOptions: { executable: join(root, "packages/claude-code/dist/test/fixtures/persistent-native.js"),
        startupTimeoutMs: 4_000, shutdownTimeoutMs: 1_000, controlTimeoutMs: 1_000,
        env: { PATH: process.env.PATH, HOME: directory, TMPDIR: directory, CLAUDE_CONFIG_DIR: native, MINU_CLAUDE_FIXTURE_PID: join(directory, "pid") } } });
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
