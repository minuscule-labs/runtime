import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { appendFile, chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer, request as httpRequest } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { AgentEvent, AgentStatus, RuntimeMessage } from "@minu/runtime-core";
import { PiAgentRuntime } from "../src/client.js";
import { BoundedDiagnosticLog } from "../src/diagnostic.js";
import { listRegistrations, readRegistration, writeRegistration } from "../src/registry.js";
import { createPiBridgeServer } from "../src/server.js";

async function fixture(
  initialStatus: AgentStatus = "idle",
  interruptible = true,
  diagnostic = false,
) {
  const directory = await mkdtemp(join(tmpdir(), "minu-runtime-test-"));
  process.env.MINU_RUNTIME_DIR = directory;
  const sessionId = `session-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const token = "test-token";
  let status = initialStatus;
  const received: string[] = [];
  const transcript = [{ role: "assistant" as const, content: "Finished the review" }];
  const steered: string[] = [];
  let interruptions = 0;
  let diagnosticOpens = 0;
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
    ...(interruptible ? {
      async interrupt() {
        interruptions += 1;
        status = "idle" as const;
      },
    } : {}),
    ...(diagnostic ? {
      async openDiagnostic() {
        diagnosticOpens += 1;
      },
    } : {}),
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
    endpoint: bridge.endpoint,
    token,
    received,
    steered,
    get interruptions() {
      return interruptions;
    },
    get diagnosticOpens() {
      return diagnosticOpens;
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

test("managed stop atomically rejects work admitted while the request body is pending", async () => {
  const sessionId = `managed-stop-${Date.now()}`;
  const token = "managed-stop-token";
  let stopCalls = 0;
  const received: string[] = [];
  const bridge = await createPiBridgeServer({
    sessionId,
    token,
    getStatus: () => "idle",
    async send(input) { received.push(input); },
    stopRequiresIdle: true,
    stop() { stopCalls += 1; },
  });
  try {
    const startPendingRequest = (path: string, prefix: string, suffix: string) => {
      let complete!: () => void;
      const response = new Promise<{ statusCode: number; body: string }>((resolve, reject) => {
        const request = httpRequest(`${bridge.endpoint}${path}`, {
          method: "POST",
          headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        }, (incoming) => {
          let body = "";
          incoming.setEncoding("utf8");
          incoming.on("data", (chunk: string) => { body += chunk; });
          incoming.on("end", () => resolve({ statusCode: incoming.statusCode ?? 0, body }));
        });
        request.on("error", reject);
        request.write(prefix);
        complete = () => request.end(suffix);
      });
      return { complete: () => complete(), response };
    };
    const sendRace = startPendingRequest("/send", '{"input":', '"late request"}');
    const turnRace = startPendingRequest("/turns", '{"turnId":"late-turn","input":', '"late turn"}');
    await new Promise((resolve) => setTimeout(resolve, 20));

    const stopResponse = await fetch(`${bridge.endpoint}/stop`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(stopResponse.status, 202);
    sendRace.complete();
    turnRace.complete();
    assert.equal((await sendRace.response).statusCode, 409);
    assert.equal((await turnRace.response).statusCode, 409);
    assert.equal(stopCalls, 1);
    assert.deepEqual(received, []);
  } finally {
    await bridge.close();
  }
});

test("managed stop refuses a session that is already working", async () => {
  let stopCalls = 0;
  const bridge = await createPiBridgeServer({
    sessionId: "managed-busy-stop",
    token: "managed-busy-stop-token",
    getStatus: () => "working",
    async send() {},
    stopRequiresIdle: true,
    stop() { stopCalls += 1; },
  });
  try {
    const response = await fetch(`${bridge.endpoint}/stop`, {
      method: "POST",
      headers: { authorization: "Bearer managed-busy-stop-token" },
    });
    assert.equal(response.status, 409);
    assert.equal(stopCalls, 0);
  } finally {
    await bridge.close();
  }
});

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

test("live session capabilities are versioned, allowlisted, and session-verified", async () => {
  const capable = await fixture();
  try {
    assert.deepEqual(await new PiAgentRuntime().sessionCapabilities(capable.sessionId), {
      version: 1,
      safeActivityEvents: true,
      interrupt: true,
      reconnectExisting: true,
      interactiveAttach: false,
      openDiagnostic: false,
      liveSkillVerification: false,
    });
  } finally {
    await capable.close();
  }

  const limited = await fixture("idle", false);
  try {
    assert.equal(
      (await new PiAgentRuntime().sessionCapabilities(limited.sessionId)).interrupt,
      false,
    );
  } finally {
    await limited.close();
  }
});

test("opens only an authenticated adapter-owned local diagnostic", async () => {
  const server = await fixture("idle", true, true);
  try {
    const runtime = new PiAgentRuntime();
    assert.equal((await runtime.sessionCapabilities(server.sessionId)).openDiagnostic, true);
    await runtime.openDiagnostic(server.sessionId);
    assert.equal(server.diagnosticOpens, 1);

    const unauthorized = await fetch(`${server.endpoint}/diagnostic/open`, { method: "POST" });
    assert.equal(unauthorized.status, 401);
    assert.deepEqual(await unauthorized.json(), { error: "Unauthorized" });
    const authorized = await fetch(`${server.endpoint}/diagnostic/open`, {
      method: "POST",
      headers: { authorization: `Bearer ${server.token}` },
    });
    assert.equal(authorized.status, 202);
    const authorizedBody = await authorized.text();
    assert.deepEqual(JSON.parse(authorizedBody), { status: "opened" });
    assert.equal(server.diagnosticOpens, 2);
    assert.doesNotMatch(authorizedBody, /[/\\]|session/i);
  } finally {
    await server.close();
  }
});

test("keeps local diagnostic logs private and bounded", async () => {
  const directory = await mkdtemp(join(tmpdir(), "minu-runtime-diagnostic-"));
  const file = join(directory, "runtime.log");
  try {
    const log = new BoundedDiagnosticLog(file, 8);
    await Promise.all([log.append("1234"), log.append("5678"), log.append("90")]);
    assert.equal(await readFile(file, "utf8"), "7890");
    const metadata = await stat(file);
    assert.equal(metadata.size, 4);
    assert.equal(metadata.mode & 0o777, 0o600);
  } finally {
    await rm(directory, { recursive: true, force: true });
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

test("managed Pi sessions preserve owner-scoped identity and transcript across suspend, resume, and worker restart", async () => {
  const directory = await mkdtemp(join(tmpdir(), "minu-runtime-managed-test-"));
  const fakePi = join(directory, "fake-pi.mjs");
  const runtimeDirectory = join(directory, "runtime");
  const runCountFile = join(directory, "pi-runs");
  await writeFile(fakePi, `#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
const args = process.argv.slice(2);
const sessionArg = args.indexOf("--session");
const sessionFile = sessionArg >= 0 ? args[sessionArg + 1] : process.env.PI_SESSION_FILE;
const runFile = process.env.PI_RUN_COUNT_FILE;
let previousRuns = 0;
try { previousRuns = Number(readFileSync(runFile, "utf8") || "0"); } catch {}
const runCount = previousRuns + 1;
writeFileSync(runFile, String(runCount));
let header;
let messages = [];
if (sessionArg >= 0) {
  const lines = readFileSync(sessionFile, "utf8").trim().split("\\n");
  header = JSON.parse(lines[0]);
  messages = lines.slice(1).map((line) => JSON.parse(line)).filter((entry) => entry.type === "message").map((entry) => entry.message);
} else {
  header = { type: "session", version: 3, id: "transcript-stable-id", timestamp: new Date().toISOString(), cwd: process.cwd() };
}
function saveTranscript() {
  const entries = messages.map((message, index) => ({
    type: "message",
    id: String(index + 1).padStart(8, "0"),
    parentId: index === 0 ? null : String(index).padStart(8, "0"),
    timestamp: new Date(message.timestamp).toISOString(),
    message,
  }));
  writeFileSync(sessionFile, [JSON.stringify(header), ...entries.map((entry) => JSON.stringify(entry))].join("\\n") + "\\n");
}
if (sessionArg < 0) saveTranscript();
let buffer = "";
process.stdin.on("data", (chunk) => {
  buffer += chunk.toString();
  while (buffer.includes("\\n")) {
    const index = buffer.indexOf("\\n");
    const line = buffer.slice(0, index);
    buffer = buffer.slice(index + 1);
    if (!line) continue;
    const request = JSON.parse(line);
    const respond = (data) => console.log(JSON.stringify({ id: request.id, type: "response", command: request.type, success: true, data }));
    if (request.type === "get_state") respond({ model: { provider: "openai", id: "gpt-test" }, thinkingLevel: "medium", sessionId: "native-pi-" + runCount, sessionFile, isStreaming: false });
    else if (request.type === "get_messages") respond({ messages });
    else if (request.type === "prompt") {
      const finishPrompt = () => {
        messages.push({ role: "user", content: request.message, timestamp: Date.now() });
        messages.push({ role: "assistant", content: [{ type: "text", text: "RESUMED_OK" }], timestamp: Date.now() });
        saveTranscript();
        respond(undefined);
        console.log(JSON.stringify({ type: "agent_start" }));
        console.log(JSON.stringify({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "RESUMED_OK" } }));
        console.log(JSON.stringify({ type: "agent_settled" }));
      };
      if (request.message === "RACE_DELAY") setTimeout(finishPrompt, 150);
      else finishPrompt();
    }
  }
});
process.stdin.on("end", () => process.exit(0));
process.on("SIGTERM", () => process.exit(0));
`);
  await chmod(fakePi, 0o755);
  process.env.MINU_RUNTIME_DIR = runtimeDirectory;
  process.env.PI_COMMAND = fakePi;
  process.env.PI_RUN_COUNT_FILE = runCountFile;
  const ownerId = "workspace-owner-1";
  const runtime = new PiAgentRuntime();
  try {
    const started = await runtime.startManaged({ cwd: directory, appendSystemPrompt: "Private managed persona" }, ownerId);
    assert.equal(started.ownership, "owned");
    assert.equal(started.ownerId, ownerId);
    assert.notEqual(started.id, "native-pi-1");
    const managedSessionId = started.id;
    const ownerKey = createHash("sha256").update(ownerId).digest("hex");
    const ownerDirectory = join(runtimeDirectory, "managed", ownerKey);
    const manifestPath = join(ownerDirectory, `${managedSessionId}.json`);
    const lockDatabasePath = join(ownerDirectory, `.lifecycle-${managedSessionId}.sqlite`);
    const initialManifest = JSON.parse(await readFile(manifestPath, "utf8")) as { sessionFile: string; transcriptId: string };
    const transcriptFile = initialManifest.sessionFile;
    const transcriptHeader = JSON.parse((await readFile(transcriptFile, "utf8")).split("\n")[0]!) as { id: string };
    assert.equal(transcriptHeader.id, initialManifest.transcriptId);
    assert.equal((await stat(manifestPath)).mode & 0o777, 0o600);
    assert.equal((await stat(lockDatabasePath)).mode & 0o777, 0o600);
    assert.equal((await stat(transcriptFile)).mode & 0o777, 0o600);
    await runtime.send(managedSessionId, "Before suspend");
    assert.deepEqual((await runtime.messages(managedSessionId)).map(({ role, content }) => [role, content]), [
      ["user", "Before suspend"],
      ["assistant", "RESUMED_OK"],
    ]);

    assert.deepEqual(await runtime.listManagedSessions(ownerId).then((items) => items.map(({ id, state }) => [id, state])), [
      [managedSessionId, "active"],
    ]);
    assert.deepEqual(await runtime.listManagedSessions("other-owner"), []);
    await assert.rejects(runtime.resume(managedSessionId, "other-owner"), /not available for this owner/);
    await runtime.suspend(managedSessionId, ownerId);
    await runtime.suspend(managedSessionId, ownerId);
    assert.equal(await runtime.status(managedSessionId), "offline");
    assert.equal((await runtime.listManagedSessions(ownerId))[0]?.state, "suspended");
    const validManifest = await readFile(manifestPath, "utf8");
    const validTranscript = await readFile(transcriptFile, "utf8");
    const transcriptLines = validTranscript.split("\n");
    const redirectedTranscriptHeader = JSON.parse(transcriptLines[0]!) as { id: string };
    redirectedTranscriptHeader.id = "another-pi-session";
    transcriptLines[0] = JSON.stringify(redirectedTranscriptHeader);
    await writeFile(transcriptFile, transcriptLines.join("\n"));
    await assert.rejects(runtime.resume(managedSessionId, ownerId), /Managed Pi transcript/);
    assert.equal((await runtime.listManagedSessions(ownerId))[0]?.state, "unavailable");
    assert.equal(Number(await readFile(runCountFile, "utf8")), 1);
    await writeFile(transcriptFile, validTranscript);

    await writeFile(transcriptFile, `${validTranscript}{"type":"message",`);
    await assert.rejects(runtime.resume(managedSessionId, ownerId), /Managed Pi transcript/);
    assert.equal((await runtime.listManagedSessions(ownerId))[0]?.state, "unavailable");
    assert.equal(Number(await readFile(runCountFile, "utf8")), 1);
    await writeFile(transcriptFile, validTranscript);

    const redirectedManifest = JSON.parse(validManifest) as { sessionFile: string };
    redirectedManifest.sessionFile = join(directory, "redirected-session.jsonl");
    await writeFile(manifestPath, JSON.stringify(redirectedManifest), { mode: 0o600 });
    await assert.rejects(runtime.resume(managedSessionId, ownerId), /Invalid Runtime managed-session transcript path/);
    assert.equal((await runtime.listManagedSessions(ownerId))[0]?.state, "unavailable");
    assert.equal(Number(await readFile(runCountFile, "utf8")), 1);
    await writeFile(manifestPath, validManifest, { mode: 0o600 });

    const resumed = await runtime.resume(managedSessionId, ownerId);
    assert.equal(resumed.id, managedSessionId);
    const manifestAfterResume = JSON.parse(await readFile(manifestPath, "utf8")) as {
      nativeSessionId: string;
      sessionFile: string;
      transcriptId: string;
    };
    assert.equal(manifestAfterResume.nativeSessionId, "native-pi-2");
    assert.notEqual(manifestAfterResume.nativeSessionId, initialManifest.transcriptId);
    assert.equal(manifestAfterResume.transcriptId, initialManifest.transcriptId);
    assert.equal(manifestAfterResume.sessionFile, transcriptFile);
    assert.deepEqual((await runtime.messages(managedSessionId)).map(({ role, content }) => [role, content]), [
      ["user", "Before suspend"],
      ["assistant", "RESUMED_OK"],
    ]);
    const eventIterator = runtime.events(managedSessionId)[Symbol.asyncIterator]();
    assert.equal((await eventIterator.next()).value?.sessionId, managedSessionId);
    await eventIterator.return?.();
    const summaryJson = JSON.stringify(await runtime.listManagedSessions(ownerId));
    assert.doesNotMatch(summaryJson, /native-pi-2|\.jsonl/);

    await Promise.all([
      runtime.resume(managedSessionId, ownerId),
      runtime.resume(managedSessionId, ownerId),
    ]);
    assert.equal(Number(await readFile(runCountFile, "utf8")), 2);

    const originalStatus = runtime.status.bind(runtime);
    let injectAfterIdleCheck = false;
    let racedSend: Promise<void> | undefined;
    runtime.status = async (sessionId) => {
      const observed = await originalStatus(sessionId);
      if (injectAfterIdleCheck && observed === "idle") {
        injectAfterIdleCheck = false;
        racedSend = runtime.send(sessionId, "RACE_DELAY");
        const deadline = Date.now() + 2_000;
        while (await originalStatus(sessionId) !== "working" && Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        assert.equal(await originalStatus(sessionId), "working");
      }
      return observed;
    };
    injectAfterIdleCheck = true;
    await assert.rejects(runtime.suspend(managedSessionId, ownerId), /cannot be stopped for suspend or destroy/);
    assert.equal(await originalStatus(managedSessionId), "working");
    await racedSend;
    assert.equal((await runtime.listManagedSessions(ownerId))[0]?.state, "active");

    injectAfterIdleCheck = true;
    await assert.rejects(runtime.destroy(managedSessionId, ownerId), /cannot be stopped for suspend or destroy/);
    assert.equal(await originalStatus(managedSessionId), "working");
    await racedSend;
    assert.equal((await runtime.listManagedSessions(ownerId))[0]?.state, "active");

    // A Runtime controller restart can recover an active manifest whose worker crashed.
    const activeRegistration = await readRegistration(managedSessionId);
    assert.ok(activeRegistration);
    process.kill(activeRegistration.pid, "SIGKILL");
    const crashDeadline = Date.now() + 2_000;
    while (await runtime.status(managedSessionId) !== "offline" && Date.now() < crashDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(await runtime.status(managedSessionId), "offline");
    const restartedRuntime = new PiAgentRuntime();
    assert.equal((await restartedRuntime.listManagedSessions(ownerId))[0]?.state, "suspended");
    await restartedRuntime.resume(managedSessionId, ownerId);
    assert.equal(Number(await readFile(runCountFile, "utf8")), 3);
    await restartedRuntime.destroy(managedSessionId, ownerId);
    const destroyedSummaries = await restartedRuntime.listManagedSessions(ownerId);
    if (destroyedSummaries.length > 0) {
      const manifestText = await readFile(manifestPath, "utf8").catch(() => undefined);
      let manifestState: unknown;
      try {
        manifestState = manifestText === undefined ? "missing" : (JSON.parse(manifestText) as { state?: unknown }).state;
      } catch {
        manifestState = "unparseable";
      }
      console.error("Unexpected managed session after destroy", {
        summaries: destroyedSummaries,
        manifestState,
        registrationPresent: Boolean(await readRegistration(managedSessionId)),
      });
    }
    assert.deepEqual(destroyedSummaries, []);
    await writeFile(manifestPath, "{ malformed manifest\n", { mode: 0o600 });
    assert.equal((await restartedRuntime.listManagedSessions(ownerId))[0]?.state, "unavailable");
    await restartedRuntime.destroy(managedSessionId, ownerId);
    assert.deepEqual(await restartedRuntime.listManagedSessions(ownerId), []);
    assert.match(await readFile(transcriptFile, "utf8"), /Before suspend/);
    await assert.rejects(restartedRuntime.resume(managedSessionId, ownerId), /not available for this owner/);
  } finally {
    await rm(directory, { recursive: true, force: true });
    delete process.env.MINU_RUNTIME_DIR;
    delete process.env.PI_COMMAND;
    delete process.env.PI_RUN_COUNT_FILE;
  }
});

test("managed lifecycle lock recovers a crashed controller without overlapping contenders", async () => {
  const directory = await mkdtemp(join(tmpdir(), "minu-runtime-lock-test-"));
  const runtimeDirectory = join(directory, "runtime");
  const logFile = join(directory, "lock-events");
  const readyFile = join(directory, "first-controller-ready");
  process.env.MINU_RUNTIME_DIR = runtimeDirectory;
  const moduleUrl = new URL("../src/managed-sessions.js", import.meta.url).href;
  const script = `
import { appendFile, writeFile } from "node:fs/promises";
const { withManagedSessionLock } = await import(process.env.LOCK_MODULE);
await withManagedSessionLock("cross-process-lock-test", "owner-one", async () => {
  await appendFile(process.env.LOCK_LOG, "enter " + process.pid + "\\n");
  if (process.env.LOCK_READY) await writeFile(process.env.LOCK_READY, "ready");
  await new Promise((resolve) => setTimeout(resolve, Number(process.env.LOCK_HOLD_MS)));
  await appendFile(process.env.LOCK_LOG, "exit " + process.pid + "\\n");
});
`;
  const children: ReturnType<typeof spawn>[] = [];
  const startChild = (holdMs: number, ready?: string) => {
    const child = spawn(process.execPath, ["--input-type=module", "--eval", script], {
      env: {
        ...process.env,
        LOCK_MODULE: moduleUrl,
        LOCK_LOG: logFile,
        LOCK_HOLD_MS: String(holdMs),
        LOCK_READY: ready ?? "",
      },
      stdio: "ignore",
    });
    children.push(child);
    return child;
  };
  const waitForExit = (child: ReturnType<typeof spawn>, timeoutMs: number) => new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("Managed lifecycle lock child timed out"));
    }, timeoutMs);
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timeout);
      if (code === 0) resolve();
      else reject(new Error(`Managed lifecycle lock child exited (${signal ?? code})`));
    });
  });
  try {
    const crashedController = startChild(30_000, readyFile);
    const readyDeadline = Date.now() + 5_000;
    while (Date.now() < readyDeadline) {
      try {
        await readFile(readyFile, "utf8");
        break;
      } catch {
        if (crashedController.exitCode !== null) throw new Error("First lifecycle lock child exited before acquiring the lock");
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    }
    assert.equal(crashedController.exitCode, null);
    const crashedExit = new Promise<void>((resolve) => crashedController.once("exit", () => resolve()));
    crashedController.kill("SIGKILL");
    await crashedExit;

    const contenderA = startChild(100);
    const contenderB = startChild(100);
    await Promise.all([waitForExit(contenderA, 10_000), waitForExit(contenderB, 10_000)]);
    const events = (await readFile(logFile, "utf8")).trim().split("\n");
    assert.equal(events.length, 5);
    assert.match(events[0]!, /^enter \d+$/);
    for (let index = 1; index < events.length; index += 2) {
      const enteredPid = events[index]!.match(/^enter (\d+)$/)?.[1];
      const exitedPid = events[index + 1]!.match(/^exit (\d+)$/)?.[1];
      assert.ok(enteredPid);
      assert.equal(exitedPid, enteredPid);
    }
  } finally {
    for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
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
    else if (request.type === "get_state") respond({ model: { provider: "openai", id: "gpt-test" }, thinkingLevel: "medium", sessionId: "fake-owned-session", isStreaming: false });
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
      defaultModel: { provider: "openai", id: "gpt-test" },
      defaultReasoningLevel: "medium",
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
    const completionDeadline = Date.now() + 2_000;
    while (recovered.status === "running" && Date.now() < completionDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
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
