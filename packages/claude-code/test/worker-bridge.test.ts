import assert from "node:assert/strict";
import { execFile, fork } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { test, type TestContext } from "node:test";
import type { AgentEvent, RuntimeActivityEvent } from "@minu/runtime-core";
import { ClaudeCodeWorkerClient } from "../src/worker-client.js";
import { nativeHistoryProvider } from "./fixtures/native-history-provider.js";
import { ClaudeCodeWorkerError, CLAUDE_WORKER_LIMITS, type ClaudeCodeWorkerConnection } from "../src/worker-protocol.js";

async function until<T>(read: () => Promise<T>, done: (value: T) => boolean): Promise<T> {
  const end = Date.now() + 5_000;
  while (true) {
    const value = await read();
    if (done(value)) return value;
    if (Date.now() > end) throw new Error("Worker test condition timed out");
    await delay(10);
  }
}
const errorStatus = (status: number) => (error: unknown) => error instanceof ClaudeCodeWorkerError && error.status === status;

test("stream cancellation settles an idle reader even after garbage collection", async () => {
  await new Promise<void>((resolve, reject) => {
    execFile(process.execPath, ["--expose-gc", fileURLToPath(new URL("./fixtures/gc-stream-cancel.js", import.meta.url))],
      { timeout: 5_000 }, error => error ? reject(error) : resolve());
  });
});

async function fixture(t: TestContext, nativeProvider?: string) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "claude-worker-bridge-")));
  const child = fork(new URL("./fixtures/worker-peer.js", import.meta.url), [], {
    stdio: ["ignore", "ignore", "ignore", "ipc"],
    env: { PATH: process.env.PATH, HOME: directory, CLAUDE_CONFIG_DIR: join(directory, "config"),
      MINU_CLAUDE_FIXTURE_PID: join(directory, "native-pid"), MINU_CLAUDE_FIXTURE_INPUT: join(directory, "input"),
      ...(nativeProvider ? { ANTHROPIC_API_KEY: "local-synthetic-only", ANTHROPIC_BASE_URL: nativeProvider,
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1" } : {}) },
  });
  const exited = once(child, "exit");
  t.after(async () => {
    try {
      if (child.exitCode === null && child.signalCode === null) child.send({ type: "close" });
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([exited, new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("Fixture cleanup timed out")), 5_000);
        })]);
      } finally { clearTimeout(timer); }
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await exited;
      await rm(directory, { recursive: true, force: true });
    }
  });
  const ready = once(child, "message");
  child.send({ type: "start", cwd: directory, executable: nativeProvider ? "bundled" : fileURLToPath(new URL("./fixtures/claude.js", import.meta.url)),
    identity: { sessionId: "logical-runtime-id", ownerId: "owner-a", generation: "generation-a" } });
  const [message] = await Promise.race([ready, exited.then(() => { throw new Error("Worker exited before ready"); })]);
  assert.equal(message.type, "ready");
  const connection = message.connection as ClaudeCodeWorkerConnection;
  return { child, exited, connection, directory, client: new ClaudeCodeWorkerClient(connection),
    headers: { authorization: `Bearer ${connection.token}`, "x-minu-runtime-session": connection.sessionId,
      "x-minu-runtime-owner": connection.ownerId, "x-minu-runtime-generation": connection.generation } };
}

test("real worker/HTTP boundary retains running turns across an actual consumer process exit", { timeout: 15_000 }, async t => {
  const f = await fixture(t);
  const consumer = fork(new URL("./fixtures/worker-consumer.js", import.meta.url), [], { stdio: ["ignore", "ignore", "ignore", "ipc"] });
  const consumerExit = once(consumer, "exit");
  try {
    const accepted = once(consumer, "message"); consumer.send(f.connection);
    const [message] = await accepted;
    assert.equal(message.type, "accepted");
    assert.equal((await consumerExit)[0], 0);
    const reconnected = new ClaudeCodeWorkerClient(f.connection);
    const recovered = await reconnected.turn("retained-turn");
    assert.equal(recovered?.status, "running");
    assert.deepEqual(await reconnected.startTurn("retained-turn", "hold"), recovered);
    await assert.rejects(reconnected.startTurn("retained-turn", "changed"), errorStatus(409));
    await assert.rejects(reconnected.startTurn("new", "new input"), errorStatus(409));
    assert.equal((await reconnected.messages()).filter(m => m.role === "user").length, 1);
    await reconnected.interrupt("retained-turn");
    assert.equal((await until(() => reconnected.turn("retained-turn"), turn => turn?.status === "interrupted"))?.status, "interrupted");
    await reconnected.send("after reconnect");
    assert.equal(await reconnected.status(), "idle");
    assert.equal((await reconnected.sessionCapabilities())?.reconnectExisting, true);
  } finally { consumer.kill("SIGKILL"); await consumerExit; }
});

test("bundled native engine runs through the real worker/HTTP boundary with a synthetic local provider", { timeout: 30_000 }, async t => {
  const provider = await nativeHistoryProvider();
  t.after(() => provider.close());
  const f = await fixture(t, provider.url);
  const abort = new AbortController();
  const iterator = f.client.events(abort.signal)[Symbol.asyncIterator]();
  await iterator.next();
  const events: AgentEvent[] = [];
  const reading = (async () => { for await (const event of { [Symbol.asyncIterator]: () => iterator }) events.push(event); })();
  try {
    await f.client.send("native worker first turn");
    const otherConsumer = new ClaudeCodeWorkerClient(f.connection);
    await otherConsumer.startTurn("native-worker-second", "native worker second turn");
    const second = await until(() => otherConsumer.turn("native-worker-second"), value => value?.status === "completed");
    assert.equal(second?.response?.content, "history reply 2");
    assert.deepEqual((await otherConsumer.messages()).filter(value => value.role === "assistant").map(value => value.content), ["history reply 1", "history reply 2"]);
    assert.equal(provider.calls(), 2);
    assert.ok(events.some(event => event.type === "message_delta"));
    assert.ok(events.every(event => event.sessionId === f.connection.sessionId));
  } finally { abort.abort(); await reading; }
});

test("token, exact owner, logical session and generation are checked on reads and mutations", async t => {
  const f = await fixture(t);
  for (const patch of [{ token: "0".repeat(64) }, { ownerId: "owner-b" }, { sessionId: "other-session" }, { generation: "stale-generation" }]) {
    const client = new ClaudeCodeWorkerClient({ ...f.connection, ...patch });
    await assert.rejects(client.status(), errorStatus(401));
    await assert.rejects(client.startTurn("denied", "must not dispatch"), errorStatus(401));
  }
  const fenced = once(f.child, "message"); f.child.send({ type: "fence" }); await fenced;
  await assert.rejects(f.client.startTurn("stale", "must not dispatch"), errorStatus(409));
  await assert.rejects(readFile(join(f.directory, "input")), { code: "ENOENT" });
});

test("normalized events use only logical identity; safe activity and cancellation cross the wire", async t => {
  const f = await fixture(t);
  const abort = new AbortController();
  const iterator = f.client.events(abort.signal)[Symbol.asyncIterator]();
  const initial = (await iterator.next()).value!;
  assert.equal(initial.type, "status"); assert.equal(initial.sessionId, f.connection.sessionId);
  const events: AgentEvent[] = [initial];
  const reading = (async () => { for await (const event of { [Symbol.asyncIterator]: () => iterator }) events.push(event); })();
  const activityAbort = new AbortController();
  const activities: RuntimeActivityEvent[] = [];
  const activityTask = (async () => { for await (const event of f.client.activityEvents(activityAbort.signal)) activities.push(event); })();
  // A status request completes after opening activity's fetch, but the native tool
  // turn also emits several phases; await the observed response phase below.
  await delay(30);
  await f.client.send("tool");
  await until(async () => activities, values => values.some(value => value.phase === "responding"));
  abort.abort(); activityAbort.abort(); await reading; await activityTask;
  assert.ok(events.some(event => event.type === "tool_started"));
  assert.ok(events.some(event => event.type === "tool_completed"));
  assert.ok(events.every(event => event.sessionId === f.connection.sessionId));
  assert.ok(!JSON.stringify(events).includes(f.connection.token));
  assert.ok((await f.client.messages()).some(m => m.role === "tool" && m.content === "file contents"));
  for (const value of activities) assert.deepEqual(Object.keys(value).sort(), ["observedAt", "phase"]);
  await f.client.send("after stream detach");
});

test("native-stop acknowledgment confirms native exit, not worker exit; explicit supervisor close ends listener", async t => {
  const f = await fixture(t);
  await f.client.startTurn("busy", "hold");
  const nativePid = Number(await readFile(join(f.directory, "native-pid"), "utf8"));
  await f.client.requestStop();
  assert.throws(() => process.kill(nativePid, 0), { code: "ESRCH" });
  assert.equal(await f.client.status(), "offline");
  assert.equal((await f.client.turn("busy"))?.status, "interrupted");
  assert.equal(f.child.exitCode, null, "HTTP acknowledgment must not be presented as worker-exit proof");
  f.child.send({ type: "close" });
  assert.equal((await f.exited)[0], 0);
  await assert.rejects(f.client.status());
});

test("invalid JSON/text/images and unsupported steering are explicit; failures never return native content", async t => {
  const f = await fixture(t);
  const malformed = await fetch(`${f.connection.endpoint}/turns`, { method: "POST", headers: f.headers, body: "{" });
  assert.equal(malformed.status, 400); await malformed.body?.cancel();
  const invalid = await fetch(`${f.connection.endpoint}/turns`, { method: "POST", headers: f.headers, body: JSON.stringify({ turnId: "bad", input: "" }) });
  assert.equal(invalid.status, 400); await invalid.body?.cancel();
  await assert.rejects(f.client.startTurn("pixels", "pixels", [{ type: "image", mimeType: "image/png", data: "YQ==" }]));
  await f.client.startTurn("steer-target", "hold");
  await f.client.steer("steer-target", "steer the running turn"); // Steering is a feature now: accepted for the running turn.
  await assert.rejects(f.client.steer("stale-turn", "wrong turn"), /http_409/, "steering never falls back to another turn");
  await f.client.interrupt("steer-target");
  await until(() => f.client.turn("steer-target"), turn => turn?.status === "interrupted");
  await assert.rejects(f.client.steer("steer-target", "after the turn ended"), /http_409/, "a settled turn cannot be steered");
  await assert.rejects(f.client.send("fail"), (error: unknown) => error instanceof ClaudeCodeWorkerError && !error.message.includes("private error"));
  assert.equal(await f.client.status(), "idle");
});

test("stream subscription count is bounded and excess readers do not affect native work", async t => {
  const f = await fixture(t);
  const aborts: AbortController[] = [];
  const readers: AsyncIterator<AgentEvent>[] = [];
  try {
    for (let n = 0; n < CLAUDE_WORKER_LIMITS.streams; n++) {
      const abort = new AbortController(); aborts.push(abort);
      const reader = f.client.events(abort.signal)[Symbol.asyncIterator](); readers.push(reader);
      assert.equal((await reader.next()).value?.type, "status");
    }
    const extra = new AbortController(); aborts.push(extra);
    await assert.rejects(f.client.events(extra.signal)[Symbol.asyncIterator]().next(), errorStatus(503));
    await f.client.send("still works");
  } finally {
    for (const abort of aborts) abort.abort();
    await Promise.allSettled(readers.map(reader => reader.return?.()));
  }
});

test("a stalled wire reader is disconnected while native work and polling keep progressing", { timeout: 15_000 }, async t => {
  const f = await fixture(t);
  const abort = new AbortController();
  const reader = f.client.events(abort.signal)[Symbol.asyncIterator]();
  assert.equal((await reader.next()).value?.type, "status");
  // Leave the fetch reader paused while the real SDK emits 16MiB of deltas.
  await f.client.send("worker-burst");
  assert.equal(await f.client.status(), "idle");
  await delay(CLAUDE_WORKER_LIMITS.drainMs + 100);
  let disconnected = false;
  const timer = setTimeout(() => abort.abort(), 5_000);
  try {
    while (!(await reader.next()).done) {}
  } catch { disconnected = !abort.signal.aborted; }
  finally { clearTimeout(timer); abort.abort(); await reader.return?.(); }
  assert.ok(disconnected, "Slow wire reader must be disconnected before its local timeout");
  await f.client.send("after stalled reader");
});

test("lost request acknowledgment is not retried; a new consumer polls the original retained turn", async t => {
  const controller = new AbortController();
  const connection = { sessionId: "id", ownerId: "owner", generation: "gen", token: "a".repeat(64), endpoint: "" };
  let posts = 0;
  let accepted: unknown;
  const server = createServer(async (request, response) => {
    if (request.method === "POST") {
      posts++;
      let raw = ""; for await (const chunk of request) raw += chunk;
      const body = JSON.parse(raw);
      const now = new Date().toISOString();
      accepted = { id: body.turnId, input: body.input, status: "running", createdAt: now, updatedAt: now };
      controller.abort(new Error("Consumer disappeared after dispatch"));
      return; // Deliberately lose the acknowledgment after admission.
    }
    response.end(JSON.stringify({ version: 1, sessionId: "id", generation: "gen", value: accepted }));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  connection.endpoint = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const client = new ClaudeCodeWorkerClient(connection);
  await assert.rejects(client.startTurn("uncertain", "hold", undefined, controller.signal));
  const recovered = await new ClaudeCodeWorkerClient(connection).turn("uncertain");
  assert.equal(recovered?.status, "running");
  assert.equal(posts, 1, "Unknown dispatch outcome must not provoke an automatic POST retry");
});

test("client rejects non-loopback/redirected/mismatched/oversized responses without endpoint fallback", async t => {
  const connection = { sessionId: "id", ownerId: "owner", generation: "gen", token: "a".repeat(64), endpoint: "http://127.0.0.1:1" };
  for (const endpoint of ["not-a-url", "https://127.0.0.1:1", "http://localhost:1", "http://example.com:1", "http://user@127.0.0.1:1", "http://127.0.0.1:1/path"]) {
    assert.throws(() => new ClaudeCodeWorkerClient({ ...connection, endpoint }));
  }
  let mode = "redirect", requests = 0;
  const server = createServer((_request, response) => {
    requests++;
    if (mode === "redirect") { response.writeHead(302, { location: "http://127.0.0.1:1" }).end(); return; }
    if (mode === "oversize") { response.end("x".repeat(CLAUDE_WORKER_LIMITS.jsonBytes + 1)); return; }
    if (mode === "hang") return;
    if (mode === "turn") {
      const now = new Date().toISOString();
      response.end(JSON.stringify({ version: 1, sessionId: "id", generation: "gen", value: {
        id: "wrong-turn", input: "input", status: "running", createdAt: now, updatedAt: now,
      } }));
      return;
    }
    response.end(JSON.stringify({ version: 1, sessionId: "wrong", generation: "gen", value: "idle" }));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const client = new ClaudeCodeWorkerClient({ ...connection, endpoint: `http://127.0.0.1:${(server.address() as { port: number }).port}` }, 500);
  await assert.rejects(client.status()); assert.equal(requests, 1);
  mode = "identity"; await assert.rejects(client.status(), error => error instanceof ClaudeCodeWorkerError && error.code === "identity_mismatch");
  mode = "oversize"; await assert.rejects(client.status(), error => error instanceof ClaudeCodeWorkerError && error.code === "response_too_large");
  mode = "turn"; await assert.rejects(client.startTurn("expected-turn", "input"), error => error instanceof ClaudeCodeWorkerError && error.code === "turn_identity_mismatch");
  mode = "hang"; await assert.rejects(client.status());
  assert.equal(requests, 5, "No automatic retries, redirects or fallback endpoints");
});
