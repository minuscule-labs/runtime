import type { CodexWorkerConnection } from "./worker-bridge.js";
import { validateWorkerConnection } from "./worker-identity.js";
import { record } from "./rpc.js";
import { SESSION_PROFILE_LIMITS, SESSION_EVENTS_LIMITS, sessionProfile, sessionEvents } from "@minu/runtime-core";
import type { AgentEvent, RuntimeImageContent, RuntimeSessionProfile, RuntimeSessionEvents } from "@minu/runtime-core";
import { BoundedEvents, checkedEvent, EVENT_LIMITS } from "./event-stream.js";

export interface CodexWorkerEvents extends AsyncIterableIterator<AgentEvent> { readonly ready: Promise<void> }

export type CodexWorkerMethod = "identity" | "status" | "inputCapabilities" | "sessionCapabilities" | "messages" | "turn" | "startTurn" | "steer" | "interrupt" | "stop";

/** Internal reconnect client. A timeout is an uncertain result, never an automatic retry. */
export class CodexWorkerClient {
  private readonly connection: CodexWorkerConnection;
  constructor(connection: CodexWorkerConnection) {
    validateWorkerConnection(connection);
    const endpoint = new URL(connection.endpoint);
    this.connection = { ...connection, endpoint: endpoint.origin };
  }

  /** A saved PID/token is not liveness. Verify the currently reachable peer. */
  async verifyIdentity(): Promise<void> {
    const actual = record(await this.request("identity"));
    const expected = this.connection;
    if (!actual || actual.version !== 1 || actual.ownerId !== expected.ownerId || actual.sessionId !== expected.sessionId
      || actual.generation !== expected.generation || actual.pid !== expected.pid || actual.claimId !== expected.claimId) {
      throw new Error("Codex worker identity could not be authenticated");
    }
  }

  events(): CodexWorkerEvents {
    const c = this.connection;
    const controller = new AbortController();
    let readyResolve!: () => void;
    let readyReject!: (error: Error) => void;
    let initialized = false;
    const ready = new Promise<void>((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
    void ready.catch(() => {}); // Cancellation before a caller awaits handshake is safe.
    const queue = new BoundedEvents(() => { controller.abort(); readyReject(new Error("Codex event stream cancelled")); });
    const deadline = setTimeout(() => controller.abort(), 10_000);
    void (async () => {
      let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
      try {
        const response = await fetch(`${c.endpoint}/events`, { redirect: "error", signal: controller.signal,
          headers: { authorization: `Bearer ${c.token}`, "x-minu-runtime-owner": c.ownerId,
            "x-minu-runtime-session": c.sessionId, "x-minu-runtime-generation": c.generation } });
        reader = response.body?.getReader();
        if (!response.ok || response.headers.get("x-minu-runtime-events") !== "1"
          || response.headers.get("content-type")?.split(";")[0] !== "application/x-ndjson" || !reader) throw new Error("Codex worker event streaming is unsupported or unavailable");
        let buffered = Buffer.alloc(0);
        let ended = false;
        const decoder = new TextDecoder("utf-8", { fatal: true });
        while (!ended) {
          const { value, done } = await reader.read();
          if (done) throw new Error("Codex event stream disconnected; events may have been missed");
          if (value.byteLength > EVENT_LIMITS.bytes) throw new Error("Codex event byte buffer exceeds limit");
          buffered = Buffer.concat([buffered, value]);
          let newline: number;
          while ((newline = buffered.indexOf(10)) !== -1) {
            if (newline + 1 > EVENT_LIMITS.frame) throw new Error("Codex event frame exceeds limit");
            const frame = record(JSON.parse(decoder.decode(buffered.subarray(0, newline))));
            buffered = buffered.subarray(newline + 1);
            if (!frame) throw new Error("Malformed Codex event frame");
            if (!initialized) {
              const actual = record(frame.identity);
              if (frame.ready !== 1 || Object.keys(frame).length !== 2 || !actual
                || actual.version !== c.version || actual.ownerId !== c.ownerId || actual.sessionId !== c.sessionId
                || actual.generation !== c.generation || actual.pid !== c.pid || actual.claimId !== c.claimId) throw new Error("Invalid Codex event handshake");
              initialized = true; clearTimeout(deadline); readyResolve();
            } else if (Object.keys(frame).length !== 1) throw new Error("Malformed Codex event frame");
            else if (frame.event) queue.push(checkedEvent(frame.event, c.sessionId));
            else if (frame.heartbeat === 1) { /* Authority-checked idle connection, not an event. */ }
            else if (frame.end === 1) { ended = true; queue.close(); break; }
            else throw new Error("Codex event stream failed; events may have been missed");
          }
          if (buffered.byteLength > EVENT_LIMITS.frame) throw new Error("Codex event frame exceeds limit");
        }
      } catch (error) {
        const failure = error instanceof Error ? error : new Error("Codex event stream failed");
        readyReject(failure); queue.fail(failure);
      } finally { clearTimeout(deadline); await reader?.cancel().catch(() => {}); reader?.releaseLock(); }
    })();
    return { ready, [Symbol.asyncIterator]() { return this; }, next: () => queue.next(),
      return: async () => { clearTimeout(deadline); controller.abort(); readyReject(new Error("Codex event stream cancelled")); return queue.return(); } };
  }

  async observe(kind: "profile" | "events", signal: AbortSignal): Promise<RuntimeSessionProfile | RuntimeSessionEvents | undefined> {
    const c = this.connection, limits = kind === "profile" ? SESSION_PROFILE_LIMITS : SESSION_EVENTS_LIMITS;
    const response = await fetch(`${c.endpoint}/session-${kind}`, { signal, redirect: "error", headers: {
      authorization: `Bearer ${c.token}`, "x-minu-runtime-owner": c.ownerId, "x-minu-runtime-session": c.sessionId,
      "x-minu-runtime-generation": c.generation } });
    if (!response.ok) { await response.body?.cancel(); return undefined; }
    const reader = response.body?.getReader();
    if (!reader || response.headers.get("content-type")?.split(";")[0] !== "application/json") { await reader?.cancel(); return undefined; }
    const chunks: Uint8Array[] = []; let bytes = 0;
    try {
      while (true) {
        const result = await reader.read(); signal.throwIfAborted();
        if (result.done) break;
        bytes += result.value.byteLength;
        if (bytes > limits.bytes) throw new Error("Observation exceeds bounds");
        chunks.push(result.value);
      }
      const body = record(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      return kind === "profile" ? sessionProfile(body?.profile) : sessionEvents(body?.events);
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  }

  /** Publication acknowledgment only, never physical exit; no retry or fallback. */
  async retire(operationId: string): Promise<{ operationId: string; phase: "native_fact_published" }> {
    if (typeof operationId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(operationId) || !this.connection.claimId) throw new Error("Invalid Codex retirement request");
    const c = this.connection;
    const result = record(await this.send("/retire", { operationId, version: c.version, pid: c.pid, claimId: c.claimId }));
    if (!result || Object.keys(result).length !== 2 || result.operationId !== operationId || result.phase !== "native_fact_published") throw new Error("Invalid Codex retirement acknowledgment");
    return { operationId, phase: "native_fact_published" };
  }

  /** Recovery stop: one best-effort request that bypasses the fence/admission (not authentication). The worker
   * stops native and exits. Never proof of exit; callers never retry it or depend on its reply. */
  async forceStop(timeoutMs = 2_000): Promise<void> {
    if (await this.send("/force-stop", {}, timeoutMs) !== null) throw new Error("Invalid Codex force-stop acknowledgment");
  }

  async request<T = unknown>(method: CodexWorkerMethod, args: { turnId?: string; input?: string; images?: RuntimeImageContent[] } = {}): Promise<T> {
    return await this.send("/rpc", { ...args, method }) as T;
  }

  private async send(path: string, payload: Record<string, unknown>, timeoutMs = 10_000): Promise<unknown> {
    const c = this.connection;
    const response = await fetch(`${c.endpoint}${path}`, {
      method: "POST", redirect: "error", signal: AbortSignal.timeout(timeoutMs),
      headers: {
        "content-type": "application/json", authorization: `Bearer ${c.token}`,
        "x-minu-runtime-owner": c.ownerId, "x-minu-runtime-session": c.sessionId,
        "x-minu-runtime-generation": c.generation,
      },
      body: JSON.stringify(payload),
    });
    const reader = response.body?.getReader();
    if (!reader) throw new Error("Missing Codex bridge response");
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > 8 * 1024 * 1024) throw new Error("Codex bridge response exceeds limit");
        chunks.push(value);
      }
    } finally { await reader.cancel(); }
    const body = record(JSON.parse(Buffer.concat(chunks).toString("utf8")));
    if (!response.ok || !body || !Object.hasOwn(body, "result")) {
      throw new Error(`Codex bridge request failed (${response.status})`);
    }
    return body.result;
  }
}
