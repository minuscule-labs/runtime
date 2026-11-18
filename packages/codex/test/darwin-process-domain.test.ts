import assert from "node:assert/strict";
import { fork, type ChildProcess, type ExecFileOptions } from "node:child_process";
import { once } from "node:events";
import { createRequire, syncBuiltinESMExports } from "node:module";
import type { Stats } from "node:fs";
import { fileURLToPath } from "node:url";
import test, { type TestContext } from "node:test";
import { collectDarwinProcessDomainObservation as collect, parseDarwinProcessDomainObservation as parse } from "../src/darwin-process-domain.js";

const host = "11111111-2222-5333-8444-555555555555";
const boot = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const header = "+-o Device  <class IOPlatformExpertDevice, id 0x1, registered, matched, active, busy 0, retain 1>";
const registry = (property = `"IOPlatformUUID" = "${host.toUpperCase()}"`) => Buffer.from(
  `${header}\n    {\n${property.split("\n").map(line => `      ${line.trimStart()}`).join("\n")}\n    }\n  \n`,
);
const bootBytes = Buffer.from(boot.toUpperCase() + "\n");
const canary = "PRIVATE_OS_DIAGNOSTIC_CANARY";
const actualPlatform = process.platform;
const require = createRequire(import.meta.url);
const cp = require("node:child_process") as typeof import("node:child_process");
const originalExecFile = cp.execFile;
const fs = require("node:fs/promises") as typeof import("node:fs/promises");
type Query = { file: string; args: string[]; options: ExecFileOptions };
type Reply = (error: Error | null, stdout: Buffer, stderr: Buffer) => void;

function unit(t: TestContext, platform = "darwin") {
  const descriptor = Object.getOwnPropertyDescriptor(process, "platform")!;
  Object.defineProperty(process, "platform", { ...descriptor, value: platform });
  t.after(() => Object.defineProperty(process, "platform", descriptor));
  const file = (path: string) => path === "/usr/sbin/ioreg" || path === "/usr/sbin/sysctl";
  const stat = t.mock.method(fs, "lstat", async (path: unknown) => ({ uid: 0, mode: 0o755,
    isSymbolicLink: () => false, isFile: () => file(String(path)), isDirectory: () => !file(String(path)),
  }) as Stats);
  const real = t.mock.method(fs, "realpath", async (path: unknown) => String(path));
  const calls: Query[] = [];
  const query = t.mock.method(cp, "execFile", ((path: string, args: string[], options: ExecFileOptions, done: Reply) => {
    calls.push({ file: path, args, options });
    queueMicrotask(() => done(null, path.endsWith("ioreg") ? registry() : bootBytes, Buffer.alloc(0)));
    return {} as ChildProcess;
  }) as typeof cp.execFile);
  syncBuiltinESMExports();
  t.after(() => { query.mock.restore(); stat.mock.restore(); real.mock.restore(); syncBuiltinESMExports(); });
  return { calls, stat, real, query };
}

function reply(f: ReturnType<typeof unit>, handler: (file: string, done: Reply) => void) {
  f.query.mock.mockImplementation(((file: string, _args: string[], _options: ExecFileOptions, done: Reply) => {
    queueMicrotask(() => handler(file, done)); return {} as ChildProcess;
  }) as typeof cp.execFile);
}

test("minimal OS observations parse to two private normalized UUID fields only", () => {
  const observation = parse(registry(), bootBytes);
  assert.deepEqual(observation, { ioPlatformUuid: host, bootSessionUuid: boot });
  assert.deepEqual(Object.keys(observation!).sort(), ["bootSessionUuid", "ioPlatformUuid"]);
  assert.deepEqual(parse(registry().subarray(0, registry().length - 1), Buffer.from(boot)), observation);
});

for (const [name, value] of [
  ["missing key", registry('    "IOPlatformSerialNumber" = "PRIVATE"')],
  ["wrong key", registry(`    "platform-uuid" = "${host}"`)],
  ["duplicate key", registry(`    "IOPlatformUUID" = "${host}"\n    "IOPlatformUUID" = "${host}"`)],
  ["malformed value", registry(`    "IOPlatformUUID" = "${canary}"`)],
  ["non-string value", registry(`    "IOPlatformUUID" = <${host}>`)],
  ["nil UUID", registry('    "IOPlatformUUID" = "00000000-0000-0000-0000-000000000000"')],
  ["placeholder UUID", registry('    "IOPlatformUUID" = "FFFFFFFF-FFFF-FFFF-FFFF-FFFFFFFFFFFF"')],
  ["wrong root", Buffer.from(registry().toString().replace("class IOPlatformExpertDevice", "class OtherDevice"))],
  ["multiple roots", Buffer.concat([registry(), registry()])],
  ["trailing private diagnostic", Buffer.concat([registry(), Buffer.from(canary)])],
  ["invalid UTF-8", Buffer.from([0xff])],
  ["oversized registry", Buffer.alloc(64 * 1024 + 1, 120)],
] as const) {
  test(`parser rejects ${name} without returning raw data`, () => { assert.equal(parse(value, bootBytes), undefined); });
}

for (const value of ["", canary, `${boot}\n${boot}\n`, ` ${boot}\n`, `${boot}\n\n`, "00000000-0000-0000-0000-000000000000", "f".repeat(129)]) {
  test(`parser rejects malformed/missing/oversized boot input (${value.length} bytes)`, () => {
    assert.equal(parse(registry(), Buffer.from(value)), undefined);
  });
}

test("collector uses only fixed trusted read-only commands, bounded buffers/deadlines and a clean environment", async t => {
  const f = unit(t);
  assert.deepEqual(await collect(), { ioPlatformUuid: host, bootSessionUuid: boot });
  assert.deepEqual(f.calls.map(call => [call.file, call.args]), [
    ["/usr/sbin/ioreg", ["-r", "-d", "1", "-c", "IOPlatformExpertDevice", "-k", "IOPlatformUUID", "-w", "0"]],
    ["/usr/sbin/sysctl", ["-n", "kern.bootsessionuuid"]],
  ]);
  for (const call of f.calls) {
    assert.deepEqual(call.options.env, { LANG: "C", LC_ALL: "C" });
    assert.equal(call.options.cwd, "/"); assert.equal(call.options.shell, false);
    assert.equal(call.options.encoding, "buffer"); assert.equal(call.options.timeout, 2_000);
    assert.equal(call.options.killSignal, "SIGKILL");
  }
  assert.deepEqual(f.calls.map(call => call.options.maxBuffer), [64 * 1024, 128]);
});

for (const platform of ["linux", "win32", "freebsd"]) {
  test(`non-Darwin ${platform} is unavailable without OS reads or fallback`, async t => {
    const f = unit(t, platform);
    assert.equal(await collect(), undefined); assert.equal(f.calls.length, 0); assert.equal(f.stat.mock.callCount(), 0);
  });
}

for (const fault of ["permission", "nonzero", "timeout", "buffer", "stderr", "malformed", "missing"]) {
  test(`collector sanitizes ${fault} query failure with no partial observation`, async t => {
    const f = unit(t);
    reply(f, (file, done) => {
      if (!file.endsWith("ioreg")) { done(null, bootBytes, Buffer.alloc(0)); return; }
      if (["permission", "nonzero", "timeout", "buffer"].includes(fault)) done(Object.assign(new Error(canary), {
        code: fault === "permission" ? "EACCES" : fault === "buffer" ? "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" : 1,
        stdout: registry(), stderr: Buffer.from(canary), killed: fault === "timeout",
      }), registry(), Buffer.from(canary));
      else done(null, fault === "malformed" ? Buffer.from(canary) : fault === "missing" ? Buffer.alloc(0) : registry(), fault === "stderr" ? Buffer.from(canary) : Buffer.alloc(0));
    });
    assert.equal(await collect(), undefined);
  });
}

for (const fault of ["denied", "owner", "writable", "symlink", "non-executable", "redirected"]) {
  test(`collector refuses ${fault} executable/path trust before running a command`, async t => {
    const f = unit(t);
    if (fault === "redirected") { f.real.mock.mockImplementation(async () => "/untrusted"); }
    else f.stat.mock.mockImplementation(async () => {
      if (fault === "denied") throw new Error(canary);
      return { uid: fault === "owner" ? 501 : 0, mode: fault === "writable" ? 0o777 : fault === "non-executable" ? 0o644 : 0o755,
        isSymbolicLink: () => fault === "symlink", isDirectory: () => true, isFile: () => true } as unknown as Stats;
    });
    syncBuiltinESMExports();
    assert.equal(await collect(), undefined); assert.equal(f.calls.length, 0);
  });
}

for (const mode of ["hang", "overflow"]) {
  test(`actual owned query child is bounded on ${mode}, without exposing diagnostics`, { timeout: 5_000 }, async t => {
    const f = unit(t);
    let child: ChildProcess | undefined;
    let closed: Promise<unknown> | undefined;
    f.query.mock.mockImplementation(((file: string, _args: string[], options: ExecFileOptions, done: Reply) => {
      if (!file.endsWith("ioreg")) { queueMicrotask(() => done(null, bootBytes, Buffer.alloc(0))); return {} as ChildProcess; }
      child = originalExecFile(process.execPath, [fileURLToPath(new URL("./fixtures/darwin-domain-observer.js", import.meta.url)), mode], { ...options, encoding: "buffer" }, done);
      closed = once(child, "close"); return child;
    }) as typeof cp.execFile);
    syncBuiltinESMExports();
    t.after(() => { if (child && child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); });
    assert.equal(await collect(), undefined);
    assert.ok(child); await closed;
    assert.ok(child.exitCode !== null || child.signalCode !== null);
  });
}

if (actualPlatform === "darwin") {
  test("actual Darwin parent and independently collecting owned fixture agree (identifiers redacted)", { timeout: 8_000 }, async t => {
    const parent = await collect();
    assert.ok(Boolean(parent), "Required actual Darwin OS observations unavailable; no weaker fallback is accepted");
    const child = fork(new URL("./fixtures/darwin-domain-observer.js", import.meta.url), ["observe"], {
      stdio: ["ignore", "ignore", "ignore", "ipc"], execArgv: [],
    });
    t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); });
    const message = once(child, "message"); const ended = once(child, "exit");
    const [reply] = await Promise.race([message, ended.then(() => { throw new Error("Owned observation fixture exited without a result"); })]);
    await ended;
    assert.equal(child.exitCode, 0);
    assert.ok(Boolean(reply.observation), "Required owned-fixture Darwin observation unavailable");
    assert.equal(parent!.ioPlatformUuid === reply.observation.ioPlatformUuid, true, "Platform observations differ (values redacted)");
    assert.equal(parent!.bootSessionUuid === reply.observation.bootSessionUuid, true, "Boot observations differ (values redacted)");
    assert.deepEqual(Object.keys(parent!).sort(), ["bootSessionUuid", "ioPlatformUuid"]);
    t.diagnostic("Actual Darwin OS sources available; independent observations agree. No deployment/namespace/exit attestation.");
  });
} else {
  test("actual non-Darwin collector is unavailable; real Darwin acceptance remains outstanding", async t => {
    assert.equal(await collect(), undefined);
    t.diagnostic("Real Darwin OS-source and parent/fixture acceptance NOT RUN on this platform; no supported-host claim.");
  });
}
