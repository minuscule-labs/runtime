import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sessionIntegrations, unavailableIntegrationSnapshot, SESSION_INTEGRATIONS_LIMITS, type RuntimeIntegrationSnapshot } from "@minu/runtime-core";
import { PiAgentRuntime } from "../src/client.js";
import { createPiBridgeServer } from "../src/server.js";
import { writeRegistration } from "../src/registry.js";
import { createSessionIntegrationsReader, projectPiIntegrations } from "../src/session-integrations.js";
import { PiRpcUnsupportedCommandError } from "../src/pi-rpc.js";

function gate<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; }
const native = () => ({ version: 1, capturedAt: new Date().toISOString(), status: "available", coverage: { configuration: "complete", tools: "complete" }, operations: { inspect: "supported", reconnect: "unsupported", reloadConfiguration: "unsupported" },
  integrations: [{ id: "mcp.notes", name: "notes", kind: "mcp", source: "user", enabled: true, connection: "connected", toolCoverage: "complete", offeredCount: 2, registeredCount: 2, reachableCount: 2 }],
  tools: [{ name: "mcp__notes__read", integrationId: "mcp.notes", exposure: "codemode", declared: false, callable: true }, { name: "mcp__notes__hidden", integrationId: "mcp.notes", exposure: "hidden", declared: false, callable: false }], issues: [] });
const snapshot = () => projectPiIntegrations(native());
async function fixture(getSessionIntegrations?: (signal: AbortSignal) => Promise<RuntimeIntegrationSnapshot>) {
  const dir = await mkdtemp(join(tmpdir(), "runtime-integrations-test-"));
  const previous = process.env.MINU_RUNTIME_DIR;
  process.env.MINU_RUNTIME_DIR = dir;
  const bridge = await createPiBridgeServer({ sessionId: "PRIVATE_NATIVE", token: "test-token", managedSession: { id: "managed", ownerId: "owner" }, getStatus: () => "idle", async send() { throw new Error("must not send"); }, getSessionIntegrations });
  const registration = { sessionId: "managed", ownerId: "owner", endpoint: bridge.endpoint, token: "test-token", pid: process.pid, cwd: "/PRIVATE_PATH", ownership: "owned" as const, updatedAt: new Date().toISOString() };
  await writeRegistration(registration);
  return { dir, bridge, registration, runtime: new PiAgentRuntime(), async close() { await bridge.close(); await rm(dir, { recursive: true, force: true }); if (previous === undefined) delete process.env.MINU_RUNTIME_DIR; else process.env.MINU_RUNTIME_DIR = previous; } };
}

test("neutral projection excludes secrets and does not conflate registered, callable, and reachable", () => {
  const raw = native();
  Object.assign(raw, { token: "SECRET", sessionId: "PRIVATE_NATIVE", config: { headers: "SECRET" } });
  Object.assign(raw.integrations[0]!, { endpoint: "SECRET", sourcePath: "/PRIVATE_PATH" });
  const result = projectPiIntegrations(raw);
  assert.deepEqual(result.tools[0], { name: "mcp__notes__read", integrationId: "mcp.notes", visibility: "discoverable", routes: ["indirect"], reachability: "unknown" });
  assert.equal(result.integrations[0]?.registeredCount, 2);
  assert.equal(result.integrations[0]?.reachableCount, undefined, "native callability counts must not claim agent reachability");
  assert.doesNotMatch(JSON.stringify(result), /SECRET|PRIVATE|codemode|endpoint|sourcePath/);
  assert.deepEqual(result.tools[1]?.routes, []);
  assert.equal(projectPiIntegrations({ ...raw, tools: [] }).integrations[0]?.reachableCount, undefined, "omitted ownership evidence is not zero reachability");
  assert.equal(projectPiIntegrations({ ...raw, tools: [], integrations: [{ ...raw.integrations[0], registeredCount: 0, offeredCount: 0 }] }).integrations[0]?.reachableCount, 0);
});

test("per-integration failure attribution and omitted counts survive native normalization", () => {
  const raw = native();
  const result = projectPiIntegrations({ ...raw, coverage: { configuration: "complete", tools: "partial" },
    integrations: [
      { ...raw.integrations[0], registeredCount: undefined, callableCount: undefined, reachableCount: undefined, failureCode: "registration_failed" },
      { ...raw.integrations[0], id: "mcp.discovery", name: "discovery", failureCode: "discovery_failed" },
    ], issues: [] });
  assert.equal(result.integrations[0]?.registeredCount, undefined);
  assert.equal(result.integrations[0]?.callableCount, undefined);
  assert.equal(result.integrations[0]?.reachableCount, undefined);
  assert.deepEqual(result.integrations.map(entry => [entry.id, entry.failureCode]), [["mcp.notes", "registration_failed"], ["mcp.discovery", "discovery_failed"]]);
  assert.equal(sessionIntegrations({ ...result, integrations: [{ ...result.integrations[0], failureCode: "SECRET" }] }).integrations[0]?.failureCode, undefined);
});

test("neutral decoder bounds catalogs and transport, preserves unknown counts, rejects malformed versions", () => {
  const original = snapshot();
  const result = sessionIntegrations({ ...original, tools: Array.from({ length: 800 }, (_, i) => ({ name: `tool_${i}`, visibility: "hidden", routes: [], reachability: "not_reachable" })), integrations: [{ ...original.integrations[0], offeredCount: undefined, registeredCount: -1 }] });
  assert.equal(result.tools.length, SESSION_INTEGRATIONS_LIMITS.tools);
  assert.equal(result.coverage.tools, "partial");
  assert.equal(result.integrations[0]?.offeredCount, undefined);
  assert.equal(result.integrations[0]?.registeredCount, undefined);
  assert.ok(Buffer.byteLength(JSON.stringify(result)) < SESSION_INTEGRATIONS_LIMITS.bytes);
  assert.throws(() => sessionIntegrations({ ...original, version: 2 }));
  assert.equal(sessionIntegrations({ ...original, tools: [{}] }).coverage.tools, "partial");
  const hidden = sessionIntegrations({ ...original, tools: [{ name: "hidden_tool", visibility: "hidden", routes: ["model"], reachability: "reachable" }] });
  assert.deepEqual(hidden.tools[0]?.routes, []);
  assert.equal(hidden.tools[0]?.reachability, "not_reachable");
  assert.equal(hidden.coverage.tools, "partial");
});

test("unsupported and unavailable evidence cannot establish absence or retain catalogs", () => {
  for (const status of ["unsupported", "unavailable"] as const) {
    const result = sessionIntegrations({ ...snapshot(), status });
    assert.deepEqual(result.integrations, []);
    assert.deepEqual(result.tools, []);
    assert.deepEqual(result.coverage, { configuration: "unknown", tools: "unknown" });
    assert.equal(unavailableIntegrationSnapshot(status).status, status);
  }
});

test("exact-worker reader performs only native observation and rejects changed identities", async () => {
  const calls: string[] = [];
  const read = createSessionIntegrationsReader({ async request(type) { calls.push(type); return { sessionId: "native", snapshot: native() }; } }, "native");
  assert.equal((await read(new AbortController().signal)).integrations[0]?.connection, "connected");
  assert.deepEqual(calls, ["get_integrations"]);
  const changed = createSessionIntegrationsReader({ async request() { return { sessionId: "other", snapshot: native() }; } }, "native");
  await assert.rejects(changed(new AbortController().signal), /unavailable/);
});

test("explicit old-native command rejection is unsupported only after identity verification", async () => {
  for (const identity of ["native", "other"]) {
    const calls: string[] = [];
    const read = createSessionIntegrationsReader({ async request(type) { calls.push(type); if (type === "get_integrations") throw new PiRpcUnsupportedCommandError(); return { sessionId: identity }; } }, "native");
    if (identity === "native") assert.equal((await read(new AbortController().signal)).status, "unsupported");
    else await assert.rejects(read(new AbortController().signal), /unavailable/);
    assert.deepEqual(calls, ["get_integrations", "get_state"]);
  }
});

test("canceled observation retains physical RPC slot and discards late evidence", async () => {
  let calls = 0;
  const pending = gate<unknown>();
  const read = createSessionIntegrationsReader({ async request() { calls++; return pending.promise; } }, "native");
  const controller = new AbortController();
  const first = read(controller.signal); controller.abort();
  await assert.rejects(first, { name: "AbortError" });
  await assert.rejects(read(new AbortController().signal), /unavailable/);
  pending.resolve({ sessionId: "native", snapshot: native() });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls, 1);
});

test("bridge inspection stays exact-owner, no-store, bounded and read-only", async () => {
  let reads = 0;
  const f = await fixture(async () => { reads++; return snapshot(); });
  try {
    const path = join(f.dir, "managed.json"), before = await readFile(path, "utf8");
    assert.equal(await f.runtime.inspectSessionIntegrations("managed", "wrong"), undefined);
    assert.equal(reads, 0);
    const headers = { authorization: "Bearer test-token", "x-minu-runtime-owner": "owner", "x-minu-runtime-session": "managed" };
    const denied = await fetch(`${f.bridge.endpoint}/session-integrations`, { method: "POST", headers });
    assert.equal(denied.status, 405); assert.equal(reads, 0);
    const value = await f.runtime.inspectSessionIntegrations("managed", "owner");
    assert.equal(value?.integrations[0]?.connection, "connected");
    assert.match(value?.workerId ?? "", /^[a-f0-9-]{36}$/);
    const response = await fetch(`${f.bridge.endpoint}/session-integrations`, { headers });
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.doesNotMatch(await response.text(), /PRIVATE|SECRET/);
    assert.equal(await readFile(path, "utf8"), before);
    assert.deepEqual(await readdir(f.dir), ["managed.json"]);
  } finally { await f.close(); }
});

test("registration replacement fences an in-flight integration observation", async () => {
  const entered = gate<void>(), pending = gate<void>();
  const f = await fixture(async () => { entered.resolve(); await pending.promise; return snapshot(); });
  try {
    const reading = f.runtime.inspectSessionIntegrations("managed", "owner"); await entered.promise;
    await writeRegistration({ ...f.registration, token: "new-worker-token" }); pending.resolve();
    assert.equal(await reading, undefined);
  } finally { pending.resolve(); await f.close(); }
});

test("stalled integration getters cannot queue physical reads or block status", { timeout: 10000 }, async () => {
  let reads = 0; const pending = gate<RuntimeIntegrationSnapshot>();
  const f = await fixture(async () => { reads++; return pending.promise; });
  try {
    const first = f.runtime.inspectSessionIntegrations("managed", "owner");
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(await f.runtime.inspectSessionIntegrations("managed", "owner"), undefined);
    assert.equal(await f.runtime.status("managed"), "idle");
    assert.equal(await first, undefined);
    assert.equal(await f.runtime.inspectSessionIntegrations("managed", "owner"), undefined);
    assert.equal(reads, 1);
  } finally { pending.resolve(snapshot()); await f.close(); }
});
