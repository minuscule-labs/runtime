import type { RuntimeMessage } from "@minu/runtime-core";

function textContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => {
      if (!block || typeof block !== "object") return "";
      const value = block as Record<string, unknown>;
      if (value.type === "text" && typeof value.text === "string") return value.text;
      if (value.type === "toolCall" && typeof value.name === "string") return `[tool: ${value.name}]`;
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

export function normalizePiMessages(messages: unknown[]): RuntimeMessage[] {
  const normalized: RuntimeMessage[] = [];
  for (const item of messages) {
    if (!item || typeof item !== "object") continue;
    const message = item as Record<string, unknown>;
    const role = message.role;
    let normalizedRole: RuntimeMessage["role"];
    if (role === "user") normalizedRole = "user";
    else if (role === "assistant") normalizedRole = "assistant";
    else if (role === "toolResult" || role === "bashExecution") normalizedRole = "tool";
    else if (role === "system") normalizedRole = "system";
    else continue;

    const content = role === "bashExecution" ? String(message.output ?? "") : textContent(message.content);
    if (!content) continue;
    normalized.push({
      role: normalizedRole,
      content,
      timestamp: typeof message.timestamp === "number" ? message.timestamp : undefined,
      toolName: typeof message.toolName === "string" ? message.toolName : undefined,
    });
  }
  return normalized;
}

export function normalizeSessionEntries(entries: unknown[]): RuntimeMessage[] {
  return normalizePiMessages(
    entries.flatMap((entry) => {
      if (!entry || typeof entry !== "object") return [];
      const value = entry as Record<string, unknown>;
      return value.type === "message" && value.message ? [value.message] : [];
    }),
  );
}
