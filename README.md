# MinuRuntime

MinuRuntime is a small, harness-neutral execution layer for live agent sessions. It answers: how do I start, communicate with, observe, and stop an agent?

Runtime does not provide shared communication, durable session analytics, remote networking, or workflow orchestration. MinuChannels, MinuSessionStore, MinuLink, and MinuOrchestrator consume Runtime as an independent capability.

## Packages

- `core` — normalized `AgentRuntime`, lifecycle, status, events, messages, and start configuration.
- `pi` — Pi RPC worker, attached-TUI bridge, local registry, client, and standalone CLI.

## Contract

```ts
interface AgentRuntime {
  start(config?: AgentStartConfig): Promise<AgentSession>;
  send(sessionId: string, input: string): Promise<void>;
  startTurn(sessionId: string, turnId: string, input: string): Promise<AgentTurn>;
  turn(sessionId: string, turnId: string): Promise<AgentTurn | undefined>;
  steer(sessionId: string, input: string): Promise<void>;
  interrupt(sessionId: string): Promise<void>;
  status(sessionId: string): Promise<AgentStatus>;
  events(sessionId: string): AsyncIterable<AgentEvent>;
  messages(sessionId: string): Promise<RuntimeMessage[]>;
  stop(sessionId: string): Promise<void>;
}
```

Runtime-owned sessions are preferred for agents created by applications. Attached sessions allow an existing native TUI to opt into Runtime through a minimal harness adapter.

`startTurn` accepts a caller-stable turn id and returns an existing running or terminal turn when retried. `turn` lets a caller recover completion and the assistant response after its own process reconnects. Turn records live with the active Runtime bridge, so they survive a Channels/Relay restart while the Runtime session remains alive; they do not survive termination of that Runtime session.

## Personas

Owned sessions can append persistent persona instructions while preserving harness defaults:

```ts
await runtime.start({
  cwd: process.cwd(),
  appendSystemPrompt: "You are a skeptical code reviewer.",
});
```

Full system-prompt replacement is also available, but the append and replacement modes are mutually exclusive.

## Development

```bash
pnpm install
pnpm check
pnpm test
```

## CLI

Through the optional separately installed Minu CLI:

```bash
minu runtime start --cwd .
minu runtime sessions
minu runtime send --follow <session-id> "Review README.md"
minu runtime steer <session-id> "Focus on persistence"
minu runtime interrupt <session-id>
minu runtime stop <session-id>
```

Standalone:

```bash
# From this repository:
pnpm runtime start --cwd .

# After installing the focused CLI package:
minu-runtime start --cwd .
```

The standalone binary remains available so Runtime can be installed and used without the rest of the Minu stack.

`steer` is accepted only while an agent is working and delivers guidance at the harness's next safe model boundary. `interrupt` aborts active work but cannot undo tool or filesystem side effects. Normal `send` remains an idle-only operation.
