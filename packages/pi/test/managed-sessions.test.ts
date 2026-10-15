import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { validatePiSessionFile } from "../src/managed-sessions.js";

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

test("accepting system entries retains managed transcript identity, ancestry, and file protections", async () => {
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
    await fixture.write([fixture.header, { ...fixture.startup, message: { role: "unsupported" } }]);
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
