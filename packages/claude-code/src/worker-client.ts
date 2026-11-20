import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import type {
  AgentEvent, AgentStatus, AgentTurn, RuntimeActivityEvent, RuntimeImageContent,
  RuntimeInputCapabilities, RuntimeMessage, RuntimeSessionCapabilities,
} from "@minu/runtime-core";
import { runtimeInput, sessionEvents, sessionIntegrations, sessionProfile, type RuntimeIntegrationSnapshot, type RuntimeSessionEvents, type RuntimeSessionProfile } from "@minu/runtime-core";
import {
  CLAUDE_WORKER_LIMITS as LIMITS, ClaudeCodeWorkerError, turnId, unseal,
  workerAcknowledgment, workerActivity, workerCapabilities, workerEvent, workerIdentity, workerMessage, workerStatus, workerToken, workerTurn,
  type ClaudeCodeWorkerConnection,
} from "./worker-protocol.js";

/** One exact living worker. No discovery, start/resume, redirect, retry or endpoint fallback. */
export class ClaudeCodeWorkerClient {
  private readonly connection: ClaudeCodeWorkerConnection;
  constructor(connection: ClaudeCodeWorkerConnection, private readonly requestMs: number = LIMITS.requestMs) {
    workerIdentity(connection); workerToken(connection.token);
    let url: URL;
    try { url = new URL(connection.endpoint); }
    catch { throw new ClaudeCodeWorkerError("invalid_endpoint", 400); }
    if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || !url.port
      || url.username || url.password || url.pathname !== "/" || url.search || url.hash) throw new ClaudeCodeWorkerError("invalid_endpoint", 400);
    if (!Number.isSafeInteger(requestMs) || requestMs < 1 || requestMs > 2_147_483_647) throw new ClaudeCodeWorkerError("invalid_deadline", 400);
    this.connection = { ...connection, endpoint: url.origin };
  }
  private headers(): Record<string, string> {
    const value = this.connection;
    return { authorization: `Bearer ${value.token}`, "x-minu-runtime-session": value.sessionId,
      "x-minu-runtime-owner": value.ownerId, "x-minu-runtime-generation": value.generation,
      "content-type": "application/json" };
  }
  private async response(path: string, data?: unknown, signal?: AbortSignal): Promise<Response> {
    const response = await fetch(`${this.connection.endpoint}${path}`, {
      method: data === undefined ? "GET" : "POST", headers: this.headers(),
      body: data === undefined ? undefined : JSON.stringify(data), redirect: "error", signal,
    });
    if (!response.ok) {
      // Never echo a server body/native error, or consume an unlimited error response.
      await response.body?.cancel();
      throw new ClaudeCodeWorkerError(`http_${response.status}`, response.status);
    }
    return response;
  }
  private async request<T>(path: string, data?: unknown, signal?: AbortSignal): Promise<T> {
    const controller = new AbortController();
    const abort = () => controller.abort(signal?.reason);
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    const timer = setTimeout(() => controller.abort(new ClaudeCodeWorkerError("request_timed_out")), this.requestMs);
    try {
      const response = await this.response(path, data, controller.signal);
      if (!response.body) throw new ClaudeCodeWorkerError("invalid_response");
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = []; let bytes = 0;
      try {
        while (true) {
          const result = await reader.read();
          if (result.done) break;
          bytes += result.value.length;
          if (bytes > LIMITS.jsonBytes) throw new ClaudeCodeWorkerError("response_too_large");
          chunks.push(result.value);
        }
      } finally { await reader.cancel().catch(() => {}); }
      let value: unknown;
      try { value = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
      catch { throw new ClaudeCodeWorkerError("invalid_response"); }
      return unseal(this.connection, value) as T;
    } finally { clearTimeout(timer); signal?.removeEventListener("abort", abort); }
  }
  async status(signal?: AbortSignal): Promise<AgentStatus> { return workerStatus(await this.request("/status", undefined, signal)); }
  async startTurn(id: string, input: string, images?: RuntimeImageContent[], signal?: AbortSignal): Promise<AgentTurn> {
    const parts = runtimeInput(input, images);
    const callerId = turnId(id);
    const turn = workerTurn(await this.request("/turns", { turnId: callerId, input: parts.input, ...(parts.images.length ? { images: parts.images } : {}) }, signal));
    if (turn.id !== callerId || turn.input !== parts.input) throw new ClaudeCodeWorkerError("turn_identity_mismatch");
    return turn;
  }
  async turn(id: string, signal?: AbortSignal): Promise<AgentTurn | undefined> {
    const callerId = turnId(id);
    try {
      const turn = workerTurn(await this.request(`/turn?id=${encodeURIComponent(callerId)}`, undefined, signal));
      if (turn.id !== callerId) throw new ClaudeCodeWorkerError("turn_identity_mismatch");
      return turn;
    }
    catch (error) { if (error instanceof ClaudeCodeWorkerError && error.status === 404) return undefined; throw error; }
  }
  async send(input: string, images?: RuntimeImageContent[], signal?: AbortSignal): Promise<void> {
    let turn = await this.startTurn(randomUUID(), input, images, signal);
    while (turn.status === "running") {
      await delay(25, undefined, { signal });
      const latest = await this.turn(turn.id, signal);
      if (!latest) throw new ClaudeCodeWorkerError("turn_unavailable");
      turn = latest;
    }
    if (turn.status !== "completed") throw new ClaudeCodeWorkerError(`turn_${turn.status}`, 409);
  }
  async messages(signal?: AbortSignal): Promise<RuntimeMessage[]> {
    const values = await this.request<unknown>("/messages", undefined, signal);
    if (!Array.isArray(values)) throw new ClaudeCodeWorkerError("invalid_response");
    return values.map(workerMessage);
  }
  async inputCapabilities(signal?: AbortSignal): Promise<RuntimeInputCapabilities> {
    const value = await this.request<RuntimeInputCapabilities>("/input-capabilities", undefined, signal);
    if (!value || value.version !== 1 || typeof value.images !== "boolean") throw new ClaudeCodeWorkerError("invalid_response");
    return { version: 1, images: value.images };
  }
  async inspectProfile(signal?: AbortSignal): Promise<RuntimeSessionProfile> { return sessionProfile(await this.request("/session-profile", undefined, signal)); }
  async inspectEvents(signal?: AbortSignal): Promise<RuntimeSessionEvents> { return sessionEvents(await this.request("/session-events", undefined, signal)); }
  async inspectIntegrations(signal?: AbortSignal): Promise<RuntimeIntegrationSnapshot> { return sessionIntegrations(await this.request("/session-integrations", undefined, signal)); }
  async sessionCapabilities(signal?: AbortSignal): Promise<RuntimeSessionCapabilities | null> {
    return workerCapabilities(await this.request("/capabilities", undefined, signal));
  }
  /** Target the retained caller turn the consumer intended, never a later active turn. */
  async interrupt(expectedTurnId: string, signal?: AbortSignal): Promise<void> {
    workerAcknowledgment(await this.request("/interrupt", { expectedTurnId: turnId(expectedTurnId) }, signal));
  }
  async steer(expectedTurnId: string, input: string, signal?: AbortSignal): Promise<void> {
    runtimeInput(input, undefined);
    workerAcknowledgment(await this.request("/steer", { expectedTurnId: turnId(expectedTurnId), input }, signal));
  }
  /** One-way idle-only quiesce. Busy refusal does not stop the session; after
   * admission, new input stays fenced even if acknowledgment/shutdown is lost.
   * Confirms native stop ONLY, not worker/group exit or eligibility to resume. */
  async requestQuiesceIdle(signal?: AbortSignal): Promise<void> { workerAcknowledgment(await this.request("/quiesce-idle", {}, signal)); }
  /** Authenticated native-stop acknowledgment, NOT independent confirmation of worker/group exit. */
  async requestStop(signal?: AbortSignal): Promise<void> { workerAcknowledgment(await this.request("/stop", {}, signal)); }
  /** Adapter-private recovery stop: bypasses idle/busy admission (not authentication). One best-effort
   * request; the worker then tears down its native family and exits. Never proof of exit. */
  async requestForceStop(signal?: AbortSignal): Promise<void> { workerAcknowledgment(await this.request("/force-stop", {}, signal)); }
  events(signal: AbortSignal): AsyncIterable<AgentEvent> { return this.stream("/events", signal) as AsyncIterable<AgentEvent>; }
  activityEvents(signal: AbortSignal): AsyncIterable<RuntimeActivityEvent> { return this.stream("/activity", signal, true) as AsyncIterable<RuntimeActivityEvent>; }

  private async *stream(path: string, signal: AbortSignal, activity = false): AsyncIterable<AgentEvent | RuntimeActivityEvent> {
    if (signal.aborted) return;
    const controller = new AbortController();
    const abort = () => controller.abort(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    // Bound connection/header wait without imposing a lifetime on a healthy stream.
    const timer = setTimeout(() => controller.abort(new ClaudeCodeWorkerError("request_timed_out")), this.requestMs);
    try {
      const response = await this.response(path, undefined, controller.signal);
      clearTimeout(timer);
      if (!response.body) throw new ClaudeCodeWorkerError("invalid_response");
      reader = response.body.getReader();
      let pending = Buffer.alloc(0);
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) {
          if (pending.length) throw new ClaudeCodeWorkerError("truncated_frame");
          break;
        }
        pending = Buffer.concat([pending, chunk.value]);
        let newline: number;
        while ((newline = pending.indexOf(10)) >= 0) {
          if (newline > LIMITS.frameBytes) throw new ClaudeCodeWorkerError("frame_too_large");
          let frame: unknown;
          try { frame = JSON.parse(pending.subarray(0, newline).toString("utf8")); }
          catch { throw new ClaudeCodeWorkerError("invalid_frame"); }
          pending = pending.subarray(newline + 1);
          const value = unseal(this.connection, frame);
          if (activity) yield workerActivity(value);
          else yield workerEvent(value, this.connection.sessionId);
        }
        if (pending.length > LIMITS.frameBytes) throw new ClaudeCodeWorkerError("frame_too_large");
      }
    } catch (error) { if (!signal.aborted) throw error; }
    finally {
      clearTimeout(timer); signal.removeEventListener("abort", abort);
      controller.abort();
      await reader?.cancel().catch(() => {});
    }
  }
}
