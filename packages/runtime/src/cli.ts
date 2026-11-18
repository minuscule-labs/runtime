#!/usr/bin/env node
import { Command, Option } from "commander";
import { open } from "node:fs/promises";
import { constants } from "node:fs";
import { extname, resolve } from "node:path";
import { createRuntime, runtimeReference, CodexAgentRuntime, runtimeInput, RUNTIME_INPUT_LIMITS,
  type AgentRuntime, type AgentStartConfig, type AgentEvent, type RuntimeAdapterId, type RuntimeImageContent } from "./index.js";
import { listRegistrations, readRegistration } from "@minu/runtime-pi";

function render(event: AgentEvent): void {
  if (event.type === "message_delta") process.stdout.write(event.delta);
  else if (event.type === "tool_started") console.log(`\n[tool] ${event.toolName}`);
  else if (event.type === "tool_completed" && event.isError) console.log(`[tool error] ${event.toolName}`);
  else if (event.type === "status") console.log(`[status] ${event.status}`);
  else if (event.type === "error") console.error(`[error] ${event.message}`);
}
async function images(paths: string[] = []): Promise<RuntimeImageContent[]> {
  if (paths.length > RUNTIME_INPUT_LIMITS.images) throw new Error("Too many CLI images");
  const content: RuntimeImageContent[] = []; let total = 0;
  for (const path of paths) {
    let handle;
    try {
      const types: Record<string, RuntimeImageContent["mimeType"]> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp" };
      const mimeType = types[extname(path).toLowerCase()]; if (!mimeType) throw new Error("Invalid");
      handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      const stat = await handle.stat(); if (!stat.isFile() || stat.size > RUNTIME_INPUT_LIMITS.imageBytes || total + stat.size > RUNTIME_INPUT_LIMITS.totalImageBytes) throw new Error("Invalid");
      const buffer = Buffer.alloc(RUNTIME_INPUT_LIMITS.imageBytes + 1); let length = 0;
      while (length < buffer.length) { const read = await handle.read(buffer, length, buffer.length - length, length); if (!read.bytesRead) break; length += read.bytesRead; }
      if (length > RUNTIME_INPUT_LIMITS.imageBytes || total + length > RUNTIME_INPUT_LIMITS.totalImageBytes) throw new Error("Invalid");
      total += length;
      content.push({ type: "image", mimeType, data: buffer.subarray(0, length).toString("base64") });
    } catch { throw new Error("CLI image input is invalid or exceeds bounds"); }
    finally { await handle?.close(); }
  }
  return content;
}
async function follow(runtime: AgentRuntime, id: string, input: string, pixels: RuntimeImageContent[]): Promise<void> {
  const iterator = runtime.events(id)[Symbol.asyncIterator]();
  try {
    const initial = await iterator.next(); if (initial.done) throw new Error("Event stream unavailable"); render(initial.value);
    const sending = runtime.send(id, input, pixels.length ? pixels : undefined);
    const observing = (async () => { while (true) { const next = await iterator.next(); if (next.done) throw new Error("Event stream ended before turn completion"); render(next.value); if (next.value.type === "turn_completed") break; } })();
    await Promise.all([sending, observing]);
  } finally { await iterator.return?.(); }
}

/** No parsing or adapter construction occurs when this module is imported. */
export function createRuntimeProgram(): Command {
  const program = new Command().name("minu-runtime").description("Manage native Runtime sessions").showHelpAfterError()
    .addOption(new Option("--adapter <adapter>").choices(["pi", "codex"]))
    .option("--owner <owner-id>").option("--managed-root <path>");
  const runtimes = new Map<RuntimeAdapterId, AgentRuntime>();
  const select = (reference?: string) => {
    const options = program.opts<{ adapter?: RuntimeAdapterId; owner?: string; managedRoot?: string }>();
    const { adapter, id } = runtimeReference(reference ?? "", options.adapter);
    if (options.managedRoot && adapter !== "codex") throw new Error("--managed-root requires Codex");
    let runtime = runtimes.get(adapter);
    if (!runtime) { runtime = adapter === "codex" ? createRuntime("codex", { managedRoot: options.managedRoot ? resolve(options.managedRoot) : undefined }) : createRuntime("pi"); runtimes.set(adapter, runtime); }
    return { adapter, id, runtime, owner: options.owner };
  };
  const owner = (value: string | undefined) => { if (!value) throw new Error("An explicit --owner is required"); return value; };
  const connected = async (reference: string) => {
    const value = select(reference);
    if (value.adapter === "codex") await (value.runtime as CodexAgentRuntime).connectManaged(value.id, owner(value.owner));
    else if (value.owner && (await readRegistration(value.id))?.ownerId !== value.owner) throw new Error("Session is unavailable for this owner");
    return value;
  };
  const qualified = (adapter: RuntimeAdapterId, id: string) => adapter === "codex" ? `codex:${id}` : id;
  const config = (options: { cwd?: string; systemPrompt?: string; appendSystemPrompt?: string; model?: string; modelProvider?: string; reasoning?: AgentStartConfig["reasoningLevel"]; skill?: string[]; skills?: boolean }): AgentStartConfig => {
    if ((options.model === undefined) !== (options.modelProvider === undefined)) throw new Error("--model and --model-provider must be supplied together");
    return { ...(options.cwd !== undefined ? { cwd: options.cwd } : {}), ...(options.systemPrompt !== undefined ? { systemPrompt: options.systemPrompt } : {}),
      ...(options.appendSystemPrompt !== undefined ? { appendSystemPrompt: options.appendSystemPrompt } : {}),
      ...(options.model !== undefined ? { model: { provider: options.modelProvider!, id: options.model } } : {}),
      ...(options.reasoning !== undefined ? { reasoningLevel: options.reasoning } : {}), ...(options.skills === false ? { skillIds: [] } : options.skill ? { skillIds: options.skill } : {}) };
  };
  program.command("start").option("--cwd <path>")
    .addOption(new Option("--system-prompt <text>").conflicts("appendSystemPrompt"))
    .addOption(new Option("--append-system-prompt <text>").conflicts("systemPrompt"))
    .option("--model <id>").option("--model-provider <id>")
    .addOption(new Option("--reasoning <level>").choices(["off", "minimal", "low", "medium", "high", "xhigh", "max"]))
    .option("--skill <id...>").addOption(new Option("--no-skills").conflicts("skill"))
    .action(async options => {
      const value = select(); const launch = config(options);
      const session = value.adapter === "codex" || value.owner ? await value.runtime.startManaged!(launch, owner(value.owner)) : await value.runtime.start(launch);
      console.log(`${qualified(value.adapter, session.id)}\t${session.ownership}\t${session.cwd}`);
    });
  program.command("sessions").action(async () => {
    const value = select();
    if (value.adapter === "codex" || value.owner) {
      for (const session of await value.runtime.listManagedSessions!(owner(value.owner))) console.log(`${qualified(value.adapter, session.id)}\t${session.state}\towned`);
    } else {
      const sessions = await listRegistrations(); if (!sessions.length) console.log("No online Pi sessions.");
      for (const session of sessions) console.log(`${session.sessionId}\t${await value.runtime.status(session.sessionId)}\t${session.ownership ?? "attached"}\t${session.cwd}`);
    }
  });
  for (const method of ["resume", "suspend", "destroy"] as const) program.command(method).argument("<session-id>").action(async reference => {
    const value = select(reference), scopedOwner = owner(value.owner);
    if (method === "resume") { const session = await value.runtime.resume!(value.id, scopedOwner); console.log(`${qualified(value.adapter, session.id)}\t${session.ownership}\t${session.cwd}`); }
    else { await value.runtime[method]!(value.id, scopedOwner); console.log(`${qualified(value.adapter, value.id)} ${method === "suspend" ? "suspended" : "destroyed"}.`); }
  });
  program.command("capabilities").option("--cwd <path>").action(async options => console.log(JSON.stringify(await select().runtime.capabilities!({ cwd: options.cwd }))));
  program.command("status").argument("<session-id>").action(async reference => { const value = await connected(reference); console.log(await value.runtime.status(value.id)); });
  program.command("send").option("--follow").option("--image <path>", "image file", (path: string, previous: string[]) => [...previous, path], []).argument("<session-id>").argument("[message...]").action(async (reference: string, message: string[], options) => {
    const content = runtimeInput(message.join(" "), await images(options.image)); const value = await connected(reference);
    if (options.follow) await follow(value.runtime, value.id, content.input, content.images);
    else { console.log(`Sending to ${qualified(value.adapter, value.id)}; waiting for ${value.adapter === "pi" ? "Pi" : "Codex"} to settle...`);
      await value.runtime.send(value.id, content.input, content.images.length ? content.images : undefined); console.log(value.adapter === "pi" ? `${value.id} is idle.` : `${qualified(value.adapter, value.id)} turn completed.`); }
  });
  program.command("start-turn").option("--image <path>", "image file", (path: string, previous: string[]) => [...previous, path], []).argument("<session-id>").argument("<turn-id>").argument("[message...]").action(async (reference: string, turnId: string, message: string[], options) => {
    const content = runtimeInput(message.join(" "), await images(options.image)), value = await connected(reference);
    console.log(JSON.stringify(await value.runtime.startTurn(value.id, turnId, content.input, content.images.length ? content.images : undefined)));
  });
  program.command("turn").argument("<session-id>").argument("<turn-id>").action(async (reference, turnId) => { const value = await connected(reference); console.log(JSON.stringify(await value.runtime.turn(value.id, turnId) ?? null)); });
  program.command("steer").argument("<session-id>").argument("<message...>").action(async (reference, message: string[]) => { const value = await connected(reference); await value.runtime.steer(value.id, message.join(" ")); console.log(`${qualified(value.adapter, value.id)} accepted the steering message.`); });
  program.command("interrupt").argument("<session-id>").action(async reference => { const value = await connected(reference); await value.runtime.interrupt(value.id); console.log(`${qualified(value.adapter, value.id)} is interrupting.`); });
  program.command("messages").argument("<session-id>").action(async reference => { const value = await connected(reference); for (const message of await value.runtime.messages(value.id)) console.log(`[${message.role}${message.toolName ? `:${message.toolName}` : ""}] ${message.content}`); });
  program.command("watch").argument("<session-id>").action(async reference => { const value = await connected(reference); for await (const event of value.runtime.events(value.id)) render(event); });
  program.command("stop").argument("<session-id>").action(async reference => { const value = await connected(reference); await value.runtime.stop(value.id); console.log(`${qualified(value.adapter, value.id)} stopped.`); });
  for (const kind of ["profile", "observations"] as const) program.command(kind).argument("<session-id>").action(async reference => {
    const value = select(reference), scopedOwner = owner(value.owner);
    const result = kind === "profile" ? await value.runtime.inspectSessionProfile!(value.id, scopedOwner) : await value.runtime.inspectSessionEvents!(value.id, scopedOwner);
    if (!result) throw new Error("Session observation unavailable"); console.log(JSON.stringify(result));
  });
  program.command("diagnostic").argument("<session-id>").action(async reference => { const value = await connected(reference); await value.runtime.openDiagnostic!(value.id); });
  return program;
}
