import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { test, type TestContext } from "node:test";
import type { AgentTurn } from "@minu/runtime-core";
import { ClaudeCodeAgentRuntime } from "../src/index.js";
import { ClaudeCodeManagedRuntime } from "../src/managed-runtime.js";
import { ClaudeCodeManagedStore } from "../src/managed-store.js";

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==";
const image = { type: "image" as const, mimeType: "image/png" as const, data: PNG };
const MODELS = JSON.stringify([{ value: "default", displayName: "Default", description: "d", supportsEffort: true, supportedEffortLevels: ["low", "high"] }]);
const claude = fileURLToPath(new URL("./fixtures/claude.js", import.meta.url));

async function until<T>(read: () => Promise<T>, done: (value: T) => boolean): Promise<T> {
  const end = Date.now() + 8_000;
  while (true) { const value = await read(); if (done(value)) return value; if (Date.now() > end) throw new Error("Input/control test timed out"); await delay(10); }
}
async function inProcess(t: TestContext, models = MODELS) {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "claude-input-")));
  const files = { images: join(dir, "images"), steers: join(dir, "steers") };
  const runtime = new ClaudeCodeAgentRuntime({ executable: claude, startupTimeoutMs: 5_000, shutdownTimeoutMs: 2_000,
    env: { PATH: process.env.PATH, HOME: dir, CLAUDE_CONFIG_DIR: join(dir, "config"), MINU_CLAUDE_FIXTURE_MODELS: models,
      MINU_CLAUDE_FIXTURE_IMAGES: files.images, MINU_CLAUDE_FIXTURE_STEERS: files.steers } });
  const session = await runtime.start({ cwd: dir });
  t.after(async () => { await runtime.stop(session.id); await rm(dir, { recursive: true, force: true }); });
  return { dir, runtime, session, files };
}
const terminal = (runtime: ClaudeCodeAgentRuntime, id: string, turn: string) =>
  until(() => runtime.turn(id, turn), value => !!value && value.status !== "running") as Promise<AgentTurn>;

test("images: sent as SDK image blocks with a text block, projected as placeholders, capability follows the model", async t => {
  const { runtime, session, files } = await inProcess(t);
  assert.deepEqual(await runtime.inputCapabilities(session.id), { version: 1, images: true });
  await runtime.startTurn(session.id, "pic", "what is this?", [image]);
  const turn = await terminal(runtime, session.id, "pic");
  assert.equal(turn.status, "completed"); assert.equal(turn.input, "what is this?");
  assert.deepEqual(JSON.parse(await readFile(files.images, "utf8")), [{ type: "image", source: { type: "base64", media_type: "image/png", data: PNG } }]);
  await runtime.startTurn(session.id, "only", "", [image, image]); // images alone are valid input
  assert.equal((await terminal(runtime, session.id, "only")).status, "completed");
  assert.equal(JSON.parse(await readFile(files.images, "utf8")).length, 2);
  const messages = await runtime.messages(session.id);
  assert.deepEqual(messages.filter(m => m.role === "user").map(m => m.content), ["what is this?\n[image]", "[image]\n[image]"]);
  assert.doesNotMatch(JSON.stringify(messages), new RegExp(PNG.slice(0, 20)));
  // Idempotent retry includes the pixels; different pixels under the same id conflict.
  assert.equal((await runtime.startTurn(session.id, "pic", "what is this?", [image])).id, "pic");
  await assert.rejects(runtime.startTurn(session.id, "pic", "what is this?", [{ ...image, data: "YQ==" }]), /conflicts/);
});

test("images: refused when the model is not verified to accept them, and invalid images stay invalid", async t => {
  const { runtime, session } = await inProcess(t, "[]");
  assert.deepEqual(await runtime.inputCapabilities(session.id), { version: 1, images: false });
  await assert.rejects(runtime.startTurn(session.id, "pic", "x", [image]), /not supported by the selected model/);
  const live = await inProcess(t);
  await assert.rejects(live.runtime.startTurn(live.session.id, "bad", "x", [{ type: "image", mimeType: "image/svg+xml", data: PNG } as never]), /Invalid image/);
  await assert.rejects(live.runtime.startTurn(live.session.id, "bad", "x", [{ ...image, data: "not base64!" }]), /Invalid image base64/);
  await assert.rejects(live.runtime.startTurn(live.session.id, "bad", "x", Array(5).fill(image)), /Too many images/);
});

test("steer: a message queued into the running turn is folded in; the turn still has one result", async t => {
  const { runtime, session, files } = await inProcess(t);
  await runtime.startTurn(session.id, "t1", "wait-steer");
  await until(async () => (await runtime.status(session.id)), status => status === "working");
  await delay(50); await runtime.steer(session.id, "please be brief");
  const turn = await terminal(runtime, session.id, "t1");
  assert.equal(turn.status, "completed"); assert.equal(turn.response?.content, "steered: please be brief");
  assert.deepEqual((await readFile(files.steers, "utf8")).trim().split("\n").map(line => JSON.parse(line).text), ["please be brief"]);
  assert.equal(await runtime.status(session.id), "idle");
  assert.deepEqual((await runtime.messages(session.id)).filter(m => m.role === "user").map(m => m.content), ["wait-steer", "please be brief"]);
  // Remaining rejections: nothing running, wrong input, interrupted turn, offline.
  await assert.rejects(runtime.steer(session.id, "late"), /no running turn/);
  await runtime.startTurn(session.id, "t2", "hold"); await delay(50);
  await assert.rejects(runtime.steer(session.id, "  "), /required|input/);
  await runtime.interrupt(session.id); await terminal(runtime, session.id, "t2");
  await assert.rejects(runtime.steer(session.id, "after interrupt"), /no running turn/);
  await runtime.stop(session.id);
  await assert.rejects(runtime.steer(session.id, "offline"), /offline/);
});

async function managed(t: TestContext) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "claude-input-managed-")));
  const cwd = join(root, "workspace"), native = join(root, "native"), state = join(root, "managed");
  await mkdir(cwd, { mode: 0o700 }); await mkdir(native, { mode: 0o700 });
  const files = { images: join(root, "images"), steers: join(root, "steers") };
  const runtime = new ClaudeCodeManagedRuntime({ ownerId: "owner", storeRoot: state, nativeConfigRoot: native, timeoutMs: 4_000,
    workerExecutable: fileURLToPath(new URL("./fixtures/worker-entry.js", import.meta.url)),
    nativeOptions: { executable: fileURLToPath(new URL("./fixtures/persistent-native.js", import.meta.url)), startupTimeoutMs: 2_000, shutdownTimeoutMs: 1_000, controlTimeoutMs: 1_000,
      env: { HOME: root, PATH: process.env.PATH!, CLAUDE_CONFIG_DIR: native, ANTHROPIC_API_KEY: "dummy-local-only", MINU_CLAUDE_FIXTURE_MODELS: MODELS,
        MINU_CLAUDE_FIXTURE_IMAGES: files.images, MINU_CLAUDE_FIXTURE_STEERS: files.steers } } });
  const store = new ClaudeCodeManagedStore(state);
  t.after(async () => {
    const children = [...(runtime as unknown as { ownedChildren: Map<string, import("node:child_process").ChildProcess> }).ownedChildren.values()];
    for (const child of children) {
      if (child.exitCode === null && child.stdin?.writable) child.stdin.end("dispose-owned-fixture\n");
      await until(async () => child.exitCode ?? child.signalCode, code => code !== null);
    }
    await rm(root, { recursive: true, force: true });
  });
  return { root, cwd, runtime, store, files };
}

test("managed: image input, steering and stop/resume with exact history (recorded steering, hidden image pointer)", async t => {
  const f = await managed(t), session = await f.runtime.startManaged({ cwd: f.cwd }, "owner");
  assert.deepEqual(await f.runtime.inputCapabilities(session.id), { version: 1, images: true }, "known before the lazy native opening");
  await f.runtime.startTurn(session.id, "pic", "managed picture", [image]);
  await until(() => f.runtime.turn(session.id, "pic"), value => value?.status === "completed");
  assert.equal(JSON.parse(await readFile(f.files.images, "utf8")).length, 1);
  await f.runtime.startTurn(session.id, "steered", "wait-steer");
  await until(() => f.runtime.status(session.id), status => status === "working"); await delay(100);
  await f.runtime.steer(session.id, "managed steer");
  const turn = await until(() => f.runtime.turn(session.id, "steered"), value => value?.status === "completed");
  assert.equal(turn?.response?.content, "steered: managed steer");
  await f.runtime.stop(session.id);
  const stopped = (await f.store.read(session.id, "owner"))!;
  assert.equal(stopped.worker.state, "none");
  assert.equal(stopped.lastDispatch.state, "settled");
  if (stopped.lastDispatch.state === "settled") assert.deepEqual(stopped.lastDispatch.steers, [createHash("sha256").update("managed steer").digest("hex")]);
  const history = (await f.runtime.messages(session.id)).map(m => m.content);
  assert.ok(history.includes("managed picture\n[image]")); assert.ok(history.includes("steered: managed steer"));
  const next = new ClaudeCodeManagedRuntime({ ownerId: "owner", storeRoot: join(f.root, "managed"), nativeConfigRoot: join(f.root, "native"), timeoutMs: 4_000,
    workerExecutable: fileURLToPath(new URL("./fixtures/worker-entry.js", import.meta.url)),
    nativeOptions: { executable: fileURLToPath(new URL("./fixtures/persistent-native.js", import.meta.url)), startupTimeoutMs: 2_000, shutdownTimeoutMs: 1_000, controlTimeoutMs: 1_000,
      env: { HOME: f.root, PATH: process.env.PATH!, CLAUDE_CONFIG_DIR: join(f.root, "native"), ANTHROPIC_API_KEY: "dummy-local-only", MINU_CLAUDE_FIXTURE_MODELS: MODELS } } });
  await next.resume(session.id, "owner", { allowStopped: true });
  await next.send(session.id, "after resume"); await next.stop(session.id);
  const children = (next as unknown as { ownedChildren: Map<string, import("node:child_process").ChildProcess> }).ownedChildren;
  for (const child of children.values()) await until(async () => child.exitCode ?? child.signalCode, code => code !== null);
  children.clear();
});

test("managed: steering needs a running dispatch; images need a model that accepts them", async t => {
  const f = await managed(t), session = await f.runtime.startManaged({ cwd: f.cwd }, "owner");
  await assert.rejects(f.runtime.steer(session.id, "nothing is running"), /unavailable/);
  await f.runtime.send(session.id, "idle again");
  await assert.rejects(f.runtime.steer(session.id, "turn already settled"), /unavailable/);
  await f.runtime.stop(session.id);
});

test("images: an idempotent retry compares MIME types too; the same pixels under another type conflict", async t => {
  const { runtime, session } = await inProcess(t);
  await runtime.startTurn(session.id, "pic", "same bytes", [image]); await terminal(runtime, session.id, "pic");
  assert.equal((await runtime.startTurn(session.id, "pic", "same bytes", [image])).id, "pic");
  await assert.rejects(runtime.startTurn(session.id, "pic", "same bytes", [{ ...image, mimeType: "image/jpeg" }]), /conflicts/);
});

test("model selection fails closed when the engine reports a different model than requested", async t => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "claude-model-")));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const models = JSON.stringify([{ value: "default", displayName: "D", description: "" },
    { value: "sonnet", resolvedModel: "claude-sonnet-fixture", displayName: "S", description: "" }]);
  const env = (extra: Record<string, string> = {}) => ({ PATH: process.env.PATH, HOME: dir, CLAUDE_CONFIG_DIR: join(dir, "config"), MINU_CLAUDE_FIXTURE_MODELS: models, ...extra });
  // Honest engine: the requested alias or its resolved id is what runs.
  for (const id of ["sonnet", "claude-sonnet-fixture"]) {
    const runtime = new ClaudeCodeAgentRuntime({ executable: claude, startupTimeoutMs: 5_000, shutdownTimeoutMs: 2_000, env: env() });
    const session = await runtime.start({ cwd: dir, model: { provider: "anthropic", id } });
    await runtime.send(session.id, "hello");
    assert.equal(await runtime.status(session.id), "idle"); await runtime.stop(session.id);
  }
  // The engine ran something else: the turn fails and the session goes offline instead of silently accepting it.
  const runtime = new ClaudeCodeAgentRuntime({ executable: claude, startupTimeoutMs: 5_000, shutdownTimeoutMs: 2_000, env: env({ MINU_CLAUDE_FIXTURE_INIT_MODEL: "claude-other-model" }) });
  const session = await runtime.start({ cwd: dir, model: { provider: "anthropic", id: "sonnet" } });
  await assert.rejects(runtime.send(session.id, "hello"));
  assert.equal(await runtime.status(session.id), "offline"); await runtime.stop(session.id);
  // No model requested: whatever the native default is, is accepted.
  const plain = new ClaudeCodeAgentRuntime({ executable: claude, startupTimeoutMs: 5_000, env: env({ MINU_CLAUDE_FIXTURE_INIT_MODEL: "claude-other-model" }) });
  const free = await plain.start({ cwd: dir }); await plain.send(free.id, "hello"); await plain.stop(free.id);
});

test("in-process capabilities() requires the same native login as managed creation", async t => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "claude-caps-auth-")));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const runtime = new ClaudeCodeAgentRuntime({ executable: claude, startupTimeoutMs: 5_000, shutdownTimeoutMs: 2_000,
    env: { PATH: process.env.PATH, HOME: dir, CLAUDE_CONFIG_DIR: join(dir, "config"), MINU_CLAUDE_FIXTURE_ACCOUNT: "none", MINU_CLAUDE_FIXTURE_MODELS: MODELS } });
  const error = await runtime.capabilities({ cwd: dir }).then(() => undefined, caught => caught);
  assert.equal(error?.name, "ClaudeCodeAuthRequiredError");
  const loggedIn = new ClaudeCodeAgentRuntime({ executable: claude, startupTimeoutMs: 5_000, shutdownTimeoutMs: 2_000,
    env: { PATH: process.env.PATH, HOME: dir, CLAUDE_CONFIG_DIR: join(dir, "config"), MINU_CLAUDE_FIXTURE_MODELS: MODELS } });
  assert.deepEqual((await loggedIn.capabilities({ cwd: dir })).models.map(m => m.id), ["default"]);
});
