import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { test, type TestContext } from "node:test";
import type { CanUseTool, PermissionResult } from "@anthropic-ai/claude-agent-sdk";
import { ClaudeCodeAgentRuntime } from "../src/client.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve };
}
async function until<T>(read: () => Promise<T>, done: (value: T) => boolean): Promise<T> {
  const end = Date.now() + 5_000;
  while (true) { const value = await read(); if (done(value)) return value; if (Date.now() > end) throw new Error("Permission test timed out"); await delay(5); }
}
async function fixture(t: TestContext, handler: CanUseTool, timeout = 1_000, mode = "") {
  const root = await mkdtemp(join(tmpdir(), "claude-permission-")), replies = join(root, "replies");
  const runtime = new ClaudeCodeAgentRuntime({ executable: fileURLToPath(new URL("./fixtures/claude.js", import.meta.url)),
    tools: ["Write"], canUseTool: handler, controlTimeoutMs: timeout, startupTimeoutMs: 5_000, shutdownTimeoutMs: 2_000,
    env: { PATH: process.env.PATH, HOME: root, CLAUDE_CONFIG_DIR: join(root, "native"), ANTHROPIC_API_KEY: "dummy-local-only",
      ANTHROPIC_BASE_URL: "http://127.0.0.1:1", MINU_CLAUDE_FIXTURE_PID: join(root, "pid"),
      MINU_CLAUDE_FIXTURE_MODE: mode, MINU_CLAUDE_FIXTURE_REPLIES: replies } });
  const session = await runtime.start({ cwd: root });
  t.after(async () => { await runtime.stop(session.id); await rm(root, { recursive: true, force: true }); });
  const pid = Number(await readFile(join(root, "pid"), "utf8"));
  const terminal = (id: string) => until(() => runtime.turn(session.id, id), value => !!value && value.status !== "running");
  const received = async (): Promise<Array<{ behavior?: string }>> => {
    try { return (await readFile(replies, "utf8")).trim().split("\n").map(line => JSON.parse(line)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
  };
  const gone = () => until(async () => { try { process.kill(pid, 0); return false; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") return true; throw error; } }, Boolean);
  return { runtime, session, terminal, received, gone };
}

test("permission deadline aborts a hung callback and late allow cannot revive or approve the failed turn", async t => {
  const late = deferred<PermissionResult>(), entered = deferred<AbortSignal>(), returned = deferred<void>();
  const f = await fixture(t, async (_name, _input, options) => {
    entered.resolve(options.signal); const result = await late.promise; returned.resolve(); return result;
  }, 50);
  await f.runtime.startTurn(f.session.id, "hung", "permission"); const signal = await entered.promise;
  const turn = await f.terminal("hung"); assert.equal(turn?.status, "failed"); assert.match(turn.error!, /permission decision timed out/);
  assert.equal(signal.aborted, true); assert.equal(await f.runtime.status(f.session.id), "offline");
  await f.gone(); // The failure handler itself must stop the native process; no explicit stop yet.
  late.resolve({ behavior: "allow", updatedInput: { content: "must not run" } }); await returned.promise; await delay(30);
  assert.equal((await f.received()).some(reply => reply.behavior === "allow"), false);
  assert.equal((await f.runtime.turn(f.session.id, "hung"))?.status, "failed");
  await assert.rejects(f.runtime.startTurn(f.session.id, "next", "permission"), /offline/);
});

test("an overdue callback cannot grant permission before a starved deadline timer runs", async t => {
  let elapsed = 0, signal: AbortSignal | undefined;
  const f = await fixture(t, async (_name, _input, options) => {
    signal = options.signal;
    const started = performance.now();
    while (performance.now() - started < 80) { /* Finite event-loop delay, not a preemption test. */ }
    elapsed = performance.now() - started;
    return { behavior: "allow" };
  }, 20);
  await f.runtime.startTurn(f.session.id, "overdue", "permission");
  const turn = await f.terminal("overdue");
  assert.ok(elapsed >= 80); assert.equal(turn?.status, "failed");
  assert.equal(turn.error, "Claude Code permission decision timed out");
  assert.equal(signal?.aborted, true); assert.equal(await f.runtime.status(f.session.id), "offline");
  await f.gone(); // The timeout path itself must confirm exit without a later stop().
  assert.equal((await f.received()).some(reply => reply.behavior === "allow"), false);
});

test("native withdrawal cancels a permission callback without inventing turn settlement", async t => {
  const late = deferred<PermissionResult>(), entered = deferred<AbortSignal>(), returned = deferred<void>();
  const f = await fixture(t, async (_name, _input, options) => {
    entered.resolve(options.signal); const result = await late.promise; returned.resolve(); return result;
  });
  await f.runtime.startTurn(f.session.id, "withdrawn", "permission-cancel"); const signal = await entered.promise;
  await until(async () => signal.aborted, Boolean);
  assert.equal((await f.runtime.turn(f.session.id, "withdrawn"))?.status, "running");
  assert.equal(await f.runtime.status(f.session.id), "working");
  await f.runtime.interrupt(f.session.id); assert.equal((await f.terminal("withdrawn"))?.status, "interrupted");
  late.resolve({ behavior: "allow" }); await returned.promise; await delay(30);
  assert.equal((await f.received()).some(reply => reply.behavior === "allow"), false);
  await f.runtime.send(f.session.id, "still usable"); assert.equal(await f.runtime.status(f.session.id), "idle");
});

test("interrupt cancels A's permission decision and a late A allow cannot approve B", async t => {
  const a = deferred<PermissionResult>(), b = deferred<PermissionResult>(), first = deferred<AbortSignal>(), second = deferred<AbortSignal>(), returned = deferred<void>();
  let calls = 0;
  const f = await fixture(t, async (_name, _input, options) => {
    if (++calls === 1) { first.resolve(options.signal); const result = await a.promise; returned.resolve(); return result; }
    second.resolve(options.signal); return b.promise;
  }, 2_000, "interrupt-no-result");
  await f.runtime.startTurn(f.session.id, "A", "permission"); const firstSignal = await first.promise;
  await f.runtime.interrupt(f.session.id); assert.equal((await f.terminal("A"))?.status, "interrupted");
  assert.equal(firstSignal.aborted, true);
  await f.runtime.startTurn(f.session.id, "B", "permission"); const secondSignal = await second.promise;
  a.resolve({ behavior: "allow" }); await returned.promise; await delay(30);
  assert.equal(secondSignal.aborted, false); assert.equal((await f.runtime.turn(f.session.id, "B"))?.status, "running");
  assert.equal((await f.received()).some(reply => reply.behavior === "allow"), false);
  b.resolve({ behavior: "deny", message: "Explicit policy denial" });
  assert.equal((await f.terminal("B"))?.status, "completed");
  assert.equal((await f.runtime.messages(f.session.id)).at(-1)?.content, "denied");
});

test("stop aborts a pending callback and late approval is ignored", async t => {
  const late = deferred<PermissionResult>(), entered = deferred<AbortSignal>(), returned = deferred<void>();
  const f = await fixture(t, async (_name, _input, options) => {
    entered.resolve(options.signal); const result = await late.promise; returned.resolve(); return result;
  });
  await f.runtime.startTurn(f.session.id, "stopped", "permission"); const signal = await entered.promise;
  await f.runtime.stop(f.session.id); assert.equal(signal.aborted, true); await f.gone();
  late.resolve({ behavior: "allow" }); await returned.promise; await delay(30);
  assert.equal((await f.received()).some(reply => reply.behavior === "allow"), false);
});

test("invalid null/out-of-band results and callback errors fail closed with bounded diagnostics", async t => {
  for (const kind of ["null", "throw"]) {
    const f = await fixture(t, async () => {
      if (kind === "throw") throw new Error("PRIVATE_POLICY_CREDENTIAL", { cause: "PRIVATE_POLICY_CAUSE" });
      return null;
    });
    await f.runtime.startTurn(f.session.id, kind, "permission");
    const turn = await f.terminal(kind); assert.equal(turn?.status, "failed");
    assert.equal(turn.error, "Claude Code permission decision failed");
    assert.doesNotMatch(JSON.stringify({ turn, messages: await f.runtime.messages(f.session.id), replies: await f.received() }), /PRIVATE_POLICY/);
    await f.gone(); assert.equal((await f.received()).some(reply => reply.behavior === "allow"), false);
  }
});

test("timely explicit permission policy decisions retain their native allow/deny semantics", async t => {
  for (const behavior of ["allow", "deny"] as const) {
    let calls = 0;
    const f = await fixture(t, async (name, input, options) => {
      calls++; assert.equal(name, "Write"); assert.equal(options.signal.aborted, false);
      return behavior === "allow" ? { behavior, updatedInput: input } : { behavior, message: "Configured policy denial" };
    });
    await f.runtime.send(f.session.id, "permission"); assert.equal(calls, 1);
    assert.equal((await f.runtime.messages(f.session.id)).at(-1)?.content, behavior === "allow" ? "allowed" : "denied");
    assert.equal(await f.runtime.status(f.session.id), "idle");
  }
});
