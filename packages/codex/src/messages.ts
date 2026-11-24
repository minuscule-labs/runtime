import type { RuntimeMessage } from "@minu/runtime-core";
import { record } from "./rpc.js";

export function toolName(item: Record<string, unknown>): string | undefined {
  switch (item.type) {
    case "commandExecution": return "shell";
    case "fileChange": return "apply_patch";
    case "webSearch": return "web_search";
    case "mcpToolCall": return typeof item.tool === "string" ? item.tool : "mcp";
    case "dynamicToolCall": return typeof item.tool === "string" ? item.tool : "dynamic_tool";
    case "collabAgentToolCall": return typeof item.tool === "string" ? item.tool : "collab_agent";
    default: return undefined;
  }
}

function textParts(value: unknown): string {
  if (!Array.isArray(value)) return "";
  return value.flatMap((part) => {
    const entry = record(part);
    return entry?.type === "text" && typeof entry.text === "string" ? [entry.text] : [];
  }).join("\n");
}

/** Omit reasoning, native metadata and image parts. Textual content is not redacted. */
export function normalizeCodexItem(item: Record<string, unknown>): RuntimeMessage | undefined {
  if (item.type === "agentMessage" && typeof item.text === "string") {
    return { role: "assistant", content: item.text };
  }
  if (item.type === "userMessage") return { role: "user", content: textParts(item.content) };
  const name = toolName(item);
  if (!name) return undefined;
  const content = typeof item.aggregatedOutput === "string" ? item.aggregatedOutput
    : textParts(record(item.result)?.content ?? item.contentItems);
  return { role: "tool", toolName: name, content };
}

export function finalResponse(items: Iterable<Record<string, unknown>>): RuntimeMessage | undefined {
  let response: RuntimeMessage | undefined;
  for (const item of items) {
    // Null/missing phase is supported for models that do not classify messages.
    // An explicit final answer may be empty when the work itself was the answer.
    if (item.type === "agentMessage" && item.phase !== "commentary" && typeof item.text === "string"
      && (item.text.trim() || (item.phase === "final_answer" && !response))) {
      response = { role: "assistant", content: item.text };
    }
  }
  return response;
}
