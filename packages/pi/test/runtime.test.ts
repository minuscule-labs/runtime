import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { AgentEvent, AgentStatus, RuntimeMessage } from "@minu/runtime-core";
import { PiAgentRuntime } from "../src/client.js";
import { listRegistrations, writeRegistration } from "../src/registry.js";
import { createPiBridgeServer } from "../src/server.js";

async function fixture(initialStatus: AgentStatus = "idle") {
  const directory = await mkdtemp(join(tmpdir(), "minu-runtime-test-"));
  process.env.MINU_RUNTIME_DIR = directory;
  const sessionId = `session-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const token = "test-token";
  let status = initialStatus;
  const received: string[] = [];
  const transcript = [{ role: "assistant" as const, content: "Finished the review" }];
  const steered: string[] = [];
  let interruptions = 0;
  const bridge = await createPiBridgeServer({
    sessionId,
    token,
    getStatus: () => status,
    async send(input) {
      received.push(input);
      status = "working";
      await new Promise((resolve) => setTimeout(resolve, 20));
      transcript.push({ role: "assistant", content: `Response to ${input}` });
      status = "idle";
    },
    async steer(input) {
      steered.push(input);
    },
    async interrupt() {
      interruptions += 1;
      status = "idle";
    },
    async getMessages() {
      return [...transcript];
    },
  });
  await writeRegistration({
    sessionId,
    endpoint: bridge.endpoint,
    token,
    pid: process.pid,
    cwd: process.cwd(),
    ownership: "attached",
    updatedAt: new Date().toISOString(),
  });
  return {
    sessionId,
    received,
    steered,
    get interruptions() {
      return interruptions;
    },
    setStatus(next: AgentStatus) {
      status = next;
    },
    publish(event: AgentEvent) {
      bridge.publish(event);
    },
    async close() {
      await bridge.close();
      await rm(directory, { recursive: true, force: true });
      delete process.env.MINU_RUNTIME_DIR;
    },
  };
}

test("send wakes an idle bridge and resolves after it returns idle", async () => {
  const server = await fixture();
  try {
    const runtime = new PiAgentRuntime();
    assert.equal(await runtime.status(server.sessionId), "idle");
    await runtime.send(server.sessionId, "Review README.md");
    assert.deepEqual(server.received, ["Review README.md"]);
    assert.equal(await runtime.status(server.sessionId), "idle");
  } finally {
    await server.close();
  }
});

test("stable turn ids recover running and completed work without rerunning it", async () => {
  const server = await fixture();
  try {
    const runtime = new PiAgentRuntime();
    const accepted = await runtime.startTurn(server.sessionId, "channel:agent:trigger-1", "Implement once");
    assert.equal(accepted.status, "running");
    const duplicate = await runtime.startTurn(server.sessionId, "channel:agent:trigger-1", "Implement once");
    assert.equal(duplicate.id, accepted.id);
    assert.deepEqual(server.received, ["Implement once"]);

    let recovered = await runtime.turn(server.sessionId, accepted.id);
    for (let attempt = 0; recovered?.status === "running" && attempt < 20; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      recovered = await runtime.turn(server.sessionId, accepted.id);
    }
    assert.equal(recovered?.status, "completed");
    assert.equal(recovered?.response?.content, "Response to Implement once");
    assert.deepEqual(server.received, ["Implement once"]);
    await assert.rejects(
      runtime.startTurn(server.sessionId, accepted.id, "Different input"),
      /different input/,
    );
    assert.equal(await runtime.turn(server.sessionId, "missing"), undefined);
  } finally {
    await server.close();
  }
});

test("events exposes the current session status", async () => {
  const server = await fixture();
  try {
    const runtime = new PiAgentRuntime();
    for await (const event of runtime.events(server.sessionId)) {
      assert.equal(event.type, "status");
      if (event.type === "status") assert.equal(event.status, "idle");
      break;
    }
  } finally {
    await server.close();
  }
});

test("safe activity events coalesce raw details and honor caller cancellation", async () => {
  const server = await fixture("working");
  try {
    const runtime = new PiAgentRuntime();
    const controller = new AbortController();
    const iterator = runtime.activityEvents(server.sessionId, { signal: controller.signal })[Symbol.asyncIterator]();
    const initial = await iterator.next();
    assert.equal(initial.done, false);
    assert.equal(initial.value?.phase, "working");
    assert.equal(Number.isFinite(Date.parse(initial.value?.observedAt ?? "")), true);
    assert.doesNotMatch(JSON.stringify(initial), /session/);

    const timestamp = new Date().toISOString();
    const responding = iterator.next();
    server.publish({
      type: "message_delta",
      sessionId: server.sessionId,
      delta: "private answer text",
      timestamp,
    });
    assert.deepEqual(await responding, { done: false, value: { phase: "responding", observedAt: timestamp } });

    const usingTools = iterator.next();
    server.publish({
      type: "message_delta",
      sessionId: server.sessionId,
      delta: "another private token",
      timestamp,
    });
    server.publish({
      type: "tool_started",
      sessionId: server.sessionId,
      toolCallId: "private-call",
      toolName: "private-tool-name",
      timestamp,
    });
    const safeToolEvent = await usingTools;
    assert.deepEqual(safeToolEvent, { done: false, value: { phase: "using_tools", observedAt: timestamp } });
    assert.doesNotMatch(JSON.stringify(safeToolEvent), /session|operation|answer|token|call|tool-name/);

    const backToWorking = iterator.next();
    server.publish({
      type: "tool_started",
      sessionId: server.sessionId,
      toolCallId: "private-parallel-call",
      toolName: "another-private-tool",
      timestamp,
    });
    server.publish({
      type: "tool_completed",
      sessionId: server.sessionId,
      toolCallId: "private-call",
      toolName: "private-tool-name",
      isError: true,
      timestamp,
    });
    server.publish({
      type: "tool_completed",
      sessionId: server.sessionId,
      toolCallId: "private-parallel-call",
      toolName: "another-private-tool",
      isError: false,
      timestamp,
    });
    assert.deepEqual(await backToWorking, { done: false, value: { phase: "working", observedAt: timestamp } });

    const afterIgnoredEvents = iterator.next();
    server.publish({
      type: "error",
      sessionId: server.sessionId,
      operationId: "private-operation",
      message: "private raw error",
      timestamp,
    });
    server.publish({
      type: "message_delta",
      sessionId: server.sessionId,
      delta: "private malformed event",
      timestamp: "not-a-date",
    });
    const laterTimestamp = new Date(Date.parse(timestamp) + 1_000).toISOString();
    server.publish({
      type: "message_delta",
      sessionId: server.sessionId,
      delta: "private final answer",
      timestamp: laterTimestamp,
    });
    const safeResponseEvent = await afterIgnoredEvents;
    assert.deepEqual(safeResponseEvent, { done: false, value: { phase: "responding", observedAt: laterTimestamp } });
    assert.doesNotMatch(JSON.stringify(safeResponseEvent), /session|operation|error|malformed|answer/);

    const canceled = iterator.next();
    controller.abort();
    assert.deepEqual(await canceled, { done: true, value: undefined });
  } finally {
    await server.close();
  }
});

test("messages returns the normalized transcript", async () => {
  const server = await fixture();
  try {
    assert.deepEqual(await new PiAgentRuntime().messages(server.sessionId), [
      { role: "assistant", content: "Finished the review" },
    ]);
  } finally {
    await server.close();
  }
});

test("attached sessions cannot be stopped by Runtime", async () => {
  const server = await fixture();
  try {
    await assert.rejects(new PiAgentRuntime().stop(server.sessionId), /cannot be stopped/);
  } finally {
    await server.close();
  }
});

test("send rejects a working session", async () => {
  const server = await fixture("working");
  try {
    const runtime = new PiAgentRuntime();
    await assert.rejects(runtime.send(server.sessionId, "hello"), /working/);
    assert.deepEqual(server.received, []);
  } finally {
    await server.close();
  }
});

test("steer delivers an explicit control message only to a working session", async () => {
  const server = await fixture("working");
  try {
    const runtime = new PiAgentRuntime();
    await runtime.steer(server.sessionId, "Focus on persistence");
    assert.deepEqual(server.steered, ["Focus on persistence"]);
    server.setStatus("idle");
    await assert.rejects(runtime.steer(server.sessionId, "too late"), /must be working/);
  } finally {
    await server.close();
  }
});

test("interrupt aborts a working session", async () => {
  const server = await fixture("working");
  try {
    const runtime = new PiAgentRuntime();
    await runtime.interrupt(server.sessionId);
    assert.equal(server.interruptions, 1);
    assert.equal(await runtime.status(server.sessionId), "idle");
  } finally {
    await server.close();
  }
});

test("status reports offline for an unknown session", async () => {
  const directory = await mkdtemp(join(tmpdir(), "minu-runtime-test-"));
  process.env.MINU_RUNTIME_DIR = directory;
  try {
    assert.equal(await new PiAgentRuntime().status("missing-session"), "offline");
  } finally {
    await rm(directory, { recursive: true, force: true });
    delete process.env.MINU_RUNTIME_DIR;
  }
});

test("start rejects competing system prompt modes", async () => {
  await assert.rejects(
    new PiAgentRuntime().start({ systemPrompt: "replace", appendSystemPrompt: "append" }),
    /cannot both be set/,
  );
});

test("turn response recovery survives transcript replacement and retention is bounded", async () => {
  let transcript: RuntimeMessage[] = Array.from({ length: 3 }, (_, index) => ({
    role: "user" as const,
    content: `old-${index}`,
  }));
  const bridge = await createPiBridgeServer({
    sessionId: "compacted-session",
    token: "compacted-token",
    getStatus: () => "idle",
    async getMessages() { return transcript; },
    async send(input) { transcript = [{ role: "assistant", content: `new-${input}` }]; },
    turnRetentionLimit: 2,
  });
  try {
    const headers = { authorization: "Bearer compacted-token", "content-type": "application/json" };
    for (const turnId of ["first", "second", "third"]) {
      await fetch(`${bridge.endpoint}/turns`, {
        method: "POST", headers, body: JSON.stringify({ turnId, input: turnId }),
      });
      for (let attempt = 0; attempt < 20; attempt += 1) {
        const body = await (await fetch(`${bridge.endpoint}/turns/${turnId}`, { headers })).json() as { turn: { status: string; response?: { content: string } } | null };
        if (body.turn?.status !== "running") {
          assert.equal(body.turn?.status, "completed");
          assert.equal(body.turn?.response?.content, `new-${turnId}`);
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    }
    assert.deepEqual(await (await fetch(`${bridge.endpoint}/turns/first`, { headers })).json(), { turn: null });
  } finally { await bridge.close(); }
});

test("short Runtime requests time out instead of stalling forever", async () => {
  const directory = await mkdtemp(join(tmpdir(), "minu-runtime-timeout-"));
  process.env.MINU_RUNTIME_DIR = directory;
  const stalled = createServer(() => {});
  await new Promise<void>((resolve) => stalled.listen(0, "127.0.0.1", resolve));
  const address = stalled.address() as AddressInfo;
  try {
    await writeRegistration({
      sessionId: "stalled", endpoint: `http://127.0.0.1:${address.port}`,
      token: "token", pid: process.pid, cwd: directory, updatedAt: new Date().toISOString(),
    });
    await assert.rejects(new PiAgentRuntime({ requestTimeoutMs: 30 }).messages("stalled"), /timed out/);
  } finally {
    await new Promise<void>((resolve, reject) => stalled.close((error) => error ? reject(error) : resolve()));
    await rm(directory, { recursive: true, force: true });
    delete process.env.MINU_RUNTIME_DIR;
  }
});

test("registry listing ignores launch markers and isolates corrupt registrations", async () => {
  const directory = await mkdtemp(join(tmpdir(), "minu-runtime-registry-"));
  process.env.MINU_RUNTIME_DIR = directory;
  try {
    await writeFile(join(directory, ".launch-test.json"), "{}\n");
    await writeFile(join(directory, "corrupt.json"), "not json\n");
    await writeRegistration({
      sessionId: "healthy", endpoint: "http://127.0.0.1:1", token: "token",
      pid: process.pid, cwd: directory, updatedAt: new Date().toISOString(),
    });
    assert.deepEqual((await listRegistrations()).map(({ sessionId }) => sessionId), ["healthy"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
    delete process.env.MINU_RUNTIME_DIR;
  }
});

test("failed Runtime startup terminates its worker", async () => {
  const directory = await mkdtemp(join(tmpdir(), "minu-runtime-startup-"));
  const worker = join(directory, "worker.mjs");
  const pidFile = join(directory, "pid");
  await writeFile(worker, `import { writeFileSync } from "node:fs";\nwriteFileSync(process.env.WORKER_PID_FILE, String(process.pid));\nsetInterval(() => {}, 1000);\n`);
  process.env.MINU_RUNTIME_DIR = join(directory, "registry");
  process.env.WORKER_PID_FILE = pidFile;
  try {
    await assert.rejects(
      new PiAgentRuntime({ workerPath: worker, startTimeoutMs: 50 }).start({ cwd: directory }),
      /Timed out starting Pi runtime/,
    );
    const pid = Number(await readFile(pidFile, "utf8"));
    assert.throws(() => process.kill(pid, 0), (error: NodeJS.ErrnoException) => error.code === "ESRCH");
  } finally {
    await rm(directory, { recursive: true, force: true });
    delete process.env.MINU_RUNTIME_DIR;
    delete process.env.WORKER_PID_FILE;
  }
});

test("Runtime startup reports a worker that exits before readiness", async () => {
  const directory = await mkdtemp(join(tmpdir(), "minu-runtime-early-exit-"));
  const worker = join(directory, "worker.mjs");
  await writeFile(worker, "process.exit(7);\n");
  process.env.MINU_RUNTIME_DIR = join(directory, "registry");
  try {
    const started = Date.now();
    await assert.rejects(
      new PiAgentRuntime({ workerPath: worker, startTimeoutMs: 5_000 }).start({ cwd: directory }),
      /exited before readiness \(7\)/,
    );
    assert.ok(Date.now() - started < 1_000);
  } finally {
    await rm(directory, { recursive: true, force: true });
    delete process.env.MINU_RUNTIME_DIR;
  }
});

test("runtime can own a prompted Pi RPC process through start, send, messages, and stop", async () => {
  const directory = await mkdtemp(join(tmpdir(), "minu-runtime-owned-test-"));
  const fakePi = join(directory, "fake-pi.mjs");
  const argsFile = join(directory, "pi-args.json");
  await writeFile(
    fakePi,
    `#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
const args = process.argv.slice(2);
const promptFlag = args.indexOf("--append-system-prompt");
const prompt = promptFlag >= 0 ? readFileSync(args[promptFlag + 1], "utf8") : undefined;
const requests = [];
const save = () => writeFileSync(process.env.PI_ARGS_FILE, JSON.stringify({ args, prompt, requests }));
save();
let buffer = "";
const messages = [];
process.stdin.on("data", (chunk) => {
  buffer += chunk.toString();
  while (buffer.includes("\\n")) {
    const index = buffer.indexOf("\\n");
    const line = buffer.slice(0, index);
    buffer = buffer.slice(index + 1);
    if (!line) continue;
    const request = JSON.parse(line);
    requests.push(request);
    save();
    const respond = (data) => console.log(JSON.stringify({ id: request.id, type: "response", command: request.type, success: true, data }));
    if (request.type === "get_available_models") respond({ models: [{ provider: "openai", id: "gpt-test", reasoning: true }] });
    else if (request.type === "get_commands") respond({ commands: [{ name: "skill:reviewer", description: "Review changes", source: "skill", sourceInfo: { path: "/skills/reviewer/SKILL.md", source: "auto", scope: "user" } }] });
    else if (request.type === "get_available_thinking_levels") respond({ levels: ["off", "medium", "high"] });
    else if (request.type === "set_model" || request.type === "set_thinking_level") respond(undefined);
    else if (request.type === "get_state") respond({ sessionId: "fake-owned-session", isStreaming: false });
    else if (request.type === "get_messages") respond({ messages });
    else if (request.type === "prompt") {
      messages.push({ role: "user", content: request.message, timestamp: Date.now() });
      messages.push({ role: "assistant", content: [{ type: "text", text: "READY" }], timestamp: Date.now() });
      respond(undefined);
      console.log(JSON.stringify({ type: "agent_start" }));
      console.log(JSON.stringify({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "READY" } }));
      console.log(JSON.stringify({ type: "agent_settled" }));
    }
  }
});
process.on("SIGTERM", () => process.exit(0));
`,
  );
  await chmod(fakePi, 0o755);
  process.env.MINU_RUNTIME_DIR = join(directory, "registry");
  process.env.PI_COMMAND = fakePi;
  process.env.PI_ARGS_FILE = argsFile;
  const runtime = new PiAgentRuntime();
  let sessionId: string | undefined;
  try {
    assert.deepEqual(await runtime.capabilities({ cwd: directory }), {
      models: [{ provider: "openai", id: "gpt-test", name: "gpt-test", reasoning: true }],
      reasoningLevels: ["off", "minimal", "low", "medium", "high", "xhigh", "max"],
      skills: [{ id: "skill:reviewer", name: "reviewer", description: "Review changes" }],
    });
    await assert.rejects(
      runtime.start({ cwd: directory, skillIds: ["skill:missing"] }),
      /Pi skill is not available: skill:missing/,
    );
    const session = await runtime.start({
      cwd: directory,
      appendSystemPrompt: "You are the reviewer persona.",
      model: { provider: "openai", id: "gpt-test" },
      reasoningLevel: "high",
      skillIds: ["skill:reviewer"],
    });
    sessionId = session.id;
    assert.equal(session.ownership, "owned");
    const launch = JSON.parse(await readFile(argsFile, "utf8")) as {
      args: string[];
      prompt?: string;
      requests: Array<Record<string, unknown>>;
    };
    const promptIndex = launch.args.indexOf("--append-system-prompt");
    assert.match(launch.args[promptIndex + 1]!, /\.prompt$/);
    assert.equal(launch.prompt, "You are the reviewer persona.");
    assert.ok(launch.args.includes("--no-skills"));
    const skillIndex = launch.args.indexOf("--skill");
    assert.equal(launch.args[skillIndex + 1], "/skills/reviewer/SKILL.md");
    assert.deepEqual(
      launch.requests.slice(0, 5).map(({ type, provider, modelId, level }) => ({ type, provider, modelId, level })),
      [
        { type: "get_available_models", provider: undefined, modelId: undefined, level: undefined },
        { type: "set_model", provider: "openai", modelId: "gpt-test", level: undefined },
        { type: "get_available_thinking_levels", provider: undefined, modelId: undefined, level: undefined },
        { type: "set_thinking_level", provider: undefined, modelId: undefined, level: "high" },
        { type: "get_state", provider: undefined, modelId: undefined, level: undefined },
      ],
    );
    assert.equal(await runtime.status(session.id), "idle");
    await runtime.send(session.id, "hello");
    assert.deepEqual(
      (await runtime.messages(session.id)).map((message) => [message.role, message.content]),
      [["user", "hello"], ["assistant", "READY"]],
    );
    const accepted = await runtime.startTurn(session.id, "owned-turn-1", "recoverable");
    let recovered = accepted;
    for (let attempt = 0; recovered.status === "running" && attempt < 20; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      recovered = (await runtime.turn(session.id, accepted.id))!;
    }
    assert.equal(recovered.status, "completed");
    assert.equal(recovered.response?.content, "READY");
    assert.deepEqual(
      (await runtime.messages(session.id)).map((message) => [message.role, message.content]),
      [
        ["user", "hello"],
        ["assistant", "READY"],
        ["user", "recoverable"],
        ["assistant", "READY"],
      ],
    );
    await runtime.stop(session.id);
    sessionId = undefined;
    assert.equal(await runtime.status(session.id), "offline");
    await assert.rejects(
      runtime.start({ cwd: directory, model: { provider: "openai", id: "missing-model" } }),
      /Pi model is not available/,
    );
  } finally {
    if (sessionId) await runtime.stop(sessionId).catch(() => {});
    await rm(directory, { recursive: true, force: true });
    delete process.env.MINU_RUNTIME_DIR;
    delete process.env.PI_COMMAND;
    delete process.env.PI_ARGS_FILE;
  }
});
