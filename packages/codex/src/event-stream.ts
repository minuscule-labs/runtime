import type { AgentEvent, RuntimeActivityEvent } from "@minu/runtime-core";
import { record } from "./rpc.js";

export const EVENT_LIMITS = { subscribers: 16, frames: 256, bytes: 2 * 1024 * 1024, frame: 256 * 1024 } as const;

/** Strict normalized wire vocabulary, not arbitrary native notification data. */
export function checkedEvent(value: unknown, sessionId: string): AgentEvent {
  const e = record(value);
  if (!e || e.sessionId !== sessionId || typeof e.timestamp !== "string" || !Number.isFinite(Date.parse(e.timestamp)) || new Date(e.timestamp).toISOString() !== e.timestamp) throw new Error("Invalid Codex event identity");
  let fields: string[];
  const text = (key: string) => typeof e[key] === "string" && (e[key] as string).length > 0;
  switch (e.type) {
    case "status": fields = ["status"]; if (typeof e.status !== "string" || !["idle", "working", "offline"].includes(e.status)) throw new Error("Invalid Codex status event"); break;
    case "turn_started": case "turn_completed": fields = ["operationId"]; if (!text("operationId")) throw new Error("Invalid Codex turn event"); break;
    case "message_delta": fields = ["delta"]; if (typeof e.delta !== "string") throw new Error("Invalid Codex text event"); break;
    case "tool_started": case "tool_completed":
      fields = ["toolCallId", "toolName", ...(e.type === "tool_completed" ? ["isError"] : [])];
      if (!text("toolCallId") || !text("toolName") || (e.type === "tool_completed" && typeof e.isError !== "boolean")) throw new Error("Invalid Codex tool event"); break;
    case "error": fields = ["message", "operationId"]; if (!text("message") || (e.operationId !== undefined && !text("operationId"))) throw new Error("Invalid Codex error event"); break;
    default: throw new Error("Unknown Codex event type");
  }
  if (Object.keys(e).some(key => !["sessionId", "timestamp", "type", ...fields].includes(key))) throw new Error("Unexpected Codex event field");
  return e as unknown as AgentEvent;
}

/** Producer never waits on a consumer. Overflow fails that subscriber, not work. */
export class BoundedEvents implements AsyncIterableIterator<AgentEvent> {
  private queue: Array<{ event: AgentEvent; bytes: number }> = [];
  private bytes = 0;
  private waiter?: { resolve(value: IteratorResult<AgentEvent>): void; reject(error: Error): void };
  private closed = false;
  private error?: Error;
  constructor(private readonly remove: () => void = () => {}) {}
  [Symbol.asyncIterator](): AsyncIterableIterator<AgentEvent> { return this; }
  next(): Promise<IteratorResult<AgentEvent>> {
    if (this.error) return Promise.reject(this.error);
    const queued = this.queue.shift();
    if (queued) { this.bytes -= queued.bytes; return Promise.resolve({ value: queued.event, done: false }); }
    if (this.closed) return Promise.resolve({ value: undefined, done: true });
    if (this.waiter) return Promise.reject(new Error("Concurrent Codex stream next is unsupported"));
    return new Promise((resolve, reject) => { this.waiter = { resolve, reject }; });
  }
  push(event: AgentEvent): void {
    if (this.closed) return;
    const eventBytes = Buffer.byteLength(JSON.stringify(event));
    // Wire legality includes exactly the envelope/newline, not retained-queue
    // overhead. Keep that conservative memory charge independently budgeted.
    const frameBytes = Buffer.byteLength('{"event":') + eventBytes + Buffer.byteLength("}\n");
    if (frameBytes > EVENT_LIMITS.frame) return this.fail(new Error("Codex event frame exceeds limit"));
    const bytes = eventBytes + 32;
    if (this.waiter) { const waiter = this.waiter; this.waiter = undefined; waiter.resolve({ value: { ...event }, done: false }); return; }
    if (this.queue.length >= EVENT_LIMITS.frames || this.bytes + bytes > EVENT_LIMITS.bytes) return this.fail(new Error("Codex event consumer overflow; events may have been missed"));
    this.queue.push({ event: { ...event }, bytes }); this.bytes += bytes;
  }
  fail(error: Error): void {
    if (this.closed) return;
    this.error = error; this.queue = []; this.bytes = 0;
    this.close();
  }
  close(): void {
    if (this.closed) return;
    this.closed = true; this.remove();
    const waiter = this.waiter; this.waiter = undefined;
    if (this.error) waiter?.reject(this.error);
    else waiter?.resolve({ value: undefined, done: true });
  }
  return(): Promise<IteratorResult<AgentEvent>> {
    this.queue = []; this.bytes = 0; this.close();
    return Promise.resolve({ value: undefined, done: true });
  }
}

export function safeCodexActivity(open: () => AsyncIterableIterator<AgentEvent>, signal: AbortSignal): AsyncIterableIterator<RuntimeActivityEvent> {
  let stream: AsyncIterableIterator<AgentEvent> | undefined;
  let closed = false;
  let previous: RuntimeActivityEvent["phase"] | undefined;
  const cancel = () => {
    closed = true; signal.removeEventListener("abort", cancel);
    void stream?.return?.().catch(() => {});
  };
  signal.addEventListener("abort", cancel, { once: true });
  if (signal.aborted) cancel();
  return {
    [Symbol.asyncIterator]() { return this; },
    async next() {
      try {
        while (!closed) {
          stream ??= open();
          const result = await stream.next();
          if (closed || result.done) { cancel(); break; }
          const event = result.value;
          if (event.type === "status" && event.status !== "working") previous = undefined;
          const phase = event.type === "tool_started" ? "using_tools" : event.type === "message_delta" ? "responding"
            : event.type === "turn_started" ? "working" : undefined;
          if (phase && phase !== previous) { previous = phase; return { value: { phase, observedAt: event.timestamp }, done: false }; }
        }
        return { value: undefined, done: true };
      } catch { const cancelled = closed; cancel(); if (cancelled) return { value: undefined, done: true }; throw new Error("Codex activity observation failed"); }
    },
    async return() { cancel(); return { value: undefined, done: true }; },
  };
}

export class CodexEventHub {
  private readonly streams = new Set<BoundedEvents>();
  private closed = false;
  private error?: Error;
  subscribe(initial?: AgentEvent): BoundedEvents {
    if (this.error) throw this.error;
    if (this.streams.size >= EVENT_LIMITS.subscribers) throw new Error("Codex event subscriber limit reached");
    const stream = new BoundedEvents(() => this.streams.delete(stream));
    if (this.closed) stream.close();
    else { this.streams.add(stream); if (initial) stream.push(initial); }
    return stream;
  }
  publish(event: AgentEvent): void { for (const stream of this.streams) stream.push(event); }
  close(error?: Error): void {
    this.closed = true; this.error = error;
    for (const stream of this.streams) { if (error) stream.fail(error); else stream.close(); }
  }
}
