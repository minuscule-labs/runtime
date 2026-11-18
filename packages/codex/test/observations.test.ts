import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, realpath, rm, writeFile, stat, symlink, link, chmod } from "node:fs/promises";
import { tmpdir } from "node:os"; import { join } from "node:path"; import { fileURLToPath } from "node:url";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { EventEmitter } from "node:events";
import test, { type TestContext } from "node:test";
import { SESSION_EVENTS_LIMITS, type AgentTurn } from "@minu/runtime-core";
import { CodexAgentRuntime } from "../src/client.js";
import { CodexManagedStore } from "../src/managed-store.js";
import { CodexSessionEventLog } from "../src/session-events.js";
import { diagnosticAvailable } from "../src/diagnostic.js";
import { createCodexWorkerBridge, type CodexWorkerRuntime } from "../src/worker-bridge.js";
import { CodexWorkerClient } from "../src/worker-client.js";
function alive(pid: number) { try { process.kill(pid, 0); return true; } catch { return false; } }
async function gone(pid: number) { for (let i=0;i<300 && alive(pid);i++) await new Promise(r=>setTimeout(r,10)); assert.equal(alive(pid),false); }
function gate() { let release!:()=>void; const promise=new Promise<void>(r=>{release=r;}); return {promise,release}; }
async function fixture(t: TestContext, scenario="normal") {
  const directory=await realpath(await mkdtemp(join(tmpdir(),"codex-observation-"))),root=join(directory,"managed"), log=join(directory,"native.log");
  const options={managedRoot:root,command:process.execPath,args:[fileURLToPath(new URL("./fixtures/app-server.js",import.meta.url)),scenario,log],requestTimeoutMs:2000,shutdownTimeoutMs:100};
  const runtime=new CodexAgentRuntime(options),store=new CodexManagedStore(root), workers:number[]=[];
  const calls=async():Promise<any[]>=>{try{return(await readFile(log,"utf8")).trim().split("\n").map(line=>JSON.parse(line));}catch(e){if((e as NodeJS.ErrnoException).code==="ENOENT")return[];throw e;}};
  const sessions:Array<{id:string}>=[];
  t.after(async()=>{for(const s of sessions)await runtime.stop(s.id).catch(()=>{});
    for(const pid of workers){if(alive(pid))process.kill(pid,"SIGTERM");await gone(pid);}
    for(const row of await calls())if(row.pid){if(alive(row.pid))process.kill(row.pid,"SIGTERM");await gone(row.pid);}
    await rm(directory,{recursive:true,force:true});});
  return {directory,root,log,runtime,store,options,calls,async create(config={}) {
    const s=await runtime.startManaged({cwd:directory,...config},"owner-a");sessions.push(s);
    const m=(await store.read(s.id,s.ownerId))!;if(m.worker.state==="ready")workers.push(m.worker.connection.pid);return s;
  }, manifest(id:string){return join(root,createHash("sha256").update("owner-a").digest("hex"),`${id}.session`,"manifest.json");},
    diagnostic(id:string){return join(root,createHash("sha256").update("owner-a").digest("hex"),".diagnostics",`${id}.json`);}};
}
async function settled(runtime:CodexAgentRuntime,id:string,turn:AgentTurn){for(let i=0;i<400&&turn.status==="running";i++){await new Promise(r=>setTimeout(r,10));turn=(await runtime.turn(id,turn.id))!;}assert.notEqual(turn.status,"running");return turn;}

 test("profiles and events inspect a living worker without native allocation or control binding",async t=>{
  const f=await fixture(t),s=await f.create({model:{provider:"saved-provider",id:"saved-model"},reasoningLevel:"high",skillIds:[]});
  const fresh=new CodexAgentRuntime(f.options),before=await f.store.read(s.id,s.ownerId);
  const profile=(await fresh.inspectSessionProfile(s.id,s.ownerId))!;
  assert.equal(profile.model.status,"not_verified");assert.equal(profile.reasoning.status,"not_verified");assert.equal(profile.skills.status,"not_verified");
  const events=(await fresh.inspectSessionEvents(s.id,s.ownerId))!;assert.deepEqual(events.events.map(e=>e.code),["bridge_ready"]);
  assert.deepEqual(await f.calls(),[]);assert.deepEqual(await f.store.read(s.id,s.ownerId),before);
  await assert.rejects(fresh.status(s.id));assert.equal(await fresh.inspectSessionProfile(s.id,"wrong-owner"),undefined);
  assert.equal(await fresh.inspectSessionEvents("unknown-id",s.ownerId),undefined);assert.equal(await fresh.inspectSessionEvents(s.id,"wrong-owner"),undefined);
 });

 test("live profiles use native acknowledgment instead of changed saved settings",async t=>{
  const f=await fixture(t),s=await f.create({model:{provider:"openai",id:"live-model"},reasoningLevel:"high",skillIds:[]});
  await f.runtime.send(s.id,"PRIVATE_PROMPT");
  const raw=JSON.parse(await readFile(f.manifest(s.id),"utf8"));raw.launchConfig.model={provider:"saved-only",id:"not-live"};
  await writeFile(f.manifest(s.id),JSON.stringify(raw));const before=await readFile(f.manifest(s.id),"utf8"),calls=await f.calls();
  const profile=(await f.runtime.inspectSessionProfile(s.id,s.ownerId))!;
  assert.deepEqual(profile.model,{status:"verified",provider:"openai",id:"live-model"});assert.deepEqual(profile.reasoning,{status:"verified",level:"high"});
  assert.deepEqual(profile.skills,{status:"not_verified"});assert.equal(JSON.stringify(profile).includes("PRIVATE_PROMPT"),false);
  assert.deepEqual(await f.calls(),calls);assert.equal(await readFile(f.manifest(s.id),"utf8"),before);
 });

 test("unrepresentable native provider is not fabricated into a verified profile",async t=>{
  const f=await fixture(t),s=await f.create({model:{provider:"review provider",id:"live-model"}});await f.runtime.send(s.id,"Text");
  assert.equal((await f.runtime.inspectSessionProfile(s.id,s.ownerId))?.model.status,"not_verified");
 });

 test("structured codes describe reuse/conflict/dispatch/control without raw payloads",async t=>{
  const f=await fixture(t,"held"),s=await f.create();const turn=await f.runtime.startTurn(s.id,"PRIVATE_CALLER_ID","PRIVATE_PROMPT");
  for(let i=0;i<300&&!(await f.calls()).some(c=>c.method==="turn/start");i++)await new Promise(r=>setTimeout(r,10));
  await f.runtime.startTurn(s.id,"PRIVATE_CALLER_ID","PRIVATE_PROMPT");
  await assert.rejects(f.runtime.startTurn(s.id,"PRIVATE_CALLER_ID","different"));await assert.rejects(f.runtime.startTurn(s.id,"busy","other"));
  await f.runtime.steer(s.id,"PRIVATE_STEER");await f.runtime.interrupt(s.id);await settled(f.runtime,s.id,turn);
  const snapshot=(await f.runtime.inspectSessionEvents(s.id,s.ownerId))!,codes=snapshot.events.map(e=>e.code);
  for(const code of ["bridge_ready","turn_accepted","turn_reused","turn_rejected_conflict","request_rejected_busy","turn_dispatch_requested","turn_dispatch_returned","steer_requested","steer_acknowledged","interrupt_requested","interrupt_acknowledged","turn_completed"])assert.ok(codes.includes(code as any),code);
  assert.equal(snapshot.eventsDropped,0);assert.deepEqual(snapshot.events.map(e=>e.sequence),snapshot.events.map((_,i)=>i+1));
  assert.equal(JSON.stringify(snapshot).includes("PRIVATE_"),false);assert.ok(snapshot.events.every(e=>Object.keys(e).sort().join(",")==="code,observedAt,sequence"));
 });

 test("structured eviction reports the full bounded window and a new worker has no continuity",()=>{
  const log=new CodexSessionEventLog();for(let i=0;i<SESSION_EVENTS_LIMITS.events+17;i++)log.record("turn_reused");
  const snapshot=log.snapshot();assert.equal(snapshot.events.length,200);assert.equal(snapshot.eventsDropped,17);assert.equal(snapshot.events[0].sequence,18);
  const fresh=new CodexSessionEventLog();assert.equal(fresh.snapshot().eventsDropped,0);assert.deepEqual(fresh.snapshot().events,[]);
 });

 test("aborted filesystem observations retain their physical slot without stopping work",async t=>{
  const f=await fixture(t),s=await f.create(),entered=gate(),release=gate(),original=CodexManagedStore.prototype.read;let blocked=true;
  t.mock.method(CodexManagedStore.prototype,"read",async function(this:CodexManagedStore,...args:Parameters<typeof original>){if(blocked&&args[0]===s.id){entered.release();await release.promise;}return original.apply(this,args);});
  const controller=new AbortController();const observing=f.runtime.inspectSessionProfile(s.id,s.ownerId,{signal:controller.signal});
  const rejected=assert.rejects(observing,{name:"AbortError"});
  try{await entered.promise;controller.abort();await rejected;assert.equal(await f.runtime.inspectSessionEvents(s.id,s.ownerId),undefined);
    await f.runtime.send(s.id,"Work is not blocked by parent observation");
  }finally{blocked=false;release.release();}
  for(let i=0;i<100;i++){const result=await f.runtime.inspectSessionEvents(s.id,s.ownerId);if(result)return;await new Promise(r=>setTimeout(r,10));}
  assert.fail("Physical inspection slot was not released");
 });

 test("observation refuses generation changes without binding or repairing",async t=>{
  const f=await fixture(t),s=await f.create(),fresh=new CodexAgentRuntime(f.options);
  const original=CodexManagedStore.prototype.read;let reads=0;
  t.mock.method(CodexManagedStore.prototype,"read",async function(this:CodexManagedStore,...args:Parameters<typeof original>){
    const result=await original.apply(this,args);if(args[0]===s.id&&++reads===2&&result)return {...result,generation:"changed-generation"};return result;});
  assert.equal(await fresh.inspectSessionProfile(s.id,s.ownerId),undefined);await assert.rejects(fresh.status(s.id));assert.deepEqual(await f.calls(),[]);
 });

 test("worker observation cancellation retains physical authorization ownership and cannot create a late getter",async t=>{
  const entered=gate(),release=gate();let blocked=true,getters=0,stops=0;
  const runtime:CodexWorkerRuntime={status:async()=>"idle",messages:async()=>[],turn:async()=>undefined,startTurn:async()=>{throw new Error("Unused");},steer:async()=>{},interrupt:async()=>{},stop:async()=>{stops++;},
    inspectSessionProfile:async()=>{getters++;return {version:1,capturedAt:new Date().toISOString(),model:{status:"not_verified"},reasoning:{status:"not_verified"},skills:{status:"not_verified"}};}};
  const bridge=await createCodexWorkerBridge(runtime,{id:"local",runtime:"codex",ownership:"owned",cwd:process.cwd()},{sessionId:"local",ownerId:"owner",generation:"gen"},
    {claimId:"claim",authorize:async control=>{if(control==="observe"&&blocked){entered.release();await release.promise;}}});
  t.after(async()=>{blocked=false;release.release();await bridge.close();});
  const c=bridge.connection,headers={authorization:`Bearer ${c.token}`,"x-minu-runtime-owner":c.ownerId,"x-minu-runtime-session":c.sessionId,"x-minu-runtime-generation":c.generation};
  const abort=new AbortController(),reading=fetch(`${c.endpoint}/session-profile`,{headers,signal:abort.signal});const rejected=assert.rejects(reading,{name:"AbortError"});
  await entered.promise;abort.abort();await rejected;
  const busy=await fetch(`${c.endpoint}/session-profile`,{headers});assert.equal(busy.status,503);await busy.arrayBuffer();
  assert.equal(await new CodexWorkerClient(c).request("status"),"idle");assert.equal(getters,0);assert.equal(stops,0);
  blocked=false;release.release();await new Promise(r=>setTimeout(r,20));assert.equal(getters,0);
  const profile=await new CodexWorkerClient(c).observe("profile",AbortSignal.timeout(2000));assert.ok(profile);assert.equal(getters,1);
  for(const patch of [{"x-minu-runtime-owner":"wrong"},{"x-minu-runtime-generation":"wrong"},{origin:"http://other"}] as Array<Record<string,string>>){
    const denied=await fetch(`${c.endpoint}/session-profile`,{headers:{...headers,...patch}});assert.equal(denied.status,403);await denied.arrayBuffer();}
 });

 test("the optional read deadline returns unavailability without stopping the worker",{timeout:5000},async t=>{
  const entered=gate(),release=gate();let stops=0;
  const runtime:CodexWorkerRuntime={status:async()=>"idle",messages:async()=>[],turn:async()=>undefined,startTurn:async()=>{throw new Error("Unused");},steer:async()=>{},interrupt:async()=>{},stop:async()=>{stops++;},inspectSessionProfile:async()=>{entered.release();await release.promise;return undefined;}};
  const bridge=await createCodexWorkerBridge(runtime,{id:"local",runtime:"codex",ownership:"owned",cwd:process.cwd()},{sessionId:"local",ownerId:"owner",generation:"gen"});
  try{const client=new CodexWorkerClient(bridge.connection);const failed=assert.rejects(client.observe("profile",AbortSignal.timeout(2000)));await entered.promise;await failed;
    assert.equal(stops,0);assert.equal(await client.request("status"),"idle");assert.equal(await client.observe("profile",AbortSignal.timeout(2000)),undefined);
  }finally{release.release();await bridge.close();}
 });

 for(const fault of ["oversized","malformed","extensions"] as const)test(`observation ${fault} transport is bounded and explicitly projected`,async t=>{
  const f=await fixture(t),s=await f.create(),original=globalThis.fetch;
  t.mock.method(globalThis,"fetch",async(input:Parameters<typeof fetch>[0],init?:Parameters<typeof fetch>[1])=>{
    if(String(input).endsWith("/session-profile")){
      assert.equal(init?.redirect,"error");const body=fault==="oversized"?"x".repeat(16385):fault==="malformed"?"bad-json":JSON.stringify({profile:{version:1,capturedAt:new Date().toISOString(),model:{status:"verified",provider:"/private/provider",id:"hidden"},reasoning:{status:"not_verified"},skills:{status:"not_verified"},secret:"PRIVATE_TOKEN"},secret:"PRIVATE_TOKEN"});
      return new Response(body,{headers:{"content-type":"application/json"}});
    }
    return original(input,init);
  });
  const result=await f.runtime.inspectSessionProfile(s.id,s.ownerId);
  if(fault==="extensions"){assert.ok(result);assert.equal(result.model.status,"not_verified");assert.equal(JSON.stringify(result).includes("PRIVATE_"),false);}
  else assert.equal(result,undefined);
  assert.deepEqual(await f.calls(),[]);
 });

 const desktopUnavailable=process.platform!=="darwin"||Boolean(process.env.SSH_CONNECTION||process.env.SSH_TTY);
 function stubViewer(t:TestContext,code=0){const cp=createRequire(import.meta.url)("node:child_process") as typeof import("node:child_process");const launches:any[]=[];
  const mock=t.mock.method(cp,"spawn",((...args:any[])=>{launches.push(args);const child=new EventEmitter() as any;child.kill=()=>true;queueMicrotask(()=>child.emit("exit",code,null));return child;}) as typeof cp.spawn);
  syncBuiltinESMExports();t.after(()=>{mock.mock.restore();syncBuiltinESMExports();});return launches;}

 test("explicit diagnostic opens only a private bounded sanitized snapshot with a fixed viewer",{skip:desktopUnavailable},async t=>{
  assert.equal(await diagnosticAvailable(),true);const f=await fixture(t),s=await f.create();await f.runtime.send(s.id,"PRIVATE_PROMPT");
  const launches=stubViewer(t);const before=await readFile(f.manifest(s.id),"utf8");await f.runtime.openDiagnostic(s.id);await f.runtime.openDiagnostic(s.id);
  assert.equal(launches.length,2);assert.equal(launches[0][0],"/usr/bin/open");assert.deepEqual(launches[0][1],["-a","/System/Applications/TextEdit.app","--",f.diagnostic(s.id)]);assert.equal(launches[0][2].shell,false);
  const data=await readFile(f.diagnostic(s.id),"utf8");assert.ok(Buffer.byteLength(data)<=65536);assert.equal(data.includes("PRIVATE_PROMPT"),false);assert.equal(data.includes(f.directory),false);
  assert.equal((await stat(f.diagnostic(s.id))).mode&0o777,0o600);assert.equal((await stat(join(f.root,createHash("sha256").update(s.ownerId).digest("hex"),".diagnostics"))).mode&0o777,0o700);
  assert.equal(await readFile(f.manifest(s.id),"utf8"),before);assert.equal(await f.runtime.status(s.id),"idle");
 });
 for(const fault of ["symlink","hardlink","public"] as const)test(`diagnostic ${fault} is refused without touching native data or launching`,{skip:desktopUnavailable},async t=>{
  const f=await fixture(t),s=await f.create(),launches=stubViewer(t);await f.runtime.openDiagnostic(s.id);const target=join(f.directory,"native-history-marker");await writeFile(target,"DO NOT DELETE",{mode:0o600});
  if(fault==="public")await chmod(f.diagnostic(s.id),0o644);else{await rm(f.diagnostic(s.id));if(fault==="symlink")await symlink(target,f.diagnostic(s.id));else await link(target,f.diagnostic(s.id));}
  await assert.rejects(f.runtime.openDiagnostic(s.id),/unavailable/);assert.equal(launches.length,1);assert.equal(await readFile(target,"utf8"),"DO NOT DELETE");
 });
 test("diagnostic revalidates authority after publication and does not launch across a fence",{skip:desktopUnavailable},async t=>{
  const f=await fixture(t),s=await f.create(),launches=stubViewer(t),original=CodexManagedStore.prototype.read;
  t.mock.method(CodexManagedStore.prototype,"read",async function(this:CodexManagedStore,...args:Parameters<typeof original>){const result=await original.apply(this,args);if(args[0]===s.id&&result&&await stat(f.diagnostic(s.id)).then(()=>true,()=>false))return {...result,requiresExplicitResume:true};return result;});
  await assert.rejects(f.runtime.openDiagnostic(s.id));assert.equal(launches.length,0);
 });
 test("viewer exit failure does not fabricate open success",{skip:desktopUnavailable},async t=>{const f=await fixture(t),s=await f.create(),launches=stubViewer(t,1);await assert.rejects(f.runtime.openDiagnostic(s.id));assert.equal(launches.length,1);});
 test("known headless conditions expose no desktop action",async t=>{const saved=process.env.SSH_CONNECTION;process.env.SSH_CONNECTION="owned headless fixture";try{assert.equal(await diagnosticAvailable(),false);const f=await fixture(t),s=await f.create();await assert.rejects(f.runtime.openDiagnostic(s.id));}finally{if(saved===undefined)delete process.env.SSH_CONNECTION;else process.env.SSH_CONNECTION=saved;}});
