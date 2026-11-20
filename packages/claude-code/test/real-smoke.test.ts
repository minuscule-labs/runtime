// Opt-in only: runs against the user's REAL native Claude Code login and the SDK engine (real model calls).
//   MINU_CLAUDE_REAL_SMOKE=1 pnpm build && MINU_CLAUDE_REAL_SMOKE=1 node --test packages/claude-code/dist/test/real-smoke.test.js
// Skipped otherwise, including in `pnpm test`. Writes only inside a temp directory (own managed root and workspace).
import assert from "node:assert/strict";
import { deflateSync } from "node:zlib";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ClaudeCodeAgentRuntime } from "../src/index.js";

/** A solid-red 64x64 PNG, built locally (no files, no network). */
function redPng(): string {
  const table = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (bytes: Buffer) => { let r = 0xffffffff; for (const x of bytes) r = table[(r ^ x) & 255] ^ (r >>> 8); return (r ^ 0xffffffff) >>> 0; };
  const chunk = (type: string, data: Buffer) => { const length = Buffer.alloc(4); length.writeUInt32BE(data.length); const body = Buffer.concat([Buffer.from(type), data]);
    const sum = Buffer.alloc(4); sum.writeUInt32BE(crc(body)); return Buffer.concat([length, body, sum]); };
  const size = 64, row = size * 3 + 1, raw = Buffer.alloc(row * size);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) { const o = y * row + 1 + x * 3; raw[o] = 220; raw[o + 1] = 20; raw[o + 2] = 20; }
  const header = Buffer.alloc(13); header.writeUInt32BE(size, 0); header.writeUInt32BE(size, 4); header[8] = 8; header[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]).toString("base64");
}

test("real smoke: Read turn, tiny Edit, image turn, stop, resume, destroy against the native login", { skip: process.env.MINU_CLAUDE_REAL_SMOKE !== "1", timeout: 300_000 }, async () => {
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
    assert.equal((await runtime.inputCapabilities(id)).images, true);
    await runtime.send(id, "What is the dominant color of this image? Answer with one word.", [{ type: "image", mimeType: "image/png", data: redPng() }]);
    assert.match((await runtime.messages(id)).at(-1)!.content.toLowerCase(), /red/);
    await runtime.suspend(id, "smoke-owner");
    await runtime.resume(id, "smoke-owner", { allowStopped: true });
    await runtime.send(id, "Reply with the single word: done");
    await runtime.suspend(id, "smoke-owner");
  } finally {
    if (id) { await runtime.forceStopManaged(id, "smoke-owner").catch(() => {}); await runtime.destroy(id, "smoke-owner").catch(() => {}); }
    await rm(root, { recursive: true, force: true });
  }
});
