import type { AgentEvent, AgentStatus, AgentTurn, RuntimeActivityEvent, RuntimeMessage, RuntimeSessionCapabilities } from "@minu/runtime-core";

export const CLAUDE_WORKER_LIMITS = Object.freeze({
  jsonBytes: 8 * 1024 * 1024, frameBytes: 1024 * 1024, streamQueue: 64,
  streams: 16, drainMs: 1_000, requestMs: 30_000,
});
export interface ClaudeCodeWorkerIdentity { sessionId: string; ownerId: string; generation: string }
/** Private connection material. Never place tokens in command lines, events or UI. */
export interface ClaudeCodeWorkerConnection extends ClaudeCodeWorkerIdentity { endpoint: string; token: string }
export class ClaudeCodeWorkerError extends Error {
  constructor(readonly code: string, readonly status = 503) {
    super(`Claude Code worker request failed (${code})`);
    this.name = "ClaudeCodeWorkerError";
  }
}
export function workerIdentity(value: ClaudeCodeWorkerIdentity): void {
  if (![value.sessionId, value.ownerId, value.generation].every(part => typeof part === "string" && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(part))) {
    throw new ClaudeCodeWorkerError("invalid_identity", 400);
  }
}
export function workerToken(value: string): void {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) throw new ClaudeCodeWorkerError("invalid_token", 400);
}
export function envelope(identity: ClaudeCodeWorkerIdentity, value: unknown): object {
  return { version: 1, sessionId: identity.sessionId, generation: identity.generation, value };
}
export function unseal(identity: ClaudeCodeWorkerIdentity, payload: unknown): unknown {
  if (!payload || typeof payload !== "object") throw new ClaudeCodeWorkerError("invalid_response");
  const body = payload as Record<string, unknown>;
  if (body.version !== 1 || body.sessionId !== identity.sessionId || body.generation !== identity.generation) {
    throw new ClaudeCodeWorkerError("identity_mismatch");
  }
  return body.value;
}
export function workerActivity(value: unknown): RuntimeActivityEvent {
  const event = value as Partial<RuntimeActivityEvent> | null;
  if (!event || !["working", "using_tools", "responding"].includes(event.phase ?? "")
    || typeof event.observedAt !== "string" || !Number.isFinite(Date.parse(event.observedAt))) {
    throw new ClaudeCodeWorkerError("invalid_activity");
  }
  return { phase: event.phase!, observedAt: event.observedAt };
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ClaudeCodeWorkerError("invalid_response");
  return value as Record<string, unknown>;
}
function string(value: unknown): string {
  if (typeof value !== "string") throw new ClaudeCodeWorkerError("invalid_response");
  return value;
}
function date(value: unknown): string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) throw new ClaudeCodeWorkerError("invalid_response");
  return value;
}
export function workerAcknowledgment(value: unknown): void {
  if (object(value).acknowledged !== true) throw new ClaudeCodeWorkerError("invalid_response");
}
export function workerStatus(value: unknown): AgentStatus {
  if (!["idle", "working", "offline"].includes(value as string)) throw new ClaudeCodeWorkerError("invalid_response");
  return value as AgentStatus;
}
export function workerMessage(value: unknown): RuntimeMessage {
  const data = object(value);
  if (!["user", "assistant", "tool", "system"].includes(data.role as string)
    || (data.timestamp !== undefined && (typeof data.timestamp !== "number" || !Number.isFinite(data.timestamp)))) throw new ClaudeCodeWorkerError("invalid_response");
  return { role: data.role as RuntimeMessage["role"], content: string(data.content),
    ...(data.timestamp === undefined ? {} : { timestamp: data.timestamp as number }),
    ...(data.toolName === undefined ? {} : { toolName: string(data.toolName) }) };
}
export function workerTurn(value: unknown): AgentTurn {
  const data = object(value);
  if (!["running", "completed", "failed", "interrupted"].includes(data.status as string)) throw new ClaudeCodeWorkerError("invalid_response");
  return { id: turnId(data.id), status: data.status as AgentTurn["status"], input: string(data.input),
    createdAt: date(data.createdAt), updatedAt: date(data.updatedAt),
    ...(data.error === undefined ? {} : { error: string(data.error) }),
    ...(data.response === undefined ? {} : { response: workerMessage(data.response) }) };
}
export function workerCapabilities(value: unknown): RuntimeSessionCapabilities | null {
  if (value === null) return null;
  const data = object(value);
  if (data.version !== 1 || !["safeActivityEvents", "interrupt", "reconnectExisting", "interactiveAttach", "openDiagnostic", "liveSkillVerification"]
    .every(key => typeof data[key] === "boolean")) throw new ClaudeCodeWorkerError("invalid_response");
  return { version: 1, safeActivityEvents: data.safeActivityEvents as boolean, interrupt: data.interrupt as boolean,
    reconnectExisting: data.reconnectExisting as boolean, interactiveAttach: data.interactiveAttach as boolean,
    openDiagnostic: data.openDiagnostic as boolean, liveSkillVerification: data.liveSkillVerification as boolean };
}
export function workerEvent(value: unknown, sessionId: string): AgentEvent {
  const data = object(value);
  if (data.sessionId !== sessionId) throw new ClaudeCodeWorkerError("identity_mismatch");
  const base = { sessionId, timestamp: date(data.timestamp) };
  switch (data.type) {
    case "status": return { ...base, type: "status", status: workerStatus(data.status) };
    case "turn_started": case "turn_completed": return { ...base, type: data.type, operationId: turnId(data.operationId) };
    case "message_delta": return { ...base, type: "message_delta", delta: string(data.delta) };
    case "tool_started": return { ...base, type: "tool_started", toolCallId: string(data.toolCallId), toolName: string(data.toolName) };
    case "tool_completed":
      if (typeof data.isError !== "boolean") throw new ClaudeCodeWorkerError("invalid_response");
      return { ...base, type: "tool_completed", toolCallId: string(data.toolCallId), toolName: string(data.toolName), isError: data.isError };
    case "error": return { ...base, type: "error", message: string(data.message),
      ...(data.operationId === undefined ? {} : { operationId: turnId(data.operationId) }) };
    default: throw new ClaudeCodeWorkerError("invalid_response");
  }
}
export function turnId(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.includes("\0") || Buffer.byteLength(value) > 256) {
    throw new ClaudeCodeWorkerError("invalid_turn_id", 400);
  }
  return value;
}
