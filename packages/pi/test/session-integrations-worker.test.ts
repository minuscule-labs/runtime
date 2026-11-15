import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PiAgentRuntime } from "../src/client.js";

// Explicit local-artifact acceptance. Never selects a live/global harness implicitly.
test("spawned managed worker reads its actual integration state through the pinned artifact", { skip: !process.env.PI_INTEGRATIONS_TEST_COMMAND, timeout: 30000 }, async () => {
  const previous = { ...process.env };
  const root = await mkdtemp(join(tmpdir(), "runtime-integrations-worker-"));
  const agent = join(root, "agent"), registry = join(root, "runtime");
  await mkdir(agent);
  const requestLog = join(root, "mcp-requests.jsonl");
  const fixture = join(root, "fixture.mjs");
  await writeFile(fixture, `import {createInterface} from 'node:readline';import {appendFileSync} from 'node:fs';
createInterface({input:process.stdin}).on('line',line=>{const r=JSON.parse(line);appendFileSync(${JSON.stringify(requestLog)},JSON.stringify(r.method)+'\\n');if(r.id===undefined)return;const result=r.method==='initialize'?{protocolVersion:r.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'notes-fixture',version:'1'}}:r.method==='tools/list'?{tools:[{name:'read',description:'fixture read',inputSchema:{type:'object',properties:{}}}]}:{};console.log(JSON.stringify({jsonrpc:'2.0',id:r.id,result}));});\n`);
  await writeFile(join(agent, "mcp.json"), JSON.stringify({ mcpServers: {
    minunotes_fixture: { command: process.execPath, args: [fixture], exposure: "codemode", env: { KEY: "SECRET_FIXTURE" } },
    mongodb_fixture: { command: join(root, "SECRET_MISSING_SERVER") },
  } }));
  process.env = { PATH: previous.PATH, HOME: root, PI_CODING_AGENT_DIR: agent, MINU_RUNTIME_DIR: registry, PI_COMMAND: previous.PI_INTEGRATIONS_TEST_COMMAND };
  const runtime = new PiAgentRuntime();
  let id: string | undefined;
  try {
    const session = await runtime.startManaged({ cwd: root }, "fixture-owner");
    id = session.id;
    assert.equal(await runtime.inspectSessionIntegrations(id, "other-owner"), undefined);
    let observed = await runtime.inspectSessionIntegrations(id, "fixture-owner");
    const deadline = Date.now() + 10000;
    while (observed?.integrations.find(item => item.name === "minunotes_fixture")?.connection !== "connected" && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 50));
      observed = await runtime.inspectSessionIntegrations(id, "fixture-owner");
    }
    assert.equal(observed?.integrations.find(item => item.name === "minunotes_fixture")?.connection, "connected");
    assert.equal(observed?.integrations.find(item => item.name === "mongodb_fixture")?.connection, "failed");
    assert.ok(observed?.tools.some(item => item.name === "mcp__minunotes_fixture__read"));
    assert.doesNotMatch(JSON.stringify(observed), /SECRET|sessionFile|nativeSessionId|endpoint|headers/);
    const requestsBefore = await readFile(requestLog, "utf8");
    const messagesBefore = await runtime.messages(id);
    const workerId = observed?.workerId;
    observed = await runtime.inspectSessionIntegrations(id, "fixture-owner");
    assert.equal(observed?.workerId, workerId);
    assert.equal(await readFile(requestLog, "utf8"), requestsBefore, "inspection adds no discovery/reconnect/business requests");
    assert.deepEqual(await runtime.messages(id), messagesBefore);
    assert.equal(await runtime.status(id), "idle");
  } finally {
    if (id) await runtime.suspend(id, "fixture-owner");
    process.env = previous;
    await rm(root, { recursive: true, force: true });
  }
});

test("older native workers report unsupported inspection without claiming no configuration", { skip: !process.env.PI_INTEGRATIONS_OLD_TEST_COMMAND, timeout: 30000 }, async () => {
  const previous = { ...process.env };
  const root = await mkdtemp(join(tmpdir(), "runtime-integrations-old-worker-"));
  const agent = join(root, "agent"); await mkdir(agent);
  await writeFile(join(agent, "mcp.json"), JSON.stringify({ mcpServers: {} }));
  process.env = { PATH: previous.PATH, HOME: root, PI_CODING_AGENT_DIR: agent, MINU_RUNTIME_DIR: join(root, "runtime"), PI_COMMAND: previous.PI_INTEGRATIONS_OLD_TEST_COMMAND };
  const runtime = new PiAgentRuntime();
  let id: string | undefined;
  try {
    const session = await runtime.startManaged({ cwd: root }, "fixture-owner"); id = session.id;
    const observed = await runtime.inspectSessionIntegrations(id, "fixture-owner");
    assert.equal(observed?.status, "unsupported");
    assert.deepEqual(observed?.coverage, { configuration: "unknown", tools: "unknown" });
    assert.deepEqual(observed?.integrations, []);
    assert.equal(observed?.operations.inspect, "unsupported");
    assert.equal(await runtime.status(id), "idle");
  } finally {
    if (id) await runtime.suspend(id, "fixture-owner");
    process.env = previous;
    await rm(root, { recursive: true, force: true });
  }
});
