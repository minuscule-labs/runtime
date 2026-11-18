import assert from "node:assert/strict";
import { fork, type ChildProcess, type ExecFileOptions } from "node:child_process";
import { once } from "node:events";
import { createRequire, syncBuiltinESMExports } from "node:module";
import type { Stats } from "node:fs";
import test, { type TestContext } from "node:test";
import { collectDarwinProcessDomainObservation as collect } from "../src/darwin-process-domain.js";
import { observeDarwinPidAbsence as observe } from "../src/darwin-process-absence.js";

const host = "11111111-2222-5333-8444-555555555555";
const boot = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const other = "99999999-8888-4777-8666-555555555555";
const expected = () => ({ ioPlatformUuid: host, bootSessionUuid: boot });
const canary = "PRIVATE_ABSENCE_DIAGNOSTIC_CANARY";
const actualPlatform = process.platform;
const require = createRequire(import.meta.url);
const cp = require("node:child_process") as typeof import("node:child_process");
const fs = require("node:fs/promises") as typeof import("node:fs/promises");
type Reply = (error: Error | null, stdout: Buffer, stderr: Buffer) => void;

/** Mock only collector OS inputs and signal-zero outcomes, not deployment proof. */
function unit(t: TestContext, platform = "darwin") {
  const descriptor = Object.getOwnPropertyDescriptor(process, "platform")!;
  Object.defineProperty(process, "platform", { ...descriptor, value: platform });
  t.after(() => Object.defineProperty(process, "platform", descriptor));
  const state = { fresh: expected() as ReturnType<typeof expected> | undefined, osReads: 0 };
  const file = (path: unknown) => String(path) === "/usr/sbin/ioreg" || String(path) === "/usr/sbin/sysctl";
  const stat = t.mock.method(fs, "lstat", async (path: unknown) => ({ uid: 0, mode: 0o755,
    isSymbolicLink: () => false, isFile: () => file(path), isDirectory: () => !file(path),
  }) as Stats);
  const real = t.mock.method(fs, "realpath", async (path: unknown) => String(path));
  const exec = t.mock.method(cp, "execFile", ((path: string, _args: string[], _options: ExecFileOptions, done: Reply) => {
    state.osReads++;
    queueMicrotask(() => {
      const fresh = state.fresh;
      if (!fresh) { done(new Error(canary), Buffer.alloc(0), Buffer.from(canary)); return; }
      const stdout = path.endsWith("ioreg")
        ? `+-o Device  <class IOPlatformExpertDevice, id 0x1>\n    {\n      "IOPlatformUUID" = "${fresh.ioPlatformUuid}"\n    }\n  \n`
        : fresh.bootSessionUuid + "\n";
      done(null, Buffer.from(stdout), Buffer.alloc(0));
    });
    return {} as ChildProcess;
  }) as typeof cp.execFile);
  const queries: Array<{ pid: number; signal: string | number | undefined }> = [];
  const query = t.mock.method(process, "kill", (pid: number, signal?: string | number) => { queries.push({ pid, signal }); return true; });
  syncBuiltinESMExports();
  t.after(() => { query.mock.restore(); exec.mock.restore(); stat.mock.restore(); real.mock.restore(); syncBuiltinESMExports(); });
  return { state, queries, query };
}

for (const [name, pid] of [
  ["zero", 0], ["negative/group", -1], ["negative", -123], ["fractional", 1.5], ["string", "123"],
  ["missing", undefined], ["null", null], ["NaN", NaN], ["infinity", Infinity], ["too large", 0x80000000],
  ["unsafe", Number.MAX_SAFE_INTEGER], ["bigint", 123n], ["coercible object", { valueOf: () => 123 }],
] as const) {
  test(`invalid PID ${name} is unconfirmed without collection or a query`, async t => {
    const f = unit(t);
    assert.equal(await observe(pid, expected()), "unconfirmed");
    assert.equal(f.state.osReads, 0); assert.equal(f.queries.length, 0);
  });
}

for (const [name, value] of [
  ["missing", undefined], ["null", null], ["array", [host, boot]], ["empty", {}],
  ["missing boot", { ioPlatformUuid: host }], ["numeric host", { ioPlatformUuid: 123, bootSessionUuid: boot }],
  ["invalid host", { ioPlatformUuid: canary, bootSessionUuid: boot }],
  ["invalid boot", { ioPlatformUuid: host, bootSessionUuid: canary }],
  ["nil host", { ioPlatformUuid: "00000000-0000-0000-0000-000000000000", bootSessionUuid: boot }],
  ["placeholder boot", { ioPlatformUuid: host, bootSessionUuid: "FFFFFFFF-FFFF-FFFF-FFFF-FFFFFFFFFFFF" }],
  ["extra attestation flag", { ...expected(), verified: true }],
  ["inherited fields", Object.assign(Object.create(expected()), { a: 1, b: 2 })],
] as const) {
  test(`invalid expected observation ${name} cannot authorize a PID query`, async t => {
    const f = unit(t);
    assert.equal(await observe(123, value), "unconfirmed");
    assert.equal(f.state.osReads, 0); assert.equal(f.queries.length, 0);
  });
}

for (const platform of ["linux", "win32", "freebsd"]) {
  test(`unsupported ${platform} is unconfirmed without borrowing Darwin assumptions`, async t => {
    const f = unit(t, platform);
    assert.equal(await observe(123, expected()), "unconfirmed");
    assert.equal(f.state.osReads, 0); assert.equal(f.queries.length, 0);
  });
}

for (const field of ["ioPlatformUuid", "bootSessionUuid"] as const) {
  test(`fresh ${field} mismatch denies a query`, async t => {
    const f = unit(t); f.state.fresh![field] = other;
    assert.equal(await observe(123, expected()), "unconfirmed");
    assert.equal(f.state.osReads, 2); assert.equal(f.queries.length, 0);
  });
  test(`fresh malformed ${field} denies a query`, async t => {
    const f = unit(t); f.state.fresh![field] = canary;
    assert.equal(await observe(123, expected()), "unconfirmed");
    assert.equal(f.queries.length, 0);
  });
}

test("collection failure does not reuse earlier absence success or leak diagnostics", async t => {
  const f = unit(t);
  f.query.mock.mockImplementation(() => { throw Object.assign(new Error(canary), { code: "ESRCH", cause: new Error(canary) }); });
  assert.equal(await observe(123, expected()), "pid_absent");
  assert.equal(f.queries.length, 0); // Overridden mock does not use its default recorder.
  assert.equal(f.query.mock.callCount(), 1);
  f.state.fresh = undefined;
  assert.equal(await observe(123, expected()), "unconfirmed");
  assert.equal(f.query.mock.callCount(), 1);
  f.state.fresh = { ...expected(), bootSessionUuid: other };
  assert.equal(await observe(123, expected()), "unconfirmed");
  assert.equal(f.query.mock.callCount(), 1);
});

test("target and expected observations are captured before awaits, not reread from caller inputs", async t => {
  const f = unit(t);
  const input = { pid: 123, expected: expected() };
  const result = observe(input.pid, input.expected);
  input.pid = 456; input.expected.ioPlatformUuid = other; input.expected.bootSessionUuid = other;
  assert.equal(await result, "pid_present");
  assert.deepEqual(f.queries, [{ pid: 123, signal: 0 }]);
});

test("mutating mismatched expected observations after invocation cannot enable a query", async t => {
  const f = unit(t);
  const input = { ...expected(), ioPlatformUuid: other };
  const result = observe(123, input); input.ioPlatformUuid = host;
  assert.equal(await result, "unconfirmed"); assert.equal(f.queries.length, 0);
});

for (const pid of [1, 123, 0x7fffffff]) {
  test(`positive PID ${pid} uses exactly one fixed signal-zero query after matching collection`, async t => {
    const f = unit(t);
    assert.equal(await observe(pid, expected()), "pid_present");
    assert.equal(f.state.osReads, 2);
    assert.deepEqual(f.queries, [{ pid, signal: 0 }]);
  });
}

test("occupied or reused PID means only pid_present, never original-worker liveness or exit", async t => {
  const f = unit(t);
  assert.equal(await observe(123, expected()), "pid_present");
  assert.equal(await observe(123, expected()), "pid_present");
  assert.equal(f.query.mock.callCount(), 2); assert.equal(f.state.osReads, 4);
  assert.ok(f.queries.every(query => query.signal === 0));
});

for (const [name, error, result] of [
  ["ESRCH", Object.assign(new Error(canary), { code: "ESRCH" }), "pid_absent"],
  ["EPERM", Object.assign(new Error(canary), { code: "EPERM" }), "unconfirmed"],
  ["EACCES", Object.assign(new Error(canary), { code: "EACCES" }), "unconfirmed"],
  ["EINVAL", Object.assign(new Error(canary), { code: "EINVAL" }), "unconfirmed"],
  ["ENOENT", Object.assign(new Error(canary), { code: "ENOENT" }), "unconfirmed"],
  ["unknown code", Object.assign(new Error(canary), { code: canary }), "unconfirmed"],
  ["message only", new Error("ESRCH " + canary), "unconfirmed"],
  ["primitive", "ESRCH", "unconfirmed"], ["null", null, "unconfirmed"],
] as const) {
  test(`query error ${name} returns only ${result}, with no retry or diagnostic fields`, async t => {
    const f = unit(t);
    f.query.mock.mockImplementation((pid, signal) => {
      assert.equal(pid, 123); assert.equal(signal, 0); throw error;
    });
    assert.equal(await observe(123, expected()), result);
    assert.equal(f.query.mock.callCount(), 1); assert.equal(f.state.osReads, 2);
  });
}

test("exceptional expected/error access is sanitized without fallback", async t => {
  const f = unit(t);
  const input = { get ioPlatformUuid() { throw new Error(canary); }, bootSessionUuid: boot };
  assert.equal(await observe(123, input), "unconfirmed"); assert.equal(f.query.mock.callCount(), 0);
  f.query.mock.mockImplementation(() => { throw { get code() { throw new Error(canary); } }; });
  assert.equal(await observe(123, expected()), "unconfirmed"); assert.equal(f.query.mock.callCount(), 1);
});

if (actualPlatform === "darwin") {
  test("actual Darwin observes only the owned fixture PID slot while occupied and after exit (identifiers redacted)", { timeout: 8_000 }, async t => {
    const observation = await collect();
    assert.ok(Boolean(observation), "Required actual Darwin observations unavailable; no weaker fallback");
    const child = fork(new URL("./fixtures/darwin-domain-observer.js", import.meta.url), ["hang"], {
      stdio: ["ignore", "ignore", "ignore", "ipc"], execArgv: [],
    });
    t.after(async () => {
      if (child.exitCode === null && child.signalCode === null) { const exited = once(child, "exit"); child.kill("SIGKILL"); await exited; }
    });
    await once(child, "spawn");
    assert.equal(await observe(child.pid, observation), "pid_present", "Owned fixture slot should be occupied (PID redacted)");
    const exited = once(child, "exit"); child.kill("SIGTERM"); await exited; // Only a test-owned handle is terminated.
    assert.equal(await observe(child.pid, observation), "pid_absent", "Owned fixture slot should be absent after actual exit (PID redacted)");
    t.diagnostic("Actual Darwin owned-fixture occupied/absent observations passed. No worker identity, deployment or lifecycle proof claimed.");
  });
} else {
  test("actual non-Darwin result remains unconfirmed; Darwin PID boundary acceptance is outstanding", async t => {
    assert.equal(await observe(123, expected()), "unconfirmed");
    t.diagnostic("Required real Darwin PID-slot boundary NOT RUN here; no supported-host acceptance claim.");
  });
}
