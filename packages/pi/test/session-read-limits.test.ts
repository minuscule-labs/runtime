import assert from "node:assert/strict";
import { mkdtemp, open, readFile, realpath, rm, writeFile, type FileHandle } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test, { type TestContext } from "node:test";
import { createManagedSessionManifest, validatePiSessionFile, writeManagedSessionManifest } from "../src/managed-sessions.js";
import { PiAgentRuntime } from "../src/client.js";

async function fixture() {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "minu-session-read-limits-")));
  const paths = await Promise.all(Array.from({ length: 12 }, async (_, i) => {
    const path = join(directory, `${i}.jsonl`);
    await writeFile(path, JSON.stringify({ type: "session", version: 3, id: "fixture", timestamp: "2026-11-02T00:00:00.000Z", cwd: directory }) + "\n", { mode: 0o600 });
    return path;
  }));
  return { directory, paths };
}

async function heldReads(t: TestContext, path: string) {
  const probe = await open(path, "r");
  const prototype = Object.getPrototypeOf(probe) as FileHandle;
  await probe.close();
  const original = prototype.read;
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const handles = new Set<number>();
  let calls = 0;
  t.mock.method(prototype, "read", async function (this: FileHandle, ...args: unknown[]) {
    calls++;
    handles.add(this.fd);
    await gate;
    return Reflect.apply(original, this, args);
  });
  return { handles, release, get calls() { return calls; } };
}

async function waitForRead(handles: Set<number>, count = 1) {
  for (let i = 0; i < 100 && handles.size < count; i++) await delay(5);
  assert.ok(handles.size >= count, "fixture validation must reach the held physical reads");
  await delay(30);
}

test("concurrent transcript validation bounds physical reads across sessions", async t => {
  const f = await fixture();
  const held = await heldReads(t, f.paths[0]!);
  const reads = f.paths.map(path => validatePiSessionFile(path, f.directory, "fixture"));
  try {
    await waitForRead(held.handles);
    assert.ok(held.handles.size <= 4, `expected at most four physical readers, saw ${held.handles.size}`);
  } finally {
    held.release();
    await Promise.all(reads);
    await rm(f.directory, { recursive: true, force: true });
  }
});

test("concurrent validation never opens overlapping readers for the same transcript", async t => {
  const f = await fixture();
  const held = await heldReads(t, f.paths[0]!);
  const reads = Array.from({ length: 12 }, () => validatePiSessionFile(f.paths[0]!, f.directory, "fixture"));
  try {
    await waitForRead(held.handles);
    assert.equal(held.handles.size, 1);
  } finally {
    held.release();
    await Promise.all(reads);
    await rm(f.directory, { recursive: true, force: true });
  }
});

test("aborting queued validation removes it before it can open a transcript", async t => {
  const f = await fixture();
  const held = await heldReads(t, f.paths[0]!);
  const first = validatePiSessionFile(f.paths[0]!, f.directory, "fixture");
  const controller = new AbortController();
  try {
    await waitForRead(held.handles);
    const queued = validatePiSessionFile(f.paths[0]!, f.directory, "fixture", { signal: controller.signal });
    const rejected = assert.rejects(queued, { name: "AbortError" });
    controller.abort();
    await rejected;
    assert.equal(held.calls, 1);
  } finally {
    held.release(); await first;
    await rm(f.directory, { recursive: true, force: true });
  }
});

test("cancelled active validation retains its physical slot until the OS read returns", async t => {
  const f = await fixture();
  const held = await heldReads(t, f.paths[0]!);
  const controller = new AbortController();
  const first = validatePiSessionFile(f.paths[0]!, f.directory, "fixture", { signal: controller.signal });
  let next: Promise<void> | undefined;
  try {
    await waitForRead(held.handles);
    const rejected = assert.rejects(first, { name: "AbortError" });
    controller.abort();
    next = validatePiSessionFile(f.paths[0]!, f.directory, "fixture");
    await delay(20);
    assert.equal(held.calls, 1, "Cancellation must not authorize a second overlapping physical reader");
    held.release();
    await rejected;
    await next;
    assert.equal(held.calls, 3, "The abandoned read stops before EOF; the fresh validation reads header and EOF");
  } finally {
    held.release(); await Promise.allSettled([first, next]);
    await rm(f.directory, { recursive: true, force: true });
  }
});

async function managedFixture(t: TestContext) {
  const f = await fixture();
  const previous = process.env.MINU_RUNTIME_DIR;
  process.env.MINU_RUNTIME_DIR = join(f.directory, "sessions");
  t.after(async () => {
    if (previous === undefined) delete process.env.MINU_RUNTIME_DIR;
    else process.env.MINU_RUNTIME_DIR = previous;
    await rm(f.directory, { recursive: true, force: true });
  });
  const manifests = await Promise.all(Array.from({ length: 12 }, async () => {
    const manifest = await createManagedSessionManifest({ cwd: f.directory }, "owner");
    manifest.state = "suspended";
    await writeManagedSessionManifest(manifest);
    return manifest;
  }));
  return { ...f, manifests, runtime: new PiAgentRuntime() };
}

test("inventory cancellation removes queued work and releases bounded physical capacity", async t => {
  const f = await managedFixture(t);
  const held = await heldReads(t, f.manifests[0]!.sessionFile!);
  const controller = new AbortController();
  const first = f.runtime.listManagedSessions("owner", { signal: controller.signal });
  let fresh: ReturnType<PiAgentRuntime["listManagedSessions"]> | undefined;
  try {
    await waitForRead(held.handles, 4);
    assert.equal(held.calls, 4);
    const rejected = assert.rejects(first, { name: "AbortError" });
    controller.abort();
    await rejected;
    fresh = f.runtime.listManagedSessions("owner");
    await delay(20);
    assert.equal(held.calls, 4, "Abandoned OS reads still own all four physical slots");
    held.release();
    assert.ok((await fresh).every(summary => summary.state === "suspended"));
    assert.equal(held.calls, 4 + f.manifests.length * 2, "Cancelled work must not continue parsing or start its queued validations");
  } finally { held.release(); await Promise.allSettled([first, fresh]); }
});

test("exact status remains metadata-only and both read APIs reject pre-aborted requests", async t => {
  const f = await managedFixture(t);
  const target = f.manifests[0]!;
  await writeFile(target.sessionFile!, "PRIVATE_INVALID_TRANSCRIPT");
  const original = await readFile(target.sessionFile!, "utf8");
  const probe = await open(target.sessionFile!, "r");
  const prototype = Object.getPrototypeOf(probe) as FileHandle;
  await probe.close();
  let transcriptReads = 0;
  t.mock.method(prototype, "read", async () => { transcriptReads++; throw new Error("Status must not read a transcript"); });
  const summaries = await Promise.all(Array.from({ length: 36 }, () => f.runtime.getManagedSession(target.managedSessionId, "owner")));
  assert.ok(summaries.every(summary => summary?.state === "suspended"));
  assert.equal(transcriptReads, 0);
  assert.equal(await readFile(target.sessionFile!, "utf8"), original);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(f.runtime.getManagedSession(target.managedSessionId, "owner", { signal: controller.signal }), { name: "AbortError" });
  await assert.rejects(f.runtime.listManagedSessions("owner", { signal: controller.signal }), { name: "AbortError" });
});
