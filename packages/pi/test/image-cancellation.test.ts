import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { PiAgentRuntime } from "../src/client.js";

async function waitFor(check: () => Promise<boolean>) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Controlled image cancellation timed out");
}

test("owned image preparation cancels before native dispatch and cannot poison a subsequent turn", { timeout: 20_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "runtime-image-cancel-"));
  const fakePi = join(directory, "controlled-pi.mjs");
  const control = join(directory, "hold-count");
  const held = join(directory, "held");
  const release = join(directory, "release");
  const released = join(directory, "released");
  const commands = join(directory, "commands.jsonl");
  const previous = { PI_COMMAND: process.env.PI_COMMAND, MINU_RUNTIME_DIR: process.env.MINU_RUNTIME_DIR };
  const runtime = new PiAgentRuntime();
  let sessionId: string | undefined;
  await writeFile(fakePi, `#!/usr/bin/env node
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
const messages = [];
let buffer = "";
process.stdin.on("data", chunk => {
  buffer += chunk.toString();
  while (buffer.includes("\\n")) {
    const index = buffer.indexOf("\\n");
    const command = JSON.parse(buffer.slice(0, index)); buffer = buffer.slice(index + 1);
    appendFileSync(${JSON.stringify(commands)}, JSON.stringify(command) + "\\n", { mode: 0o600 });
    const respond = data => console.log(JSON.stringify({ id: command.id, type: "response", command: command.type, success: true, data }));
    if (command.type === "get_state") {
      const state = { sessionId: "controlled-cancel", isStreaming: false, model: { input: ["text", "image"] } };
      let remaining = 0;
      try { remaining = Number(readFileSync(${JSON.stringify(control)}, "utf8")); } catch {}
      if (remaining > 0) writeFileSync(${JSON.stringify(control)}, String(remaining - 1));
      if (remaining === 1) {
        writeFileSync(${JSON.stringify(held)}, "held");
        const timer = setInterval(() => {
          if (!existsSync(${JSON.stringify(release)})) return;
          clearInterval(timer); respond(state); writeFileSync(${JSON.stringify(released)}, "released");
        }, 5);
      } else respond(state);
    } else if (command.type === "get_messages") respond({ messages });
    else if (command.type === "prompt") {
      messages.push({ role: "assistant", content: "NEXT_COMPLETED" });
      respond(undefined); console.log(JSON.stringify({ type: "agent_settled" }));
    } else respond({});
  }
});
process.on("SIGTERM", () => process.exit(0));
`, { mode: 0o700 });
  try {
    await chmod(fakePi, 0o700);
    process.env.PI_COMMAND = fakePi;
    process.env.MINU_RUNTIME_DIR = join(directory, "runtime");
    sessionId = (await runtime.start({ cwd: directory })).id;
    // /turns admission reads get_state once; hold inject's final model check.
    await writeFile(control, "2");
    const images = [{ type: "image" as const, mimeType: "image/png" as const, data: Buffer.from("pixels").toString("base64") }];
    assert.equal((await runtime.startTurn(sessionId, "cancel-image", "never dispatch", images)).status, "running");
    await waitFor(() => readFile(held).then(() => true, () => false));
    assert.equal(await runtime.status(sessionId), "working");
    await assert.rejects(runtime.steer(sessionId, "must not queue while preparing"), /must be working/);
    await runtime.interrupt(sessionId);
    const id = sessionId;
    await waitFor(async () => (await runtime.turn(id, "cancel-image"))?.status === "interrupted");
    assert.equal(await runtime.status(sessionId), "idle");

    await runtime.startTurn(sessionId, "next", "next turn");
    await waitFor(async () => (await runtime.turn(id, "next"))?.status === "completed");
    await writeFile(release, "release");
    await waitFor(() => readFile(released).then(() => true, () => false));
    await runtime.messages(sessionId);
    const observed = (await readFile(commands, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as { type: string; message?: string });
    assert.deepEqual(observed.filter((command) => command.type === "prompt").map((command) => command.message), ["next turn"]);
    assert.ok(!observed.some((command) => command.type === "abort" || command.type === "steer"), "Canceled preparation needs no native control command");
    assert.equal((await runtime.startTurn(sessionId, "cancel-image", "never dispatch", images)).status, "interrupted");
    assert.equal((await runtime.turn(sessionId, "next"))?.status, "completed");
    assert.equal(await runtime.status(sessionId), "idle");
  } finally {
    await writeFile(release, "release").catch(() => {});
    if (sessionId) await runtime.stop(sessionId).catch(() => {});
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    await rm(directory, { recursive: true, force: true });
  }
});
