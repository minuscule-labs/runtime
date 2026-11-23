// Opt-in only: runs against the user's REAL Codex login (real model calls) with full access. Never runs in CI or `pnpm test`.
//   MINU_CODEX_REAL_SMOKE=1 pnpm build && MINU_CODEX_REAL_SMOKE=1 node --test packages/codex/dist/test/real-smoke.test.js
// Skipped otherwise. Writes only inside two temp directories (the workspace and a second, sibling directory outside it).
// Assertions are on files and discovery, not on skills/hooks: the session starts with no skills selected, and nothing here
// depends on what the user's Codex configuration adds around a turn.
import assert from "node:assert/strict";
import { deflateSync } from "node:zlib";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { CodexAgentRuntime } from "../src/index.js";

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

test("real smoke: discovery, full-access start, read, edit, write outside cwd, image, suspend/resume", { skip: process.env.MINU_CODEX_REAL_SMOKE !== "1", timeout: 600_000 }, async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "codex-real-smoke-")));
  const cwd = join(root, "workspace"), outside = join(root, "outside");
  await mkdir(cwd); await mkdir(outside);
  const file = join(cwd, "note.txt"); await writeFile(file, "alpha\n");
  const target = join(outside, "written.txt");
  const runtime = new CodexAgentRuntime({ managedRoot: join(root, "managed"), sandbox: "danger-full-access" });
  let id: string | undefined;
  try {
    const capabilities = await runtime.capabilities({ cwd });
    assert.ok(capabilities.models.length > 0);
    assert.ok(capabilities.defaultModel);
    id = (await runtime.startManaged({ cwd, skillIds: [] }, "smoke-owner")).id;
    await runtime.send(id, "Read note.txt and reply with only its first word.");
    assert.match((await runtime.messages(id)).at(-1)!.content.toLowerCase(), /alpha/);
    await runtime.send(id, "Change 'alpha' to 'omega' in note.txt using your file editing ability. Do nothing else.");
    assert.equal(await readFile(file, "utf8"), "omega\n");
    // Full access: a path outside the workspace, which a workspace-write sandbox would refuse.
    await runtime.send(id, `Create the file ${target} containing exactly the text: outside. Do nothing else.`);
    assert.equal((await readFile(target, "utf8")).trim(), "outside");
    assert.equal((await runtime.inputCapabilities(id)).images, true);
    await runtime.send(id, "What is the dominant color of this image? Answer with one word.", [{ type: "image", mimeType: "image/png", data: redPng() }]);
    assert.match((await runtime.messages(id)).at(-1)!.content.toLowerCase(), /red/);
    await runtime.suspend(id, "smoke-owner");
    await runtime.resume(id, "smoke-owner", { allowStopped: true });
    await runtime.send(id, "Reply with the single word: done");
    assert.match((await runtime.messages(id)).at(-1)!.content.toLowerCase(), /done/);
    await runtime.suspend(id, "smoke-owner");
  } finally {
    if (id) { await runtime.forceStopManaged(id, "smoke-owner").catch(() => {}); await runtime.destroy(id, "smoke-owner").catch(() => {}); }
    await rm(root, { recursive: true, force: true });
  }
});
