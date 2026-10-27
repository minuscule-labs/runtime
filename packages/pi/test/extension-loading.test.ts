import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test, { type TestContext } from "node:test";
import { PiAgentRuntime, type PiAgentRuntimeOptions } from "../src/index.js";
import { listRegistrations } from "../src/registry.js";

function environment(t: TestContext, values: Record<string, string>): void {
  const original = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
  Object.assign(process.env, values);
  t.after(() => {
    for (const [key, value] of Object.entries(original)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
}

interface Launch {
  args: string[];
  credentialPresent: boolean;
}

async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "minu-runtime-extensions-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const command = join(directory, "pi.mjs");
  const launchesFile = join(directory, "launches.jsonl");
  await writeFile(command, `#!/usr/bin/env node
import { appendFileSync } from "node:fs";
const args = process.argv.slice(2);
appendFileSync(process.env.EXTENSION_TEST_LAUNCHES, JSON.stringify({
  args, credentialPresent: process.env.EXTENSION_TEST_CREDENTIAL === "fixture-only",
}) + "\\n");
if (process.env.EXTENSION_TEST_FAILURE === "exit") {
  console.error("Failed to load extension: fixture syntax error");
  process.exit(1);
}
if (process.env.EXTENSION_TEST_FAILURE === "hook") {
  console.log(JSON.stringify({ type: "extension_error", event: "session_start", error: "private fixture error" }));
}
const sessionIndex = args.indexOf("--session");
const sessionFile = sessionIndex < 0 ? undefined : args[sessionIndex + 1];
const commands = args.includes("--no-skills") && !args.includes("--skill") ? []
  : [{ name: "skill:reviewer", description: "Review changes", source: "skill", sourceInfo: { path: "/skills/reviewer/SKILL.md" } }];
let buffer = "";
process.stdin.on("data", (chunk) => {
  buffer += chunk.toString();
  while (buffer.includes("\\n")) {
    const index = buffer.indexOf("\\n");
    const line = buffer.slice(0, index);
    buffer = buffer.slice(index + 1);
    if (!line) continue;
    const request = JSON.parse(line);
    let data;
    if (request.type === "get_available_models") data = { models: [{ provider: "fixture", id: "model" }] };
    else if (request.type === "get_state") data = { sessionId: "native-" + process.pid, sessionFile, isStreaming: false };
    else if (request.type === "get_commands") data = { commands };
    else if (request.type === "get_messages") data = { messages: [] };
    console.log(JSON.stringify({ id: request.id, type: "response", command: request.type, success: true, data }));
  }
});
process.on("SIGTERM", () => process.exit(0));
`, { mode: 0o700 });
  await chmod(command, 0o700);
  environment(t, {
    MINU_RUNTIME_DIR: join(directory, "registry"),
    PI_COMMAND: command,
    EXTENSION_TEST_LAUNCHES: launchesFile,
    EXTENSION_TEST_CREDENTIAL: "fixture-only",
    EXTENSION_TEST_FAILURE: "",
  });
  const launches = async (): Promise<Launch[]> => (await readFile(launchesFile, "utf8"))
    .trim().split("\n").map((line) => JSON.parse(line) as Launch);
  return { directory, launches };
}

async function realFixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "minu-runtime-real-extensions-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const agentDirectory = join(directory, "agent");
  const observationsFile = join(directory, "observations.jsonl");
  for (const root of [agentDirectory, join(directory, ".pi")]) {
    await mkdir(join(root, "extensions"), { recursive: true });
    await writeFile(join(root, "extensions", "unselected.ts"), 'export default () => { throw new Error("unselected extension loaded"); };\n');
  }
  await writeFile(join(agentDirectory, "settings.json"), JSON.stringify({
    defaultProvider: "anthropic", defaultModel: "claude-sonnet-4-5", defaultThinkingLevel: "off",
  }));
  environment(t, {
    PI_COMMAND: fileURLToPath(new URL("./cli.js", import.meta.resolve("@earendil-works/pi-coding-agent"))),
    PI_CODING_AGENT_DIR: agentDirectory,
    // Pi also discovers ~/.agents/skills independently of its agent directory.
    HOME: directory,
    PI_OFFLINE: "1",
    ANTHROPIC_API_KEY: "fixture-not-a-real-key",
    MINU_RUNTIME_DIR: join(directory, "registry"),
    EXTENSION_TEST_CREDENTIAL: "fixture-only",
    EXTENSION_TEST_OBSERVATIONS: observationsFile,
    EXTENSION_TEST_FAILURE: "",
  });
  return { directory, agentDirectory, observationsFile };
}

function extensions(args: string[]): string[] {
  assert.ok(args.includes("--no-extensions"), "automatic discovery must remain disabled");
  return args.flatMap((value, index) => value === "--extension" ? [args[index + 1]!] : []);
}

test("Pi adapter validates and copies its explicit extension configuration", () => {
  const invalid: unknown[] = [null, "extension.ts", [null], new Array(1), [""], [" "], [" extension.ts"], ["extension\0.ts"],
    ["x".repeat(4_097)], Array.from({ length: 101 }, (_, index) => `${index}.ts`),
    ["extension.ts", "./extension.ts"], ["builtin:codemode", "builtin:codemode"]];
  for (const extensionPaths of invalid) {
    assert.throws(() => new PiAgentRuntime({ extensionPaths } as PiAgentRuntimeOptions), /extensionPaths/);
  }
  assert.doesNotThrow(() => new PiAgentRuntime({ extensionPaths: [] }));
});

test("default and empty extension configuration preserve disabled discovery and skill behavior", async (t) => {
  const { directory, launches } = await fixture(t);
  for (const options of [{}, { extensionPaths: [] }]) {
    const runtime = new PiAgentRuntime(options);
    const catalog = await runtime.capabilities({ cwd: directory });
    assert.deepEqual(catalog.skills, [{ id: "skill:reviewer", name: "reviewer", description: "Review changes" }]);
    const session = await runtime.start({ cwd: directory, skillIds: [] });
    try {
      const all = await launches();
      assert.deepEqual(extensions(all.at(-1)!.args), []);
      assert.ok(all.at(-1)!.args.includes("--no-skills"));
      assert.ok(!all.at(-1)!.args.includes("--skill"));
    } finally {
      await runtime.stop(session.id);
    }
  }
  for (const launch of await launches()) assert.deepEqual(extensions(launch.args), []);
});

test("configured extensions reach capability discovery, skill validation, and owned workers without exposing credentials", async (t) => {
  const { directory, launches } = await fixture(t);
  const paths = ["./extensions/integration with spaces.ts", "builtin:codemode"];
  const expected = [resolve(paths[0]!), paths[1]!];
  const runtime = new PiAgentRuntime({ extensionPaths: paths });
  paths.push("must-not-be-loaded.ts");
  const catalog = await runtime.capabilities({ cwd: directory });
  assert.doesNotMatch(JSON.stringify(catalog), /integration with spaces|fixture-only|\/skills\//);
  await assert.rejects(runtime.start({ cwd: directory, skillIds: ["skill:missing"] }), /Pi skill is not available/);
  const session = await runtime.start({ cwd: directory, skillIds: ["skill:reviewer"] });
  try {
    const all = await launches();
    assert.equal(all.length, 4);
    for (const launch of all) {
      assert.deepEqual(extensions(launch.args), expected);
      assert.equal(launch.credentialPresent, true);
    }
    const ownedArgs = all.at(-1)!.args;
    assert.ok(ownedArgs.includes("--no-skills"));
    assert.equal(ownedArgs[ownedArgs.indexOf("--skill") + 1], "/skills/reviewer/SKILL.md");
    assert.ok(!all[0]!.args.includes("--no-skills"), "skill selection must not change the discovery catalog");
  } finally {
    await runtime.stop(session.id);
  }
});

test("managed resume uses the new host adapter's extension configuration, not persisted launch grants", async (t) => {
  const { directory, launches } = await fixture(t);
  const path = join(directory, "integration.ts");
  const runtime = new PiAgentRuntime({ extensionPaths: [path] });
  const ownerId = "extension-test-owner";
  const session = await runtime.startManaged({ cwd: directory }, ownerId);
  try {
    await runtime.suspend(session.id, ownerId);
    const restarted = new PiAgentRuntime({ extensionPaths: [path] });
    await restarted.resume(session.id, ownerId);
    assert.deepEqual((await launches()).map(({ args }) => extensions(args)), [[path], [path]]);
    await restarted.suspend(session.id, ownerId);
    const restricted = new PiAgentRuntime();
    await restricted.resume(session.id, ownerId);
    assert.deepEqual(extensions((await launches()).at(-1)!.args), []);
  } finally {
    await runtime.destroy(session.id, ownerId);
  }
});

test("real headless Pi loads only explicit extensions and registers their tools again after resume", { timeout: 60_000 }, async (t) => {
  const { directory, observationsFile } = await realFixture(t);
  const extension = join(directory, "integration.ts");
  const broken = join(directory, "broken.ts");
  await writeFile(extension, `import { appendFileSync } from "node:fs";
export default function(pi) {
  pi.registerTool({
    name: "runtime_fixture_tool", label: "Runtime fixture", description: "Read-only test tool",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    async execute() { return { content: [{ type: "text", text: "fixture" }], details: undefined }; },
  });
  pi.on("session_start", () => {
    if (process.env.EXTENSION_TEST_FAILURE === "hook") throw new Error("private fixture hook error");
    appendFileSync(process.env.EXTENSION_TEST_OBSERVATIONS, JSON.stringify({
      active: pi.getActiveTools(), registered: pi.getAllTools().map(tool => tool.name),
      credentialPresent: process.env.EXTENSION_TEST_CREDENTIAL === "fixture-only",
    }) + "\\n");
  });
}
`);
  await writeFile(broken, "export default function( {\n");
  const options = { extensionPaths: [extension] };
  const runtime = new PiAgentRuntime(options);
  const ownerId = "real-extension-owner";
  const catalog = await runtime.capabilities({ cwd: directory });
  assert.doesNotMatch(JSON.stringify(catalog), /fixture-only|integration\.ts/);
  const session = await runtime.startManaged({ cwd: directory, skillIds: [] }, ownerId);
  try {
    await runtime.suspend(session.id, ownerId);
    await new PiAgentRuntime(options).resume(session.id, ownerId);
    const observations = (await readFile(observationsFile, "utf8")).trim().split("\n")
      .map((line) => JSON.parse(line) as { active: string[]; registered: string[]; credentialPresent: boolean });
    assert.equal(observations.length, 5, "capabilities, skill validation, start, validation on resume, and resumed worker");
    for (const observation of observations) {
      assert.ok(observation.active.includes("runtime_fixture_tool"));
      assert.ok(observation.registered.includes("runtime_fixture_tool"));
      assert.ok(!observation.registered.includes("codemode"), "built-in extensions remain disabled too");
      assert.equal(observation.credentialPresent, true);
    }
  } finally {
    await runtime.destroy(session.id, ownerId);
  }
  for (const failure of ["syntax", "hook"]) {
    process.env.EXTENSION_TEST_FAILURE = failure;
    const failing = new PiAgentRuntime({ extensionPaths: [failure === "syntax" ? broken : extension] });
    await assert.rejects(failing.capabilities({ cwd: directory }), /check configured Pi extensions|Pi extension initialization failed/);
    let publicError = "";
    await assert.rejects(failing.start({ cwd: directory }), (error: Error) => {
      publicError = error.message;
      assert.match(publicError, /check configured Pi extensions|Pi extension initialization failed/);
      assert.doesNotMatch(publicError, /private fixture hook error|session_start|integration\.ts/);
      return true;
    });
    if (failure === "hook") {
      const logPath = publicError.match(/\. See (.+)$/)?.[1];
      assert.ok(logPath, "startup failure must reference its private log");
      const diagnostic = await readFile(logPath, "utf8");
      assert.match(diagnostic, /private fixture hook error/);
      assert.match(diagnostic, /session_start/);
      assert.match(diagnostic, /integration\.ts/);
      assert.equal((await stat(logPath)).mode & 0o777, 0o600);
    }
    assert.deepEqual(await listRegistrations(), []);
  }
});

test("real Pi rejects extension-provided skills outside explicit selections, including on resume", { timeout: 60_000 }, async (t) => {
  const { directory, agentDirectory } = await realFixture(t);
  const selectedDirectory = join(agentDirectory, "skills", "selected-skill");
  await mkdir(selectedDirectory, { recursive: true });
  await writeFile(join(selectedDirectory, "SKILL.md"), "---\nname: selected-skill\ndescription: Selected fixture skill\n---\nSelected instructions.\n");
  const ownerId = "extension-skill-selection-owner";
  const expected = ["skill:extra-skill", "skill:selected-skill"];
  for (const source of ["resources_discover", "package"]) {
    const root = join(directory, source);
    const skillsDirectory = join(root, "skills");
    const extraDirectory = join(skillsDirectory, "extra-skill");
    await mkdir(extraDirectory, { recursive: true });
    await writeFile(join(extraDirectory, "SKILL.md"), "---\nname: extra-skill\ndescription: Extension-provided fixture skill\n---\nExtra instructions.\n");
    const entry = join(root, "index.ts");
    await writeFile(entry, source === "resources_discover"
      ? `export default function(pi) { pi.on("resources_discover", () => ({ skillPaths: [${JSON.stringify(skillsDirectory)}] })); }\n`
      : "export default function() {}\n");
    if (source === "package") {
      await writeFile(join(root, "package.json"), JSON.stringify({
        name: "runtime-skill-fixture", type: "module", pi: { extensions: ["./index.ts"], skills: ["./skills"] },
      }));
    }
    const runtime = new PiAgentRuntime({ extensionPaths: [source === "package" ? root : entry] });
    assert.deepEqual((await runtime.capabilities({ cwd: directory })).skills.map(({ id }) => id).sort(), expected);
    for (const skillIds of [[], ["skill:selected-skill"]]) {
      await assert.rejects(runtime.startManaged({ cwd: directory, skillIds }, ownerId), /could not enforce the selected skills/);
      assert.deepEqual(await listRegistrations(), [], `${source}: rejected workers must not become reachable`);
      assert.deepEqual(await runtime.listManagedSessions(ownerId), []);
    }
    const unrestricted = await runtime.startManaged({ cwd: directory }, ownerId);
    try {
      const profile = await runtime.inspectSessionProfile(unrestricted.id, ownerId);
      assert.deepEqual(profile?.skills.status === "verified" ? profile.skills.commandIds.slice().sort() : undefined, expected);
    } finally {
      await runtime.destroy(unrestricted.id, ownerId);
    }
    const session = await runtime.startManaged({ cwd: directory, skillIds: expected }, ownerId);
    try {
      const profile = await runtime.inspectSessionProfile(session.id, ownerId);
      assert.deepEqual(profile?.skills.status === "verified" ? profile.skills.commandIds.slice().sort() : undefined, expected);
      await runtime.suspend(session.id, ownerId);
      const addedDirectory = join(skillsDirectory, "late-skill");
      await mkdir(addedDirectory);
      await writeFile(join(addedDirectory, "SKILL.md"), "---\nname: late-skill\ndescription: Newly supplied unselected skill\n---\nLate instructions.\n");
      await assert.rejects(runtime.resume(session.id, ownerId), /could not enforce the selected skills/);
      assert.deepEqual(await listRegistrations(), []);
      assert.equal((await runtime.listManagedSessions(ownerId))[0]?.state, "suspended");
      await rm(addedDirectory, { recursive: true });
      await runtime.resume(session.id, ownerId);
      const resumed = await runtime.inspectSessionProfile(session.id, ownerId);
      assert.deepEqual(resumed?.skills.status === "verified" ? resumed.skills.commandIds.slice().sort() : undefined, expected);
    } finally {
      await runtime.destroy(session.id, ownerId);
    }
  }
});

test("extension initialization failures reject discovery and startup without registering a partial worker", async (t) => {
  const { directory } = await fixture(t);
  const runtime = new PiAgentRuntime({ extensionPaths: [join(directory, "broken.ts")] });
  for (const failure of ["hook", "exit"]) {
    process.env.EXTENSION_TEST_FAILURE = failure;
    await assert.rejects(runtime.capabilities({ cwd: directory }), /Pi extension initialization failed|check configured Pi extensions/);
    await assert.rejects(runtime.start({ cwd: directory }), /Pi extension initialization failed|check configured Pi extensions/);
    assert.deepEqual(await listRegistrations(), []);
  }
});
