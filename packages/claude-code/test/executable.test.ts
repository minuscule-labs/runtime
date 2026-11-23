import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { ClaudeCodeAgentRuntime } from "../src/index.js";
import { resolveClaudeCodeExecutable } from "../src/native-config.js";
import { probeClaudeCode } from "../src/probe.js";

const fixture = fileURLToPath(new URL("./fixtures/claude.js", import.meta.url));

test("the installed `claude` on PATH is the default executable; bundled and explicit paths are opt-in", async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "claude-exec-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bin = join(root, "bin"), other = join(root, "other"); await mkdir(bin); await mkdir(other);
  // A fake installed `claude`: an executable that hands over to the stream-json test peer.
  await writeFile(join(bin, "claude"), `#!/bin/sh\nexec "${process.execPath}" "${fixture}" "$@"\n`); await chmod(join(bin, "claude"), 0o755);
  await writeFile(join(other, "claude"), "not executable"); await chmod(join(other, "claude"), 0o644);
  assert.equal(await resolveClaudeCodeExecutable(undefined, { PATH: [other, bin].join(delimiter) }), join(bin, "claude"), "first EXECUTABLE regular file on PATH");
  assert.equal(await resolveClaudeCodeExecutable("bundled", { PATH: bin }), undefined);
  assert.equal(await resolveClaudeCodeExecutable("/explicit/path", { PATH: bin }), "/explicit/path");
  for (const PATH of [other, "", "relative/dir", undefined]) {
    await assert.rejects(resolveClaudeCodeExecutable(undefined, { PATH }), { name: "ClaudeCodeNotInstalledError", message: "Claude Code is not installed; install `claude`" });
  }
  // End to end: no executable option, the shim on PATH is what runs.
  const runtime = new ClaudeCodeAgentRuntime({ startupTimeoutMs: 5_000, env: { PATH: bin, HOME: root, CLAUDE_CONFIG_DIR: join(root, "config"), MINU_CLAUDE_FIXTURE_PID: join(root, "pid") } });
  const session = await runtime.start({ cwd: root });
  await runtime.send(session.id, "through the installed claude");
  assert.equal((await runtime.messages(session.id)).at(-1)?.content, "reply: through the installed claude");
  await runtime.stop(session.id);
  // A missing install is a clear error, never a silent fallback to the bundled engine.
  const missing = new ClaudeCodeAgentRuntime({ env: { PATH: other, HOME: root } });
  await assert.rejects(missing.start({ cwd: root }), { name: "ClaudeCodeNotInstalledError" });
  await assert.rejects(missing.capabilities({ cwd: root }), { name: "ClaudeCodeNotInstalledError" });
  // An explicit path that does not exist is the same named error, without echoing the path.
  const gone = join(root, "no-such-claude");
  const explicit = new ClaudeCodeAgentRuntime({ executable: gone, startupTimeoutMs: 5_000, env: { PATH: bin, HOME: root } });
  const error = await explicit.capabilities({ cwd: root }).then(() => undefined, caught => caught);
  assert.equal(error?.name, "ClaudeCodeNotInstalledError"); assert.equal(error.message.includes(root), false);
  // A missing workspace reports the same native ENOENT, but is not a missing install.
  const lost = await probeClaudeCode({ cwd: join(root, "no-such-workspace"), executable: join(bin, "claude"), env: { PATH: bin, HOME: root }, startupTimeoutMs: 5_000 })
    .then(() => undefined, caught => caught);
  assert.ok(lost instanceof Error); assert.notEqual(lost.name, "ClaudeCodeNotInstalledError");
});
