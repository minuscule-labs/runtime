export type AgentStatus = "idle" | "working" | "offline";
export type AgentOwnership = "owned" | "attached";

export interface AgentSession {
  id: string;
  runtime: string;
  ownership: AgentOwnership;
  cwd: string;
}

export interface AgentStartConfig {
  cwd?: string;
  /** Replace the harness's default system prompt. Prefer appendSystemPrompt for personas. */
  systemPrompt?: string;
  /** Add persistent role/persona instructions while preserving the harness defaults. */
  appendSystemPrompt?: string;
}

export interface RuntimeMessage {
  role: "user" | "assistant" | "tool" | "system";
  content: string;
  timestamp?: number;
  toolName?: string;
}

export type AgentTurnStatus = "running" | "completed" | "failed" | "interrupted";

export interface AgentTurn {
  id: string;
  status: AgentTurnStatus;
  input: string;
  response?: RuntimeMessage;
  error?: string;
  createdAt: string;
  updatedAt: string;
}

interface EventBase {
  sessionId: string;
  timestamp: string;
}

export type AgentEvent =
  | (EventBase & { type: "status"; status: AgentStatus })
  | (EventBase & { type: "turn_started"; operationId: string })
  | (EventBase & { type: "turn_completed"; operationId: string })
  | (EventBase & { type: "message_delta"; delta: string })
  | (EventBase & { type: "tool_started"; toolCallId: string; toolName: string })
  | (EventBase & {
      type: "tool_completed";
      toolCallId: string;
      toolName: string;
      isError: boolean;
    })
  | (EventBase & { type: "error"; operationId?: string; message: string });

export interface AgentRuntime {
  /** Launch and own a new agent process. */
  start(config?: AgentStartConfig): Promise<AgentSession>;
  /** Send input to an idle session and resolve after the resulting run settles. */
  send(sessionId: string, input: string): Promise<void>;
  /** Idempotently start or recover a turn identified by a caller-stable id. */
  startTurn(sessionId: string, turnId: string, input: string): Promise<AgentTurn>;
  /** Read a previously accepted turn. */
  turn(sessionId: string, turnId: string): Promise<AgentTurn | undefined>;
  /** Adjust an active run at the harness's next safe model boundary. */
  steer(sessionId: string, input: string): Promise<void>;
  /** Abort the active run. This does not undo tool side effects. */
  interrupt(sessionId: string): Promise<void>;
  status(sessionId: string): Promise<AgentStatus>;
  events(sessionId: string): AsyncIterable<AgentEvent>;
  messages(sessionId: string): Promise<RuntimeMessage[]>;
  /** Stop a runtime-owned session. Attached sessions cannot be stopped by Runtime. */
  stop(sessionId: string): Promise<void>;
}
