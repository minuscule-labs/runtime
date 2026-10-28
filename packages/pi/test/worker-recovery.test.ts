import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, writeFile, chmod, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
const { PiAgentRuntime } = await import(process.env.MINU_RECOVERY_RUNTIME_MODULE
  ? pathToFileURL(process.env.MINU_RECOVERY_RUNTIME_MODULE).href : "../src/client.js") as typeof import("../src/client.js");
import { readRegistration } from "../src/registry.js";
import { managedWorkerProcessExists, readManagedSessionManifest, writeManagedSessionManifest } from "../src/managed-sessions.js";
import { processGroupExists, terminateManagedWorker } from "../src/worker-recovery.js";

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "runtime-recovery-"));
  const previous = { command: process.env.PI_COMMAND, registry: process.env.MINU_RUNTIME_DIR };
  const command = join(directory, "fake-pi.mjs");
  await writeFile(command, `#!/usr/bin/env node
import { readFileSync, appendFileSync } from "node:fs";
import { createInterface } from "node:readline";
const file = process.argv[process.argv.indexOf("--session") + 1];
const header = JSON.parse(readFileSync(file, "utf8").split("\\n")[0]);
createInterface({ input: process.stdin }).on("line", line => {
  const r = JSON.parse(line);
  const respond = data => console.log(JSON.stringify({ id: r.id, type: "response", command: r.type, success: true, data }));
  if (r.type === "get_state") respond({ sessionId: header.id, sessionFile: file, isStreaming: false });
  else if (r.type === "prompt") {
    if (r.message === "HANG") return;
    appendFileSync(file, JSON.stringify({ type: "message", id: "entry1", parentId: null, timestamp: new Date().toISOString(), message: { role: "user", content: r.message } }) + "\\n");
    respond(); console.log(JSON.stringify({ type: "agent_settled" }));
  } else if (r.type === "get_messages") respond({ messages: [] });
});
process.stdin.on("end", () => process.exit());
`);
  await chmod(command, 0o700);
  process.env.PI_COMMAND = command;
  process.env.MINU_RUNTIME_DIR = join(directory, "registry");
  const runtime = new PiAgentRuntime();
  const sessions: string[] = [];
  const owner = "recovery-owner";
  return { runtime, owner, directory,
    async start() { const session = await runtime.startManaged({ cwd: directory }, owner); sessions.push(session.id); return session; },
    async close() {
      for (const id of sessions) await runtime.forceStopManaged(id, owner).catch(() => {});
      if (previous.command === undefined) delete process.env.PI_COMMAND; else process.env.PI_COMMAND = previous.command;
      if (previous.registry === undefined) delete process.env.MINU_RUNTIME_DIR; else process.env.MINU_RUNTIME_DIR = previous.registry;
      await rm(directory, { recursive: true, force: true });
    },
  };
}

test("explicit recovery stops busy workers, verifies owner and preserves the same transcript across restart", async () => {
  const f = await fixture();
  try {
    const session = await f.start();
    await f.runtime.send(session.id, "remember this");
    const manifest = (await readManagedSessionManifest(session.id, f.owner))!;
    const transcript = await readFile(manifest.sessionFile!, "utf8");
    const registration = (await readRegistration(session.id))!;
    await assert.rejects(f.runtime.forceStopManaged(session.id, "wrong-owner"), /not available for this owner/);
    const denied = await fetch(`${registration.endpoint}/managed/stop`, { method: "POST", headers: { authorization: `Bearer ${registration.token}` }, body: JSON.stringify({ managedSessionId: session.id, ownerId: "wrong-owner" }) });
    assert.equal(denied.status, 403);
    assert.equal(await f.runtime.status(session.id), "idle");
    await f.runtime.startTurn(session.id, "blocked-turn", "HANG");
    await assert.rejects(f.runtime.suspend(session.id, f.owner), /working/);
    await f.runtime.forceStopManaged(session.id, f.owner);
    assert.equal(managedWorkerProcessExists(registration.pid), false);
    assert.equal(await f.runtime.status(session.id), "offline");
    assert.equal((await f.runtime.listManagedSessions(f.owner))[0]?.state, "suspended");
    assert.equal(await readFile(manifest.sessionFile!, "utf8"), transcript);
    await assert.rejects(new PiAgentRuntime().resume(session.id, f.owner), /manually stopped/);
    const resumed = await Promise.all([f.runtime.resume(session.id, f.owner, { allowStopped: true }), f.runtime.resume(session.id, f.owner, { allowStopped: true })]);
    assert.ok(resumed.every(result => result.id === session.id && result.ownerId === f.owner));
    assert.notEqual((await readRegistration(session.id))!.pid, registration.pid);
    assert.equal(await readFile(manifest.sessionFile!, "utf8"), transcript);
    await f.runtime.forceStopManaged(session.id, f.owner);
    await f.runtime.forceStopManaged(session.id, f.owner);
    await writeFile(manifest.sessionFile!, "corrupt transcript");
    await f.runtime.forceStopManaged(session.id, f.owner);
    await assert.rejects(f.runtime.resume(session.id, f.owner, { allowStopped: true }), /transcript/);
    await assert.rejects(f.runtime.resume(session.id, f.owner), /manually stopped/);
  } finally { await f.close(); }
});

test("an unresponsive bridge is stopped through its isolated verified process group without affecting other sessions", { skip: process.platform === "win32", timeout: 40_000 }, async () => {
  const f = await fixture();
  try {
    const stuck = await f.start(), other = await f.start();
    const registration = (await readRegistration(stuck.id))!;
    process.kill(registration.pid, "SIGSTOP");
    await f.runtime.forceStopManaged(stuck.id, f.owner);
    assert.equal(processGroupExists(registration.pid), false);
    assert.equal(await f.runtime.status(other.id), "idle");
    await f.runtime.resume(stuck.id, f.owner, { allowStopped: true });
    assert.notEqual((await readRegistration(stuck.id))!.pid, registration.pid);
  } finally { await f.close(); }
});

test("legacy workers can be stopped without ever signalling their shared process group", { skip: process.platform === "win32" }, async () => {
  const f = await fixture();
  try {
    const session = await f.start();
    const manifest = (await readManagedSessionManifest(session.id, f.owner))!;
    // Simulate a worker created before isolated process groups were recorded.
    delete manifest.workerProcessGroup;
    await writeManagedSessionManifest(manifest);
    const { terminateManagedWorker } = await import("../src/worker-recovery.js");
    const workerPath = process.env.MINU_RECOVERY_RUNTIME_MODULE
      ? join(process.env.MINU_RECOVERY_RUNTIME_MODULE, "..", "owned-worker.js")
      : fileURLToPath(new URL("../src/owned-worker.js", import.meta.url));
    await terminateManagedWorker(manifest, await realpath(workerPath));
    assert.equal(managedWorkerProcessExists(manifest.workerPid!), false);
    manifest.state = "suspended";
    await writeManagedSessionManifest(manifest);
    await f.runtime.forceStopManaged(session.id, f.owner);
    assert.equal((await f.runtime.listManagedSessions(f.owner))[0]?.state, "suspended");
  } finally { await f.close(); }
});

test("a dead legacy bridge without process-group evidence cannot authorize a new writer", async () => {
  const f = await fixture();
  try {
    const session = await f.start();
    const manifest = (await readManagedSessionManifest(session.id, f.owner))!;
    await f.runtime.forceStopManaged(session.id, f.owner);
    delete manifest.workerProcessGroup;
    manifest.state = "active";
    await writeManagedSessionManifest(manifest);
    await assert.rejects(f.runtime.forceStopManaged(session.id, f.owner), /descendants cannot be verified/);
    await assert.rejects(f.runtime.resume(session.id, f.owner), /manually stopped/);
  } finally { await f.close(); }
});

test("worker identity matching rejects owner prefixes and duplicate identity flags in arguments", { skip: process.platform === "win32" }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "runtime-recovery-identity-"));
  const worker = join(directory, "owned-worker.mjs");
  await writeFile(worker, "setInterval(() => {}, 1000);");
  try {
    for (const spoof of [false, true]) {
      const cwd = spoof ? `${directory}/--runtime-session-id target --runtime-owner-id owner` : directory;
      const child = spawn(process.execPath, [worker, "--cwd", cwd, "--runtime-session-id", "target", "--runtime-owner-id", "owner-other", "--isolated-process-group"], { detached: true, stdio: "ignore" });
      try {
        const manifest = { managedSessionId: "target", ownerId: "owner", workerPid: child.pid!, workerProcessGroup: child.pid! };
        await assert.rejects(terminateManagedWorker(manifest as never, worker), /identity/);
        assert.equal(managedWorkerProcessExists(child.pid!), true);
      } finally {
        const exited = new Promise<void>(resolve => child.once("exit", () => resolve()));
        child.kill("SIGKILL"); await exited;
      }
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("recovery refuses a stale/reused PID belonging to an unrelated process group", { skip: process.platform === "win32" }, async () => {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { detached: true, stdio: "ignore" });
  try {
    const manifest = { managedSessionId: "target-session", ownerId: "target-owner", workerPid: child.pid!, workerProcessGroup: child.pid! };
    await assert.rejects(terminateManagedWorker(manifest as never, "/owned-worker.js"), /identity/);
    assert.equal(managedWorkerProcessExists(child.pid!), true);
  } finally {
    const exited = new Promise<void>(resolve => child.once("exit", () => resolve()));
    child.kill("SIGKILL"); await exited;
  }
});
