import { createHash, randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type {
  AgentEvent,
  AgentStatus,
  AgentTurn,
  RuntimeMessage,
  RuntimeSessionCapabilities,
  RuntimeSessionProfile,
  RuntimeImageContent,
} from "@minu/runtime-core";
import { sessionProfile, SESSION_PROFILE_LIMITS, SESSION_EVENTS_LIMITS, runtimeInput, RuntimeInputError, RUNTIME_INPUT_LIMITS } from "@minu/runtime-core";
import { SessionEventLog } from "./session-events.js";

const MAX_INPUT_BYTES = 1024 * 1024;
const DEFAULT_TURN_RETENTION_LIMIT = 1_000;

export class SessionBusyError extends Error {}

export interface PiBridgeServerOptions {
  sessionId: string;
  token: string;
  getStatus(): AgentStatus;
  send(input: string, operationId: string, images?: RuntimeImageContent[]): Promise<void>;
  /** Must reflect the active model; absent adapters reject image input. */
  supportsImages?(): Promise<boolean>;
  steer?(input: string): Promise<void>;
  interrupt?(): Promise<void>;
  openDiagnostic?(): Promise<void>;
  getMessages?(): Promise<RuntimeMessage[]>;
  managedSession?: { id: string; ownerId: string };
  getSessionProfile?(signal: AbortSignal): Promise<RuntimeSessionProfile>;
  stop?(): Promise<void> | void;
  /** Managed sessions reject stop unless idle, closing the send/stop race at admission. */
  stopRequiresIdle?: boolean;
  /** Completed turn ids remain idempotent within this bounded, insertion-ordered window. */
  turnRetentionLimit?: number;
}

export interface PiBridgeServer {
  endpoint: string;
  publish(event: AgentEvent): void;
  close(): Promise<void>;
}

async function readJson(request: IncomingMessage, limit = MAX_INPUT_BYTES): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > limit) {
      request.resume();
      throw new RuntimeInputError("Input transport is too large", 413);
    }
    chunks.push(buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(`${JSON.stringify(body)}\n`);
}

export async function createPiBridgeServer(options: PiBridgeServerOptions): Promise<PiBridgeServer> {
  const streams = new Set<ServerResponse>();
  const turns = new Map<string, AgentTurn>();
  // Only hashes survive dispatch. Do not retain or return image bytes in turn polling.
  const fingerprints = new Map<string, string>();
  const turnRetentionLimit = options.turnRetentionLimit ?? DEFAULT_TURN_RETENTION_LIMIT;
  if (!Number.isSafeInteger(turnRetentionLimit) || turnRetentionLimit < 1) {
    throw new Error("turnRetentionLimit must be a positive integer");
  }
  // Track executions by object identity: an evicted caller ID can be reused while
  // an older canceled read with that same ID is still physically outstanding.
  let activeTurn: AgentTurn | undefined;
  let dispatchingTurn: AgentTurn | undefined;
  let stopRequested = false;
  let profileReading = false;
  let eventsReading = false;
  const eventLog = options.managedSession ? new SessionEventLog() : undefined;

  const assertImageSupport = async (images: RuntimeImageContent[]): Promise<void> => {
    if (images.length && (await options.supportsImages?.()) !== true) throw new RuntimeInputError("Image input is not supported by this session's active model");
  };

  const dispatch = async (input: string, operationId: string, images: RuntimeImageContent[] = []): Promise<void> => {
    eventLog?.record("turn_dispatch_requested");
    try {
      await options.send(input, operationId, images.length ? images : undefined);
      eventLog?.record("turn_dispatch_returned");
    } catch (error) {
      eventLog?.record("turn_dispatch_failed");
      if (images.length && !(error instanceof SessionBusyError)) throw new Error("Image dispatch failed");
      throw error;
    }
  };

  const copyTurn = (turn: AgentTurn): AgentTurn => ({
    ...turn,
    response: turn.response ? { ...turn.response } : undefined,
  });

  const pruneTurns = (): void => {
    if (turns.size <= turnRetentionLimit) return;
    for (const [id, candidate] of turns) {
      if (candidate.status === "running") continue;
      turns.delete(id);
      fingerprints.delete(id);
      if (turns.size <= turnRetentionLimit) return;
    }
  };

  const messageEquals = (left: RuntimeMessage, right: RuntimeMessage): boolean =>
    left.role === right.role
    && left.content === right.content
    && left.timestamp === right.timestamp
    && left.toolName === right.toolName;

  const runTurn = async (turn: AgentTurn, images: RuntimeImageContent[]): Promise<void> => {
    const interrupted = () => turn.status === "interrupted";
    try {
      const before = await options.getMessages?.() ?? [];
      if (interrupted()) return;
      dispatchingTurn = turn;
      await dispatch(turn.input, turn.id, images);
      if (interrupted()) return;
      const after = await options.getMessages?.() ?? [];
      if (interrupted()) return;
      let sharedPrefix = 0;
      while (sharedPrefix < before.length && sharedPrefix < after.length
        && messageEquals(before[sharedPrefix]!, after[sharedPrefix]!)) sharedPrefix += 1;
      const responseMessage = after
        .slice(sharedPrefix)
        .reverse()
        .find((message) => message.role === "assistant");
      if (!responseMessage) throw new Error("Agent turn produced no assistant response");
      turn.status = "completed";
      turn.response = { ...responseMessage };
      turn.updatedAt = new Date().toISOString();
      eventLog?.record("turn_completed");
    } catch (error) {
      if (interrupted()) return;
      turn.status = "failed";
      turn.error = images.length ? "Image turn failed" : error instanceof Error ? error.message : String(error);
      turn.updatedAt = new Date().toISOString();
      eventLog?.record("turn_failed");
    } finally {
      if (activeTurn === turn) activeTurn = undefined;
      if (dispatchingTurn === turn) dispatchingTurn = undefined;
      pruneTurns();
    }
  };

  const publish = (event: AgentEvent): void => {
    const frame = `data: ${JSON.stringify(event)}\n\n`;
    for (const stream of streams) stream.write(frame);
  };

  const server = createServer(async (request, response) => {
    let observeBusy = false;
    try {
      if (request.headers.authorization !== `Bearer ${options.token}`) {
        json(response, 401, { error: "Unauthorized" });
        return;
      }

      const url = new URL(request.url ?? "/", "http://runtime.local");
      observeBusy = request.method === "POST" && ["/turns", "/send", "/steer", "/interrupt", "/stop"].includes(url.pathname);
      if (request.method === "GET" && url.pathname === "/status") {
        json(response, 200, { sessionId: options.sessionId, status: options.getStatus() });
        return;
      }

      if (request.method === "GET" && url.pathname === "/input-capabilities") {
        response.setHeader("cache-control", "no-store");
        json(response, 200, { capabilities: { version: 1, images: (await options.supportsImages?.()) === true } });
        return;
      }

      if (request.method === "GET" && url.pathname === "/capabilities") {
        const capabilities: RuntimeSessionCapabilities = {
          version: 1,
          safeActivityEvents: true,
          interrupt: Boolean(options.interrupt),
          reconnectExisting: true,
          interactiveAttach: false,
          openDiagnostic: Boolean(options.openDiagnostic),
          liveSkillVerification: false,
        };
        json(response, 200, { capabilities });
        return;
      }

      if (url.pathname === "/session-profile") {
        response.setHeader("cache-control", "no-store");
        if (!options.managedSession || !options.getSessionProfile
          || request.headers["x-minu-runtime-owner"] !== options.managedSession.ownerId
          || request.headers["x-minu-runtime-session"] !== options.managedSession.id) {
          json(response, 404, { error: "Session profile unavailable" }); return;
        }
        if (request.method !== "GET") { json(response, 405, { error: "Read-only resource" }); return; }
        if (profileReading || stopRequested || options.getStatus() === "offline") { json(response, 503, { error: "Session profile unavailable" }); return; }
        profileReading = true;
        const controller = new AbortController();
        const closed = () => controller.abort();
        response.once("close", closed);
        const timer = setTimeout(closed, SESSION_PROFILE_LIMITS.readMs);
        const task = Promise.resolve().then(() => options.getSessionProfile!(controller.signal));
        // A getter ignoring cancellation must retain the single physical slot until it settles.
        void task.then(() => { profileReading = false; }, () => { profileReading = false; });
        try {
          const value = await Promise.race([task, new Promise<never>((_, reject) => {
            const aborted = () => reject(new Error("Session profile unavailable"));
            controller.signal.addEventListener("abort", aborted, { once: true });
            if (controller.signal.aborted) aborted();
          })]);
          controller.signal.throwIfAborted();
          if (!response.destroyed) json(response, 200, { profile: sessionProfile(value) });
        } catch { if (!response.destroyed) json(response, 503, { error: "Session profile unavailable" }); }
        finally { clearTimeout(timer); response.off("close", closed); }
        return;
      }

      if (url.pathname === "/session-events") {
        response.setHeader("cache-control", "no-store");
        if (!eventLog || !options.managedSession
          || request.headers["x-minu-runtime-owner"] !== options.managedSession.ownerId
          || request.headers["x-minu-runtime-session"] !== options.managedSession.id) {
          json(response, 404, { error: "Session events unavailable" }); return;
        }
        if (request.method !== "GET") { json(response, 405, { error: "Read-only resource" }); return; }
        let available = false;
        try { available = options.getStatus() !== "offline"; } catch {}
        if (url.search || eventsReading || !available) {
          json(response, 503, { error: "Session events unavailable" }); return;
        }
        // Snapshot work is synchronous and bounded; retain the response slot until physical delivery ends.
        eventsReading = true;
        const timer = setTimeout(() => response.destroy(), SESSION_EVENTS_LIMITS.readMs);
        const release = () => {
          clearTimeout(timer);
          eventsReading = false;
          response.off("finish", release);
          response.off("close", release);
        };
        response.once("finish", release);
        response.once("close", release);
        try { json(response, 200, { events: eventLog.snapshot() }); }
        catch { json(response, 503, { error: "Session events unavailable" }); }
        return;
      }

      if (request.method === "GET" && url.pathname === "/messages") {
        json(response, 200, { messages: await options.getMessages?.() ?? [] });
        return;
      }

      if (request.method === "GET" && url.pathname === "/events") {
        response.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
          connection: "keep-alive",
        });
        streams.add(response);
        response.write(`data: ${JSON.stringify({
          type: "status",
          sessionId: options.sessionId,
          status: options.getStatus(),
          timestamp: new Date().toISOString(),
        })}\n\n`);
        request.on("close", () => streams.delete(response));
        return;
      }

      if (request.method === "POST" && url.pathname === "/steer") {
        if (stopRequested) throw new SessionBusyError("Pi session is stopping");
        if (!options.steer) {
          json(response, 405, { error: "This Runtime adapter does not support steering" });
          return;
        }
        if (options.getStatus() !== "working") {
          throw new SessionBusyError("Pi session must be working to steer it");
        }
        const body = (await readJson(request)) as { input?: unknown };
        if (typeof body.input !== "string" || body.input.trim().length === 0) {
          json(response, 400, { error: "input must be a non-empty string" });
          return;
        }
        if (stopRequested) throw new SessionBusyError("Pi session is stopping");
        eventLog?.record("steer_requested");
        try { await options.steer(body.input); }
        catch (error) { eventLog?.record("steer_failed"); throw error; }
        eventLog?.record("steer_acknowledged");
        json(response, 202, { status: "steering" });
        return;
      }

      const turnMatch = url.pathname.match(/^\/turns\/(.+)$/);
      if (request.method === "GET" && turnMatch) {
        const turnId = decodeURIComponent(turnMatch[1]!);
        const turn = turns.get(turnId);
        json(response, 200, { turn: turn ? copyTurn(turn) : null });
        return;
      }

      if (request.method === "POST" && url.pathname === "/turns") {
        const body = (await readJson(request, RUNTIME_INPUT_LIMITS.transportBytes)) as { turnId?: unknown; input?: unknown; images?: unknown };
        if (typeof body.turnId !== "string" || !body.turnId.trim() || body.turnId.length > 512) {
          json(response, 400, { error: "turnId must be a non-empty string of at most 512 characters" });
          return;
        }
        const content = runtimeInput(body.input, body.images);
        const fingerprint = createHash("sha256").update(JSON.stringify(content)).digest("hex");
        const turnId = body.turnId;
        const replay = (): boolean => {
          const existing = turns.get(turnId);
          if (!existing) return false;
          if (fingerprints.get(turnId) !== fingerprint) {
            eventLog?.record("turn_rejected_conflict");
            json(response, 409, { error: "turnId is already associated with different input" });
          } else {
            eventLog?.record("turn_reused");
            json(response, 200, { turn: copyTurn(existing) });
          }
          return true;
        };
        if (replay()) return;
        await assertImageSupport(content.images);
        if (replay()) return;
        // Recheck admission after the model capability read, including pending-body races.
        if (stopRequested) throw new SessionBusyError("Pi session is stopping");
        if (options.getStatus() !== "idle" || activeTurn) {
          throw new SessionBusyError("Pi session is working");
        }
        const timestamp = new Date().toISOString();
        const turn: AgentTurn = {
          id: body.turnId,
          status: "running",
          input: content.input,
          createdAt: timestamp,
          updatedAt: timestamp,
        };
        turns.set(turn.id, turn);
        fingerprints.set(turn.id, fingerprint);
        activeTurn = turn;
        eventLog?.record("turn_accepted");
        void runTurn(turn, content.images);
        json(response, 202, { turn: copyTurn(turn) });
        return;
      }

      if (request.method === "POST" && url.pathname === "/interrupt") {
        if (stopRequested) throw new SessionBusyError("Pi session is stopping");
        if (!options.interrupt) {
          json(response, 405, { error: "This Runtime adapter does not support interruption" });
          return;
        }
        const turn = activeTurn;
        const preparing = turn?.status === "running" && dispatchingTurn !== turn;
        if (!preparing && options.getStatus() !== "working") {
          throw new SessionBusyError("Pi session must be working to interrupt it");
        }
        eventLog?.record("interrupt_requested");
        try { if (!preparing) await options.interrupt(); }
        catch (error) { eventLog?.record("interrupt_failed"); throw error; }
        eventLog?.record("interrupt_acknowledged");
        if (turn) {
          turn.status = "interrupted";
          turn.updatedAt = new Date().toISOString();
          if (preparing && activeTurn === turn) activeTurn = undefined;
        }
        json(response, 202, { status: "interrupting" });
        return;
      }

      if (request.method === "POST" && url.pathname === "/diagnostic/open") {
        if (!options.openDiagnostic) {
          json(response, 405, { error: "This Runtime session has no local diagnostic" });
          return;
        }
        await options.openDiagnostic();
        json(response, 202, { status: "opened" });
        return;
      }

      if (request.method === "POST" && url.pathname === "/send") {
        if (stopRequested) throw new SessionBusyError("Pi session is stopping");
        if (options.getStatus() !== "idle" || activeTurn) {
          throw new SessionBusyError("Pi session is working");
        }
        const body = (await readJson(request, RUNTIME_INPUT_LIMITS.transportBytes)) as { input?: unknown; images?: unknown };
        const content = runtimeInput(body.input, body.images);
        await assertImageSupport(content.images);
        if (stopRequested) throw new SessionBusyError("Pi session is stopping");
        if (options.getStatus() !== "idle" || activeTurn) throw new SessionBusyError("Pi session is working");
        const operationId = randomUUID();
        await dispatch(content.input, operationId, content.images);
        json(response, 200, { operationId, status: "completed" });
        return;
      }

      if (request.method === "POST" && url.pathname === "/stop") {
        if (!options.stop) {
          json(response, 405, { error: "Attached Pi sessions cannot be stopped by Runtime" });
          return;
        }
        if (stopRequested) {
          json(response, 202, { status: "stopping" });
          return;
        }
        if (options.stopRequiresIdle && (options.getStatus() !== "idle" || activeTurn)) {
          throw new SessionBusyError("A working Pi session cannot be stopped for suspend or destroy");
        }
        stopRequested = true;
        eventLog?.record("stop_requested");
        json(response, 202, { status: "stopping" });
        setImmediate(() => void options.stop?.());
        return;
      }

      json(response, 404, { error: "Not found" });
    } catch (error) {
      if (observeBusy && error instanceof SessionBusyError) eventLog?.record("request_rejected_busy");
      const status = error instanceof SessionBusyError ? 409 : error instanceof RuntimeInputError ? error.status : 500;
      json(response, status, { error: error instanceof Error ? error.message : String(error) });
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address() as AddressInfo;
  eventLog?.record("bridge_ready");

  return {
    endpoint: `http://127.0.0.1:${address.port}`,
    publish,
    async close() {
      for (const stream of streams) stream.end();
      streams.clear();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}
