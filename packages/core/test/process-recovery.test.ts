import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { bootChanged, processGroupAbsent, readBootIdentity, terminateVerifiedGroup } from "../src/process-recovery.js";

const SESSION = "11111111-1111-4111-8111-111111111111", OWNER = "owner-1";
// Leader spawns a same-group grandchild; the entry path and markers sit in argv.
const script = `const { spawn } = require("node:child_process");
const c = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore" });
process.stdout.write(c.pid + "\\n"); setInterval(() => {}, 1000);`;
const markers = (generation: string | number) => ["--minu-runtime-session", SESSION, "--minu-runtime-owner", OWNER, "--minu-runtime-generation", String(generation)];

async function group(generation: string | number = 1, entry = "/virtual/entry.js") {
  // `node -e script <entry> markers...`: argv carries the entry path and markers.
  const child = spawn(process.execPath, ["-e", script, entry, ...markers(generation)], { detached: true, stdio: ["ignore", "pipe", "ignore"] });
  const grandchild = Number(await new Promise<string>((resolve) => child.stdout.once("data", (d) => resolve(String(d).trim()))));
  const pgid = child.pid!;
  const reaped = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  const cleanup = async () => { try { process.kill(-pgid, "SIGKILL"); } catch { /* gone */ } await reaped; };
  return { pgid, grandchild, cleanup, reaped };
}
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === "EPERM"; } };

test("terminates a verified group including descendants", async () => {
  const g = await group();
  try {
    assert.equal(processGroupAbsent(g.pgid), "present");
    await terminateVerifiedGroup({ pgid: g.pgid, entryPath: "/virtual/entry.js", markers: { session: SESSION, owner: OWNER, generation: "1" }, termMs: 3_000, killMs: 3_000 });
    await g.reaped;
    assert.equal(processGroupAbsent(g.pgid), "absent");
    assert.equal(alive(g.grandchild), false);
  } finally { await g.cleanup(); }
});

test("marker or entry mismatch refuses without signalling", async () => {
  const g = await group(2);
  try {
    const base = { pgid: g.pgid, termMs: 200, killMs: 200 };
    const ok = { session: SESSION, owner: OWNER, generation: "2" };
    for (const options of [
      { entryPath: "/virtual/entry.js", markers: { ...ok, generation: "3" } },
      { entryPath: "/virtual/entry.js", markers: { ...ok, owner: "owner-2" } },
      { entryPath: "/virtual/entry.js", markers: { ...ok, session: "other" } },
      { entryPath: "/virtual/other.js", markers: ok },
    ]) {
      await assert.rejects(terminateVerifiedGroup({ ...base, ...options }), /no process was signalled/);
    }
    assert.equal(processGroupAbsent(g.pgid), "present");
    assert.equal(alive(g.grandchild), true);
  } finally { await g.cleanup(); }
});

test("a prefix of an identity value is not a match", async () => {
  const g = await group(12);
  try {
    await assert.rejects(terminateVerifiedGroup({ pgid: g.pgid, entryPath: "/virtual/entry.js", markers: { session: SESSION, owner: OWNER, generation: "1" }, termMs: 100, killMs: 100 }), /no process was signalled/);
    assert.equal(processGroupAbsent(g.pgid), "present");
  } finally { await g.cleanup(); }
});

test("pgid reported by ps must equal the recorded group", async () => {
  const signals: unknown[] = [];
  await assert.rejects(terminateVerifiedGroup({
    pgid: 4242, entryPath: "/e.js", markers: { session: SESSION, owner: OWNER, generation: "1" }, termMs: 10, killMs: 10,
    kill: (pid, signal) => { signals.push([pid, signal]); },
    readProcess: async () => `4243 node /e.js ${markers(1).join(" ")}`,
  }), /no process was signalled/);
  assert.deepEqual(signals, [[-4242, 0]]); // only the existence probe
});

test("EPERM is unproven and unknown errors fail closed", async () => {
  const failing = (code: string) => () => { throw Object.assign(new Error(code), { code }); };
  assert.equal(processGroupAbsent(4242, failing("ESRCH")), "absent");
  assert.equal(processGroupAbsent(4242, failing("EPERM")), "unproven");
  assert.throws(() => processGroupAbsent(4242, failing("EIO")), /EIO/);
  assert.throws(() => processGroupAbsent(1), /Invalid/);
  await assert.rejects(terminateVerifiedGroup({ pgid: 4242, entryPath: "/e.js", markers: { session: SESSION, owner: OWNER, generation: "1" }, termMs: 10, killMs: 10, kill: failing("EPERM") }), /no process was signalled/);
  await assert.rejects(terminateVerifiedGroup({ pgid: 4242, entryPath: "/e.js", markers: { session: SESSION, owner: OWNER, generation: "1" }, termMs: 10, killMs: 10, kill: failing("EIO") }), /EIO/);
});

test("a group that survives SIGKILL is reported, never assumed gone", async () => {
  const sent: [number, unknown][] = [];
  await assert.rejects(terminateVerifiedGroup({
    pgid: 4242, entryPath: "/e.js", markers: { session: SESSION, owner: OWNER, generation: "1" }, termMs: 30, killMs: 30,
    kill: (pid, signal) => { sent.push([pid, signal]); },
    readProcess: async () => `4242 node /e.js ${markers(1).join(" ")}`,
  }), /did not exit/);
  assert.deepEqual(sent.filter(([, s]) => s !== 0), [[-4242, "SIGTERM"], [-4242, "SIGKILL"]]);
});

test("boot identity: a changed boot proves absence, unknown proves nothing", async () => {
  assert.equal(await bootChanged("darwin:a", async () => "darwin:b"), true);
  assert.equal(await bootChanged("darwin:a", async () => "darwin:a"), false);
  assert.equal(await bootChanged("darwin:a", async () => undefined), false);
  assert.equal(await bootChanged(undefined, async () => "darwin:b"), false);
  const current = await readBootIdentity();
  if (process.platform === "darwin" || process.platform === "linux") assert.match(current ?? "", /^(darwin|linux):[0-9a-f-]{32,36}$/);
  await delay(0);
});
