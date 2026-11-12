import { PiAgentRuntime } from "@minu/runtime-pi";
import { CodexAgentRuntime, type CodexAgentRuntimeOptions } from "@minu/runtime-codex";
import type { AgentRuntime } from "@minu/runtime-core";
export * from "@minu/runtime-core";
export { PiAgentRuntime, CodexAgentRuntime };
export type { CodexAgentRuntimeOptions };
export type RuntimeAdapterId = "pi" | "codex";
type PiOptions = NonNullable<ConstructorParameters<typeof PiAgentRuntime>[0]>;

export function createRuntime(adapter: "codex", options?: CodexAgentRuntimeOptions): CodexAgentRuntime;
export function createRuntime(adapter?: "pi", options?: PiOptions): PiAgentRuntime;
export function createRuntime(adapter: RuntimeAdapterId, options?: PiOptions | CodexAgentRuntimeOptions): AgentRuntime;
export function createRuntime(adapter: RuntimeAdapterId = "pi", options: PiOptions | CodexAgentRuntimeOptions = {}): AgentRuntime {
  if (adapter === "pi") return new PiAgentRuntime(options as PiOptions);
  if (adapter === "codex") return new CodexAgentRuntime(options as CodexAgentRuntimeOptions);
  throw new Error("Unsupported Runtime adapter");
}

/** Qualified IDs preserve adapter identity across CLI/controller restarts. */
export function runtimeReference(value: string, explicit?: RuntimeAdapterId): { adapter: RuntimeAdapterId; id: string } {
  const prefix = /^(pi|codex):(.+)$/.exec(value);
  if (!prefix && /^(pi|codex):/.test(value)) throw new Error("Invalid Runtime session reference");
  if (prefix && explicit && prefix[1] !== explicit) throw new Error("Runtime adapter conflicts with session reference");
  const adapter = prefix ? prefix[1] as RuntimeAdapterId : explicit ?? "pi";
  if (adapter !== "pi" && adapter !== "codex") throw new Error("Unsupported Runtime adapter");
  return { adapter, id: prefix ? prefix[2] : value };
}
