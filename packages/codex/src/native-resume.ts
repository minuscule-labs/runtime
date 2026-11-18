import { createHash } from "node:crypto";
import { RUNTIME_INPUT_LIMITS } from "@minu/runtime-core";
import type { RuntimeMessage } from "@minu/runtime-core";
import { normalizeCodexItem, toolName } from "./messages.js";
import { record, type CodexRpcProcess } from "./rpc.js";

export type CodexHistoryCheckpoint = { kind: "pending" } | { kind: "history"; digest: string; turns: number; items: number };

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, data]) => [key, canonical(data)]));
  return value;
}

export async function readNativeCheckpoint(rpc: CodexRpcProcess, threadId: string, expectedMessages?: RuntimeMessage[]): Promise<CodexHistoryCheckpoint> {
  const hash = createHash("sha256"); let turns = 0, items = 0;
  const messages = await readNativeHistory(rpc, threadId, turn => {
    turns++; items += (turn.items as unknown[]).length;
    hash.update(JSON.stringify(canonical({ id: turn.id, status: turn.status, items: turn.items })) + "\n");
  });
  if (expectedMessages && JSON.stringify(canonical(messages)) !== JSON.stringify(canonical(expectedMessages))) throw new Error("Codex native history is missing observed messages");
  return { kind: "history", digest: hash.digest("hex"), turns, items };
}

const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

export function validateNativeThreadId(threadId: string): void {
  if (typeof threadId !== "string" || !ID.test(threadId)) throw new Error("Invalid Codex native thread identity");
}

/** Check persisted identity/workspace before resume can apply configuration overrides. */
export async function validateNativeResume(rpc: CodexRpcProcess, threadId: string, cwd: string): Promise<void> {
  const response = record(await rpc.request("thread/read", { threadId, includeTurns: false }));
  const thread = record(response?.thread);
  if (!thread || thread.id !== threadId || thread.cwd !== cwd || thread.ephemeral !== false
    || !["notLoaded", "idle"].includes(record(thread.status)?.type as string)) {
    throw new Error("Codex resume identity, workspace, persistence or idle state could not be verified");
  }
}

function validateTextParts(value: unknown, strictEntries: boolean): void {
  if (!Array.isArray(value)) throw new Error("Codex resume history contains invalid message content");
  for (const part of value) {
    const entry = record(part);
    if (strictEntries && (!entry || typeof entry.type !== "string")) {
      throw new Error("Codex resume history contains invalid message parts");
    }
    // Non-text parts are intentionally omitted by the projection. A recognized
    // text part is not optional content and must never be silently discarded.
    if ((entry?.type === "text" || entry?.type === "inputText") && typeof entry.text !== "string") {
      throw new Error("Codex resume history contains invalid text content");
    }
  }
}

function validateProjectedItem(item: Record<string, unknown>): void {
  if (item.type === "agentMessage") {
    if (typeof item.text !== "string") throw new Error("Codex resume history contains invalid assistant text");
  } else if (item.type === "userMessage") validateTextParts(item.content, true);
  else if (toolName(item)) {
    if (item.aggregatedOutput !== undefined && item.aggregatedOutput !== null && typeof item.aggregatedOutput !== "string") {
      throw new Error("Codex resume history contains invalid tool output");
    }
    if (item.tool !== undefined && typeof item.tool !== "string") throw new Error("Codex resume history contains invalid tool name");
    if (item.result !== undefined && item.result !== null) {
      const result = record(item.result);
      if (!result) throw new Error("Codex resume history contains invalid tool result");
      validateTextParts(result.content, false);
    }
    if (item.contentItems !== undefined && item.contentItems !== null) validateTextParts(item.contentItems, true);
  }
  // Unknown native item kinds remain intentionally unprojected, not malformed
  // supported messages. Their private metadata is not interpreted or exposed.
}

/** Hydrate paginated history with explicit bounds; never silently return a partial transcript. */
export async function readNativeHistory(rpc: CodexRpcProcess, threadId: string, checkpoint?: (turn: Record<string, unknown>) => void): Promise<RuntimeMessage[]> {
  const history: RuntimeMessage[] = [];
  const turns = new Set<string>();
  const cursors = new Set<string>();
  let cursor: string | undefined;
  let bytes = 0;
  let items = 0;
  for (let page = 0; page < 20; page++) {
    const response = record(await rpc.request("thread/turns/list", {
      threadId, limit: 100, sortDirection: "asc", itemsView: "full", ...(cursor ? { cursor } : {}),
    }));
    bytes += Buffer.byteLength(JSON.stringify(response) ?? "");
    if (!response || !Array.isArray(response.data) || response.data.length > 100 || bytes > RUNTIME_INPUT_LIMITS.transportBytes) {
      throw new Error("Codex resume history is invalid or exceeds bounds");
    }
    for (const value of response.data) {
      const turn = record(value);
      if (!turn || typeof turn.id !== "string" || !ID.test(turn.id) || turns.has(turn.id)
        || !["completed", "interrupted", "failed"].includes(turn.status as string)
        || turn.itemsView !== "full" || !Array.isArray(turn.items)) throw new Error("Codex resume history is incomplete or invalid");
      turns.add(turn.id);
      const itemIds = new Set<string>();
      for (const value of turn.items) {
        if (++items > 10_000) throw new Error("Codex resume history exceeds item bounds");
        const item = record(value);
        if (!item || typeof item.id !== "string" || !item.id || itemIds.has(item.id) || typeof item.type !== "string") {
          throw new Error("Codex resume history contains invalid items");
        }
        itemIds.add(item.id);
        validateProjectedItem(item);
        const message = normalizeCodexItem(item);
        if (message) history.push(message);
      }
      checkpoint?.(turn);
    }
    if (response.nextCursor === null) return history;
    if (typeof response.nextCursor !== "string" || !response.nextCursor || response.nextCursor.length > 4096 || cursors.has(response.nextCursor)) {
      throw new Error("Codex resume history has an invalid continuation cursor");
    }
    cursor = response.nextCursor;
    cursors.add(cursor);
  }
  throw new Error("Codex resume history exceeds page bounds");
}
