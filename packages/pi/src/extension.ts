import { randomBytes } from "node:crypto";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AgentStatus } from "@minu/runtime-core";
import { normalizeSessionEntries } from "./messages.js";
import { removeRegistration, writeRegistration } from "./registry.js";
import { createPiBridgeServer, SessionBusyError, type PiBridgeServer } from "./server.js";

interface PendingTurn {
  operationId: string;
  resolve(): void;
  reject(error: Error): void;
}

export default function runtimePiExtension(pi: ExtensionAPI): void {
  let bridge: PiBridgeServer | undefined;
  let sessionId: string | undefined;
  let status: AgentStatus = "offline";
  let pending: PendingTurn | undefined;

  const setStatus = (next: AgentStatus): void => {
    if (status === next) return;
    status = next;
    if (sessionId) {
      bridge?.publish({
        type: "status",
        sessionId,
        status,
        timestamp: new Date().toISOString(),
      });
    }
  };

  const injectTurn = (
    ctx: ExtensionContext,
    input: string,
    operationId: string,
  ): Promise<void> => {
    if (!bridge || !sessionId) throw new Error("MinuRuntime is disconnected");
    if (!ctx.isIdle() || pending) throw new SessionBusyError("Pi session is working");
    return new Promise<void>((resolve, reject) => {
      pending = { operationId, resolve, reject };
      setStatus("working");
      bridge?.publish({
        type: "turn_started",
        sessionId: sessionId!,
        operationId,
        timestamp: new Date().toISOString(),
      });
      try {
        pi.sendUserMessage(input);
      } catch (error) {
        pending = undefined;
        setStatus("idle");
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  };

  const connect = async (ctx: ExtensionContext, notify = true): Promise<void> => {
    if (bridge) {
      if (notify) ctx.ui.notify(`MinuRuntime already connected: ${sessionId}`, "info");
      return;
    }

    sessionId = ctx.sessionManager.getSessionId();
    const connectedSessionId = sessionId;
    const token = randomBytes(32).toString("hex");
    status = ctx.isIdle() ? "idle" : "working";
    const newBridge = await createPiBridgeServer({
      sessionId: connectedSessionId,
      token,
      getStatus: () => status,
      send: (input, operationId) => injectTurn(ctx, input, operationId),
      steer: async (input) => {
        if (status !== "working") {
          throw new SessionBusyError("Pi session must be working to steer it");
        }
        pi.sendUserMessage(input, { deliverAs: "steer" });
      },
      interrupt: async () => {
        if (status !== "working") {
          throw new SessionBusyError("Pi session must be working to interrupt it");
        }
        ctx.abort();
      },
      getMessages: async () => normalizeSessionEntries(ctx.sessionManager.getBranch()),
    });

    try {
      await writeRegistration({
        sessionId: connectedSessionId,
        endpoint: newBridge.endpoint,
        token,
        pid: process.pid,
        cwd: ctx.cwd,
        sessionFile: ctx.sessionManager.getSessionFile(),
        ownership: "attached",
        updatedAt: new Date().toISOString(),
      });
      bridge = newBridge;
    } catch (error) {
      await newBridge.close();
      sessionId = undefined;
      status = "offline";
      throw error;
    }

    ctx.ui.setStatus("minu-runtime", `runtime ${connectedSessionId.slice(0, 8)} · ${status}`);
    if (notify) ctx.ui.notify(`MinuRuntime connected: ${connectedSessionId}`, "info");
  };

  const disconnect = async (
    ctx: ExtensionContext,
    force = false,
    notify = true,
  ): Promise<boolean> => {
    if (!bridge || !sessionId) {
      ctx.ui.setStatus("minu-runtime", undefined);
      if (notify) ctx.ui.notify("MinuRuntime is already disconnected", "info");
      return true;
    }
    if (!force && (!ctx.isIdle() || pending)) {
      if (notify) ctx.ui.notify("Wait for Pi to become idle before disconnecting", "warning");
      return false;
    }

    const disconnectedSessionId = sessionId;
    const closingBridge = bridge;
    setStatus("offline");
    if (force) {
      pending?.reject(new Error("Pi session disconnected before the turn completed"));
      pending = undefined;
    }
    ctx.ui.setStatus("minu-runtime", undefined);
    bridge = undefined;
    sessionId = undefined;
    status = "offline";
    await closingBridge.close();
    await removeRegistration(disconnectedSessionId);
    if (notify) ctx.ui.notify("MinuRuntime disconnected", "info");
    return true;
  };

  pi.registerCommand("runtime-disconnect", {
    description: "Disconnect this Pi session from MinuRuntime",
    handler: async (_args, ctx) => {
      await disconnect(ctx);
    },
  });

  pi.registerCommand("runtime-connect", {
    description: "Reconnect this Pi session to MinuRuntime",
    handler: async (_args, ctx) => {
      await connect(ctx);
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    await connect(ctx);
  });

  pi.on("message_update", (event) => {
    if (event.assistantMessageEvent.type === "text_delta" && sessionId) {
      bridge?.publish({
        type: "message_delta",
        sessionId,
        delta: event.assistantMessageEvent.delta,
        timestamp: new Date().toISOString(),
      });
    }
  });

  pi.on("tool_execution_start", (event) => {
    if (!sessionId) return;
    bridge?.publish({
      type: "tool_started",
      sessionId,
      toolCallId: event.toolCallId,
      toolName: event.toolName,
      timestamp: new Date().toISOString(),
    });
  });

  pi.on("tool_execution_end", (event) => {
    if (!sessionId) return;
    bridge?.publish({
      type: "tool_completed",
      sessionId,
      toolCallId: event.toolCallId,
      toolName: event.toolName,
      isError: event.isError,
      timestamp: new Date().toISOString(),
    });
  });

  pi.on("agent_start", (_event, ctx) => {
    if (!bridge || !sessionId) return;
    setStatus("working");
    ctx.ui.setStatus("minu-runtime", `runtime ${sessionId.slice(0, 8)} · working`);
  });

  pi.on("agent_settled", (_event, ctx) => {
    if (!bridge || !sessionId) return;
    const completed = pending;
    if (completed) {
      bridge.publish({
        type: "turn_completed",
        sessionId,
        operationId: completed.operationId,
        timestamp: new Date().toISOString(),
      });
      pending = undefined;
      completed.resolve();
    }
    setStatus("idle");
    ctx.ui.setStatus("minu-runtime", `runtime ${sessionId.slice(0, 8)} · idle`);
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    await disconnect(ctx, true, false);
  });
}
