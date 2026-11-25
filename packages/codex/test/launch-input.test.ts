import assert from "node:assert/strict";
import { mkdtemp, realpath, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test, { type TestContext } from "node:test";
import type { AgentTurn, RuntimeImageContent } from "@minu/runtime-core";
import { CodexAgentRuntime, CodexNativeStartupCleanupError } from "../src/client.js";
import { CodexRpcProcess } from "../src/rpc.js";
import { CodexWorkerClient } from "../src/worker-client.js";
import { CodexManagedStore } from "../src/managed-store.js";
const png: RuntimeImageContent = { type: "image", mimeType: "image/png", data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==" };
function alive(pid: number) { try { process.kill(pid, 0); return true; } catch { return false; } }
async function gone(pid: number) { for (let i = 0; i < 300 && alive(pid); i++) await new Promise(r => setTimeout(r, 10)); assert.equal(alive(pid), false); }
async function fixture(t: TestContext, scenario = "normal") {
  const cwd = await realpath(await mkdtemp(join(tmpdir(), "codex-launch-input-"))), log = join(cwd, "native.log");
  const options = { managedRoot: join(cwd, "managed"), command: process.execPath,
    args: [fileURLToPath(new URL("./fixtures/app-server.js", import.meta.url)), scenario, log], requestTimeoutMs: 2000, shutdownTimeoutMs: 100 };
  const runtime = new CodexAgentRuntime(options), store = new CodexManagedStore(options.managedRoot);
  const sessions: Array<{ id: string; runtime: CodexAgentRuntime; pid?: number }> = [];
  const calls = async (): Promise<any[]> => { try { return (await readFile(log, "utf8")).trim().split("\n").map(line => JSON.parse(line)); } catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return []; throw e; } };
  t.after(async () => { for (const s of sessions) { await s.runtime.stop(s.id).catch(() => {}); if (s.pid) await gone(s.pid); }
    let leaked = false;
    for (const call of await calls()) if (call.pid) {
      if (alive(call.pid)) { leaked = true; process.kill(call.pid, "SIGTERM"); }
      await gone(call.pid);
    }
    await rm(cwd, { recursive: true, force: true });
    assert.equal(leaked, false, "Unexpected unregistered native process after fixture cleanup"); });
  return { cwd, options, runtime, store, calls, async remember<T extends { id: string }>(s: T, adapter = runtime) {
    const saved = "ownerId" in s ? await store.read(s.id, String(s.ownerId)) : undefined;
    sessions.push({ id: s.id, runtime: adapter, pid: saved?.worker.state === "ready" ? saved.worker.connection.pid : undefined }); return s;
  } };
}
async function settled(runtime: CodexAgentRuntime, id: string, turn: AgentTurn) {
  for (let i = 0; i < 400 && turn.status === "running"; i++) { await new Promise(r => setTimeout(r, 10)); turn = (await runtime.turn(id, turn.id))!; }
  assert.notEqual(turn.status, "running"); return turn;
}

test("explicit launch discovery uses one ephemeral thread, sanitizes identities and confirms exit", async t => {
  const f = await fixture(t); const caps = await f.runtime.capabilities({ cwd: f.cwd });
  assert.deepEqual(caps.defaultModel, { provider: "openai", id: "gpt-test" }); assert.equal(caps.defaultReasoningLevel, "medium");
  assert.ok(caps.reasoningLevels.includes("max")); assert.equal(caps.skills.length, 2);
  assert.equal(JSON.stringify(caps).includes(f.cwd), false); assert.equal(JSON.stringify(caps).includes("SKILL.md"), false);
  assert.ok(caps.skills.every(s => /^codex-skill-[a-f0-9]{64}$/.test(s.id)));
  const calls = await f.calls(), starts = calls.filter(c => c.method === "thread/start");
  assert.equal(starts.length, 1); assert.equal(starts[0].params.ephemeral, true);
  assert.equal(starts[0].params.sandbox, "read-only"); assert.equal(starts[0].params.approvalPolicy, "never");
  assert.equal(calls.some(c => c.method === "turn/start" || c.method?.includes("/write")), false);
  await gone(calls[0].pid); assert.deepEqual(await f.runtime.listManagedSessions("owner"), []);
});

test("skills that Codex loads shortly after startup are discovered, selected and deselected", async t => {
  const f = await fixture(t, "late-skills"), caps = await f.runtime.capabilities({ cwd: f.cwd });
  assert.deepEqual(caps.skills.map(s => s.name), ["alpha", "late:late"]);
  await f.remember(await f.runtime.start({ cwd: f.cwd, skillIds: [caps.skills[1].id] }));
  await f.remember(await f.runtime.start({ cwd: f.cwd, skillIds: [] }));
  const starts = (await f.calls()).filter(c => c.method === "thread/start" && c.params.ephemeral !== true);
  assert.deepEqual(starts.map(c => c.params.config.skills.config.map((s: any) => s.enabled)), [[false, true], [false, false]]);
});

test("a skill list that never settles is bounded", { timeout: 15_000 }, async t => {
  const f = await fixture(t, "growing-skills");
  assert.ok((await f.runtime.capabilities({ cwd: f.cwd })).skills.length > 1);
});

test("plugin-qualified skills are discovered and selected", async t => {
  const f = await fixture(t, "plugin-skills"), caps = await f.runtime.capabilities({ cwd: f.cwd });
  assert.deepEqual(caps.skills.map(s => s.name), ["alpha", "pdf:pdf"]);
  await f.remember(await f.runtime.start({ cwd: f.cwd, skillIds: [caps.skills[1].id] }));
  const start = (await f.calls()).filter(c => c.method === "thread/start").at(-1);
  assert.deepEqual(start.params.config.skills.config.map((s: any) => s.enabled), [false, true]);
});

test("a missing codex executable is a named setup error from capabilities and start, with no path", async t => {
  const f = await fixture(t), command = join(f.cwd, "no-such-codex");
  const runtime = new CodexAgentRuntime({ command, requestTimeoutMs: 2000, shutdownTimeoutMs: 100 });
  for (const attempt of [() => runtime.capabilities({ cwd: f.cwd }), () => runtime.start({ cwd: f.cwd })]) {
    const error = await attempt().then(() => undefined, caught => caught);
    assert.equal(error?.name, "CodexNotInstalledError");
    assert.equal(error.message, "Codex is not installed; install `codex`");
    assert.equal(error.message.includes(f.cwd), false);
  }
});

test("a signed-out codex is a named setup error before discovery or any thread exists", async t => {
  const f = await fixture(t, "signed-out");
  const error = await f.runtime.capabilities({ cwd: f.cwd }).then(() => undefined, caught => caught);
  assert.equal(error?.name, "CodexAuthRequiredError");
  assert.equal(error.message, "Codex is not logged in; run `codex login`");
  const started = await f.runtime.start({ cwd: f.cwd }).then(() => undefined, caught => caught);
  assert.equal(started?.name, "CodexAuthRequiredError");
  const calls = await f.calls();
  assert.ok(calls.some(c => c.method === "account/read"));
  assert.equal(calls.some(c => c.method === "thread/start" || c.method === "model/list"), false);
  for (const pid of new Set(calls.map(c => c.pid))) await gone(pid);
});

for (const scenario of ["custom-provider", "account-unsupported"]) test(`${scenario} is never reported as signed out`, async t => {
  const f = await fixture(t, scenario);
  assert.equal((await f.runtime.capabilities({ cwd: f.cwd })).defaultModel?.id, "gpt-test");
  await f.remember(await f.runtime.start({ cwd: f.cwd }));
});

test("malformed qualified skill names keep discovery unavailable", async t => {
  const f = await fixture(t, "malformed-skill"); await assert.rejects(f.runtime.capabilities({ cwd: f.cwd }), /unavailable/);
});

test("discovery workspace failures reveal no private paths and start no process", async t => {
  const f = await fixture(t);
  await assert.rejects(f.runtime.capabilities({ cwd: join(f.cwd, "missing-private-workspace") }), error => {
    assert.equal(error instanceof Error && error.message.includes(f.cwd), false); return true;
  });
  assert.deepEqual(await f.calls(), []);
});

test("non-ephemeral discovery is unavailable without retry", async t => {
  const f = await fixture(t, "discovery-persistent"); await assert.rejects(f.runtime.capabilities({ cwd: f.cwd }), /unavailable/);
  assert.equal((await f.calls()).filter(c => c.method === "thread/start").length, 1);
});

test("discovery never returns defaults after unconfirmed cleanup and retains exact shutdown authority", async t => {
  const f = await fixture(t), stop = CodexRpcProcess.prototype.stop; let rpc: CodexRpcProcess | undefined, attempts = 0;
  t.mock.method(CodexRpcProcess.prototype, "stop", function(this: CodexRpcProcess) { rpc = this; attempts++; return Promise.reject(new Error("Unconfirmed")); });
  try {
    await assert.rejects(f.runtime.capabilities({ cwd: f.cwd }), CodexNativeStartupCleanupError); assert.equal(attempts, 1);
    assert.ok(alive((await f.calls())[0].pid));
  } finally { if (rpc) await stop.call(rpc); }
});

for (const ids of ["all", "empty", "omitted"] as const) test(`native skill ${ids} selection is scoped and exact`, async t => {
  const f = await fixture(t), caps = await f.runtime.capabilities({ cwd: f.cwd });
  const selected = ids === "all" ? [caps.skills[0].id] : ids === "empty" ? [] : undefined;
  await f.remember(await f.runtime.start({ cwd: f.cwd, ...(selected ? { skillIds: selected } : {}) }));
  const start = (await f.calls()).filter(c => c.method === "thread/start").at(-1);
  if (ids === "omitted") assert.equal(start.params.config, undefined);
  else assert.deepEqual(start.params.config.skills.config.map((s: any) => s.enabled), ids === "all" ? [true, false] : [false, false]);
  assert.equal((await f.calls()).some(c => c.method === "skills/config/write"), false);
});

test("native selection rejection does not expose private skill paths or diagnostics", async t => {
  const f = await fixture(t, "selection-error");
  await assert.rejects(f.runtime.start({ cwd: f.cwd, skillIds: [] }), error => {
    assert.ok(error instanceof Error); assert.equal(error.message.includes(f.cwd), false);
    assert.equal(error.message.includes("PRIVATE_SECRET"), false); return true;
  });
});

for (const mode of ["direct", "managed"] as const) {
  test(`${mode} native provider IDs preserve whitespace, Unicode and byte-boundary strings exactly`, async t => {
    const f = await fixture(t, "unknown-model");
    const providers = ["review provider", " review provider ", "re\u0301view provider", "p".repeat(512)];
    for (const provider of providers) {
      const config = { cwd: f.cwd, model: { provider, id: "custom-text-v1" } };
      const s = await f.remember(mode === "direct" ? await f.runtime.start(config) : await f.runtime.startManaged(config, "owner"));
      await f.runtime.send(s.id, "Native-compatible provider text");
      assert.equal((await f.calls()).filter(call => call.method === "thread/start").at(-1).params.modelProvider, provider);
      if ("ownerId" in s) assert.equal((await f.store.read(s.id, String(s.ownerId)))?.launchConfig.model?.provider, provider);
      assert.equal(await f.runtime.status(s.id), "idle");
    }
  });

  test(`${mode} provider selection still requires exact native acknowledgment`, async t => {
    const f = await fixture(t, "mismatch-provider"), config = { cwd: f.cwd, model: { provider: "review provider", id: "custom-text-v1" } };
    if (mode === "direct") await assert.rejects(f.runtime.start(config), /exact requested model/);
    else {
      const s = await f.remember(await f.runtime.startManaged(config, "owner"));
      await assert.rejects(f.runtime.send(s.id, "No silent provider normalization"));
      assert.equal(await f.runtime.status(s.id), "offline");
    }
    assert.equal((await f.calls()).some(call => call.method === "turn/start"), false);
  });
}

test("malformed, empty and oversized explicit providers reject before native launch or managed persistence", async t => {
  const f = await fixture(t);
  for (const provider of [undefined, null, 42, [], {}, "", "   ", "provider\nname", "provider\u0000name", "provider\u007f", "\ud800", "p".repeat(513), "é".repeat(257)]) {
    const config = { cwd: f.cwd, model: { provider: provider as string, id: "custom-text-v1" } };
    await assert.rejects(f.runtime.start(config), /Invalid Codex launch selection/);
    await assert.rejects(f.runtime.startManaged(config, "owner"), /Invalid Codex launch selection/);
  }
  assert.deepEqual(await f.calls(), []); assert.deepEqual(await f.runtime.listManagedSessions("owner"), []);
});

test("discovery provider privacy filtering is separate from explicit selection", async t => {
  const f = await fixture(t, "discovery-private-provider");
  await assert.rejects(f.runtime.capabilities({ cwd: f.cwd }), error => {
    assert.ok(error instanceof Error); assert.equal(error.message.includes("/private/native-provider"), false); return true;
  });
  assert.equal((await f.calls()).filter(call => call.method === "thread/start").length, 1);
});

test("unknown skill and unsupported model reasoning fail before user input", async t => {
  const f = await fixture(t);
  await assert.rejects(f.runtime.start({ cwd: f.cwd, skillIds: [`codex-skill-${"a".repeat(64)}`] }));
  await assert.rejects(f.runtime.start({ cwd: f.cwd, model: { provider: "openai", id: "text-model" }, reasoningLevel: "high" }));
  const session = await f.remember(await f.runtime.start({ cwd: f.cwd, reasoningLevel: "max" })); assert.equal(await f.runtime.status(session.id), "idle");
  assert.equal((await f.calls()).some(c => c.method === "turn/start"), false);
});

test("ordered image-only direct turns have typed identities and no pixel projection", async t => {
  const f = await fixture(t, "held"), s = await f.remember(await f.runtime.start({ cwd: f.cwd }));
  assert.deepEqual(await f.runtime.inputCapabilities(s.id), { version: 1, images: true });
  const images = [png, { ...png, mimeType: "image/jpeg" as const }];
  const first = await f.runtime.startTurn(s.id, "pixels", "", images);
  assert.deepEqual(await f.runtime.startTurn(s.id, "pixels", "", images), first);
  await assert.rejects(f.runtime.startTurn(s.id, "pixels", "", [...images].reverse()), /conflict/);
  await assert.rejects(f.runtime.startTurn(s.id, "pixels", "", [png]), /conflict/);
  await f.runtime.interrupt(s.id); const turn = await settled(f.runtime, s.id, first);
  const request = (await f.calls()).find(c => c.method === "turn/start");
  assert.deepEqual(request.params.input, images.map(i => ({ type: "image", url: `data:${i.mimeType};base64,${i.data}` })));
  assert.equal(JSON.stringify({ turn, messages: await f.runtime.messages(s.id) }).includes(png.data), false);
});

for (const scenario of ["text-only", "unknown-model"] as const) test(`${scenario} keeps text and reports incompatible/unknown vision honestly`, async t => {
  const f = await fixture(t, scenario), s = await f.remember(await f.runtime.start({ cwd: f.cwd,
    ...(scenario === "unknown-model" ? { model: { provider: "local", id: "provider/model:v1" }, reasoningLevel: "high" as const } : {}) }));
  if (scenario === "text-only") assert.deepEqual(await f.runtime.inputCapabilities(s.id), { version: 1, images: false });
  else await assert.rejects(f.runtime.inputCapabilities(s.id), /unavailable/);
  await assert.rejects(f.runtime.startTurn(s.id, "image", "", [png]));
  assert.equal((await f.calls()).some(c => c.method === "turn/start"), false);
  await f.runtime.send(s.id, "Still text");
});

for (const scenario of ["text-only", "unknown-model"] as const) for (const allocated of [false, true]) {
  test(`managed ${scenario} image rejection preserves ${allocated ? "existing" : "first-use"} native text usability`, { timeout: 15000 }, async t => {
    const f = await fixture(t, scenario), s = await f.remember(await f.runtime.startManaged({ cwd: f.cwd }, "owner"));
    if (allocated) await f.runtime.send(s.id, "Initial text");
    const before = (await f.store.read(s.id, s.ownerId))!;
    const rejected = await settled(f.runtime, s.id, await f.runtime.startTurn(s.id, "unsupported-image", "", [png]));
    assert.equal(rejected.status, "failed"); assert.match(rejected.error!, /does not support images|unverified/);
    assert.equal(await f.runtime.status(s.id), "idle");
    assert.deepEqual(await f.runtime.startTurn(s.id, "unsupported-image", "", [png]), rejected);
    await assert.rejects(f.runtime.startTurn(s.id, "unsupported-image", "different input"));
    const bound = (await f.store.read(s.id, s.ownerId))!;
    assert.equal(bound.native.state, "bound"); assert.equal(bound.generation, before.generation);
    if (allocated) assert.deepEqual(bound, before);
    const pid = (await f.calls()).find(call => call.pid).pid; assert.ok(alive(pid));
    assert.equal((await f.calls()).filter(call => call.method === "turn/start").length, allocated ? 1 : 0);
    await f.runtime.send(s.id, "Valid text after rejected image");
    assert.equal(await f.runtime.status(s.id), "idle"); assert.ok(alive(pid));
    assert.deepEqual(await f.store.read(s.id, s.ownerId), bound);
    assert.equal((await f.calls()).filter(call => call.method === "thread/start").length, 1);
    assert.equal((await f.calls()).filter(call => call.method === "turn/start").length, allocated ? 2 : 1);
  });
}

test("native model rerouting fails instead of silently changing the selected model", async t => {
  const f = await fixture(t, "reroute"), s = await f.remember(await f.runtime.start({ cwd: f.cwd }));
  await assert.rejects(f.runtime.send(s.id, "Stay on this model"), /changed the selected model/);
  assert.equal(await f.runtime.status(s.id), "offline"); await assert.rejects(f.runtime.inputCapabilities(s.id));
  assert.equal((await f.calls()).filter(c => c.method === "turn/start").length, 1);
});

test("image errors and events never project native pixel diagnostics", async t => {
  const f = await fixture(t, "image-error"), s = await f.remember(await f.runtime.start({ cwd: f.cwd }));
  const events = f.runtime.events(s.id), observed: unknown[] = [];
  const observing = (async () => { for await (const event of events) { observed.push(event); if (event.type === "error") break; } })();
  await assert.rejects(f.runtime.send(s.id, "", [png]), /image turn failed/); await observing;
  assert.equal(JSON.stringify({ observed, messages: await f.runtime.messages(s.id) }).includes(png.data), false);
  await events.return?.();
});

test("later text errors cannot expose earlier image history", async t => {
  const f = await fixture(t, "history-image-error"), s = await f.remember(await f.runtime.start({ cwd: f.cwd }));
  await f.runtime.send(s.id, "First image", [png]);
  const turn = await settled(f.runtime, s.id, await f.runtime.startTurn(s.id, "followup", "Text only"));
  assert.equal(turn.status, "failed"); assert.match(turn.error!, /native turn request failed/);
  assert.equal(JSON.stringify({ turn, history: await f.runtime.messages(s.id) }).includes(png.data), false);
});

test("bounded image envelopes beyond the old 8 MiB frame limit preserve native history", { timeout: 15000 }, async t => {
  const f = await fixture(t, "lifecycle"), s = await f.remember(await f.runtime.startManaged({ cwd: f.cwd }, "owner"));
  const image = { ...png, data: Buffer.alloc(6 * 1024 * 1024 + 1, 7).toString("base64") };
  await f.runtime.send(s.id, "Large transport", [image]);
  assert.equal(JSON.stringify(await f.runtime.messages(s.id)).includes(image.data), false);
  if (process.platform === "darwin") { await f.runtime.suspend(s.id, s.ownerId); assert.equal((await f.runtime.listManagedSessions(s.ownerId))[0].state, "suspended"); }
});

test("image preparation cancellation never dispatches pixels", { timeout: 15000 }, async t => {
  const f = await fixture(t, "paused-create"), s = await f.remember(await f.runtime.startManaged({ cwd: f.cwd }, "owner"));
  const turn = await f.runtime.startTurn(s.id, "cancel-image", "", [png]);
  for (let i = 0; i < 400 && !(await f.calls()).some(c => c.method === "thread/start"); i++) await new Promise(r => setTimeout(r, 10));
  await f.runtime.interrupt(s.id); await writeFile(join(f.cwd, "native.log.release"), "release");
  assert.equal((await settled(f.runtime, s.id, turn)).status, "interrupted");
  assert.equal((await f.calls()).some(c => c.method === "turn/start"), false);
});

test("live vision observation uses the actual pinned model without a work-stopping catalog RPC", async t => {
  const f = await fixture(t, "catalog-stall-after-open"), s = await f.remember(await f.runtime.start({ cwd: f.cwd }));
  const turn = await f.runtime.startTurn(s.id, "held", "Keep working");
  assert.deepEqual(await f.runtime.inputCapabilities(s.id), { version: 1, images: true });
  assert.equal((await f.calls()).filter(c => c.method === "model/list").length, 1);
  assert.equal(await f.runtime.status(s.id), "working"); await f.runtime.interrupt(s.id);
  assert.equal((await settled(f.runtime, s.id, turn)).status, "interrupted");
});

test("reachable managed workers do not advertise live capabilities after native exit", async t => {
  const f = await fixture(t), s = await f.remember(await f.runtime.startManaged({ cwd: f.cwd }, "owner"));
  await f.runtime.send(s.id, "Allocate"); const pid = (await f.calls()).find(c => c.pid).pid;
  process.kill(pid, "SIGTERM"); await gone(pid);
  await assert.rejects(f.runtime.sessionCapabilities(s.id)); await assert.rejects(f.runtime.inputCapabilities(s.id));
});

test("managed text keeps the legacy worker request envelope", async t => {
  const f = await fixture(t), s = await f.remember(await f.runtime.startManaged({ cwd: f.cwd }, "owner"));
  const request = CodexWorkerClient.prototype.request; let turns = 0;
  t.mock.method(CodexWorkerClient.prototype, "request", function(this: CodexWorkerClient, ...args: Parameters<typeof request>) {
    if (args[0] === "startTurn") { turns++; assert.equal(Object.hasOwn(args[1]!, "images"), false); }
    return request.apply(this, args);
  });
  await f.runtime.send(s.id, "Legacy text");
  await settled(f.runtime, s.id, await f.runtime.startTurn(s.id, "second", "Still text", []));
  assert.equal(turns, 2);
});

for (const scenario of ["normal", "text-only"] as const) test(`managed ${scenario} session answers input capabilities before its first turn without opening a thread`, { timeout: 15000 }, async t => {
  const f = await fixture(t, scenario === "normal" ? "lifecycle" : "lifecycle-text-only"), s = await f.remember(await f.runtime.startManaged({ cwd: f.cwd, skillIds: [] }, "owner"));
  assert.deepEqual(await f.runtime.inputCapabilities(s.id), { version: 1, images: scenario === "normal" });
  const calls = await f.calls();
  assert.equal(calls.some(c => c.method === "turn/start"), false);
  assert.ok(calls.filter(c => c.method === "thread/start").every(c => c.params.ephemeral === true && c.params.sandbox === "read-only"));
  assert.deepEqual((await f.store.read(s.id, "owner"))?.native, { state: "pending" });
  for (const pid of new Set(calls.map(c => c.pid))) await gone(pid);
  // The session still opens lazily and normally afterwards.
  assert.equal((await settled(f.runtime, s.id, await f.runtime.startTurn(s.id, "after", "hello"))).status, "completed");
});

test("managed lazy image admission, authenticated live queries and cold history retain no pixel projection", { timeout: 15000 }, async t => {
  const f = await fixture(t, "lifecycle"), s = await f.remember(await f.runtime.startManaged({ cwd: f.cwd, skillIds: [] }, "owner"));
  assert.deepEqual(await f.calls(), []);
  await assert.rejects(f.runtime.startTurn(s.id, "bad", "", [{ ...png, data: "invalid" }]));
  await assert.rejects(f.runtime.startTurn(s.id, "too-many", "", Array.from({ length: 5 }, () => png)));
  assert.deepEqual(await f.calls(), []);
  const turn = await settled(f.runtime, s.id, await f.runtime.startTurn(s.id, "image", "", [png])); assert.equal(turn.status, "completed");
  assert.deepEqual(await f.runtime.inputCapabilities(s.id), { version: 1, images: true });
  assert.equal((await f.runtime.sessionCapabilities(s.id)).liveSkillVerification, false);
  await assert.rejects(f.runtime.startTurn(s.id, "image", "", [{ ...png, mimeType: "image/jpeg" }]));
  const history = await f.runtime.messages(s.id); assert.equal(JSON.stringify({ turn, history }).includes(png.data), false);
  if (process.platform === "darwin") {
    await f.runtime.suspend(s.id, s.ownerId); const fresh = new CodexAgentRuntime(f.options);
    await f.remember(await fresh.resume(s.id, s.ownerId), fresh); assert.deepEqual(await fresh.messages(s.id), history);
    assert.deepEqual(await fresh.inputCapabilities(s.id), { version: 1, images: true });
    await fresh.destroy(s.id, s.ownerId);
    assert.ok((await readFile(`${join(f.cwd, "native.log")}.history.json`, "utf8")).includes(png.data));
  }
});
