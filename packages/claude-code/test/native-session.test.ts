import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { fork } from "node:child_process";
import { once } from "node:events";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { test, type TestContext } from "node:test";
import { openClaudeCodeNativeSession, type ClaudeCodeNativeOpen } from "../src/native-session.js";
import { inspectClaudeCodeHistory, ClaudeCodeHistoryError } from "../src/native-history.js";
import { nativeHistoryProvider } from "./fixtures/native-history-provider.js";

const executable = fileURLToPath(new URL("./fixtures/claude.js", import.meta.url));
type Handle = Awaited<ReturnType<typeof openClaudeCodeNativeSession>>;
async function until<T>(read: () => Promise<T>, done: (value: T) => boolean): Promise<T> {
  const end = Date.now() + 5_000;
  while (true) {
    const value = await read();
    if (done(value)) return value;
    if (Date.now() > end) throw new Error("Native session test timed out");
    await delay(5);
  }
}
async function fixture(t: TestContext) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "claude-native-session-")));
  const cwd = join(root, "workspace"), configRoot = join(root, "config");
  await mkdir(cwd, { mode: 0o700 }); await mkdir(configRoot, { mode: 0o700 });
  const nativeSessionId = randomUUID();
  const descriptor: ClaudeCodeNativeOpen = { mode: "create", firstInput: "first", runtimeSessionId: "logical-runtime-id",
    nativeSessionId, canonicalCwd: cwd, nativeConfigRoot: configRoot };
  const env = { PATH: process.env.PATH, HOME: root, CLAUDE_CONFIG_DIR: configRoot,
    MINU_CLAUDE_FIXTURE_PID: join(root, "pid"), MINU_CLAUDE_FIXTURE_INPUT: join(root, "input") };
  const handles: Handle[] = [];
  t.after(async () => {
    const results = await Promise.allSettled(handles.map(handle => handle.runtime.stop("logical-runtime-id")));
    await rm(root, { recursive: true, force: true });
    const errors = results.filter(result => result.status === "rejected");
    assert.equal(errors.length, 0, "Every native process must confirm shutdown");
  });
  const remember = (handle: Handle) => { handles.push(handle); return handle; };
  const fake = async (extra: Record<string, string> = {}, binding: ClaudeCodeNativeOpen = descriptor) => remember(await openClaudeCodeNativeSession(
    { cwd }, binding, { executable, env: { ...env, ...extra }, startupTimeoutMs: 5_000 },
  ));
  const seed = async () => {
    const directory = join(configRoot, "projects", cwd.replace(/[^a-zA-Z0-9]/g, "-"));
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const user = randomUUID();
    const rows = [
      { type: "user", message: { role: "user", content: "history input" }, uuid: user, parentUuid: null },
      { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "history answer" }] }, uuid: randomUUID(), parentUuid: user },
    ].map(row => ({ ...row, sessionId: nativeSessionId, cwd, version: "2.1.321", isSidechain: false, timestamp: new Date().toISOString() }));
    const path = join(directory, `${nativeSessionId}.jsonl`);
    await writeFile(path, rows.map(row => JSON.stringify(row)).join("\n") + "\n", { mode: 0o600 });
    return path;
  };
  const resume: ClaudeCodeNativeOpen = { mode: "resume", runtimeSessionId: descriptor.runtimeSessionId,
    nativeSessionId, canonicalCwd: cwd, nativeConfigRoot: configRoot };
  return { root, cwd, configRoot, descriptor, resume, env, fake, remember, seed };
}

async function terminal(handle: Handle, id: string) {
  return until(() => handle.runtime.turn("logical-runtime-id", id), turn => !!turn && turn.status !== "running");
}

test("real persistent create/resume keeps native and Runtime identity separate without fabricating caller results", { timeout: 45_000 }, async t => {
  const f = await fixture(t); const provider = await nativeHistoryProvider();
  t.after(() => provider.close());
  const options = { tools: [], env: { PATH: process.env.PATH, HOME: f.root, CLAUDE_CONFIG_DIR: f.configRoot,
    ANTHROPIC_API_KEY: "synthetic-local-only", ANTHROPIC_BASE_URL: provider.url, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1" } };
  const created = f.remember(await openClaudeCodeNativeSession({ cwd: f.cwd }, f.descriptor, options));
  assert.equal(created.session.id, "logical-runtime-id"); assert.notEqual(created.session.id, f.descriptor.nativeSessionId);
  assert.deepEqual(await created.runtime.messages(created.session.id), []);
  assert.equal(provider.calls(), 0, "Opening must not inject a hidden first turn");
  const messageId = randomUUID();
  await created.startMappedTurn("caller-one", "first", messageId);
  assert.equal((await terminal(created, "caller-one"))?.response?.content, "history reply 1");
  assert.equal(created.evidence("caller-one"), "native");
  assert.equal((await created.startMappedTurn("caller-one", "first", messageId)).status, "completed");
  await assert.rejects(created.startMappedTurn("caller-one", "first", randomUUID()), /identity conflicts/);
  assert.equal(provider.calls(), 1);
  await created.runtime.stop(created.session.id);
  const resumed = f.remember(await openClaudeCodeNativeSession({ cwd: f.cwd }, f.resume, options));
  assert.equal(resumed.session.id, created.session.id);
  assert.deepEqual((await resumed.runtime.messages(resumed.session.id)).map(m => m.content), ["first", "history reply 1"]);
  assert.equal(await resumed.runtime.turn(resumed.session.id, "caller-one"), undefined);
  assert.equal(resumed.evidence("caller-one"), undefined, "Native history is not a durable Runtime turn ledger");
  assert.equal(provider.calls(), 1, "Resume initialization must not replay prior input");
  await resumed.startMappedTurn("caller-two", "second", randomUUID());
  assert.equal((await terminal(resumed, "caller-two"))?.response?.content, "history reply 2");
  await resumed.runtime.stop(resumed.session.id);
  assert.equal(provider.calls(), 2);
  const snapshot = await inspectClaudeCodeHistory({ nativeSessionId: f.descriptor.nativeSessionId, canonicalCwd: f.cwd, nativeConfigRoot: f.configRoot });
  assert.equal(snapshot.state, "present");
  if (snapshot.state === "present") assert.deepEqual(snapshot.messages.map(m => m.content), ["first", "history reply 1", "second", "history reply 2"]);
});

test("an empty initialized native ID is not history and resume refuses without fallback spawning", { timeout: 30_000 }, async t => {
  const f = await fixture(t); const provider = await nativeHistoryProvider(); t.after(() => provider.close());
  const created = f.remember(await openClaudeCodeNativeSession({ cwd: f.cwd }, f.descriptor, { tools: [], env: {
    PATH: process.env.PATH, HOME: f.root, CLAUDE_CONFIG_DIR: f.configRoot, ANTHROPIC_API_KEY: "local-only",
    ANTHROPIC_BASE_URL: provider.url, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
  } }));
  await created.runtime.stop(created.session.id);
  await assert.rejects(f.fake({}, f.resume), /native history is missing/);
  await assert.rejects(readFile(join(f.root, "pid")), { code: "ENOENT" });
  assert.equal(provider.calls(), 0);
});

test("create refuses an existing native history instead of opening it as a fresh session", async t => {
  const f = await fixture(t); await f.seed();
  await assert.rejects(f.fake(), /history already exists/);
  await assert.rejects(readFile(join(f.root, "pid")), { code: "ENOENT" });
});

test("wrong workspace/config root, unsafe history and replay environment refuse before native spawn", async t => {
  const f = await fixture(t); const path = await f.seed();
  const other = join(f.root, "other"); await mkdir(other, { mode: 0o700 });
  await assert.rejects(openClaudeCodeNativeSession({ cwd: other }, f.resume, { executable, env: f.env }), /identity or workspace/);
  await assert.rejects(openClaudeCodeNativeSession({ cwd: other }, { ...f.resume, canonicalCwd: other }, { executable, env: f.env }), /history is missing/);
  await assert.rejects(f.fake({ CLAUDE_CONFIG_DIR: other }, f.resume), /configuration root is not verified/);
  for (const value of ["1", "0", ""]) await assert.rejects(f.fake({ CLAUDE_CODE_RESUME_INTERRUPTED_TURN: value }, f.resume), /replay is not allowed/);
  await writeFile(path, "{corrupt\n");
  await assert.rejects(f.fake({}, f.resume), error => error instanceof ClaudeCodeHistoryError && error.code === "invalid_history");
  await assert.rejects(readFile(join(f.root, "pid")), { code: "ENOENT" });
});

test("configured project-directory overrides refuse create and resume before preparation or spawn", async t => {
  const f = await fixture(t);
  for (const binding of [f.descriptor, f.resume]) for (const value of ["override", "", "0", "../alternate"]) {
    await assert.rejects(f.fake({ CLAUDE_CODE_PROJECT_DIR_NAME: value }, binding),
      /^Error: Persistent Claude Code project-directory override is not supported$/);
  }
  await assert.rejects(stat(join(f.configRoot, "projects")), { code: "ENOENT" });
  await assert.rejects(readFile(join(f.root, "pid")), { code: "ENOENT" });
  await assert.rejects(readFile(join(f.root, "input")), { code: "ENOENT" });
});

test("effective inherited override refuses while an explicit replacement environment does not inherit it", { timeout: 15_000 }, async t => {
  const f = await fixture(t);
  const before = { ...process.env };
  for (const replacement of [false, true]) {
    const child = fork(new URL("./fixtures/native-opening-environment.js", import.meta.url), [], {
      stdio: ["ignore", "ignore", "ignore", "ipc"],
      env: { ...f.env, CLAUDE_CODE_PROJECT_DIR_NAME: "inherited-override" },
    });
    const exited = once(child, "exit");
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const reply = once(child, "message");
      child.send({ cwd: f.cwd, native: f.descriptor, executable,
        ...(replacement ? { replacementEnv: f.env } : {}) });
      const [message] = await Promise.race([reply,
        exited.then(() => { throw new Error("Environment probe exited before its report"); }),
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Environment probe timed out")), 5_000); }),
      ]);
      assert.equal((await exited)[0], 0);
      assert.equal(message.opened, replacement);
      if (!replacement) {
        assert.equal(message.overrideRejected, true);
        await assert.rejects(stat(join(f.configRoot, "projects")), { code: "ENOENT" });
        await assert.rejects(readFile(join(f.root, "pid")), { code: "ENOENT" });
      } else {
        assert.equal(message.cleanupFailed, undefined);
        const pid = Number(await readFile(join(f.root, "pid"), "utf8"));
        assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
      }
      await assert.rejects(readFile(join(f.root, "input")), { code: "ENOENT" });
    } finally {
      clearTimeout(timer);
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await exited;
    }
  }
  assert.deepEqual({ ...process.env }, before);
});

test("persistent opening spawns with its validated environment snapshot despite later host mutation", { timeout: 15_000 }, async t => {
  const f = await fixture(t);
  const capture = join(f.root, "native-project-dir");
  const child = fork(new URL("./fixtures/native-opening-environment.js", import.meta.url), [], {
    stdio: ["ignore", "ignore", "ignore", "ipc"], env: { ...f.env, MINU_CLAUDE_FIXTURE_PROJECT_DIR: capture },
  });
  const exited = once(child, "exit");
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const reply = once(child, "message");
    child.send({ cwd: f.cwd, native: f.descriptor, executable, injectOverrideDuringPrepare: true });
    const [message] = await Promise.race([reply,
      exited.then(() => { throw new Error("Environment probe exited before its report"); }),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Environment probe timed out")), 5_000); }),
    ]);
    assert.equal((await exited)[0], 0);
    assert.equal(message.opened, true);
    assert.equal(message.environmentChangedDuringPrepare, true);
    assert.equal(message.cleanupFailed, undefined);
    assert.equal(await readFile(capture, "utf8"), "<default>");
    const pid = Number(await readFile(join(f.root, "pid"), "utf8"));
    assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
    await assert.rejects(readFile(join(f.root, "input")), { code: "ENOENT" });
  } finally {
    clearTimeout(timer);
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await exited;
  }
});

test("create prepares only missing private directories and does not manufacture history", async t => {
  const f = await fixture(t);
  await rm(f.configRoot, { recursive: true });
  await f.fake();
  const projects = join(f.configRoot, "projects"), project = join(projects, f.cwd.replace(/[^a-zA-Z0-9]/g, "-"));
  for (const path of [f.configRoot, projects, project]) assert.equal((await stat(path)).mode & 0o777, 0o700);
  await assert.rejects(readFile(join(project, `${f.descriptor.nativeSessionId}.jsonl`)), { code: "ENOENT" });
  await assert.rejects(readFile(join(f.root, "input")), { code: "ENOENT" });
});

test("preexisting nonprivate native directories are refused without chmod or native startup", async t => {
  const f = await fixture(t);
  const projects = join(f.configRoot, "projects"); await mkdir(projects); await chmod(projects, 0o755);
  await assert.rejects(f.fake(), /private and canonical/);
  assert.equal((await stat(projects)).mode & 0o777, 0o755);
  await assert.rejects(readFile(join(f.root, "pid")), { code: "ENOENT" });
});

test("opening snapshots caller launch identity/config before asynchronous filesystem reads", async t => {
  const f = await fixture(t);
  const config = { cwd: f.cwd, appendSystemPrompt: "original" };
  const descriptor = { ...f.descriptor };
  const pending = openClaudeCodeNativeSession(config, descriptor, { executable, env: f.env });
  config.cwd = "/"; config.appendSystemPrompt = "changed";
  descriptor.runtimeSessionId = "changed"; descriptor.nativeSessionId = randomUUID();
  const handle = f.remember(await pending);
  assert.equal(handle.session.id, "logical-runtime-id"); assert.equal(handle.session.cwd, f.cwd);
  await handle.startMappedTurn("caller", "hello", randomUUID());
  assert.equal((await terminal(handle, "caller"))?.status, "completed");
});

test("invalid first input, identities and explicit launch selections do not launch native work", async t => {
  const f = await fixture(t);
  await assert.rejects(f.fake({}, { ...f.descriptor, mode: "create", firstInput: "  " }), /required/);
  for (const patch of [{ nativeSessionId: "../native" }, { runtimeSessionId: undefined }, { runtimeSessionId: "../runtime" }, { mode: "unknown" }]) {
    await assert.rejects(f.fake({}, { ...f.descriptor, ...patch } as ClaudeCodeNativeOpen));
  }
  for (const config of [null, [], "not-config"]) await assert.rejects(openClaudeCodeNativeSession(config as any, f.descriptor, { executable, env: f.env }), /Invalid.*configuration/);
  // Selections are a feature now: a malformed one is refused before launch; a well-formed unsupported one only after discovery.
  await assert.rejects(openClaudeCodeNativeSession({ cwd: f.cwd, model: { provider: "other", id: "explicit" } }, f.descriptor, { executable, env: f.env }), /Unsupported/);
  await assert.rejects(readFile(join(f.root, "pid")), { code: "ENOENT" });
  await assert.rejects(openClaudeCodeNativeSession({ cwd: f.cwd, model: { provider: "anthropic", id: "explicit" } }, f.descriptor, { executable, env: f.env }), /Unsupported/);
  const started = Number(await readFile(join(f.root, "pid"), "utf8"));
  assert.throws(() => process.kill(started, 0), { code: "ESRCH" }, "the engine that refused the selection is confirmed gone");
});

test("unsupported native version refuses registration and confirms spawned-process shutdown", async t => {
  const f = await fixture(t);
  await assert.rejects(f.fake({ MINU_CLAUDE_FIXTURE_VERSION: "unknown" }), /Unsupported persistent Claude Code version/);
  const pid = Number(await readFile(join(f.root, "pid"), "utf8"));
  assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
  await assert.rejects(readFile(join(f.root, "input")), { code: "ENOENT" });
});

test("pre-abort and cancellation during startup preserve reason and confirm process cleanup", async t => {
  const f = await fixture(t);
  const controller = new AbortController(); const reason = new Error("cancel native opening"); controller.abort(reason);
  await assert.rejects(f.fake({}, { ...f.descriptor, signal: controller.signal }), error => error === reason);
  await assert.rejects(readFile(join(f.root, "pid")), { code: "ENOENT" });
  const inflight = new AbortController();
  const opening = f.fake({ MINU_CLAUDE_FIXTURE_MODE: "startup-hang" }, { ...f.descriptor, signal: inflight.signal });
  const rejected = assert.rejects(opening, error => error === reason);
  const pid = await until(() => readFile(join(f.root, "pid"), "utf8").catch(() => ""), value => !!value);
  inflight.abort(reason); await rejected;
  assert.throws(() => process.kill(Number(pid), 0), { code: "ESRCH" });
});

test("a launch cancellation signal cannot terminate later work after opening succeeds", async t => {
  const f = await fixture(t); const controller = new AbortController();
  const handle = await f.fake({}, { ...f.descriptor, signal: controller.signal });
  controller.abort(new Error("late launch cancellation"));
  await handle.startMappedTurn("later", "hello", randomUUID());
  assert.equal((await terminal(handle, "later"))?.status, "completed");
});

for (const [input, status, evidence] of [["hello", "completed", "native"], ["fail", "failed", "native"], ["crash", "failed", "uncertain"], ["malformed-result", "failed", "uncertain"]] as const) {
  test(`${input} distinguishes a native terminal frame from uncertain failure`, async t => {
    const f = await fixture(t); const handle = await f.fake();
    await handle.startMappedTurn("caller", input, randomUUID());
    assert.equal((await terminal(handle, "caller"))?.status, status);
    assert.equal(handle.evidence("caller"), evidence);
  });
}

test("definite queued cancellation and native interruption carry distinct settlement evidence", async t => {
  const f = await fixture(t); const handle = await f.fake();
  const starting = handle.startMappedTurn("queued", "hold", randomUUID());
  const cancel = handle.runtime.interrupt("logical-runtime-id");
  await Promise.all([starting, cancel]);
  assert.equal(handle.evidence("queued"), "undispatched");
  await assert.rejects(readFile(join(f.root, "input")), { code: "ENOENT" });
  await handle.startMappedTurn("active", "hold", randomUUID());
  await until(() => readFile(join(f.root, "input"), "utf8").catch(() => ""), value => value === "hold");
  await handle.runtime.interrupt("logical-runtime-id");
  assert.equal((await terminal(handle, "active"))?.status, "interrupted");
  assert.equal(handle.evidence("active"), "native");
});

test("busy stop and inconsistent native workspace metadata do not fabricate native settlement", async t => {
  const f = await fixture(t); const handle = await f.fake();
  await handle.startMappedTurn("busy", "hold", randomUUID());
  await until(() => readFile(join(f.root, "input"), "utf8").catch(() => ""), value => value === "hold");
  await handle.runtime.stop("logical-runtime-id");
  assert.equal((await handle.runtime.turn("logical-runtime-id", "busy"))?.status, "interrupted");
  assert.equal(handle.evidence("busy"), "uncertain");
  const other = await f.fake({ MINU_CLAUDE_FIXTURE_MODE: "wrong-workspace-init" });
  await other.startMappedTurn("wrong", "hello", randomUUID());
  assert.equal((await terminal(other, "wrong"))?.status, "failed");
  assert.equal(other.evidence("wrong"), "uncertain");
});
