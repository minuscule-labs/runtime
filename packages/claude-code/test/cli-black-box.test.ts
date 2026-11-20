import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { test, type TestContext } from "node:test";
import { fileURLToPath } from "node:url";

// Black-box oracles use only CLI JSON/exit codes and a loopback request counter.
// No adapter/store imports, manifest reads, protocol peers or valid model inputs.
const cliPath = fileURLToPath(new URL("../src/cli.js", import.meta.url));
const dummyKey = "OFFLINE_CLI_BLACK_BOX_DUMMY_NOT_A_CREDENTIAL";
const options = { timeout: 90_000 };
type Flags = Record<string, string>;
type Result = { code: number; stdout: string; stderr: string };

async function fixture(t: TestContext) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "claude-cli-black-box-")));
  const home = join(root, "home"), native = join(root, "native"), otherNative = join(root, "other-native");
  const cwd = join(root, "workspace"), state = join(root, "state");
  await Promise.all([home, native, otherNative, cwd].map(path => mkdir(path, { mode: 0o700 })));
  let requests = 0;
  const guard = createServer((request, response) => {
    requests++;
    request.resume();
    response.writeHead(503, { "content-type": "application/json", connection: "close" });
    response.end('{"error":"offline_test_does_not_serve_model_requests"}');
  });
  await new Promise<void>((resolve, reject) => {
    guard.once("error", reject);
    guard.listen(0, "127.0.0.1", resolve);
  });
  const env = {
    HOME: home, TMPDIR: root,
    PATH: [dirname(process.execPath), "/usr/bin", "/bin", "/usr/sbin", "/sbin"].join(delimiter),
    ANTHROPIC_API_KEY: dummyKey,
    ANTHROPIC_BASE_URL: `http://127.0.0.1:${(guard.address() as AddressInfo).port}`,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", NO_PROXY: "127.0.0.1,localhost",
  };
  const args = (command: string, flags: Flags = {}) => [cliPath, command, ...Object.entries({
    "--owner": "black-box-owner", "--state": state, "--native-root": native, "--executable": "bundled", ...flags,
  }).flat()];
  const raw = (argv: string[], input?: string | Buffer) => new Promise<Result>((resolve, reject) => {
    const child = execFile(process.execPath, argv, { env, timeout: 30_000, maxBuffer: 128 * 1024 }, (error, stdout, stderr) => {
      if (!error) resolve({ code: 0, stdout, stderr });
      else if (typeof error.code === "number") resolve({ code: error.code, stdout, stderr });
      else reject(error); // A timeout/spawn failure is not an expected CLI rejection.
    });
    child.stdin!.on("error", () => {}); // An early argument rejection may close stdin.
    child.stdin!.end(input);
  });
  const call = (command: string, flags: Flags = {}, input?: string | Buffer) => raw(args(command, flags), input);
  const json = async (command: string, flags: Flags = {}) => {
    const result = await call(command, flags);
    assert.equal(result.code, 0, `${command}: ${result.stderr}`);
    assert.ok(!result.stderr.includes(dummyKey));
    return JSON.parse(result.stdout);
  };
  const refused = (result: Result) => {
    assert.equal(result.code, 1, result.stderr);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /\{"error":"claude_code_command_failed"\}/);
    assert.ok(!result.stderr.includes(root), "errors must not expose private fixture paths");
    assert.ok(!result.stderr.includes(dummyKey), "errors must not expose native environment credentials");
  };
  t.after(async () => {
    let clean = false;
    try {
      // Use the same public boundary for cleanup. Preserve ambiguous fixtures;
      // never delete live/uncertain state or signal a recovered worker PID/group.
      for (const session of await json("list")) {
        if (session.state === "active") await json("stop", { "--id": session.id });
        else assert.equal(session.state, "suspended", "Fixture shutdown is unproven; preserve its state");
      }
      assert.equal(requests, 0, "Metadata/invalid-input scenarios must not call the model endpoint");
      clean = true;
    } finally {
      await new Promise<void>((resolve, reject) => guard.close(error => error ? reject(error) : resolve()));
      if (clean) await rm(root, { recursive: true, force: true });
      else t.diagnostic(`Uncertain black-box fixture preserved: ${root}`);
    }
  });
  const create = async () => {
    const session = await json("create", { "--cwd": cwd });
    assert.equal(session.runtime, "claude-code");
    assert.equal(session.ownerId, "black-box-owner");
    assert.equal(session.ownership, "owned");
    assert.equal(session.cwd, cwd);
    assert.equal(typeof session.id, "string");
    assert.ok(session.id);
    return session;
  };
  return { root, cwd, otherNative, args, env, raw, call, json, refused, create, requests: () => requests };
}

function safeSummary(summary: Record<string, unknown>, root: string) {
  assert.ok(Object.keys(summary).every(key => ["id", "ownerId", "state", "createdAt", "unavailableReason"].includes(key)));
  const text = JSON.stringify(summary);
  assert.ok(!text.includes(root));
  assert.ok(!text.includes(dummyKey));
  assert.doesNotMatch(text, /token|endpoint|fingerprint|processGroupId|nativeConfigRoot/);
}

test("CLI black box: independent processes reconnect to an empty session without model work", options, async t => {
  const f = await fixture(t);
  assert.deepEqual(await f.json("list"), []);
  const session = await f.create(), flags = { "--id": session.id };
  assert.equal(await f.json("status", flags), "idle");
  assert.equal((await f.json("get", flags)).state, "active");
  assert.deepEqual(await f.json("history", flags), []);
  assert.equal(await f.json("turn", { ...flags, "--turn-id": "not-submitted" }), null);
  assert.deepEqual(await f.json("interrupt", flags), { acknowledged: true });
  assert.equal(await f.json("status", flags), "idle");
  const inventory = await f.json("list");
  assert.equal(inventory.length, 1); assert.equal(inventory[0].id, session.id);
  safeSummary(inventory[0], f.root);
  assert.equal(f.requests(), 0);
});

test("CLI black box: exact-owner queries and controls cannot cross scopes", options, async t => {
  const f = await fixture(t), session = await f.create();
  const wrong = { "--id": session.id, "--owner": "another-owner" };
  assert.equal(await f.json("get", wrong), null);
  assert.deepEqual(await f.json("list", { "--owner": "another-owner" }), []);
  for (const command of ["status", "history", "stop", "resume", "interrupt"]) f.refused(await f.call(command, wrong));
  assert.equal(await f.json("status", { "--id": session.id }), "idle");
  assert.equal((await f.json("list")).length, 1);
});

test("CLI black box: empty stop/resume preserves identity and inspection never auto-wakes it", options, async t => {
  const f = await fixture(t), session = await f.create(), flags = { "--id": session.id };
  assert.deepEqual(await f.json("stop", flags), { suspended: true });
  assert.equal(await f.json("status", flags), "offline");
  const suspended = await f.json("get", flags);
  assert.equal(suspended.id, session.id); assert.equal(suspended.state, "suspended");
  assert.equal((await f.json("list"))[0].state, "suspended");
  safeSummary(suspended, f.root);
  assert.deepEqual(await f.json("history", flags), []);
  f.refused(await f.call("turn", { ...flags, "--turn-id": "not-submitted" }));
  assert.equal(await f.json("status", flags), "offline");
  assert.deepEqual(await f.json("resume", flags), session);
  assert.equal(await f.json("status", flags), "idle");
  assert.deepEqual(await f.json("history", flags), []);
  assert.equal((await f.json("list")).length, 1);
  assert.equal(f.requests(), 0);
});

test("CLI black box: malformed stdin fails privately without dispatch or poisoning the session", options, async t => {
  const f = await fixture(t), session = await f.create(), flags = { "--id": session.id };
  const invalid = [
    "not json", Buffer.from([0xff]), "null", "[]",
    JSON.stringify({ turnId: "rejected-turn", input: "valid text", images: [] }),
    JSON.stringify({ input: "missing caller id" }),
    JSON.stringify({ turnId: "rejected-turn", input: "\ud800" }),
    JSON.stringify({ turnId: "rejected-turn", input: 42 }),
  ];
  for (const input of invalid) f.refused(await f.call("run", flags, input));
  assert.equal(await f.json("turn", { ...flags, "--turn-id": "rejected-turn" }), null);
  assert.equal(await f.json("status", flags), "idle");
  assert.deepEqual(await f.json("history", flags), []);
  assert.equal(f.requests(), 0);
});

test("CLI black box: invalid arguments and unknown IDs cannot create or disturb sessions", options, async t => {
  const f = await fixture(t), session = await f.create(), flags = { "--id": session.id };
  for (const argv of [
    [cliPath, "not-a-command"], [cliPath, "status"],
    [...f.args("status", flags), "--owner", "duplicate-owner"],
    [...f.args("status", flags), "--unexpected", "value"],
    [...f.args("status", flags), "--turn-id"],
  ]) f.refused(await f.raw(argv));
  const absent = { "--id": randomUUID() };
  assert.equal(await f.json("get", absent), null);
  for (const command of ["status", "stop", "resume"]) f.refused(await f.call(command, absent));
  f.refused(await f.call("create", { "--cwd": join(f.root, "absent-workspace") }));
  assert.equal(await f.json("status", flags), "idle");
  const inventory = await f.json("list");
  assert.equal(inventory.length, 1); assert.equal(inventory[0].id, session.id);
});

test("CLI black box: a different native root refuses control without altering the existing session", options, async t => {
  const f = await fixture(t), session = await f.create(), flags = { "--id": session.id };
  const wrong = { ...flags, "--native-root": f.otherNative };
  const unavailable = await f.json("get", wrong);
  assert.equal(unavailable.state, "unavailable"); safeSummary(unavailable, f.root);
  for (const command of ["status", "history", "stop", "resume"]) f.refused(await f.call(command, wrong));
  assert.equal(await f.json("status", flags), "idle");
  assert.equal((await f.json("get", flags)).state, "active");
  assert.deepEqual(await f.json("history", flags), []);
});

test("CLI black box: cancelling an event reader exits the consumer but leaves the worker usable", options, async t => {
  const f = await fixture(t), session = await f.create(), flags = { "--id": session.id };
  const output = await new Promise<string>((resolve, reject) => {
    let received = "", interrupted = false;
    const child = execFile(process.execPath, f.args("events", flags), {
      env: f.env, timeout: 30_000, maxBuffer: 128 * 1024,
    }, (error, stdout, stderr) => {
      if (error) { reject(error); return; }
      if (!interrupted || stderr.includes(dummyKey)) { reject(new Error("Event reader did not cancel safely")); return; }
      resolve(stdout);
    });
    child.stdin!.end();
    child.stdout!.on("data", chunk => {
      received += chunk;
      if (!interrupted && received.includes("\n")) {
        interrupted = true;
        child.kill("SIGINT"); // Original local CLI consumer only, never a recovered worker PID/group.
      }
    });
  });
  const first = JSON.parse(output.trim().split("\n")[0]);
  assert.equal(first.type, "status"); assert.equal(first.status, "idle");
  assert.equal(first.sessionId, session.id);
  assert.equal(await f.json("status", flags), "idle");
  assert.equal((await f.json("get", flags)).state, "active");
  assert.deepEqual(await f.json("history", flags), []);
});
