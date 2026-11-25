import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os"; import { join } from "node:path"; import { fileURLToPath } from "node:url";
import test, { type TestContext } from "node:test";
import { createRuntime, runtimeReference, PiAgentRuntime, CodexAgentRuntime, ClaudeCodeAgentRuntime, type AgentEvent } from "../src/index.js";
import { createRuntimeProgram } from "../src/cli.js";
const { CodexManagedStore } = await import(new URL("../../../codex/dist/src/managed-store.js", import.meta.url).href);
const exec = promisify(execFile), cli = fileURLToPath(new URL("../../bin/minu-runtime.js", import.meta.url));
const fixtureNative = fileURLToPath(new URL("../../../codex/dist/test/fixtures/app-server.js", import.meta.url));
function alive(pid: number) { try { process.kill(pid, 0); return true; } catch { return false; } }
async function gone(pid: number) { for (let i=0;i<300&&alive(pid);i++) await new Promise(r=>setTimeout(r,10));assert.equal(alive(pid),false); }
async function fixture(t: TestContext, scenario = "lifecycle") {
  const directory=await realpath(await mkdtemp(join(tmpdir(),"runtime-cli-"))),root=join(directory,"managed"),bin=join(directory,"bin"),log=join(directory,"native.log");await mkdir(bin);
  const wrapper=join(bin,"codex");await writeFile(wrapper,`#!${process.execPath}\nprocess.argv=[process.execPath,${JSON.stringify(fixtureNative)},${JSON.stringify(scenario)},${JSON.stringify(log)},...process.argv.slice(2)];\nimport(${JSON.stringify(new URL(`file://${fixtureNative}`).href)}).catch(e=>{console.error(e);process.exitCode=1;});\n`,{mode:0o700});await chmod(wrapper,0o700);
  const env={...process.env,PATH:`${bin}:${process.env.PATH}`,MINU_RUNTIME_DIR:join(directory,"pi")};
  const runtime=new CodexAgentRuntime({managedRoot:root,command:wrapper}),store=new CodexManagedStore(root),pids=new Set<number>();const sessions:string[]=[];
  const run=async(args:string[],success=true)=>{try{const result=await exec(process.execPath,[cli,...args],{env,timeout:10000,maxBuffer:1024*1024});assert.equal(success,true,`Unexpected success: ${args.join(" ")}`);for(const m of await store.list("cli-owner"))if("connection" in m.worker)pids.add(m.worker.connection.pid);return result.stdout.trim();}
    catch(error){if(success)throw error;assert.ok((error as any).code);return String((error as any).stderr);}};
  t.after(async()=>{for(const id of sessions){try{await runtime.connectManaged(id,"cli-owner");await runtime.stop(id);}catch{}}
    for(const pid of pids){if(alive(pid))process.kill(pid,"SIGTERM");await gone(pid);}
    try{for(const line of (await readFile(log,"utf8")).trim().split("\n")){const row=JSON.parse(line);if(row.pid&&alive(row.pid)){process.kill(row.pid,"SIGTERM");await gone(row.pid);}}}catch(e){if((e as NodeJS.ErrnoException).code!=="ENOENT")throw e;}
    await rm(directory,{recursive:true,force:true});});
  const scoped=["--adapter","codex","--owner","cli-owner","--managed-root",root];
  return{directory,root,log,runtime,run,scoped,sessions,async calls(){try{return(await readFile(log,"utf8")).trim().split("\n").map(s=>JSON.parse(s));}catch(e){if((e as NodeJS.ErrnoException).code==="ENOENT")return[];throw e;}}};
}

test("public factory is explicit, defaults to Pi and never falls back between adapters",()=>{
  assert.ok(createRuntime() instanceof PiAgentRuntime);assert.ok(createRuntime("codex") instanceof CodexAgentRuntime);
  assert.ok(createRuntime("claude-code") instanceof ClaudeCodeAgentRuntime);
  assert.deepEqual(runtimeReference("claude-code:session"),{adapter:"claude-code",id:"session"});
  assert.throws(()=>runtimeReference("claude-code:session","codex"),/conflicts/);assert.throws(()=>runtimeReference("claude-code:"),/Invalid/);
  assert.throws(()=>createRuntime("other" as "codex"),/Unsupported/);
  assert.deepEqual(runtimeReference("codex:session"),{adapter:"codex",id:"session"});
  assert.deepEqual(runtimeReference("pi:session"),{adapter:"pi",id:"session"});
  assert.deepEqual(runtimeReference("session"),{adapter:"pi",id:"session"});
  assert.throws(()=>runtimeReference("codex:session","pi"),/conflicts/);assert.throws(()=>runtimeReference("codex:"),/Invalid/);
});

test("shared CLI preserves legacy Pi start and control dispatch without managed rebinding",async t=>{
  const calls: unknown[][]=[];t.mock.method(console,"log",()=>{});
  t.mock.method(PiAgentRuntime.prototype,"start",async(config: Parameters<PiAgentRuntime["start"]>[0])=>{calls.push(["start",config]);return{id:"legacy",runtime:"pi",ownership:"owned",cwd:"/workspace"};});
  for(const method of ["send","steer","interrupt","stop"] as const)t.mock.method(PiAgentRuntime.prototype,method,async(...args:unknown[])=>{calls.push([method,...args]);});
  const run=(args:string[])=>createRuntimeProgram().parseAsync([process.execPath,"minu-runtime",...args]);
  await run(["start","--cwd","/workspace","--system-prompt","persona"]);
  await run(["send","legacy","hello","world"]);await run(["steer","pi:legacy","next","step"]);await run(["interrupt","legacy"]);await run(["stop","legacy"]);
  assert.deepEqual(calls,[["start",{cwd:"/workspace",systemPrompt:"persona"}],["send","legacy","hello world",undefined],["steer","legacy","next step"],["interrupt","legacy"],["stop","legacy"]]);
});

test("CLI keeps default Pi inventory/help and rejects unsafe selection before native launch",async t=>{
  const f=await fixture(t);assert.match(await f.run(["sessions"]),/No online Pi sessions/);assert.match(await f.run(["--help"]),/--adapter/);
  assert.match(await f.run(["--adapter","other","sessions"],false),/Allowed choices/);
  assert.match(await f.run(["--adapter","codex","--managed-root",f.root,"start"],false),/owner/);
  assert.match(await f.run(["--adapter","pi","status","codex:session"],false),/conflicts/);
  assert.match(await f.run([...f.scoped,"start","--model","","--model-provider",""],false),/Invalid/);
  assert.deepEqual(await f.calls(),[]);
});

test("CLI --sandbox is Codex-only and saves the chosen policy for new sessions",async t=>{
  const f=await fixture(t);
  assert.match(await f.run(["--adapter","pi","--sandbox","danger-full-access","sessions"],false),/--sandbox requires Codex/);
  assert.match(await f.run(["--adapter","claude-code","--sandbox","danger-full-access","sessions"],false),/--sandbox requires Codex/);
  assert.match(await f.run([...f.scoped,"--sandbox","unrestricted","sessions"],false),/Allowed choices/);
  const store=new CodexManagedStore(f.root);
  const plain=(await f.run([...f.scoped,"start","--cwd",f.directory])).split("\t")[0].replace("codex:","");f.sessions.push(plain);
  const full=(await f.run([...f.scoped,"--sandbox","danger-full-access","start","--cwd",f.directory])).split("\t")[0].replace("codex:","");f.sessions.push(full);
  assert.equal((await store.read(plain,"cli-owner"))?.sandbox,"read-only");
  assert.equal((await store.read(full,"cli-owner"))?.sandbox,"danger-full-access");
  // A later controller without the flag must not change the saved policy.
  assert.equal(await f.run([...f.scoped,"status",`codex:${full}`]),"idle");
  // Codex suspend is macOS-only.
  if(process.platform==="darwin")await f.run([...f.scoped,"suspend",`codex:${full}`]);
  assert.equal((await store.read(full,"cli-owner"))?.sandbox,"danger-full-access");
});

test("createRuntime passes the Codex sandbox through",()=>{
  assert.ok(createRuntime("codex",{sandbox:"danger-full-access"}) instanceof CodexAgentRuntime);
  assert.throws(()=>createRuntime("codex",{sandbox:"unrestricted" as "read-only"}),/sandboxing/);
});

test("separate CLI controllers preserve owner-scoped native lifecycle, qualified routing and history",{timeout:60000},async t=>{
  const f=await fixture(t);const started=await f.run([...f.scoped,"start","--cwd",f.directory,"--no-skills"]),reference=started.split("\t")[0],id=reference.slice("codex:".length);f.sessions.push(id);
  assert.ok(reference.startsWith("codex:"));assert.deepEqual(await f.calls(),[]);
  assert.equal(await f.run([...f.scoped,"status",reference]),"idle");
  assert.match(await f.run(["--owner","wrong","--managed-root",f.root,"send",reference,"Do not dispatch"],false),/unavailable/);
  assert.deepEqual(await f.calls(),[]);
  await f.run([...f.scoped,"send",reference,"First", "input"]);const history=await f.run([...f.scoped,"messages",reference]);assert.match(history,/First input/);
  assert.equal((await f.calls()).filter(c=>c.method==="thread/start").length,1);
  const profile=JSON.parse(await f.run([...f.scoped,"profile",reference]));assert.equal(profile.model.status,"verified");
  const events=JSON.parse(await f.run([...f.scoped,"observations",reference]));assert.ok(events.events.some((e:any)=>e.code==="turn_completed"));
  if(process.platform==="darwin"){
    await f.run([...f.scoped,"suspend",reference]);const calls=await f.calls();
    assert.match(await f.run([...f.scoped,"status",reference],false),/unavailable/);assert.deepEqual(await f.calls(),calls);
    assert.match(await f.run([...f.scoped,"sessions"]),/suspended/);
    await f.run([...f.scoped,"resume",reference]);assert.equal(await f.run([...f.scoped,"messages",reference]),history);
    await f.run([...f.scoped,"send",reference,"Second input"]);await f.run([...f.scoped,"destroy",reference]);
    assert.equal(await f.run([...f.scoped,"sessions"]),"");assert.match(await f.run([...f.scoped,"resume",reference],false),/unavailable/);
    assert.equal((await f.calls()).filter(c=>c.method==="thread/resume").length,1);assert.ok((await readFile(`${f.log}.history.json`,"utf8")).includes("First input"));
  }else await f.run([...f.scoped,"stop",reference]);
});

test("CLI follow settles on success and on native image rejection without losing text usability",{timeout:30000},async t=>{
  const f=await fixture(t,"text-only"),reference=(await f.run([...f.scoped,"start","--cwd",f.directory])).split("\t")[0];f.sessions.push(reference.slice(6));
  await f.run([...f.scoped,"send","--follow",reference,"First input"]);
  const image=join(f.directory,"pixel.png");await writeFile(image,Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==","base64"));
  assert.match(await f.run([...f.scoped,"send","--follow",reference,"--image",image],false),/does not support images/);
  await f.run([...f.scoped,"send","--follow",reference,"Still usable"]);
  assert.equal((await f.calls()).filter(c=>c.method==="turn/start").length,2);
});

test("CLI caller turn IDs, image-only inputs and deterministic rejection keep one worker usable",{timeout:30000},async t=>{
  const f=await fixture(t),reference=(await f.run([...f.scoped,"start","--cwd",f.directory])).split("\t")[0];f.sessions.push(reference.slice(6));
  const image=join(f.directory,"pixel.png");await writeFile(image,Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==","base64"));
  await f.run([...f.scoped,"start-turn",reference,"photo","--image",image]);let turn;
  for(let i=0;i<50;i++){turn=JSON.parse(await f.run([...f.scoped,"turn",reference,"photo"]));if(turn.status!=="running")break;}
  assert.equal(turn.status,"completed");assert.equal(turn.input,"");
  const duplicate=JSON.parse(await f.run([...f.scoped,"start-turn",reference,"photo","--image",image]));assert.deepEqual(duplicate,turn);
  assert.match(await f.run([...f.scoped,"start-turn",reference,"photo","different"],false),/failed/);
  const bad=join(f.directory,"bad.txt");await writeFile(bad,"secret");await f.run([...f.scoped,"send",reference,"--image",bad],false);
  await f.run([...f.scoped,"send",reference,"Valid text"]);
  assert.equal((await f.calls()).filter(c=>c.method==="turn/start").length,2);
});

test("fresh CLI interrupt cancels paused preparation before native dispatch",{timeout:20000},async t=>{
  const f=await fixture(t,"paused-create"),reference=(await f.run([...f.scoped,"start","--cwd",f.directory])).split("\t")[0];f.sessions.push(reference.slice(6));
  try {
    await f.run([...f.scoped,"start-turn",reference,"cancel-preparation","Do not dispatch"]);
    const deadline=Date.now()+4000;
    while(!(await f.calls()).some(c=>c.method==="thread/start")){assert.ok(Date.now()<deadline);await new Promise(r=>setTimeout(r,10));}
    await f.run(["--owner","wrong","--managed-root",f.root,"interrupt",reference],false);
    await f.run([...f.scoped,"interrupt",reference]);
    assert.equal((await f.calls()).filter(c=>c.method==="turn/start").length,0);
  } finally {await writeFile(f.log+".release","release");}
  const turn=JSON.parse(await f.run([...f.scoped,"turn",reference,"cancel-preparation"]));assert.equal(turn.status,"interrupted");
  assert.equal((await f.calls()).filter(c=>c.method==="turn/start").length,0);
});

function followStream() {
  const event=(fields: Record<string,unknown>)=>({sessionId:"session",timestamp:new Date().toISOString(),...fields} as AgentEvent);
  const queue: AgentEvent[]=[event({type:"status",status:"idle"})];
  let closed=false,waiting:((value:IteratorResult<AgentEvent>)=>void)|undefined;
  const iterator={
    [Symbol.asyncIterator](){return this;},
    next():Promise<IteratorResult<AgentEvent>>{if(queue.length)return Promise.resolve({done:false,value:queue.shift()!});if(closed)return Promise.resolve({done:true,value:undefined});return new Promise(resolve=>{waiting=resolve;});},
    return():Promise<IteratorResult<AgentEvent>>{closed=true;waiting?.({done:true,value:undefined});waiting=undefined;return Promise.resolve({done:true,value:undefined});},
  };
  return {iterator,get closed(){return closed;},push(fields:Record<string,unknown>){const value=event(fields);if(closed)return;if(waiting){const resolve=waiting;waiting=undefined;resolve({done:false,value});}else queue.push(value);}};
}

for(const outcome of ["success","send-failure","stream-ended"] as const)test(`CLI follow ${outcome} respects independent stream settlement`,{timeout:5000},async t=>{
  const stream=followStream();let output="";
  t.mock.method(PiAgentRuntime.prototype,"events",()=>stream.iterator);
  t.mock.method(PiAgentRuntime.prototype,"send",async()=>{if(outcome==="send-failure")throw new Error("Rejected input");});
  t.mock.method(console,"log",()=>{});t.mock.method(process.stdout,"write",(chunk: string|Uint8Array)=>{output+=String(chunk);return true;});
  const command=createRuntimeProgram().parseAsync([process.execPath,"minu-runtime","send","--follow","session","Prompt"]);
  if(outcome==="send-failure"){await assert.rejects(command,/Rejected input/);assert.equal(stream.closed,true);return;}
  await new Promise(resolve=>setImmediate(resolve));assert.equal(stream.closed,false);
  if(outcome==="stream-ended"){await stream.iterator.return();await assert.rejects(command,/before turn completion/);return;}
  stream.push({type:"message_delta",delta:"COMPLETE_ANSWER"});stream.push({type:"turn_completed",operationId:"turn"});
  await command;assert.ok(output.includes("COMPLETE_ANSWER"));assert.equal(stream.closed,true);
});

test("CLI canonicalizes a symlinked --managed-root and --cwd instead of leaving the session stuck",{timeout:60000},async t=>{
  const f=await fixture(t),link=join(f.directory,"managed-link"),workspace=join(f.directory,"workspace"),workspaceLink=join(f.directory,"workspace-link");
  await mkdir(workspace);await (await import("node:fs/promises")).symlink(f.directory,link);await (await import("node:fs/promises")).symlink(workspace,workspaceLink);
  // The root need not exist yet: its parent is canonicalized and the leaf appended.
  const args=["--adapter","codex","--owner","cli-owner","--managed-root",join(link,"managed")];
  const started=await f.run([...args,"start","--cwd",workspaceLink,"--no-skills"]),reference=started.split("\t")[0];f.sessions.push(reference.slice("codex:".length));
  assert.equal(started.split("\t")[2],workspace);
  assert.equal(await f.run([...args,"status",reference]),"idle");
  assert.match(await f.run([...args,"sessions"]),new RegExp(reference));
});

const claudeFixture = (name: string) => fileURLToPath(new URL(`../../../claude-code/dist/test/fixtures/${name}`, import.meta.url));
test("Claude Code runs through the shared CLI like Codex: owner-scoped managed sessions, qualified ids, restart-safe lifecycle",{timeout:90000},async t=>{
  const directory=await realpath(await mkdtemp(join(tmpdir(),"runtime-cli-claude-"))),root=join(directory,"managed"),config=join(directory,"config"),cwd=join(directory,"workspace");
  await mkdir(config,{mode:0o700});await mkdir(cwd);
  // The fake engine speaks the SDK protocol; no model, no login, no network.
  const env={...process.env,HOME:directory,TMPDIR:directory,CLAUDE_CONFIG_DIR:config,MINU_RUNTIME_DIR:join(directory,"pi"),ANTHROPIC_API_KEY:"dummy-local-only"};
  const scoped=["--adapter","claude-code","--owner","cli-owner","--managed-root",root,"--executable",claudeFixture("persistent-native.js")];
  const run=async(args:string[],success=true,extra:Record<string,string>={})=>{try{const result=await exec(process.execPath,[cli,...args],{env:{...env,...extra},timeout:20000,maxBuffer:1024*1024});assert.equal(success,true,`Unexpected success: ${args.join(" ")}`);return result.stdout.trim();}
    catch(error){if(success)throw error;assert.ok((error as any).code);return String((error as any).stderr);}};
  let reference="";
  t.after(async()=>{try{if(reference){await run([...scoped,"destroy",reference],true).catch(()=>{});}}finally{await rm(directory,{recursive:true,force:true});}});
  // The worker the CLI starts must be a disposable test worker, so build a runtime with the same root to observe/clean up.
  const started=await run([...scoped,"start","--cwd",cwd,"--permissions","full"]);reference=started.split("\t")[0];
  assert.match(reference,/^claude-code:/);assert.equal(started.split("\t")[1],"owned");
  assert.equal(await run([...scoped,"status",reference]),"idle");
  assert.match(await run([...scoped,"send",reference,"hello","claude"]),/turn completed/);
  assert.match(await run([...scoped,"messages",reference]),/\[assistant\] reply: hello claude/);
  assert.match(await run([...scoped,"sessions"]),new RegExp(`${reference}\\tactive\\towned`));
  assert.match(await run([...scoped,"profile",reference]),/"version":1/);
  // Another owner sees nothing and cannot touch it.
  assert.equal(await run(["--adapter","claude-code","--owner","other-owner","--managed-root",root,"--executable",claudeFixture("persistent-native.js"),"sessions"]),"");
  assert.match(await run(["--adapter","claude-code","--owner","other-owner","--managed-root",root,"--executable",claudeFixture("persistent-native.js"),"suspend",reference],false),/unavailable/);
  // Suspend, then an explicit resume; a plain status/send never relaunches a stopped session.
  await run([...scoped,"suspend",reference]);
  assert.match(await run([...scoped,"sessions"]),new RegExp(`${reference}\\tsuspended\\towned`));
  await run([...scoped,"send",reference,"must not relaunch"],false);
  assert.match(await run([...scoped,"resume",reference]),/^claude-code:/);
  assert.match(await run([...scoped,"send",reference,"after","resume"]),/turn completed/);
  assert.match(await run([...scoped,"messages",reference]),/\[assistant\] reply: after resume/);
  await run([...scoped,"suspend",reference]);
  // Flags that belong to another adapter are refused before anything starts; a missing login is the one specific error.
  assert.match(await run(["--adapter","pi","--permissions","full","sessions"],false),/require Claude Code/);
  assert.match(await run([...scoped,"start","--cwd",cwd],false,{MINU_CLAUDE_FIXTURE_ACCOUNT:"none"}),/not logged in/);
});

test("start refuses a skill the adapter does not report, before any session exists",async t=>{
  const f=await fixture(t);
  await assert.rejects(f.run([...f.scoped,"start","--cwd",f.directory,"--skill","reviewer"]),/Unknown skill: reviewer/);
  assert.equal((await f.run([...f.scoped,"sessions"])).trim(),"");
});
