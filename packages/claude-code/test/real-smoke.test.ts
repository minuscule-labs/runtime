// Opt-in only: runs against the user's REAL native Claude Code login and the SDK engine (real model calls).
//   MINU_CLAUDE_REAL_SMOKE=1 pnpm build && MINU_CLAUDE_REAL_SMOKE=1 node --test packages/claude-code/dist/test/real-smoke.test.js
// Skipped otherwise, including in `pnpm test`. Writes only inside a temp directory (own managed root and workspace).
import assert from "node:assert/strict";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ClaudeCodeAgentRuntime } from "../src/index.js";

test("real smoke: Read turn, tiny Edit, stop, resume, destroy against the native login", { skip: process.env.MINU_CLAUDE_REAL_SMOKE !== "1", timeout: 300_000 }, async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "claude-real-smoke-")));
  const cwd = join(root, "workspace"); await (await import("node:fs/promises")).mkdir(cwd);
  const file = join(cwd, "note.txt"); await writeFile(file, "alpha\n");
  const runtime = new ClaudeCodeAgentRuntime({ managedRoot: join(root, "managed"), permissions: "full" }); // Native config root and login.
  let id: string | undefined;
  try {
    assert.ok((await runtime.capabilities({ cwd })).models.length > 0);
    id = (await runtime.startManaged({ cwd }, "smoke-owner")).id;
    await runtime.send(id, "Read note.txt and reply with only its first word.");
    assert.match((await runtime.messages(id)).at(-1)!.content.toLowerCase(), /alpha/);
    await runtime.send(id, "Use the Edit tool to change 'alpha' to 'omega' in note.txt. Do nothing else.");
    assert.equal(await readFile(file, "utf8"), "omega\n");
    await runtime.suspend(id, "smoke-owner");
    await runtime.resume(id, "smoke-owner", { allowStopped: true });
    await runtime.send(id, "Reply with the single word: done");
    await runtime.suspend(id, "smoke-owner");
  } finally {
    if (id) { await runtime.forceStopManaged(id, "smoke-owner").catch(() => {}); await runtime.destroy(id, "smoke-owner").catch(() => {}); }
    await rm(root, { recursive: true, force: true });
  }
});
