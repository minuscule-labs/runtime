import { PiAgentRuntime } from "@minu/runtime-pi";
import { CodexAgentRuntime, type CodexAgentRuntimeOptions } from "@minu/runtime-codex";
import { ClaudeCodeAgentRuntime, type ClaudeCodeRuntimeOptions } from "@minu/runtime-claude-code";
import type { AgentRuntime } from "@minu/runtime-core";
export * from "@minu/runtime-core";
export { PiAgentRuntime, CodexAgentRuntime, ClaudeCodeAgentRuntime };
export type { CodexAgentRuntimeOptions, ClaudeCodeRuntimeOptions };
export type RuntimeAdapterId = "pi" | "codex" | "claude-code";
type PiOptions = NonNullable<ConstructorParameters<typeof PiAgentRuntime>[0]>;

export function createRuntime(adapter: "codex", options?: CodexAgentRuntimeOptions): CodexAgentRuntime;
export function createRuntime(adapter: "claude-code", options?: ClaudeCodeRuntimeOptions): ClaudeCodeAgentRuntime;
export function createRuntime(adapter?: "pi", options?: PiOptions): PiAgentRuntime;
export function createRuntime(adapter: RuntimeAdapterId, options?: PiOptions | CodexAgentRuntimeOptions | ClaudeCodeRuntimeOptions): AgentRuntime;
export function createRuntime(adapter: RuntimeAdapterId = "pi", options: PiOptions | CodexAgentRuntimeOptions | ClaudeCodeRuntimeOptions = {}): AgentRuntime {
  if (adapter === "pi") return new PiAgentRuntime(options as PiOptions);
  if (adapter === "codex") return new CodexAgentRuntime(options as CodexAgentRuntimeOptions);
  if (adapter === "claude-code") return new ClaudeCodeAgentRuntime(options as ClaudeCodeRuntimeOptions);
  throw new Error("Unsupported Runtime adapter");
}

/** Qualified IDs preserve adapter identity across CLI/controller restarts. */
export function runtimeReference(value: string, explicit?: RuntimeAdapterId): { adapter: RuntimeAdapterId; id: string } {
  const prefix = /^(pi|codex|claude-code):(.+)$/.exec(value);
  if (!prefix && /^(pi|codex|claude-code):/.test(value)) throw new Error("Invalid Runtime session reference");
  if (prefix && explicit && prefix[1] !== explicit) throw new Error("Runtime adapter conflicts with session reference");
  const adapter = prefix ? prefix[1] as RuntimeAdapterId : explicit ?? "pi";
  if (adapter !== "pi" && adapter !== "codex" && adapter !== "claude-code") throw new Error("Unsupported Runtime adapter");
  return { adapter, id: prefix ? prefix[2] : value };
}
