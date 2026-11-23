import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test, { type TestContext } from "node:test";
import { CodexRpcProcess } from "../src/rpc.js";

const fixturePath = fileURLToPath(new URL("./fixtures/app-server.js", import.meta.url));

async function fixture(t: TestContext, scenario = "normal") {
  const directory = await mkdtemp(join(tmpdir(), "minu-codex-rpc-"));
  const logPath = join(directory, "requests.jsonl");
  const rpc = new CodexRpcProcess(directory, {
    command: process.execPath, args: [fixturePath, scenario, logPath],
    requestTimeoutMs: 1_000, shutdownTimeoutMs: 50,
  });
  t.after(async () => { await rpc.stop(); await rm(directory, { recursive: true, force: true }); });
  return { rpc, async log() { return (await readFile(logPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line)); } };
}

test("initializes, correlates out-of-order responses and decodes split UTF-8 frames", async (t) => {
  const { rpc, log } = await fixture(t);
  await rpc.initialize();
  assert.deepEqual(await Promise.all([
    rpc.request("test/echo", { order: 1 }), rpc.request("test/echo", { order: 2 }),
  ]), [{ order: 1 }, { order: 2 }]);
  assert.deepEqual(await rpc.request("test/fragmented"), { text: "café 🐈" });
  await assert.rejects(rpc.request("test/error"), /Codex native request failed/);
  assert.deepEqual(await rpc.request("test/echo", { alive: true }), { alive: true });
  const frames = await log();
  assert.deepEqual(frames[0].args, ["app-server", "--listen", "stdio://"]);
  assert.equal(frames[1].method, "initialize");
  assert.equal(frames[2].method, "initialized");
});

for (const [scenario, message] of [["invalid-json", /Invalid Codex protocol/], ["large-frame", /frame exceeds limit/]] as const) {
  test(`refuses ${scenario} and confirms child shutdown`, async (t) => {
    const { rpc, log } = await fixture(t, scenario);
    await assert.rejects(rpc.initialize(), message);
    await rpc.stop();
    const [{ pid }] = await log();
    assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
  });
}

test("a deadline stops an uncertain worker, escalating when TERM is ignored", async (t) => {
  const { rpc, log } = await fixture(t, "hang-ignore-term");
  await assert.rejects(rpc.initialize(), /timed out/);
  await rpc.stop();
  const [{ pid }] = await log();
  assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
  await assert.rejects(rpc.request("test/echo"), /timed out/);
});

test("unknown server requests are refused, never answered with approval", async (t) => {
  const { rpc, log } = await fixture(t);
  await rpc.initialize();
  const failed = new Promise<Error>((resolve) => { rpc.onFailure = resolve; });
  const pending = rpc.request("test/interactive");
  await assert.rejects(pending, /unsupported interactive operation/);
  assert.match((await failed).message, /unsupported interactive operation/);
  await rpc.stop();
  assert.equal((await log()).some((frame) => frame.id === "server-request" && frame.result), false);
});

test("spawn failure rejects promptly and stopping is repeatable", async () => {
  const rpc = new CodexRpcProcess(process.cwd(), { command: "/no-such-minu-codex-executable" });
  await assert.rejects(rpc.initialize(), (error: Error) => error.name === "CodexNotInstalledError" && !error.message.includes("no-such"));
  await rpc.stop();
  await rpc.stop();
});

test("a launch failure other than a missing executable stays generic", async () => {
  const rpc = new CodexRpcProcess(process.cwd(), { command: "/" });
  await assert.rejects(rpc.initialize(), (error: Error) => error.name === "Error" && /launch|input|exited/.test(error.message));
  await rpc.stop();
});

test("invalid deadlines fail before launching", () => {
  for (const value of [0, -1, NaN, Infinity, 0.5]) {
    assert.throws(() => new CodexRpcProcess(process.cwd(), { requestTimeoutMs: value }), /positive integers/);
  }
});
