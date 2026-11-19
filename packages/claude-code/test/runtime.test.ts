import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import type { AgentTurn, RuntimeActivityEvent } from "@minu/runtime-core";
import { ClaudeCodeAgentRuntime, type ClaudeCodeRuntimeOptions } from "../src/index.js";

const fixture = fileURLToPath(new URL("./fixtures/claude.js", import.meta.url));
const pause = () => new Promise<void>((resolve) => setTimeout(resolve, 10));
async function waitFor<T>(read: () => Promise<T>, done: (value: T) => boolean): Promise<T> {
  const end = Date.now() + 5_000;
  while (true) {
    const value = await read();
    if (done(value)) return value;
    if (Date.now() > end) throw new Error("Test condition timed out");
    await pause();
  }
}
async function terminal(runtime: ClaudeCodeAgentRuntime, session: string, id: string): Promise<AgentTurn> {
  return (await waitFor(() => runtime.turn(session, id), (value) => !!value && value.status !== "running"))!;
}
const dir0 = (session: { cwd: string }) => session.cwd;
async function setup(t: { after: (fn: () => Promise<void>) => void }, options: ClaudeCodeRuntimeOptions = {}, mode = "") {
  const dir = await mkdtemp(join(tmpdir(), "minu-claude-fixture-"));
  const runtime = new ClaudeCodeAgentRuntime({ executable: fixture, startupTimeoutMs: 5_000,
    env: { PATH: process.env.PATH, HOME: dir, CLAUDE_CONFIG_DIR: join(dir, "config"),
      MINU_CLAUDE_FIXTURE_MODE: mode, MINU_CLAUDE_FIXTURE_PID: join(dir, "pid"),
      MINU_CLAUDE_FIXTURE_INPUT: join(dir, "input") }, ...options });
  const session = await runtime.start({ cwd: dir, appendSystemPrompt: "Be concise" });
  t.after(async () => { await runtime.stop(session.id); await rm(dir, { recursive: true, force: true }); });
  return { runtime, session, dir };
}

test("text turns use one SDK process, project messages, and return isolated snapshots", async (t) => {
  const { runtime, session, dir } = await setup(t);
  assert.equal(session.runtime, "claude-code");
  assert.equal(await runtime.status(session.id), "idle");
  assert.deepEqual(await runtime.inputCapabilities(session.id), { version: 1, images: false });
  const pid = await readFile(join(dir, "pid"), "utf8");
  await runtime.send(session.id, "one");
  await runtime.send(session.id, "two");
  assert.equal(await readFile(join(dir, "pid"), "utf8"), pid);
  const messages = await runtime.messages(session.id);
  assert.deepEqual(messages.map((m) => [m.role, m.content]), [
    ["user", "one"], ["assistant", "reply: one"], ["user", "two"], ["assistant", "reply: two"],
  ]);
  messages[0].content = "mutated";
  assert.equal((await runtime.messages(session.id))[0].content, "one");
  await runtime.stop(session.id);
  assert.throws(() => process.kill(Number(pid), 0), { code: "ESRCH" });
  assert.equal(await runtime.status(session.id), "offline");
});

test("caller turn ids reuse running/terminal input and reject conflicts or busy sessions", async (t) => {
  const { runtime, session } = await setup(t);
  const first = await runtime.startTurn(session.id, "stable", "hold");
  assert.equal(first.status, "running");
  assert.deepEqual(await runtime.startTurn(session.id, "stable", "hold"), first);
  await assert.rejects(runtime.startTurn(session.id, "stable", "changed"), /conflicts/);
  await assert.rejects(runtime.startTurn(session.id, "second", "next"), /busy/);
  await runtime.stop(session.id);
  assert.equal((await runtime.turn(session.id, "stable"))?.status, "interrupted");
  assert.equal((await runtime.startTurn(session.id, "stable", "hold")).status, "interrupted");
  await assert.rejects(runtime.startTurn(session.id, "new", "new"), /offline/);
});

test("retention defines a bounded idempotency window and returned turns cannot be mutated", async (t) => {
  const { runtime, session } = await setup(t, { turnRetentionLimit: 2 });
  for (const id of ["a", "b", "c"]) {
    await runtime.startTurn(session.id, id, id);
    await terminal(runtime, session.id, id);
  }
  assert.equal(await runtime.turn(session.id, "a"), undefined);
  const turn = (await runtime.turn(session.id, "b"))!;
  turn.response!.content = "changed";
  assert.equal((await runtime.turn(session.id, "b"))?.response?.content, "reply: b");
  assert.equal((await runtime.startTurn(session.id, "b", "b")).status, "completed");
});

test("tool/delta projections omit reasoning, pixels, inputs and nested subagent text", async (t) => {
  const { runtime, session } = await setup(t);
  const events: unknown[] = [];
  const eventTask = (async () => { for await (const event of runtime.events(session.id)) events.push(event); })();
  const abort = new AbortController();
  const activities: RuntimeActivityEvent[] = [];
  const activityTask = (async () => { for await (const event of runtime.activityEvents(session.id, { signal: abort.signal })) activities.push(event); })();
  await runtime.send(session.id, "tool");
  abort.abort();
  await activityTask;
  await runtime.stop(session.id);
  await eventTask;
  const serialized = JSON.stringify({ events, messages: await runtime.messages(session.id), activities });
  for (const privateText of ["private reasoning", "private-pixels", "private-path", "private subagent text"]) assert.ok(!serialized.includes(privateText));
  assert.equal(events.filter((event: any) => event.type === "tool_started").length, 1);
  assert.equal(events.filter((event: any) => event.type === "tool_completed").length, 1);
  assert.ok((await runtime.messages(session.id)).some((m) => m.role === "tool" && m.content === "file contents" && m.toolName === "Read"));
  assert.deepEqual(activities.map((event) => event.phase), ["working", "using_tools", "responding"]);
  for (const event of activities) assert.deepEqual(Object.keys(event).sort(), ["observedAt", "phase"]);
});

test("a slow event subscriber is disconnected without blocking native completion", async (t) => {
  const { runtime, session } = await setup(t, { eventBufferLimit: 2 });
  const iterator = runtime.events(session.id)[Symbol.asyncIterator]();
  const first = iterator.next();
  await runtime.send(session.id, "burst");
  await first;
  await assert.rejects(iterator.next(), /fell behind/);
  assert.equal(await runtime.status(session.id), "idle");
  await runtime.send(session.id, "still works");
});

test("permission requests are denied by default and only an explicit handler grants approval", async (t) => {
  const denied = await setup(t);
  await denied.runtime.send(denied.session.id, "permission");
  assert.equal((await denied.runtime.messages(denied.session.id)).at(-1)?.content, "denied");
  let calls = 0;
  const allowed = await setup(t, { tools: ["Write"], canUseTool: async (name, input) => {
    calls++;
    assert.equal(name, "Write");
    return { behavior: "allow", updatedInput: input };
  } });
  await allowed.runtime.send(allowed.session.id, "permission");
  assert.equal(calls, 1);
  assert.equal((await allowed.runtime.messages(allowed.session.id)).at(-1)?.content, "allowed");
});

for (const kind of ["refusal_fallback_prompt", "future-runtime-dialog"]) {
  test(`headless ${kind} fails the owned session without a fabricated dialog answer`, async t => {
    const { runtime, session, dir } = await setup(t);
    await runtime.startTurn(session.id, "dialog", `user-dialog:${kind}`);
    const turn = await terminal(runtime, session.id, "dialog");
    assert.equal(turn.status, "failed"); assert.match(turn.error!, /unsupported interactive input/);
    assert.equal(await runtime.status(session.id), "offline");
    assert.doesNotMatch(JSON.stringify({ turn, messages: await runtime.messages(session.id) }), /PRIVATE_DIALOG/);
    await runtime.stop(session.id);
    const pid = Number(await readFile(join(dir, "pid"), "utf8"));
    assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
  });
}

test("headless dialog failure stops only its exact owned session", async t => {
  const { runtime, session, dir } = await setup(t);
  const firstPid = Number(await readFile(join(dir, "pid"), "utf8"));
  const cwd = join(dir, "second"); await mkdir(cwd, { mode: 0o700 });
  const second = await runtime.start({ cwd });
  t.after(() => runtime.stop(second.id));
  await runtime.startTurn(session.id, "dialog", "user-dialog:future-runtime-dialog");
  assert.equal((await terminal(runtime, session.id, "dialog")).status, "failed");
  await runtime.stop(session.id);
  assert.throws(() => process.kill(firstPid, 0), { code: "ESRCH" });
  await runtime.send(second.id, "unrelated session still works");
  assert.equal(await runtime.status(second.id), "idle");
  assert.equal((await runtime.messages(second.id)).at(-1)?.content, "reply: unrelated session still works");
  await runtime.stop(second.id);
});

test("headless MCP elicitation is declined without answering user fields or waiting", async t => {
  const { runtime, session } = await setup(t);
  await runtime.send(session.id, "elicitation");
  assert.equal((await runtime.messages(session.id)).at(-1)?.content, "elicitation declined");
  assert.doesNotMatch(JSON.stringify(await runtime.messages(session.id)), /PRIVATE_ELICITATION/);
  assert.equal(await runtime.status(session.id), "idle");
});

test("interrupt acknowledgement is not completion; a later native result settles the turn", async (t) => {
  const { runtime, session, dir } = await setup(t);
  await runtime.startTurn(session.id, "hold", "hold");
  await waitFor(() => readFile(join(dir, "input"), "utf8").catch(() => ""), (value) => value === "hold");
  await runtime.interrupt(session.id);
  assert.equal((await runtime.turn(session.id, "hold"))?.status, "running");
  await assert.rejects(runtime.startTurn(session.id, "next", "next"), /busy/);
  assert.equal((await terminal(runtime, session.id, "hold")).status, "interrupted");
  await runtime.send(session.id, "next");
});

test("immediate interruption cannot overtake the input write and leave untracked work", async (t) => {
  const { runtime, session } = await setup(t);
  await runtime.startTurn(session.id, "hold", "hold");
  await runtime.interrupt(session.id);
  assert.equal((await terminal(runtime, session.id, "hold")).status, "interrupted");
  await runtime.send(session.id, "after cancellation");
  assert.equal(await runtime.status(session.id), "idle");
});

test("undispatched cancellations do not fill the prompt queue or corrupt a reused caller id", async (t) => {
  const { runtime, session } = await setup(t, { turnRetentionLimit: 1 });
  const pending: Promise<unknown>[] = [];
  for (let n = 0; n < 10; n++) {
    pending.push(runtime.startTurn(session.id, `cancel-${n}`, "hold"));
    pending.push(runtime.interrupt(session.id));
  }
  await Promise.all(pending);
  await runtime.startTurn(session.id, "cancel-0", "reused safely");
  assert.equal((await terminal(runtime, session.id, "cancel-0")).response?.content, "reply: reused safely");
});

test("without a terminal result interrupt leaves the session busy", async (t) => {
  const { runtime, session, dir } = await setup(t, {}, "interrupt-no-result");
  await runtime.startTurn(session.id, "hold", "hold");
  await waitFor(() => readFile(join(dir, "input"), "utf8").catch(() => ""), (value) => value === "hold");
  await runtime.interrupt(session.id);
  assert.equal(await runtime.status(session.id), "working");
  await assert.rejects(runtime.startTurn(session.id, "next", "next"), /busy/);
});

test("uncertain control timeout fails offline and confirms process exit", async (t) => {
  const { runtime, session, dir } = await setup(t, { controlTimeoutMs: 50 }, "interrupt-hang");
  await runtime.startTurn(session.id, "hold", "hold");
  await waitFor(() => readFile(join(dir, "input"), "utf8").catch(() => ""), (value) => value === "hold");
  await assert.rejects(runtime.interrupt(session.id), /timed out/);
  assert.equal(await runtime.status(session.id), "offline");
  assert.equal((await runtime.turn(session.id, "hold"))?.status, "failed");
  const pid = Number(await readFile(join(dir, "pid"), "utf8"));
  assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
});

for (const input of ["wrong-session", "wrong-turn", "malformed-result", "crash"]) {
  test(`native ${input} fails the session without automatic replay`, async (t) => {
    const { runtime, session } = await setup(t);
    await assert.rejects(runtime.send(session.id, input));
    assert.equal(await runtime.status(session.id), "offline");
    await assert.rejects(runtime.startTurn(session.id, "retry", input), /offline/);
  });
}

test("native turn errors reject send without returning raw errors or killing a healthy session", async (t) => {
  const { runtime, session } = await setup(t);
  await assert.rejects(runtime.send(session.id, "fail"), /^Error: Claude Code turn failed$/);
  assert.equal(await runtime.status(session.id), "idle");
  await runtime.send(session.id, "recover");
});

test("unsupported launch/input/control options fail explicitly before model work", async (t) => {
  const runtime = new ClaudeCodeAgentRuntime({ executable: fixture });
  // Launch selections are now supported (see the A6 tests below); malformed or conflicting configuration still fails before launch.
  for (const config of [{ systemPrompt: "a", appendSystemPrompt: "b" }, { model: { provider: "other", id: "model" } },
    { reasoningLevel: "ultra" as never }, { skillIds: ["a", "a"] }]) await assert.rejects(runtime.start(config));
  const { runtime: live, session } = await setup(t);
  await assert.rejects(live.startTurn(session.id, "image", "image", [{ type: "image", mimeType: "image/png", data: "YQ==" }]), /not supported/);
  await assert.rejects(live.startTurn(session.id, "empty", "  "), /required/);
  await assert.rejects(live.startTurn(session.id, "oversize", "x".repeat(1024 * 1024 + 1)), /exceeds/);
  await assert.rejects(live.startTurn(session.id, "", "text"), /Turn id/);
  await assert.rejects(live.steer(session.id, "steer"), /no running turn/, "steering needs a running turn");
  assert.equal(await live.status(session.id), "idle");
  // The owner-per-call managed API now exists on the runtime, but an in-process session is never a managed one.
  assert.equal(typeof live.startManaged, "function");
  const managedRoot = join(dir0(session), "managed-probe");
  const separate = new ClaudeCodeAgentRuntime({ executable: fixture, managedRoot });
  assert.deepEqual(await separate.listManagedSessions("some-owner"), []);
  assert.equal(await separate.getManagedSession(session.id, "some-owner"), undefined);
});

for (const mode of ["startup-hang", "startup-exit"]) {
  test(`${mode} refuses registration and cleans up the spawned process`, async () => {
    const dir = await mkdtemp(join(tmpdir(), "minu-claude-startup-"));
    try {
      const runtime = new ClaudeCodeAgentRuntime({ executable: fixture, startupTimeoutMs: 500,
        env: { PATH: process.env.PATH, MINU_CLAUDE_FIXTURE_MODE: mode, MINU_CLAUDE_FIXTURE_PID: join(dir, "pid") } });
      await assert.rejects(runtime.start({ cwd: dir }));
      const pid = Number(await readFile(join(dir, "pid"), "utf8"));
      assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
}

const MODELS = JSON.stringify([
  { value: "default", displayName: "Default", description: "d", supportsEffort: true, supportedEffortLevels: ["low", "medium", "high"] },
  { value: "sonnet", resolvedModel: "claude-sonnet-fixture", displayName: "Sonnet", description: "s", supportsEffort: true, supportedEffortLevels: ["low", "high", "max"] },
  { value: "haiku", displayName: "Haiku", description: "h", supportsEffort: false },
]);
const COMMANDS = JSON.stringify([{ name: "compact", description: "builtin", argumentHint: "", builtin: true },
  { name: "review", description: "Review code", argumentHint: "" }, { name: "deploy", description: "Deploy it", argumentHint: "" }]);
async function selection(t: { after: (fn: () => Promise<void>) => void }) {
  const dir = await mkdtemp(join(tmpdir(), "minu-claude-select-"));
  const argv = join(dir, "argv"), pid = join(dir, "pid");
  const runtime = new ClaudeCodeAgentRuntime({ executable: fixture, startupTimeoutMs: 5_000, shutdownTimeoutMs: 2_000,
    env: { PATH: process.env.PATH, HOME: dir, CLAUDE_CONFIG_DIR: join(dir, "config"), MINU_CLAUDE_FIXTURE_MODELS: MODELS,
      MINU_CLAUDE_FIXTURE_COMMANDS: COMMANDS, MINU_CLAUDE_FIXTURE_ARGV: argv, MINU_CLAUDE_FIXTURE_PID: pid } });
  t.after(async () => { await rm(dir, { recursive: true, force: true }); });
  const flag = async (name: string) => (await readFile(argv, "utf8")).trim().split("\n").map(line => JSON.parse(line) as { argv: string[]; probe: boolean })
    .filter(entry => !entry.probe).at(-1)!.argv.find(arg => arg === name || arg.startsWith(`${name}=`));
  return { dir, runtime, flag, pid };
}

test("capabilities() reports models, the union of effort levels plus off, and skills without any session or input", async t => {
  const { dir, runtime } = await selection(t);
  const capabilities = await runtime.capabilities({ cwd: dir });
  assert.deepEqual(capabilities.models.map(m => [m.provider, m.id, m.name, m.reasoning]),
    [["anthropic", "default", "Default", true], ["anthropic", "sonnet", "Sonnet", true], ["anthropic", "haiku", "Haiku", false]]);
  assert.deepEqual(capabilities.reasoningLevels, ["off", "low", "medium", "high", "max"]);
  assert.deepEqual(capabilities.skills, [{ id: "review", name: "review", description: "Review code" }, { id: "deploy", name: "deploy", description: "Deploy it" }]);
  assert.deepEqual(capabilities.defaultModel, { provider: "anthropic", id: "default" });
  await assert.rejects(readFile(join(dir, "pid")), { code: "ENOENT" }, "no session or input");
  await assert.rejects(runtime.capabilities({ cwd: join(dir, "absent") }));
});

test("model, reasoning and skills are validated against discovery and passed to the engine", async t => {
  const { dir, runtime, flag } = await selection(t);
  const session = await runtime.start({ cwd: dir, model: { provider: "anthropic", id: "claude-sonnet-fixture" }, reasoningLevel: "max", skillIds: ["review"] });
  assert.equal(await flag("--model"), "--model=claude-sonnet-fixture"); assert.equal(await flag("--effort"), "--effort=max");
  await runtime.send(session.id, "hello"); await runtime.stop(session.id);
  const off = await runtime.start({ cwd: dir, reasoningLevel: "off", skillIds: [] });
  assert.equal(await flag("--thinking"), "--thinking=disabled", "off disables thinking (maxThinkingTokens: 0)"); await runtime.stop(off.id);
  const plain = await runtime.start({ cwd: dir }); assert.equal(await flag("--model"), undefined); assert.equal(await flag("--effort"), undefined);
  await runtime.stop(plain.id);
});

test("unsupported selections are refused after discovery with the engine confirmed gone and no session created", async t => {
  const { dir, runtime, pid } = await selection(t);
  for (const config of [{ model: { provider: "anthropic", id: "nonexistent" } }, { reasoningLevel: "xhigh" as const },
    { reasoningLevel: "minimal" as const }, { model: { provider: "anthropic", id: "haiku" }, reasoningLevel: "low" as const }, { skillIds: ["compact"] }, { skillIds: ["missing"] }]) {
    await assert.rejects(runtime.start(config), /Unsupported|Unknown/);
    const started = Number(await readFile(pid, "utf8")); assert.throws(() => process.kill(started, 0), { code: "ESRCH" });
  }
  await assert.rejects(runtime.start({ model: { provider: "openai", id: "gpt" }, cwd: dir }), /Unsupported/);
});
