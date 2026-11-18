import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test, type TestContext } from "node:test";
import { ClaudeCodeManagedStore, type ClaudeCodeManagedManifest } from "../src/managed-store.js";
import { waitForClaudeCodeWorkerReady as ready } from "../src/worker-readiness.js";
import { envelope } from "../src/worker-protocol.js";
import { encodeClaudeCodeWorkerRegistration, type ClaudeCodeWorkerRegistrationScope } from "../src/worker-registration.js";

async function fixture(t: TestContext, adopted = true) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "claude-readiness-")));
  const cwd = join(root, "workspace"), nativeRoot = join(root, "native"), storeRoot = join(root, "managed");
  await mkdir(cwd, { mode: 0o700 }); await mkdir(nativeRoot, { mode: 0o700 });
  const store = new ClaudeCodeManagedStore(storeRoot);
  const initial: ClaudeCodeManagedManifest = { version: 3, runtime: "claude-code", id: "readiness-session", ownerId: "owner",
    revision: 0, generation: "generation", requiresExplicitResume: false, native: { state: "pending" }, worker: { state: "none" },
    lastDispatch: { state: "none" }, launchConfig: { cwd },
    policy: { configuration: "isolated", permissionMode: "default", nativeConfigRoot: nativeRoot, tools: [] }, createdAt: new Date().toISOString() };
  await store.create(initial);
  const scope: ClaudeCodeWorkerRegistrationScope = { sessionId: initial.id, ownerId: initial.ownerId, generation: initial.generation,
    reservationId: randomUUID(), workerExecutable: fileURLToPath(new URL("./fixtures/worker-entry.js", import.meta.url)), cwd, nativeConfigRoot: nativeRoot };
  const path = join(storeRoot, createHash("sha256").update(initial.ownerId).digest("hex"), `${initial.id}.session`, "manifest.json");
  const requests: string[] = [];
  const reply = (response: ServerResponse, value: unknown) => {
    response.setHeader("content-type", "application/json"); response.end(JSON.stringify(envelope(scope, value)));
  };
  let handle: (request: IncomingMessage, response: ServerResponse) => Promise<void> = async (_, response) => {
    // Same lock as the client-side admission: positive results would deadlock if
    // the readiness helper retained its lease across HTTP.
    await store.withWorkerAdmission(scope, bytes, async () => { reply(response, "idle"); });
  };
  const server = createServer((request, response) => {
    requests.push(`${request.method} ${request.url}`);
    assert.equal(request.headers.authorization, `Bearer ${"a".repeat(64)}`);
    assert.equal(request.headers["x-minu-runtime-session"], scope.sessionId);
    assert.equal(request.headers["x-minu-runtime-owner"], scope.ownerId);
    assert.equal(request.headers["x-minu-runtime-generation"], scope.generation);
    void handle(request, response).catch(() => { response.statusCode = 503; response.end(); });
  });
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
  const registration = { version: 1 as const, runtime: "claude-code" as const, ownership: "owned" as const, ...scope,
    pid: process.pid, processGroupId: null, endpoint: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    token: "a".repeat(64), createdAt: new Date().toISOString() };
  const bytes = encodeClaudeCodeWorkerRegistration(registration, scope);
  await store.withSessionLock(initial.id, initial.ownerId, async lease => {
    await lease.reserveWorker(0, scope.generation, scope.reservationId, scope.workerExecutable);
    await lease.beginWorkerStart(1, scope.generation, scope.reservationId);
    await lease.recordWorkerProcess(2, scope.generation, scope.reservationId, process.pid, null);
    if (adopted) await lease.publishWorker(3, scope.generation, scope.reservationId, bytes);
  });
  t.after(async () => {
    server.closeAllConnections(); await new Promise<void>((done, reject) => server.close(error => error ? reject(error) : done()));
    assert.ok(requests.every(value => value === "GET /status"));
    await rm(root, { recursive: true, force: true });
  });
  const read = async () => (await store.read(scope.sessionId, scope.ownerId))!;
  return { root, store, scope, bytes, registration, path, requests, read, reply,
    setHandler: (handler: typeof handle) => { handle = handler; },
    options: { store, scope, registration: bytes, timeoutMs: 1_000 } };
}

for (const status of ["idle", "working"] as const) {
  test(`exact authenticated ${status} worker is ready without holding the lifecycle lease across HTTP`, async t => {
    const f = await fixture(t), before = await f.read();
    f.setHandler(async (_, response) => { await f.store.withWorkerAdmission(f.scope, f.bytes, async () => { f.reply(response, status); }); });
    assert.deepEqual(await ready(f.options), { state: "ready", status });
    assert.equal(f.requests.length, 1); assert.deepEqual(await f.read(), before);
  });
}

test("published-but-unready retries only status reads until the existing worker becomes ready", async t => {
  const f = await fixture(t), before = await f.read(); let reads = 0;
  f.setHandler(async (_, response) => {
    if (++reads < 3) { response.statusCode = 503; response.end("PRIVATE_NOT_READY_ERROR"); }
    else f.reply(response, "idle");
  });
  assert.deepEqual(await ready(f.options), { state: "ready", status: "idle" });
  assert.equal(reads, 3); assert.deepEqual(await f.read(), before);
});

test("a prepared but unpublished endpoint is unavailable without any HTTP observation or mutation", async t => {
  const f = await fixture(t, false), before = await f.read();
  assert.deepEqual(await ready(f.options), { state: "unavailable" });
  assert.equal(f.requests.length, 0); assert.deepEqual(await f.read(), before);
});

test("wrong frozen descriptor is rejected before contacting its endpoint", async t => {
  const f = await fixture(t), before = await f.read();
  const wrong = encodeClaudeCodeWorkerRegistration({ ...f.registration, token: "b".repeat(64) }, f.scope);
  assert.deepEqual(await ready({ ...f.options, registration: wrong }), { state: "unavailable" });
  assert.equal(f.requests.length, 0); assert.deepEqual(await f.read(), before);
});

for (const change of ["generation", "human-fence", "descriptor"] as const) {
  test(`a healthy reply after ${change} revocation cannot confirm readiness`, async t => {
    const f = await fixture(t); let changed: ClaudeCodeManagedManifest | undefined;
    f.setHandler(async (_, response) => {
      if (change === "descriptor") {
        const current = await f.read(); assert.equal(current.worker.state, "live");
        if (current.worker.state !== "live") throw new Error("Expected live fixture");
        changed = { ...current, revision: current.revision + 1, worker: { ...current.worker,
          registration: { ...current.worker.registration, token: "b".repeat(64) } } };
        // Actual private-file replacement fault, not a claimed legitimate retirement.
        await writeFile(f.path, JSON.stringify(changed), { mode: 0o600 });
      } else await f.store.withSessionLock(f.scope.sessionId, f.scope.ownerId, async lease => {
        changed = await lease.update((await f.read()).revision, change === "generation" ? { generation: "new-generation" } : { requiresExplicitResume: true });
      });
      f.reply(response, "idle");
    });
    assert.deepEqual(await ready(f.options), { state: "unavailable" });
    assert.equal(f.requests.length, 1); assert.deepEqual(await f.read(), changed);
  });
}

test("stalled HTTP status body times out without late readiness, cleanup or metadata changes", async t => {
  const f = await fixture(t), before = await f.read();
  f.setHandler(async (_, response) => { response.writeHead(200); response.flushHeaders(); response.write('{"version":'); });
  const start = performance.now();
  assert.deepEqual(await ready({ ...f.options, timeoutMs: 80 }), { state: "unavailable" });
  assert.ok(performance.now() - start < 2_000); assert.deepEqual(await f.read(), before);
});

test("a starved timer cannot publish a late successful post-response admission", async t => {
  const f = await fixture(t), original = f.store.withWorkerAdmission.bind(f.store); let calls = 0;
  // Count only the two client checks; nested server admission is covered above.
  f.setHandler(async (_, response) => { f.reply(response, "idle"); });
  f.store.withWorkerAdmission = (async (...args: Parameters<typeof original>) => {
    const value = await original(...args);
    if (++calls === 2) { const end = performance.now() + 600; while (performance.now() < end) {} }
    return value;
  }) as typeof original;
  assert.deepEqual(await ready({ ...f.options, timeoutMs: 500 }), { state: "unavailable" });
  assert.equal(calls, 2);
});

test("contended admission uses the remaining readiness budget, not the default five-second lock wait", async t => {
  const f = await fixture(t), before = await f.read();
  await f.store.withSessionLock(f.scope.sessionId, f.scope.ownerId, async () => {
    const start = performance.now();
    assert.deepEqual(await ready({ ...f.options, timeoutMs: 80 }), { state: "unavailable" });
    assert.ok(performance.now() - start < 2_000); assert.equal(f.requests.length, 0);
  });
  assert.deepEqual(await f.read(), before);
});

test("pre-cancelled readiness never performs an HTTP read or exposes the cancellation reason", async t => {
  const f = await fixture(t), controller = new AbortController(); controller.abort(new Error("PRIVATE_CANCEL_REASON"));
  await assert.rejects(ready({ ...f.options, signal: controller.signal }), { name: "AbortError", message: "Claude Code readiness check cancelled" });
  assert.equal(f.requests.length, 0);
});

test("cancellation aborts a stalled status body without exposing its private reason", async t => {
  const f = await fixture(t), controller = new AbortController(); let entered!: () => void;
  const reading = new Promise<void>(done => { entered = done; });
  f.setHandler(async (_, response) => { response.writeHead(200); response.flushHeaders(); response.write('{"version":'); entered(); });
  const check = ready({ ...f.options, signal: controller.signal }); await reading;
  controller.abort(new Error("PRIVATE_CANCEL_REASON"));
  await assert.rejects(check, { name: "AbortError", message: "Claude Code readiness check cancelled" });
});

test("caller mutation cannot change snapshotted scope or registration bytes during readiness", async t => {
  const f = await fixture(t), scope = { ...f.scope }, registration = new Uint8Array(f.bytes);
  const check = ready({ ...f.options, scope, registration });
  scope.ownerId = "other-owner"; registration.fill(0);
  assert.deepEqual(await check, { state: "ready", status: "idle" }); assert.equal(f.requests.length, 1);
});

for (const mode of ["offline", "wrong-identity", "redirect"] as const) {
  test(`${mode} status cannot establish readiness or trigger endpoint fallback`, async t => {
    const f = await fixture(t), before = await f.read();
    f.setHandler(async (_, response) => {
      if (mode === "offline") f.reply(response, "offline");
      else if (mode === "wrong-identity") response.end(JSON.stringify({ version: 1, sessionId: "other", generation: f.scope.generation, value: "idle", error: "PRIVATE_STATUS_ERROR" }));
      else { response.writeHead(302, { location: `${f.registration.endpoint}/turns` }); response.end(); }
    });
    assert.deepEqual(await ready(f.options), { state: "unavailable" });
    assert.equal(f.requests.length, 1); assert.deepEqual(await f.read(), before);
  });
}

test("invalid readiness deadlines reject before HTTP or lifecycle observation", async t => {
  const f = await fixture(t), before = await f.read();
  for (const timeoutMs of [0, 1.5, 30_001]) await assert.rejects(ready({ ...f.options, timeoutMs }), /Invalid Claude Code readiness deadline/);
  assert.equal(f.requests.length, 0); assert.deepEqual(await f.read(), before);
});
