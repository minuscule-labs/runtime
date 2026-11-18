# MinuRuntime

MinuRuntime is a small, harness-neutral execution layer for live agent sessions. It answers: how do I start, communicate with, observe, and stop an agent?

Runtime does not provide shared communication, durable session analytics, remote networking, or workflow orchestration. MinuChannels, MinuSessionStore, MinuLink, and MinuOrchestrator consume Runtime as an independent capability.

## Packages

- `core` — normalized `AgentRuntime`, lifecycle, status, events, messages, and start configuration.
- `pi` — Pi RPC worker, attached-TUI bridge, local registry, client, and standalone CLI.
- `claude-code` — native Claude SDK adapter, durable text-only controller and standalone CLI (implementation reviewed; real-auth acceptance pending).

## Claude Code adapter (initial slice)

`@minu/runtime-claude-code` implements Runtime using one long-lived Claude Agent
SDK query and its native process per session. It pins SDK `0.3.321`, including its
platform-specific Claude Code engine; a separate `claude` on PATH is not required.
Install optional dependencies for your platform. Native authentication must already
be configured, or supplied through the environment.

```ts
import { ClaudeCodeAgentRuntime } from "@minu/runtime-claude-code";

const runtime = new ClaudeCodeAgentRuntime();
const session = await runtime.start({
  cwd: process.cwd(),
  appendSystemPrompt: "You are a skeptical code reviewer.",
});
try {
  await runtime.send(session.id, "Review README.md without changing files.");
  console.log(await runtime.messages(session.id));
} finally {
  await runtime.stop(session.id);
}
```

The initial adapter supports text turns, caller-stable turn IDs, normalized
messages/events, sanitized activity and interruption. Input is sent literally,
without slash-command dispatch or file-mention expansion. Appended personas retain
the native Claude Code prompt; full `systemPrompt` replacement is mutually exclusive.
The native default model is used. Explicit model/reasoning/skill selections, images
and steering are rejected rather than silently ignored.

By default only `Read`, `Grep` and `Glob` are exposed. Constructor `tools` can change
that list; `canUseTool` can answer native permission requests. Without a handler,
requests are denied. Permission mode is explicitly `default`, never bypass/auto or
accept-edits. **The callback is not an all-tool gate:** native auto-allowed actions
need not ask it. Exposing more tools is an explicit policy decision. This is not an
OS sandbox, and read tools are not confined to the workspace. Interruption and stop
do not undo tool side effects.

User/project/local filesystem settings, configured hooks and MCP discovery are
not inherited: the adapter requests SDK isolation, disables hooks and uses strict
empty MCP/plugin configuration. Machine-admin policies and native authentication
still apply. The subprocess otherwise inherits the host environment; constructor
`env`, when supplied, replaces it entirely. No Pi extensions/settings are loaded.
Native transcript persistence is disabled, not a secure-erasure or no-artifacts
guarantee. Prompts and tool content can still reach the selected provider.

Turn idempotency is instance-local within the most recent 1,000 retained turns
(configurable with `turnRetentionLimit`). Messages live in memory for the session.
Each event subscriber has a bounded queue; a slow consumer is disconnected without
stalling the agent. Raw events and message text are not presentation-safe; only
`activityEvents` has the fixed sanitized vocabulary. An interrupt acknowledgment
is not completion: the turn remains busy until a native terminal result. Uncertain
control failures take the session offline and stop it; no automatic replay occurs.
`stop` confirms the exact native process exit or rejects, not independent exit of
all tool descendants or a managed recovery fence.

The in-process class has no managed lifecycle. `ClaudeCodeManagedRuntime` separately
implements the durable text-only MVP below; forced recovery, destroy, rich live
profiles/diagnostics and native TUI attachment remain outside that implementation.
The existing `runtime` CLI and Channels/Conversations loading remain Pi-only.

### Durable text-only MVP (real-auth acceptance pending)

`ClaudeCodeManagedRuntime` takes one exact `ownerId`, explicit `storeRoot`, an
existing owner-private canonical `nativeConfigRoot`, and explicit `nativeOptions.env`
with matching `CLAUDE_CONFIG_DIR`. There is no inherited/default credential or state
root. The harness still owns authentication and tools. Trusted executable/env
settings must obey the [conditional process-family contract](docs/claude-code-process-family-contract.md);
process groups are not OS containment or a filesystem sandbox.

Supported path: managed create/readiness, literal text/streams/history/status,
interrupt, owner inventory, reconnect to a living worker, healthy idle-only stop and
explicit same-history resume. Stop observes the eligible fresh process-family's
absence, requires exact unchanged metadata and materialization of an independently
completed latest input, then fences/clears the worker under CAS. Resume requires
`{ allowStopped: true }`. No missing-history fallback, unknown-outcome replay,
legacy null-group migration or busy/unreachable recovery. Busy stop is refused. An interrupted but healthy worker needs a fresh confirmed
completed turn before clean suspension; failed/uncertain sessions remain refused
rather than guessing history eligibility.

Caller turn results/idempotence are retained within a living worker, not rebuilt
from transcript text after worker restart. Use new turn IDs after explicit resume;
the known previous-epoch last ID is refused, not redispatched or fabricated.
Supported history is the pinned bounded linear subset, not compaction/branching.
One verified real authentication/provider path and production acceptance remain
pending; synthetic-provider tests do not establish subscription compatibility.

Build first, then use `pnpm runtime:claude` (or the package's `minu-claude-runtime`
bin). Commands: `create`, `list`, `get`, `status`, `run`, `turn`, `history`, `interrupt`,
`stop`, `resume`, `events`, `activity`. All require `--owner`, `--state` and
`--native-root`; session commands also take `--id`, `turn` takes `--turn-id`, and
`create` accepts `--cwd`. Credentials come from the explicit operator environment,
never arguments. `run` reads a bounded UTF-8 JSON object from stdin only:

```json
{"turnId":"fresh-caller-id","input":"Literal user input"}
```

For example, `pnpm runtime:claude run --owner OWNER --state /private/state
--native-root /private/native --id SESSION < turn.json` (one shell command).
No automatic real-provider/authentication acceptance is authorized by these examples.
The MVP does not complete or remove full R01–R41 requirements.

Verification includes SDK protocol fixtures and a real bundled-engine integration
with an isolated temporary home and localhost synthetic provider, covering multi-turn
text, literal input, interruption and denied native writes. It does not establish
real model quality, paid-provider authentication or successful tool-write behavior.

CLI-only black-box tests exercise fresh-process reconnect, empty-session stop/resume,
owner/configuration isolation, invalid input, private errors and event cancellation
without model requests or adapter/store imports. Run them after building:

```sh
pnpm check
node --test packages/claude-code/dist/test/cli-black-box.test.js
```

## Contract

```ts
interface AgentRuntime {
  start(config?: AgentStartConfig): Promise<AgentSession>;
  startManaged?(config: AgentStartConfig, ownerId: string): Promise<ManagedAgentSession>;
  suspend?(managedSessionId: string, ownerId: string): Promise<void>;
  forceStopManaged?(managedSessionId: string, ownerId: string): Promise<void>;
  resume?(managedSessionId: string, ownerId: string, options?: { allowStopped?: boolean }): Promise<ManagedAgentSession>;
  destroy?(managedSessionId: string, ownerId: string): Promise<void>;
  getManagedSession?(managedSessionId: string, ownerId: string, options?: { signal?: AbortSignal }): Promise<ManagedSessionSummary | undefined>;
  listManagedSessions?(ownerId: string, options?: { signal?: AbortSignal }): Promise<ManagedSessionSummary[]>;
  capabilities?(config?: Pick<AgentStartConfig, "cwd">): Promise<RuntimeLaunchCapabilities>;
  send(sessionId: string, input: string, images?: RuntimeImageContent[]): Promise<void>;
  startTurn(sessionId: string, turnId: string, input: string, images?: RuntimeImageContent[]): Promise<AgentTurn>;
  inputCapabilities?(sessionId: string): Promise<RuntimeInputCapabilities>;
  turn(sessionId: string, turnId: string): Promise<AgentTurn | undefined>;
  steer(sessionId: string, input: string): Promise<void>;
  interrupt(sessionId: string): Promise<void>;
  status(sessionId: string): Promise<AgentStatus>;
  sessionCapabilities?(sessionId: string): Promise<RuntimeSessionCapabilities>;
  inspectSessionProfile?(managedSessionId: string, ownerId: string, options?: { signal?: AbortSignal }): Promise<RuntimeSessionProfile | undefined>;
  inspectSessionEvents?(managedSessionId: string, ownerId: string, options?: { signal?: AbortSignal }): Promise<RuntimeSessionEvents | undefined>;
  openDiagnostic?(sessionId: string): Promise<void>;
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

## Managed-session lifecycle

Adapters may implement the optional owner-scoped `startManaged`, `suspend`, `resume`, `destroy`, `getManagedSession`, and `listManagedSessions` operations. The consumer supplies a stable opaque `ownerId` for its installation. `ManagedAgentSession.id` is generated by Runtime, remains stable across worker restarts, and is the ID used by the normal send/status/events APIs; Pi-native IDs remain private adapter details. A managed ID can only be resumed, suspended, destroyed, or enumerated in its exact owner scope.

The Pi adapter persists versioned resume manifests and transcripts in owner-private storage. It uses Node's built-in SQLite transaction locks for crash-safe cross-process lifecycle serialization (managed sessions require Node.js 22.5 or newer). It starts Pi against a managed transcript file, permits suspend only while idle, and validates private-file ownership, transcript identity, and journal-entry ancestry before resume; repeated resume returns the already-active session rather than launching another worker. Pi owns entry payload and message-role interpretation: Runtime does not keep a second allowlist that rejects newer native entries such as context edits or usage records. Additional tree roots are allowed, while malformed JSON, broken ancestry, duplicate IDs, redirected files, and identity mismatches still fail closed. Resume reopens the same transcript and preserves the managed ID even if Pi reports a different native ID. `listManagedSessions` returns only IDs, owner scope, sanitized state, known timestamps, and an optional bounded `unavailableReason` (`session_metadata_unavailable` or `session_transcript_invalid`); incomplete/corrupt registrations are reported as unavailable rather than silently omitted. For managed sessions, generic `stop` preserves resume metadata like `suspend`; use `destroy` to discard Runtime resume metadata. Destruction deliberately does not delete the Pi transcript. Legacy `start` and attached-TUI sessions retain their existing adapter-native addressing and do not gain managed lifecycle semantics.

`getManagedSession(id, ownerId)` is the hot-path lookup: it reads only that exact owner-scoped manifest and registration, never enumerates sessions, opens transcripts, or cleans up registrations. A `suspended` result means resume material is recorded, not that its contents have been validated; only `resume` validates the selected transcript under the lifecycle lock before launching a writer. Use `listManagedSessions` for inventory, not as a prerequisite for recovering one session. Both lookup APIs accept an optional cancellation signal.

Full transcript validation, including resume and inventory reads, retains the emergency recovery build's backpressure: at most four validators per Runtime module and one per transcript path. Cancellation removes queued validation and stops active validation between chunks. An already-issued OS read is allowed to return, and its slot stays occupied until the handle closes; cancellation never permits an overlapping reader. Exact metadata-only status checks do not enter this transcript-validation queue.

`forceStopManaged` is explicit recovery, not idle sleep: it stops a busy or unresponsive exact-owner worker without a healthy status/native RPC prerequisite and preserves its transcript. A persisted recovery fence rejects automatic/stale `resume` calls; only an explicit human resume uses `{ allowStopped: true }`, and a failed resume does not clear that fence. Successful completion means physical worker exit, not merely an HTTP acknowledgment or missing registration. New POSIX workers have a dedicated process group, verified against their exact managed ID, owner, worker executable and group before TERM/KILL escalation. Legacy shared-group workers receive only worker-targeted TERM and require observed descendant exit; unverifiable/unsupported shutdown fails closed. No broad process-name kills, transcript deletion, automatic replacement or tool-side-effect rollback occurs. Consumers must fence message delivery and settle their old routing tasks before resuming. Windows does not support process-signal fallback; an unreachable worker remains unconfirmed.

`events` is the adapter-level stream and may contain message deltas, tool names, errors, operation IDs, and session IDs. Presentation layers must not consume it directly. Adapters may instead expose `activityEvents`, an optional sanitized stream containing only `working`, `using_tools`, or `responding` plus an observation timestamp. The Pi adapter coalesces repeated raw events, discards all private fields before yielding, and stops when the caller aborts.

`sessionCapabilities` is an optional live-session query, distinct from launch-time `capabilities`. Version 1 returns only booleans for safe activity events, interruption, reconnecting an existing live session, interactive attachment, diagnostic opening, and live skill verification. Consumers must treat an absent or failed query as **not verified**, not as proof that a capability is unsupported. The Pi bridge computes this response from the currently reachable session and never includes session IDs, endpoints, paths, commands, tools, providers, or credentials.

`inspectSessionProfile` is an optional, separately versioned read of an **existing owner-scoped managed worker**, not launch discovery. Pi observes that process’s model, reasoning, and available skill-command identifiers through `get_state`, `get_commands`, and a confirming `get_state`. Each field is verified or not verified; commands do not prove loaded instructions or turn usage. The allowlisted profile contains no prompts, raw state, model credentials, paths, native IDs, PIDs or tokens. Reads are limited to two seconds, 16 KiB of UTF-8 transport and 64 skill identifiers, with cancellation covering registration reads, HTTP and body decoding. One physical read per session and at most 16 per client remain occupied until their underlying work settles; stalled inspection never grants lifecycle authority. The bridge separately bounds its getter and RPC reads.

Missing/older workers, unsupported versions, unsafe registrations, suspended sessions, and unavailable evidence return `undefined`; caller cancellation throws `AbortError`. There is no start, resume, message, registry cleanup, manifest migration, credential refresh or fallback to saved launch configuration. Registration inspection requires owner-private POSIX permissions and uses bounded, non-following/non-blocking file reads; redirects are rejected and registration replacement fences late results. Attached and legacy sessions do not acquire this optional managed-session capability.

`inspectSessionEvents` reads the current managed worker's **structured Runtime bridge observations**, not Pi/Codex logs. It returns a version-one `runtime_bridge` snapshot with capture/recording-since times, an eviction count and at most 200 ordered records containing only a sequence, worker observation time and fixed event code. The total UTF-8 transport is capped at 32 KiB; reads have a two-second deadline. It shares the profile reader's per-session physical slot and 16-read per-client budget, pure registration inspection, exact owner/session authentication, cancellation, redirect rejection and worker-replacement fencing. No discovery, RPC, message/transcript/log reading, file writes or process wakeup occurs. The bridge route is read-only and `no-store`; attached/legacy/old workers and unavailable sources return `undefined` without a fallback. Caller cancellation throws `AbortError`.

The in-memory window starts when the already-verified managed worker creates its bridge. A resumed/replaced worker starts a new window at sequence one; no persistent history, pagination or cross-worker continuity is promised. `eventsDropped` counts evicted records, so zero retained events is not evidence of health or complete logical-session history. Reads and raw harness events do not add records. Recording has fixed memory bounds and cannot fail an authoritative operation; a failed recorder makes the optional snapshot unavailable, not a misleading empty history.

Event codes describe only observed Runtime boundaries:

- `bridge_ready`: bridge listener is ready, not proof of downstream routing or model health.
- `turn_accepted`, `turn_reused`, `turn_rejected_conflict`: turn admission/idempotency decisions, without IDs or input.
- `turn_dispatch_requested`, `turn_dispatch_returned`, `turn_dispatch_failed`: invocation/result of the adapter send callback; a returned callback is not proof of Channels delivery.
- `turn_completed`, `turn_failed`: the Runtime turn tracker recorded a result after response extraction; not confirmation of a public Conversation response.
- `request_rejected_busy`: a control/turn request was rejected as busy.
- `steer_requested`, `steer_acknowledged`, `steer_failed`, `interrupt_requested`, `interrupt_acknowledged`, `interrupt_failed`: control callback observations; acknowledgment does not prove turn settlement.
- `stop_requested`: stop admitted; no claim of physical process exit or completed cleanup.

There are no free-text errors, prompts, payloads, tool names, severities or private/native identifiers. Consumers independently authorize the human/resource, revalidate their binding generation around reads, render curated labels and discard stale snapshots. Channels' own operation timeline remains the source for host routing, lifecycle and delivery observations; Runtime events must not be misrepresented as those observations.

`openDiagnostic` is an optional explicit local action. It returns no path or content: the adapter asks the reachable session to open its own diagnostic with an installed OS viewer. Runtime-owned Pi sessions expose a private, permission-restricted log capped at 1 MiB; attached sessions and hosts without a verified local opener leave the live capability false. The authenticated bridge response contains only an allowlisted completion state.

`startTurn` accepts a caller-stable turn id and returns an existing running or terminal turn when retried. `turn` lets a caller recover completion and the assistant response after its own process reconnects. Turn records live with the active Runtime bridge, so they survive a Channels/Relay restart while the Runtime session remains alive; they do not survive termination of that Runtime session. Bridges retain the most recent 1,000 terminal/running turn records by default, defining the in-memory retry-idempotency window without allowing unbounded session growth. Execution ownership uses turn-instance identity, so late cleanup from an evicted, canceled entry cannot alter a newer execution reusing its caller ID.

## Image input

Text callers remain unchanged. Adapters can additionally accept ordered typed raster parts:

```ts
interface RuntimeImageContent {
  type: "image";
  data: string; // canonical base64 bytes, not a path, URL or data URI
  mimeType: "image/png" | "image/jpeg" | "image/gif" | "image/webp";
}
interface RuntimeInputCapabilities { version: 1; images: boolean }

if ((await runtime.inputCapabilities?.(sessionId))?.images === true) {
  await runtime.startTurn(sessionId, "caller-stable-turn", "Inspect the image", [image]);
}
```

The optional authenticated live query is separate from launch discovery and existing session-control capabilities. Missing/failed queries mean **not verified**. Owned Pi workers verify the current `get_state` model's `input` includes `image`, then recheck at dispatch. Text-only, unknown and attached-TUI sessions do not claim image support; the bridge rejects their image input rather than silently discarding pixels. Existing text send, steering and transcript projections are unchanged.

Client and bridge validate canonical base64, MIME and bounds: four images, 10 MiB each, 20 MiB combined and 1 MiB text. The JSON transport is separately capped at 34 MiB to accommodate base64 and text escaping. Runtime does not decode/resize pixels or fetch URLs; the consumer validates image containers and decides what to omit before submission. Owned Pi maps these parts to the native RPC `prompt.images` field, relying on the harness/provider for normal pixel processing.

Accepted turns remain cancellable while transcript or final model-capability reads are pending. Before native dispatch, cancellation settles locally without sending a native abort; a late read is fenced from dispatching or changing a subsequent turn. Once native work is dispatched, the existing native interruption/acknowledgment semantics apply, without claiming to undo side effects.

Turn identity covers text plus ordered image bytes/MIME. Matching concurrent/repeated requests reuse one turn; changed pixels or ordering conflict. Only a digest is retained for idempotency, in the same bounded retention window as turns; turn polling, normalized `messages`, structured events and image-dispatch errors do not return pixels. As with any native prompt, **Pi may persist the image parts in its owner-private transcript** and submit them to the selected model provider. Transcript resume preserves them; Runtime is not an independent attachment store and makes no secure-erasure claim.

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

The Pi adapter discovers configured models through Pi RPC and reports the sanitized effective model and reasoning defaults that would be used when launch selections are omitted. At startup it verifies the exact provider/model, selects it, checks the model's available thinking levels, and then applies the requested reasoning level. Unsupported selections fail before the session is registered; they never silently fall back to Pi defaults. Launch selection is immutable for that session. Owned-worker startup remains supervised until readiness; timeout, setup failure, spawn failure, or early exit terminates and awaits the worker before launch artifacts are removed. Short bridge requests and control operations use bounded deadlines, while event streams remain caller-cancellable and long-lived.

## Extensions and MCP

Owned Pi workers inherit Pi's configured extensions and MCP servers, including its normal built-in extensions. Runtime does not filter them or force codemode on; enable codemode through Pi's settings. Configured extensions execute code and MCP servers may start processes or connect to external services. Workers launch with `--approve`, so project-local configuration is trusted for that process.

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

Owned Pi workers inherit their host's environment. Authorized API workflows can use existing shell tools; credentials must reach the actual host process, not only an interactive terminal. Runtime does not provision secrets or treat Skills as credential grants.

## Development

```bash
pnpm install
pnpm check
pnpm test
```

The separate `pnpm test:headless` integration check applies the same refusal,
nonblocking-activity and stop-cancellation assertions to Claude Code, Pi and Codex.
It runs with a disposable allowlisted environment and synthetic protocol peers;
no model/provider calls are made. All three built adapters are required—none is
silently skipped. It supplements, not replaces, `pnpm test` and is not yet in CI.

When Codex is being developed outside this checkout, supply its explicit built
Runtime artifact root (containing `packages/codex/dist`):

```bash
MINU_RUNTIME_CODEX_TEST_ROOT=/absolute/built-runtime-root pnpm test:headless
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
