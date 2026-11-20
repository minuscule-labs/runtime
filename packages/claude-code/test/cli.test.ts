import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { ClaudeCodeManagedStore } from "../src/managed-store.js";
import { nativeHistoryProvider } from "./fixtures/native-history-provider.js";

test("CLI bin symlink executes the entrypoint rather than silently returning", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "claude-cli-bin-"))), link = join(root, "minu-claude-runtime");
  try {
    await symlink(fileURLToPath(new URL("../src/cli.js", import.meta.url)), link);
    await new Promise<void>((resolve, reject) => {
      execFile(process.execPath, [link, "invalid-command"], { env: { HOME: root, PATH: process.env.PATH }, timeout: 5_000 }, (error, stdout, stderr) => {
        try { assert.equal(error?.code, 1); assert.equal(stdout, ""); assert.match(stderr, /"error":"claude_code_command_failed"/); resolve(); }
        catch (error) { reject(error); }
      });
    });
  } finally { await rm(root, { recursive: true, force: true }); }
});

// Real independent CLI processes and production entry; TWO local native requests.
test("CLI processes survive app restart and route stdin-only text through clean stop/resume", { timeout: 120_000 }, async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "claude-cli-"))), native = join(root, "native"), cwd = join(root, "workspace"), state = join(root, "managed");
  await mkdir(native, { mode: 0o700 }); await mkdir(cwd, { mode: 0o700 });
  const path = fileURLToPath(new URL("../src/cli.js", import.meta.url));
  const args = ["--owner", "cli-owner", "--state", state, "--native-root", native, "--executable", "bundled"];
  const provider = await nativeHistoryProvider(2);
  const env = { HOME: root, TMPDIR: root, PATH: process.env.PATH, ANTHROPIC_API_KEY: "PRIVATE_CLI_DUMMY",
    ANTHROPIC_BASE_URL: provider.url, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", NO_PROXY: "127.0.0.1,localhost" };
  const cli = (command: string, extra: string[] = [], input?: string) => new Promise<any>((resolve, reject) => {
    const child = execFile(process.execPath, [path, command, ...args, ...extra], { env, timeout: 30_000, maxBuffer: 128 * 1024 }, (error, stdout, stderr) => {
      assert.doesNotMatch(stderr, /PRIVATE_CLI_DUMMY/);
      if (error) { reject(error); return; } resolve(JSON.parse(stdout));
    });
    assert.ok(!child.spawnargs.join(" ").includes("PRIVATE_CLI_DUMMY"));
    if (input) assert.ok(!child.spawnargs.join(" ").includes(input)); child.stdin!.end(input);
  });
  let id: string | undefined;
  try {
    const session = await cli("create", ["--cwd", cwd]); id = session.id;
    assert.equal(session.runtime, "claude-code"); assert.equal(await cli("status", ["--id", id!]), "idle");
    assert.equal((await cli("get", ["--id", id!])).state, "active");
    assert.equal((await cli("list")).length, 1); assert.equal(provider.calls(), 0);
    const first = await cli("run", ["--id", id!], JSON.stringify({ turnId: "cli-first", input: "literal CLI input" }));
    assert.equal(first.status, "completed"); assert.equal(first.response.content, "history reply 1");
    await cli("stop", ["--id", id!]); assert.equal((await cli("get", ["--id", id!])).state, "suspended");
    await cli("resume", ["--id", id!]); assert.equal(await cli("status", ["--id", id!]), "idle");
    assert.equal(provider.calls(), 1, "resume must not replay input");
    assert.deepEqual((await cli("history", ["--id", id!])).map((m: any) => m.content), ["literal CLI input", "history reply 1"]);
    const second = await cli("run", ["--id", id!], JSON.stringify({ turnId: "cli-second", input: "after CLI restart" }));
    assert.equal(second.response.content, "history reply 2"); assert.equal(provider.calls(), 2);
    await cli("stop", ["--id", id!]);
    const m = await new ClaudeCodeManagedStore(state).read(id!, "cli-owner");
    assert.equal(m?.worker.state, "none"); assert.equal(m?.native.state, "bound");
    assert.doesNotMatch(JSON.stringify(await cli("list")), /PRIVATE_|token|native|workspace|fingerprint/);
  } finally {
    if (id) {
      const m = await new ClaudeCodeManagedStore(state).read(id, "cli-owner");
      if (m?.worker.state === "live") await cli("stop", ["--id", id]);
    }
    await provider.close(); await rm(root, { recursive: true, force: true });
  }
});
