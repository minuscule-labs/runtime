import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, writeFile, chmod, symlink, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { sessionProfile, type RuntimeSessionProfile } from "@minu/runtime-core";
import { PiAgentRuntime } from "../src/client.js";
import { createPiBridgeServer } from "../src/server.js";
import { inspectRegistration, writeRegistration } from "../src/registry.js";
import { createSessionProfileReader } from "../src/session-profile.js";

const profile = (): RuntimeSessionProfile => ({ version: 1, capturedAt: new Date().toISOString(), model: { status: "verified", provider: "provider", id: "live-model" }, reasoning: { status: "verified", level: "low" }, skills: { status: "verified", commandIds: ["skill:check"], complete: true } });
function gate<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; }
async function fixture(getSessionProfile?: (signal: AbortSignal) => Promise<RuntimeSessionProfile>, send?: () => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), "runtime-profile-test-"));
  const previous = process.env.MINU_RUNTIME_DIR;
  process.env.MINU_RUNTIME_DIR = dir;
  const bridge = await createPiBridgeServer({ sessionId: "PRIVATE_NATIVE", token: "test-token", managedSession: { id: "managed", ownerId: "owner" }, getStatus: () => "idle", async send() { if (send) await send(); else throw new Error("must not send"); }, getSessionProfile });
  const registration = { sessionId: "managed", ownerId: "owner", endpoint: bridge.endpoint, token: "test-token", pid: process.pid, cwd: "/PRIVATE_PATH", ownership: "owned" as const, updatedAt: new Date().toISOString() };
  await writeRegistration(registration);
  const runtime = new PiAgentRuntime();
  return { dir, bridge, registration, runtime, async close() { await bridge.close(); await rm(dir, { recursive: true, force: true }); if (previous === undefined) delete process.env.MINU_RUNTIME_DIR; else process.env.MINU_RUNTIME_DIR = previous; } };
}

test("profile projection bounds fields/bytes and drops native/config/prompt extensions", () => {
  const value = sessionProfile({ ...profile(), nativeSessionId: "SECRET_NATIVE", prompt: "SECRET_PROMPT", model: { ...profile().model, token: "SECRET_TOKEN", baseUrl: "SECRET_URL" }, skills: { status: "verified", complete: true, commandIds: Array.from({ length: 80 }, (_, i) => `skill:item-${i}`), path: "SECRET_PATH" } });
  assert.equal(value.skills.status, "verified");
  if (value.skills.status === "verified") { assert.equal(value.skills.commandIds.length, 64); assert.equal(value.skills.complete, false); }
  assert.ok(Buffer.byteLength(JSON.stringify(value)) < 16 * 1024);
  assert.doesNotMatch(JSON.stringify(value), /SECRET|nativeSessionId|baseUrl|token|prompt/);
  const unsafe = sessionProfile({ ...profile(), model: { status: "verified", provider: "x", id: "/private/model" }, reasoning: { status: "verified", level: "secret" }, skills: { status: "verified", complete: true, commandIds: ["/private/path"] } });
  assert.equal(unsafe.model.status, "not_verified"); assert.equal(unsafe.reasoning.status, "not_verified");
  assert.deepEqual(unsafe.skills, { status: "verified", commandIds: [], complete: false });
  assert.throws(() => sessionProfile({ ...profile(), version: 2 }));
});

test("owned RPC reader uses only this process's state and command names, never discovery or messages", async () => {
  const calls: string[] = [];
  const read = createSessionProfileReader({ async request(type) { calls.push(type); return type === "get_state"
    ? { sessionId: "native", model: { provider: "p", id: "actual-model", headers: "SECRET" }, thinkingLevel: "high", sessionFile: "SECRET" }
    : { commands: [{ source: "skill", name: "skill:live", sourceInfo: { path: "SECRET" } }, { source: "prompt", name: "secret-prompt" }] }; } }, "native");
  const value = await read(new AbortController().signal);
  assert.deepEqual(calls, ["get_state", "get_commands", "get_state"]);
  assert.deepEqual(value.model, { status: "verified", provider: "p", id: "actual-model" });
  assert.deepEqual(value.skills, { status: "verified", commandIds: ["skill:live"], complete: true });
  assert.doesNotMatch(JSON.stringify(value), /SECRET|sessionFile|sourceInfo|secret-prompt/);
});

test("canceled RPC delivery retains its physical slot and cannot queue follow-ups or late evidence", async () => {
  const pending = gate<unknown>(); let calls = 0;
  const read = createSessionProfileReader({ request: async () => { calls++; return pending.promise; } }, "native");
  const controller = new AbortController();
  const first = read(controller.signal); controller.abort();
  await assert.rejects(first, { name: "AbortError" });
  await assert.rejects(read(new AbortController().signal), /unavailable/);
  pending.resolve({ sessionId: "native", model: { provider: "p", id: "m" } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls, 1, "no get_commands after cancellation");
});

test("an RPC state from a changed native session is never attributed to the original managed worker", async () => {
  const calls: string[] = [];
  const read = createSessionProfileReader({ async request(type) { calls.push(type); return { sessionId: "other", model: { provider: "p", id: "m" } }; } }, "native");
  await assert.rejects(read(new AbortController().signal), /unavailable/);
  assert.deepEqual(calls, ["get_state"]);
});

test("model, reasoning or native identity changing during commands cannot be combined into one verified profile", async () => {
  for (const changed of [{ sessionId: "other" }, { model: { provider: "p", id: "other" } }, { thinkingLevel: "high" }]) {
    let states = 0;
    const state = { sessionId: "native", model: { provider: "p", id: "original" }, thinkingLevel: "low" };
    const read = createSessionProfileReader({ async request(type) {
      if (type === "get_commands") return { commands: [] };
      return ++states === 1 ? state : { ...state, ...changed };
    } }, "native");
    await assert.rejects(read(new AbortController().signal), /unavailable/);
  }
});

test("managed profile checks both owner and worker identity, stays read-only and tolerates old workers", async () => {
  let reads = 0;
  const f = await fixture(async () => { reads++; return { ...profile(), token: "SECRET" } as RuntimeSessionProfile; });
  try {
    const path = join(f.dir, "managed.json"), before = await readFile(path, "utf8");
    assert.equal(await f.runtime.inspectSessionProfile("managed", "other-owner"), undefined); assert.equal(reads, 0);
    const forged = await fetch(`${f.bridge.endpoint}/session-profile`, { headers: { authorization: "Bearer test-token", "x-minu-runtime-owner": "other-owner", "x-minu-runtime-session": "managed" } });
    assert.equal(forged.status, 404); assert.equal(reads, 0);
    const value = await f.runtime.inspectSessionProfile("managed", "owner"); assert.equal(value?.model.status, "verified"); assert.equal(reads, 1);
    assert.equal(await readFile(path, "utf8"), before);
    assert.deepEqual(await readdir(f.dir), ["managed.json"], "no manifests, locks, launch files or credential writes");
    const response = await fetch(`${f.bridge.endpoint}/session-profile`, { headers: { authorization: "Bearer test-token", "x-minu-runtime-owner": "owner", "x-minu-runtime-session": "managed" } });
    assert.equal(response.headers.get("cache-control"), "no-store"); assert.doesNotMatch(await response.text(), /SECRET|PRIVATE_NATIVE|PRIVATE_PATH/);
  } finally { await f.close(); }
  const old = await fixture(); try { assert.equal(await old.runtime.inspectSessionProfile("managed", "owner"), undefined); } finally { await old.close(); }
});

test("registry reads reject unsafe sources without cleanup, directory creation or manifest migration", async () => {
  const f = await fixture(async () => profile());
  try {
    const path = join(f.dir, "managed.json"), before = await readFile(path, "utf8");
    await writeFile(path, JSON.stringify({ ...f.registration, pid: 2147483000 }));
    assert.equal(await inspectRegistration("managed"), undefined);
    assert.equal(JSON.parse(await readFile(path, "utf8")).pid, 2147483000, "stale registration is NOT removed");
    await writeFile(path, before); await chmod(path, 0o644);
    assert.equal(await f.runtime.inspectSessionProfile("managed", "owner"), undefined);
    await chmod(path, 0o600); await rm(path); await writeFile(join(f.dir, "target"), before, { mode: 0o600 }); await symlink(join(f.dir, "target"), path);
    assert.equal(await inspectRegistration("managed"), undefined); assert.equal(await readFile(join(f.dir, "target"), "utf8"), before);
  } finally { await f.close(); }
});

test("registration replacement during a read fences the old result", async () => {
  const entered = gate<void>(), pending = gate<void>();
  const f = await fixture(async () => { entered.resolve(); await pending.promise; return profile(); });
  try {
    const reading = f.runtime.inspectSessionProfile("managed", "owner"); await entered.promise;
    await writeRegistration({ ...f.registration, token: "new-worker-token" }); pending.resolve();
    assert.equal(await reading, undefined);
  } finally { pending.resolve(); await f.close(); }
});

test("profile redirects are not followed to another resource or endpoint", async () => {
  const f = await fixture();
  let redirected = 0;
  const server = createServer((request, response) => {
    if (request.url === "/session-profile") { response.writeHead(302, { location: "/redirected-resource" }); response.end(); }
    else { redirected++; response.end(JSON.stringify({ profile: profile() })); }
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    await writeRegistration({ ...f.registration, endpoint: `http://127.0.0.1:${(server.address() as AddressInfo).port}` });
    assert.equal(await f.runtime.inspectSessionProfile("managed", "owner"), undefined);
    assert.equal(redirected, 0, "owner/session headers stay on the selected existing-worker route");
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await f.close(); }
});

test("caller cancellation covers response decoding and oversized transport is rejected", async () => {
  for (const oversized of [false, true]) {
    const f = await fixture();
    const sockets = new Set<import("node:net").Socket>();
    const server = createServer((_request, response) => { response.writeHead(200, { "content-type": "application/json" }); if (oversized) response.end(JSON.stringify({ profile: profile(), secret: "x".repeat(20_000) })); else response.write('{"profile":'); });
    server.on("connection", socket => { sockets.add(socket); socket.on("close", () => sockets.delete(socket)); });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    try {
      await writeRegistration({ ...f.registration, endpoint: `http://127.0.0.1:${(server.address() as AddressInfo).port}` });
      const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 50);
      if (oversized) assert.equal(await f.runtime.inspectSessionProfile("managed", "owner"), undefined);
      else await assert.rejects(f.runtime.inspectSessionProfile("managed", "owner", { signal: controller.signal }), { name: "AbortError" });
      clearTimeout(timer);
    } finally { for (const socket of sockets) socket.destroy(); await new Promise<void>(resolve => server.close(() => resolve())); await f.close(); }
  }
});

test("stalled bridge getters stay bounded to one physical read without affecting status or send admission", { timeout: 10000 }, async () => {
  let reads = 0, sends = 0; const pending = gate<RuntimeSessionProfile>();
  const f = await fixture(async () => { reads++; return pending.promise; }, async () => { sends++; });
  try {
    const started = performance.now();
    const first = f.runtime.inspectSessionProfile("managed", "owner");
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(await f.runtime.inspectSessionProfile("managed", "owner"), undefined);
    await f.runtime.send("managed", "Fake-worker admission during metadata read");
    assert.equal(sends, 1, "a pending profile read does not acquire turn admission");
    assert.equal(await first, undefined);
    assert.ok(performance.now() - started < 3000, "two-second read deadline is independent of HTTP fixture shutdown");
    assert.equal(await f.runtime.inspectSessionProfile("managed", "owner"), undefined);
    assert.equal(reads, 1);
    const statusStarted = performance.now();
    assert.equal(await f.runtime.status("managed"), "idle");
    assert.ok(performance.now() - statusStarted < 1000, "profile stalls cannot block status");
  } finally { pending.resolve(profile()); await f.close(); }
});
