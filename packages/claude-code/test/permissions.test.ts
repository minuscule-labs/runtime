import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test, type TestContext } from "node:test";
import { ClaudeCodeAgentRuntime } from "../src/index.js";
import { ClaudeCodeManagedRuntime } from "../src/managed-runtime.js";
import { ClaudeCodeManagedStore, claudeCodeEffectivePermissions } from "../src/managed-store.js";
import { CLAUDE_CODE_INTERACTIVE_TOOLS, claudeCodePermissionOptions, resolveClaudeCodePermissions } from "../src/permissions.js";

const fixture = fileURLToPath(new URL("./fixtures/claude.js", import.meta.url));

test("permission presets resolve to the documented policies and reject invalid input", () => {
  assert.deepEqual(resolveClaudeCodePermissions(), { permissions: "readOnly", permissionMode: "default", tools: ["Read", "Grep", "Glob"] });
  assert.deepEqual(resolveClaudeCodePermissions("edits"), { permissions: "edits", permissionMode: "acceptEdits", tools: null });
  assert.deepEqual(resolveClaudeCodePermissions("full"), { permissions: "full", permissionMode: "bypassPermissions", tools: null });
  assert.deepEqual(resolveClaudeCodePermissions({ mode: "default", allowedTools: ["Read"], disallowedTools: ["Bash"] }),
    { permissions: "custom", permissionMode: "default", tools: null, allowedTools: ["Read"], disallowedTools: ["Bash"] });
  for (const bad of ["root", { mode: "plan" }, { mode: "default", extra: 1 }, { mode: "default", allowedTools: ["a", "a"] }, { mode: "default", disallowedTools: [""] }, null, []]) {
    assert.throws(() => resolveClaudeCodePermissions(bad as never), /Invalid Claude Code/);
  }
});

test("query options: full skips permission prompts with every tool; interactive tools are always disallowed", () => {
  const full = claudeCodePermissionOptions(resolveClaudeCodePermissions("full"));
  assert.equal(full.permissionMode, "bypassPermissions"); assert.equal(full.allowDangerouslySkipPermissions, true);
  assert.deepEqual(full.tools, { type: "preset", preset: "claude_code" });
  const edits = claudeCodePermissionOptions(resolveClaudeCodePermissions("edits"));
  assert.equal(edits.permissionMode, "acceptEdits"); assert.equal(edits.allowDangerouslySkipPermissions, false);
  const readOnly = claudeCodePermissionOptions(resolveClaudeCodePermissions("readOnly"));
  assert.deepEqual(readOnly.tools, ["Read", "Grep", "Glob"]); assert.equal(readOnly.allowDangerouslySkipPermissions, false);
  const custom = claudeCodePermissionOptions(resolveClaudeCodePermissions({ mode: "default", disallowedTools: ["Bash"], allowedTools: ["Read"] }));
  assert.deepEqual(custom.allowedTools, ["Read"]);
  for (const options of [full, edits, readOnly, custom]) for (const tool of CLAUDE_CODE_INTERACTIVE_TOOLS) assert.ok(options.disallowedTools!.includes(tool));
  assert.ok(custom.disallowedTools!.includes("Bash"));
});

async function native(t: TestContext) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "claude-permissions-")));
  const cwd = join(root, "workspace"), config = join(root, "native"); await mkdir(cwd, { mode: 0o700 }); await mkdir(config, { mode: 0o700 });
  const argv = join(root, "argv");
  const env = { PATH: process.env.PATH!, HOME: root, CLAUDE_CONFIG_DIR: config, ANTHROPIC_API_KEY: "dummy-local-only",
    MINU_CLAUDE_FIXTURE_ARGV: argv, MINU_CLAUDE_FIXTURE_PID: join(root, "pid") };
  t.after(() => rm(root, { recursive: true, force: true }));
  const flag = (argv: string[], name: string) => argv.find(arg => arg.startsWith(`${name}=`))?.slice(name.length + 1);
  const launches = async () => (await readFile(argv, "utf8")).trim().split("\n").map(line => JSON.parse(line) as { probe: boolean; argv: string[] })
    .filter(entry => !entry.probe);
  return { root, cwd, config, env, launches, flag };
}

for (const [name, mode] of [["readOnly", "default"], ["edits", "acceptEdits"], ["full", "bypassPermissions"]] as const) {
  test(`in-process "${name}" launches the engine with its permission mode and never offers interactive tools`, async t => {
    const f = await native(t);
    const runtime = new ClaudeCodeAgentRuntime({ executable: fixture, permissions: name, env: f.env, startupTimeoutMs: 5_000 });
    const session = await runtime.start({ cwd: f.cwd }); t.after(() => runtime.stop(session.id));
    await runtime.send(session.id, "hello");
    const [launch] = await f.launches(), joined = launch.argv.join(" ");
    assert.equal(f.flag(launch.argv, "--permission-mode"), mode);
    void joined;
    assert.equal(launch.argv.includes("--allow-dangerously-skip-permissions"), name === "full");
    assert.equal(f.flag(launch.argv, "--tools"), name === "readOnly" ? "Read,Grep,Glob" : "default");
    assert.equal(f.flag(launch.argv, "--disallowedTools"), "AskUserQuestion,ExitPlanMode,EnterPlanMode");
  });
}

test("managed: the policy is stored in a v5 manifest, resume keeps it, and old manifests read as readOnly", async t => {
  const f = await native(t), state = join(f.root, "managed"), store = new ClaudeCodeManagedStore(state);
  const options = { ownerId: "owner", storeRoot: state, nativeConfigRoot: f.config, timeoutMs: 4_000,
    workerExecutable: fileURLToPath(new URL("./fixtures/worker-entry.js", import.meta.url)),
    nativeOptions: { executable: fileURLToPath(new URL("./fixtures/persistent-native.js", import.meta.url)), startupTimeoutMs: 2_000, shutdownTimeoutMs: 1_000, controlTimeoutMs: 1_000, env: f.env } };
  const full = new ClaudeCodeManagedRuntime({ ...options, permissions: "full" });
  const session = await full.startManaged({ cwd: f.cwd }, "owner");
  const stored = (await store.read(session.id, "owner"))!;
  assert.equal(stored.version, 5); assert.equal(stored.policy.permissions, "full"); assert.equal(stored.policy.permissionMode, "bypassPermissions");
  assert.equal(stored.policy.configuration, "native"); assert.equal(stored.policy.tools, null);
  await full.send(session.id, "first"); await full.stop(session.id);
  // A controller configured differently still resumes with the STORED policy (changing it needs a new session).
  const other = new ClaudeCodeManagedRuntime({ ...options, permissions: "readOnly" });
  await other.resume(session.id, "owner", { allowStopped: true });
  const launches = await f.launches();
  assert.equal(launches.length, 2);
  for (const launch of launches) assert.equal(f.flag(launch.argv, "--permission-mode"), "bypassPermissions");
  assert.equal((await store.read(session.id, "owner"))!.policy.permissions, "full");
  await other.send(session.id, "second"); await other.stop(session.id);
  assert.equal(claudeCodeEffectivePermissions(stored), "full");
  assert.equal(claudeCodeEffectivePermissions({ ...stored, version: 4, policy: { configuration: "isolated", permissionMode: "default", tools: ["Read"], nativeConfigRoot: f.config } }), "readOnly");
  await other.destroy(session.id, "owner");
});

test("managed: isolateConfiguration restores isolated config; defaults stay readOnly and native", async t => {
  const f = await native(t), state = join(f.root, "managed"), store = new ClaudeCodeManagedStore(state);
  const options = { ownerId: "owner", storeRoot: state, nativeConfigRoot: f.config, timeoutMs: 4_000,
    workerExecutable: fileURLToPath(new URL("./fixtures/worker-entry.js", import.meta.url)),
    nativeOptions: { executable: fileURLToPath(new URL("./fixtures/persistent-native.js", import.meta.url)), startupTimeoutMs: 2_000, shutdownTimeoutMs: 1_000, controlTimeoutMs: 1_000, env: f.env } };
  const plain = new ClaudeCodeManagedRuntime(options), isolated = new ClaudeCodeManagedRuntime({ ...options, isolateConfiguration: true });
  const one = await plain.startManaged({ cwd: f.cwd }, "owner"), two = await isolated.startManaged({ cwd: f.cwd }, "owner");
  assert.equal((await store.read(one.id, "owner"))!.policy.permissions, "readOnly");
  assert.equal((await store.read(one.id, "owner"))!.policy.configuration, "native");
  assert.equal((await store.read(two.id, "owner"))!.policy.configuration, "isolated");
  await plain.send(one.id, "a"); await isolated.send(two.id, "b");
  const [inherited, iso] = await f.launches();
  assert.equal(f.flag(inherited.argv, "--setting-sources"), "user,project,local");
  assert.equal(f.flag(iso.argv, "--setting-sources"), "");
  await plain.stop(one.id); await isolated.stop(two.id);
  await plain.destroy(one.id, "owner"); await isolated.destroy(two.id, "owner");
  assert.throws(() => new ClaudeCodeManagedRuntime({ ...options, permissions: { mode: "plan" } as never }));
});
