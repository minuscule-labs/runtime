import { timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import {
  runtimeInput, RuntimeInputError, RUNTIME_INPUT_LIMITS,
  type AgentRuntime, type AgentEvent, type RuntimeActivityEvent,
} from "@minu/runtime-core";
import { Queue } from "./queue.js";
import {
  CLAUDE_WORKER_LIMITS as LIMITS, ClaudeCodeWorkerError, envelope, turnId,
  workerActivity, workerEvent, workerIdentity, workerToken, type ClaudeCodeWorkerConnection,
} from "./worker-protocol.js";

export interface ClaudeCodeWorkerBridgeOptions extends Omit<ClaudeCodeWorkerConnection, "endpoint"> {
  runtime: AgentRuntime;
  nativeSessionId: string;
  /** Validate live owner/generation and hold authority through each callback. Streams use
   * separate admissions for setup and every frame write; never retain a lock while idle/draining.
   * This bridge must be the session's sole turn/control admission path. Headers alone
   * are NOT a persisted replacement fence. */
  admit<T>(operation: () => Promise<T>): Promise<T>;
}

async function body(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const part of request.iterator({ destroyOnReturn: false })) {
    const chunk = Buffer.isBuffer(part) ? part : Buffer.from(part);
    bytes += chunk.length;
    if (bytes > RUNTIME_INPUT_LIMITS.transportBytes) {
      request.resume();
      throw new ClaudeCodeWorkerError("input_too_large", 413);
    }
    chunks.push(chunk);
  }
  let value: unknown;
  try { value = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw new ClaudeCodeWorkerError("invalid_json", 400); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ClaudeCodeWorkerError("invalid_input", 400);
  return value as Record<string, unknown>;
}

/** Owned-session transport only. No disk discovery, generation authority, start/resume or automatic retry. */
export async function createClaudeCodeWorkerBridge(options: ClaudeCodeWorkerBridgeOptions): Promise<{
  connection: ClaudeCodeWorkerConnection;
  /** Successful idle stop after admission release and a bounded reply attempt.
   * Not worker/group exit, metadata-clear or resume authority. Generic stop does not resolve it. */
  idleQuiesced: Promise<void>;
  /** Authenticated recovery stop, outside admission (a fenced/revoked session cannot admit). Resolves after
   * the bounded reply attempt; the owner must then tear down natively and exit. Not exit/clear authority. */
  forceStopped: Promise<void>;
  /** Fences admission, confirms native stop, then closes the listener and streams. */
  close(): Promise<void>;
}> {
  workerIdentity(options); workerToken(options.token);
  const runtime = options.runtime, id = options.nativeSessionId;
  const events = new Set<Queue<AgentEvent>>();
  const activities = new Set<Queue<RuntimeActivityEvent>>();
  const responses = new Set<ServerResponse>();
  const abort = new AbortController();
  let stopping = false, mutating = false, idleStopConfirmed = false, forced = false;
  let resolveIdleQuiesced!: () => void, resolveForceStopped!: () => void;
  const idleQuiesced = new Promise<void>(resolve => { resolveIdleQuiesced = resolve; });
  const forceStopped = new Promise<void>(resolve => { resolveForceStopped = resolve; });
  let stopTask: Promise<void> | undefined;
  let transportClose: Promise<void> | undefined;
  let streams = 0, eventsEnded = false, activityEnded = false;
  const json = (response: ServerResponse, status: number, value: unknown) => {
    const data = `${JSON.stringify(value)}\n`;
    if (Buffer.byteLength(data) > LIMITS.jsonBytes) throw new ClaudeCodeWorkerError("response_too_large");
    response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
    response.end(data);
  };
  const reply = (response: ServerResponse, value: unknown) => json(response, 200, envelope(options, value));
  const stop = async () => {
    stopping = true;
    if (!stopTask) {
      stopTask = options.admit(() => runtime.stop(id));
      // An explicit later stop may retry confirmation; never retry automatically.
      void stopTask.catch(() => { stopTask = undefined; });
    }
    await stopTask;
  };
  const mutate = async <T>(operation: () => Promise<T>): Promise<T> => {
    if (stopping) throw new ClaudeCodeWorkerError("stopping", 409);
    if (mutating) throw new ClaudeCodeWorkerError("busy", 409);
    mutating = true;
    try {
      return await options.admit(async () => {
        if (stopping) throw new ClaudeCodeWorkerError("stopping", 409);
        return operation();
      });
    } finally { mutating = false; }
  };
  const control = (expected: unknown, operation: () => Promise<void>) => {
    const target = turnId(expected);
    return mutate(async () => {
      const current = await runtime.turn(id, target);
      if (!current || current.status !== "running") throw new ClaudeCodeWorkerError("stale_turn", 409);
      // mutate holds admission across lookup/invocation and excludes a subsequent
      // bridge turn until control settles. Never fall back to the then-current turn.
      await operation();
    });
  };
  const stream = async <T>(response: ServerResponse, queues: Set<Queue<T>>, initial?: T, ended = false) => {
    const queue = new Queue<T>(LIMITS.streamQueue);
    let registered = false;
    const closed = () => { void queue.return(); };
    try {
      await options.admit(async () => {
        if (streams >= LIMITS.streams || stopping || response.destroyed) throw new ClaudeCodeWorkerError("stream_unavailable");
        queues.add(queue); responses.add(response); streams++; registered = true;
        response.once("close", closed);
        response.writeHead(200, { "content-type": "application/x-ndjson", "cache-control": "no-store" });
        response.flushHeaders();
        if (initial) queue.push(initial);
        if (ended) queue.end();
      });
      for await (const value of queue) {
        const frame = `${JSON.stringify(envelope(options, value))}\n`;
        if (Buffer.byteLength(frame) > LIMITS.frameBytes) throw new ClaudeCodeWorkerError("frame_too_large");
        const writable = await options.admit(async () => {
          if (response.destroyed) throw new ClaudeCodeWorkerError("stream_closed");
          return response.write(frame);
        });
        // A frame already written under valid authority cannot be recalled from
        // network buffers. Revalidate every later write, outside idle/drain waits.
        if (!writable) {
          await new Promise<void>((resolve, reject) => {
            const cleanup = () => { clearTimeout(timer); response.off("drain", drained); response.off("close", drained); };
            const drained = () => { cleanup(); resolve(); };
            const timer = setTimeout(() => { cleanup(); reject(new ClaudeCodeWorkerError("slow_reader")); }, LIMITS.drainMs);
            response.once("drain", drained); response.once("close", drained);
            if (response.destroyed) drained();
          });
        }
      }
      response.end();
    } finally {
      response.off("close", closed);
      if (registered) { queues.delete(queue); responses.delete(response); streams--; }
      await queue.return();
    }
  };
  const server = createServer({ maxHeaderSize: 8 * 1024, requestTimeout: 15_000, headersTimeout: 5_000 }, async (request, response) => {
    try {
      const expected = Buffer.from(`Bearer ${options.token}`);
      const supplied = Buffer.from(request.headers.authorization ?? "");
      if (expected.length !== supplied.length || !timingSafeEqual(expected, supplied)
        || request.headers["x-minu-runtime-session"] !== options.sessionId
        || request.headers["x-minu-runtime-owner"] !== options.ownerId
        || request.headers["x-minu-runtime-generation"] !== options.generation) {
        json(response, 401, { error: "unauthorized" }); return;
      }
      const url = new URL(request.url ?? "/", "http://runtime.local");
      if (request.method === "GET" && url.pathname === "/status") reply(response, await options.admit(() => runtime.status(id)));
      else if (request.method === "GET" && url.pathname === "/turn") {
        const turn = await options.admit(() => runtime.turn(id, turnId(url.searchParams.get("id"))));
        if (!turn) throw new ClaudeCodeWorkerError("turn_not_found", 404);
        reply(response, turn);
      } else if (request.method === "GET" && url.pathname === "/messages") reply(response, await options.admit(() => runtime.messages(id)));
      else if (request.method === "GET" && url.pathname === "/input-capabilities") {
        reply(response, await options.admit(async () => await runtime.inputCapabilities?.(id) ?? { version: 1, images: false }));
      } else if (request.method === "GET" && url.pathname === "/capabilities") {
        const capabilities = await options.admit(async () => {
          const base = await runtime.sessionCapabilities?.(id);
          return base && { ...base, safeActivityEvents: base.safeActivityEvents && !activityEnded,
            reconnectExisting: (await runtime.status(id)) !== "offline" };
        });
        reply(response, capabilities ?? null);
      } else if (request.method === "GET" && url.pathname === "/events") {
        const status = await options.admit(() => runtime.status(id));
        await stream(response, events, { type: "status", status, sessionId: options.sessionId, timestamp: new Date().toISOString() } as AgentEvent, eventsEnded);
      } else if (request.method === "GET" && url.pathname === "/activity") {
        await options.admit(async () => { if (!runtime.activityEvents) throw new ClaudeCodeWorkerError("activity_unavailable", 404); });
        await stream(response, activities, undefined, activityEnded);
      } else if (request.method === "POST" && url.pathname === "/turns") {
        const data = await body(request);
        const input = runtimeInput(data.input, data.images);
        const callerId = turnId(data.turnId);
        const turn = await mutate(() => runtime.startTurn(id, callerId, input.input, input.images.length ? input.images : undefined));
        reply(response, turn);
      } else if (request.method === "POST" && url.pathname === "/interrupt") {
        const data = await body(request);
        await control(data.expectedTurnId, () => runtime.interrupt(id)); reply(response, { acknowledged: true });
      } else if (request.method === "POST" && url.pathname === "/steer") {
        const data = await body(request);
        const input = runtimeInput(data.input, undefined);
        await control(data.expectedTurnId, () => runtime.steer(id, input.input)); reply(response, { acknowledged: true });
      } else if (request.method === "POST" && url.pathname === "/quiesce-idle") {
        await mutate(async () => {
          if (await runtime.status(id) !== "idle") throw new ClaudeCodeWorkerError("not_idle", 409);
          // Check and fence within one admission. Busy refusal leaves the worker
          // usable; after this point uncertainty must keep new input fenced.
          stopping = true;
          await runtime.stop(id);
        });
        // mutate has released admission. Self-teardown must never reacquire it
        // merely to repeat a stop that this exact idle request already confirmed.
        idleStopConfirmed = true;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const complete = () => {
          clearTimeout(timer); response.off("finish", complete); response.off("close", complete);
          resolveIdleQuiesced();
        };
        response.once("finish", complete); response.once("close", complete);
        // Lost ACK / slow delivery cannot keep a quiesced worker alive forever.
        timer = setTimeout(complete, LIMITS.drainMs); timer.unref();
        try { reply(response, { acknowledged: true }); }
        finally { if (response.destroyed || response.writableFinished) complete(); }
      } else if (request.method === "POST" && url.pathname === "/force-stop") {
        // Deliberately no admit/mutate: recovery must work while busy, fenced or with a dead registration.
        stopping = true; forced = true;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const complete = () => {
          clearTimeout(timer); response.off("finish", complete); response.off("close", complete);
          resolveForceStopped();
        };
        response.once("finish", complete); response.once("close", complete);
        timer = setTimeout(complete, LIMITS.drainMs); timer.unref();
        try { reply(response, { acknowledged: true }); }
        finally { if (response.destroyed || response.writableFinished) complete(); }
      } else if (request.method === "POST" && url.pathname === "/stop") {
        await stop();
        // This acknowledges native stop only. The owning supervisor must separately observe worker exit.
        reply(response, { acknowledged: true });
      } else throw new ClaudeCodeWorkerError("not_found", 404);
    } catch (error) {
      if (response.destroyed || response.writableEnded) return;
      if (response.headersSent) { response.destroy(); return; }
      const code = error instanceof ClaudeCodeWorkerError ? error.code
        : error instanceof RuntimeInputError ? "invalid_input"
          : error instanceof Error && ["Claude Code session is busy", "Turn id conflicts with previously accepted input"].includes(error.message) ? "conflict" : "operation_failed";
      const status = error instanceof ClaudeCodeWorkerError || error instanceof RuntimeInputError ? error.status : code === "conflict" ? 409 : 503;
      json(response, status, { error: code });
    }
  });
  const eventPump = (async () => {
    try {
      for await (const event of runtime.events(id)) {
        const value = { ...workerEvent(event, id), sessionId: options.sessionId } as AgentEvent;
        for (const queue of events) queue.push(value);
      }
      for (const queue of events) queue.end();
    } catch { for (const queue of events) queue.end(new ClaudeCodeWorkerError("event_stream_failed")); }
    finally { eventsEnded = true; }
  })();
  const activityPump = (async () => {
    try {
      if (runtime.activityEvents) for await (const raw of runtime.activityEvents(id, { signal: abort.signal })) {
        const value = workerActivity(raw);
        for (const queue of activities) queue.push(value);
      }
      for (const queue of activities) queue.end();
    } catch { for (const queue of activities) queue.end(new ClaudeCodeWorkerError("activity_stream_failed")); }
    finally { activityEnded = true; }
  })();
  try { await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); }); }
  catch (error) { abort.abort(); await runtime.stop(id); await Promise.all([eventPump, activityPump]); throw error; }
  const address = server.address() as AddressInfo;
  return {
    idleQuiesced, forceStopped,
    connection: { sessionId: options.sessionId, ownerId: options.ownerId, generation: options.generation,
      endpoint: `http://127.0.0.1:${address.port}`, token: options.token },
    async close() {
      if (!idleStopConfirmed && !forced) await stop();
      if (!transportClose) transportClose = (async () => {
        abort.abort();
        for (const response of responses) response.destroy();
        server.closeAllConnections();
        await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
        await Promise.all([eventPump, activityPump]);
      })();
      await transportClose;
    },
  };
}
