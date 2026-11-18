import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, writeFile, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import type { AgentEvent } from "@minu/runtime-core";
import { PiRpcProcess, type RpcEvent } from "../src/pi-rpc.js";
import { PiAgentRuntime } from "../src/client.js";

const FAILURE = "Pi requested unsupported interactive input";
const PRIVATE = "PRIVATE_DIALOG_TITLE_OPTIONS_PREFILL";

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw error;
  }
}

async function until(check: () => boolean | Promise<boolean>, timeoutMs = 3_000): Promise<void> {
  const expiry = performance.now() + timeoutMs;
  while (!await check()) {
    assert.ok(performance.now() < expiry, "condition did not become true before deadline");
    await delay(10);
  }
}

async function fixture() {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "runtime-pi-headless-")));
  const command = join(directory, "pi.mjs");
  // A real owned subprocess/protocol peer, not a model or permission simulator.
  await writeFile(command, `#!${process.execPath}
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { randomUUID } from "node:crypto";
const sessionId = randomUUID();
appendFileSync("native-process.jsonl", JSON.stringify({ pid: process.pid, sessionId }) + "\\n");
const frames = (...values) => process.stdout.write(values.map(v => JSON.stringify(v)).join("\\n") + "\\n");
const response = (r, data) => ({ type: "response", id: r.id, command: r.type, success: true, data });
const ui = method => ({ type: "extension_ui_request", id: "private-dialog-id", method,
  title: "${PRIVATE}", message: "${PRIVATE}", options: ["${PRIVATE}"], prefill: "${PRIVATE}" });
createInterface({ input: process.stdin }).on("line", line => {
  appendFileSync("native-input.jsonl", line + "\\n");
  const r = JSON.parse(line);
  if (r.type === "get_state") frames(response(r, { sessionId, pid: process.pid, args: process.argv.slice(2), isStreaming: false }));
  else if (r.type === "get_messages") frames(response(r, { messages: [] }));
  else if (r.type === "test_ui") frames(ui(r.method), { type: "agent_settled" }, response(r, {}));
  else if (r.type === "test_notifications") frames(...r.methods.map(ui), response(r, {}));
  else if (r.type === "prompt") {
    frames(response(r, { disposition: "started" }), { type: "agent_start" });
    setTimeout(() => frames(ui("confirm"), { type: "agent_settled" }), 25);
  } else frames(response(r, {}));
});
`, { mode: 0o700 });
  const rpc = new PiRpcProcess(directory, () => {}, { command });
  const events: RpcEvent[] = [];
  rpc.onEvent(event => events.push(event));
  let exited = false;
  rpc.onExit(() => { exited = true; });
  const state = await rpc.request("get_state") as { pid: number; args: string[] };
  return {
    directory, command, rpc, events, state,
    async automaticExit() {
      await until(() => exited);
      assert.equal(alive(state.pid), false, "owned native process must exit before explicit cleanup");
    },
    async requests() { return (await readFile(join(directory, "native-input.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line) as RpcEvent); },
    async close() { await rpc.stop(); await rm(directory, { recursive: true, force: true }); },
  };
}

for (const method of ["select", "confirm", "input", "editor", "future-private-method", null, undefined, {}]) {
  test(`headless Pi refuses ${JSON.stringify(method)} without answering or waiting for a native UI timeout`, { timeout: 10_000 }, async () => {
    const f = await fixture();
    try {
      await assert.rejects(f.rpc.request("test_ui", { method }), { message: FAILURE });
      await f.automaticExit();
      await assert.rejects(f.rpc.request("should_not_dispatch"), { message: FAILURE });
      assert.deepEqual(f.events, [{ type: "rpc_interaction_error", error: FAILURE }]);
      assert.equal(JSON.stringify(f.events).includes(PRIVATE), false);
      assert.deepEqual((await f.requests()).map(r => r.type), ["get_state", "test_ui"]);
      assert.deepEqual(f.state.args, ["--approve", "--mode", "rpc"], "project trust is not an interactive answer");
    } finally { await f.close(); }
  });
}

test("Pi fire-and-forget UI records neither fail the process nor receive invented responses", async () => {
  const f = await fixture();
  try {
    const methods = ["notify", "setStatus", "setWidget", "setTitle", "set_editor_text"];
    await f.rpc.request("test_notifications", { methods });
    assert.deepEqual(f.events.map(event => event.method), methods);
    await f.rpc.request("get_state");
    assert.equal(alive(f.state.pid), true);
    assert.equal((await f.requests()).some(r => r.type === "extension_ui_response"), false);
  } finally { await f.close(); }
});

test("a failing event observer cannot leak the private dialog as a parse error or prevent native shutdown", async () => {
  const f = await fixture();
  try {
    f.rpc.onEvent(event => { f.events.push(event); throw new Error("observer failed"); });
    await assert.rejects(f.rpc.request("test_ui", { method: "confirm" }), { message: FAILURE });
    await f.automaticExit();
    assert.deepEqual(f.events, [{ type: "rpc_interaction_error", error: FAILURE }]);
  } finally { await f.close(); }
});

test("an unsupported dialog stops only its owned Pi process", async () => {
  const first = await fixture(), other = await fixture();
  try {
    await assert.rejects(first.rpc.request("test_ui", { method: "confirm" }), { message: FAILURE });
    await first.automaticExit();
    await other.rpc.request("get_state");
    assert.equal(alive(other.state.pid), true);
    assert.deepEqual(other.events, []);
  } finally { await Promise.all([first.close(), other.close()]); }
});

test("owned Pi worker publishes a fixed error, fails the send and becomes offline without an explicit stop", { timeout: 15_000 }, async () => {
  const f = await fixture();
  const previous = { command: process.env.PI_COMMAND, registry: process.env.MINU_RUNTIME_DIR };
  const runtime = new PiAgentRuntime();
  let sessionId: string | undefined;
  let collected: Promise<void> | undefined;
  try {
    process.env.PI_COMMAND = f.command;
    process.env.MINU_RUNTIME_DIR = join(f.directory, "registry");
    const session = await runtime.start({ cwd: f.directory });
    sessionId = session.id;
    const events: AgentEvent[] = [];
    const nativeProcesses = (await readFile(join(f.directory, "native-process.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line) as { pid: number; sessionId: string });
    const workerNative = nativeProcesses.find(p => p.sessionId === session.id)!;
    assert.ok(workerNative);
    const iterator = runtime.events(session.id)[Symbol.asyncIterator]();
    const initial = await iterator.next();
    assert.equal(initial.value?.type, "status");
    collected = (async () => { for await (const event of { [Symbol.asyncIterator]: () => iterator }) events.push(event); })();
    await assert.rejects(runtime.send(session.id, "ask for permission"));
    await until(() => events.some(e => e.type === "error"));
    await until(async () => await runtime.status(session.id) === "offline");
    await until(() => !alive(workerNative.pid));
    assert.ok(events.some(e => e.type === "error" && e.message === FAILURE));
    assert.equal(events.some(e => e.type === "turn_completed"), false);
    assert.equal(JSON.stringify(events).includes(PRIVATE), false);
    assert.equal((await f.requests()).some(r => r.type === "extension_ui_response"), false);
  } finally {
    if (sessionId) await runtime.stop(sessionId).catch(() => {});
    await collected?.catch(() => {});
    if (previous.command === undefined) delete process.env.PI_COMMAND; else process.env.PI_COMMAND = previous.command;
    if (previous.registry === undefined) delete process.env.MINU_RUNTIME_DIR; else process.env.MINU_RUNTIME_DIR = previous.registry;
    await f.close();
  }
});

test("native Pi extension confirm fails headlessly without returning a fabricated answer", { timeout: 20_000 }, async () => {
  const f = await fixture();
  const extension = join(f.directory, "extension.mjs"), answered = join(f.directory, "answered");
  await writeFile(extension, `import { writeFileSync } from "node:fs";
export default function (pi) {
  pi.registerCommand("runtime-headless-confirm", { description: "Disposable test dialog", handler: async (_args, ctx) => {
    await ctx.ui.confirm("${PRIVATE}", "${PRIVATE}");
    writeFileSync(${JSON.stringify(answered)}, "a decision was returned");
  }});
}
`);
  const command = join(f.directory, "native-pi");
  const cli = fileURLToPath(new URL("../../../../node_modules/@earendil-works/pi-coding-agent/dist/cli.js", import.meta.url));
  // Absolute paths, no real authentication, no model input: only an explicit local extension command.
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
  await writeFile(command, `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(cli)} --no-extensions --extension ${quote(extension)} "$@"\n`, { mode: 0o700 });
  const native = new PiRpcProcess(f.directory, () => {}, { command });
  let exited = false;
  native.onExit(() => { exited = true; });
  const events: RpcEvent[] = [];
  native.onEvent(event => events.push(event));
  try {
    await native.request("get_state");
    await assert.rejects(native.request("prompt", { message: "/runtime-headless-confirm" }), { message: FAILURE });
    await until(() => exited);
    assert.deepEqual(events.filter(e => e.type === "rpc_interaction_error"), [{ type: "rpc_interaction_error", error: FAILURE }]);
    assert.equal(JSON.stringify(events).includes(PRIVATE), false);
    await assert.rejects(readFile(answered), { code: "ENOENT" });
  } finally { await native.stop(); await f.close(); }
});
