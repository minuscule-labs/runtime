import assert from "node:assert/strict";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test, { type TestContext } from "node:test";
import type { AgentTurn, RuntimeActivityEvent } from "@minu/runtime-core";
import { CodexAgentRuntime, CodexSessionBusyError, CodexSessionOfflineError, type CodexAgentRuntimeOptions } from "../src/index.js";
import { finalResponse, normalizeCodexItem } from "../src/messages.js";

const fixturePath = fileURLToPath(new URL("./fixtures/app-server.js", import.meta.url));

async function fixture(t: TestContext, scenario = "normal", options: CodexAgentRuntimeOptions = {}) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "minu-codex-runtime-")));
  const logPath = join(directory, "requests.jsonl");
  const runtime = new CodexAgentRuntime({
    command: process.execPath, args: [fixturePath, scenario, logPath],
    requestTimeoutMs: 1_000, shutdownTimeoutMs: 100, ...options,
  });
  const sessions: string[] = [];
  t.after(async () => {
    await Promise.all(sessions.map((id) => runtime.stop(id)));
    await rm(directory, { recursive: true, force: true });
  });
  return {
    runtime, directory,
    async start(config: Parameters<typeof runtime.start>[0] = {}) {
      const session = await runtime.start({ cwd: directory, ...config });
      sessions.push(session.id);
      return session;
    },
    async resume(config: Parameters<typeof runtime.start>[0] = {}) {
      const session = await runtime.resumeNativeThread("native-thread", { cwd: directory, ...config });
      sessions.push(session.id);
      return session;
    },
    async log(): Promise<Array<Record<string, any>>> {
      return (await readFile(logPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    },
  };
}

async function settled(runtime: CodexAgentRuntime, sessionId: string, turnId: string): Promise<AgentTurn> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const turn = await runtime.turn(sessionId, turnId);
    if (turn && turn.status !== "running") return turn;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Turn did not settle within test deadline");
}

test("launches an owned Codex session with exact persona/model/reasoning and execution policy", async (t) => {
  const f = await fixture(t, "normal", { sandbox: "workspace-write" });
  const session = await f.start({ appendSystemPrompt: "Be skeptical", model: { provider: "openai", id: "selected-model" }, reasoningLevel: "high" });
  assert.equal(session.runtime, "codex");
  assert.equal(session.ownership, "owned");
  assert.equal(session.cwd, f.directory);
  assert.notEqual(session.id, "native-thread");
  assert.equal(await f.runtime.status(session.id), "idle");
  await f.runtime.send(session.id, "Review the files");
  const calls = await f.log();
  const launch = calls.find((call) => call.method === "thread/start")!.params;
  assert.equal(launch.developerInstructions, "Be skeptical");
  assert.equal(launch.model, "selected-model");
  assert.equal(launch.modelProvider, "openai");
  assert.deepEqual(launch.config, { model_reasoning_effort: "high" });
  assert.equal(launch.sandbox, "workspace-write");
  assert.equal(launch.approvalPolicy, "never");
  const turn = calls.find((call) => call.method === "turn/start")!.params;
  assert.equal(turn.model, "selected-model");
  assert.equal(turn.effort, "high");
  assert.deepEqual(turn.input, [{ type: "text", text: "Review the files", text_elements: [] }]);
  const messages = await f.runtime.messages(session.id);
  assert.equal(messages[0].role, "user");
  assert.equal(messages.at(-1)?.content, "Answer 1: café 🐈");
  messages[0].content = "mutated";
  assert.equal((await f.runtime.messages(session.id))[0].content, "Review the files");
});

test("native resume verifies identity/policy, hydrates paginated history, then accepts new turns", async t => {
  const f = await fixture(t);
  const session = await f.resume({ appendSystemPrompt: "Reviewer", model: { provider: "openai", id: "selected-model" }, reasoningLevel: "high" });
  assert.notEqual(session.id, "native-thread");
  assert.equal(await f.runtime.status(session.id), "idle");
  assert.deepEqual(await f.runtime.messages(session.id), [
    { role: "user", content: "Prior prompt" }, { role: "assistant", content: "Prior answer" },
    { role: "user", content: "Prior steering" }, { role: "tool", toolName: "shell", content: "Prior tool output" },
  ]);
  assert.equal(await f.runtime.turn(session.id, "old-turn-0"), undefined);
  await f.runtime.send(session.id, "New prompt");
  const calls = await f.log();
  assert.equal(calls.some(call => call.method === "thread/start"), false);
  const methods = calls.filter(call => call.method).map(call => call.method);
  assert.ok(methods.indexOf("thread/read") < methods.indexOf("thread/resume"));
  const resume = calls.find(call => call.method === "thread/resume")!.params;
  assert.equal(resume.threadId, "native-thread");
  assert.equal(resume.excludeTurns, true);
  assert.equal(resume.approvalPolicy, "never");
  assert.equal(resume.sandbox, "read-only");
  assert.equal(resume.model, "selected-model");
  assert.equal(resume.developerInstructions, "Reviewer");
  assert.equal("path" in resume, false);
  assert.equal("history" in resume, false);
  const pages = calls.filter(call => call.method === "thread/turns/list");
  assert.equal(pages.length, 2);
  assert.equal(pages[0].params.sortDirection, "asc");
  assert.equal(pages[0].params.itemsView, "full");
  assert.equal(pages[1].params.cursor, "page-1");
});

for (const scenario of ["resume-missing", "resume-read-id", "resume-read-cwd", "resume-read-active", "resume-read-array-status", "resume-read-ephemeral",
  "resume-response-id", "resume-response-cwd", "resume-response-active", "resume-response-ephemeral",
  "mismatch-model", "mismatch-reasoning", "mismatch-policy",
  "resume-history-summary", "resume-history-active", "resume-history-array-status", "resume-history-duplicate", "resume-history-cursor", "resume-history-pages",
  "resume-history-invalid-cursor", "resume-history-items",
  "resume-history-assistant-text", "resume-history-assistant-missing", "resume-history-user-content", "resume-history-user-text",
  "resume-history-user-part", "resume-history-tool-output", "resume-history-tool-result", "resume-history-tool-text", "resume-history-tool-parts", "resume-history-dynamic-text"]) {
  test(`native resume refuses ${scenario} and confirms spawned-process shutdown`, async t => {
    const f = await fixture(t, scenario);
    await assert.rejects(f.resume({ model: { provider: "openai", id: "selected-model" }, reasoningLevel: "high" }));
    const calls = await f.log();
    assert.throws(() => process.kill(calls[0].pid, 0), { code: "ESRCH" });
    assert.equal(calls.some(call => call.method === "thread/start" || call.method === "turn/start"), false);
    if (scenario.startsWith("resume-read-") || scenario === "resume-missing") {
      assert.equal(calls.some(call => call.method === "thread/resume"), false);
    }
  });
}

test("native resume distinguishes unsupported private items from valid supported messages", async t => {
  const f = await fixture(t, "resume-history-unsupported");
  const session = await f.resume();
  assert.equal(await f.runtime.status(session.id), "idle");
  assert.deepEqual((await f.runtime.messages(session.id)).slice(-3), [
    { role: "user", content: "Caption" },
    { role: "tool", toolName: "shell", content: "" },
    { role: "tool", toolName: "lookup", content: "MCP text" },
  ]);
  assert.equal(JSON.stringify(await f.runtime.messages(session.id)).includes("private"), false);
});

test("invalid native thread identifiers fail before any process launch", async () => {
  const runtime = new CodexAgentRuntime({ command: "/not-a-real-executable" });
  for (const id of ["", "../thread", "x".repeat(129)]) {
    await assert.rejects(runtime.resumeNativeThread(id, {}), /Invalid Codex native thread identity/);
  }
});

test("defaults to read-only, supports full prompt replacement and maps off to native none", async (t) => {
  const f = await fixture(t);
  await f.start({ systemPrompt: "Replacement", reasoningLevel: "off" });
  const launch = (await f.log()).find((call) => call.method === "thread/start")!.params;
  assert.equal(launch.baseInstructions, "Replacement");
  assert.equal(launch.developerInstructions, undefined);
  assert.equal(launch.sandbox, "read-only");
  assert.deepEqual(launch.config, { model_reasoning_effort: "none" });
});

for (const scenario of ["mismatch-model", "mismatch-reasoning", "mismatch-policy"]) {
  test(`rejects ${scenario} before registration and stops the worker`, async (t) => {
    const f = await fixture(t, scenario);
    await assert.rejects(f.start({ model: { provider: "openai", id: "selected-model" }, reasoningLevel: "high" }), /did not apply/);
    const [{ pid }] = await f.log();
    assert.throws(() => process.kill(pid as number, 0), { code: "ESRCH" });
  });
}

test("unsupported launch options fail without starting a process", async () => {
  const runtime = new CodexAgentRuntime({ command: "/not-a-real-executable" });
  await assert.rejects(runtime.start({ systemPrompt: "a", appendSystemPrompt: "b" }), /Invalid Codex launch selection/);
  await assert.rejects(runtime.start({ skillIds: ["invalid"] }), /Invalid Codex launch selection/);
  await assert.rejects(runtime.start({ reasoningLevel: "invalid" as "max" }), /Invalid Codex launch selection/);
  assert.throws(() => new CodexAgentRuntime({ turnRetentionLimit: 0 }), /positive integer/);
  assert.throws(() => new CodexAgentRuntime({ sandbox: "danger-full-access" as "read-only" }), /sandboxing/);
});

test("turns are idempotent, reject conflicts and busy input, and return defensive copies", async (t) => {
  const f = await fixture(t);
  const { id } = await f.start();
  const first = await f.runtime.startTurn(id, "caller-turn", "same input");
  assert.equal(first.status, "running");
  assert.equal(await f.runtime.status(id), "working");
  assert.equal((await f.runtime.startTurn(id, "caller-turn", "same input")).id, first.id);
  await assert.rejects(f.runtime.startTurn(id, "caller-turn", "different input"), /conflicts/);
  await assert.rejects(f.runtime.startTurn(id, "other-turn", "different input"), CodexSessionBusyError);
  const complete = await settled(f.runtime, id, first.id);
  assert.equal(complete.status, "completed");
  assert.equal(complete.response?.content, "Answer 1: café 🐈");
  complete.response!.content = "mutated";
  assert.equal((await f.runtime.turn(id, first.id))?.response?.content, "Answer 1: café 🐈");
  assert.equal((await f.runtime.startTurn(id, "caller-turn", "same input")).status, "completed");
  assert.equal((await f.log()).filter((call) => call.method === "turn/start").length, 1);
});

for (const scenario of ["early-completion", "terminal-response"]) {
  test(`handles ${scenario} without losing final responses or accepting stale events`, async (t) => {
    const f = await fixture(t, scenario);
    const { id } = await f.start();
    await f.runtime.startTurn(id, "first", "hello");
    const turn = await settled(f.runtime, id, "first");
    assert.equal(turn.status, "completed");
    assert.equal(turn.response?.content, scenario === "terminal-response" ? "Immediate answer" : "Answer 1: café 🐈");
    assert.equal(await f.runtime.status(id), "idle");
    await f.runtime.send(id, "second input");
  });
}

for (const [scenario, message] of [["failed", /native turn failed/], ["commentary-only", /no final assistant/], ["turn-error", /native turn request failed/]] as const) {
  test(`records ${scenario} as a failed turn rather than a successful answer`, async (t) => {
    const f = await fixture(t, scenario);
    const { id } = await f.start();
    await f.runtime.startTurn(id, "failed", "hello");
    const turn = await settled(f.runtime, id, "failed");
    assert.equal(turn.status, "failed");
    assert.match(turn.error!, message);
    assert.equal(turn.response, undefined);
    assert.equal(await f.runtime.status(id), "idle");
  });
}

for (const scenario of ["held", "slow-start"]) {
  test(`steering and interruption target the exact native turn (${scenario})`, async (t) => {
    const f = await fixture(t, scenario);
    const { id } = await f.start();
    await f.runtime.startTurn(id, "interrupt-me", "hello");
    await f.runtime.steer(id, "Focus on errors");
    await f.runtime.interrupt(id);
    assert.equal((await settled(f.runtime, id, "interrupt-me")).status, "interrupted");
    const log = await f.log();
    assert.equal(log.find((call) => call.method === "turn/steer")!.params.expectedTurnId, "native-turn-1");
    assert.equal(log.find((call) => call.method === "turn/interrupt")!.params.turnId, "native-turn-1");
    await assert.rejects(f.runtime.steer(id, "too late"), CodexSessionBusyError);
  });
}

for (const scenario of ["steer-history", "steer-history-response"]) {
  test(`history deduplicates the original prompt but preserves steering (${scenario})`, async t => {
    const f = await fixture(t, scenario);
    const { id } = await f.start();
    await f.runtime.startTurn(id, "steered", "Original prompt");
    await f.runtime.steer(id, "Original prompt");
    await f.runtime.steer(id, "Focus on errors");
    assert.equal((await settled(f.runtime, id, "steered")).status, "completed");
    assert.deepEqual((await f.runtime.messages(id)).filter(message => message.role === "user"), [
      { role: "user", content: "Original prompt" },
      { role: "user", content: "Original prompt" },
      { role: "user", content: "Focus on errors" },
    ]);
  });
}

test("interrupt acknowledgment alone does not settle a native turn", async (t) => {
  const f = await fixture(t, "interrupt-ack-only");
  const { id } = await f.start();
  await f.runtime.startTurn(id, "pending", "hello");
  await f.runtime.interrupt(id);
  assert.equal((await f.runtime.turn(id, "pending"))?.status, "running");
  assert.equal(await f.runtime.status(id), "working");
  await f.runtime.stop(id);
  assert.equal((await f.runtime.turn(id, "pending"))?.status, "interrupted");
});

for (const scenario of ["interactive", "exit", "invalid-turn"]) {
  test(`${scenario} fails the turn, takes the session offline and forbids further dispatch`, async (t) => {
    const f = await fixture(t, scenario);
    const { id } = await f.start();
    await f.runtime.startTurn(id, "failed", "hello");
    assert.equal((await settled(f.runtime, id, "failed")).status, "failed");
    assert.equal(await f.runtime.status(id), "offline");
    await assert.rejects(f.runtime.send(id, "must not run"), CodexSessionOfflineError);
    assert.equal((await f.log()).some((call) => call.id === "server-request" && call.result), false);
  });
}

test("stopping while native admission is pending interrupts the local turn and closes event readers", async (t) => {
  const f = await fixture(t, "slow-start");
  const { id } = await f.start();
  const stream = f.runtime.events(id);
  await f.runtime.startTurn(id, "pending-start", "hello");
  await f.runtime.stop(id);
  assert.equal((await f.runtime.turn(id, "pending-start"))?.status, "interrupted");
  const events = [];
  for await (const event of stream) events.push(event);
  assert.ok(events.some((event) => event.type === "turn_completed"));
  assert.ok(events.some((event) => event.type === "status" && event.status === "offline"));
});

test("an uncertain turn-start deadline fails the turn and stops further admission", async (t) => {
  const f = await fixture(t, "hang-turn");
  const { id } = await f.start();
  await f.runtime.startTurn(id, "timeout", "hello");
  const turn = await settled(f.runtime, id, "timeout");
  assert.equal(turn.status, "failed");
  assert.match(turn.error!, /timed out/);
  assert.equal(await f.runtime.status(id), "offline");
  await assert.rejects(f.runtime.send(id, "must not run"), CodexSessionOfflineError);
});

test("send waits for native completion and rejects interruption rather than reporting success", async (t) => {
  const f = await fixture(t, "held");
  const { id } = await f.start();
  const sending = f.runtime.send(id, "hello");
  const rejection = assert.rejects(sending, /interrupted/);
  await f.runtime.interrupt(id);
  await rejection;
});

test("advertises only verified capabilities and rejects incompatible images without dispatch", async (t) => {
  const f = await fixture(t, "text-only");
  const { id } = await f.start();
  assert.deepEqual(await f.runtime.inputCapabilities(id), { version: 1, images: false });
  assert.deepEqual(await f.runtime.sessionCapabilities(id), {
    version: 1, safeActivityEvents: true, interrupt: true, reconnectExisting: false,
    interactiveAttach: false, openDiagnostic: false, liveSkillVerification: false,
  });
  await assert.rejects(f.runtime.send(id, "picture", [{ type: "image", mimeType: "image/png", data: "YQ==" }]), /does not support images/);
  await assert.rejects(f.runtime.send(id, ""), /required/);
  await assert.rejects(f.runtime.send(id, "x".repeat(1024 * 1024 + 1)), /exceeds 1 MiB/);
  assert.equal((await f.log()).filter((call) => call.method === "turn/start").length, 0);
});

test("raw events correlate turns; activity contains only coalesced phases and timestamps", async (t) => {
  const f = await fixture(t);
  const { id } = await f.start();
  const raw = f.runtime.events(id);
  const controller = new AbortController();
  const activity: RuntimeActivityEvent[] = [];
  const observing = (async () => {
    for await (const event of f.runtime.activityEvents(id, { signal: controller.signal })) {
      activity.push(event);
      if (event.phase === "responding") controller.abort();
    }
  })();
  await f.runtime.send(id, "hello");
  await observing;
  const events = [];
  for await (const event of raw) {
    events.push(event);
    if (event.type === "turn_completed") break;
  }
  assert.ok(events.some((event) => event.type === "tool_started" && event.toolName === "shell"));
  assert.equal(events.some((event) => event.type === "message_delta" && event.delta === "wrong thread"), false);
  assert.deepEqual(activity.map((event) => event.phase), ["working", "using_tools", "responding"]);
  assert.ok(activity.every((event) => Object.keys(event).sort().join(",") === "observedAt,phase"));
  const cancelled = new AbortController();
  const iterator = f.runtime.activityEvents(id, { signal: cancelled.signal })[Symbol.asyncIterator]();
  const pending = iterator.next();
  cancelled.abort();
  assert.equal((await pending).done, true);
});

for (const scenario of ["flood", "byte-flood"]) {
test(`slow event consumers are bounded by frames/bytes without stopping native work: ${scenario}`, async (t) => {
  const f = await fixture(t, scenario);
  const { id } = await f.start();
  const stream = f.runtime.events(id);
  await f.runtime.send(id, "hello");
  await assert.rejects(stream.next(), /fell behind/);
  assert.equal(await f.runtime.status(id), "idle");
});

}

test("retention bounds terminal records, and stop confirms exit without deleting history", async (t) => {
  const f = await fixture(t, "normal", { turnRetentionLimit: 2 });
  const { id } = await f.start();
  for (const turn of ["one", "two", "three"]) {
    await f.runtime.startTurn(id, turn, turn);
    await settled(f.runtime, id, turn);
  }
  assert.equal(await f.runtime.turn(id, "one"), undefined);
  assert.equal((await f.runtime.turn(id, "two"))?.status, "completed");
  await f.runtime.stop(id);
  await f.runtime.stop(id);
  assert.equal(await f.runtime.status(id), "offline");
  await assert.rejects(f.runtime.sessionCapabilities(id), /offline/);
  const log = await f.log();
  assert.throws(() => process.kill(log[0].pid, 0), { code: "ESRCH" });
  assert.equal(log.some((call) => call.method === "thread/delete"), false);
});

test("message projection omits reasoning, paths, pixels and interim-only final responses", () => {
  assert.equal(normalizeCodexItem({ type: "reasoning", content: ["private reasoning"] }), undefined);
  assert.deepEqual(normalizeCodexItem({ type: "userMessage", content: [{ type: "text", text: "hello" }, { type: "localImage", path: "/secret/image.png" }] }), { role: "user", content: "hello" });
  assert.equal(finalResponse([{ type: "agentMessage", phase: "commentary", text: "Not final" }]), undefined);
  assert.deepEqual(finalResponse([{ type: "agentMessage", phase: null, text: "Legacy answer" }]), { role: "assistant", content: "Legacy answer" });
});
