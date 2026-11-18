import type { AgentRuntime, AgentSession, AgentStartConfig, AgentTurn } from "@minu/runtime-core";
import { runtimeInput } from "@minu/runtime-core";
import {
  ClaudeCodeAgentRuntime, type ClaudeCodeNativeLaunch, type ClaudeCodeRuntimeOptions,
  type ClaudeCodeSettlementEvidence,
} from "./client.js";

export type ClaudeCodeNativeOpen =
  | (ClaudeCodeNativeLaunch & { mode: "create"; firstInput: string })
  | (ClaudeCodeNativeLaunch & { mode: "resume"; firstInput?: never });

class NativeRuntime extends ClaudeCodeAgentRuntime {
  open(config: AgentStartConfig, native: ClaudeCodeNativeLaunch): Promise<AgentSession> {
    return this.launch(config, native);
  }
  mappedTurn(id: string, turnId: string, input: string, nativeMessageId: string): Promise<AgentTurn> {
    return this.acceptTurn(id, turnId, input, undefined, nativeMessageId);
  }
  evidence(id: string, turnId: string): ClaudeCodeSettlementEvidence | undefined {
    return this.settlementEvidence(id, turnId);
  }
}

/**
 * Internal persistent native primitive, not managed ownership or recovery authority.
 * The caller must hold owner/generation/workspace/policy admission through opening,
 * record the exact native binding before input, and persist dispatch intent before
 * startMappedTurn. Resume never starts a replacement or reconstructs caller turns.
 * Native firstInput is validated for create but is NOT automatically dispatched.
 */
export async function openClaudeCodeNativeSession(
  config: AgentStartConfig, native: ClaudeCodeNativeOpen, options: ClaudeCodeRuntimeOptions = {},
): Promise<{
  runtime: AgentRuntime;
  session: AgentSession;
  startMappedTurn(turnId: string, input: string, nativeMessageId: string): Promise<AgentTurn>;
  evidence(turnId: string): ClaudeCodeSettlementEvidence | undefined;
}> {
  const snapshot = { ...native };
  if (snapshot.mode === "create") runtimeInput(snapshot.firstInput, undefined);
  const runtime = new NativeRuntime(options);
  const session = await runtime.open(config, snapshot);
  return {
    runtime, session: { ...session },
    startMappedTurn: (turnId, input, nativeMessageId) => runtime.mappedTurn(session.id, turnId, input, nativeMessageId),
    evidence: turnId => runtime.evidence(session.id, turnId),
  };
}
