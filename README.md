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
  capabilities?(config?: Pick<AgentStartConfig, "cwd">): Promise<RuntimeLaunchCapabilities>;
  send(sessionId: string, input: string): Promise<void>;
  startTurn(sessionId: string, turnId: string, input: string): Promise<AgentTurn>;
  turn(sessionId: string, turnId: string): Promise<AgentTurn | undefined>;
  steer(sessionId: string, input: string): Promise<void>;
  interrupt(sessionId: string): Promise<void>;
  status(sessionId: string): Promise<AgentStatus>;
  events(sessionId: string): AsyncIterable<AgentEvent>;
  activityEvents?(
    sessionId: string,
    options: { signal: AbortSignal },
  ): AsyncIterable<RuntimeActivityEvent>;
  messages(sessionId: string): Promise<RuntimeMessage[]>;
  stop(sessionId: string): Promise<void>;
}
```

Runtime-owned sessions are preferred for agents created by applications. Attached sessions allow an existing native TUI to opt into Runtime through a minimal harness adapter.

`events` is the adapter-level stream and may contain message deltas, tool names, errors, operation IDs, and session IDs. Presentation layers must not consume it directly. Adapters may instead expose `activityEvents`, an optional sanitized stream containing only `working`, `using_tools`, or `responding` plus an observation timestamp. The Pi adapter coalesces repeated raw events, discards all private fields before yielding, and stops when the caller aborts.

`startTurn` accepts a caller-stable turn id and returns an existing running or terminal turn when retried. `turn` lets a caller recover completion and the assistant response after its own process reconnects. Turn records live with the active Runtime bridge, so they survive a Channels/Relay restart while the Runtime session remains alive; they do not survive termination of that Runtime session. Bridges retain the most recent 1,000 terminal/running turn records by default, defining the in-memory retry-idempotency window without allowing unbounded session growth.

## Personas

Owned sessions can append persistent persona instructions while preserving harness defaults:

```ts
await runtime.start({
  cwd: process.cwd(),
  appendSystemPrompt: "You are a skeptical code reviewer.",
});
```

Full system-prompt replacement is also available, but the append and replacement modes are mutually exclusive.

## Models and reasoning

Adapters may advertise launch capabilities and accept a structured model plus reasoning level for a new session:

```ts
const capabilities = await runtime.capabilities?.({ cwd: process.cwd() });
const session = await runtime.start({
  cwd: process.cwd(),
  model: { provider: "openai", id: "gpt-5.6-codex" },
  reasoningLevel: "high",
});
```

The Pi adapter discovers configured models through Pi RPC. At startup it verifies the exact provider/model, selects it, checks the model's available thinking levels, and then applies the requested reasoning level. Unsupported selections fail before the session is registered; they never silently fall back to Pi defaults. Launch selection is immutable for that session. Owned-worker startup remains supervised until readiness; timeout, setup failure, spawn failure, or early exit terminates and awaits the worker before launch artifacts are removed. Short bridge requests and control operations use bounded deadlines, while event streams remain caller-cancellable and long-lived.

## Skills

Adapters may advertise sanitized skill metadata and accept adapter-scoped skill ids when starting a session:

```ts
const capabilities = await runtime.capabilities?.({ cwd: process.cwd() });
const session = await runtime.start({
  cwd: process.cwd(),
  skillIds: capabilities?.skills.filter(({ id }) => id === "skill:code-review").map(({ id }) => id),
});
```

Omitting `skillIds` preserves the harness's default skill behavior. Supplying an empty array explicitly disables discovered skills for adapters that support selection. The Pi adapter discovers skills from its available-command RPC response, keeps native paths private, revalidates selected ids before launch, and starts the owned process with only those skills. Skill changes require a new session.

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

## License

MinuRuntime is licensed under the [Apache License 2.0](LICENSE).
