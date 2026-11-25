# MinuRuntime

MinuRuntime is a small, harness-neutral execution layer for live agent sessions. It answers: how do I start, communicate with, observe, and stop an agent?

Runtime does not provide shared communication, durable session analytics, remote networking, or workflow orchestration. MinuChannels, MinuSessionStore, MinuLink, and MinuOrchestrator consume Runtime as an independent capability.

## Packages

- `core` — normalized `AgentRuntime`, lifecycle, status, events, messages, and start configuration.
- `pi` — Pi RPC worker, attached-TUI bridge, local registry, client, and legacy Pi CLI module.
- `codex` — native Codex app-server adapter with managed execution, reconnect, and macOS idle suspend/exact-thread resume.
- `claude-code` — native Claude SDK adapter with durable owner-per-call managed sessions, full tools under an explicit policy, model/skill selection, images and steering, and a standalone CLI (live-tested on a subscription login; available through the shared factory/CLI).
- `runtime` — `@minu/runtime` public adapter factory and the `minu-runtime` CLI.

## Shared API and CLI

```ts
import { createRuntime } from "@minu/runtime";
const pi = createRuntime(); // unchanged Pi default; never an error fallback
const codex = createRuntime("codex", { managedRoot: "/absolute/private/managed" });
// Persist the returned session's runtime together with its ID.
// For an existing living worker only (no launch or cold resume):
await codex.connectManaged(sessionId, ownerId);
```

After `pnpm install && pnpm build`, `pnpm runtime` and `minu-runtime` use the shared
entry point. Bare legacy Pi IDs and existing Pi CLI commands retain Pi behavior.
The old `@minu/runtime-pi/cli` module remains available; the shared package now owns
the command binary. Selection is explicit, without global preference changes or
fallback between adapters. Codex CLI IDs are qualified as `codex:<id>` so copying
an ID into a later command preserves its adapter; conflicting `--adapter` rejects.
Unqualified Codex IDs require `--adapter codex`.

```sh
pnpm runtime --adapter codex --owner cli start --cwd "$PWD"
# Copy the returned codex:<id> into later commands:
pnpm runtime --owner cli status codex:<id>
pnpm runtime --owner cli send codex:<id> "Review README.md"
pnpm runtime --owner cli suspend codex:<id>
pnpm runtime --owner cli resume codex:<id>
pnpm runtime --owner cli destroy codex:<id>
```

Every Codex session operation requires the exact explicit `--owner`. Optional
`--managed-root` selects its private metadata root. Creation is managed/lazy;
ordinary status/control/history commands only connect to living workers and never
implicitly cold-resume. `resume` is explicit. Existing macOS/v5 suspend/destroy
eligibility limits still apply; `stop` is not verified suspension or force recovery
(use `forceStopManaged`, below). `--managed-root` and workspaces are canonicalized
(symlinks such as macOS `/tmp` are resolved) before anything is persisted.

The CLI also exposes `capabilities`, model/provider/reasoning/skill launch choices,
`start-turn`/`turn`, repeated `--image <file>` inputs (including image-only turns),
`steer`, `interrupt`, `watch`, `messages`, `profile`, `observations`, and explicit
`diagnostic`. Images use Core bounds and regular local PNG/JPEG/GIF/WebP files.
Caller turn IDs retain the worker-lifetime boundary; an absent turn is not permission
to replay. Conversations loading/packaging and selection policy remain separate,
uncompleted integration work.

## Native Codex adapter

`@minu/runtime-codex` implements the existing Runtime interface using one dedicated
`codex app-server --listen stdio://` process per owned session. The Codex executable
must be installed and authenticated separately. Protocol/resume checks used Codex
CLI `0.160.0`; `0.167.0` also passed the managed suspend/resume/history loop against a controlled loopback provider. Full native model/tool
acceptance and compatibility across versions remain open; see the implementation plan.

```ts
import { CodexAgentRuntime } from "@minu/runtime-codex";

const runtime = new CodexAgentRuntime(); // read-only sandbox
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

This adapter supports text and bounded ordered image turns, caller-stable turn IDs,
normalized messages/events, sanitized activity, steering and interruption. Exact
model/reasoning selections are checked against the launch response and known native
model metadata; unsupported or mismatched selections fail rather than silently
falling back. Native `none` reasoning maps to Runtime `off`; `max` is accepted only
for native models that advertise it. Full prompt replacement maps
to Codex base instructions, and appended personas map to developer instructions.

Execution defaults to a read-only native sandbox. To allow native workspace writes,
construct with `{ sandbox: "workspace-write" }`. Approval policy is `never`: the
adapter does not grant escalation or bypass the sandbox. Unexpected server requests
for approvals, user answers or other interactive operations fail the turn and stop
that session instead of hanging or inventing approval. A request deadline likewise
takes the session offline because dispatch outcome may be uncertain; do not blindly
retry in a new session. Interruption acknowledgment alone is not turn completion,
and interruption/stop do not roll back tool side effects.

Codex inherits the host environment and its own native configuration, authentication,
hooks, skills and MCP servers—not Pi's extensions/settings. Configured native
integrations may execute code or contact external services; a shell sandbox is not
a blanket authorization policy for external tools. Codex may persist prompts and
responses in its own history. Stopping Runtime does not delete that history.
Raw messages/events contain agent/tool content and are not presentation-safe;
only `activityEvents` exposes the fixed sanitized activity vocabulary.

### Native launch and input capabilities

`capabilities({ cwd })` explicitly discovers native models/reasoning and opaque skill
IDs. One temporary app-server and one ephemeral read-only/approval-never thread
resolve effective defaults; results return only after confirmed shutdown. Discovery
dispatches no user input/model/tool call, registers no managed session, mutates no
shared settings and creates no persisted conversation. Failures stay unavailable;
there is no guessed provider, retry or replacement settings resolver. A configured
custom model need not appear in the native catalog; its verified effective model is
still returned, with unknown reasoning defaults omitted.

Select skills using discovered `skillIds`; `[]` disables all discovered skills,
including builtins, through per-thread native config. Omission preserves harness
defaults. IDs are hashes, not paths: of the plugin ID and skill name for plugin skills,
so they survive plugin updates, and of the path otherwise (also for an engine that
reports no plugin ID). Versions of a plugin skill listed together share one ID. Earlier path
IDs still resolve at launch but are not listed; unknown IDs fail. Codex gives no signal that
plugin skills have finished loading, so a missing ID cannot be told apart from a late one,
and only listed skills can be turned off. The selection is resolved again on native
allocation/resume without changing shared native configuration.

`send`/`startTurn` accept Core image objects: PNG/JPEG/GIF/WebP with canonical base64,
at most four images, 10 MiB each and 20 MiB combined. Ordered MIME/pixels participate
in turn identity; polling/history/events never copy image parts. Native failure
diagnostics are generic, including text-only failures after earlier image turns. Native transport/history remain bounded at 34 MiB; larger saved
histories reject rather than silently truncate. Image-only input is allowed.

`inputCapabilities` reads native metadata verified for the actual opened model;
every turn pins that model, and rerouting seals the session. It sends no catalog RPC
that could time out and stop existing work. Known text-only models
report false; missing metadata and unallocated/offline native sessions report
unavailability without allocation. Images require verified vision metadata. Custom
provider text and exact native-acknowledged reasoning remain usable without catalog
metadata; known unsupported reasoning is rejected rather than silently falling back. `sessionCapabilities` uses the authenticated worker; it does
not mistake global skill discovery for live per-thread skill verification, which
remains false. Neither live query uses the ephemeral discovery thread.

### Existing-worker observations and diagnostics

`inspectSessionProfile(id, ownerId, { signal })` and `inspectSessionEvents` read the
exact owner's current ready worker without launching/resuming Native work or binding
control routing in a fresh adapter. Reads are bounded to two seconds and fixed Core
byte limits. Unknown, older, fenced, corrupt or unreachable workers return `undefined`;
caller cancellation throws `AbortError`. One physical read per owner/session and 16
per adapter are retained until their work settles, including canceled filesystem reads.

Profiles use the actual native thread's acknowledged model/provider/reasoning, never
saved launch settings or discovery defaults. Pending native allocation has unverified
fields; identifiers that cannot be safely represented are `not_verified`. Skills stay
`not_verified`: global discovery is not live proof of commands/instructions loaded
in a thread. Profile observation sends no native model/read/turn requests.

Structured observations contain only Core bridge codes, sequence/timestamps and
truthful eviction data: the current worker's last 200 records, with no continuity
across restarts. Dispatch codes describe Runtime admission/dispatch calls—not native
logs, model/tool payloads or proof that a downstream consumer received anything.

`openDiagnostic(id)` is an explicit action for an owner-authorized living managed
worker. It writes only projected profile/event snapshots into a bounded 0600 file in
an owner-private `.diagnostics` directory, separate from resume metadata/native
history. It refuses unsafe files/links/permissions and rechecks authority before
launching. macOS currently uses only verified root-owned canonical system `open` and
TextEdit, with fixed arguments/no shell. Unsupported/headless hosts reject honestly.
Success acknowledges the viewer launcher's zero exit—not that a person read a window.
Observation never opens a viewer; tests stub that boundary and do not launch apps.

### Owner-scoped managed sessions

```ts
const ownerId = "my-runtime-installation";
const managed = await runtime.startManaged({ cwd: process.cwd() }, ownerId);
await runtime.send(managed.id, "Review README.md without changing files.");

// macOS: idle-only, verified history-preserving suspension.
await runtime.suspend(managed.id, ownerId);
// A new consumer explicitly authorizes the same owner and exact native thread.
const nextConsumer = new CodexAgentRuntime();
const same = await nextConsumer.resume(managed.id, ownerId);
console.log(await nextConsumer.messages(same.id));
```

`startManaged` persists a stable owner-scoped ID/configuration and opens a reachable
pending worker. It does **not** launch Codex or validate native model/authentication
until valid first input. `managedRoot` optionally selects an absolute, canonical,
owner-private storage root; the default is `~/.minu/runtime-codex/managed`. Consumers
using a custom root must use the same root to reconnect.

New macOS managed sessions use v5 records. `suspend` seals idle admission, records
owned native shutdown, checks the original worker's absence using fresh matching
Darwin host/boot observations, and verifies persisted native history against a sealed
checkpoint. Inspection uses a temporary owned app-server with no thread creation or
input dispatch. Only a complete verified receipt grants clean cold-resume eligibility.
Busy, missing-history, permission, provenance and uncertain outcomes fail closed.
Matching OS observations use Runtime's local-host assumption, not namespace attestation.
Post-shutdown readback verifies recoverable history at that boundary; power-loss
durability and tool-descendant/group shutdown are not inferred.

`resume` authenticates a living worker, launches a never-attempted pending identity,
or reopens a cleanly suspended session through one fenced resume epoch. The epoch
retains its immediate predecessor's retirement/history evidence and preserves the
exact native thread, workspace and saved execution policy. Bound resume never starts
a replacement thread, replays prior input or clears a recovery fence—even with
`allowStopped: true`. Missing/corrupt history or interrupted resume stays unavailable;
there is no automatic retry. A retained failed turn remains readable from its living
worker without authorizing new work.

Existing v4 sessions are not migrated or enrolled. Other platforms retain v4
create/turn/reconnect and explicitly reject suspend/cold resume for now. macOS
provenance failures do not silently downgrade or authorize teardown of adopted work. Unknown IDs do not trigger owner discovery:
call `startManaged` or exact-owner `resume` before ID-only controls in each adapter
instance. Different owners or in-process sessions cannot overwrite a local binding
with the same ID.

`listManagedSessions` does not start native processes or bind control routing.
`active` means authenticated worker status is idle/working, not verified model
readiness; `suspended` denotes verified clean suspension or never-attempted saved
pending configuration without a worker. Inventory is read-only; cold resume rechecks
native history before readiness. Fenced, uncertain, offline and unreachable registrations are
`unavailable`. Corrupt/unsafe/incomplete records cause an explicit sanitized failure,
not silent omission or repair. Summaries exclude private connection/native metadata.

Managed text/turn/status/history/steer/interrupt/normal-stop calls route to that
worker. Missing retained turns return `undefined`; unreachable observations fail
rather than fabricate history/results. A known unreachable managed session reports
`offline`; an unknown/unbound ID rejects. `send` waits for settlement and never
replays on lost acknowledgments or observation failure. Prefer caller-stable
`startTurn` IDs within that living worker's retention window. After cold resume,
a missing old caller-turn ID is not permission to replay uncertain input.

Normal managed `stop` confirms the worker's native-stop response and preserves
metadata, but does not create a clean-suspension receipt: use `suspend` for later
cold resume. Neither operation proves tool-descendant/group exit or establishes a
recovery fence. Messages are hydrated from native history after clean resume.
Caller-turn lookup/idempotency remains bounded to the original worker's retention
window; native history is not a durable caller-turn or exactly-once tool ledger.
`forceStopManaged(id, ownerId)` is explicit recovery for a busy, interrupted,
unreachable, `reserved`, `aborted` or `ready` worker. It persists a fence first,
sends one best-effort authenticated stop that bypasses admission, then needs
**absence proof**: a changed boot identity, or `ESRCH` on the worker's own process
group (new workers are forked detached with exact `--minu-runtime-*` argv markers and a
`ps`-verified group). Otherwise it verifies the group leader's command line and sends
TERM then KILL to that group only. It never signals a bare PID or a legacy worker
recorded without a group; those stay fenced unless a reboot proves absence. Success
leaves the worker `none`, the session `suspended` and the native binding untouched;
it does not validate history. `resume(id, owner, { allowStopped: true })` relaunches
such a slot only where a fresh launch is already permitted (native never started, or
a verified resume epoch); otherwise it stays fenced and suspended.
`destroy(id, ownerId)` first tries verified idle suspension for a ready worker, then
proves absence (or force-stops, on every platform including Linux) and removes only
Runtime resume metadata under the same revision-checked lifecycle lock. Codex history is
never deleted. An unfenced slot with a bound thread and no registered worker, or any
slot whose absence cannot be proven, rejects. Concurrent cold resume
and destruction cannot both mutate the same generation. Publication/lock-return
failure remains uncertain, even when canonical metadata is already gone. Lifecycle
lock files are retained; unexpected files in the resume directory prevent deletion.

Managed `events` observes that authenticated living worker over bounded HTTP
streaming. Its first event is a current status snapshot; await that snapshot before
relying on observation of subsequent input. Opening/cancelling/losing a stream
never allocates Codex, replays input or stops the worker. Streams are live-only:
reconnect does not replay missed events or establish durable history continuity.
`activityEvents` reuses the phase/timestamp-only projection and is caller-abortable.
Observation failures reject with a fixed generic error and no raw cause; cancellation
still completes cleanly. Raw events/errors remain diagnostic, not presentation-safe.
Safe activity is advertised only after a live stream handshake; older reachable
workers lacking the endpoint remain unverified. Images remain unavailable; no
saved config is presented as a live profile or native capability proof.

There are at most 16 subscriptions per worker, with 256 queued frames / 2 MiB of
wire-equivalent data per subscriber and 256 KiB per frame. Network drain waits are
bounded to two seconds; overflow, malformed/wrong-session frames, lost authority
or an unclean disconnect fail explicitly, never silently drop and continue. An
idle subscription rechecks authority every 250 ms, and every delivered event is
re-authorized. Cancellation releases blocked reads/handshakes without waiting for
an event. The ten-second handshake deadline does not limit an established stream.
Use one outstanding `next()` per iterator. Normal stop closes streams, which may
report a gap; use retained turn lookup—not stream closure, interrupt acknowledgment
or `offline` status—as evidence of actual turn settlement. Worker loss still ends
the retention window; there is no durable stream/caller-turn ledger.

**Still required and not yet implemented:** cross-platform suspend/cold resume and legacy migration policy, native TUI
attachment and Conversations/CLI selection. Native launch/input capabilities are
independently approved; profile/structured observations and managed local diagnostics
await behavior-level independent review. Non-macOS viewers and direct/unmanaged
diagnostic opening are not implemented. The existing `minu-runtime` CLI and
Conversations loader still use Pi.

In-process session state/history remain in their adapter instance. Managed retained
turns survive consumer restart only while the same worker lives. Both modes retain
the most recent 1,000 turns by default (`turnRetentionLimit`), not a durable
caller-turn ledger or exactly-once tool guarantee. In-process event subscribers
have bounded queues; slow readers are disconnected without stopping native work.

See the [required functionality checklist](docs/runtime-functionality-matrix.md)
for Runtime requirements, acceptance criteria and remaining work, and the
[phased implementation plan](docs/codex-adapter-plan.md) for sequencing.
All listed functionality is required; deferred delivery and optional API methods
do not make product functionality optional.

## Claude Code adapter

`@minu/runtime-claude-code` implements Runtime on the Claude Agent SDK: one long-lived
query and native `claude` process per session. Claude Code keeps its own model/tool
loop; Runtime adds ownership, input, streaming, reconnect, interruption, stop and resume.

**Executable.** Like Pi's `pi`, the installed `claude` found on `PATH` is the default
(first executable regular file; nothing is pinned or recorded). `executable: "bundled"`
selects the SDK's pinned engine (SDK `0.3.321`) and any other value is an explicit path.
A missing install is an error, never a silent fallback.

**Authentication and configuration are native.** The adapter uses whatever login `claude`
already has (a subscription in `~/.claude`/keychain, or `ANTHROPIC_API_KEY` in the
environment). It never reads, copies, stores or prompts for credentials, and never
creates or writes the config root (`nativeConfigRoot`, else `$CLAUDE_CONFIG_DIR`, else
`~/.claude`; must be an owned directory, not necessarily private). Workers inherit the
process environment overlaid by the `env` option (for managed sessions `env` only overlays; an in-process `start()` session still gets `env` as its full environment); `NODE_OPTIONS`,
`NODE_PATH`, `CLAUDE_CODE_PROJECT_DIR_NAME` and `CLAUDE_CODE_RESUME_INTERRUPTED_TURN`
are always removed. User/project/local settings, hooks, MCP servers, plugins and skills
load exactly as running `claude` in that `cwd` would (no new trust is granted);
`isolateConfiguration: true` restores the isolated behavior (no settings, hooks, MCP or
plugins). If there is no login, `capabilities()` and `startManaged()` throw
`ClaudeCodeAuthRequiredError` ("Claude Code is not logged in; run `claude` to sign in")
before any session exists.

**Permissions.** `permissions`: `"full"` (bypassPermissions, every native tool; what
Channels should opt into), `"edits"` (acceptEdits; Bash etc. only via `canUseTool`),
`"readOnly"` (Read/Grep/Glob; the library default) or `{ mode, allowedTools?, disallowedTools? }`.
Interactive tools (`AskUserQuestion`, `ExitPlanMode`, `EnterPlanMode`) are always
disallowed; if a dialog still arrives the owned session goes offline, like Pi and Codex.
The policy is stored per managed session and resume uses the stored one. This is not an
OS sandbox or a filesystem boundary, and stop does not undo tool side effects.

**Launch options and input.** `capabilities({ cwd })` runs a short-lived prompt-less
query (confirmed exit) and returns models, reasoning levels (`off` plus the engine's
effort levels) and skills. `model` (`{ provider: "anthropic", id }`), `reasoningLevel`
and `skillIds` are validated against it; unsupported choices are rejected, never
downgraded, and a session whose engine reports a different model than requested fails
closed. Images are sent as SDK image blocks when the model is discovered; `steer`
queues a message into the running turn. History projects images as `[image]`.

**API.** `new ClaudeCodeAgentRuntime({ permissions, managedRoot, nativeConfigRoot, executable })`
takes no owner: `startManaged`, `resume`, `suspend`, `forceStopManaged`, `destroy`,
`getManagedSession`, `listManagedSessions` and the read-only `inspectSessionProfile`,
`inspectSessionEvents`, `inspectSessionIntegrations` take `ownerId` per call
(`managedRoot` defaults to `~/.minu/runtime/claude-code`, mode 0700).
`ClaudeCodeManagedRuntime` is the per-owner controller underneath. `start()` still
makes an in-process, non-durable session.

**Lifecycle.** Stop requires an idle worker, observes the worker group's absence, and
only then reads the native transcript (the real engine finalizes it on exit). Whatever
that check finds, the proven-gone worker is fenced and cleared; an ineligible history
then fails the stop and refuses resume. A completed turn needs an exact tail match; an
interrupted or failed turn only needs a structurally valid (or absent) transcript.
Resume requires `{ allowStopped: true }`. Supported history is the engine's linear
format for versions `>=2.1.300 <3` (tool, image and steering rows included); compaction
and branching fail closed. The engine version is recorded and a changed major is refused.
Recovery is explicit and absence-proven; see the
[process-family contract](docs/claude-code-process-family-contract.md) (v2).

**CLI.** `pnpm runtime:claude` (`minu-claude-runtime`): `create`, `list`, `get`, `status`,
`run`, `turn`, `history`, `interrupt`, `stop`, `resume`, `events`, `activity`; all take
`--owner` and `--state`, optionally `--native-root` and `--executable`; `run` reads a
bounded JSON `{"turnId","input"}` from stdin. Credentials come from the environment, never
arguments.

**Testing and status.** Fixtures speak the SDK protocol; the shared headless conformance
(`pnpm test:headless`) runs Claude Code, Pi and Codex through the public API and also
drives the real bundled engine (Write/Bash turns, stop/resume) against a local synthetic
provider with dummy keys. Credential-free by default. An opt-in smoke test
(`MINU_CLAUDE_REAL_SMOKE=1 node --test packages/claude-code/dist/test/real-smoke.test.js`)
uses the real login and model; it passed on a subscription login during acceptance. The adapter is wired into the shared `createRuntime("claude-code", ...)` factory and the `minu-runtime` CLI
(`--adapter claude-code`, `--permissions`, `--executable`, `claude-code:`-qualified ids), so projects can load Pi, Codex and
Claude Code the same way.


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

Omitting `skillIds` preserves the harness's default skill behavior. Supplying an empty array explicitly disables discovered skills for adapters that support selection. The Pi adapter discovers skills from its available-command RPC response, keeps native paths private, resolves selected ids again before launch and resume, and starts the owned process with only those skills. Skill changes require a new session.

With Pi, a selected skill that has been deleted or renamed is left out instead of stopping the start or resume. Codex and Claude Code still refuse, because a skill that loads late looks the same as a missing one. The remaining selection still applies, an empty remainder means no skills, and the stored selection is not rewritten, so a restored skill returns on the next resume. Compare the selection with `capabilities()` to report what is missing. Malformed ids are still rejected.

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
