#!/usr/bin/env node
import { randomBytes } from "node:crypto";
import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { AgentStatus } from "@minu/runtime-core";
import { normalizePiMessages } from "./messages.js";
import { PiRpcProcess, type RpcEvent } from "./pi-rpc.js";
import { removeRegistration, writeRegistration } from "./registry.js";
import { createPiBridgeServer, SessionBusyError, type PiBridgeServer } from "./server.js";

interface PendingTurn {
  operationId: string;
  resolve(): void;
  reject(error: Error): void;
}

function optionalArgument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function argument(name: string): string {
  const value = optionalArgument(name);
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}

const cwd = argument("--cwd");
const readyFile = argument("--ready-file");
const logFile = argument("--log-file");
const systemPromptFile = optionalArgument("--system-prompt-file");
const appendSystemPromptFile = optionalArgument("--append-system-prompt-file");
let rpc: PiRpcProcess | undefined;
let bridge: PiBridgeServer | undefined;
let sessionId: string | undefined;
let status: AgentStatus = "offline";
let pending: PendingTurn | undefined;
let shuttingDown = false;

async function log(text: string): Promise<void> {
  await mkdir(dirname(logFile), { recursive: true });
  await appendFile(logFile, text);
}

function publishStatus(next: AgentStatus): void {
  if (status === next) return;
  status = next;
  if (sessionId) {
    bridge?.publish({ type: "status", sessionId, status, timestamp: new Date().toISOString() });
  }
}

function handleEvent(event: RpcEvent): void {
  if (!sessionId) return;
  const timestamp = new Date().toISOString();
  if (event.type === "agent_start") publishStatus("working");
  else if (event.type === "agent_settled") {
    const completed = pending;
    if (completed) {
      bridge?.publish({ type: "turn_completed", sessionId, operationId: completed.operationId, timestamp });
      pending = undefined;
      completed.resolve();
    }
    publishStatus("idle");
  } else if (event.type === "message_update") {
    const update = event.assistantMessageEvent as Record<string, unknown> | undefined;
    if (update?.type === "text_delta" && typeof update.delta === "string") {
      bridge?.publish({ type: "message_delta", sessionId, delta: update.delta, timestamp });
    }
  } else if (event.type === "tool_execution_start") {
    if (typeof event.toolCallId === "string" && typeof event.toolName === "string") {
      bridge?.publish({
        type: "tool_started",
        sessionId,
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        timestamp,
      });
    }
  } else if (event.type === "tool_execution_end") {
    if (typeof event.toolCallId === "string" && typeof event.toolName === "string") {
      bridge?.publish({
        type: "tool_completed",
        sessionId,
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        isError: event.isError === true,
        timestamp,
      });
    }
  } else if (event.type === "extension_error" || event.type === "rpc_parse_error") {
    bridge?.publish({ type: "error", sessionId, message: String(event.error ?? event.type), timestamp });
  }
}

async function inject(input: string, operationId: string): Promise<void> {
  if (!rpc || status !== "idle" || pending) throw new SessionBusyError("Pi session is working");
  return new Promise<void>((resolve, reject) => {
    pending = { operationId, resolve, reject };
    publishStatus("working");
    bridge?.publish({
      type: "turn_started",
      sessionId: sessionId!,
      operationId,
      timestamp: new Date().toISOString(),
    });
    void rpc!.request("prompt", { message: input }).catch((error) => {
      pending = undefined;
      publishStatus("idle");
      reject(error instanceof Error ? error : new Error(String(error)));
    });
  });
}

async function steer(input: string): Promise<void> {
  if (!rpc || status !== "working" || !pending) {
    throw new SessionBusyError("Pi session must be working to steer it");
  }
  await rpc.request("steer", { message: input });
}

async function interrupt(): Promise<void> {
  if (!rpc || status !== "working") {
    throw new SessionBusyError("Pi session must be working to interrupt it");
  }
  await rpc.request("abort");
}

async function shutdown(exitCode = 0): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  publishStatus("offline");
  pending?.reject(new Error("Runtime-owned Pi session stopped before the turn completed"));
  pending = undefined;
  await rpc?.stop().catch((error) => log(`Failed to stop Pi: ${String(error)}\n`));
  await bridge?.close().catch((error) => log(`Failed to close bridge: ${String(error)}\n`));
  if (sessionId) await removeRegistration(sessionId);
  process.exit(exitCode);
}

async function main(): Promise<void> {
  await mkdir(dirname(readyFile), { recursive: true });
  rpc = new PiRpcProcess(cwd, (text) => void log(text), {
    systemPromptFile,
    appendSystemPromptFile,
  });
  rpc.onEvent(handleEvent);
  rpc.onExit((_code, _signal) => {
    if (!shuttingDown) void shutdown(1);
  });

  const state = (await rpc.request("get_state")) as Record<string, unknown>;
  if (typeof state.sessionId !== "string") throw new Error("Pi RPC did not return a session id");
  sessionId = state.sessionId;
  status = state.isStreaming === true ? "working" : "idle";
  const token = randomBytes(32).toString("hex");
  bridge = await createPiBridgeServer({
    sessionId,
    token,
    getStatus: () => status,
    send: inject,
    steer,
    interrupt,
    getMessages: async () => {
      const data = (await rpc!.request("get_messages")) as { messages?: unknown[] };
      return normalizePiMessages(data.messages ?? []);
    },
    stop: () => shutdown(),
  });
  await writeRegistration({
    sessionId,
    endpoint: bridge.endpoint,
    token,
    pid: process.pid,
    cwd,
    sessionFile: typeof state.sessionFile === "string" ? state.sessionFile : undefined,
    ownership: "owned",
    logFile,
    updatedAt: new Date().toISOString(),
  });
  await writeFile(readyFile, `${JSON.stringify({ sessionId })}\n`, { mode: 0o600 });
}

process.on("SIGINT", () => void shutdown(130));
process.on("SIGTERM", () => void shutdown(143));

main().catch(async (error) => {
  await log(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`).catch(() => {});
  await writeFile(readyFile, `${JSON.stringify({ error: error instanceof Error ? error.message : String(error) })}\n`).catch(
    () => {},
  );
  await shutdown(1);
});
