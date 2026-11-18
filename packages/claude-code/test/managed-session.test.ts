import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { test, type TestContext } from "node:test";
import { RUNTIME_INPUT_LIMITS, type AgentEvent } from "@minu/runtime-core";
import { ClaudeCodeManagedStore, type ClaudeCodeManagedManifest } from "../src/managed-store.js";
import { createClaudeCodeManagedSession } from "../src/managed-session.js";
import { encodeClaudeCodeWorkerRegistration as encode, type ClaudeCodeWorkerRegistration, type ClaudeCodeWorkerRegistrationScope } from "../src/worker-registration.js";
import { createClaudeCodeWorkerBridge } from "../src/worker-bridge.js";
import { ClaudeCodeWorkerClient } from "../src/worker-client.js";
import { claudeCodeNativeProjectKey } from "../src/native-history.js";
import type { ClaudeCodeRuntimeOptions } from "../src/client.js";

async function until<T>(read: () => Promise<T>, done: (value: T) => boolean): Promise<T> {
  const end = Date.now() + 8_000;
  while (true) { const value = await read(); if (done(value)) return value; if (Date.now() > end) throw new Error("Managed session test timed out"); await delay(5); }
}
async function fixture(t: TestContext, extra: Omit<ClaudeCodeRuntimeOptions, "tools"> = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "claude-managed-session-")));
  const cwd = join(root, "workspace"), nativeRoot = join(root, "native");
  await mkdir(cwd, { mode: 0o700 }); await mkdir(nativeRoot, { mode: 0o700 });
  const storeRoot = join(root, "managed"), store = new ClaudeCodeManagedStore(storeRoot);
  const manifest: ClaudeCodeManagedManifest = { version: 3, runtime: "claude-code", id: "managed-session", ownerId: "owner",
    revision: 0, generation: "worker-generation", requiresExplicitResume: false, native: { state: "pending" },
    worker: { state: "none" }, lastDispatch: { state: "none" }, launchConfig: { cwd },
    policy: { configuration: "isolated", permissionMode: "default", nativeConfigRoot: nativeRoot, tools: [] }, createdAt: new Date().toISOString() };
  await store.create(manifest);
  const path = join(storeRoot, createHash("sha256").update(manifest.ownerId).digest("hex"), `${manifest.id}.session`, "manifest.json");
  const scope: ClaudeCodeWorkerRegistrationScope = { sessionId: manifest.id, ownerId: manifest.ownerId, generation: manifest.generation,
    reservationId: randomUUID(), workerExecutable: fileURLToPath(import.meta.url), cwd, nativeConfigRoot: nativeRoot };
  const pidFile = join(root, "pid"), inputFile = join(root, "input"), traceFile = join(root, "trace");
  const nativeOptions = { startupTimeoutMs: 5_000, controlTimeoutMs: 2_000, shutdownTimeoutMs: 5_000,
    executable: fileURLToPath(new URL("./fixtures/managed-native.js", import.meta.url)), ...extra,
    env: { PATH: process.env.PATH, HOME: root, CLAUDE_CONFIG_DIR: nativeRoot, ANTHROPIC_API_KEY: "dummy-local-only",
      ANTHROPIC_BASE_URL: "http://127.0.0.1:1", CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      MINU_CLAUDE_FIXTURE_PID: pidFile, MINU_CLAUDE_FIXTURE_INPUT: inputFile, MINU_CLAUDE_MANIFEST: path, MINU_CLAUDE_TRACE: traceFile, ...extra.env } };
  const handle = createClaudeCodeManagedSession({ store, scope, nativeOptions });
  let cleanup = false, allowUnconfirmed = false;
  // The fixture owns listener disposal after metadata revocation; normal routes always admit.
  const runtime = new Proxy(handle.runtime, { get(target, key) {
    if (key === "stop" && cleanup) return async () => {};
    const value = Reflect.get(target, key, target); return typeof value === "function" ? value.bind(target) : value;
  } });
  const bridge = await createClaudeCodeWorkerBridge({ ...scope, token: "a".repeat(64), nativeSessionId: manifest.id, runtime,
    admit: operation => cleanup ? operation() : handle.admit(operation) });
  const registration: ClaudeCodeWorkerRegistration = { version: 1, runtime: "claude-code", ownership: "owned", ...scope,
    pid: process.pid, processGroupId: null, endpoint: bridge.connection.endpoint, token: bridge.connection.token, createdAt: new Date().toISOString() };
  await store.withSessionLock(manifest.id, manifest.ownerId, async lease => {
    await lease.reserveWorker(0, scope.generation, scope.reservationId, scope.workerExecutable);
    await lease.beginWorkerStart(1, scope.generation, scope.reservationId);
    await lease.recordWorkerProcess(2, scope.generation, scope.reservationId, process.pid, null);
    await lease.publishWorker(3, scope.generation, scope.reservationId, encode(registration, scope));
  });
  const read = async () => (await store.read(manifest.id, manifest.ownerId))!;
  const proveNativeGone = async () => {
    let pid: number; try { pid = Number(await readFile(pidFile, "utf8")); } catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return; throw e; }
    await until(async () => { try { process.kill(pid, 0); return false; } catch (e) { if ((e as NodeJS.ErrnoException).code === "ESRCH") return true; throw e; } }, Boolean);
  };
  t.after(async () => {
    cleanup = true; await chmod(dirname(path), 0o700);
    try { await handle.closeOwnedNative(); }
    catch (error) { if (!allowUnconfirmed) throw error; assert.match(String(error), /native shutdown is unconfirmed/); }
    finally { await proveNativeGone(); await bridge.close(); await rm(root, { recursive: true, force: true }); }
  });
  const client = new ClaudeCodeWorkerClient(bridge.connection, 10_000);
  const initialize = () => handle.initialize(encode(registration, scope));
  const terminal = (id: string) => until(() => client.turn(id), turn => !!turn && turn.status !== "running");
  const trace = async () => {
    try { return (await readFile(traceFile, "utf8")).trim().split("\n").map(line => JSON.parse(line)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
  };
  const seed = async () => {
    const nativeId = randomUUID(), user = randomUUID(), directory = join(nativeRoot, "projects", claudeCodeNativeProjectKey(cwd));
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const rows = [
      { type: "user", message: { role: "user", content: "history input" }, uuid: user, parentUuid: null },
      { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "history answer" }] }, uuid: randomUUID(), parentUuid: user },
    ].map(row => ({ ...row, sessionId: nativeId, cwd, version: "2.1.321", isSidechain: false, timestamp: new Date().toISOString() }));
    await writeFile(join(directory, `${nativeId}.jsonl`), rows.map(row => JSON.stringify(row)).join("\n") + "\n", { mode: 0o600 });
    const current = await read();
    await writeFile(path, JSON.stringify({ ...current, native: { state: "bound", sessionId: nativeId },
      lastDispatch: { state: "settled", generation: "prior-worker", turnId: "prior-turn", fingerprint: createHash("sha256").update("history input").digest("hex"), nativeMessageId: randomUUID(), outcome: "completed" } }));
    return nativeId;
  };
  return { root, cwd, nativeRoot, path, store, manifest, scope, registration, nativeOptions, handle, client, initialize,
    read, terminal, trace, seed, pidFile, inputFile, allowUnconfirmed: () => { allowUnconfirmed = true; } };
}

test("managed pending worker allocates nothing until valid input, then binds and persists intent BEFORE actual SDK dispatch", async t => {
  const f = await fixture(t); await f.initialize();
  assert.equal(await f.client.status(), "idle");
  assert.deepEqual(await f.client.messages(), []);
  for (const input of ["", "  ", "x".repeat(RUNTIME_INPUT_LIMITS.textBytes + 1)]) await assert.rejects(f.client.startTurn("invalid", input));
  await assert.rejects(f.client.startTurn("image", "", [{ type: "image", mimeType: "image/png",
    data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jR0cAAAAASUVORK5CYII=" }]));
  await assert.rejects(readFile(f.pidFile), { code: "ENOENT" });
  assert.deepEqual((await f.read()).native, { state: "pending" });
  assert.equal((await f.read()).revision, 4);
  await f.client.startTurn("one", "hello");
  const turn = await f.terminal("one"); assert.equal(turn?.status, "completed"); assert.equal(turn.response?.content, "reply: hello");
  const saved = await f.read(), traces = await f.trace();
  assert.equal(saved.native.state, "bound"); assert.equal(saved.lastDispatch.state, "settled");
  assert.equal(saved.revision, 8); assert.equal(traces.length, 1);
  assert.equal(traces[0].native.state, "bound"); assert.equal(traces[0].dispatch.state, "dispatching");
  assert.equal(traces[0].dispatch.turnId, "one"); assert.equal(traces[0].dispatch.nativeMessageId, traces[0].messageId);
  assert.equal(traces[0].native.sessionId, traces[0].sessionId); assert.notEqual(traces[0].sessionId, f.manifest.id);
  assert.equal((await f.client.startTurn("one", "hello")).status, "completed");
  await assert.rejects(f.client.startTurn("one", "different"));
  const fresh = new ClaudeCodeWorkerClient(f.registration); assert.equal((await fresh.turn("one"))?.response?.content, "reply: hello");
  assert.equal((await f.trace()).length, 1);
});

for (const populated of [false, true]) {
  test(`idle quiesce preserves managed metadata and confirms captured native stop (${populated ? "completed turn" : "pending"})`, async t => {
    const f = await fixture(t); await f.initialize();
    if (populated) await f.client.send("before quiesce");
    const before = await f.read();
    const pid = populated ? Number(await readFile(f.pidFile, "utf8")) : undefined;
    await f.client.requestQuiesceIdle();
    if (pid !== undefined) assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
    else await assert.rejects(readFile(f.pidFile), { code: "ENOENT" });
    assert.equal(await f.client.status(), "offline");
    await assert.rejects(f.client.startTurn("late", "never dispatched"));
    assert.deepEqual(await f.read(), before);
    // The authenticated listener still answers; this is not worker/group exit proof.
  });
}

test("close during first-input creation persistence prevents native opening and preserves uncertainty", async t => {
  const f = await fixture(t); await f.initialize();
  const admission = f.store.withWorkerAdmission.bind(f.store);
  let release!: () => void, held = false;
  const gate = new Promise<void>(resolve => { release = resolve; });
  f.store.withWorkerAdmission = (scope, payload, operation) => admission(scope, payload, (lease, manifest) => operation({
    ...lease,
    beginNativeCreation: async (revision, nativeId) => {
      const saved = await lease.beginNativeCreation(revision, nativeId);
      held = true; await gate; return saved;
    },
  }, manifest));
  let sending: ReturnType<typeof f.client.startTurn> | undefined;
  try {
    sending = f.client.startTurn("cancelled", "hello"); void sending.catch(() => {});
    await until(async () => held, Boolean);
    const persisted = await f.read();
    assert.equal(persisted.native.state, "creating"); assert.equal(persisted.revision, 5);
    assert.equal(persisted.lastDispatch.state, "none");
    await f.handle.closeOwnedNative();
    await assert.rejects(readFile(f.pidFile), { code: "ENOENT" });
    release();
    const failed = await sending;
    assert.equal(failed.status, "failed"); assert.equal(failed.response, undefined);
    // Check before the fixture's second cleanup; a late child is not acceptable
    // merely because the preparation catch would subsequently stop it.
    await assert.rejects(readFile(f.pidFile), { code: "ENOENT" });
    await assert.rejects(readFile(f.inputFile), { code: "ENOENT" });
    assert.deepEqual(await f.trace(), []);
    assert.deepEqual(await f.read(), persisted);
    assert.deepEqual(await f.client.startTurn("cancelled", "hello"), failed);
    await assert.rejects(f.client.startTurn("replacement", "new"));
  } finally {
    release(); await sending?.catch(() => {}); f.store.withWorkerAdmission = admission;
  }
});

test("the facade preserves actual loopback text/tool streams and curated activity without duplicate turn events", async t => {
  const f = await fixture(t); await f.initialize();
  const abort = new AbortController();
  const iterator = f.client.events(abort.signal)[Symbol.asyncIterator]();
  const seen: AgentEvent[] = [], chunks: string[] = [];
  assert.equal((await iterator.next()).value?.type, "status");
  const eventPump = (async () => { try { while (true) { const next = await iterator.next(); if (next.done) break; seen.push(next.value); } } catch { if (!abort.signal.aborted) throw new Error("Event stream failed"); } })();
  // Await flushed headers so activity subscription is established before first input.
  const response = await fetch(`${f.registration.endpoint}/activity`, { signal: abort.signal,
    headers: { authorization: `Bearer ${f.registration.token}`, "x-minu-runtime-session": f.scope.sessionId,
      "x-minu-runtime-owner": f.scope.ownerId, "x-minu-runtime-generation": f.scope.generation } });
  assert.equal(response.status, 200);
  const activityPump = (async () => { try { for await (const chunk of response.body!) chunks.push(Buffer.from(chunk).toString()); }
    catch { if (!abort.signal.aborted) throw new Error("Activity stream failed"); } })();
  try {
    await f.client.startTurn("streamed", "tool"); await f.terminal("streamed");
    await f.client.startTurn("streamed-next", "after"); await f.terminal("streamed-next");
    await until(async () => seen, values => values.filter(event => event.type === "turn_completed").length === 2);
    await until(async () => chunks.join(""), text => text.includes("responding"));
    assert.equal(seen.filter(event => event.type === "turn_started").length, 2);
    assert.equal(seen.filter(event => event.type === "turn_completed").length, 2);
    assert.ok(seen.some(event => event.type === "message_delta"));
    assert.ok(seen.some(event => event.type === "tool_started")); assert.ok(seen.some(event => event.type === "tool_completed"));
    let active: string | undefined;
    for (const event of seen) {
      if (event.type === "turn_started") { assert.equal(active, undefined); active = event.operationId; }
      if (["message_delta", "tool_started", "tool_completed"].includes(event.type)) assert.ok(active, "Raw frames must precede their terminal event");
      if (event.type === "message_delta") assert.equal(event.delta, active === "streamed" ? "reply: tool" : "reply: after");
      if (event.type === "turn_completed") { assert.equal(event.operationId, active); active = undefined; }
    }
    assert.ok(seen.every(event => event.sessionId === f.manifest.id));
    for (const line of chunks.join("").trim().split("\n")) {
      const value = JSON.parse(line).value;
      assert.deepEqual(Object.keys(value).sort(), ["observedAt", "phase"]);
    }
  } finally { abort.abort(); await Promise.all([eventPump, activityPump]); await iterator.return?.(); }
});

test("only admitted async call chains can use the lease, and descendant contexts expire", async t => {
  const f = await fixture(t); await f.initialize();
  await assert.rejects(f.handle.runtime.status(f.manifest.id), /requires current worker admission/);
  let inside!: () => void, release!: () => void;
  const entered = new Promise<void>(resolve => { inside = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
  const held = f.handle.admit(async () => { inside(); await gate; }); await entered;
  try { await assert.rejects(f.handle.runtime.startTurn(f.manifest.id, "borrowed", "wrong"), /requires current worker admission/); }
  finally { release(); await held; }
  let late!: () => Promise<void>;
  const later = new Promise<void>(resolve => { late = async () => { await assert.rejects(f.handle.runtime.status(f.manifest.id), /requires current worker admission/); resolve(); }; });
  let run!: () => void;
  const trigger = new Promise<void>(resolve => { run = resolve; });
  await f.handle.admit(async () => { void trigger.then(late); }); run(); await later;
  assert.equal((await f.read()).revision, 4);
});

test("initialization is single-epoch, self-PID bound and rejects an uninitialized bridge", async t => {
  const f = await fixture(t);
  await assert.rejects(f.client.status());
  const wrong = createClaudeCodeManagedSession({ store: f.store, scope: f.scope, nativeOptions: f.nativeOptions });
  await assert.rejects(wrong.initialize(encode({ ...f.registration, pid: process.pid + 1 }, f.scope)), /registered worker process/);
  await f.initialize(); await assert.rejects(f.initialize(), /already attempted/);
  const duplicate = createClaudeCodeManagedSession({ store: f.store, scope: f.scope, nativeOptions: f.nativeOptions });
  await assert.rejects(duplicate.initialize(encode(f.registration, f.scope)), /already claimed/);
  await wrong.closeOwnedNative(); await duplicate.closeOwnedNative();
});

test("busy retries stay on their retained input and interrupt acknowledgment alone cannot settle dispatch", async t => {
  const f = await fixture(t, { env: { MINU_CLAUDE_FIXTURE_MODE: "interrupt-no-result" } }); await f.initialize();
  await f.client.startTurn("held", "hold");
  assert.equal((await f.client.startTurn("held", "hold")).status, "running");
  await assert.rejects(f.client.startTurn("other", "next"));
  await assert.rejects(f.client.startTurn("held", "changed"));
  await until(f.trace, values => values.length === 1);
  await f.client.interrupt("held");
  assert.equal((await f.client.turn("held"))?.status, "running"); assert.equal((await f.read()).lastDispatch.state, "dispatching");
  await f.client.requestStop();
  assert.equal((await f.terminal("held"))?.status, "failed");
  assert.equal((await f.read()).lastDispatch.state, "dispatching");
});

test("observed native interrupted and failed results settle the exact persisted dispatch", async t => {
  const f = await fixture(t); await f.initialize();
  await f.client.startTurn("held", "hold"); await until(f.trace, values => values.length === 1);
  await f.client.interrupt("held"); assert.equal((await f.terminal("held"))?.status, "interrupted");
  let saved = await f.read(); assert.equal(saved.lastDispatch.state, "settled");
  if (saved.lastDispatch.state === "settled") assert.equal(saved.lastDispatch.outcome, "interrupted");
  await f.client.startTurn("failure", "fail"); assert.equal((await f.terminal("failure"))?.status, "failed");
  saved = await f.read(); if (saved.lastDispatch.state === "settled") assert.equal(saved.lastDispatch.outcome, "failed");
  assert.equal((await f.trace()).length, 2);
});

test("native crash remains uncertain, retains the failed caller result and never admits replacement input", async t => {
  const f = await fixture(t); await f.initialize();
  await f.client.startTurn("crashed", "crash"); assert.equal((await f.terminal("crashed"))?.status, "failed");
  assert.equal((await f.read()).lastDispatch.state, "dispatching"); assert.equal(await f.client.status(), "offline");
  assert.equal((await f.client.startTurn("crashed", "crash")).status, "failed");
  await assert.rejects(f.client.startTurn("replacement", "new")); assert.equal((await f.trace()).length, 1);
});

test("failed lazy startup keeps its failed caller record and creating uncertainty without reopening", async t => {
  const f = await fixture(t, { env: { MINU_CLAUDE_FIXTURE_MODE: "startup-exit" } }); f.allowUnconfirmed(); await f.initialize();
  assert.equal((await f.client.startTurn("startup", "hello")).status, "failed");
  assert.equal((await f.read()).native.state, "creating"); assert.equal((await f.read()).lastDispatch.state, "none");
  assert.equal((await f.client.startTurn("startup", "hello")).status, "failed");
  await assert.rejects(f.client.startTurn("replacement", "new")); await assert.rejects(readFile(f.inputFile), { code: "ENOENT" });
  await assert.rejects(f.handle.closeOwnedNative(), /shutdown is unconfirmed/);
});

for (const sequence of ["close-before-init", "close-while-init-is-queued"]) {
  test(`stopped initialization never spawns native history: ${sequence}`, async t => {
    const f = await fixture(t); await f.seed();
    const before = await f.read();
    let refused!: Promise<void>;
    if (sequence === "close-before-init") {
      await f.handle.closeOwnedNative();
      refused = assert.rejects(f.initialize(), /stopped during initialization/);
    } else {
      // Hold the real lease. initialize() has passed any entry-only checks before
      // close wins, and cannot proceed to native opening until this callback exits.
      await f.store.withSessionLock(f.manifest.id, f.manifest.ownerId, async () => {
        refused = assert.rejects(f.initialize(), /stopped during initialization/);
        await f.handle.closeOwnedNative();
      });
    }
    await refused;
    // Assert before the fixture's second cleanup; it must not hide a late child.
    await assert.rejects(readFile(f.pidFile), { code: "ENOENT" });
    await assert.rejects(readFile(f.inputFile), { code: "ENOENT" });
    assert.deepEqual(await f.trace(), []);
    assert.deepEqual(await f.read(), before);
    await assert.rejects(f.handle.admit(() => f.handle.runtime.status(f.manifest.id)), /not initialized/);
    await assert.rejects(f.initialize(), /already attempted/);
  });
}

test("bound initialization reopens only exact validated history, with no replay or reconstructed caller result", async t => {
  const f = await fixture(t); const nativeId = await f.seed(); await f.initialize();
  assert.deepEqual((await f.client.messages()).map(m => m.content), ["history input", "history answer"]);
  assert.equal(await f.client.turn("prior-turn"), undefined);
  await assert.rejects(f.client.startTurn("prior-turn", "history input"));
  await assert.rejects(readFile(f.inputFile), { code: "ENOENT" });
  await f.client.startTurn("next", "fresh"); assert.equal((await f.terminal("next"))?.status, "completed");
  const traces = await f.trace(); assert.equal(traces.length, 1); assert.equal(traces[0].sessionId, nativeId);
});

test("allocation, empty-binding and dispatch uncertainty refuse initialization before native resume", async t => {
  for (const mode of ["creating", "empty-bound", "dispatching"]) {
    const f = await fixture(t), current = await f.read();
    const uncertain: ClaudeCodeManagedManifest = { ...current, native: { state: mode === "creating" ? "creating" : "bound", sessionId: randomUUID() },
      lastDispatch: mode === "dispatching" ? { state: "dispatching", turnId: "prior", fingerprint: "a".repeat(64),
        nativeMessageId: randomUUID(), generation: current.generation } : { state: "none" } };
    await writeFile(f.path, JSON.stringify(uncertain));
    await assert.rejects(f.initialize(), /uncertain/);
    await assert.rejects(readFile(f.pidFile), { code: "ENOENT" }); assert.deepEqual(await f.read(), uncertain);
  }
});

test("missing bound history is unavailable rather than fallback creation", async t => {
  const f = await fixture(t); const nativeId = await f.seed();
  await rm(join(f.nativeRoot, "projects", claudeCodeNativeProjectKey(f.cwd), `${nativeId}.jsonl`));
  f.allowUnconfirmed(); await assert.rejects(f.initialize(), /native history is missing/);
  await assert.rejects(readFile(f.pidFile), { code: "ENOENT" });
  assert.deepEqual((await f.read()).native, { state: "bound", sessionId: nativeId });
});

test("recovery/generation/policy changes reject subsequent commands without dispatch", async t => {
  for (const mode of ["recovery", "generation", "policy"]) {
    const f = await fixture(t); await f.initialize();
    if (mode === "policy") {
      const current = await f.read();
      await writeFile(f.path, JSON.stringify({ ...current, launchConfig: { ...current.launchConfig, appendSystemPrompt: "changed" } }));
    } else await f.store.update(f.manifest.id, f.manifest.ownerId, 4, mode === "recovery" ? { requiresExplicitResume: true } : { generation: "revoked" });
    await assert.rejects(f.client.startTurn("blocked", "hello")); await assert.rejects(readFile(f.pidFile), { code: "ENOENT" });
  }
});

test("unsupported launch intentions and unsafe environments refuse before native allocation", async t => {
  for (const mode of ["native-policy", "default-tools", "model", "override", "replay", "root"]) {
    const env = mode === "override" ? { CLAUDE_CODE_PROJECT_DIR_NAME: "" } : mode === "replay" ? { CLAUDE_CODE_RESUME_INTERRUPTED_TURN: "0" }
      : mode === "root" ? { CLAUDE_CONFIG_DIR: "/other" } : {};
    const f = await fixture(t, { env }); const current = await f.read();
    if (mode === "native-policy" || mode === "default-tools" || mode === "model") {
      await writeFile(f.path, JSON.stringify({ ...current,
        ...(mode === "model" ? { launchConfig: { ...current.launchConfig, model: { provider: "anthropic", id: "unimplemented" } } }
          : { policy: { ...current.policy, ...(mode === "native-policy" ? { configuration: "native" } : { tools: null }) } }) }));
    }
    await assert.rejects(f.initialize()); await assert.rejects(readFile(f.pidFile), { code: "ENOENT" });
    assert.deepEqual((await f.read()).native, { state: "pending" }); assert.equal((await f.read()).lastDispatch.state, "none");
  }
});

test("constructor environment snapshot cannot be redirected by later caller mutation", async t => {
  const f = await fixture(t);
  Object.assign(f.nativeOptions.env, { CLAUDE_CONFIG_DIR: "/other", CLAUDE_CODE_PROJECT_DIR_NAME: "redirect" });
  await f.initialize(); await f.client.startTurn("snapshot", "hello");
  assert.equal((await f.terminal("snapshot"))?.status, "completed");
});

test("different JS text with the same lossy UTF8 digest cannot reuse a retained caller ID", async t => {
  const f = await fixture(t); await f.initialize();
  const original = "text-\ud800", different = "text-\ud801";
  assert.equal(createHash("sha256").update(original).digest("hex"), createHash("sha256").update(different).digest("hex"));
  await f.client.startTurn("exact-text", original); await f.terminal("exact-text");
  await assert.rejects(f.client.startTurn("exact-text", different));
  assert.equal((await f.trace()).length, 1);
});

test("retention is bounded by worker lifetime, never by silently evicting accepted caller IDs", async t => {
  const f = await fixture(t, { turnRetentionLimit: 1 }); await f.initialize();
  await f.client.startTurn("one", "hello"); await f.terminal("one");
  await assert.rejects(f.client.startTurn("two", "next"));
  assert.equal((await f.client.startTurn("one", "hello")).status, "completed"); assert.equal((await f.trace()).length, 1);
});

test("binding publication failure retains caller lookup and creating uncertainty after native cleanup", { skip: process.getuid?.() === 0 }, async t => {
  const f = await fixture(t, { env: { MINU_CLAUDE_DENY_BINDING: "1" } }); await f.initialize();
  assert.equal((await f.client.startTurn("binding", "hello")).status, "failed");
  assert.equal((await f.client.turn("binding"))?.status, "failed");
  assert.equal((await f.client.startTurn("binding", "hello")).status, "failed");
  const saved = await f.read(); assert.equal(saved.native.state, "creating"); assert.equal(saved.lastDispatch.state, "none");
  await assert.rejects(readFile(f.inputFile), { code: "ENOENT" });
});

test("exceptional native observation cannot settle from completed evidence or erase a prior result", async t => {
  const f = await fixture(t); await f.initialize();
  const admission = f.store.withWorkerAdmission.bind(f.store);
  let injected = false, settleAttempts = 0, dispatching: ClaudeCodeManagedManifest | undefined;
  f.store.withWorkerAdmission = (scope, payload, operation) => admission(scope, payload, (lease, manifest) => operation({
    ...lease,
    bindNativeSession: async (...args) => {
      const saved = await lease.bindNativeSession(...args);
      // Wrap only the actual native event subscription before the driver installs
      // it. Native producer, result/evidence and persistence stay unstubbed.
      const native = Reflect.get(f.handle.runtime, "native") as Awaited<ReturnType<typeof import("../src/native-session.js").openClaudeCodeNativeSession>>;
      const events = native.runtime.events.bind(native.runtime);
      native.runtime.events = async function* (id) {
        let observed: string | undefined;
        for await (const frame of events(id)) {
          if (frame.type === "turn_started") observed = frame.operationId;
          if (frame.type === "message_delta" && observed === "result") {
            await until(async () => native.evidence("result"), value => value === "native");
            assert.equal((await native.runtime.turn(id, "result"))?.response?.content, "reply: hello");
            injected = true;
            throw new Error("PRIVATE_NATIVE_OBSERVATION_FAILURE");
          }
          yield frame;
        }
      };
      return saved;
    },
    beginDispatch: async (...args) => {
      const saved = await lease.beginDispatch(...args);
      if (args[2].turnId === "result") dispatching = saved;
      return saved;
    },
    settleDispatch: (...args) => {
      if (args[2].turnId === "result") settleAttempts++;
      return lease.settleDispatch(...args);
    },
  }, manifest));
  const abort = new AbortController(), iterator = f.client.events(abort.signal)[Symbol.asyncIterator]();
  const events: AgentEvent[] = [];
  assert.equal((await iterator.next()).value?.type, "status");
  const pump = (async () => {
    try { for await (const event of { [Symbol.asyncIterator]: () => iterator }) events.push(event); }
    catch (error) { if (!abort.signal.aborted) throw error; }
  })();
  void pump.catch(() => {});
  try {
    await f.client.startTurn("prior", "before");
    const prior = await f.terminal("prior"); assert.equal(prior?.status, "completed");
    await f.client.startTurn("result", "hello");
    const result = await f.terminal("result");
    assert.equal(injected, true);
    assert.equal(result?.status, "failed"); assert.equal(result.response, undefined);
    assert.match(result.error!, /observation unavailable.*uncertain/);
    assert.equal(await f.client.status(), "offline");
    await until(async () => events, values => values.some(e => e.type === "error" && e.operationId === "result"));
    const started = events.findIndex(e => e.type === "turn_started" && e.operationId === "result");
    assert.ok(started >= 0);
    assert.equal(events.slice(started).some(e => e.type === "message_delta"), false);
    assert.equal(events.some(e => e.type === "turn_completed" && e.operationId === "result"), false);
    assert.doesNotMatch(JSON.stringify({ result, events }), /PRIVATE_NATIVE_OBSERVATION_FAILURE/);
    assert.ok(dispatching); assert.equal(dispatching.lastDispatch.state, "dispatching");
    assert.deepEqual(await f.read(), dispatching); assert.equal(settleAttempts, 0);
    assert.deepEqual(await f.client.startTurn("result", "hello"), result);
    await assert.rejects(f.client.startTurn("replacement", "new"));
    assert.deepEqual(await f.client.turn("prior"), prior);
    assert.deepEqual(await f.client.startTurn("prior", "before"), prior);
    assert.equal((await f.trace()).length, 2);
    const pid = Number(await readFile(f.pidFile, "utf8"));
    assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
  } finally {
    abort.abort(); await pump; await iterator.return?.(); f.store.withWorkerAdmission = admission;
  }
});

test("lost settlement confirmation cannot publish success or replay an actually committed outcome", async t => {
  const f = await fixture(t); await f.initialize();
  const admission = f.store.withWorkerAdmission.bind(f.store);
  let committed: ClaudeCodeManagedManifest | undefined, settleCalls = 0;
  f.store.withWorkerAdmission = (scope, payload, operation) => admission(scope, payload, (lease, manifest) => operation({
    ...lease,
    settleDispatch: async (...args) => {
      settleCalls++;
      committed = await lease.settleDispatch(...args);
      throw new Error("PRIVATE_SETTLEMENT_CONFIRMATION");
    },
  }, manifest));
  const abort = new AbortController(), iterator = f.client.events(abort.signal)[Symbol.asyncIterator]();
  const events: AgentEvent[] = [];
  assert.equal((await iterator.next()).value?.type, "status");
  const pump = (async () => {
    try { for await (const event of { [Symbol.asyncIterator]: () => iterator }) events.push(event); }
    catch (error) { if (!abort.signal.aborted) throw error; }
  })();
  void pump.catch(() => {});
  try {
    await f.client.startTurn("result", "hello");
    const result = await f.terminal("result");
    assert.equal(result?.status, "failed"); assert.equal(result.response, undefined);
    assert.match(result.error!, /uncertain/); assert.equal(await f.client.status(), "offline");
    await until(async () => events, values => values.some(event => event.type === "error"));
    assert.equal(events.some(event => event.type === "turn_completed"), false);
    assert.doesNotMatch(JSON.stringify({ result, events }), /PRIVATE_SETTLEMENT_CONFIRMATION/);
    assert.ok(committed); assert.deepEqual(await f.read(), committed);
    assert.equal(committed.lastDispatch.state, "settled");
    if (committed.lastDispatch.state === "settled") {
      assert.equal(committed.lastDispatch.outcome, "completed");
      assert.equal(committed.lastDispatch.turnId, "result");
    }
    assert.deepEqual(await f.client.startTurn("result", "hello"), result);
    await assert.rejects(f.client.startTurn("result", "changed"));
    await assert.rejects(f.client.startTurn("replacement", "new"));
    assert.equal(settleCalls, 1); assert.equal((await f.trace()).length, 1);
    assert.deepEqual(await f.read(), committed);
  } finally {
    abort.abort(); await pump; await iterator.return?.(); f.store.withWorkerAdmission = admission;
  }
});

test("settlement persistence failure cannot publish native success or reset dispatch intent", { skip: process.getuid?.() === 0 }, async t => {
  const f = await fixture(t, { env: { MINU_CLAUDE_DENY_SETTLEMENT: "1" } }); await f.initialize();
  await f.client.startTurn("result", "hello");
  const result = await f.terminal("result"); assert.equal(result?.status, "failed"); assert.equal(result.response, undefined);
  assert.match(result.error!, /uncertain/); assert.equal((await f.read()).lastDispatch.state, "dispatching");
  assert.equal((await f.client.startTurn("result", "hello")).status, "failed"); assert.equal((await f.trace()).length, 1);
});
