import type { AgentEvent } from "@minu/runtime-core";
import type { IncomingMessage, ServerResponse } from "node:http";
import { checkedEvent, EVENT_LIMITS } from "./event-stream.js";
import type { CodexWorkerConnection } from "./worker-identity.js";

/** One bounded live subscription. Authority is never held while awaiting data/drain. */
export async function serveCodexEvents(
  request: IncomingMessage, response: ServerResponse, source: AsyncIterable<AgentEvent>,
  sourceId: string, identity: Pick<CodexWorkerConnection, "version" | "ownerId" | "sessionId" | "generation" | "pid" | "claimId">,
  authorize: () => Promise<void>, controller: AbortController,
): Promise<void> {
  const iterator = source[Symbol.asyncIterator]();
  let pending: IteratorResult<AgentEvent> | undefined;
  let failure: unknown;
  let wake: (() => void) | undefined;
  const cancel = () => { controller.abort(); wake?.(); void iterator.return?.(); };
  response.once("close", cancel);
  const aborted = () => { wake?.(); void iterator.return?.(); if (!response.destroyed) response.destroy(); };
  controller.signal.addEventListener("abort", aborted, { once: true });
  const advance = () => {
    void Promise.resolve().then(() => iterator.next()).then(value => { pending = value; wake?.(); }, error => { failure = error ?? new Error("Codex event source failed"); wake?.(); });
  };
  const write = async (frame: unknown) => {
    const data = JSON.stringify(frame) + "\n";
    if (Buffer.byteLength(data) > EVENT_LIMITS.frame) throw new Error("Codex event frame exceeds limit");
    if (controller.signal.aborted) throw new Error("Codex event stream cancelled");
    if (response.write(data)) return;
    await new Promise<void>((resolve, reject) => {
      const cleanup = () => { clearTimeout(timer); response.off("drain", drained); response.off("close", closed); controller.signal.removeEventListener("abort", closed); };
      const drained = () => { cleanup(); resolve(); };
      const closed = () => { cleanup(); reject(new Error("Codex event reader disconnected or fell behind")); };
      const timer = setTimeout(closed, 2_000);
      response.once("drain", drained); response.once("close", closed); controller.signal.addEventListener("abort", closed, { once: true });
      if (controller.signal.aborted || response.destroyed) closed();
    });
  };
  try {
    if (controller.signal.aborted || response.destroyed) return;
    await authorize();
    if (controller.signal.aborted) return;
    response.writeHead(200, { "content-type": "application/x-ndjson; charset=utf-8", "cache-control": "no-store", "x-minu-runtime-events": "1" });
    await write({ ready: 1, identity });
    advance();
    while (!controller.signal.aborted) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      if (!pending && !failure) await new Promise<void>(resolve => { wake = resolve; timer = setTimeout(resolve, 250); });
      clearTimeout(timer); wake = undefined;
      if (controller.signal.aborted) break;
      if (failure) throw failure;
      await authorize();
      if (controller.signal.aborted) break;
      const observed = pending; pending = undefined;
      if (!observed) { await write({ heartbeat: 1 }); continue; }
      if (observed.done) { await write({ end: 1 }); response.end(); break; }
      const event = checkedEvent(observed.value, sourceId);
      await write({ event: { ...event, sessionId: identity.sessionId } });
      advance();
    }
  } catch (error) {
    if (!response.headersSent && !controller.signal.aborted) throw error;
    // end() only queues more bytes: a stalled reader could keep that socket
    // alive indefinitely. Failed observation must release the transport even
    // when none of its buffered output can be flushed. Abrupt EOF reports a gap.
    response.destroy();
  } finally {
    response.off("close", cancel); controller.signal.removeEventListener("abort", aborted);
    await iterator.return?.();
    if (!response.writableEnded && !response.destroyed) response.end();
  }
}
