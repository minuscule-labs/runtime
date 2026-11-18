import assert from "node:assert/strict";
import { fork, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import http, { request as httpRequest } from "node:http";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test, { type TestContext } from "node:test";
import type { AgentTurn, RuntimeMessage } from "@minu/runtime-core";
import { CodexWorkerClient } from "../src/worker-client.js";
import { createCodexWorkerBridge, type CodexWorkerRuntime, type CodexWorkerConnection } from "../src/worker-bridge.js";
import { CodexEventHub } from "../src/event-stream.js";

async function waitExit(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await once(child, "exit");
}

async function fixture(t: TestContext, scenario = "normal", shutdownTimeoutMs = 100, threadId?: string) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "codex-worker-")));
  const logPath = join(directory, "native.jsonl");
  const child = fork(new URL("../src/owned-worker.js", import.meta.url), [], {
    stdio: ["ignore", "ignore", "pipe", "ipc"],
  });
  let diagnostics = "";
  child.stderr?.on("data", chunk => { diagnostics += chunk; });
  let client: CodexWorkerClient | undefined;
  t.after(async () => {
    try {
      if (child.exitCode === null && child.signalCode === null) {
        if (client) await client.request("stop").catch(() => { child.kill("SIGTERM"); });
        else child.kill("SIGTERM");
        await waitExit(child);
      }
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
  const ready = once(child, "message");
  child.send({ type: "launch", ...(threadId ? { threadId } : {}), identity: { ownerId: "owner-a", sessionId: "stable-id", generation: "generation-a" },
    config: { cwd: directory }, options: { command: process.execPath,
      args: [fileURLToPath(new URL("./fixtures/app-server.js", import.meta.url)), scenario, logPath],
      requestTimeoutMs: 1_000, shutdownTimeoutMs },
  });
  const [message] = await Promise.race([
    ready,
    once(child, "exit").then(() => { throw new Error(`Worker failed to launch: ${diagnostics}`); }),
  ]) as [{ type: string; connection: CodexWorkerConnection }];
  assert.equal(message.type, "ready");
  const connection = message.connection;
  client = new CodexWorkerClient(connection);
  return { child, client, connection, directory,
    async log(): Promise<Array<Record<string, any>>> {
      return (await readFile(logPath, "utf8")).trim().split("\n").map(line => JSON.parse(line));
    },
  };
}

async function settled(client: CodexWorkerClient, turnId: string): Promise<AgentTurn> {
  const deadline = Date.now() + 3_000;
  do {
    const turn = await client.request<AgentTurn>("turn", { turnId });
    if (turn.status !== "running") return turn;
    await new Promise(resolve => setTimeout(resolve, 5));
  } while (Date.now() < deadline);
  throw new Error("Worker turn did not settle");
}

function headers(c: CodexWorkerConnection): Record<string, string> {
  return { authorization: `Bearer ${c.token}`, "x-minu-runtime-owner": c.ownerId,
    "x-minu-runtime-session": c.sessionId, "x-minu-runtime-generation": c.generation,
    "content-type": "application/json" };
}

function gate() { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve; }); return { promise, release }; }

async function retirementBridge(t: TestContext, callbacks: { retire(operationId: string, connection: CodexWorkerConnection): Promise<void>; beforeClose(): Promise<void> }, stop: () => Promise<void> = async () => {}) {
  let server!: http.Server;
  const create = http.createServer;
  const mock = t.mock.method(http, "createServer", ((...args: any[]) => { server = (create as any)(...args); return server; }) as typeof create);
  syncBuiltinESMExports(); const hub = new CodexEventHub();
  const runtime: CodexWorkerRuntime = { status: async () => "idle", messages: async () => [], turn: async () => undefined,
    startTurn: async () => { throw new Error("Unused"); }, steer: async () => {}, interrupt: async () => {}, stop,
    events: () => hub.subscribe({ type: "status", sessionId: "local", timestamp: new Date().toISOString(), status: "idle" }) };
  const registration = { claimId: "claim", authorize: async function(this: { claimId: string }) { assert.equal(this.claimId, "claim"); }, ...callbacks };
  let bridge!: Awaited<ReturnType<typeof createCodexWorkerBridge>>;
  try { bridge = await createCodexWorkerBridge(runtime, { id: "local", runtime: "codex", ownership: "owned", cwd: process.cwd() },
    { sessionId: "local", ownerId: "owner", generation: "generation" }, registration); }
  finally { mock.mock.restore(); syncBuiltinESMExports(); }
  const priorExitCode = process.exitCode;
  t.after(async () => { hub.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    await new Promise(resolve => setImmediate(resolve)); process.exitCode = priorExitCode; });
  return { ...bridge, registration, client: new CodexWorkerClient(bridge.connection) };
}

for (const fault of ["token", "owner", "session", "generation", "origin", "version", "pid", "claim", "operation", "extra", "missing", "array"] as const) {
  test(`private retirement route rejects ${fault} without invoking producer`, async t => {
    let calls = 0; const f = await retirementBridge(t, { retire: async () => { calls++; }, beforeClose: async () => {} });
    const c = f.connection; const h = headers(c); let body: any = { operationId: "retire-a", version: c.version, pid: c.pid, claimId: c.claimId };
    if (fault === "token") h.authorization = "Bearer wrong";
    else if (fault === "owner") h["x-minu-runtime-owner"] = "other";
    else if (fault === "session") h["x-minu-runtime-session"] = "other";
    else if (fault === "generation") h["x-minu-runtime-generation"] = "other";
    else if (fault === "origin") h.origin = "https://browser.invalid";
    else if (fault === "version") body.version = [1];
    else if (fault === "pid") body.pid = String(c.pid);
    else if (fault === "claim") body.claimId = "other";
    else if (fault === "operation") body.operationId = "../bad";
    else if (fault === "extra") body.extra = true;
    else if (fault === "missing") delete body.claimId;
    else body = [body];
    const response = await fetch(`${c.endpoint}/retire`, { method: "POST", headers: h, body: JSON.stringify(body) });
    assert.ok(!response.ok); await response.arrayBuffer(); assert.equal(calls, 0);
    assert.equal(await f.client.request("status"), "idle"); await f.close();
  });
}

test("retirement bridge snapshots callbacks and passes detached actual connection context", async t => {
  const entered = gate(), released = gate(); let checks = 0;
  const callbacks = { retire: async (_op: string, connection: CodexWorkerConnection) => { connection.token = "b".repeat(64); entered.release(); await released.promise; },
    beforeClose: async () => { checks++; } };
  const f = await retirementBridge(t, callbacks); const originalToken = f.connection.token;
  f.registration.retire = async () => { throw new Error("Mutated callback invoked"); }; f.registration.beforeClose = async () => { throw new Error("Mutated guard invoked"); };
  const result = f.client.retire("retire-a"); await entered.promise; released.release();
  assert.deepEqual(await result, { operationId: "retire-a", phase: "native_fact_published" }); await f.closed;
  assert.equal(f.connection.token, originalToken); assert.ok(checks >= 1);
});

for (const failure of [false, true]) {
  test(`late retirement admission during native stop ${failure ? "failure" : "delay"} gates closure and streams`, async t => {
    const stopping = gate(), nativeReleased = gate(), admitted = gate(), published = gate(); let active = false, closed = false;
    const error = new Error("Injected publication failure");
    const completion = published.promise.then(() => { if (failure) throw error; }); void completion.catch(() => {});
    const f = await retirementBridge(t, { retire: async () => { active = true; admitted.release(); await completion; },
      beforeClose: async () => { if (active) await completion; } }, async () => { stopping.release(); await nativeReleased.promise; });
    const stream = f.client.events(); await stream.ready; await stream.next();
    void f.closed.then(() => { closed = true; }); const closure = Promise.allSettled([f.close()]);
    await stopping.promise; const request = Promise.allSettled([f.client.retire("retire-a")]); await admitted.promise;
    nativeReleased.release(); await new Promise(resolve => setImmediate(resolve)); assert.equal(closed, false);
    assert.equal(await f.client.request("status").then(() => false, () => true), true); // Ordinary stopping shortcut does not govern /retire.
    published.release(); const [result] = await closure; assert.equal(result.status, failure ? "rejected" : "fulfilled");
    await request; if (failure) assert.equal(closed, false); else await f.closed;
    await stream.return?.();
  });
}

for (const value of [null, true, {}, { operationId: "other", phase: "native_fact_published" }, { operationId: "retire-a", phase: "exited" },
  { operationId: "retire-a", phase: "native_fact_published", exited: true }]) {
  test(`retirement client strictly rejects acknowledgment ${JSON.stringify(value)} without resend/fallback`, async t => {
    let calls = 0; const server = http.createServer(async (req, res) => { calls++; assert.equal(req.url, "/retire"); for await (const _ of req) {} res.end(JSON.stringify({ result: value })); });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve)); t.after(() => { server.closeAllConnections(); server.close(); });
    const address = server.address() as import("node:net").AddressInfo;
    const client = new CodexWorkerClient({ version: 1, ownerId: "owner", sessionId: "session", generation: "generation", claimId: "claim", pid: process.pid,
      endpoint: `http://127.0.0.1:${address.port}`, token: "a".repeat(64) });
    await assert.rejects(client.retire("retire-a")); assert.equal(calls, 1);
  });
}

test("retirement acknowledgment survives request disconnect and schedules closure without response finish", async t => {
  const entered = gate(), released = gate(); const f = await retirementBridge(t, { retire: async () => { entered.release(); await released.promise; }, beforeClose: async () => {} });
  const c = f.connection;
  const req = httpRequest(`${c.endpoint}/retire`, { method: "POST", headers: headers(c) }); req.on("error", () => {});
  req.end(JSON.stringify({ operationId: "retire-a", version: c.version, pid: c.pid, claimId: c.claimId }));
  await entered.promise; req.destroy(); released.release(); await f.closed;
});

test("unregistered retirement is unsupported without changing eager ordinary controls", { timeout: 10_000 }, async t => {
  const f = await fixture(t); await assert.rejects(f.client.retire("retire-a")); assert.equal(await f.client.request("status"), "idle");
  const body = { operationId: "retire-a", version: 1, pid: f.connection.pid, claimId: "forged-claim" };
  const response = await fetch(`${f.connection.endpoint}/retire`, { method: "POST", headers: headers(f.connection), body: JSON.stringify(body) });
  assert.equal(response.status, 404); await response.arrayBuffer(); assert.equal(await f.client.request("status"), "idle");
});

test("owns a separate worker and app-server, and confirms native shutdown before worker exit", { timeout: 10_000 }, async t => {
  const f = await fixture(t);
  assert.equal(f.connection.pid, f.child.pid);
  assert.notEqual(f.connection.pid, process.pid);
  assert.match(f.connection.endpoint, /^http:\/\/127\.0\.0\.1:\d+$/);
  assert.equal(await f.client.request("status"), "idle");
  const nativePid = (await f.log())[0].pid;
  assert.notEqual(nativePid, f.child.pid);
  await f.client.request("startTurn", { turnId: "turn-one", input: "hello" });
  assert.equal((await settled(f.client, "turn-one")).status, "completed");
  const messages = await f.client.request<RuntimeMessage[]>("messages");
  assert.equal(messages[0].content, "hello");
  await f.client.request("stop");
  await waitExit(f.child);
  assert.equal(f.child.exitCode, 0);
  assert.throws(() => process.kill(nativePid, 0), { code: "ESRCH" });
});

test("worker can reopen an explicit native thread without creating a replacement", { timeout: 10_000 }, async t => {
  const f = await fixture(t, "normal", 100, "native-thread");
  const messages = await f.client.request<RuntimeMessage[]>("messages");
  assert.equal(messages[0].content, "Prior prompt");
  await f.client.request("startTurn", { turnId: "after-resume", input: "Continue" });
  assert.equal((await settled(f.client, "after-resume")).status, "completed");
  const calls = await f.log();
  assert.equal(calls.some(call => call.method === "thread/start"), false);
  assert.equal(calls.find(call => call.method === "thread/resume")!.params.threadId, "native-thread");
});

test("survives controller disconnect and preserves worker-owned turn idempotency on reconnect", { timeout: 10_000 }, async t => {
  const f = await fixture(t, "held");
  await f.client.request("startTurn", { turnId: "stable-turn", input: "hello" });
  f.child.disconnect();
  const reconnected = new CodexWorkerClient(f.connection);
  assert.equal((await reconnected.request<AgentTurn>("startTurn", { turnId: "stable-turn", input: "hello" })).status, "running");
  await assert.rejects(reconnected.request("startTurn", { turnId: "stable-turn", input: "changed" }), /400/);
  await assert.rejects(reconnected.request("startTurn", { turnId: "busy", input: "no" }), /409/);
  await reconnected.request("steer", { input: "Focus" });
  await reconnected.request("interrupt");
  assert.equal((await settled(reconnected, "stable-turn")).status, "interrupted");
  assert.equal((await reconnected.request<AgentTurn>("startTurn", { turnId: "stable-turn", input: "hello" })).status, "interrupted");
  const calls = await f.log();
  assert.equal(calls.filter(call => call.method === "turn/start").length, 1);
  assert.equal(calls.filter(call => call.method === "turn/steer").length, 1);
});

test("independent consumer processes recover the same accepted turn without redispatch", { timeout: 10_000 }, async t => {
  const f = await fixture(t, "held");
  const consume = async (): Promise<AgentTurn> => {
    const consumer = fork(new URL("./fixtures/worker-consumer.js", import.meta.url), [], {
      stdio: ["ignore", "ignore", "ignore", "ipc"],
    });
    t.after(() => { if (consumer.exitCode === null) consumer.kill("SIGTERM"); });
    const reply = once(consumer, "message");
    consumer.send({ connection: f.connection, method: "startTurn", args: { turnId: "consumer-turn", input: "hello" } });
    const [message] = await reply as [{ result: AgentTurn }];
    await waitExit(consumer);
    assert.equal(consumer.exitCode, 0);
    return message.result;
  };
  assert.equal((await consume()).status, "running");
  f.child.disconnect();
  assert.equal((await consume()).status, "running");
  assert.equal((await f.log()).filter(call => call.method === "turn/start").length, 1);
});

test("wrong token, owner, session, generation, and browser origin cannot inspect or stop worker", { timeout: 10_000 }, async t => {
  const f = await fixture(t);
  const denied: Array<Record<string, string>> = [
    { authorization: `Bearer ${"0".repeat(64)}` },
    { "x-minu-runtime-owner": "owner-b" },
    { "x-minu-runtime-session": "other-session" },
    { "x-minu-runtime-generation": "old-generation" },
    { origin: "http://localhost:1234" },
  ];
  for (const override of denied) {
    for (const method of ["messages", "startTurn", "stop"]) {
      const response = await fetch(`${f.connection.endpoint}/rpc`, { method: "POST",
        headers: { ...headers(f.connection), ...override },
        body: JSON.stringify({ method, turnId: "unauthorized", input: "private" }),
      });
      assert.equal(response.status, 403);
      assert.deepEqual(await response.json(), { error: "Bridge access denied" });
    }
  }
  assert.equal(await f.client.request("status"), "idle");
  assert.equal((await f.log()).filter(call => call.method === "turn/start").length, 0);
});

test("rejects malformed, unsupported, and oversized requests without dispatch", { timeout: 10_000 }, async t => {
  const f = await fixture(t);
  for (const body of ["broken", "[]", '{"method":"native/exec"}',
    '{"method":"startTurn","turnId":"t","input":"x","images":[{"type":"image","mimeType":"image/png","data":"bad"}]}',
    '{"method":"startTurn","turnId":42,"input":"x"}',
  ]) {
    const response = await fetch(`${f.connection.endpoint}/rpc`, { method: "POST", headers: headers(f.connection), body });
    assert.equal(response.status, 400);
    await response.arrayBuffer();
  }
  // Exceeding the physical body bound may terminate the request socket.
  try {
    const response = await fetch(`${f.connection.endpoint}/rpc`, { method: "POST", headers: headers(f.connection), body: "x".repeat(34 * 1024 * 1024 + 1) });
    assert.equal(response.status, 413);
    await response.arrayBuffer();
  } catch (error) { assert.ok(error instanceof TypeError); }
  assert.equal(await f.client.request("status"), "idle");
  assert.equal((await f.log()).filter(call => call.method === "turn/start").length, 0);
});

for (const scenario of ["held", "ignore-term"]) {
  test(`SIGTERM stops active native worker with confirmed exit (${scenario})`, { timeout: 10_000 }, async t => {
    const f = await fixture(t, scenario);
    await f.client.request("startTurn", { turnId: "active", input: "hello" });
    const nativePid = (await f.log())[0].pid;
    f.child.kill("SIGTERM");
    await waitExit(f.child);
    assert.equal(f.child.exitCode, 0);
    assert.throws(() => process.kill(nativePid, 0), { code: "ESRCH" });
  });
}

async function nativeStopping(log: () => Promise<Array<Record<string, any>>>): Promise<void> {
  const deadline = Date.now() + 2_000;
  do {
    if ((await log()).some(entry => entry.signal === "SIGTERM")) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  } while (Date.now() < deadline);
  throw new Error("Native shutdown did not begin");
}

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  test(`repeated ${signal} cannot bypass native shutdown`, { timeout: 10_000 }, async t => {
    const f = await fixture(t, "ignore-term", 500);
    const nativePid = (await f.log())[0].pid;
    t.after(() => { try { process.kill(nativePid, "SIGKILL"); } catch {} });
    f.child.kill(signal);
    // Synchronize on the native handler rather than assuming a signal was handled.
    await nativeStopping(f.log);
    f.child.kill(signal);
    await new Promise(resolve => setTimeout(resolve, 20));
    f.child.kill(signal);
    assert.equal(f.child.exitCode, null);
    assert.equal(f.child.signalCode, null);
    await waitExit(f.child);
    assert.equal(f.child.exitCode, 0);
    assert.equal(f.child.signalCode, null);
    assert.throws(() => process.kill(nativePid, 0), { code: "ESRCH" });
  });
}

test("stop caller disconnect during native shutdown cannot strand worker or listener", { timeout: 10_000 }, async t => {
  const f = await fixture(t, "ignore-term", 500);
  const nativePid = (await f.log())[0].pid;
  t.after(() => { try { process.kill(nativePid, "SIGKILL"); } catch {} });
  const request = httpRequest(`${f.connection.endpoint}/rpc`, {
    method: "POST", headers: headers(f.connection),
  }, response => response.resume());
  request.on("error", () => {}); // Socket closure is intentional; no retry.
  request.end(JSON.stringify({ method: "stop" }));
  await nativeStopping(f.log);
  request.destroy();
  // No further RPC or signal is needed to finish the admitted stop operation.
  await waitExit(f.child);
  assert.equal(f.child.exitCode, 0);
  assert.throws(() => process.kill(nativePid, 0), { code: "ESRCH" });
  await assert.rejects(fetch(`${f.connection.endpoint}/rpc`, {
    method: "POST", headers: headers(f.connection), body: JSON.stringify({ method: "status" }),
  }));
});

test("interactive native requests fail closed behind the bridge", { timeout: 10_000 }, async t => {
  const f = await fixture(t, "interactive");
  await f.client.request("startTurn", { turnId: "interactive", input: "hello" });
  assert.equal((await settled(f.client, "interactive")).status, "failed");
  assert.equal(await f.client.request("status"), "offline");
  assert.equal((await f.log()).some(call => call.id === "server-request" && call.result), false);
});

test("client refuses non-loopback and credential-bearing endpoints", async () => {
  const c: CodexWorkerConnection = { version: 1, ownerId: "owner-a", sessionId: "stable-id", generation: "gen-a",
    endpoint: "http://127.0.0.1:1234", token: "a".repeat(64), pid: process.pid };
  for (const endpoint of ["http://example.com:1234", "https://127.0.0.1:1234", "http://user:pass@127.0.0.1:1234", "http://127.0.0.1:1234/path"]) {
    assert.throws(() => new CodexWorkerClient({ ...c, endpoint }));
  }
});
