import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { runtimeInput, RuntimeInputError, RUNTIME_INPUT_LIMITS, SESSION_PROFILE_LIMITS, SESSION_EVENTS_LIMITS, sessionProfile, sessionEvents } from "@minu/runtime-core";
import type { AgentRuntime, AgentSession, RuntimeSessionEventCode } from "@minu/runtime-core";
import { CodexSessionBusyError, CodexSessionOfflineError } from "./client.js";
import { record } from "./rpc.js";
import { EVENT_LIMITS } from "./event-stream.js";
import { serveCodexEvents } from "./worker-events.js";

import { validateWorkerIdentity, type CodexWorkerIdentity, type CodexWorkerConnection } from "./worker-identity.js";
export { validateWorkerIdentity, type CodexWorkerIdentity, type CodexWorkerConnection } from "./worker-identity.js";
const BODY_LIMIT = RUNTIME_INPUT_LIMITS.transportBytes;
const RESPONSE_LIMIT = 8 * 1024 * 1024;

class BridgeError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

function json(response: ServerResponse, status: number, value: unknown): void {
  let data = JSON.stringify(value);
  if (Buffer.byteLength(data) > RESPONSE_LIMIT) {
    status = 413;
    data = JSON.stringify({ error: "Bridge response exceeds limit" });
  }
  response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  response.end(data);
}

async function readBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > BODY_LIMIT) throw new BridgeError(413, "Bridge request exceeds limit");
    chunks.push(chunk);
  }
  try {
    const body = record(JSON.parse(Buffer.concat(chunks).toString("utf8")));
    if (body) return body;
  } catch {}
  throw new BridgeError(400, "Invalid bridge request");
}

export type CodexWorkerRuntime = Pick<AgentRuntime, "status" | "messages" | "turn" | "startTurn" | "steer" | "interrupt" | "stop"> & Partial<Pick<AgentRuntime, "events" | "inputCapabilities" | "sessionCapabilities" | "inspectSessionProfile" | "inspectSessionEvents">>
  & { recordSessionEvent?(code: RuntimeSessionEventCode): void };

/** Internal RPC boundary only; no discovery, persistence, native resume, or managed API. */
export async function createCodexWorkerBridge(
  runtime: CodexWorkerRuntime,
  session: AgentSession,
  identity: CodexWorkerIdentity,
  registration?: { claimId: string; authorize(control?: "interrupt" | "observe"): Promise<void>; retire?(operationId: string, connection: CodexWorkerConnection): Promise<void>; beforeClose?(): Promise<void> },
): Promise<{ connection: CodexWorkerConnection; closed: Promise<void>; close(): Promise<void> }> {
  validateWorkerIdentity(identity);
  identity = { ...identity };
  const claimId = registration?.claimId, authorize = registration?.authorize.bind(registration);
  const retire = registration?.retire?.bind(registration), beforeClose = registration?.beforeClose?.bind(registration);
  let connection!: CodexWorkerConnection;
  const token = randomBytes(32).toString("hex");
  const authorization = Buffer.from(`Bearer ${token}`);
  let resolveClosed!: () => void;
  const closed = new Promise<void>(resolve => { resolveClosed = resolve; });
  const streams = new Set<AbortController>();
  const reading = new Set<string>();
  const observe = (code: RuntimeSessionEventCode) => { try { runtime.recordSessionEvent?.(code); } catch {} };
  let stopping: Promise<void> | undefined;
  const stopRuntime = () => stopping ??= runtime.stop(session.id);
  const stopForClose = async () => {
    await stopRuntime();
    // Admission is closed; retirement may have sealed during native stop.
    await beforeClose?.();
  };
  let closing: Promise<void> | undefined;
  const close = () => closing ??= (async () => {
    // Never claim shutdown or exit while the app-server's exit is unconfirmed.
    await stopForClose();
    for (const controller of streams) controller.abort();
    await new Promise<void>((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve());
      server.closeAllConnections();
    });
    resolveClosed();
  })();

  const server = createServer({ requestTimeout: 10_000, headersTimeout: 5_000, maxHeaderSize: 8192 }, (request, response) => {
    void (async () => {
      const supplied = Buffer.from(typeof request.headers.authorization === "string" ? request.headers.authorization : "");
      if (supplied.length !== authorization.length || !timingSafeEqual(supplied, authorization)
        || request.headers["x-minu-runtime-owner"] !== identity.ownerId
        || request.headers["x-minu-runtime-session"] !== identity.sessionId
        || request.headers["x-minu-runtime-generation"] !== identity.generation
        || request.headers.origin !== undefined) {
        request.resume();
        json(response, 403, { error: "Bridge access denied" });
        return;
      }
      if (request.url === "/session-profile" || request.url === "/session-events") {
        request.resume();
        if (request.method !== "GET") throw new BridgeError(405, "Read-only resource");
        if (request.headers["transfer-encoding"] || (request.headers["content-length"] && request.headers["content-length"] !== "0")) throw new BridgeError(400, "Unexpected observation body");
        const kind = request.url === "/session-profile" ? "profile" : "events";
        const limits = kind === "profile" ? SESSION_PROFILE_LIMITS : SESSION_EVENTS_LIMITS;
        if (stopping || reading.has(kind)) throw new BridgeError(503, "Observation unavailable");
        reading.add(kind);
        const controller = new AbortController(); let settled = false, delivered = false;
        const release = () => { if (settled && delivered) reading.delete(kind); };
        const finished = () => {
          delivered = true; controller.abort(); clearTimeout(timer); release();
          response.off("close", finished); response.off("finish", finished);
        };
        response.once("close", finished); response.once("finish", finished);
        const timer = setTimeout(() => { controller.abort(); response.destroy(); }, limits.readMs);
        const task = (async () => {
          await authorize?.("observe"); controller.signal.throwIfAborted();
          if (stopping) throw new Error("Unavailable");
          const value = kind === "profile" ? await runtime.inspectSessionProfile?.(session.id, identity.ownerId, { signal: controller.signal })
            : await runtime.inspectSessionEvents?.(session.id, identity.ownerId, { signal: controller.signal });
          if (!value) throw new Error("Unavailable");
          const body = kind === "profile" ? { profile: sessionProfile(value) } : { events: sessionEvents(value) };
          await authorize?.("observe"); controller.signal.throwIfAborted();
          if (stopping || Buffer.byteLength(JSON.stringify(body)) > limits.bytes) throw new Error("Unavailable");
          if (!response.destroyed) json(response, 200, body);
        })();
        void task.then(() => { settled = true; release(); }, () => { settled = true; release(); });
        try { await task; } catch { if (!response.destroyed) json(response, 503, { error: "Observation unavailable" }); }
        finally { if (response.destroyed && !delivered) finished(); }
        return;
      }
      if (request.method === "GET" && request.url === "/events") {
        request.resume();
        if (stopping) throw new BridgeError(409, "Codex worker is stopping");
        if (!runtime.events) throw new BridgeError(404, "Codex event stream is unsupported");
        if (request.headers["transfer-encoding"] || (request.headers["content-length"] && request.headers["content-length"] !== "0")) throw new BridgeError(400, "Unexpected event request body");
        if (streams.size >= EVENT_LIMITS.subscribers) throw new BridgeError(429, "Codex event subscriber limit reached");
        const controller = new AbortController();
        const cancel = () => controller.abort();
        // Cover the first authorization await too, before any source exists.
        response.once("close", cancel);
        streams.add(controller);
        try {
          // Source subscription precedes the handshake. Every delivered event and
          // idle heartbeat re-authorizes, without retaining a lock while waiting.
          await authorize?.();
          if (controller.signal.aborted || response.destroyed) return;
          if (stopping) throw new BridgeError(409, "Codex worker is stopping");
          await serveCodexEvents(request, response, runtime.events(session.id), session.id, { version: 1, ...identity, pid: process.pid,
            ...(claimId !== undefined ? { claimId } : {}) },
            async () => { await authorize?.(); }, controller);
        } finally {
          response.off("close", cancel);
          // Cancellation closes the socket, not the underlying authorization.
          // Retain its slot until that work actually settles.
          streams.delete(controller);
        }
        return;
      }
      if (request.method === "POST" && request.url === "/retire") {
        if (!retire) throw new BridgeError(404, "Codex retirement is unsupported");
        const body = await readBody(request);
        if (Object.keys(body).length !== 4 || Object.keys(body).some(key => !["operationId", "version", "pid", "claimId"].includes(key))
          || typeof body.operationId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(body.operationId)
          || typeof body.claimId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(body.claimId)
          || body.version !== connection.version || body.pid !== connection.pid || body.claimId !== connection.claimId) {
          throw new BridgeError(400, "Invalid Codex retirement request");
        }
        const operationId = body.operationId;
        await retire(operationId, structuredClone(connection));
        // Publication acknowledgment is not bridge closure or physical exit.
        // Cleanup cannot depend on response finish/disconnect events.
        setImmediate(() => { void close().catch(() => { process.exitCode = 1; }); });
        if (!response.destroyed) json(response, 200, { result: { operationId, phase: "native_fact_published" } });
        return;
      }
      if (request.method !== "POST" || request.url !== "/rpc") {
        request.resume();
        json(response, 404, { error: "Not found" });
        return;
      }
      const body = await readBody(request);
      if (stopping) throw new BridgeError(409, "Codex worker is stopping");
      if (Object.keys(body).some(key => !["method", "turnId", "input", ...(body.method === "startTurn" ? ["images"] : [])].includes(key))) {
        throw new BridgeError(400, "Unsupported bridge argument");
      }
      const text = (key: "turnId" | "input") => {
        const value = body[key];
        if (typeof value !== "string" || !value.trim()) throw new BridgeError(400, "Invalid bridge argument");
        return value;
      };
      // Identity is read-only: reconnect must not queue behind allocation and
      // prevent preparation cancellation. Dispatched control retains its fence.
      await authorize?.(body.method === "interrupt" ? "interrupt" : body.method === "identity" ? "observe" : undefined);
      let result: unknown;
      switch (body.method) {
        case "identity": result = { version: 1, ...identity, pid: process.pid,
          ...(claimId !== undefined ? { claimId } : {}) }; break;
        case "status": result = await runtime.status(session.id); break;
        case "inputCapabilities":
          if (!runtime.inputCapabilities) throw new BridgeError(503, "Live input capabilities unavailable");
          result = await runtime.inputCapabilities(session.id); break;
        case "sessionCapabilities":
          if (!runtime.sessionCapabilities) throw new BridgeError(503, "Live session capabilities unavailable");
          result = await runtime.sessionCapabilities(session.id); break;
        case "messages": result = await runtime.messages(session.id); break;
        case "turn": result = await runtime.turn(session.id, text("turnId")) ?? null; break;
        case "startTurn": {
          const content = runtimeInput(body.input, body.images);
          result = await runtime.startTurn(session.id, text("turnId"), content.input, content.images); break;
        }
        case "steer": {
          const input = text("input"); observe("steer_requested");
          try { await runtime.steer(session.id, input); observe("steer_acknowledged"); }
          catch (error) { observe("steer_failed"); throw error; }
          result = null; break;
        }
        case "interrupt":
          observe("interrupt_requested");
          try { await runtime.interrupt(session.id); observe("interrupt_acknowledged"); }
          catch (error) { observe("interrupt_failed"); throw error; }
          result = null; break;
        case "stop":
          await stopForClose();
          // Cleanup must not depend on response events: the caller may already
          // have disconnected while native shutdown was pending. Give a live
          // caller one event-loop turn to receive this best-effort confirmation.
          setImmediate(() => { void close().catch(() => { process.exitCode = 1; }); });
          if (!response.destroyed) json(response, 200, { result: null });
          return;
        default: throw new BridgeError(400, "Unsupported bridge method");
      }
      json(response, 200, { result });
    })().catch(error => {
      if (response.destroyed || response.headersSent) return;
      const status = error instanceof BridgeError || error instanceof RuntimeInputError ? error.status
        : error instanceof CodexSessionBusyError ? 409 : error instanceof CodexSessionOfflineError ? 503 : 400;
      // Native errors can contain prompts, commands, config paths or credentials.
      json(response, status, { error: error instanceof BridgeError ? error.message : "Codex bridge operation failed" });
    });
  });
  server.maxConnections = 32;
  server.keepAliveTimeout = 1_000;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => { server.off("error", reject); resolve(); });
  });
  const address = server.address() as AddressInfo;
  connection = { version: 1, ...identity, endpoint: `http://127.0.0.1:${address.port}`, token, pid: process.pid,
    ...(claimId !== undefined ? { claimId } : {}) };
  observe("bridge_ready");
  return { connection: { ...connection }, closed, close };
}
