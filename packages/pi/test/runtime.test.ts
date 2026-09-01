import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { AgentStatus } from "@minu/runtime-core";
import { PiAgentRuntime } from "../src/client.js";
import { writeRegistration } from "../src/registry.js";
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
    });
    const session = await runtime.start({
      cwd: directory,
      appendSystemPrompt: "You are the reviewer persona.",
      model: { provider: "openai", id: "gpt-test" },
      reasoningLevel: "high",
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
