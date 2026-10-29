import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { managedSessionAvailability, validatePiSessionFile, type ManagedSessionManifest } from "../src/managed-sessions.js";

const timestamp = "2026-10-14T12:26:24.000Z";
const transcriptId = "system-snapshot-session";

async function transcriptFixture() {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "minu-runtime-transcript-test-")));
  const sessionFile = join(directory, "session.jsonl");
  const header = { type: "session", version: 3, id: transcriptId, timestamp, cwd: directory };
  const startup = {
    type: "message", id: "startup", parentId: null, timestamp,
    message: {
      role: "system", content: "", timestamp: Date.parse(timestamp),
      sections: { preamble: "Private instructions", skills: "Private skill descriptions" },
      toolsAdded: [{ name: "read", description: "Read a file", parameters: { type: "object" } }],
    },
  };
  const update = {
    type: "message", id: "update", parentId: "startup", timestamp,
    message: {
      role: "system", content: "", timestamp: Date.parse(timestamp),
      sections: { skills: null }, toolsRemoved: [{ name: "read" }],
    },
  };
  const write = async (entries: unknown[]) => {
    await writeFile(sessionFile, entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n", { mode: 0o600 });
  };
  return { directory, sessionFile, header, startup, update, write };
}

test("managed transcript validation accepts Pi system snapshots and updates without modifying them", async () => {
  const fixture = await transcriptFixture();
  try {
    await fixture.write([fixture.header, fixture.startup, fixture.update]);
    const original = await readFile(fixture.sessionFile, "utf8");
    await validatePiSessionFile(fixture.sessionFile, fixture.directory, transcriptId);
    assert.equal(await readFile(fixture.sessionFile, "utf8"), original);
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test("durable journal validation retains managed identity, ancestry, and file protections", async () => {
  const fixture = await transcriptFixture();
  const reject = () => assert.rejects(
    validatePiSessionFile(fixture.sessionFile, fixture.directory, transcriptId),
    /Managed Pi transcript/,
  );
  try {
    await fixture.write([{ ...fixture.header, id: "different-session" }, fixture.startup]);
    await reject();
    await fixture.write([fixture.header, fixture.startup, { ...fixture.update, parentId: "missing" }]);
    await reject();
    await fixture.write([fixture.header, fixture.startup, { ...fixture.update, id: "startup" }]);
    await reject();
    await fixture.write([fixture.header, { ...fixture.startup, message: { role: 42 } }]);
    await reject();
    await fixture.write([fixture.header, { ...fixture.startup, message: [] }]);
    await reject();
    await fixture.write([fixture.header, fixture.startup]);
    await writeFile(fixture.sessionFile, (await readFile(fixture.sessionFile, "utf8")) + '{"type":"message",');
    await reject();
    await fixture.write([fixture.header, fixture.startup]);
    if (process.platform !== "win32") {
      await chmod(fixture.sessionFile, 0o644);
      await reject();
      await chmod(fixture.sessionFile, 0o600);
    }
    const redirected = join(fixture.directory, "redirected.jsonl");
    await symlink(fixture.sessionFile, redirected);
    await assert.rejects(validatePiSessionFile(redirected, fixture.directory, transcriptId), /Managed Pi transcript/);
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test("Pi context edits, usage, multiple roots and future entry schemas stay resumable without rewriting history", async () => {
  const fixture = await transcriptFixture();
  try {
    await fixture.write([
      fixture.header, fixture.startup,
      { type: "message", id: "user", parentId: "startup", timestamp, message: { role: "user", content: "fixture request", timestamp: Date.parse(timestamp) } },
      { type: "context_edit", id: "edit", parentId: "user", timestamp, targetId: "user", replacement: null },
      { type: "usage", id: "usage", parentId: "edit", timestamp, kind: "cache_warm", provider: "fixture", model: "fixture", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } },
      { type: "branch_summary", id: "branch", parentId: null, timestamp, fromId: "usage", summary: "A second root is valid Pi history" },
      { type: "future_pi_metadata", id: "future", parentId: "branch", timestamp, payload: { private: true } },
      { type: "message", id: "future-role", parentId: "future", timestamp, message: { role: "future_pi_role", content: [] } },
    ]);
    const original = await readFile(fixture.sessionFile, "utf8");
    await validatePiSessionFile(fixture.sessionFile, fixture.directory, transcriptId);
    assert.equal(await readFile(fixture.sessionFile, "utf8"), original);
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test("unavailable resume material has a bounded reason without private paths or transcript content", async () => {
  const fixture = await transcriptFixture();
  const manifest: ManagedSessionManifest = { version: 2, managedSessionId: "fixture-session", ownerId: "fixture-owner", state: "suspended", cwd: fixture.directory,
    launchConfig: { cwd: fixture.directory }, transcriptId, sessionFile: fixture.sessionFile, createdAt: timestamp, updatedAt: timestamp };
  try {
    await fixture.write([fixture.header, fixture.startup]);
    assert.deepEqual(await managedSessionAvailability(manifest, false), { state: "suspended" });
    await writeFile(fixture.sessionFile, "PRIVATE_MALFORMED_TRANSCRIPT");
    const unavailable = await managedSessionAvailability(manifest, false);
    assert.deepEqual(unavailable, { state: "unavailable", unavailableReason: "session_transcript_invalid" });
    assert.ok(!JSON.stringify(unavailable).includes(fixture.directory));
    assert.ok(!JSON.stringify(unavailable).includes("PRIVATE_MALFORMED_TRANSCRIPT"));
    assert.deepEqual(await managedSessionAvailability({ ...manifest, sessionFile: undefined }, false), { state: "unavailable", unavailableReason: "session_metadata_unavailable" });
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
});
