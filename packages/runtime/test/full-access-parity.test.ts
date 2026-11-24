import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os"; import { join } from "node:path"; import { fileURLToPath } from "node:url";
import test from "node:test";
import { createRuntime, type RuntimeAdapterId } from "../src/index.js";

// Fakes only: a fake Pi, the Codex app-server fixture and the Claude Code stream-json fixture. No real engine is ever started.
const codexFixture = fileURLToPath(new URL("../../../codex/dist/test/fixtures/app-server.js", import.meta.url));
const claudeFixture = fileURLToPath(new URL("../../../claude-code/dist/test/fixtures/claude.js", import.meta.url));
type Observed = { access: string; approvals: string };
const read = async (path: string) => (await readFile(path, "utf8")).trim().split("\n").map(line => JSON.parse(line));

/** What each adapter's native engine was asked for by a launch with its "full" access setting. */
const launches: Record<RuntimeAdapterId, (directory: string, cwd: string, full: boolean) => Promise<Observed>> = {
  async codex(directory, cwd, full) {
    const log = join(directory, "codex.jsonl");
    const runtime = createRuntime("codex", { command: process.execPath, args: [codexFixture, "normal", log], requestTimeoutMs: 2_000, shutdownTimeoutMs: 200,
      ...(full ? { sandbox: "danger-full-access" as const } : {}) });
    const session = await runtime.start({ cwd });
    try {
      const params = (await read(log)).find(call => call.method === "thread/start").params;
      return { access: params.sandbox === "danger-full-access" ? "unrestricted" : params.sandbox, approvals: params.approvalPolicy === "never" ? "none" : params.approvalPolicy };
    } finally { await runtime.stop(session.id); }
  },
  async "claude-code"(directory, cwd, full) {
    const argv = join(directory, "claude.jsonl");
    const runtime = createRuntime("claude-code", { executable: claudeFixture, startupTimeoutMs: 5_000, shutdownTimeoutMs: 2_000,
      ...(full ? { permissions: "full" as const } : {}),
      env: { PATH: process.env.PATH!, HOME: directory, CLAUDE_CONFIG_DIR: join(directory, "claude-config"), ANTHROPIC_API_KEY: "dummy-local-only", MINU_CLAUDE_FIXTURE_ARGV: argv } });
    const session = await runtime.start({ cwd });
    try {
      await runtime.send(session.id, "hello");
      const launch = (await read(argv)).find(entry => !entry.probe).argv as string[];
      const flag = (name: string) => launch.find(arg => arg.startsWith(`${name}=`))?.slice(name.length + 1);
      const bypass = flag("--permission-mode") === "bypassPermissions" && launch.includes("--allow-dangerously-skip-permissions");
      return { access: flag("--tools") === "default" ? "unrestricted" : `tools:${flag("--tools")}`, approvals: bypass ? "none" : String(flag("--permission-mode")) };
    } finally { await runtime.stop(session.id); }
  },
  async pi(directory, cwd) {
    // Pi has no restriction knob: full access is passing none. Its only flags are the auto-approve switch and the RPC mode.
    const fake = join(directory, "fake-pi.mjs"), argsFile = join(directory, "pi-args.json");
    await writeFile(fake, `#!/usr/bin/env node
import { writeFileSync } from "node:fs";
writeFileSync(process.env.PI_ARGS_FILE, JSON.stringify(process.argv.slice(2)));
let buffer = "";
process.stdin.on("data", chunk => {
  buffer += chunk.toString();
  while (buffer.includes("\\n")) {
    const index = buffer.indexOf("\\n"), line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
    if (!line) continue;
    const request = JSON.parse(line), respond = data => console.log(JSON.stringify({ id: request.id, type: "response", command: request.type, success: true, data }));
    if (request.type === "get_state") respond({ model: { provider: "openai", id: "gpt-test", input: ["text"] }, thinkingLevel: "medium", sessionId: "fake-session", isStreaming: false });
    else if (request.type === "get_messages") respond({ messages: [] });
    else respond(undefined);
  }
});
process.on("SIGTERM", () => process.exit(0));
`);
    await chmod(fake, 0o755);
    const saved = { dir: process.env.MINU_RUNTIME_DIR, command: process.env.PI_COMMAND, args: process.env.PI_ARGS_FILE };
    Object.assign(process.env, { MINU_RUNTIME_DIR: join(directory, "pi-registry"), PI_COMMAND: fake, PI_ARGS_FILE: argsFile });
    const runtime = createRuntime("pi");
    let id: string | undefined;
    try {
      id = (await runtime.start({ cwd })).id;
      const args = JSON.parse(await readFile(argsFile, "utf8")) as string[];
      assert.deepEqual(args, ["--approve", "--mode", "rpc"], "no tool, sandbox or permission restriction flag is passed");
      return { access: "unrestricted", approvals: args.includes("--approve") ? "none" : "prompt" };
    } finally {
      if (id) await runtime.stop(id);
      for (const [key, value] of [["MINU_RUNTIME_DIR", saved.dir], ["PI_COMMAND", saved.command], ["PI_ARGS_FILE", saved.args]] as const) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      }
    }
  },
};

for (const adapter of ["pi", "codex", "claude-code"] as const) test(`${adapter}: a full-access launch asks the native engine for unrestricted execution without approvals`, async t => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "minu-full-access-parity-"))), cwd = join(directory, "workspace");
  await mkdir(cwd);
  t.after(() => rm(directory, { recursive: true, force: true }));
  assert.deepEqual(await launches[adapter](directory, cwd, true), { access: "unrestricted", approvals: "none" });
});

// Control: the same observation distinguishes a restricted launch, so the table above cannot pass vacuously.
for (const adapter of ["codex", "claude-code"] as const) test(`${adapter}: the default launch is not unrestricted`, async t => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "minu-full-access-parity-"))), cwd = join(directory, "workspace");
  await mkdir(cwd);
  t.after(() => rm(directory, { recursive: true, force: true }));
  assert.notDeepEqual(await launches[adapter](directory, cwd, false), { access: "unrestricted", approvals: "none" });
});
