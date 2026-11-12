# Native Codex adapter

## Objective and baseline

Add native Codex sessions alongside Pi through the existing `AgentRuntime` contract.
This is not a Pi model-provider change or installation of a Codex plugin.

Use the [Runtime functionality requirements](runtime-functionality-matrix.md) as
the functionality checklist: all listed items are required. Optional TypeScript
methods do not imply optional product requirements. Delivery phase and progress are
tracked separately. R01–R41 cover the current native-adapter work; ACP, native TUI
attachment and interactive approvals/answers (R42–R44) are required later-phase
work. Preserve native-first/ACP-later sequencing and update evidence at each checkpoint.

Baseline: Runtime `86f8110`; local Codex CLI `0.160.0`. Protocol shapes were
inspected using `codex app-server generate-ts`. App-server remains experimental:
support must be verified against a specific CLI version, not assumed for every release.

## Scope and decisions

- Add `@minu/runtime-codex`; preserve existing Pi behavior and core contracts.
- Use a dedicated `codex app-server --listen stdio://` process per owned session.
  Do not attach to or stop the shared Codex daemon.
- First slice is **in-process owned execution**, not managed/reconnectable execution.
- Default to read-only sandboxing; workspace writes require explicit constructor configuration.
  Do not bypass sandboxing, hook trust, or approvals.
- Use Codex's own authentication/configuration. Pi extensions, settings, MCP servers
  and skills are not automatically portable.
- Until an interaction contract is agreed, reject server-initiated interactive
  requests and stop that session. Never synthesize approval or user answers.
- Reject unsupported launch/input options explicitly; do not silently ignore them.
- Current native-adapter slices add no new external dependencies, automatic credential
  provisioning, transcript deletion or generic plugin framework. Required ACP, native
  TUI attachment and interactive approval/answer delivery are sequenced later.

## Phases

### 1. Basic owned adapter — current implementation slice

Files: `packages/codex/src/{rpc,client,messages,index}.ts`, package/build wiring,
focused tests, and README usage.

- [x] Supervised JSONL request/notification transport, initialization, deadlines,
      bounded frames, fail-closed server requests and confirmed process exit.
- [x] `start`, `send`, idempotent `startTurn`/`turn`, `status`, `messages`,
      `events`, sanitized `activityEvents`, `steer`, `interrupt`, `stop`.
- [x] Map personas and exact model/reasoning launch selections; fail mismatches.
- [x] Bound retained turn records and subscriber queues. Correlate native turn IDs
      even when completion notifications precede the start response.
- [x] Explicitly reject images and skill selection in this slice.
- [x] Verify fake-process contract tests and a real no-model-call handshake.

Done means this bounded adapter is usable programmatically and its limitations are
documented. It does **not** mean Conversations integration or production parity.

### 2. Managed workers and recovery

- [x] Internal create-only, owner-private Codex thread manifest storage (slice 2a;
      not yet wired into the adapter's public lifecycle).
- [x] Internal out-of-process owned worker and authenticated loopback RPC (slice
      2b1; not yet durable, registered, or exposed through the adapter).
- [x] Internal cross-process lifecycle lock and revision-checked generation/fence
      metadata updates (slice 2b2; not yet enforced by worker lifecycle).
- [x] Internal native-thread resume and bounded paginated history hydration
      (slice 2b3; protocol-fixture verified, not yet owner-scoped lifecycle wiring).
- [x] Internal pending identities and one-shot native allocation/binding (slice 2b4).
- [x] Internal pending-worker startup, first-input admission/dispatch, living-worker
      idempotency and creation/dispatch fencing (slice 2b5; independently approved
      after retained-result recovery rework).
- [x] Internal durable worker registration, authenticated living-worker rediscovery
      and mutually exclusive readiness/pre-ready cleanup (slice 2b6; independently
      approved after adoption/cleanup and fresh-abort fence corrections).
- [x] Bounded public managed creation/inventory, pending/living-worker resume and
      control routing (slice 2b7; independently approved after stop-confirmation
      interleaving correction).
- Finish remaining production lifecycle/recovery and cross-platform resume support.
  Cross-worker uncertain input must remain unavailable without replay; native
  history is not a durable caller-turn ledger.
- [x] Bounded managed worker events/safe activity and live capability verification
      (2b8a–2b8d independently approved after scoped corrections).
- [x] Worker-local idle-only native quiesce with atomic admission and fresh authority
      (2b9a.1; internal only, not public suspension/worker retirement).
- [x] Unwired Darwin host/boot observations with bounded trusted-source queries
      (2b9a.2a; not deployment/namespace provenance or worker-exit proof).
- [x] Private Darwin PID-slot observations gated by fresh matching host/boot data
      (2b9a.2b; not authenticated worker-exit or lifecycle proof).
- [x] Strict v5 private process-domain correlation and lease/CAS storage
      (2b9a.2c1; production creation remains v4, no retirement/producers).
- [x] V5 correlated retirement-intent storage with fresh CAS and fail-closed guards
      (2b9a.2c2; not actual admission sealing or shutdown/exit proof).
- [x] V5 native-quiesce assertion storage and retirement finalization CAS
      (2b9a.2c3; stored assertions only, no verified shutdown/public suspension).
- [x] Internal intent-publication seam between idle/admission seal and native
      shutdown (2b9a.2d; no authenticated producer/public lifecycle integration).
- [x] Independent launcher/worker domain correlation for new explicit-v5 launches
      (2b9a.2e; no production-v5 switch, attestation or exit/public lifecycle proof).
- [x] Worker-local owned-native quiesce fact producer and fresh publication CAS
      (2b9a.2f; not worker-exit/public wiring, history or full lifecycle acceptance).
- [x] Private authenticated retirement route and publication-gated bridge closure
      (2b9a.2g; not production absence/finalization, public suspend or history acceptance).
- [x] Private controller same-domain absence observation and finalization CAS
      (2b9a.2h; independently approved, not production/public lifecycle acceptance).
- [x] Integrated Darwin create/turn/idle suspend/inventory/controller restart/
      exact-thread resume with history preservation, including startup cleanup fix.
- [x] Non-destructive destroy MVP for verified suspension/never-launched metadata.
- [ ] Remaining explicit recovery/fences and platform/legacy lifecycle eligibility.
- Complete the remaining durable lifecycle wiring; keep changes bounded and avoid
  redesigning Pi.
- Persist owner-private Runtime-ID → Codex-thread-ID manifests and launch policy.
  Codex retains its own history; do not reuse Pi transcript validation.
- Implement exact-owner start/list/suspend/resume/destroy with crash-safe locking,
  stable IDs, worker-replacement fencing, and resume validation.
- Implement explicit recovery with confirmed shutdown and stopped-session fences.
  Verify process ownership/group isolation before any descendant escalation.
- Preserve turn recovery across consumer restarts while a worker stays alive.

Done requires lifecycle failure/race tests, cross-owner negative tests, restart
integration tests and confirmation that destruction never deletes Codex history.

### 3. Required discovery, inputs, observation and diagnostics

These are required deliverables, not optional because their core API methods use
`?` or their implementation is incomplete.

- Model/reasoning discovery, effective defaults, skill discovery and enforceable
  per-session selection (including explicit empty selection).
- Image modality verification and safe native image transport with validation,
  retry identity and cancellation; reject genuinely incompatible models.
- Live profile, bounded structured bridge events and local diagnostic actions.
- Honest live capability reporting. Unverified capabilities must remain unavailable
  while building, but blanket refusal does not complete a required feature.

### 4. Conversations integration

- Generalize the Pi-specific loader and release packaging.
- Agree whether selection is installation-wide or per agent. Side-by-side Pi/Codex
  requires persisted adapter identity, routing and adapter-scoped skill/model choices.
- Preserve existing Pi bindings; never reinterpret a saved Pi ID as a Codex ID.
- Run focused Channels loader/routing/lifecycle tests and a human-approved live
  Conversation smoke test. UI interaction/approval support is a required later phase.

### 5. Required later-phase integrations

- Generic ACP adapter/interoperability (R42), after native Codex/Pi integration as
  directed by the owner; do not replace the current native Codex protocol work.
- Native interactive TUI attachment and externally started-session registration
  (R43), preserving ownership and existing attached-session safeguards.
- Explicit human approval/user-answer interaction contract and UI (R44), with
  session/turn binding, cancellation and safe waiting behavior. Interim headless
  refusal is not final delivery of that interaction functionality.

These require separately scoped implementation phases. They remain requirements,
not optional features or a claim that the current native-adapter phase includes them.

## Verification

During phase 1: focused compiled Node tests for framing, initialization, request
correlation, deadlines, process failure/shutdown, interaction refusal, exact launch
selection, idempotency/conflicts, busy admission, event races and interruption.

At the phase-1 integration point: `pnpm install --frozen-lockfile`, `pnpm check`,
`pnpm test`, and `git diff --check`. A real installed-CLI handshake verifies the
transport boundary but is not proof of model execution or tool safety. No billed
model calls or user-configuration changes are part of that smoke.

Managed lifecycle, cross-repository, UI and release validation remain gated by
their phases. Local checks are author verification, not independent review.
The owner's latest sequencing is to build out Codex first, then the generic black-box
conformance suite. Focused feature/boundary tests remain mandatory while building;
the generic suite stays required under R38 and is not silently skipped or declared
implemented.

The functionality requirements checklist tracks required delivery and remaining
shared-conformance/end-to-end acceptance work. Adapter-specific test passes alone
do not establish completion; missing required functionality cannot be reclassified
as optional without an explicit owner decision.

## Current implementation handoff

Target: uncommitted phase-1 changes on `feat/codex-adapter`, based on `86f8110`.
Pi source and core contracts are unchanged; the new package is included in the root
TypeScript project and existing test glob. README includes programmatic usage and
explicit safety/feature limitations.

Observed author checks:

- `pnpm install --offline --frozen-lockfile` — passed; no external dependencies added.
- `pnpm check` — passed.
- `node --test packages/codex/dist/test/*.test.js` — 33/33 passed.
- `pnpm test` — 101/101 passed, including existing Pi regressions.
- `git diff --check` and whitespace checks for the new files — passed.
- Installed Codex `0.160.0`: initialized, started a read-only thread, observed idle
  and queried safe capabilities, then stopped and confirmed spawned-process exit.
  Used temporary `CODEX_HOME`/workspace directories; no `turn/start`, model call,
  user-config edit or real tool execution.

Limits: native model execution, real streaming/tool behavior, managed recovery,
Conversations integration and independent review are not verified by this slice.

## Phase 2a implementation handoff — owner-private storage

Added `packages/codex/src/managed-store.ts` and
`packages/codex/test/managed-store.test.ts`. The internal store records stable
Runtime IDs, exact owner IDs, native thread IDs, launch configuration and sandbox
policy. It uses a separate Codex storage root (not Pi's registry), hashed owner
directories, bounded private-file reads, create-only atomic publication and fsync.
It refuses invalid policies, redirected/non-private storage, identity mismatches,
symlinks and hardlinked manifests; duplicate creation cannot overwrite a mapping.
Corrupt material is preserved and reported, not deleted or silently repaired.

Observed author checks on the uncommitted working tree:

- `pnpm check` — passed.
- `node --test packages/codex/dist/test/managed-store.test.js` — 9/9 passed.
- `git diff --check` — passed (tracked files only).

This is storage groundwork only: no public managed methods are enabled, no native
Codex history is read or deleted, and no worker/authentication/locking/recovery
claims are made. Storage currently targets POSIX private-file semantics; other
platform support is unverified. The earlier 101-test result describes phase 1,
not this delta.

### Independent review and finding-driven rework

The verifier reported 110/110 full regression tests passing on the original phase
1 + 2a tree, but reproduced two defects: hardlink publication could leave a
manifest unreadable after a writer crash, and history omitted steering messages.
That reviewed tree was not accepted.

Rework replaces hardlink publication with atomic directory publication:
`<id>.session/manifest.json` is staged privately, file/directory-synced, then
renamed into place. A valid existing session is nonempty and cannot be replaced
by POSIX directory rename. The manifest file retains a single link throughout;
pre-publication crashes leave only ignored staging directories, and published
sessions need no cleanup before readers can use them. This unshipped internal
format has no legacy flat-file migration. Unexpected hardlinked manifest files
remain rejected.

History now skips only the original prompt's first native echo, retaining later
user items including repeated-text steering. Native item IDs still deduplicate
duplicate notifications.

Observed rework author checks:

- `pnpm check` — passed.
- `node --test packages/codex/dist/test/managed-store.test.js packages/codex/dist/test/runtime.test.js`
  — 39/39 passed (12 storage, 27 runtime).
- Storage regressions kill a real writer with SIGKILL immediately before/after
  the publication rename, exercise readers while paused and after restart, and
  exercise concurrent publication/list/read. The hardlink-refusal test remains.
- Protocol regression completes a turn with original-prompt echo, same-text and
  distinct-text steering, plus duplicate native item notifications.

The verifier's second assessment closed the storage finding with 46/46 Codex
tests passing, but reproduced a remaining history case: the original prompt was
present only in the nonterminal `turn/start` response, whose items were ignored.
Same-text steering was then incorrectly treated as the original echo.

Follow-up rework retains response items before replaying buffered notifications,
so the original item precedes subsequent steering even when it has no separate
item notification. The protocol regression now runs both notification-only and
response-only original-item variants, preserving same-text and distinct steering.

Follow-up author checks:

- `pnpm check` — passed.
- `node --test packages/codex/dist/test/runtime.test.js` — 28/28 passed.
- Tracked and untracked whitespace checks — no whitespace errors.

Storage and Pi code are unchanged by this follow-up; their prior verifier evidence
is reused. These checks do not prove power-loss durability, native model/tool
execution or managed lifecycle correctness. The verifier's final finding-driven
assessment approved the phase 1 + 2a checkpoint: typecheck, 28 runtime tests and
the previously failing independent protocol probe passed; unchanged storage/RPC/Pi
evidence was reused. Both findings are closed.

## Phase 2b1 implementation handoff — internal worker and RPC boundary

Added `packages/codex/src/{owned-worker,worker-bridge,worker-client}.ts`,
`packages/codex/test/worker-bridge.test.ts`, and a separate consumer-process fixture.
No Pi/core/storage changes and no new dependencies or public adapter methods.

- Worker launches one dedicated app-server through the existing Codex adapter.
  Launch options travel through private Node IPC, not argv or persisted files.
- A random bearer token authenticates loopback HTTP requests. Exact owner,
  Runtime session and launch-generation headers are mandatory on every method;
  browser Origin requests are rejected. Native thread IDs remain internal.
- RPC allowlist: status, messages, startTurn/turn, steer, interrupt, stop.
  Bodies, headers, connections and response sizes are bounded; invalid/unsupported
  requests are refused. Native exception details are not returned as RPC errors.
- Turn state stays in the worker. Controller IPC disconnect and fresh consumer
  processes can recover/replay the same turn without redispatch, within the
  adapter's existing bounded retention policy. Timeouts never auto-retry.
- Graceful stop/SIGTERM waits for direct app-server exit, including its existing
  SIGTERM-to-SIGKILL escalation, before closing the bridge and allowing worker exit.
  No descendant/group escalation or shared-daemon termination is introduced.

Observed author checks on this uncommitted working tree:

- `pnpm check` — passed.
- Initial focused worker-boundary tests — 8/8 passed; then added an independent
  consumer-process restart regression, covered by the full run below.
- `pnpm test` — 124/124 passed, including 9 worker-boundary tests and existing Pi,
  storage, RPC and Codex runtime regressions. Output: `/tmp/minu-codex-phase2b-tests.log`.

This is an internal RPC checkpoint, not completed phase 2 or managed-session
support. Connections are ephemeral and are not saved/discovered. There is no
native thread resume, event streaming over the bridge, durable lifecycle lock,
worker-replacement fencing, stopped-session fence or process-group recovery yet.
The generation check rejects a stale connection against one worker; it is **not**
a durable replacement fence. Public managed APIs remain unavailable. SIGKILL of
the worker itself, power loss, real model/tools and managed lifecycle remain
unverified. No billed calls or native history deletion occurred.

### Slice 2b1 shutdown review and rework

The verifier reproduced two blockers despite 9/9 worker tests passing: a second
SIGTERM bypassed one-shot handlers and orphaned a TERM-ignoring app-server, and a
stop caller disconnecting during native shutdown prevented the response `finish`
event that was responsible for closing the bridge.

Rework keeps SIGTERM/SIGINT handlers installed and routes repeated signals through
the same idempotent shutdown promise. After confirmed native exit, RPC stop now
schedules bridge closure independently of response delivery, before attempting a
best-effort response to a still-connected caller. It does not depend on `finish`
or `close` events, and does not retry native shutdown.

New real-process/network regressions synchronize on the fake app-server's TERM
handler, then send repeated SIGTERM/SIGINT or disconnect the HTTP stop caller
while escalation is pending. They assert native termination and normal worker
exit; the disconnected-stop test also confirms the listener is gone without a
second stop request or recovery signal.

Observed author checks on the reworked tree:

- `pnpm check` — passed.
- `node --test packages/codex/dist/test/worker-bridge.test.js` — 12/12 passed.
- `node --test packages/codex/dist/test/*.test.js` — 59/59 passed; includes RPC and
  runtime consumers of the shared process fixture. Output:
  `/tmp/minu-codex-shutdown-rework-tests.log`.
- The 124/124 full-suite result above predates this rework; unchanged Pi evidence
  is reused, not claimed as a new full-suite pass.

The verifier approved the 2b1 checkpoint after both independent shutdown probes,
59/59 Codex tests, typecheck and whitespace checks passed. Both shutdown findings
are closed; the other slice limitations above are unchanged.

## Phase 2b2 implementation handoff — lifecycle lock and manifest CAS

Added `packages/codex/src/lifecycle-lock.ts`; extended the internal managed store
and storage tests, with child-process lock/read/crash fixtures. Worker, RPC,
in-process adapter, public exports, Pi and core source are unchanged.

- Exact owner/session operations serialize using permanent, private SQLite lock
  files and `BEGIN IMMEDIATE`, following the existing Pi pattern without importing
  Pi transcript/storage logic. Locks use Node's built-in `node:sqlite` (Node 22.5+),
  memory-only journals, async contention waits and a bounded acquisition deadline.
  OS locks release on process death: no PID stale-lock deletion or auto-recovery.
- The lock callback receives an expiring mutation lease; concurrent mutation on
  one lease and use after release are refused. Any already-started mutation settles
  before releasing the lock. Callers must not recursively lock the same session.
- Internal manifest format is now version 2, with monotonic safe-integer revision,
  generation and `requiresExplicitResume`. This unshipped format has no v1 migration;
  old/invalid versions fail closed rather than being silently upgraded.
- CAS mutation can change only generation and explicit-resume metadata. Identity,
  native thread ID, launch policy, sandbox and creation timestamp remain immutable.
  Missing/foreign/stale manifests conflict. Replacement is bounded, private,
  file-synced and atomically renamed; the containing directory is then synced.
- Readers may finish a validated descriptor pinned to an old, now-unlinked inode
  (link count zero) after atomic replacement. Multiple hardlinks still fail closed;
  static symlink/public/corrupt storage and lock files are not repaired or deleted.

Observed author checks on this uncommitted working tree:

- `pnpm check` — passed.
- `node --test packages/codex/dist/test/managed-store.test.js` — 23/23 passed,
  including cross-process contention/CAS, lock-holder SIGKILL, before/after-rename
  update SIGKILL, stale writes, owner isolation, expired/concurrent leases,
  unawaited-mutation lock lifetime, pinned readers, file safety and size/revision
  bounds. Output: `/tmp/minu-codex-phase2b2-tests.log`.
- Earlier verified worker/RPC/Pi evidence is reused for unchanged code. No new
  full-workspace or live-model run is claimed for this isolated storage slice.

These are internal storage primitives, not an operational worker fence. Generation
and explicit-resume fields are not yet consumed by worker startup/admission or
resume policy. There is no durable worker registration, native resume, managed
start/list/suspend/resume/destroy, event streaming or process-group recovery yet.
Power-loss durability, real model/tools and worker replacement remain unverified.
No native history is changed or deleted, and no public managed API is enabled.

### Slice 2b2 lock-lifetime review and rework

The verifier reproduced a POSIX lock-lifetime defect: a same-process contender
opened/closed the lock-file inode while another callback still held its SQLite
transaction. Closing that raw descriptor released the process's record locks,
allowing an external CAS writer to enter and acknowledge revision 1 before the
original revision-0 writer overwrote it. The original 23 passing storage tests
did not cover this mixed-process interaction.

Rework adds a per-path local queue before any lock-file descriptor access. It
covers descriptor creation, validation, SQLite acquisition, callback execution,
rollback and descriptor closure. Timed-out waiters release only their queue gate;
their queue entry remains chained behind the active holder until it settles, so
later local callers cannot bypass the holder. One acquisition deadline is carried
through both the local queue and SQLite contention waits.

The new mixed-process regression pauses writer A immediately before manifest
publication, times out three contenders in A's process, verifies those contenders
opened zero lock-file descriptors, and confirms external writer B cannot enter.
After A is released, B's stale revision-0 CAS must conflict rather than also
acknowledge revision 1; A's acknowledged value remains persisted.

Observed rework author checks:

- `pnpm check` — passed.
- `node --test packages/codex/dist/test/managed-store.test.js` — 24/24 passed.
  Output: `/tmp/minu-codex-lock-rework-tests.log`.
- Unchanged worker/RPC/Pi evidence is reused; no new full-suite or native-model
  run is claimed.

The verifier confirmed that the same-path probe passed but reproduced a case-alias
variant on this case-insensitive macOS filesystem: ASCII IDs with different case
reached the same lock inode through different local queue keys.

Follow-up folds the local queue key to lowercase, without changing the actual
filesystem path, owner/session IDs, hashed owner namespace or persisted identity.
Canonical root/owner directories are verified before lock acquisition; folding
covers supported ASCII session-ID case aliases. On case-sensitive filesystems this
conservatively serializes otherwise independent case-variant sessions.

The mixed-process regression now includes repeated uppercase-ID contenders and
confirms zero lock-file opens. On this host it explicitly observed matching inode
and device IDs for the canonical and uppercase lock paths, so the real
case-insensitive alias path was exercised. It also checks that differently cased
owner IDs retain separate hashed namespaces and can acquire independently.

Observed follow-up author checks:

- `pnpm check` — passed.
- `node --test packages/codex/dist/test/managed-store.test.js` — 24/24 passed,
  including the updated real-filesystem case-alias regression. Output:
  `/tmp/minu-codex-case-alias-tests.log`.

The verifier approved the 2b2 checkpoint: typecheck, 24 storage tests, independent
same-path/case-alias CAS probes (matching inodes confirmed), and whitespace checks
passed. The lock-lifetime finding and alias variant are closed. Worker-fencing
enforcement and power-loss durability remain unverified.

## Phase 2b3 implementation handoff — native-thread resume boundary

Added `packages/codex/src/native-resume.ts`; factored common launch logic in the
Codex client; added an internal `resumeNativeThread` primitive and optional native
thread ID in the private worker IPC launch. Extended runtime/worker protocol tests
and the fake app-server. Store/lock, bridge/authentication, core and Pi source are
unchanged. No new dependencies or optional managed AgentRuntime methods.

- Validate native thread ID and canonical workspace before process launch.
- Read native metadata by exact thread ID before resume applies overrides; require
  matching persisted ID/cwd and idle/not-loaded metadata. No path/history fallback
  or replacement `thread/start` occurs when resume fails.
- Resume explicitly with the requested sandbox, never-approve policy and launch
  model/reasoning/persona selections. Verify returned ID/cwd/persistence/idle state
  and existing exact policy/model/reasoning checks before local admission.
- Request metadata-only resume, then hydrate `thread/turns/list` ascending with
  `itemsView: full`. Reject incomplete/running turns, invalid/duplicate IDs and
  invalid/repeated cursors. Bounds: 20 pages, 100 turns/page, 10,000 items and
  8 MiB aggregate raw page data. Unknown native items are omitted by the existing
  message normalizer; reasoning/image metadata is not projected.
- Only after validation/hydration does the adapter register an idle Runtime
  session. Historical native turn IDs do not become caller-stable Runtime turn
  records. Alive-worker turn recovery is unchanged; cross-worker turn idempotency
  is not inferred from native history.

Observed author checks:

- Codex `0.160.0` generated TypeScript inspected for read/resume, turn pagination,
  item views and native thread status/history contracts.
- `pnpm check` — passed.
- Focused runtime/worker tests — 62/62 passed, including successful protocol resume,
  history restoration/new input and fail-closed identity/workspace/persistence,
  active-state, policy/model/reasoning, malformed/partial/oversized history and
  cursor/page-limit cases. Every refusal verifies spawned-process exit.
- `pnpm test` — 161/161 passed. Output:
  `/tmp/minu-codex-native-resume-full-tests.log`.

Real no-model-call protocol spike: a temporary-home/workspace `thread/start`
returned an idle non-ephemeral **paginated** thread. After stopping/restarting the
app-server, `thread/read` failed with `thread not loaded`. Temporary data was
removed and processes stopped. Thus a never-used thread is not yet demonstrated
to provide durable resume material; this author spike did not establish successful
real-history resume.
This is a concrete lifecycle integration gap: do not promise durable managed start
for an empty thread or silently replace its native ID. Positive resume and history
hydration author evidence here uses protocol fixtures, not real model/tool execution.

This internal native primitive is not owner authorization or operational fencing.
Its caller must validate the owner-private mapping and coordinate worker lifetime
under the approved locks/CAS. Public managed start/resume/suspend/destroy remain
unavailable; durable registrations, generation/stopped-session enforcement,
process-group recovery and bridge event streaming are still pending.

### Slice 2b3 payload-validation review and rework

The verifier reproduced malformed supported messages being silently projected as
partial history: numeric assistant text was dropped, and non-array user content
became an empty user message. Both incorrectly admitted idle sessions.

Rework validates supported payloads before permissive normalization: assistant
text must be a string; user content must be an array of typed parts; text parts
must contain string text. Tool output/result/content containers and recognized
text fields are checked when present. Unsupported item kinds and non-text parts
remain intentionally unprojected rather than being interpreted as supported text.
This is projection validation, not a replacement for the complete Codex schema.

New protocol regressions inject malformed supported items on a later history page,
after earlier valid history has loaded, and verify refusal plus spawned-process
exit. Positive coverage retains valid image/non-text omission, unknown private
items, null command output and textual MCP output.

Observed rework author checks:

- `pnpm check` — passed.
- `node --test packages/codex/dist/test/runtime.test.js packages/codex/dist/test/worker-bridge.test.js`
  — 73/73 passed. Output: `/tmp/minu-codex-history-payload-tests.log`.
- The 161/161 full-workspace result predates this rework; unchanged storage/RPC/Pi
  evidence is reused, not claimed as a new full-suite run.

Independent positive integration evidence reported by the verifier before rework:
Codex `0.160.0` completed a synthetic turn using a localhost fake provider, then
restarted, resumed through the adapter, restored history and accepted another send.
The verifier reported no billed calls or user-config changes. This supplies a real
Codex persistence/resume boundary check for a materialized thread, not real model
or tool behavior, and does not resolve never-used thread persistence.

The verifier approved the 2b3 checkpoint: typecheck, 73 focused tests, independent
payload/refusal/cleanup probes and whitespace checks passed. Earlier real-Codex
synthetic-provider integration evidence was reused. Empty-thread persistence
remains an explicit gate before durable managed-session claims.

## Empty-thread persistence investigation and lazy-creation decision

Further installed Codex `0.160.0` probes used dedicated temporary CODEX_HOME and
workspace directories, explicit `ephemeral: false`, read-only sandbox and
`approvalPolicy: never`. No turns, model requests, user-config changes or native
history fabrication were performed. Spawned processes were stopped and temporary
directories removed after each probe.

Observed results:

- After a 500 ms wait, the same process could read the exact idle thread with zero
  turns. After restart, `thread/read` returned `thread not loaded`; direct
  `thread/resume` also failed with `no rollout found for thread id`.
- Successful `thread/unsubscribe` before shutdown did not change the outcome.
- Empty `thread/metadata/update` Git patch was refused because it must contain a
  field. No metadata patch was applied; resume still had no rollout.
- `thread/name/set` succeeded on a temporary probe thread but did not make that
  empty thread resumable after restart. No naming workaround is proposed.

The inspected stable request schema has no explicit flush/materialize operation.
These probes do not prove that every possible Codex configuration lacks a
solution; they establish that explicit persistence intent, waiting, clean
unsubscribe and naming did not satisfy the required same-ID restart contract.
Do not silently recreate native threads, inject synthetic messages, write Codex
rollout files, or bootstrap a hidden model turn to mask this gap.

The proposed adjustment was to persist a stable Runtime identity plus launch
configuration while empty, deferring native thread creation until first actual
input. Existing in-process `start` would remain unchanged. Native launch/model/
policy validation would occur at first use rather than at managed-session creation.
After discussion of native integration versus ACP, the owner directed continuing
with the native approach and then explicitly asked the implementer to continue.
Implementation is proceeding with this lazy-creation design; generic ACP remains
future scope. The lifecycle implementation must distinguish pending launch from
accepted-turn uncertainty and must never auto-replay an uncertain first turn.

## Phase 2b4 implementation handoff — pending identity and one-shot allocation

Target: uncommitted working tree on `feat/codex-adapter`, based on `86f8110`,
following the verifier-approved 2b3 checkpoint. This delta changes
`packages/codex/src/{managed-store,client}.ts`, adds internal
`packages/codex/src/managed-native.ts`, extends storage tests and adds
`managed-native.test.ts` plus its separate-process fault fixture. Worker/bridge,
RPC transport, native resume/history validator, public exports, Pi and core source
are unchanged.

The internal pending-session helper saves stable Runtime identity, exact owner,
generation, workspace, persona/model/reasoning selection and sandbox without
launching any native process. This confirms saved configuration, not a verified
Codex launch. It does not enable public `startManaged` or change in-process `start`.

Unshipped manifest format is now version 3 with an explicit native binding union:

- `pending`: no thread has been attempted; the stable identity survives an empty
  session restart without relying on Codex empty-thread persistence.
- `creating`: persisted creation intent, committed under the exact-owner lifecycle
  lock **before** invoking native launch. Any subsequent failure/crash is uncertain;
  there is no reset-to-pending transition or automatic replacement.
- `bound`: one exact native thread ID is saved, under the same lock, before any
  user input may be submitted. Binding is immutable; allocation refuses both bound
  and creating records, stale generations and explicit-resume fences.

These transitions use expiring mutation leases and revision checks, preserve the
existing locking/publication protections, and cannot be written through the
ordinary metadata patch API. Unknown/contradictory native states and old v1/v2
manifests are refused, not silently migrated or deleted. Tests were updated to the
new internal format; previously recorded version-2 handoffs remain historical.

The one-shot allocation helper validates the saved workspace and native response:
canonical cwd, native identity, idle state, non-ephemeral intent, sandbox/approval
policy and explicit model/reasoning selection. It never calls `turn/start`.
Launch failures preserve creating intent; binding/publication failures stop the
spawned process before releasing the lifecycle lock. A post-publication or
lock-release failure also cleans up instead of returning an unconfirmed allocation.

Observed author checks on this tree:

- `pnpm check` — passed.
- Focused storage tests — 26/26 passed, including both new native-state tests and
  existing lock-lifetime/case-alias/CAS/publication regressions.
- Focused pending-allocation + runtime tests — 81/81 passed (21 allocation tests,
  60 runtime tests). Includes cross-process contention, stale/foreign/stopped
  identities, deferred native-policy failures, symlinked workspaces, SIGKILL after
  intent/before binding/after binding, and before/after-publication binding failures.
- `pnpm test` — 195/195 passed, including unchanged worker/RPC/Pi regressions.
  Output: `/tmp/minu-codex-lazy-native-full-tests.log`.
- Tracked and untracked whitespace checks — passed.
- Installed Codex is now `0.167.0` (earlier protocol evidence used `0.160.0`). A
  temporary-home/workspace smoke persisted pending state, allocated/validated an
  idle native thread, confirmed bound state and empty messages, stopped the spawned
  process, then refused repeat allocation. No turn/model request or user-config
  edit was made. This checks startup/binding, not native history durability.
- Smoke cleanup was partial: native startup created a temporary plugin clone and
  `rm` reported permission denial under
  `/tmp/minu-codex-lazy-smoke.rvbGiF/home/.tmp/plugins-clone-egQisE/.git`.
  No retry or permission bypass was attempted. A process listing showed no remaining
  matching app-server/temporary-path command. This is a cleanup limitation, not a
  successful all-artifacts-removed claim; native startup may run integrations.

Limits: this is a preparation/allocation checkpoint, not managed lifecycle or
first-turn delivery. First-input worker triggering, durable worker registration,
operational replacement fencing and cross-worker accepted-turn uncertainty handling
remain unimplemented. `bound` means an exact native ID was recorded, **not** that
an empty native thread is resumable or that a first turn completed. A crash between
binding and actual input must remain unavailable rather than replace/replay.
Controller-SIGKILL tests explicitly clean up their fixture processes; production
orphan/group recovery and power-loss durability are not claimed. Real model/tools
remain unverified. Public managed APIs stay disabled.

The verifier approved slice 2b4 with no actionable findings: typecheck, 107/107
focused tests, eight additional fault/fencing probes and whitespace checks passed.
The reviewed source hashes were unchanged. This is independent checkpoint approval,
not full-workspace re-verification or acceptance of durable managed sessions.

Next at the 2b4 checkpoint was pending-worker/first-input wiring; its implementation
and current evidence follow. Do not present the adapter as restart-recoverable after
worker loss or ready for Conversations integration.

## Phase 2b5 implementation handoff — internal first-input worker

Target: uncommitted working tree on `feat/codex-adapter`, based on `86f8110`,
following verifier-approved 2b4. Added `packages/codex/src/pending-worker.ts`,
`test/pending-worker.test.ts` and a child-only fault fixture. Updated owned-worker
IPC dispatch, the bridge's narrow runtime port type, allocation cleanup authority,
startup cleanup error propagation, and the deterministic app-server fixture.
Manifest format/storage/lock code, public exports, core and Pi source are unchanged.

Implemented internal behavior:

- A `managedRoot` IPC launch reads the exact owner/session/generation's pending
  manifest and opens the authenticated bridge without constructing Codex.
  Readiness means an available pending worker, not verified native/model health.
  This mode refuses supplied config/native thread/sandbox overrides; saved policy
  remains authoritative. Existing eager start/native-resume worker modes remain.
- Reads and idle stop do not create native state. Text/turn-ID/size validation
  precedes admission and allocation. The first accepted turn returns running while
  preparation proceeds, and matching concurrent/repeated IDs recover that one
  worker-owned record. Conflicting input and other busy turns are refused.
- First use calls the reviewed one-shot pending → creating → bound allocation.
  The worker reacquires the lifecycle lock, revalidates generation/fence/native
  identity and checks cancellation immediately before native dispatch.
  Two pending workers may exist internally without durable registration, but only
  one can allocate/dispatch; this is not a claim of complete worker-lifetime fencing.
- Subsequent turns reuse the same allocation. Local records have the configured
  bounded retention window. Native settlement is observed independently of control
  acknowledgments; a healthy failed turn does not force a new allocation.
- Preparation interruption prevents input dispatch and settles only after native
  preparation/cleanup completes. Once native work is dispatched, native interrupt
  behavior applies. Stopping closes admission before awaiting preparation and
  confirmed direct-child exit; repeated signals and disconnected stop callers do
  not bypass cleanup.
- Allocation/startup errors retain private shutdown authority when native exit is
  unconfirmed, even before a native session was registered. The bridge must not
  report successful stop/close in that case. These error objects/handles are internal;
  raw startup error text/configuration is not returned as the preparation failure.
- An offline native process refuses new turn admission. A read pinned to an older
  creating manifest is not compared with an allocation that completed during that
  read; the regression covers that asynchronous snapshot race.
- A fresh pending worker refuses creating/bound manifests after worker loss. There
  is no cold-worker turn replay, replacement thread, synthetic input, native history
  deletion, or inference of turn idempotency from history.

Observed author verification:

- `pnpm check` — passed.
- `node --test packages/codex/dist/test/pending-worker.test.js` — 24/24 passed.
  Output: `/tmp/minu-codex-pending-worker-focused.log`.
- Tracked/untracked whitespace, local documentation links and all 44 requirement
  IDs checked. Concrete review source hashes: `/tmp/minu-codex-first-input-source.sha256`.
- An earlier focused full-Codex run passed 150/150 before the final snapshot-race
  regression was added. In the final workspace run, all **151 Codex tests passed**.
- `pnpm test` — **218/219 passed, one Pi recovery test failed**.
  Output: `/tmp/minu-codex-first-input-full-tests.log`. This is not a green workspace
  gate and is not superseded by isolated passing results.
- The new tests cover empty-worker restart, malformed/oversized/unauthorized input,
  first-use contention/idempotency, living-worker consumer restart, control races,
  generation/explicit-resume fences before allocation and between binding/dispatch,
  startup/turn deadlines, missing executable, interactive refusal, SIGKILL during
  creation/after dispatch, cleanup uncertainty, retention and the stale-read race.
  Tests that deliberately kill a controller or deny native cleanup perform explicit
  test-only fixture cleanup; production orphan recovery is not demonstrated.

### Workspace failure — pre-existing Pi readiness-file race, still outstanding

The full run failed `an unresponsive bridge is stopped through its isolated verified
process group without affecting other sessions` with `Unexpected end of JSON input`
in `packages/pi/src/client.ts` while starting the resumed worker.

Pi client, owned-worker and recovery-test source hashes match `86f8110` exactly.
The unchanged worker writes its `.launch-*.json` readiness file directly, while the
client parses a visible file immediately and retries only ENOENT; a visible empty/
partial write is therefore a fatal parse error. The new Codex package imports no
Pi code and this slice changes no Pi source.

Proportionate diagnostics, not retries-until-green:

- One isolated unchanged-Pi recovery run — **6/6 passed**.
  Output: `/tmp/minu-pi-recovery-isolated.log`.
- A separate subprocess preload injected one empty readiness read into that same
  unchanged Pi client. The targeted recovery test reproduced the identical parse
  failure, as expected. Probe: `/tmp/minu-pi-ready-race-probe.mjs`;
  output: `/tmp/minu-pi-ready-race-baseline.log`.
- No Pi source fix, broad rerun, test weakening or ignored failure was introduced.
  Track the ready-file publication/read race separately and resolve it before a
  clean integration/merge claim.

Current limits: public managed create/list/suspend/resume/destroy/force-stop,
durable worker registration, full replacement fencing, bound-session cold-worker
resume, worker event streaming and production orphan/group recovery remain open.
Local turn records survive consumer restart only while this worker lives; there
is no durable caller-turn ledger. Startup can remain in progress until its bounded
native deadlines; cancellation does not imply undoing allocation or side effects.
Real model/tool execution and power-loss durability are unverified. Generic
conformance remains required later, per the owner's latest sequencing.

Initial handoff status: internal slice implemented, with independent review and
full-workspace gate outstanding. The review/rework and current approved checkpoint
are recorded below.

### Slice 2b5 review and retained-result rework

The verifier requested changes despite typecheck and 151/151 Codex tests passing.
When binding failed and native cleanup was unconfirmed, the worker stored a
cleanup-only allocation in its successfully bound execution field. Its identity
reader then required a bound manifest even though the manifest correctly remained
creating. Both retained `turn` lookup and matching `startTurn` retry returned 503,
hiding the admitted turn's failed result (R03).

Rework keeps a cleanup-only stop callback separate from execution allocation.
Only successful allocation/binding populates the execution field. Existing owner,
generation, native-binding and explicit-resume checks remain in place; cleanup
handles cannot authorize work. Retained results remain readable in the original
owner/generation until fenced, new work stays refused, and uncertain native exit
still cannot produce a successful stop/bridge close.

Extended both startup- and binding-cleanup failure regressions to assert terminal
lookup, identical matching retries, conflicting input rejection, new-work refusal,
creating-state preservation, owner denial, generation/stopped-session fencing and
continued refusal of false stop confirmation. Before the source fix, the binding
case reproduced the reported 503; after the fix all 24 worker tests passed.

Observed author checks for this rework:

- `pnpm check` — passed.
- `node --test packages/codex/dist/test/pending-worker.test.js` — 24/24 passed.
  Output: `/tmp/minu-codex-2b5-retained-recovery.log`.
- Tracked/changed-file whitespace checks — passed.
- Concrete rework hashes: `/tmp/minu-codex-2b5-retained-recovery.sha256`.
- No fresh full-Codex/workspace/native run. Broader evidence for unchanged areas
  is reused; the earlier workspace result remains 218/219, not a green gate.

The verifier independently supported the pre-existing Pi readiness-race
classification: relevant baseline source hashes matched and widening the actual
publication window reproduced the same failure. It remains separate, unfixed and
outstanding for integration. No Pi source changed during this rework.

The verifier approved slice 2b5 after reassessment: typecheck, 37/37 worker/bridge
tests, the previously failing independent lookup/retry probe and whitespace checks
passed. Retained results remain recoverable without granting new work; identity/
generation/stopped-session fences and unconfirmed-exit safeguards remain enforced.
No actionable findings remain for this internal checkpoint. No fresh full-workspace
or native model/tool run was claimed; the Pi readiness race remains an open gate.

## Phase 2b6 handoff — bounded durable worker registration

Implementation delegated to sol-med after the verifier-approved 2b5 baseline.
Workspace: `feat/codex-adapter`, uncommitted changes based on
`86f81102db9ddacade58009d040a95253188992b`. The approved retained-result source/test
hashes were checked before handoff; a code snapshot is recorded at
`/tmp/minu-codex-approved-2b5.sha256` (check from the Runtime repository root).
This snapshot is a handoff reference, not a commit or a green workspace gate.

Boundary:

- Add owner-private durable reservation/ready records using existing lifecycle
  locks and revision checks; persist launch intent before process creation.
- Validate the exact worker claim at startup, ready publication and dispatch.
  Registration mutations remain generation-fenced. Persisted credentials/PIDs
  alone neither establish liveness nor authorize another worker.
- Rediscover an exact-owner/session/generation authenticated living worker and its
  retained turns without starting another process or redispatching input.
  Liveness/reconnect checks must be bounded and must not resume native work.
- Preserve uncertain reservations, stale/unreachable registrations and publication
  failures as unavailable. No automatic replacement, PID-based cleanup, input
  replay or implicit native-history mutation.
- Keep connection credentials in owner-private storage. Preserve the approved
  cleanup-only authority/retained-result behavior and repeated-signal/disconnected-
  stop safeguards.

Likely files: `managed-store.ts`, new `managed-worker.ts`, `owned-worker.ts`,
`pending-worker.ts`, and focused registration/process fixtures. Preserve the existing
uncommitted work; record any internal-format changes and refuse unsupported old
material rather than silently migrating it.

Acceptance evidence: concurrent controllers, consumer restart/reconnect, wrong
owner/session/generation, unsafe registrations, stale publication, crashes around
spawn/readiness, publication failures and shutdown cleanup. Show that only one
worker becomes authoritative and reconnect does not redispatch retained input.
Use focused checks during implementation; run affected existing worker/storage
regressions at handoff and record limits before independent assessment.

Excluded: public managed lifecycle APIs, bound-session cold resume, production
orphan/process-group recovery, event streaming, generic conformance and Pi fixes.
The Pi readiness race remains a separate integration gate; approval of 2b5 does
not waive it. Hand the bounded implementation/evidence back to the coordinator
before proceeding to another slice or claiming independent approval.

### Implementation receipt and first independent assessment

The author returned the bounded implementation and
[2b6 handoff](codex-registration-2b6-handoff.md). Internal manifests are now version
4, with `none` / `reserved` / `ready` worker registration, a persisted claim before
forking, PID binding, authenticated readiness/reconnect, and request-time claim
checks. Unsupported older material is refused rather than migrated. Public
managed APIs, bound-session cold resume and production orphan recovery are still
excluded; this is not completion of managed lifecycle.

The coordinator made no source changes. Source/test hashes matched
`/tmp/minu-codex-2b6-source.sha256` before and after the integration check, run from
the Runtime root:

- `pnpm check` passed.
- `node --test packages/codex/dist/test/managed-store.test.js packages/codex/dist/test/pending-worker.test.js packages/codex/dist/test/worker-bridge.test.js packages/codex/dist/test/managed-worker.test.js`
  passed **86/86**, with normal file concurrency. Log:
  `/tmp/minu-codex-2b6-coordinator-integration.log`.
- `git diff --check` passed. The author's separate handoff records **23/23** final
  registration tests and an earlier **173/173 serial** Codex run.

An earlier author parallel run had two eager-worker startup failures, recorded in
`/tmp/minu-codex-registration-initial.log`. Their cause remains unclassified: the
passing integration check does not explain or erase them. The separate,
independently confirmed Pi readiness race also remains an open workspace gate;
there is no new full-workspace result.

Independent assessment returned **REQUEST_CHANGES — HIGH** for the concrete 2b6
delta, including untracked files. The earlier adoption/cleanup question is now a
confirmed defect, independently reproduced on both paths:

1. A second consumer authenticates the durably ready worker and dispatches a turn.
2. The original launcher times out before IPC confirmation, or the IPC connection
   disconnects before confirmation.
3. Controller or worker startup cleanup terminates the adopted worker, leaving a
   `ready` registration and `bound` native thread without the living worker or its
   retained results.

Finding anchors: `managed-worker.ts:126–134` and `owned-worker.ts:42,93–108` in the
reviewed snapshot. Independent typecheck, **86/86** affected tests at normal
concurrency, source hashes and whitespace checks passed, but both additional
adoption-race probes failed. Evidence:

- `/tmp/codex-verifier-2b6-adoption-race.mjs`
- `/tmp/codex-verifier-2b6-delayed-ready-worker.mjs`
- `/tmp/codex-verifier-2b6-adoption-race.log`

The coordinator checked that `/tmp/minu-codex-2b6-source.sha256` still matches before
rework and read the independent probe/log; no source edits or additional runtime
tests were made for this receipt. Status is **REWORK**, not approval.

### Finding-driven 2b6 rework handoff

Delegate this correction to sol-med on the reviewed source snapshot. Preserve the
original snapshot/probes and the existing uncommitted work; return a new source
checksum manifest and updated implementation handoff before reassessment.

Required outcome:

- Make durable readiness/adoptability and failed-startup teardown mutually
  exclusive across both controller and worker, using the existing lifecycle-lock/
  revision-check discipline. Missing IPC confirmation is not teardown authority
  once adoption is possible. An unlocked read followed by kill must not introduce
  another publication/cleanup race.
- Cover controller timeout, worker/controller IPC disconnect, and exceptions after
  readiness publication. Publication uncertainty must fail conservatively; do not
  blindly close a potentially adoptable worker or reset its registration.
- Preserve bounded cleanup of a genuinely pre-ready, non-adoptable launch, ordinary
  authenticated stop, explicit signal shutdown, exact claim/generation fences and
  cleanup-only retained-result recovery. Do not infer authority from persisted
  PIDs, add replacement/replay, or suppress all shutdown to hide the race.
- Add deterministic concurrent-adopter regressions for both independently failing
  paths and post-publication errors. Prove the same worker/native binding survives,
  running/retained turn lookup and matching retry remain available, and native
  input dispatch occurs only once. Update earlier fault expectations that require
  teardown after adoptable readiness; retain the pre-ready cleanup assertions.

Verification: use the new regressions while building, then typecheck and affected
registration/storage/pending-worker/bridge tests at normal concurrency before
handoff. Include allocation regressions if store/state changes affect allocation.
Report exact checks and limits; independent reassessment must close both failing
probe paths before 2b6 approval or another implementation slice.

Earlier eager-worker startup failures remain unclassified, and the separate Pi
workspace gate remains open. Public lifecycle, bound-session cold resume,
production orphan/process-group recovery, event streaming, generic conformance
and Pi fixes remain excluded from this rework.

### Adoption-race rework receipt and independent reassessment

The author returned the correction in the
[updated handoff](codex-registration-2b6-handoff.md#finding-driven-adoptioncleanup-correction).
The new snapshot is `/tmp/minu-codex-2b6-adoption-rework-source.sha256`; the original
2b6 snapshot and independent reproducer remain preserved. Against that original
snapshot, exactly six files changed: `managed-store.ts`, `managed-worker.ts`,
`owned-worker.ts`, `managed-worker.test.ts` and the two registration fault fixtures.
No coordinator source changes were made.

The proposed correction adds a shared locked/CAS `reserved -> aborted` transition
before failed-startup teardown. The unshipped version-4 format now includes this
terminal pre-ready state. Both controller and worker use the selector; ready or
uncertain publication cannot grant that cleanup authority. The author reports
preserved normal stop/signals, retained results and single native dispatch.
These are implementation claims pending independent reassessment, not closure of
the prior HIGH finding.

Observed coordinator checks:

- New source/test hashes matched before and after validation.
- `pnpm check` passed.
- The supplied reproducer and harness-only copy were compared: the only change is
  `child?.ref()` in `finally`, keeping the unreferenced child alive for test cleanup.
  Assertions and race triggers are unchanged. The original probe remains intact.
- `node /tmp/codex-verifier-2b6-adoption-race-ref.mjs` passed **both** adoption paths:
  original-launch timeout and IPC disconnect. Each left the adopted worker alive,
  its native thread bound, one native dispatch and its retained running turn
  accessible. Log: `/tmp/minu-codex-2b6-adoption-coordinator-probe.log`.
- `git diff --check` passed. Author logs record **29/29** registration tests and
  **113/113** affected tests at normal concurrency, including native allocation.
  Those results are reused, not claimed as another coordinator suite run.

Reassessment target: these six changed files and their immediate interactions,
including the new abort state's validation/admission, pre-ready cleanup,
post-publication errors, ordinary stop/signals and retained-result behavior.
Independent reassessment **closed the HIGH adoption/cleanup finding**, with
113/113 affected tests, typecheck, both original adoption probes and post-
publication/retained-result/shutdown checks passing. The persisted-fence question
is now a confirmed **MEDIUM** finding; 2b6 remains **REQUEST_CHANGES**.

Fresh `reserved -> aborted` authority ignores the current manifest generation and
`requiresExplicitResume` flag. Independent probes changed those persisted fields
while retaining the original claim, then observed cleanup granted and revision
incremented. Both the selector and lease mutator need current-manifest guards.
Evidence: `/tmp/codex-verifier-2b6-abort-fences.mjs` and its `.log`. Coordinator
confirmed the reviewed rework snapshot still matches and read that evidence;
no source changes or additional runtime tests were made for this receipt.

### Fresh-abort fence correction — bounded rework handoff

Delegate only this remaining correction to sol-med on
`/tmp/minu-codex-2b6-adoption-rework-source.sha256`. Expected source/test scope:
`managed-store.ts` and `managed-worker.test.ts`, plus the implementation handoff.

- Reject fresh cleanup authorization when the current manifest generation no
  longer matches the launch/registration generation or explicit resume is required.
  Enforce the persisted fences in both `claimPreReadyCleanup` and the lease's
  `abortWorkerStartup` mutator; neither entry point may bypass them.
- Add regressions that mutate the persisted generation and explicit-resume flag.
  Assert no cleanup grant, no transition and no revision increment. Exercise the
  direct lease mutator with the latest revision so stale-CAS rejection cannot
  disguise a missing fence check.
- Preserve the distinction between a fresh abort and idempotent cleanup of an
  already committed abort. Keep ordinary eligible abort, adopted-worker protection,
  retained results, normal stop/signals and all existing exclusions unchanged.
- Return typecheck, focused registration/storage tests and both supplied persisted-
  fence probes, a new source snapshot and updated handoff for reassessment. Reuse
  relevant unchanged evidence; do not rerun broad suites merely for test counts.

The HIGH finding is closed; approval awaits correction and independent closure of
the MEDIUM finding. Earlier startup failures remain unclassified, the Pi workspace
gate remains open, and there is no new full-workspace/native acceptance claim.

### Fresh-abort correction receipt and approval

The author returned selector and lease current-manifest guards plus four persisted-
fence/idempotency regressions. Only `managed-store.ts` and `managed-worker.test.ts`
changed against the prior reviewed snapshot. New snapshot:
`/tmp/minu-codex-2b6-abort-fences-rework-source.sha256`; all source/test hashes
matched before and after coordinator checks. No coordinator source changes.

- Author registration checks: **33/33 passed**; reuse that evidence.
- Coordinator `pnpm check`: passed.
- Coordinator storage tests: **26/26 passed**; log:
  `/tmp/minu-codex-2b6-fence-coordinator-storage.log`.
- Coordinator execution of the unchanged independent persisted-fence probe:
  **both cases passed**, refusing fresh abort with the reserved record/revision
  unchanged; log: `/tmp/minu-codex-2b6-fence-coordinator-probe.log`.
- `git diff --check`: passed. No new combined/full-workspace result is claimed.

Independent reassessment **approved slice 2b6**, closing the MEDIUM fresh-abort
finding. The HIGH adoption/cleanup finding remains closed; no actionable findings
remain for this internal checkpoint. Independent evidence: typecheck, **59/59**
storage/registration tests at normal concurrency, both unchanged persisted-fence
probes, source hashes and whitespace checks passed. No fresh full-workspace or
public managed-lifecycle acceptance is claimed.

The coordinator verified the approved source hashes and preserved an identical
Runtime-relative manifest at `/tmp/minu-codex-approved-2b6.sha256`, copied from
`/tmp/minu-codex-2b6-abort-fences-rework-source.sha256`. Check from the Runtime root.
This records the reviewed source, not a commit or a green workspace gate.

## Phase 2b7 handoff — public managed entry and living-worker routing

Delegate this bounded implementation to sol-med on the approved 2b6 snapshot.
Workspace remains `feat/codex-adapter`, uncommitted over `86f8110`; preserve the
existing tree and check `/tmp/minu-codex-approved-2b6.sha256` before editing.

Objective: expose the approved pending-worker path through `CodexAgentRuntime`,
without yet implementing bound-session cold resume or the remaining lifecycle.
This advances R03/R11–R13/R17/R18; it does not complete all managed requirements.

Scope / file-test map:

- Wire `startManaged`, `listManagedSessions` and the bounded `resume` path into the
  existing adapter. Add an optional managed storage-root constructor setting for
  isolation/tests, defaulting to the existing Codex store location. Preserve core
  contracts, package identity and in-process `start` behavior.
- `startManaged` saves a new exact-owner Runtime identity/configuration and opens
  its pending worker through the approved helpers. Do not start Codex or allocate
  its native thread until valid first input. Preserve published material on launch
  failure; saved configuration is not proof of native/model readiness.
- `resume` may authenticate an existing exact-owner/generation living worker, or
  launch a never-attempted `native: pending` / `worker: none` record through the
  approved reservation path. Reserved, aborted, fenced, ambiguous or unreachable
  registrations remain unavailable. No bound-session cold resume, replacement,
  generation reset or explicit-resume fence clearing (even with `allowStopped`).
- Bind control routing only after exact-owner authorization. Route managed
  `send`, `startTurn`, `turn`, `status`, `messages`, `steer`, `interrupt` and normal
  `stop` through that worker, retaining stable Runtime IDs. Never infer an owner
  from an ID, scan other owners to attach, overwrite a different-owner local
  binding, or fall back to a new native/in-process session.
- Preserve input validation before allocation, retained running/terminal lookup,
  matching retries and conflicts. `send` dispatches once and waits for that turn;
  observation failures/unknown outcomes never trigger input replay. Missing turns
  follow the core `undefined` contract, not fabricated results.
- Inventory is read-only with respect to lifecycle: use conservative sanitized
  summaries, authenticate live status before claiming `active`, and report uncertain/
  fenced/unreachable sessions as unavailable. Corrupt/unsafe records must surface
  an explicit sanitized failure, not be silently omitted or repaired. Never expose
  native IDs, credentials, connection material or raw manifests in summaries.
- Unsupported managed event/activity streaming and unimplemented capability/profile
  surfaces must be explicit and honestly reported, not synthetic or advertised as
  complete. Worker streaming remains required subsequent work. Do not regress the
  existing in-process observation/control paths.
- Expected files: `client.ts`, narrowly necessary managed-client/worker-client
  integration, new public managed-runtime tests and a consumer-process fixture if
  needed. Prefer direct established patterns; no new framework/dependency. Update
  README/handoff with the exact supported session modes and remaining limitations.

Verification: focused public-API tests for create-without-native-launch, invalid
first input, one-shot native binding, repeated/retained turns, `send` settlement,
control/stop, exact-owner inventory, wrong-owner/colliding bindings, persisted
fences, unsafe/unreachable registrations, and mixed in-process/managed use. Exercise
consumer exit and fresh-process `resume` while the same worker lives, including
retained running/terminal lookup with one native dispatch. At handoff run typecheck
and the affected public/worker/storage boundary tests at normal concurrency;
reuse unchanged evidence and record any missing checks before independent review.

Excluded: bound-session cold resume, `suspend`/`destroy`/`forceStopManaged`, production
orphan/process-group recovery, worker event streaming, discovery/images/skills,
CLI/Conversations wiring, generic conformance and Pi fixes. These stay required
unfinished work, not optional or silently implemented through aliases.

Carry-forward gates: two earlier eager-worker startup failures remain unclassified;
if they recur, preserve and investigate the evidence rather than serializing tests
or raising deadlines to erase them. The independently confirmed Pi readiness race
still blocks clean workspace integration; no Pi fix or fresh green full-workspace
result exists. Native model/tool acceptance remains unverified. Return this bounded
implementation, source snapshot, focused checks and limitations to the coordinator
before another slice or independent approval is claimed.

### 2b7 implementation receipt and first independent review

The author returned [2b7's implementation handoff](codex-managed-entry-2b7-handoff.md)
and `/tmp/minu-codex-2b7-source.sha256`. Against the approved 2b6 source manifest,
existing `client.ts` and `managed-store.ts` changed; `managed-client.ts`, public
managed-runtime tests and a fresh-consumer fixture were added. README documents
supported modes, conservative inventory states and remaining required work.
The store delta shares its default-root function and refuses recognized session
directories with missing manifests; it does not change format/fencing mutators.

Coordinator checks: source/test hashes matched before/after, `pnpm check` and
**30/30** public managed tests passed, and `git diff --check` passed. Public-test
log: `/tmp/minu-codex-2b7-coordinator-public.log`. No coordinator source changes.
The author's **207/207** normal-concurrency affected result is recorded in
`/tmp/minu-codex-2b7-affected-final.log`; it is reused, not another coordinator run.
No new full-workspace/native acceptance result is claimed.

Request independent review of the concrete 2b7 delta and immediate interactions,
including untracked files, relative to `/tmp/minu-codex-approved-2b6.sha256`.
Priorities: exact-owner local binding/intents and ID collisions; generation/resume
fences; inventory liveness/corruption/privacy; deferred allocation and retained
turn recovery across consumer exit; `send` settlement/uncertainty without replay;
stop acknowledgment semantics; conservative capabilities/unsupported managed
streaming; and preservation of in-process execution. Do not proceed to another
slice or treat public lifecycle/parity as complete before this assessment.

Approval still extends through internal 2b6 only. Earlier unclassified eager-worker
startup failures and the separate Pi readiness race remain open integration gates;
all 2b7 exclusions and required unfinished work remain unchanged.

### 2b7 stop-confirmation correction — bounded rework handoff

Independent review returned **REQUEST_CHANGES — MEDIUM**. The 207/207 affected
suite, typecheck, snapshot and whitespace checks passed, but two additional stop
interleavings failed in `managed-client.ts`:

- A concurrent repeat while native stop is pending receives bridge 409 rather
  than sharing the first call's pending confirmation.
- A resume already in progress finishes after confirmed stop, replaces the same
  worker binding with `stopped: false`, and loses that confirmed result; subsequent
  stop fails against the closed bridge.

Evidence: `/tmp/codex-verifier-2b7-stop-interleavings.mjs` and its `.log`.
Coordinator verified `/tmp/minu-codex-2b7-source.sha256` still matches and read the
independent reproducer/log. No source changes or additional runtime checks were
made for this receipt. Approval still extends through 2b6 only.

Delegate this correction to sol-med on that reviewed 2b7 snapshot. Keep changes to
`managed-client.ts`, focused public managed-runtime regressions and the handoff
(unless a concrete dependency requires a narrowly explained adjustment):

- Preserve pending and confirmed shutdown state across rebinds of the same exact
  authorized worker/connection. Do not transfer confirmation merely because the
  Runtime ID/owner is the same when the worker/generation/connection differs.
- Concurrent local stop callers must share the in-flight result; cache success
  only after the actual confirmed native-stop response. A failed/unconfirmed stop
  must reject and must not poison later explicit attempts as cached success.
  Do not introduce automatic retries, new shutdown authority or wire changes.
- Add deterministic public regressions for both supplied interleavings, including
  native shutdown genuinely pending, and failure/unconfirmed-stop cache behavior.
  Retain exact-owner/fence checks, adopted-worker safety, no replay, ordinary
  control and documented shutdown confirmation limits.
- Return typecheck, focused public managed tests, both unchanged stop-interleaving
  probes, a new source snapshot and updated handoff for independent reassessment.
  Reuse relevant unchanged evidence; do not claim a new 207-test/workspace pass.

The separate Pi gate and earlier unclassified startup failures remain open. Cold
resume, remaining lifecycle/recovery, managed streaming, generic conformance and
all other 2b7 exclusions remain outside this correction. No next slice before
independent closure of this finding.

### 2b7 stop-correction receipt and approval

The author returned a two-file correction in `managed-client.ts` and
`managed-runtime.test.ts`, preserving the original snapshot. New source manifest:
`/tmp/minu-codex-2b7-stop-rework-source.sha256`. The coordinator confirmed its hashes
before/after checks and the two-file boundary; no coordinator source edits.

Same-worker reauthentication now retains the binding object and its pending/
confirmed stop state, comparing the full authenticated connection descriptor.
Concurrent callers share one stop attempt. Only the expected null acknowledgment
marks success; rejected, malformed or lost confirmations do not. Seven added
regressions cover both reported interleavings, pending rebind, failure/lost/malformed
confirmation and a distinct worker descriptor under the same Runtime ID.

Author public tests: **37/37 passed**. Coordinator `pnpm check`, both unchanged
independent stop-interleaving probe paths and `git diff --check` passed; probe log:
`/tmp/minu-codex-2b7-stop-coordinator-probe.log`. The earlier 207-test result is reused
for unchanged areas, not claimed as a new broad run.

Independent reassessment **approved bounded slice 2b7**, closing the MEDIUM stop-
confirmation finding with no actionable findings remaining. Independent typecheck,
**37/37** public managed tests, both unchanged stop-interleaving probes, source
hashes and whitespace checks passed. This is not complete managed lifecycle or
Conversations/parity acceptance; there is no new broad/full-workspace result.

The coordinator checked the approved source and preserved the identical manifest
at `/tmp/minu-codex-approved-2b7.sha256`, copied from
`/tmp/minu-codex-2b7-stop-rework-source.sha256`. Paths are Runtime-relative; check
from the Runtime root. It records reviewed source, not a commit or a green global
gate. The Pi workspace gate and earlier unclassified startup failures remain open.

## Phase 2b8 handoff — managed event and safe-activity streaming

The original whole-2b8 coding assignment is superseded by the four checkpoints
below, following the owner's request for smaller chunks. Workspace remains
`feat/codex-adapter`, uncommitted over `86f8110`; the last approved baseline is
`/tmp/minu-codex-approved-2b7.sha256` (Runtime-relative paths).

The failed agent turn left an unreviewed implementation, tests and
[2b8 handoff](codex-managed-streams-2b8-handoff.md) on disk. The coordinator verified
that current source matches `/tmp/minu-codex-2b8-source.sha256` and preserved the
same manifest at `/tmp/minu-codex-2b8-pre-split-source.sha256`. Do not reset, discard
or blindly rerun the original implementation. Review/repair the existing draft in
small scopes. Its saved author log reports 248/248; no new coordinator runtime
checks or independent 2b8 approval accompany this replanning.

Objective: implement the managed `events` and sanitized `activityEvents` path across
the existing worker/consumer boundary (R06/R07), with honest live stream capability
reporting (partial R28). Choose a simple authenticated HTTP stream on the existing
bridge; no external dependency, polling-generated fake stream or generic framework.
Cold resume/recovery is not a prerequisite and must not be silently added.

### Execution checkpoints — one active scope at a time

1. **2b8a — Worker event source and shared primitives (scoped approval recorded).**
   Review `event-stream.ts` (bounded queues/hub, schema and pure activity helper),
   `pending-worker.ts` (preparation/native event production and stable IDs), and
   only the internal native-queue adaptation in `client.ts`. Include the relevant
   helper/pending-worker/native-queue tests and new native fixture scenarios.
   Completion: bounded, non-blocking source with honest preparation/terminal
   ordering, no native allocation on subscribe and no private native-ID exposure.
   Do not include HTTP transport, public routing or live capability approval.
2. **2b8b — Server streaming boundary (scoped approval recorded).**
   Review `worker-events.ts` and the `worker-bridge.ts` stream route with focused
   server-boundary tests: authentication/current authority, subscriber limits,
   backpressure, cancellation and shutdown. Completion: a disconnected or slow
   subscriber cannot stop work, hold lifecycle locks indefinitely or leak resources.
3. **2b8c — Client stream reader (scoped approval recorded).**
   Review `worker-client.ts` streaming/handshake/decoder and focused reader tests.
   Completion: strict identity/session/schema checking, bounded fragmented UTF-8/
   JSON decoding, honest EOF/overflow errors, and cancellation of blocked reads.
   Established streams must outlive the handshake deadline; redirects/old peers
   cannot acquire false support. No public activity-capability approval yet.
4. **2b8d — Public wiring and integrated acceptance (approved after privacy correction).**
   Review `managed-client.ts`, the public event/activity/capability changes in
   `client.ts`, managed-runtime/consumer-process tests and README. Completion:
   presentation-safe activity, honest live capability verification, consumer
   reconnect without replay and preserved control/stop/in-process behavior across
   the reviewed layers. Run the affected integrated checks here, not after every
   earlier checkpoint.

Each checkpoint returns a scoped result before the next begins. Any correction
should stay within its active scope; flag cross-component dependencies before
broadening edits. Existing later-layer drafts stay intact and unapproved. A scoped
pass is not approval of the whole source snapshot or all of 2b8; final integrated
assessment remains required. No new feature implementation is requested before
the first scoped review. The unchanged full requirements below apply across all
four checkpoints; splitting work does not defer their safeguards.

Scope / file-test map:

- Extend `pending-worker.ts` to expose normalized Runtime events across preparation
  and native execution. Preserve the managed Runtime ID and caller turn IDs; do not
  expose private native session IDs, raw Codex notifications or synthetic messages.
  Subscribe/forward native events before dispatch can emit them. Avoid duplicate
  lifecycle events; reflect preparation failure/cancellation and actual settlement
  honestly, never treating an interrupt acknowledgment as completed work.
- Opening a stream is observation only: no native allocation, turn replay, owner
  discovery, resume or worker launch. Existing authenticated pending workers can
  be observed without starting Codex; fresh consumers must first authorize routing
  through the existing explicit owner-scoped resume path.
- Add streaming to `worker-bridge.ts` / `worker-client.ts` with the current bearer,
  exact owner/session/generation and registration checks. Do not put credentials in
  URLs or accept redirects/origin requests. Recheck persisted authority before
  event delivery and close stale/fenced streams; an initial authentication must
  not become indefinite authority. Never hold the lifecycle lock while awaiting
  the next event, network backpressure or consumer input.
- Bound subscribers, per-subscriber queues, frames, byte buffers and server/client
  backpressure. Fragmented UTF-8/JSON must decode correctly. Malformed, oversized
  or wrong-session frames and slow-reader overflow must fail explicitly rather
  than silently drop events, grow memory without limit or stall native execution.
  A connection/handshake deadline must not terminate a legitimate long-lived stream.
- `AsyncIterator.return()` must cancel blocked connection/read/next operations and
  release sockets/listeners, including when no event arrives. Activity abort must
  promptly do the same. Consumer disconnect/cancel/stream failure must not stop or
  interrupt the native turn/worker. Normal stop/bridge close must clean up streams
  without preventing confirmed shutdown or regressing stop-result sharing.
- Wire public managed `events` through `managed-client.ts` / `client.ts`. Reuse the
  existing phase/timestamp-only activity projection; no raw error/tool/prompt fields
  may enter safe activity. Keep already-aborted signals and repeated cancellation
  safe. Stream reconnect is live observation, not replay of missed events or proof
  of durable event/turn history.
- Advertise safe managed activity only when the currently authenticated reachable
  worker demonstrably supports the stream. Use minimal backward-compatible private
  negotiation/verification; an older reachable peer without streaming must remain
  unsupported/unverified rather than falsely advertised. Do not expand unrelated
  model/profile/discovery capabilities. Preserve in-process event behavior.
- A small shared bounded event-stream helper is acceptable if genuinely reused;
  do not introduce a new event framework or unrelated Pi refactor. Update README
  and a 2b8 handoff with exact stream lifetime, buffering/cancellation and gap rules.

Verification: focused tests for subscribe-before-first-input (no native launch),
real normalized status/text/tool/lifecycle events with stable IDs, safe activity
allowlist/coalescing, preparation failures/cancellation and terminal correlation.
Exercise fragmented/malformed/oversized frames, wrong-owner/generation and changed
persisted fences, slow readers, cancellation while idle/blocked/already aborted,
multiple subscribers, long-lived streams and older-peer capability refusal. Prove
consumer stream loss/exit leaves a held turn running, a fresh consumer can resume
and observe subsequent events without redispatch, and normal stop closes streams
without losing its confirmed result. At the final 2b8d handoff run typecheck and
affected event/public-runtime/pending-worker/bridge/control regressions at normal
concurrency. Earlier checkpoints use their focused checks and reuse relevant
unchanged evidence; report gaps before independent assessment.

Excluded: bound-session cold resume, suspend/destroy/force-stop lifecycle,
production orphan/process-group recovery, discovery/skills/images/profiles/local
diagnostics, CLI/Conversations wiring, generic conformance and Pi fixes. These
remain required unfinished work, not optional. No real model/tool call or user-
configuration change is needed for deterministic boundary verification.

Carry forward the separate Pi readiness-file integration gate and earlier
unclassified eager-worker startup failures. No full-workspace/native acceptance
claim follows from this checkpoint; do not serialize tests or raise existing
deadlines to erase failures. Return the bounded implementation, new source
snapshot, focused results and limitations to the coordinator before another slice
or independent approval is claimed.

### 2b8a strict-status correction and scoped approval

Independent source-only review returned **REQUEST_CHANGES — MEDIUM**:
`checkedEvent` accepted array-valued statuses through `String(e.status)`, returning
an array as an `AgentStatus`. The three malformed-status probes failed. Typecheck,
61 native-runtime tests, the bounded-queue test and ten other source-only checks
passed. Transport and public wiring were not reviewed or approved.

The coordinator made a minimal local correction in `event-stream.ts`: require a
string before allowed-value membership. `event-stream.test.ts` adds three direct
validator regressions, each retaining the valid string case and rejecting its
array-valued equivalent. All three failed before the fix (missing expected throw)
and passed afterward. No later-layer source changes were made.

Observed post-fix checks: `pnpm check`, **4/4** focused repository validator/queue
tests, **13/13** unchanged independent source-only probes (coordinator execution),
and `git diff --check` passed. Logs:
`/tmp/minu-codex-2b8a-status-{red,focused,source-probes}.log`.

New source manifest: `/tmp/minu-codex-2b8a-status-rework-source.sha256`. Only
`event-stream.ts` and `event-stream.test.ts` differ from the preserved draft.
The original draft/snapshots remain intact. Independent reassessment **approved
2b8a only**, closing the status-validator finding with no actionable findings in
that scope. Typecheck, 4 focused tests, 13 unchanged source-only probes, snapshot
and scoped whitespace checks passed; no new broad run is claimed.

The coordinator verified the reviewed tree and preserved its identical hash
manifest at `/tmp/minu-codex-2b8a-reviewed-tree.sha256`. This is a full-tree locator,
**not full-tree approval**: approval covers shared/source primitives,
`pending-worker.ts` and the internal native-queue adaptation in `client.ts` only.
Server transport, client reader and public wiring remain unreviewed.

### 2b8b server-boundary review handoff

Review only the existing `worker-events.ts` implementation and streaming-related
`worker-bridge.ts` changes plus their immediate authorization/stop interactions.
Tree locator: `/tmp/minu-codex-2b8a-reviewed-tree.sha256`; compare the server delta
to the last fully approved `/tmp/minu-codex-approved-2b7.sha256` baseline.
No source changes or additional runtime checks accompany this handoff.

Acceptance: authenticate exact owner/session/generation and bearer without URL
credentials; revalidate current authority before delivery and during idle waits;
bound subscribers, queue/write pressure and pending work; release observation
resources on disconnect/cancel/stop without stopping native work or blocking
confirmed shutdown. Include initial/in-flight authorization, blocked reads/drain,
source errors/close and concurrent control interleavings. No lifecycle lock may
be held while awaiting events, drain or consumer activity.

Use focused server-boundary and bridge/control checks; prefer direct HTTP probes
for server assertions rather than treating the unreviewed client reader as proof
of correctness. Existing relevant tests include route access refusal, idle/event
reauthorization, subscriber-slot reuse and a paused reader alongside a healthy
subscriber. Return a **2b8b-only** verdict; do not advance to client/public review
or rerun the whole 2b8 suite as a substitute for this scoped assessment.

2b8c/2b8d and final integrated acceptance remain pending. The Pi workspace gate,
earlier unclassified startup failures and all existing exclusions remain open.

### 2b8b server-cleanup correction — bounded rework handoff

Independent review returned **REQUEST_CHANGES — two MEDIUM findings**:

- `worker-events.ts`: after the two-second backpressure timeout the source iterator
  returned, but `response.end()` left a stalled socket alive with 100,219 queued
  bytes. A reader that never resumes prevents flushing indefinitely.
- `worker-bridge.ts`: cancellation is installed after initial authorization. A
  disconnect while that await is pending still permits source creation and a
  second authorization after it resolves.

Independent typecheck, six server-boundary tests, 13 bridge tests and snapshot/
scoped whitespace checks passed. Additional direct HTTP probes had two passes and
two failures. Evidence: `/tmp/codex-verifier-2b8b-server.test.mjs` and
`/tmp/codex-verifier-2b8b-server-probes.log`. Coordinator read the evidence and
confirmed the reviewed-tree hash still matches; no new runtime checks/source edits.

Delegate only these two cleanup corrections to sol-med on
`/tmp/minu-codex-2b8a-reviewed-tree.sha256` (tree locator, not whole-tree approval):

- Force-close the failed observation transport, or otherwise bound its flushing.
  Add a direct HTTP regression with a reader that **never resumes**, proving the
  server socket/resources are actually released, not merely the source iterator.
  Do not call worker/native stop to clean up a failed subscriber.
- Install cancellation before the first authorization await; check it before
  creating/subscribing to a source or starting another authorization/handshake.
  Disconnected requests must create no late source and perform no second auth.
  Keep pending-authorization slots counted until their underlying work settles;
  cancellation must not enable unbounded outstanding authorization work. Verify
  slot recovery after settlement and bounded bridge shutdown while auth is pending.
- Restrict production changes to `worker-events.ts` and streaming-related
  `worker-bridge.ts`, plus focused server-only regressions and the handoff. Preserve
  per-delivery/idle fences, healthy subscribers, no input replay, normal controls
  and confirmed-stop semantics. Do not refactor the client/public/source layers.
- Return typecheck, focused server/bridge checks and the unchanged four direct HTTP
  probes, a new source manifest and updated handoff before reassessment. No broad
  suite rerun is needed merely for test counts; keep all later drafts intact.

2b8a's scoped approval stands; 2b8b is not approved. Client reader/public wiring
and final integration stay paused/unreviewed, with all existing exclusions/gates
preserved.

### 2b8b cleanup-correction receipt and scoped approval

The author returned only the two server source corrections plus five new direct-
HTTP regressions in `worker-events.test.ts` and an updated handoff. New tree
locator: `/tmp/minu-codex-2b8b-server-rework-source.sha256` (not full-tree approval).
The coordinator verified hashes before/after and confirmed approved 2b8a sources
and later client/public drafts were unchanged; no coordinator source edits.

Coordinator `pnpm check` and all **4/4** unchanged direct HTTP probes passed.
The never-resumed reader now leaves a destroyed response, zero server connections
and zero queued bytes; initial-auth disconnect leaves one authorization and no
source subscription/second authorization. Log:
`/tmp/minu-codex-2b8b-coordinator-probes.log`. `git diff --check` passed.

Author evidence: **18/18** server/bridge tests (including five new direct server
regressions) and **6/6** existing boundary checks passed. The new tests cover slot
accounting until pending authorization settles, recovery afterward, prompt source
return and bounded shutdown without native stop on observation failure. This
remains author evidence, not independent closure; no broad suite was rerun.

Independent reassessment **approved 2b8b only**, closing both MEDIUM findings with
no actionable findings remaining in that scope. Typecheck, **18/18** server/bridge
tests, **6/6** existing boundary tests, **4/4** unchanged HTTP probes, snapshot and
scoped whitespace checks passed. No new broad/full-workspace result is claimed.

The coordinator verified and preserved an identical tree locator at
`/tmp/minu-codex-2b8b-reviewed-tree.sha256`, copied from the server-rework manifest.
As with the earlier locator, this is **not full-tree approval**: it identifies the
current draft while approval remains scoped to 2b8a/source and 2b8b/server only.
Client reader, public wiring and final integrated acceptance are still unreviewed.

### 2b8c client-reader review handoff

Review only the existing `worker-client.ts` streaming method/handshake/decoder and
its immediate use of the approved shared event primitives. Tree locator:
`/tmp/minu-codex-2b8b-reviewed-tree.sha256`; last fully approved adapter baseline:
`/tmp/minu-codex-approved-2b7.sha256`. No source changes or extra runtime checks
accompany this handoff; later drafts stay intact.

Acceptance: strict expected peer/session/generation/claim handshake and normalized
frames; bounded chunk/tail/queue parsing across fragmented multibyte UTF-8/JSON;
honest malformed/oversized/wrong-session/abrupt-EOF errors rather than false clean
completion; cancellation before/during handshake or blocked reads with prompt
socket/reader/listener/timer cleanup. Repeated return and unobserved readiness
rejection must be safe. Established idle streams must outlive the handshake deadline.
No redirects/credential forwarding, implicit retry/reconnect, input replay or
lifecycle side effects; older/unsupported peers must not be falsely accepted.

Use focused client-boundary tests and direct crafted HTTP peers for adversarial
reader assertions, including explicit end versus a server-destroyed gap. Existing
cases cover fragmented text, malformed bytes/schema, identity mismatch, overflow,
blocked-return cancellation, long-lived idle streaming, redirects and old peers.
Do not reopen approved source/server work without a concrete newly exposed concern,
or treat public capability/activity wiring as approved. Return a **2b8c-only**
verdict; 2b8d/final integration and the Pi/unclassified-startup gates remain pending.

### 2b8c frame-accounting correction — bounded rework handoff

Independent review returned **REQUEST_CHANGES — MEDIUM**. The parser/server permit
262,144-byte wire frames, but `BoundedEvents.push` adds 32 accounting bytes to an
event where the wire envelope/newline adds 11, then applies the same frame cap to
that different measure. The top 21 legal wire bytes are rejected by the queue.
An actual bridge + deterministic native fixture completed its turn but failed to
deliver its legal maximum-sized event. This is a newly exposed shared-helper
interaction necessary to fix within 2b8c, not unrelated source/server reopening.

Independent typecheck, 18 focused reader tests and additional identity/EOF/cancel/
overflow probes passed; maximum-frame probes failed. Evidence:
`/tmp/codex-verifier-2b8c-real-boundary.mjs`, its `.log`, and its deterministic helper
`/tmp/codex-verifier-2b8c-large-native.mjs`. Coordinator confirmed the reviewed tree
still matches and read that evidence; no source edits/new runtime checks here.

Delegate this narrow correction to sol-med on
`/tmp/minu-codex-2b8b-reviewed-tree.sha256` (locator, not whole-tree approval):

- Separate legal encoded wire-frame length from queue-memory charging. Align
  server/parser/queue boundary behavior without raising the 256-KiB frame cap,
  2-MiB queued-byte budget or frame/subscriber counts. Do not truncate data or
  remove queue overhead merely to pass the wire limit.
- Add exact-limit acceptance and limit-plus-one rejection regressions using actual
  encoded UTF-8 bytes including the envelope/newline. Cover both the shared queue
  and reader/real-bridge interaction; retain aggregate queue overflow coverage and
  prove observation failure does not stop/replay native work.
- Limit changes to the shared frame/queue accounting and narrowly required reader
  integration, focused regressions/fixture and handoff. Do not alter unrelated
  source lifecycle, server authority/cleanup, public wiring or persisted formats.
  The dependency's changed accounting must be included in the targeted recheck;
  unrelated 2b8a/2b8b approvals remain intact.
- Return typecheck, focused helper/reader tests, the unchanged real-boundary probe,
  a new tree locator and updated handoff. Preserve original probes/snapshots and
  do not substitute a broad run or larger limits for exact boundary evidence.

2b8c remains unapproved; 2b8d/final integration stays paused. Existing exclusions,
the Pi integration gate and earlier unclassified startup failures remain open.

### 2b8c accounting-correction receipt and scoped approval

The author changed only `event-stream.ts:BoundedEvents.push` in production:
actual UTF-8 envelope/newline bytes determine wire legality, while the unchanged
`JSON(event) + 32` charge still enforces the unchanged aggregate queue budget.
New `event-frame.test.ts` and `fixtures/frame-native.ts` cover exact-limit/plus-one,
ASCII/multibyte escaping, seven-versus-eight maximum frames, drained-byte reuse,
raw-reader and actual bridge/native behavior without stopping/replaying input.

New tree locator: `/tmp/minu-codex-2b8c-frame-rework-source.sha256` (not full-tree
approval). Coordinator hashes matched before/after; all other existing source/test
hashes match the 2b8b locator. No coordinator source edits or public/reader changes.

Author **12/12** boundary regressions and **22/22** helper/reader checks passed.
Coordinator `pnpm check`, `git diff --check` and the unchanged actual-bridge boundary
probe passed: a 262,144-byte frame delivered its entire 262,027-character delta,
native status stayed idle and no reader failure occurred. Log:
`/tmp/minu-codex-2b8c-coordinator-boundary.log`. These are focused results, not a
new broad/full-workspace or native model/tool acceptance run.

Independent reassessment **approved 2b8c only**, closing the frame-accounting
finding with no actionable findings in that scope. Typecheck, **12/12** boundary
regressions, **22/22** helper/reader checks, the unchanged actual-bridge probe at
262,144 bytes, snapshot and scoped whitespace checks passed. Exact-limit ASCII/
UTF-8 frames pass and plus-one rejects without removing the 32-byte queue charge
or changing the aggregate bound.

The coordinator verified and preserved the identical tree locator at
`/tmp/minu-codex-2b8c-reviewed-tree.sha256`. Approval now covers 2b8a/source,
2b8b/server and 2b8c/reader (including the accounting interaction), **not** public
wiring or the whole tree. No source changes accompany the approval receipt.

### 2b8d public-wiring and integrated review handoff

Review the remaining managed public event/activity/capability wiring in
`managed-client.ts` and `client.ts`, associated public managed/native tests,
`fixtures/managed-runtime-consumer.ts`, and README's supported modes/limits.
Include integration with the already scoped-reviewed source/server/reader; reopen
those components only for concrete newly exposed interactions, not a blind repeat
of their reviews. Current tree locator: `/tmp/minu-codex-2b8c-reviewed-tree.sha256`;
last fully approved adapter baseline: `/tmp/minu-codex-approved-2b7.sha256`.

Acceptance: only already owner-authorized IDs route to the correct worker; opening,
losing or cancelling observation never allocates/resumes/stops/replays work. Verify
public stable Runtime/caller IDs and lifecycle correlation, documented live-only/
subscription-readiness semantics, phase/timestamp-only activity coalescing and
privacy (including failure paths), prompt idle/already-aborted cancellation, and
honest capabilities derived from the actual live stream handshake. Old/fenced/
unavailable/gapped peers must not produce fabricated support/profile/history.

Confirm consumer exit with an open stream leaves the held turn alive; a fresh
consumer explicitly resumes that worker, observes subsequent events and recovers
retained results without redispatch. Preserve stop-sharing/rebind confirmation,
normal control/history and in-process event/activity behavior. Check documentation
against the actual session-mode, queue/frame, EOF/gap and shutdown guarantees.

Coordinator integration evidence on the unchanged tree:

- `pnpm check` passed.
- `node --test packages/codex/dist/test/*.test.js` passed **275/275**, with normal
  file concurrency and no skipped tests. This includes all Codex test files, not
  the whole workspace. Log: `/tmp/minu-codex-2b8d-coordinator-integration.log`.
- Source/test hashes matched before/after; `git diff --check` passed. No source
  edits or deadline/concurrency changes were made for this check.

Reuse this exact-tree evidence where relevant and run focused independent public/
integration probes as needed. Return the final 2b8d/integrated streaming verdict;
it is not approval of complete managed lifecycle, Conversations/parity, release or
native model/tool acceptance. Earlier startup failures remain unclassified despite
this passing run; the separate Pi readiness race still blocks a clean workspace
gate. Cold resume, remaining lifecycle/recovery, generic conformance and all
other excluded requirements remain unfinished.

### 2b8d safe-activity failure privacy correction — closed after reassessment

Independent public/integrated review returned **REQUEST_CHANGES — MEDIUM**:
a valid handshake followed by malformed private text exposed the raw JSON decoder
diagnostic through `activityEvents().next()`. The helper rethrew the original error,
violating the presentation-safe failure boundary. Independent typecheck and
275/275 Codex tests passed, plus gap/capability/unbound behavior probes; the new
privacy canary failed. Evidence: `/tmp/codex-verifier-2b8d-public.test.mjs`.

Coordinator correction is limited to the shared activity catch path: genuine
observation/open failures now throw a fresh fixed `Codex activity observation
failed` error without the raw error/cause or copied fields. Cancellation still
returns done; genuine failure still rejects, rather than becoming clean completion.
Raw `events` diagnostics are unchanged. No control/lifecycle/transport change.

Three repository canary regressions cover synchronous open failure, rejected next
(with private message/cause/extra property), and the actual public API after a
valid handshake/malformed body. They check message/own descriptors/cause, preserve
raw diagnostics, and verify unbound activity still rejects without subscription,
manifest mutation or native launch. All three failed before and passed after.

Observed checks: `pnpm check`, **10/10** focused helper/public/native activity and
cancellation tests, and **2/2** selected unchanged privacy/gap probes passed.
Logs: `/tmp/minu-codex-2b8d-privacy-{red,focused,public-probes}.log`.
The original probe is untouched. Its third unbound-activity assertion expects the
old `/Unknown Codex/` safe-error text; uniform sanitization intentionally changes
that safe rejection to the fixed error. The raw unbound event error is unchanged,
and the repository public canary tests rejection/no discovery under the new safe
error contract. Do not claim all three original probe assertions were rerun green.

Reviewed source/test locator: `/tmp/minu-codex-2b8d-activity-privacy-source.sha256`.
Only `event-stream.ts`, `event-stream.test.ts` and `managed-runtime.test.ts` changed
among prior source/test entries; README documents the fixed safe-error boundary.
The earlier 275-test pass belongs to the prior tree, not a new 278-test/full-
workspace run. Independent closure and the bounded integrated verdict are recorded
below; this is not whole-Runtime, lifecycle, release or native model/tool approval.

### 2b8d independent approval — bounded managed streaming complete

The independent verifier approved **2b8d**, closed the MEDIUM safe-activity failure-
privacy finding and reported no remaining actionable findings within this checkpoint.
Independent `pnpm check`, **10/10** focused tests, **2/2** selected unchanged public
privacy/gap probes, snapshot and scoped whitespace checks passed. Unbound activity
rejects without discovery/allocation; cancellation and raw diagnostics retain their
distinct behavior. Prior 275-test integration evidence is reused, not reported as a
fresh broad/full-workspace pass on the corrected tree.

Together with the source/server/reader approvals, this completes bounded **2b8
managed live streaming**. The coordinator matched the reviewed source/test hashes
and recorded `/tmp/minu-codex-approved-2b8.sha256`, identical to the privacy-source
locator. Hash check: `/tmp/minu-codex-approved-2b8-check.log`. No source edits,
commits, extra test cycle or release-readiness claim accompany this receipt.

Preserved gates: separate Pi partial-launch-JSON workspace failure; two earlier
unclassified eager-worker startup failures; cold bound resume, suspension,
destruction, explicit recovery/physical process-group ownership, complete lifecycle/
consumer integration and generic conformance; real model/tool/native acceptance.
Later green Codex tests do not classify or close those failures.

### 2b9a idle-suspension proposal — completed without implementation

Prepare a read-only proposal for the smallest next R14 lifecycle increment, not
implementation. Existing `stop` deliberately interrupts work; composing public
`status` then `stop` cannot atomically reject busy admission. An unreachable ready
worker also does not prove clean shutdown or authorize replacement. Establish these
contracts before changing persisted retirement/resume eligibility.

Inspect the pending-worker admission/stop path and its immediate bridge/store/public
consumers. Return:

- One small first checkpoint with a concrete file/test map; split additional
  persistence/public wiring into later checkpoints rather than implement them all.
- The atomic idle-check/admission-close point, including pending native preparation
  and concurrent first-input admission; busy suspension must not interrupt work.
- Required positive worker/native shutdown confirmation and durable retirement
  authority, distinguishing lost/failed acknowledgments from confirmed success.
- Owner/generation/claim fences, clean never-used pending identity handling and
  failure/uncertainty behavior. Preserve exact native binding/history; no replay,
  silent replacement, generation/fence reset or PID-only teardown authority.
- Focused busy/admission-race, wrong-owner/fence and failed/uncertain-shutdown checks,
  plus where eventual public-boundary integration verification belongs.

Do not edit source, run native/model calls, add dependencies/frameworks, fix Pi or
implement bound cold resume, force recovery or destruction in this planning task.
Flag concrete prerequisite/schema changes for agreement before expanding the first
implementation slice. Approval of 2b8 is not approval of a new lifecycle design.

### 2b9a.1 implementation handoff — worker-local idle quiesce only

The read-only proposal recommends one internal `quiesceIdle` operation. Coordinator
inspection confirms a two-file increment can use the existing admission, lifecycle
lock and owned-child shutdown paths without changing registration or public APIs.
The approved 2b8 hashes still match; the proposal made no edits or test/native calls.
This authorizes implementation of the bounded increment, not code acceptance or a
retirement/resume design. Public R14 suspension remains unfinished.

**Baseline and allowed source/test files:**

- `/tmp/minu-codex-approved-2b8.sha256` (verify from the Runtime root).
- `packages/codex/src/pending-worker.ts` — add worker-local idle quiescing; expose
  the method through this module's internal runtime return type only.
- `packages/codex/test/pending-worker.test.ts` — focused deterministic regressions.
- Before-images for an exact two-file review live under
  `/tmp/minu-codex-2b9a1-baseline/packages/codex/`.

No RPC, core-interface/index export, managed-client/public wiring, manifest format
or revision/state mutation, retirement receipt, new launch/resume eligibility,
worker-process-exit proof or history-durability claim belongs in this increment.
A fulfilled operation confirms only this actor's owned native child exit (through
its existing child handle), or a still-pending never-used identity with no owned
native execution or uncertain cleanup. Creating/bound material without an owned
allocation is not proof of a never-used idle identity and must reject.

**Admission and authority:**

- Validate the addressed identity and persisted owner/generation/explicit-resume/
  worker-claim/native-binding fences. `current()` alone is an unlocked read; do
  not carry that authority across a native-status await and then seal from the
  stale snapshot. Use the existing session lock for the final fresh authority
  check and synchronous idle-check/admission seal. Release the lock before
  awaiting native shutdown/forwarding completion.
- Recheck active preparation/dispatched work, native availability and shutdown
  state at that seal. Input wins => busy rejection without interruption,
  cancellation or any seal/stop side effect. Quiesce wins => new input rechecks
  the seal after its awaits and cannot allocate or dispatch. Resolved `allocating`
  promises are not a busy predicate; use the active entry.
- Keep quiesce-specific pending/result identity distinct from ordinary `stop`.
  Repeated calls share the admitted quiesce result, including its rejection;
  ordinary stop winning must never become a fabricated idle-quiesce success.
  Ordinary stop after quiesce may share the existing shutdown work, but may not
  convert failed/unconfirmed quiescing into success.
- Preserve existing retained-turn matching retries, control/stop semantics and
  event shutdown. Failed or unconfirmed shutdown rejects with admission still
  closed; no automatic reopening, replay or replacement. Validation/busy rejection
  before admission must not stop an otherwise authorized worker.

**Verification and handoff:**

Add focused tests for never-used/no-mutation success; idle bound owned-native exit
with unchanged binding/history metadata; busy and paused preparation; both controlled
first-input/admission interleavings; wrong identity/owner, persisted fences/stale
claim/binding; creating/bound-without-owned-allocation refusal; repeated quiesce,
ordinary-stop interleavings and failed/unconfirmed shutdown without false success.
Use deterministic gates rather than timing-only races; clean up owned fixture
children even in deliberately failed shutdown cases. Exercise availability of the
session lock while shutdown is held.

Run `pnpm check` and the full `node --test
packages/codex/dist/test/pending-worker.test.js` file at normal concurrency, keeping
existing deadlines and isolation. Broaden only if a concrete changed consumer or
failure requires it; no new full-workspace/model run is needed for this internal
increment. Return exact checks, a source/test snapshot and the scoped diff against
the before-images for independent review. Do not advance to retirement/public
wiring before this checkpoint's review.

**Deferred prerequisites:** Version-4 registration has no retirement state. The
suggested `ready → retiring → retired` protocol is a proposal, not approved schema
or implementation. Later work must establish exact-generation/claim/connection/
operation retirement authority and actual worker-process exit proof for detached/
reconnected controllers. An intent/revocation receipt is not proof of physical
exit; SIGKILL-confirmed native exit is not proof of flushed history or guaranteed
cold resume. Lost acknowledgments/publication failures/unreachable ready workers
remain unavailable/uncertain, never replacement authority. Bound cold resume,
forced recovery, destruction, Pi fixes, the earlier startup failures and remaining
native/consumer/conformance gates stay separate and open.

### 2b9a.1 implementation received — historical review handoff

Author delivered worker-local `quiesceIdle`, an idle-admitted shutdown result
separate from ordinary stop, and 17 new pending-worker cases. The only changed
source/test files are `pending-worker.ts` and `pending-worker.test.ts`; internal
return typing exposes the method without a core/index/RPC/public API change.
No manifest/retirement/resume change or public suspension is implemented.

Review target: `/tmp/minu-codex-2b9a1-source.sha256`, relative to the approved 2b8
source/test baseline. Exact before-images are under
`/tmp/minu-codex-2b9a1-baseline/packages/codex/`; the submitted two-file patch is
`/tmp/minu-codex-2b9a1.diff`. Author handoff:
`/tmp/minu-codex-2b9a1-handoff.md`. These are submitted artifacts, not approval.

Author evidence: `pnpm check` and **41/41** pending-worker tests (24 existing plus
17 new) passed at normal concurrency without changing existing deadlines.
Log: `/tmp/minu-codex-2b9a1-pending.log`.

Coordinator observed `pnpm check`, **8/8** selected busy/preparation, controlled
admission-race, post-status-await authority and shared-result/lock-release tests
passing. The submitted hashes match; the patch exactly matches the before-images,
all other prior source/test hashes are unchanged, there are no added/missing source/
test paths, and `git diff --check` passed. Logs:
`/tmp/minu-codex-2b9a1-coordinator-{focused,hashes}.log`; regenerated patch:
`/tmp/minu-codex-2b9a1-coordinator.diff`. No coordinator source changes.

Independent review should assess only this two-file increment, including untracked
files, against the preceding handoff. Focus on fresh locked authority and atomic
admission under awaits, busy/preparation rejection without stop/cancellation, the
native-status/authority recheck, correct cached quiesce versus ordinary-stop
interleavings, closed admission after unconfirmed exit, and release of the lifecycle
lock before awaiting shutdown/forwarding. Check refusal of unowned creating/bound
material, retained retry/event/stop regressions, unchanged metadata and ownership-
scoped native shutdown. Reuse approved layers unless a concrete new interaction
requires inspection. Require a verdict before moving to any retirement/public work.

The independent verdict below closes this internal checkpoint only. No new broad/
full-workspace or real Codex/model/tool acceptance is claimed. Public R14 suspension,
actual worker-process/group exit, durable retirement, transcript durability/cold
resume, force recovery/destruction and all previously recorded integration gates
stay open.

### 2b9a.1 independent approval — worker-local quiesce only

The independent verifier approved **2b9a.1 only**, with no actionable findings.
Independent `pnpm check`, **41/41** pending-worker tests at normal concurrency,
**5/5** additional authority/fencing probes, approved before-images/exact patch,
snapshot and scoped whitespace checks passed. Probe artifact:
`/tmp/codex-verifier-2b9a1-quiesce.test.mjs`; logs:
`/tmp/codex-verifier-2b9a1-{typecheck,pending,quiesce,final-hashes}.log`.

The verdict confirms one admission winner, non-interruption of busy/preparing
work, shutdown completion outside the lifecycle lock, distinct ordinary-stop/
quiesce confirmation, failure with admission still closed, and fresh authority
checks before returning cached results. These are worker-local properties, not
public suspension, physical worker/group exit or native history durability.

The coordinator matched the reviewed source/test hashes and recorded
`/tmp/minu-codex-approved-2b9a1.sha256`, identical to
`/tmp/minu-codex-2b9a1-source.sha256`. Check log:
`/tmp/minu-codex-approved-2b9a1-check.log`. No source edits, new test cycle or broad/
real-native acceptance claim accompany this receipt. The Pi launch-JSON workspace
gate, earlier unclassified startup failures and all unfinished lifecycle/recovery,
consumer, conformance and native-acceptance work remain open.

### 2b9a.2 retirement/exit-proof proposal — absence-based working direction

Prepare a read-only design proposal, not implementation/schema changes. The
worker-local primitive deliberately leaves the bridge/worker alive; its result
cannot satisfy public `suspend` or authorize replacement. Version-4 registration
has no retirement state, and detached/reconnected controllers lack a retained
worker child handle. Choose the smallest concrete proof/protocol before persistence
or public wiring is authorized.

Return:

- Exact meaning and correlation of any retirement intent, native-quiesce evidence
  and physical worker-exit evidence: owner, generation, claim, connection and
  suspension operation. A receipt written before exit proves neither actual OS
  exit nor flushed native history. Separate those claims explicitly.
- One concrete worker-exit proof mechanism usable after consumer reconnect, with
  bounded failure behavior for PID reuse/permission denial, lost acknowledgment,
  late exit, publication failure and consumer/worker crash. Prefer the existing
  authenticated process/registration boundary; justify any extra mechanism with
  the specific failure the simpler approach cannot handle. Persisted PID/token or
  endpoint failure alone must not authorize signaling, replacement or success.
- Minimal state/CAS and publication ordering, and how fresh controllers inspect
  uncertain outcomes without automatically retrying mutations, replaying input,
  resetting registration to `none`, changing native binding or clearing fences.
  `ready → retiring → retired` remains a candidate, not an approved schema.
- The smallest first implementation checkpoint, exact file/test map and format-
  compatibility decision, separating storage, worker/RPC and public integration.
  Do not infer public suspended/resumable state from a private receipt alone.
- Native/history limits, including SIGKILL escalation and never-used versus bound
  identities; identify any prerequisite for R14 history preservation instead of
  treating unchanged Runtime metadata as proof of native history durability.

No source edits, schema/version changes, tests/process/model calls, new dependencies
or supervisor framework in this proposal task. Bound cold resume, forced recovery,
destruction and Pi fixes stay separate. Flag concrete prerequisites for agreement;
2b9a.1 approval does not approve retirement or a worker-exit mechanism.

#### Witness proposal received — not yet authorized

The author proposed a per-worker parent exit witness: retain one worker child,
correlate its private quiesce messages with the suspension operation, observe the
actual child `exit` event, then publish private CAS evidence. Consumer disconnect
would not stop either actor; witness loss before publication remains uncertain.
The proposed ordering separates sealed intent, owned-native shutdown and actual
worker exit. Existing version-4 workers cannot silently acquire this parent;
read/control compatibility was suggested but no format policy has been approved.
The author reports no edits or runtime/test calls; approved 2b9a.1 hashes match.

This is a concrete sufficient child-exit mechanism, but its necessity relative to
a smaller OS-observation path has not been established. Source inspection confirms
that `managed-worker.ts` currently loses controller access to the child handle
after returning the authenticated connection; connection/manifest material has no
host/boot/PID-namespace provenance. Plain `ESRCH` from an arbitrary reconnected
consumer is therefore **not** accepted as proof under the current format.

Before adding a resident process and changing launch ancestry, return one bounded
read-only comparison:

- **Candidate A:** exact-operation authenticated native-quiesce evidence plus a
  positive OS absence observation in a demonstrably comparable process domain.
  State the supported host/boot/PID-namespace assumptions and the smallest way to
  establish them. Missing/ambiguous provenance, a live/reused PID, permission denial
  or unsupported inspection must stay unconfirmed. This is not PID-based signal
  authority, and endpoint/EOF failure alone is never physical-exit evidence.
- **Candidate B:** the retained-parent witness, including its lifetime/resource
  cost, witness-loss behavior and the production launch/registration/cleanup
  changes it requires. Account for the existing direct-child PID checks and
  pre-ready adoption/cleanup fences, not merely the isolated primitive.
- Compare minimal complete changes and meaningful failure cases on the supported
  environment. Either demonstrate a concrete failure of A that makes B necessary,
  or recommend the simpler proof with its explicit fail-closed limits. Do not
  weaken actual worker-exit, native-quiesce or history-preservation requirements.
- Keep legacy read/control, schema compatibility and migration decisions explicit
  and separate; neither candidate may silently upgrade old workers, reset claims
  or grant cold-resume eligibility.

No source/schema edits or test/runtime/native calls are authorized for this
comparison. Do not implement the proposed witness primitive yet. Physical worker
exit is still required; this is a minimality/proof-domain decision, not permission
to substitute an acknowledgment or to relabel a live bridge as a stopped worker.
All previously recorded gates remain open.

#### Comparison outcome — no witness authorized

The author found no necessity for a witness within a successfully established
same-domain absence path. Rapid PID reuse and restricted visibility reduce that
path's availability, but remaining unconfirmed is acceptable rather than inventing
exit proof. A witness would additionally change launch ancestry, worker/witness
identities, readiness/PID checks, pre-ready cleanup/adoption arbitration, retained
IPC and witness-loss handling. Keep it as an unapproved alternative if a concrete
required availability case later defeats the simpler design.

Use correlated native-quiesce plus verified-domain OS absence as the **working
direction**, conditional on validating the provider and deployment assumptions.
Current version-4 records contain no such provenance and gain no new authority.
An explicitly unsandboxed, host-local, uncloned macOS process domain was proposed;
ordinary UUID reads do not attest those conditions. Do not imply automatic sandbox/
VM/clone detection or physical-exit proof from matching strings. No complete proof,
schema, migration/enrollment or public suspension design has been approved.

### 2b9a.2a implementation handoff — unwired Darwin domain observations only

Implement the smallest private OS-observation increment to validate the provider
inputs. This is not an absence checker, retirement protocol or lifecycle authority.
All approved existing source/test entries must remain unchanged.

**Allowed new files, Runtime-relative:**

- `packages/codex/src/darwin-process-domain.ts` — minimal private collector/parser
  for OS-sourced host identity and kernel boot-session identity on Darwin.
- `packages/codex/test/darwin-process-domain.test.ts` — parser/failure tests and
  actual supported-host boundary checks.
- `packages/codex/test/fixtures/darwin-domain-observer.ts` — only if needed, one
  transient owned Node fixture that independently collects its own observations.

Baseline: `/tmp/minu-codex-approved-2b9a1.sha256`; coordinator preflight log:
`/tmp/minu-codex-2b9a2a-baseline.log`. All three paths were absent at handoff.

**Contract and limits:**

- Read narrowly scoped, documented trusted OS sources; validate their exact
  identity meanings rather than guessing keys or deriving both from installation
  data. Use fixed trusted executable paths/arguments if commands are required,
  bounded asynchronous reads/timeouts/output, strict minimal parsing and no
  hostname/installation-token/environment fallback. Missing/malformed/denied/
  unsupported observations fail closed with no raw diagnostics in the result.
- Return private observation data only, not `verified` deployment/namespace/exit
  flags. Host-local/unsandboxed/uncloned preconditions cannot be inferred merely
  because UUID reads succeed; state them as unresolved proof/deployment conditions.
  Non-Darwin behavior must be unavailable without borrowing Darwin assumptions.
- No PID queries or `kill(pid, 0)`, signal API, worker-exit decision, manifest/
  schema/version changes, registration enrollment, launch/RPC/public/index wiring,
  replacement/resume eligibility, new resident actor, dependencies or framework.
  Existing version-4 read/control behavior stays unchanged. Linux proof remains
  separate; this increment does not redefine platform/product completion scope.
- Keep host/boot identities and raw command output private: no logs, public
  profiles/events/errors or README claims of verified suspension. If required OS
  sources are unavailable or their semantics cannot be justified, report the
  concrete blocker rather than invent a weaker fallback or expand scope.

**Proportionate verification:**

Exercise valid/minimal parsing, malformed/oversized/missing values, unavailable/
permission/command failures and bounded timeout behavior without output leakage.
On the supported Darwin host, verify actual OS reads and compare independently
collected parent/owned-fixture observations, reporting only redacted outcomes.
Use deterministic inputs for parser/failure cases; do not fake supported-host
acceptance on other platforms or silently skip a required check. This demonstrates
observation consistency, not trusted worker provenance or physical exit.

Owned transient test children and bounded read-only OS queries are authorized for
this increment; clean up only handles created by these tests. No Codex/model/tool
calls, unrelated process inspection/signaling, Pi work or broad workspace runs.
Run `pnpm check` and `node --test
packages/codex/dist/test/darwin-process-domain.test.js`, recording Node/macOS versions
and the exact trusted source semantics without identifiers. Return a patch, observed
checks/limits and a source/test snapshot **including all new files**, not merely
rehashed prior entries. Independent review is required before any integration or
physical-exit proof is claimed. Public R14, history durability/cold resume and all
previous integration gates remain open.

### 2b9a.2a implementation received — historical review handoff

The author added only the three authorized collector/test/fixture files. The
collector returns private `ioPlatformUuid` and `bootSessionUuid` observations or
`undefined`, using fixed trusted `ioreg`/`sysctl` paths, path-ownership checks,
clean environment, bounded query children/output and strict parsing. It has no
production imports, PID inspection, registration/lifecycle/public integration or
attestation/physical-exit verdict.

Review target: `/tmp/minu-codex-2b9a2a-source.sha256`, including all three new files,
against `/tmp/minu-codex-approved-2b9a1.sha256`. New-file patch:
`/tmp/minu-codex-2b9a2a.diff`; redacted author OS/version/source-semantics evidence:
`/tmp/minu-codex-2b9a2a-os-evidence.md`. Author environment: Node v22.23.0,
macOS 14.1 / Darwin 23.1.0, kernel xnu-10002.41.9. Exact source meanings/references
are recorded in that evidence, not inferred from matching UUID strings.

Author typecheck and **40/40** focused tests passed with zero skips. The initial
39/40 run failed the actual OS-layout check; redacted diagnostics established the
fixed `ioreg` brace/property/whitespace layout, and parser/fixtures were corrected
without falling back to weaker sources. Preserve
`/tmp/minu-codex-2b9a2a-tests-initial.log`; final author log:
`/tmp/minu-codex-2b9a2a-tests.log`. This classified parser issue does not classify
the earlier unrelated eager-worker startup failures.

Coordinator `pnpm check` and the entire new collector test file passed **40/40**,
zero skips, including actual Darwin parent/independent-owned-fixture agreement,
owned-query timeout and buffer-overflow cleanup. Outcomes remain redacted. Log:
`/tmp/minu-codex-2b9a2a-coordinator-tests.log`. The submitted snapshot includes all
current source/test paths, the approved prior hashes are unchanged, the patch
exactly matches the three new files, and tracked/new-file whitespace checks passed.
Metadata: `/tmp/minu-codex-2b9a2a-coordinator-{hashes,prior-hashes,whitespace}.log`
and `/tmp/minu-codex-2b9a2a-coordinator.diff`. No coordinator source edits.

Request independent review of only these three new files (including untracked
content). Assess actual OS source semantics and truthful field naming, fixed-path/
environment trust, strict bounded parsing and fail-closed command/timeout handling,
resource cleanup of owned query/fixture children, absence of identifier/raw-output
leakage, realistic supported-host evidence and unsupported-platform behavior.
Confirm no lifecycle/authority inference or production wiring. Parent/fixture
agreement proves observation consistency only, not an unsandboxed/uncloned domain,
comparable PID visibility or worker exit. Require a scoped verdict before further
integration. All public R14, native-history/cold-resume, Pi/startup and other
integration/acceptance gates remain open; no broader or real Codex/model/tool run
is claimed.

### 2b9a.2a independent approval — observation-only collector

The independent verifier approved **2b9a.2a only**, with no actionable findings.
Independent `pnpm check`, **40/40** focused tests with zero skips, real Darwin
parent/fixture agreement and owned-query timeout/overflow cleanup passed. OS-source
semantics were checked against installed documentation/SDK and matching XNU source.
Prior approved hashes, the full submitted snapshot, exact new-file patch and scoped
whitespace checks matched/passed. Results remain two private observations, not
attestation or authority; identifier redaction and actual-host parser correction
were verified.

The coordinator matched and recorded `/tmp/minu-codex-approved-2b9a2a.sha256`,
identical to `/tmp/minu-codex-2b9a2a-source.sha256`. Check log:
`/tmp/minu-codex-approved-2b9a2a-check.log`. Independent evidence:
`/tmp/codex-verifier-2b9a2a-{typecheck,tests,final-hashes}.log` and the preserved
`/tmp/codex-verifier-2b9a2a-{IOPlatformExpert.cpp,kern_sysctl.c}` source references.
No source edits or additional test cycle accompany this receipt. No broad/full-
workspace or real Codex/model/tool acceptance is claimed. Existing Pi workspace,
unclassified startup, lifecycle/recovery, consumer/conformance and native gates
remain open.

### Owner decision — existing Runtime local-host model, no extra opt-in

After comparing the existing Pi implementation, the owner accepted reuse of
Runtime's normal local-host deployment assumption **without a Codex-only opt-in**,
while retaining Codex's explicit ownership and shutdown-confirmation safeguards.
This supersedes the earlier proposed opt-in/owner-input gate; it does not approve a
witness, weaken physical-exit confirmation to deregistration, or attest deployment
conditions from UUIDs. Codex's read-only sandbox and approvalPolicy `never` stay
unchanged. Unknown/unsupported inspection stays unconfirmed, and no claim of
universal VM/namespace/clone detection is made.

Pi precedent inspected: `packages/pi/src/client.ts:482,802` performs authenticated
idle-only stop, waits for deregistration and validates its transcript. Explicit
recovery at `client.ts:432` / `worker-recovery.ts:17` adds PID/group checks and
identity verification before OS signals. Ordinary Pi suspension is not independent
physical-worker-exit proof. No Pi changes or new Pi acceptance claims accompany
this policy decision.

### 2b9a.2b implementation handoff — private Darwin PID-absence observations

Implement only two new files:

- `packages/codex/src/darwin-process-absence.ts`
- `packages/codex/test/darwin-process-absence.test.ts`

Baseline: `/tmp/minu-codex-approved-2b9a2a.sha256`; preflight log:
`/tmp/minu-codex-2b9a2b-baseline.log`. Both paths were absent. Reuse the existing
collector and transient `darwin-domain-observer` fixture's hold/hang mode; do not
modify approved source/fixtures or add dependencies/frameworks/production wiring.
Flag a concrete prerequisite before expanding these two-file bounds.

**Changed behavior and risk:** observe one positive PID slot read-only after fresh
private Darwin observations match the captured expected host/boot observations,
under the accepted local-host model. Misclassification must not create lifecycle,
replacement or signal authority.

- Capture the target/expected observation inputs before awaits. Validate rather
  than coerce PID inputs; reject zero, negative/group, fractional, non-numeric and
  out-of-range values before any PID query. Compare fresh collector results; do
  not reuse cached prior success after failed/mismatched/missing observations.
- Return minimal private facts, conceptually `pid_absent`, `pid_present` or
  `unconfirmed`. Non-Darwin, invalid/missing expected observations, host/boot
  mismatch, collection failure or unknown errors stay unconfirmed without a PID
  query when the preconditions fail. Matching strings remain observations, not
  deployment/namespace attestation.
- The sole process query is fixed `process.kill(pid, 0)`: only its `ESRCH` outcome
  after matching fresh observations may mean PID absent. Normal return means a PID
  is occupied, not that the original worker/identity is alive; reuse remains
  unconfirmed for worker exit. `EPERM` and every other error are not absence.
  Never deliver nonzero signals, inspect groups, scan processes or add kill/retry
  fallbacks. No identifiers/raw diagnostics in returned status or logs.
- No manifest/schema/enrollment/launch/RPC/public/index changes, no extra flag,
  witness, retirement receipt, resume/replacement eligibility or state mutation.
  This helper is not authenticated shutdown proof: future integration must first
  correlate exact owner/session/generation/claim/connection/operation and native-
  quiesce evidence, then revalidate authority around observation/publication.
  Endpoint/registry disappearance never substitutes for those facts. Physical
  group/descendant exit and native history durability are not established here.

**Focused verification:** cover invalid inputs without queries, missing/malformed/
changed host/boot observations, mutation of expected inputs across an await,
unsupported platform, collection failure, occupied/reused PID, `ESRCH`, `EPERM`
and other errors, fixed signal zero and no cached-success/error-data leakage.
Use deterministic mocks for permission/reuse/error cases. On Darwin exercise a
transient owned fixture while alive and after its actual child exit; keep OS
identifiers redacted and clean up only owned child handles. Actual non-Darwin
checks must report unconfirmed rather than impersonate Darwin acceptance.

Run `pnpm check` and `node --test
packages/codex/dist/test/darwin-process-absence.test.js`. Reuse the unchanged
collector's approved evidence; broaden only for a concrete affected failure, not
another broad workspace cycle. Return the patch, focused evidence and a complete
source/test snapshot including the new files for independent review before any
integration. No Codex/model/tool calls, Pi work or public lifecycle changes.
Public R14, retirement/provenance storage, cold resume, forced recovery/destruction
and all existing integration/acceptance gates remain open.

### 2b9a.2b implementation received — historical review handoff

The author added only `darwin-process-absence.ts` and its test file. The helper
snapshots/validates inputs, collects fresh host/boot observations and returns only
`pid_absent`, `pid_present` or `unconfirmed`. Its sole PID query is fixed signal
zero; only direct `ESRCH` after matching observations means an absent slot.
This is not worker identity, authenticated quiesce/exit proof or lifecycle authority.
The owner-approved normal Runtime local-host model applies; no extra opt-in/witness
or deployment/namespace attestation is introduced.

Target: `/tmp/minu-codex-2b9a2b-source.sha256`, including both new files, relative
to `/tmp/minu-codex-approved-2b9a2a.sha256`. Patch:
`/tmp/minu-codex-2b9a2b.diff`; author handoff:
`/tmp/minu-codex-2b9a2b-handoff.md`.

Author typecheck and **50/50** focused tests passed, zero skips, including actual
Darwin owned-fixture PID presence/absence. Coordinator `pnpm check` and the same
new test file also passed **50/50**, zero skips. Supported-host output is redacted;
permission/reuse/error cases are deterministic mocks, and real termination is only
through the fixture's retained owned handle. Coordinator log:
`/tmp/minu-codex-2b9a2b-coordinator-tests.log`.

The submitted snapshot matches every source/test path, all prior approved hashes
remain unchanged, only the two allowed files were added, the regenerated patch
matches exactly and tracked/new-file whitespace checks passed. Artifacts:
`/tmp/minu-codex-2b9a2b-coordinator-{hashes,prior-hashes,whitespace}.log` and
`/tmp/minu-codex-2b9a2b-coordinator.diff`. No coordinator source edits.

Request independent review only of these two untracked files. Focus on strict
non-coercing PID validation, expected-data capture across awaits, fresh matching
observations before queries, unsupported/mismatch/failure behavior, exact signal
zero and ESRCH-only classification, no cached success/diagnostic leakage, realistic
owned-fixture cleanup and truthful distinction between PID-slot and worker proof.
Reuse the unchanged collector's approval unless a concrete interaction requires
inspection. No schema, launch/registration, public/RPC/index, retirement or native
history/resume integration is present. Await a scoped verdict before advancing;
all previously recorded gates stay open, with no broad/workspace or real Codex/
model/tool acceptance run.

### 2b9a.2b independent approval — PID-slot observations only

The independent verifier approved **2b9a.2b only**, with no actionable findings.
Independent `pnpm check`, **50/50** focused tests with zero skips, actual Darwin
owned-fixture presence/absence and cleanup, prior approved hashes, complete snapshot,
exact patch and scoped whitespace checks passed. The unchanged collector approval
was reused. Evidence: `/tmp/codex-verifier-2b9a2b-{typecheck,tests,final-hashes}.log`.

Inputs are captured before awaits; fresh matching observations gate one fixed
signal-zero query; only ESRCH yields absence; unknown/permission failures remain
unconfirmed without diagnostic leakage. These are PID-slot facts, not worker
identity, native-quiesce proof, deployment/namespace attestation or lifecycle rights.

The coordinator matched and recorded `/tmp/minu-codex-approved-2b9a2b.sha256`,
identical to `/tmp/minu-codex-2b9a2b-source.sha256`. Check log:
`/tmp/minu-codex-approved-2b9a2b-check.log`. No source edits or additional test cycle
accompany this receipt. No broad/full-workspace or real Codex/model/tool acceptance
is claimed. The Pi partial-launch-JSON gate, earlier unclassified startup failures,
public lifecycle/recovery, consumer/conformance and native-acceptance work stay open.

### 2b9a.2c storage/correlation proposal — received; first increment scoped below

Prepare one small read-only proposal for persisted correlation and retirement CAS,
with a **storage-only first implementation checkpoint** and exact file/test map.
Do not implement schema, launcher, worker/RPC or public changes yet. The source
baseline is `/tmp/minu-codex-approved-2b9a2b.sha256`.

The existing strict version-4 manifest supports only none/reserved/aborted/ready
registration and contains neither launch provenance nor a suspension operation.
The approved helpers alone cannot establish safe retirement. Specify:

1. The exact proposed format/fields and compatibility decision. Preserve existing
   version-4 read/control behavior without silently enrolling/migrating live legacy
   workers or rewriting their native binding. Explain how new material differs;
   no version/default change is approved merely by requesting this proposal.
2. How independently collected launcher/worker observations will be matched and
   bound to the exact owner/session/generation/claim/PID/connection before becoming
   useful retirement evidence. Data equality is not attestation. Keep all private
   connection/provenance material out of public summaries/events/diagnostics.
3. A small state/transition table and writer authority for intent, confirmed owned-
   native quiesce (including verified never-used identity), and completed original-
   worker retirement. Correlate one stable suspension operation and immutable
   evidence; define expected-revision checks, fresh generation/explicit-resume/
   claim/connection fences and exact-operation idempotency. Missing native proof,
   occupied/reused PID or any unconfirmed observation cannot complete retirement.
4. Publication/crash ordering: busy admission must reject without side effects;
   seal admission and commit intent before native shutdown; await shutdown outside
   the lock; publish native evidence before worker exit; observe the recorded PID
   only with matching fresh domain data and revalidate exact authority before final
   CAS. The current quiesce method couples seal/shutdown: identify any necessary
   narrow seam as a separate later checkpoint, not a hidden storage-patch expansion.
5. Read-only inspection after lost acknowledgment, ambiguous publication, late exit
   or consumer restart. Preserve the same operation; never assume an error means a
   write failed, silently retry a mutation/new ID, reset registration to `none`,
   clear a fence, authorize replacement or replay input. Completed private records
   do not automatically imply public suspended/resumable state or durable history.

Return the smallest first storage increment and focused real-filesystem/CAS test
map, including wrong owner/claim/connection/operation, persisted fence changes,
revision conflicts, missing/mismatched facts, idempotency and partial publication.
Name any concrete prerequisite before expanding its file/behavior bounds. Keep
producer/protocol integration and public suspension in subsequent checkpoints.

Use the owner's accepted existing Runtime local-host model: no new opt-in, witness,
resident process, dependency/framework or Pi refactor. No edits, process probes,
new test runs or Codex/model/tool calls in this proposal task. Native-history
preservation, cold resume, force recovery/destruction and all existing gates remain
separate unfinished work.

### 2b9a.2c1 implementation handoff — v5 correlation storage only

Proceed with the author's two-file correlation-only increment, not the proposed
retirement transitions. Source inspection confirms strict v4 parsing currently
rejects every additional root field; an explicit v5 branch is appropriate for the
new private record. Existing production creation in `managed-native.ts` remains
version 4. No migration, automatic enrollment or producer integration is authorized.

**Allowed files:** `packages/codex/src/managed-store.ts` and
`packages/codex/test/managed-store.test.ts`. Baseline:
`/tmp/minu-codex-approved-2b9a2b.sha256`. Exact before-images are under
`/tmp/minu-codex-2b9a2c1-baseline/packages/codex/`; hash preflight:
`/tmp/minu-codex-2b9a2c1-baseline.log`. Flag any concrete need for another file
before expanding this checkpoint.

**Format/API:**

- Keep strict version-4 reads/control unchanged and reject v4 correlation
  enrollment. Continue refusing other unsupported formats. Add explicit strict v5
  parsing with an optional private `processDomain` containing exactly `connection`,
  `launcher` and `worker`; the latter two contain only the collector's well-formed
  normalized UUID observations. Compare the complete validated connection,
  including version/owner/session/generation/claim/PID/endpoint/token, with the
  ready registration; observations must match. No attestation flags or extra data.
- Add one lease/CAS operation recording that immutable correlation only on v5
  ready material. Snapshot all nested caller data before awaits; use existing
  lease lifetime/serialization, bounded private-file and atomic-publish machinery.
  Tests may construct v5 records explicitly; do not change production factories,
  registration states, default launch behavior, native binding or launch policy.
- Require fresh root generation matching the ready claim/connection, clear
  explicit-resume fence, exact addressed identity/connection and current expected
  revision before either new recording or an identical replay. For this first
  API, all stale revisions conflict, including matching payloads. With the current
  revision and fresh authority, identical data returns unchanged without revision
  increment or publication; conflicting data cannot replace an existing record.
- **Historical-read clarification:** correlation must remain readable/listable
  after a root generation change or explicit-resume fence, and must not prevent
  those existing fence updates. Structural validation ties retained evidence to
  its recorded ready registration/connection, not to a requirement that it is
  still authorized by the current root generation. The mutator's separate fresh
  checks must then reject both new writes and cached-success replay after fencing.
  This preserves inspection without treating historical data as fresh authority.

Storage checks only structure/correlation. It cannot establish that two processes
collected independently, authenticate a worker report or prove OS/native/worker
exit. Those producers, retirement intent/native-quiesce/finalization states, the
seal-before-shutdown seam and public behavior remain later unapproved checkpoints.
No OS/PID queries, state resets, scope/fence clearing, replacement or resume rights.

**Checks and handoff:**

Add filesystem/CAS tests for strict v4/v5 round trips and no implicit upgrade;
malformed/extra-field and private-file rejection; wrong owner/session/generation/
claim/PID/endpoint/token and mismatched observations; stale revisions; exact replay
and immutable conflicts; nested argument mutation across awaits; fenced historical
read/list plus valid fence updates and rejected fresh/cached mutations; lease
lifetime/concurrency; and failures before/after atomic rename with readable old/new
outcomes and no automatic retry. Preserve existing native/storage protections.

Run `pnpm check` and `node --test packages/codex/dist/test/managed-store.test.js
packages/codex/dist/test/managed-worker.test.js` at normal file concurrency, keeping
existing deadlines. These cover the changed shared storage/registration boundary;
broaden only if a concrete consumer/failure requires it. Do not serialize tests or
use later passing checks to erase failures. Return exact results, scoped patch
against the before-images, a complete source/test snapshot and limitations for
independent review. No broad workspace/model run, Pi work, dependencies/framework,
RPC/public/index/schema producer changes or retirement transitions in this increment.
All existing lifecycle/history/recovery and integration/acceptance gates stay open.

### 2b9a.2c1 implementation received — historical review handoff

Author delivered explicit strict v5 parsing and the lease `recordProcessDomain`
operation, changing only `managed-store.ts` and `managed-store.test.ts`. Production
creation remains v4; v4 read/control is preserved and v4 correlation enrollment is
rejected. There are no retirement states, OS queries or producer/public changes.
The Darwin observation import is type-only. Storage validates correlation, not
independent collection, authenticated provenance or shutdown/exit/history proof.

Review target: `/tmp/minu-codex-2b9a2c1-source.sha256` relative to
`/tmp/minu-codex-approved-2b9a2b.sha256`. Exact before-images:
`/tmp/minu-codex-2b9a2c1-baseline/packages/codex/`; patch:
`/tmp/minu-codex-2b9a2c1.diff`; author handoff:
`/tmp/minu-codex-2b9a2c1-handoff.md`.

Author `pnpm check` and **112/112** storage/registration tests passed at normal file
concurrency, zero skips, without deadline/concurrency overrides. Log:
`/tmp/minu-codex-2b9a2c1-storage-registration.log`. Coordinator typecheck and **7/7**
selected current-revision/idempotent replay, fenced historical read/replay, nested
input snapshot, competing CAS and before/after-rename publication cases passed.
Log: `/tmp/minu-codex-2b9a2c1-coordinator-focused.log`.

Coordinator hashes match the complete submitted source/test snapshot. Only the two
authorized prior entries differ; there are no added/missing source/test paths. The
regenerated two-file patch matches the before-images exactly, and tracked/scoped
whitespace checks passed. Artifacts:
`/tmp/minu-codex-2b9a2c1-coordinator-{hashes,whitespace}.log` and
`/tmp/minu-codex-2b9a2c1-coordinator.diff`. No coordinator source edits.

Request independent review of this two-file increment, including untracked content.
Focus on strict version branches and unchanged v4 defaults/control; complete private
connection/observation correlation; fresh generation/explicit-resume checks and
current CAS revision before both new writes and cached replay; immutable payload,
no-op replay and argument snapshotting; historical evidence remaining readable and
not preventing fence updates; lease/private-file/byte-limit/atomic-publication
safeguards and inspectable uncertain outcomes without retries. Reuse approved
layers unless a concrete interaction requires review. Return a scoped verdict
before retirement/storage producer integration. All existing gates remain open;
no broad/full-workspace or real Codex/model/tool acceptance is claimed.

### 2b9a.2c1 independent approval — correlation storage only

The independent verifier approved **2b9a.2c1 only**, with no actionable findings.
Independent typecheck, **112/112** storage/registration tests at normal concurrency,
**2/2** additional storage-workflow probes, baseline/complete snapshot/exact patch
and scoped whitespace checks passed. V4 defaults remain unchanged; v5 correlation
is immutable, fresh-authority/current-revision guarded even on replay, historically
readable after fencing, and atomically inspectable after publication uncertainty.

One review-only probe initially assumed the pending factory returned its private
manifest. It actually returns a session summary; the probe was corrected to read
the stored manifest before checking v4 defaults/inventory. No implementation was
changed or assertion waived. Preserve the initial script/log:
`/tmp/codex-verifier-2b9a2c1-storage-initial.test.mjs` and
`/tmp/codex-verifier-2b9a2c1-storage-probes-initial.log`; corrected probes/log:
`/tmp/codex-verifier-2b9a2c1-storage.test.mjs` and
`/tmp/codex-verifier-2b9a2c1-storage-probes.log`. Other independent evidence:
`/tmp/codex-verifier-2b9a2c1-{typecheck,storage-registration,final-hashes}.log`.

The coordinator matched and recorded `/tmp/minu-codex-approved-2b9a2c1.sha256`,
identical to `/tmp/minu-codex-2b9a2c1-source.sha256`. Check log:
`/tmp/minu-codex-approved-2b9a2c1-check.log`. No source edits or additional test cycle
accompany this receipt. Correlation storage is not independent producer collection,
authenticated quiesce/exit proof, public suspension or native-history acceptance.
Pi/startup and all remaining lifecycle/recovery/consumer/conformance/native gates
remain open; no broad/full-workspace or real Codex/model/tool run is claimed.

### 2b9a.2c2 implementation handoff — retirement-intent storage only

Implement only the first proposed retirement transition, **v5 ready → retiring**,
in `packages/codex/src/managed-store.ts` and
`packages/codex/test/managed-store.test.ts`. Keep production creation v4, preserve
v4 reads/control and reject v4 enrollment/new states; no migration or producers.
Baseline: `/tmp/minu-codex-approved-2b9a2c1.sha256`; before-images:
`/tmp/minu-codex-2b9a2c2-baseline/packages/codex/`; preflight log:
`/tmp/minu-codex-2b9a2c2-baseline.log`. Flag a concrete need for any other file
before expanding scope.

**Private format and operation:**

- A v5 `retiring` registration retains the ready record's exact `claimId`,
  `generation` and complete `connection`, plus exactly a `retirement` intent with
  `operationId` and `native` snapshot. The snapshot is strictly `{ state: pending }`
  or `{ state: bound, threadId }` matching current native material; creating/
  uncertain material is ineligible. Require the existing matching `processDomain`
  record, unchanged. No native-quiesce/worker-exit/history-success facts or `retired`
  state in this increment; strict parsing rejects such unsupported additions.
- Add a lease/CAS begin-intent operation taking the stable operation ID, expected
  full connection and native snapshot. Validate/snapshot nested inputs before
  awaits. Require v5 ready material, existing correlation, clear explicit-resume
  fence, fresh matching root/registration generation, current expected revision
  and exact identity/claim/PID/endpoint/token/connection/native binding. Publish
  only the intent/state and revision increment; preserve all other material.
- An already-retiring exact intent may return unchanged only with current revision
  and fresh fences/connection/native match. Different operations or payloads,
  stale revisions, missing correlation and fenced/new claims conflict without
  publication. Do not overwrite an intent, reopen admission, reset registration
  to none, clear fences or grant replacement/resume eligibility.
- Structural validation must accept retained correlation/intent after root
  generation or explicit-resume fencing, without blocking those fence updates;
  reads/list preserve historical data while fresh/cached mutation guards reject.
  The captured native binding stays exact: existing native creation/bind operations
  must not advance or retarget it after intent. Unknown/malformed intent fields,
  operation IDs, nested snapshots and mismatched correlations fail closed.
- Normal ready/reserved claim authorization remains unchanged and must reject
  `retiring`; do not widen default authorization to make the new state reachable.
  Pre-ready cleanup must whitelist only its existing reserved/aborted cases and
  never gain authority over retiring material. Other registration/enrollment
  mutators remain ineligible after intent. Update only in-module guards needed
  for this new union member; do not refactor unrelated controls.

Storage records a correlated **intent**, not proof that an owning worker actually
checked idle or sealed admission. That truth requires a later authenticated worker
producer which atomically checks idle/seals and commits intent before shutdown.
The current quiesce seam, expected stream completion, native-quiesce recording,
PID observation/final CAS and public suspension remain separate checkpoints.

**Verification and handoff:**

Cover pending/bound intent round trips and immutable data; v4/default compatibility;
non-ready/un-correlated/creating material; every connection/native/operation mismatch;
stale and fenced fresh/replay attempts; no-op exact replay/no rename; retained
read/list and allowed fence updates; blocked native/registration/enrollment/pre-ready
cleanup bypasses; nested input snapshots; lease/CAS contention/lifetime; strict
malformed/private-file/byte bounds; and before/after-rename failure inspection
without automatic retries. Tests use explicit v5 storage fixtures only, not new OS/
worker/native proof producers.

Run `pnpm check` and the storage/registration/**pending-worker** test files together
at normal file concurrency, without changing existing deadlines. The extra pending
suite covers the new registration tag's immediate claim/read consumer. Reuse
unchanged observation-provider evidence. Return a scoped patch, complete source/test
snapshot, exact checks and limitations for independent review before further work.
No native/OS/PID queries, model/tool calls, nonzero process signaling, dependencies,
extra opt-in/witness, Pi changes, launch/RPC/public/index wiring or completed-retirement
transition. Existing fixture process cleanup remains allowed. Public R14, history/
cold resume, force recovery/destruction and all previous gates stay open.

### 2b9a.2c2 implementation received — historical review handoff

Author added only v5 retirement-intent parsing and `beginRetirementIntent` lease/CAS
storage in `managed-store.ts` and its tests. The ready → retiring record retains
connection/correlation and captures one operation/native snapshot; it is not a
verified idle/admission-seal, quiesce/exit or history-success fact. V4 production
creation and controls remain unchanged. No retired state or producer/public change.

Review target: `/tmp/minu-codex-2b9a2c2-source.sha256` relative to
`/tmp/minu-codex-approved-2b9a2c1.sha256`. Exact before-images:
`/tmp/minu-codex-2b9a2c2-baseline/packages/codex/`; patch:
`/tmp/minu-codex-2b9a2c2.diff`; author handoff:
`/tmp/minu-codex-2b9a2c2-handoff.md`.

Author typecheck and **198/198** storage/registration/pending-worker tests passed at
normal file concurrency, zero skips, unchanged deadlines. This includes 45 new
storage cases plus the previous 112 storage/registration and 41 pending-worker
cases. Log: `/tmp/minu-codex-2b9a2c2-storage-registration-pending.log`.

Coordinator `pnpm check` and **12/12** selected pending/bound round-trip/replay,
fenced admission/replay and retained read/list, ordinary-claim/pre-ready/native/
registration/enrollment rejection, nested snapshot, lease/CAS contention and
before/after-rename failure cases passed. Log:
`/tmp/minu-codex-2b9a2c2-coordinator-focused.log`. Complete submitted hashes match,
only the two allowed prior entries differ, there are no added/missing source/test
paths, the regenerated patch matches before-images exactly and tracked/scoped
whitespace checks pass. Artifacts:
`/tmp/minu-codex-2b9a2c2-coordinator-{hashes,whitespace}.log` and
`/tmp/minu-codex-2b9a2c2-coordinator.diff`. No coordinator source changes.

Request independent review only of this two-file increment, including untracked
content. Focus on strict v5-only intent fields/snapshot consistency, required
correlation and exact connection/operation matching, current CAS/fresh fences on
both recording/replay, immutable no-op replay, historical read/list plus allowed
fence updates, input snapshotting and atomic/private/byte-limit safeguards. Check
that the new tag is excluded from ordinary ready/reserved claim and pre-ready
cleanup authority, cannot advance native binding or re-enroll/register, and does
not change v4 defaults. Reuse prior approvals outside concrete interactions.

Native-quiesce/worker-exit facts, completed retirement, producer/seal-shutdown
integration, OS observation/final CAS, actual public suspension and durable history/
cold resume are still absent. Await a scoped verdict before advancing; all prior
Pi/startup/lifecycle/recovery/consumer/conformance/native gates remain open, with
no broad/full-workspace or real Codex/model/tool acceptance claimed.

### 2b9a.2c2 independent approval — retirement-intent storage only

The independent verifier approved **2b9a.2c2 only**, with no actionable findings.
Independent typecheck, **198/198** affected tests at normal concurrency, a lazy-
actor/ordinary-consumer fencing probe, approved baseline/complete snapshot/exact
patch and scoped whitespace checks passed. Evidence:
`/tmp/codex-verifier-2b9a2c2-{typecheck,affected,consumer,final-hashes}.log` and
`/tmp/codex-verifier-2b9a2c2-consumer.test.mjs`.

The coordinator matched and recorded `/tmp/minu-codex-approved-2b9a2c2.sha256`,
identical to `/tmp/minu-codex-2b9a2c2-source.sha256`; check:
`/tmp/minu-codex-approved-2b9a2c2-check.log`. No source edits or new test cycle
accompany this receipt. Intent correlation/snapshots, fresh CAS/replay authority,
historical reads, ordinary-path rejection and inspectable publication uncertainty
are approved storage properties—not proof of idle admission, sealing or exit.
All existing Pi/startup/lifecycle/history/recovery/consumer/conformance/native gates
stay open; no broad/full-workspace or real Codex/model/tool acceptance is claimed.

### 2b9a.2c3 implementation handoff — remaining retirement-fact storage/CAS only

Complete the private storage sequence in the same two files:
`packages/codex/src/managed-store.ts` and `packages/codex/test/managed-store.test.ts`.
Baseline: `/tmp/minu-codex-approved-2b9a2c2.sha256`; before-images:
`/tmp/minu-codex-2b9a2c3-baseline/packages/codex/`; hash preflight:
`/tmp/minu-codex-2b9a2c3-baseline.log`. Keep v4 reads/control/default creation
unchanged, no migration or production producers. Flag concrete extra-file needs
before expanding scope.

**Strict private data and operations:**

- Keep `retirement` itself the immutable two-field operation/native intent.
  V5 `retiring` may additionally hold an optional `nativeQuiesce` fact, exactly
  `{ kind: never_started }` for the captured pending native binding or
  `{ kind: owned_exit }` for the captured bound binding. The fact inherits the
  exact original connection/operation/native correlation; a lease record operation
  must also receive that expected connection and intent. Creating/uncertain native
  material, mismatched kinds, booleans and extra fields cannot be recorded.
- A native-fact record is immutable and can be added only to matching retiring
  material. Current revision, exact addressed identity/full connection/claim,
  matching root/registration generation, clear explicit-resume fence, required
  process-domain correlation and exact intent/native binding are mandatory even
  for identical no-op replay. Stage-regressing mutation from retired is ineligible.
- Add strict v5 `retired` registration retaining the original connection, claim,
  generation, intent and processDomain, with required `nativeQuiesce` plus required
  `workerAbsence` exactly `{ pid, domain, result: pid_absent }`. Require a valid
  positive signed-pid_t-range PID equal to the recorded connection and normalized
  domain observations equal to the unchanged launcher/worker domain. Reject
  occupied/unconfirmed results, missing/native-inconsistent facts, wrong targets,
  mismatched domains, partial records, extra fields and v4 use of these forms.
- A finalization lease/CAS operation accepts the expected full connection/intent
  and asserted absence data. Only matching retiring material with native fact
  present can transition to retired. Recheck all fresh authority/native/correlation
  guards and current revision. Exactly matching already-retired data may return
  unchanged after those checks, with no revision increment/rename; conflicts cannot
  replace facts or retarget the original operation. No stale-revision recovery.
- Snapshot all nested inputs before awaits; reuse existing lease serialization,
  private bounded atomic storage and strict validators. Historical fact/retired
  records stay readable/listable after generation/explicit-resume fencing, while
  new/cached mutations reject. Such fence updates must still work. No native-binding,
  registration/enrollment, ordinary claim or pre-ready cleanup path may bypass
  retiring **or retired** state; preserve existing ready/reserved authorization.

**Meaning and scope:** storage checks asserted fact structure/correlation, not
physical truth or producer authorization. Native facts become trustworthy only
when later authenticated workers confirm their owned native child exited (or was
never allocated), after busy-safe sealing/intent publication. A later controller
must inspect the same operation/native fact before a fresh approved PID observation,
then revalidate exact authority/revision before final CAS. No endpoint/registry
absence, persisted PID, bare boolean or caller summary substitutes for that workflow.
A private retired record is not public suspended/resumable state, descendant/group
exit, flushed history or permission to reset claims, clear fences, replace or replay.

No OS/PID/native calls in storage, runtime observer imports, producer/seal-shutdown
seam, launcher/RPC/public/index wiring, new flags/witness/dependencies/framework,
Pi changes or production v5 creation. These remain later checkpoints.

**Verification:** test pending/bound native-fact and full retirement round trips;
unsupported/missing/mismatched facts/results/target/domain/operation/connection;
stale revision and persisted fences for new/cached writes; no-rename idempotence
and immutable conflicts; expected-input mutation across awaits; stage-regressing
and ordinary/native/registration/cleanup bypass rejection; historical read/list and
fence updates; private-file/byte bounds; lease/CAS contention/lifetime; and before/
after-rename uncertainty for both fact and finalization with no retries. Preserve
all existing v4/v5/intents tests and use synthetic asserted facts, not new OS probes.

Run `pnpm check` plus the storage/registration/pending-worker test files together
at normal file concurrency with existing deadlines. Reuse unchanged OS-provider
approvals. Return a scoped patch, complete snapshot, exact checks and limits for
independent review before integration. Existing controlled fixture cleanup remains
allowed; no real Codex/model/tool calls or broad workspace cycle. All outstanding
public lifecycle/history/recovery/integration/acceptance gates remain open.

### 2b9a.2c3 implementation received — historical review handoff

Author added only private native-quiesce assertion storage, strict retired records
and finalization CAS in `managed-store.ts` and its tests. Intent remains immutable;
asserted native kinds must match the captured pending/bound binding, and finalized
records require matching original connection/operation/native plus PID/domain/
`pid_absent` data. The operations do not collect or authenticate physical facts.
V4 production defaults/control stay unchanged; no OS/producer/public integration.

Review target: `/tmp/minu-codex-2b9a2c3-source.sha256` relative to
`/tmp/minu-codex-approved-2b9a2c2.sha256`. Before-images:
`/tmp/minu-codex-2b9a2c3-baseline/packages/codex/`; patch:
`/tmp/minu-codex-2b9a2c3.diff`; author handoff:
`/tmp/minu-codex-2b9a2c3-handoff.md`.

Author typecheck and **254/254** storage/registration/pending-worker tests passed
at normal concurrency, zero skips and unchanged deadlines, including 56 added
storage cases. Log: `/tmp/minu-codex-2b9a2c3-storage-registration-pending.log`.
Coordinator typecheck and **28/28** selected native-kind/absence mismatches,
round-trip/idempotence, exact connection/operation/native matching, fenced historical
read/fresh/cached mutation, missing-native/stage checks, retired bypass rejection,
input snapshot, lease/CAS contention and before/after-rename publication cases
passed. Log: `/tmp/minu-codex-2b9a2c3-coordinator-focused.log`.

Complete submitted hashes match; only the two allowed prior entries differ, there
are no added/missing source/test paths, the patch exactly matches before-images
and tracked/scoped whitespace checks pass. Artifacts:
`/tmp/minu-codex-2b9a2c3-coordinator-{hashes,whitespace}.log` and
`/tmp/minu-codex-2b9a2c3-coordinator.diff`. No coordinator source edits.

Request independent review only of this two-file increment, including untracked
content. Focus on strict stage-specific schemas/native kinds, native-fact prerequisite
and exact original target/domain/connection/operation/native correlation, current
revision/fresh authority before writes or replay, immutable no-op facts, historical
reads/fence updates, rejected stage regression/claim/native/registration/cleanup
bypasses and private/atomic/byte safeguards. Reuse prior approvals unless a concrete
interaction requires inspection. Explicitly distinguish asserted storage data from
truth established by future authenticated producers/observation workflows.

No real idle/seal/shutdown/worker/group verification, producer/seal seam, launcher/
RPC/public wiring or native-history/resume acceptance is implemented here. Require
a scoped verdict before advancing; all prior Pi/startup/lifecycle/recovery/consumer/
conformance/native gates stay open. No broad/full-workspace or real Codex/model/tool
run is claimed.

### 2b9a.2c3 independent approval — retirement-assertion storage/CAS only

The independent verifier approved **2b9a.2c3 only**, with no actionable findings.
Independent typecheck, **254/254** affected tests at normal concurrency, a synthetic-
retirement consumer-boundary probe, approved baseline/complete snapshot/exact patch
and scoped whitespace checks passed. Evidence:
`/tmp/codex-verifier-2b9a2c3-{typecheck,affected,consumer,final-hashes}.log` and
`/tmp/codex-verifier-2b9a2c3-consumer.test.mjs`. The probe deliberately stores
synthetic assertions, then checks that ordinary consumers cannot allocate, mutate,
resume or expose private evidence; inventory remains unavailable rather than
suspended. It does not establish physical shutdown or worker absence.

The coordinator matched and recorded `/tmp/minu-codex-approved-2b9a2c3.sha256`,
identical to `/tmp/minu-codex-2b9a2c3-source.sha256`; check:
`/tmp/minu-codex-approved-2b9a2c3-check.log`. No source edits or new test cycle
accompany this receipt. Strict schemas, exact native/operation/connection/PID/domain
correlation, native-assertion prerequisites, fresh CAS/replay authority, immutable
facts, historical reads, ordinary-path rejection and inspectable publication
uncertainty are approved storage properties only. Producer authentication, idle/
seal/shutdown/exit truth, group exit, public suspension and history/cold resume
remain unverified. All existing Pi/startup/lifecycle/recovery/consumer/conformance/
native gates stay open; no broad/full-workspace or real model/tool run is claimed.

The matrix's stale final-checklist exclusion of R42–R44 is corrected to the existing
44-required-items agreement; native-first/later-phase delivery sequencing remains
unchanged. This is documentation correction, not new implementation scope.

### 2b9a.2d proposal handoff — historical read-only scope

Request a short read-only proposal for the smallest pending-worker seam needed
between idle/admission sealing and native shutdown. Current `quiesceIdle` couples
them; recording intent afterward cannot establish the required ordering. Inspect
`pending-worker.ts` and its tests, with storage/authority consumers only as needed.
Prefer the existing worker/test files; identify concrete dependencies before any
scope expansion. No source edits, tests, process probes or implementation yet.

Specify the exact internal API/file changes and focused test map. Show how a later
producer can commit one intent under fresh locked authority immediately after
busy-safe sealing, before any shutdown starts; release the lock before awaiting
shutdown. Explain busy rejection without seal/publication/stop effects, authority
checks after status awaits, callback/publication failure and unknown-outcome
handling with admission kept closed once sealed, and duplicate-operation/shutdown
handling. Preserve current `quiesceIdle` behavior, v4 defaults and ordinary claim/
input fencing; do not broaden ready/reserved admission to retiring/retired. Address
where exact retirement-operation authority would belong once intent changes the
registration state, without implementing the producer in this proposal.

Keep independent launch-domain collection/authentication, actual native-fact
publication, worker-exit observation/final CAS workflows, production v5 creation,
RPC/public suspension/history/resume, recovery, migration, witness/flags/framework/
dependencies and Pi changes out of this checkpoint. Return the proposal against
`/tmp/minu-codex-approved-2b9a2c3.sha256` for scoping before implementation.

### 2b9a.2d implementation handoff — internal seal/intent/shutdown seam only

The coordinator accepts the two-file callback-seam approach, with the bounded
publication-capability refinement below. This authorizes implementation, not
acceptance of code or public suspension. Only change:
`packages/codex/src/pending-worker.ts` and
`packages/codex/test/pending-worker.test.ts`.

Approved baseline: `/tmp/minu-codex-approved-2b9a2c3.sha256`; saved before-images:
`/tmp/minu-codex-2b9a2d-baseline/packages/codex/`; preflight:
`/tmp/minu-codex-2b9a2d-baseline.log`. Approved hashes and both before-images match.
No tests, process probes or source edits accompanied this scoping decision.

**Internal API and publication capability:**

Expose `quiesceIdleWithIntent(id, operationId, publishIntent)` only in
`openPendingCodexWorker`'s internal return type, not `CodexWorkerRuntime`, RPC or
package/public exports. Require current correlated v5 ready material, exact owned
claim/allocation and eligible pending or exact bound native binding. Validate the
operation ID and callback before sealing; keep v4 defaults and ordinary
`quiesceIdle` behavior unchanged.

Refine the proposal's callback context from an unrestricted lease to
`{ current, intent, commitIntent }`. `commitIntent()` is a bound, one-publication
capability using the existing lease's `beginRetirementIntent`, with the captured
current revision, full original connection and immutable operation/native snapshot.
It cannot retarget or perform unrelated lease mutations. No nested session locks.
Give the callback detached copies of metadata; retain separate private snapshots
for authority validation so callback mutation cannot rewrite the expected target.
The concrete `commitIntent` return type may reuse `CodexManagedManifest`.

Close the publication capability when the callback settles; reject later use and
never repeat its storage mutation. Track/settle any commit it already started
before final readback, even if the callback failed to await it. Reason: the store
lease drains pending mutations during lock release; an unrestricted or undrained
publisher could otherwise change authority after the worker's readback. Use a
small local closure, not a new generic lease/event/supervisor framework or a store
change. A callback success without the exact committed intent is insufficient.

**Ordering, authority and races:**

1. Reject active/preparing/busy/uncertain work before seal, callback, publication
   or stop side effects. Under the session lock validate fresh ordinary authority
   and idle eligibility. After native-status awaits reread authority and recheck
   local activity/native identity; reject non-idle status.
2. Synchronously seal admission after the final idle check, without an intervening
   await. Keep a private operation seal distinct from started shutdown. Input and
   dispatch admission must honor it after their awaits; status must not continue
   advertising idle admission while sealed. Preserve retained-result behavior of
   the existing quiesce path without authorizing new execution.
3. Invoke the publisher under that same lock. After successful callback and fully
   settled commit, reread persisted material and require exact v5 retiring intent,
   original owner/session/generation/full connection/claim/domain/native binding
   and clear explicit-resume fence. Do not treat a callback return as evidence.
4. Box only the shutdown authorization, release the session lock completely, then
   start and await the existing owned-native shutdown path exactly once outside
   it. Reuse shutdown/forwarding cleanup; avoid self-joining the operation promise
   when ordinary `stop` is redirected to the sealed result.

Ordinary stop winning before seal retains its existing behavior; the new path
rejects without intent publication. After seal, ordinary stop joins the controlled
result and cannot bypass publication. Ordinary quiesce cannot infer its own idle
success from an intent seal. Same-operation calls never repeat callback, commit or
shutdown; different operations reject. Cached success still requires fresh exact
operation authority. Guard failures override cached success, and failed/uncertain
operations remain terminal rejection even if later read-only inspection finds the
intent. Do not reopen admission, auto-continue shutdown or generate a new operation.

Keep retirement authority private to the exact locally sealed operation: validate
fresh matching retiring, not retired, material. Never widen `current()`, ordinary
ready/reserved claims, input, forwarding or RPC authorization to retirement states.
Callback failure before/after write, uncertain publication, wrong readback, fencing
or shutdown failure cannot become success. Once sealed, keep admission closed;
failed publication/readback must not initiate native shutdown.

**Verification and limits:**

Cover pending/bound success with intent visible before the first stop and lock
released at stop start; input/seal winners and active/preparing/native-busy cases;
stop before/during sealing/publication; same/different operations and shared shutdown
success/failure; no self-join/deadlock; fresh cached-result fencing; status-await and
publication authority/native changes; callback failure before/after commit; missing/
mismatched readback; callback metadata mutation; unawaited commit settlement and
retained-capability rejection. Assert no premature shutdown, duplicate publication,
automatic continuation/retry, new input allocation/dispatch or reopened admission.
Preserve all 41 prior pending-worker cases and ordinary retirement-stage rejection.
Existing owned-fixture cleanup remains allowed; keep fixture gates/cleanup bounded.

Run `pnpm check` plus storage/registration/pending-worker test files together at
normal file concurrency with unchanged deadlines. Reuse unchanged OS-provider
approval. Return the exact two-file patch against saved before-images, complete
source/test/fixture snapshot, checks, initial failures if any and limitations for
independent scoped review before any next implementation. Raise concrete extra-file
needs before expanding scope.

No production caller/RPC/launcher/public/index wiring, production v5 creation or
legacy enrollment, independent domain collection/authentication, native-fact
publication, worker exit/absence/finalization workflow, history/cold resume, force
recovery/replacement, witness/opt-in/dependency/framework or Pi change. Deterministic
owned native fixtures are allowed; no real Codex/model/tool calls or broad workspace
cycle. R14/all public lifecycle and existing integration/acceptance gates stay open.

### 2b9a.2d implementation received — historical review handoff

Author added the internal `quiesceIdleWithIntent` seam, local retirement seal,
bound one-use intent capability and private operation-specific authority checks in
`pending-worker.ts`, with tests only in `pending-worker.test.ts`. Callback metadata
is detached, started commits drain before readback even after callback failure,
and uncertainty cannot be swallowed into success. The existing owned shutdown
cleanup is reused only after full lock release; ordinary stop joins without
self-joining, and ordinary ready/reserved authorization is unchanged.

Review target: `/tmp/minu-codex-2b9a2d-source.sha256` relative to
`/tmp/minu-codex-approved-2b9a2c3.sha256`. Before-images:
`/tmp/minu-codex-2b9a2d-baseline/packages/codex/`; exact patch:
`/tmp/minu-codex-2b9a2d.diff`; author handoff:
`/tmp/minu-codex-2b9a2d-handoff.md`.

Author typecheck and **295/295** storage/registration/pending-worker tests passed
at normal file concurrency, zero skips and unchanged deadlines. This includes all
41 prior pending-worker tests and 41 new seam cases. Log:
`/tmp/minu-codex-2b9a2d-storage-registration-pending.log`. The handoff records an
initial TS7006 pair on rename-mock parameters, corrected with explicit parameter
types; final typecheck/uncertainty cases pass. No author runtime test failure is
reported; earlier unrelated/unclassified gates are not erased by this pass.

Coordinator typecheck and **26/26** selected pending/bound intent-before-stop and
lock-release-at-stop, metadata/capability isolation, unawaited-commit draining,
before/after-rename uncertainty, missing/before/after-write callback failures,
shared shutdown success/failure, blocked-publication stop/input races, input/seal
winners, fresh authority after status awaits, cached success fencing and the prior
ordinary-stop/status race passed. Logs:
`/tmp/minu-codex-2b9a2d-coordinator-{typecheck,focused}.log`.

Complete submitted hashes match; only the two authorized approved entries differ,
with no new/missing source/test paths. Exact regenerated patch and tracked/scoped
whitespace checks pass. Artifacts:
`/tmp/minu-codex-2b9a2d-coordinator-{hashes,whitespace}.log` and
`/tmp/minu-codex-2b9a2d-coordinator.diff`. No coordinator source changes.

Request independent review of this two-file increment including untracked content.
Focus on busy-safe seal/intent ordering, fixed-target capability lifetime and
commit draining (including swallowed errors), detached expected authority, fresh
exact retiring-only checks after awaits and before replay, ordinary admission/
claim rejection, stop/duplicate/no-self-join races, lock release before starting
native shutdown and fail-closed uncertainty without automatic continuation. Reuse
prior approved storage/OS evidence outside concrete interactions.

Production v4 creation/callers, RPC/index/launcher and public lifecycle are unchanged.
There is no authenticated independent domain producer, native-fact publication,
worker-exit observation/final CAS workflow or public suspended/resumable/history
claim. Await a scoped verdict before advancing; all existing Pi/startup/lifecycle/
recovery/consumer/conformance/native acceptance gates stay open. No broad/full-
workspace or real Codex/model/tool run is claimed.

### 2b9a.2d independent approval — internal seal/intent/shutdown seam only

The independent verifier approved **2b9a.2d only**, with no actionable findings.
Independent typecheck, **295/295** affected tests at normal concurrency, **2/2**
additional capability/lock-return probes, approved baseline/complete snapshot/exact
patch and scoped whitespace checks passed. Evidence:
`/tmp/codex-verifier-2b9a2d-{typecheck,affected,seam,final-hashes}.log` and
`/tmp/codex-verifier-2b9a2d-seam.test.mjs`. The probes check that commit acknowledgment
mutation cannot retarget private authority, duplicates/stop cannot start shutdown
before the lock wrapper fully returns, and a retained never-used capability cannot
recover a failed seal after callback settlement.

The coordinator matched and recorded `/tmp/minu-codex-approved-2b9a2d.sha256`,
identical to `/tmp/minu-codex-2b9a2d-source.sha256`; check:
`/tmp/minu-codex-approved-2b9a2d-check.log`. No source edits or new test cycle
accompany this receipt. Capability isolation/lifetime and commit drain, exact
readback/authority, once-only shutdown outside the lock, joined stop/duplicates
and fail-closed uncertainty are approved internal seam properties only.

Production v4 defaults, callers, RPC/index/launcher and ordinary claim rules remain
unchanged. Independent authenticated domain production, native-fact publication,
worker/group exit, public suspension, history/cold resume and replacement/replay
eligibility remain unverified. All existing Pi/startup/lifecycle/recovery/consumer/
conformance/native gates stay open; no broad/workspace or real model/tool acceptance
is claimed.

### 2b9a.2e proposal handoff — historical read-only scope

Request a short read-only proposal for independent launcher/worker Darwin-domain
collection and authenticated correlation to the actual launched child and exact
ready connection. The approved storage/seam still has only synthetic correlation
in tests; real provenance is a prerequisite for the later absence-proof workflow.
Use `/tmp/minu-codex-approved-2b9a2d.sha256` as the baseline. No edits, tests, new
process/OS probes or implementation are authorized by this proposal request.

Define the smallest independently reviewable first increment, exact API/message/
file changes and focused test map. Prefer existing launch/registration/IPC patterns;
justify new files or fixtures and split larger integration before implementation.
Show how each process obtains its own fresh observation from the approved collector
rather than echoing/inheriting the peer's observation. Bind reports to the actual
forked child PID, owner/session/generation/claim and complete authenticated ready
connection, with fresh locked CAS checks around asynchronous collection/registration.
Keep host/boot values and raw diagnostics private/redacted.

Explain collector unavailability/mismatch, stale/fenced authority, registration
races, lost acknowledgments and parent/child loss. Preserve durable registration,
exact-worker adoption and mutually exclusive pre-ready cleanup/abort authority; no
automatic replay/replacement or new authority from endpoint/registry disappearance.
Keep v4 production defaults/read/control and legacy workers unchanged, with no
silent enrollment/migration. State explicitly which portion can remain private/
unwired on explicit v5 fixtures and what later production-version decision is needed.

Reuse the owner's existing local-host assumption with no Codex-only opt-in or
witness; matching observations are not deployment/namespace attestation or worker
exit. No sandbox-policy changes. Native-fact publication, shutdown/worker-exit/
absence/finalization workflows, public suspension/history/resume, recovery, native
binding changes, defaults/flags/framework/dependencies and Pi changes remain outside
this proposal checkpoint. Return the bounded proposal for scoping before any code.

### 2b9a.2e implementation handoff — explicit-v5 launch-domain correlation only

The coordinator accepts one coherent five-file launch/registration increment:
- `packages/codex/src/managed-worker.ts`
- `packages/codex/src/owned-worker.ts`
- `packages/codex/test/managed-worker.test.ts`
- `packages/codex/test/fixtures/registration-controller.ts`
- `packages/codex/test/fixtures/registration-worker-fault.ts`

Approved baseline: `/tmp/minu-codex-approved-2b9a2d.sha256`; before-images:
`/tmp/minu-codex-2b9a2e-baseline/packages/codex/`; preflight:
`/tmp/minu-codex-2b9a2e-baseline.log`. All approved hashes and five before-images
match. Scoping used source/test inspection only; no source edits, tests or OS/
process probes were run. Extra-file needs require a concrete explanation before
expanding scope. No new production API, configuration flag, helper framework or
permanent fixture is approved.

**Eligibility and independent observations:**

Keep all production creation at v4. The new private branch is selected solely by
explicit, eligible v5 manifest material, not a test flag or pathname. Existing v4
and eager/unregistered launch/read/control behavior and message shape stay unchanged
and must perform no domain collection/enrollment. Already-ready reconnect, including
uncorrelated v5, stays authentication-only with no collection, repair or enrollment.

For a fresh v5 none/pending candidate, capture private inputs/revision under fresh
owner/session/generation/fence/eligibility checks, then collect the launcher's own
observation with the approved collector outside the session lock. If unavailable,
fail before reservation/fork without mutation. Reacquire the lock, revalidate the
captured revision and all authority/eligibility before reservation, fork and PID
publication. If a concurrent winner is already ready, use ordinary authenticated
reconnect without applying the unused observation; other reserved/uncertain changes
cannot authorize another launch. Preserve one-shot allocation and saved launch policy.

The worker must independently collect from its own OS after validating eligible
v5 reserved identity/claim/actual PID, outside the session lock. Never send the
launcher's observation to the worker or accept values from launch/native options,
argv, environment or a caller-supplied observation as provenance. Revalidate fresh
reserved authority and captured revision/fences after collection under the existing
readiness publication lock. Unavailable collection fails before readiness and uses
only existing pre-ready abort/cleanup arbitration; no weaker cleanup path.

**Private report and CAS:**

For v5 only, extend the child's private IPC ready envelope to
`{ type: ready, connection, processDomain: workerObservation }`. The observation is
the exact bounded normalized two-UUID shape, not the manifest's larger correlation
record. Keep the v4 envelope unchanged. Snapshot/validate the complete report and
private expectations before asynchronous authentication; no mutable message alias
may retarget the expected identity, connection or observations.

Accept only the report on the retained child IPC channel with PID equal to the
actual forked child, exact owner/session/generation/claim and complete connection
matching durable readiness plus existing authenticated endpoint verification.
Require valid matching launcher/worker observations. Under a fresh session lock,
revalidate the complete current ready registration/fences/connection and use the
current revision with existing `recordProcessDomain` exactly once. Preserve native
binding and other launch policy, including work independently adopted meanwhile.
Keep observations/raw diagnostics private and errors generic without raw causes.

Readiness remains independently authoritative for adoption, not revocable by a
correlation failure. Missing/malformed/mismatched reports, failed authentication,
parent/child loss, acknowledgment loss, correlation errors before/after publication
or unknown outcomes must preserve a ready/possibly-published worker and inspectable
old/new correlation. No retry, late repair/enrollment, replacement, claim reset,
fence clearing or teardown from IPC silence/endpoint failure. Existing shared
locked revision-checked pre-ready abort authority alone may authorize cleanup of
the actual spawned child; original ready/adopted work must survive. A v5 ready worker
without correlation remains controllable but ineligible for provenance-dependent
retirement. Do not infer native/worker/group exit or public suspension.

**Test boundary, verification and limits:**

Use only existing test/fixture boundary controls (for example builtin execFile/FS
interception before module import, as existing tests do), delegating unrelated calls.
Do not add production hooks, provider arguments/overrides, environment knobs or
configurable OS command paths. Counter/mismatch controls must be independent in
launcher and worker and must not travel as provenance on the real launch message.
Reuse existing gates and exact owned-fixture cleanup; no new broader signaling.

Cover independent queries/no inheritance; exact child/full connection/observations;
unavailable/malformed/mismatched inputs; query/authentication revision and fence
races; concurrent launch; reservation/readiness/cleanup arbitration; lost IPC/parent/
child; no collection/enrollment on reconnect or v4/unregistered paths; and before/
after correlation publication uncertainty with no retries. Include a controlled
v5 adoption-before-correlation-failure case retaining actual dispatched fixture
work and matching retries, not merely an alive empty worker. Preserve original
adoption/abort and unclassified-failure evidence.

On the supported Darwin host, include one unmocked new v5 launcher/owned-worker
collection/correlation round trip, with private values redacted even on assertion
failure. It may stop the exact idle fixture by normal authenticated RPC; do not
allocate a real Codex/model/tool session. On other hosts, record the unsupported
result and do not claim real Darwin wiring acceptance. Reuse OS-source/provider
validation rather than rerunning unchanged collector/absence suites.

Focused checks while building. At completion run `pnpm check` plus storage,
registration, pending-worker, worker-bridge and public managed-runtime test files
together at normal file concurrency. The two additional suites cover the shared
owned-worker eager/unregistered entry and existing public v4 managed launch/control
consumers. Keep existing query/startup/test bounds; do not extend deadlines or
serialize files. Preserve/classify any initial failure; later greens do not erase
unexplained startup/Pi gates. Return exact five-file patch against before-images,
complete source/test/fixture snapshot, observed checks and limitations for independent
scoped review before advancing.

No production v5 creation/version-default decision or silent legacy enrollment;
unsupported-platform/failure policy for that future switch needs separate review.
No native-fact publication, retirement shutdown/absence/finalization workflow, public
suspension/history/resume, recovery, native-binding changes, witness/opt-in, new
framework/dependency or Pi change. The accepted Runtime local-host assumption and
Codex sandbox policy are unchanged; UUID equality is not deployment/namespace
attestation or worker-exit proof. All prior public lifecycle/native/history/
conformance/integration gates remain open; all 44 requirements remain required.

### 2b9a.2e implementation received — historical review handoff

Author added independent approved-collector calls to the explicit-v5 launcher and
owned-worker paths, a private worker-observation ready report and authenticated
full-connection/actual-child correlation followed by fresh locked `recordProcessDomain`.
Only the five authorized source/test/fixture files changed. V4/eager/unregistered
and already-ready reconnect paths remain unenrolled; production creation stays v4.
No new production override/provider argument/flag or configurable OS command path.

Review target: `/tmp/minu-codex-2b9a2e-source.sha256` relative to
`/tmp/minu-codex-approved-2b9a2d.sha256`. Before-images:
`/tmp/minu-codex-2b9a2e-baseline/packages/codex/`; exact patch:
`/tmp/minu-codex-2b9a2e.diff`; author handoff:
`/tmp/minu-codex-2b9a2e-handoff.md`.

Author typecheck and **395/395** storage/registration/pending-worker/worker-bridge/
public-managed-runtime tests passed at normal file concurrency, zero skips and
unchanged deadlines. This includes 40 new registration cases. Log:
`/tmp/minu-codex-2b9a2e-affected.log`. The redacted unmocked Darwin launcher/worker
round trip passed in that run, with no native app-server/thread/model/tool allocation
and normal authenticated fixture cleanup. The handoff reports no initial test or
typecheck failures; earlier unrelated/unclassified startup/Pi gates remain unresolved.

Coordinator typecheck and **28/28** selected independent/exact-child correlation,
redacted unmocked Darwin wiring, unavailable/malformed collection, v4 no-query/
enrollment behavior, parent/worker collection revision/generation/explicit fences,
concurrent ready/reservation winners, authentication fencing, report PID/token/
domain mismatch, before/after correlation publication uncertainty, parent/worker
loss, all three adopted-work correlation success/failure/parent-loss cases and the
three original v4 adoption-before-IPC failure cases passed. Zero skips. Logs:
`/tmp/minu-codex-2b9a2e-coordinator-{typecheck,focused}.log`.

Complete submitted hashes match; only the five authorized approved entries differ,
with no added/missing source/test paths. Regenerated five-file patch exactly matches
before-images and tracked/scoped whitespace checks pass. Artifacts:
`/tmp/minu-codex-2b9a2e-coordinator-{hashes,whitespace}.log` and
`/tmp/minu-codex-2b9a2e-coordinator.diff`. No coordinator source changes.

Request independent review of only this five-file increment, including untracked
content. Focus on each process's actual independent OS-source invocation outside
the lock, no inherited/caller provenance or production test overrides, input/report
snapshots, strict normalized/private observation fields, actual retained-child PID
and complete authenticated connection, fresh query/readiness/auth/CAS fences and
single immutable correlation publication. Check that every pre/post-publication
failure and acknowledgment/parent/child loss preserves durable ready/adopted work
unless existing locked pre-ready abort authority wins; no teardown from IPC silence,
repair/enrollment on reconnect, or replacement/replay. Inspect fixture controls and
redaction, and reuse unchanged provider/storage approvals outside concrete interactions.

These are private correlation guarantees under the accepted local-host assumption,
not deployment/namespace attestation, native/worker/group exit, public suspension,
resumability or history preservation. No production-v5/default/migration switch or
native-fact/retirement/absence/final-CAS workflow. Await a scoped verdict before
advancing; all existing lifecycle/recovery/native/conformance/integration gates
remain open. No full-workspace or real Codex/model/tool acceptance is claimed.

### 2b9a.2e independent approval — explicit-v5 launch-domain correlation only

The independent verifier approved **2b9a.2e only**, with no actionable findings.
Independent typecheck, **395/395** affected tests at normal file concurrency/zero
skips, the redacted unmocked Darwin launcher/worker round trip, approved baseline/
complete snapshot/exact patch and scoped whitespace checks passed. Evidence:
`/tmp/codex-verifier-2b9a2e-{typecheck,affected,final-hashes}.log`. The actual Darwin
case used normal authenticated idle fixture cleanup, with no native app-server/
thread/model/tool allocation or identifier disclosure.

The coordinator matched and recorded `/tmp/minu-codex-approved-2b9a2e.sha256`,
identical to `/tmp/minu-codex-2b9a2e-source.sha256`; check:
`/tmp/minu-codex-approved-2b9a2e-check.log`. No source edits or new test cycle
accompany this receipt. Independent observations bound to the actual forked child
and complete authenticated connection, fresh CAS preserving native/adopted work,
ready-worker preservation on correlation failure and unenrolled v4/reconnect paths
are approved private registration properties under the accepted local-host assumption.

This is not deployment/PID-namespace attestation or native/worker/group exit proof.
Production v5 creation and its unsupported-platform/failure policy, native-fact
publication, retirement/absence/finalization workflows, public suspension/history/
cold resume and replacement/replay eligibility remain unfinished. All prior Pi/
startup/lifecycle/recovery/consumer/conformance/native/integration gates stay open;
no full-workspace or real-native/model/tool acceptance is claimed. All 44 items
remain required.

### 2b9a.2f proposal handoff — historical read-only scope

Request a short read-only proposal for the smallest worker-local producer of the
existing immutable `nativeQuiesce` assertion after the approved idle seal/intent/
owned-native shutdown sequence. Baseline:
`/tmp/minu-codex-approved-2b9a2e.sha256`. Prefer `pending-worker.ts` and its tests;
identify concrete dependencies before expanding scope. No source edits, tests or
OS/process probes are authorized by this proposal request.

Define the exact internal API/file changes, operation-specific authority and test
map. Derive `never_started` only from the exact captured pending/no-allocation
identity, or `owned_exit` only from confirmed shutdown of that worker's exact
owned bound allocation. Neither caller-supplied facts/booleans, ordinary stop,
endpoint/deregistration evidence nor a reconstructed cached result establishes this
truth. Do not widen ordinary ready/reserved claim, input, forwarding or RPC authority.

Show how fresh locked owner/session/generation/fence/full connection/domain/native/
operation checks and current-revision CAS govern fact publication and cached
outcomes. Preserve native binding and intent, admission sealing, once-only shutdown
and existing quiesce behavior. Distinguish the quiesce/shutdown outcome from fact-
publication completion so failure/uncertainty cannot be mistaken for producer success.
Explain concurrent/duplicate calls, authority change after shutdown, publication
before/after-rename uncertainty, retained capabilities and crash/loss windows.
Keep admission closed and outcomes inspectable, with no automatic retry, new
operation, reopening, replacement or replay after uncertainty.

Identify the later controlled-worker-exit boundary that must await successful fact
publication, without implementing worker-exit or finalization orchestration here.
Native exit, including forced native exit, still does not establish durable history,
flushed transcript, descendant/group exit or public suspended/resumable state.
Reuse approved storage/correlation/collector evidence; propose focused deterministic
owned-fixture checks and only the affected integration suites.

Keep production-v5/default/migration policy, new launch/RPC/public/index wiring,
OS/PID absence observation, worker-exit/final-CAS workflows, public suspension,
history/cold resume, recovery, witness/opt-in, new dependency/framework and Pi changes
out of this proposal checkpoint. Return the bounded design for scoping before code.

### 2b9a.2f implementation handoff — worker-local owned-native fact producer only

Accept the two-file producer proposal. Only change:
`packages/codex/src/pending-worker.ts` and
`packages/codex/test/pending-worker.test.ts`.
Baseline: `/tmp/minu-codex-approved-2b9a2e.sha256`; before-images:
`/tmp/minu-codex-2b9a2f-baseline/packages/codex/`; preflight:
`/tmp/minu-codex-2b9a2f-baseline.log`. Approved hashes and both before-images match.
Scoping used inspection only, with no source edits, tests or process/OS probes.
Concrete extra-file needs require explanation before expanding scope.

**Evidence and internal API:**

Add `quiesceIdleWithNativeFact(id, operationId, publishIntent): Promise<void>` only
to `openPendingCodexWorker`'s internal return type. Reuse approved intent/admission/
shutdown behavior and the bounded intent-publication capability; accept no native
fact, success boolean, process handle or alternate allocation from the caller.
Preserve v4 defaults and existing quiesce/stop semantics and ordinary claim rules.

Capture the native binding and exact owned allocation/runtime/session/thread tuple
privately at the original successful seal, not from metadata or mutable allocation
state fetched after shutdown. Derive local evidence only on successful completion
of that sealed operation's shutdown of its exact capture. Pending/no-allocation
with no preparation or cleanup-only uncertainty permits `never_started`; bound
material permits `owned_exit` only for the retained matching owned allocation.
A resolved allocating promise after a completed bound turn is not pending work.
Ordinary stop/quiesce, cleanup-only handles, creating/unowned material, persisted
assertions or reconstructed cached success must not mint evidence. Keep evidence
private and unforgeable through the callback-visible metadata/capability.

The coordinator inspected the existing native chain: allocation constructs its own
`CodexAgentRuntime`; `client.stop` addresses a retained session and awaits
`session.rpc.stop`; `rpc.shutdown` awaits its retained child exit and rejects if
exit remains unconfirmed. The process error handler marks exit only without a PID;
bound startup cannot rely on that no-spawn path. No client/RPC edits or extra PID/
OS observer are needed for the scoped producer. This is owned native-child exit,
not graceful history flushing, descendant/group exit or worker-process exit.

**Separate outcomes, fresh publication and duplicates:**

Keep native shutdown result and native-fact publication result distinct on the
private local operation. Publication success means both succeeded; a publication
failure cannot rewrite confirmed shutdown, and ordinary shutdown success is not
producer completion. A producer may use evidence already minted by the same exact
qualified local intent seal, but may never reconstruct it from an arbitrary cached
stop result or stored fact.

After confirmed shutdown, create/cache one publication-attempt promise per local
operation before asynchronous lock/FS work, then reacquire the session lock. Require
private evidence plus fresh exact v5 retiring-only owner/session/generation/fence,
full original connection/claim/domain/intent/native/owned-capture authority. Use
current revision with existing `recordNativeQuiesce`; do not alter intent/native
binding or permit ordinary ready/reserved admission to retirement states.

First and cached producer success must validate the matching persisted fact and
fresh exact authority. Read back under the lock after publication, and do not
resolve producer completion before the complete lock/lease wrapper returns.
Duplicates must await the same pending publication outcome, not infer completion
from a fact visible before that attempt has returned. Cache rejection as terminal,
even if the mutation committed before acknowledgment/lock return failed. Different
operations reject; no duplicated callback, shutdown or fact-publication attempt.
Pre-seal busy/invalid rejection must remain side-effect free.

Shutdown failure mints no evidence and writes no fact. Authority change after
shutdown rejects publication while preserving the native shutdown outcome. Any
publication/readback/before-or-after-rename/lock-return failure keeps the producer
rejected and admission sealed, with inspectable old/new persisted state. Later
inspection finding a fact cannot retry, reinterpret that failed attempt as success,
create a new operation, reopen admission, replace or replay. Process loss discards
local evidence; a fresh worker cannot reconstruct it from manifests. No new retained
fact-publication capability or generic event/supervisor framework.

**Verification and scope limits:**

Cover pending/bound evidence, captured allocation identity and actual owned native
exit; busy/preparing/creating/unowned/cleanup-only rejection; ordinary stop/cached
results not minting evidence; unchanged intent-capability isolation/closure/draining;
independent shutdown/publication outcomes; concurrent duplicates/different operations
and once-only writes; authority/native/domain/fence changes after shutdown and before
cached success; harmless revision updates using current CAS; actual before/after-
rename uncertainty including a persisted fact after rejection; and post-publication
lock-return delay/error with no stolen completion or automatic continuation. Keep
all previous pending-worker/seam tests and exact owned-fixture cleanup. Use existing
deterministic native fixtures; no new permanent fixture is required.

Run `pnpm check` and storage/registration/pending-worker test files together at
normal file concurrency with unchanged deadlines. Reuse unchanged launch-domain/
collector and native shutdown-layer approvals; expand verification only for a
concrete affected boundary. Return exact two-file patch against before-images,
complete source/test/fixture snapshot, observed checks, initial failures if any and
limitations for independent scoped review before advancing.

Later controlled worker exit must await successful producer publication, not the
ordinary native shutdown result. That process-exit boundary remains unwired here.
No owned-worker/launcher/RPC/public/index changes, production-v5/default/migration
policy, worker-exit/OS absence/finalization workflow, public suspension/history/
resume, force recovery/replacement, witness/opt-in, dependency/framework or Pi change.
No real Codex/model/tool calls or broad workspace cycle. The accepted host assumption,
Codex sandbox and all 44 required items are unchanged; native exit still does not
establish transcript durability or public suspended/resumable state. Existing gates
remain open.

### 2b9a.2f implementation received — historical review handoff

Author added `quiesceIdleWithNativeFact` only to the internal pending-worker return
type. The original qualified seal captures allocation/runtime/session-object/session-
ID/thread identity, checks it around owned shutdown and mints private pending/bound
evidence only after success. Native shutdown outcome remains separate from the
cached one-attempt fact publication outcome, which uses fresh retiring-only CAS,
matching stored-fact readback and complete lock return before producer success.
Only `pending-worker.ts` and its tests changed; ordinary claims and production
v4/public/worker-exit paths are unchanged.

Review target: `/tmp/minu-codex-2b9a2f-source.sha256` relative to
`/tmp/minu-codex-approved-2b9a2e.sha256`. Before-images:
`/tmp/minu-codex-2b9a2f-baseline/packages/codex/`; exact patch:
`/tmp/minu-codex-2b9a2f.diff`; author handoff:
`/tmp/minu-codex-2b9a2f-handoff.md`.

Author typecheck and **373/373** storage/registration/pending-worker tests passed
at normal file concurrency, zero skips and unchanged deadlines, including 38 new
producer cases plus prior seam/capability/worker tests. Log:
`/tmp/minu-codex-2b9a2f-storage-registration-pending.log`. The unchanged registration
suite included its redacted Darwin correlation case. Author reports no initial
runtime/typecheck failure; prior unexplained startup/Pi gates remain open.

Coordinator typecheck and **28/28** selected pending/bound evidence/actual owned
fixture exit, same qualified-seal reuse, ordinary-stop/quiesce non-evidence,
allocation/runtime/session-object/session-ID/thread capture changes, before/after-
rename terminal uncertainty with independent shutdown success, delayed/failed lock
return and duplicate completion, restored-fact readback failure, fresh generation/
native/current-revision checks after shutdown, cached domain/missing-fact/retired
rejection, creating/unowned/cleanup-only/stored-assertion rejection, busy/preparing
work untouched and no-retry shutdown failure cases passed. Logs:
`/tmp/minu-codex-2b9a2f-coordinator-{typecheck,focused}.log`.

Complete submitted hashes match; only the two authorized approved entries differ,
with no new/missing source/test paths. Exact regenerated patch and tracked/scoped
whitespace checks pass. Artifacts:
`/tmp/minu-codex-2b9a2f-coordinator-{hashes,whitespace}.log` and
`/tmp/minu-codex-2b9a2f-coordinator.diff`. No coordinator source changes.

Request independent review of this two-file increment, including untracked content.
Focus on evidence minted only from the exact qualified captured allocation/native
shutdown (not caller/stored/cached assertions), ordinary-operation compatibility,
separate native/publication outcomes, once-only attempt installation before awaits,
fresh exact authority/current CAS plus matching fact for first/cached success,
complete wrapper-return/duplicate ordering, and terminal publication/readback/rename/
lock-return failure even when a fact is durable. Preserve capability closure/drain,
closed admission and no automatic retry/reconstruction/reopening/replacement/replay.
Reuse unchanged native client/RPC, storage, launch-domain and collector approvals
outside concrete interactions; do not infer authenticated public/exit workflow.

Later controlled worker exit still must await producer completion and remains
unwired. No production-v5/default/migration policy, worker-exit/absence/finalization
workflow, public suspension/history/cold resume, force recovery, dependency/framework/
witness or Pi change. Private owned native-child exit is not worker/group/descendant
exit or transcript durability. Await a scoped verdict before advancing; all existing
native/lifecycle/recovery/conformance/integration gates remain open, with no broad
workspace or real Codex/model/tool acceptance claimed.

### 2b9a.2f independent approval — worker-local native-fact producer only

The independent verifier approved **2b9a.2f only**, with no actionable findings.
Independent typecheck, **373/373** affected tests at normal file concurrency/zero
skips, approved baseline/complete snapshot/exact patch and scoped whitespace checks
passed. Evidence:
`/tmp/codex-verifier-2b9a2f-{typecheck,affected,final-hashes}.log`.

The coordinator matched and recorded `/tmp/minu-codex-approved-2b9a2f.sha256`,
identical to `/tmp/minu-codex-2b9a2f-source.sha256`; check:
`/tmp/minu-codex-approved-2b9a2f-check.log`. No source edits or new test cycle
accompany this receipt. Exact privately captured owned-shutdown evidence, separate
shutdown/publication outcomes, fresh CAS/authority/matching-fact checks, complete
lock-return/duplicate ordering and terminal publication uncertainty even after
persisted fact are approved worker-local producer properties.

There is still no controlled worker-exit/public wiring, production-v5/default/
migration policy, controller absence/finalization workflow, public suspension/
history/cold resume, recovery/replacement or descendant/group-exit acceptance.
Unchanged native client/RPC and launch/collector approvals are reused. All prior
Pi/startup/native/lifecycle/conformance/integration gates stay open; no full-workspace
or real-native/model/tool acceptance is claimed. All 44 items remain required.

### 2b9a.2g proposal handoff — historical read-only scope

Request a short read-only proposal for the smallest private authenticated retirement
request and controlled-worker-exit boundary using the approved native-fact producer.
Baseline: `/tmp/minu-codex-approved-2b9a2f.sha256`. Inspect existing bridge/owned-
worker/control tests and propose the minimum exact file/API/message changes and
focused test map; split before implementation if it is not one coherent increment.
No source edits, tests or OS/process probes are authorized by this proposal request.

Require eligible correlated v5 owned material and exact authenticated original
owner/session/generation/claim/full connection plus stable operation identity.
Explain initial ready authorization and same-operation retiring duplicates without
widening ordinary ready/reserved claims, input, streaming or generic RPC authority,
or reconstructing lost local evidence. V4/unregistered/uncorrelated material must
retain current controls without silent enrollment or retirement side effects.

The private controlled-success path must await complete successful
`quiesceIdleWithNativeFact` publication, not ordinary stop or native shutdown alone,
before it permits bridge/process shutdown. Preserve busy rejection without seal/
publication/stop/close effects, once-only execution, exact-operation duplicate/fence
guards and terminal failures. A durable fact visible after producer rejection must
not be used to bypass that failed local attempt and close as controlled success.
Keep native shutdown, native-fact completion, response acknowledgment and physical
worker exit as distinct outcomes; an RPC acknowledgment cannot attest exit or mean
public suspended/resumable status.

Cover request disconnect/lost acknowledgment, publication/closure failure, concurrent
stop/retirement/duplicates, parent/worker loss and stale/wrong owner/connection/
operation. No automatic mutating resend/new operation, replay/replacement, claim
reset, fence clearing or success inferred from endpoint disappearance. Reuse existing
bounded bridge/cleanup patterns; distinguish external termination/crash windows
from controlled-success completion, with inspectable fail-closed metadata.

Keep the public AgentRuntime/managed-client/CLI/Conversations surface, production-v5/
unsupported-platform policy/defaults/migration, OS absence observer/controller final
CAS, actual suspended/history/cold-resume acceptance, recovery/group escalation,
witness/opt-in/framework/dependencies and Pi changes out of this proposal checkpoint.
Return the bounded design for scoping before code; the local-host assumption and
Codex sandbox remain unchanged.

### 2b9a.2g implementation handoff — private retirement and publication-gated closure

Accept one coherent six-file private bridge/control increment:
- `packages/codex/src/worker-bridge.ts`
- `packages/codex/src/owned-worker.ts`
- `packages/codex/src/worker-client.ts`
- `packages/codex/test/worker-bridge.test.ts`
- `packages/codex/test/managed-worker.test.ts`
- `packages/codex/test/fixtures/registration-worker-fault.ts`

Baseline: `/tmp/minu-codex-approved-2b9a2f.sha256`; before-images:
`/tmp/minu-codex-2b9a2g-baseline/packages/codex/`; preflight:
`/tmp/minu-codex-2b9a2g-baseline.log`. All approved hashes and six before-images
match. Scoping used source inspection only, with no tests/probes/source changes.
No pending-worker or extra-file change is authorized; explain a concrete dependency
before expanding scope. Reuse existing bridge/cleanup patterns, not a new supervisor,
registry, event framework, public API or configuration flag.

**Private route and exact authority:**

Add separate authenticated `POST /retire` with exact bounded request
`{ operationId, version, pid, claimId }`. Reuse bearer/owner/session/generation/
no-browser-origin checks, body/header/response bounds and current timeouts. Validate
literal types/IDs and exact expected version/PID/claim; snapshot request and connection
expectations before awaits. Response result is exactly
`{ operationId, phase: native_fact_published }`, with strict matching operation and
phase validation in internal `CodexWorkerClient.retire(operationId)`. No automatic
resend, new operation, fallback to ordinary stop or reconnect/enrollment repair.
Acknowledgment denotes publication only, not bridge closure, process exit or public
suspension. Preserve normal `/rpc`, `/events` and ordinary client behavior.

Owned-worker must compare fresh stored authority with its complete actual bridge
connection. Initial request requires eligible correlated v5 ready owned material.
Retiring duplicates require the same admitted local attempt/operation, original
full connection/claim/domain/native intent and fresh fences; never reconstruct
local evidence or permission from persisted state alone. Reject retired, stale,
wrong-owner/connection/operation, uncorrelated, v4 and unregistered retirement
without changing their existing ordinary controls. Do not broaden generic RPC,
streaming, input or ready/reserved authorization to retirement states.

Install the local attempt/producer promise before invocation. The bounded intent
callback must synchronously mark it admitted immediately after the actual seal,
validate its captured context against the actual bridge connection/original
correlation and operation, then use only `commitIntent`. No await may create a
seal-to-admission-marker gap. Preserve the producer's private allocation/native
checks and fresh publication guards. Pre-seal busy/invalid rejection must not
permanently latch a retirement barrier: a settled unadmitted attempt may release
its own reservation for a later explicit request, never an automatic retry. Once
admitted, retain the attempt and terminal outcome; no new operation or reopening.

**Closure barrier and ordering:**

Optional internal registration callbacks `retire(operationId)` and `beforeClose()`
may connect the route and existing closure paths. The barrier awaits only the
admitted attempt's complete native-fact producer result, never route response or
bridge closure itself. Snapshot callback references so later caller mutation cannot
disable the guard.

Crucial ordering: existing `close()` already calls `stopRuntime()` first. Keep its
synchronous native admission closure, await that native outcome, then perform the
publication barrier before aborting streams, calling `server.close`/closing sockets,
resolving `closed`, disconnecting for controlled exit or claiming controlled success.
A sole barrier check before `stopRuntime()` is insufficient: retirement could seal
and become admitted during that await gap. Either ordinary stop synchronously wins
before seal, or retirement wins and closure must await its producer. Include the
late-admission race explicitly; do not hold a lifecycle lock across these waits.

Apply the barrier to ordinary stop and SIGTERM/SIGINT-driven bridge closure too.
Once admitted, these paths must join the producer rather than cancel it via generic
ready/shutting-down authorization or use ordinary native success as publication.
Different/stale requests cannot obtain that operation-specific authority. Matching
pending duplicates must not be bypassed by generic stopping-state shortcuts or an
already-visible fact. Producer/publication/readback/lock-return failure blocks
controlled-success closure permanently for that attempt, even if data was persisted.
Preserve inspectable metadata, closed admission and no retry/repair/replacement/replay.

After complete producer success, send best-effort acknowledgment and schedule the
existing bounded closure independently of response finish/disconnect events. A lost
ack does not cancel accepted work. Closure can still fail after acknowledgment;
keep publication, acknowledgment, closure and physical worker exit distinct. External
SIGKILL/crash remains an uncertain-loss window, not controlled exit/absence proof.

**Verification and limits:**

Cover strict route/client auth/schema/response identity; wrong token/owner/session/
generation/version/PID/claim/operation and browser origin; v4/unregistered/uncorrelated
compatibility; pending/bound success and actual owned fixture exit separately from
ack; busy/preparing rejection followed by a legitimate later explicit idle request;
concurrent stop/retire/duplicates and pre/post-seal signals; late admission around
closure; visible fact with producer/lock return pending or rejected; no stolen ack/
closure; no self-join; request disconnect and lost ack; closure failure, stale cached
fences, parent/worker loss and no automatic resend or ordinary-stop fallback. Include
an active event-stream closure case so streams cannot strand retirement. Safely
release gates and clean exact owned fixtures even when the intentional failed barrier
keeps a worker alive; no new production force-kill/group recovery path.

Run focused checks while building. At completion run `pnpm check` and storage,
registration, pending-worker, worker-bridge, public managed-runtime and worker-events
test files together at normal file concurrency, keeping all existing bounds/deadlines.
The event suite covers the shared stream-abort/server-close boundary changed by the
new barrier. Reuse unchanged collector/absence and native shutdown evidence rather
than rerunning their suites. Preserve initial failures; later green runs do not
explain old startup/Pi gates. Return exact six-file patch against before-images,
complete source/test/fixture snapshot, observed checks and limitations for independent
scoped review before advancing.

No public AgentRuntime/managed-client/index/CLI/Conversations surface, production-v5/
unsupported-platform/default/migration policy, OS absence/controller final CAS,
public suspended/history/cold-resume acceptance, recovery/group escalation,
witness/opt-in/dependency/framework or Pi change. No real Codex/model/tool calls or
broad workspace cycle. All 44 items stay required; native fact plus route/closure is
not same-domain physical-worker-exit confirmation, namespace attestation, durable
history or full lifecycle acceptance. Existing gates remain open.

### 2b9a.2g implementation received — historical review handoff

Author added private authenticated `/retire`, strict publication-only acknowledgment
and no-resend client support, owned-worker exact-operation authorization/attempt
tracking and a post-native publication barrier on RPC/signal/bridge closure. Existing
callback references and receivers are preserved; the bridge passes detached actual
connection context. Unadmitted attempts release for later explicit idle requests,
while admitted failures remain terminal. Ordinary generic RPC/event authority stays
ready-only. Only the six authorized files changed; pending-worker is unchanged.

Review target: `/tmp/minu-codex-2b9a2g-source.sha256` relative to
`/tmp/minu-codex-approved-2b9a2f.sha256`. Before-images:
`/tmp/minu-codex-2b9a2g-baseline/packages/codex/`; exact patch:
`/tmp/minu-codex-2b9a2g.diff`; author handoff:
`/tmp/minu-codex-2b9a2g-handoff.md`.

Final author typecheck and **477/477** required storage/registration/pending-worker/
worker-bridge/public-managed-runtime/worker-events tests passed at normal file
concurrency, zero skips and unchanged deadlines. Log:
`/tmp/minu-codex-2b9a2g-final-affected.log`. This includes 39 added cases plus all
prior affected tests. The unchanged registration suite included real redacted Darwin
correlation; no new OS/absence provider probes or real Codex/model/tool calls.

Initial evidence is preserved, not replaced by later greens. The first focused run
was **35/36**: preparing `paused-create` retirement queued in the new owner preflight
lock behind native allocation until its existing timeout, spoiling subsequent idle
retirement. Author removed that redundant preflight lock; preflight now reads only,
while the unchanged producer performs fresh seal/CAS checks and the locked callback
validates actual connection/correlation/operation. The same busy/idle test plus
callback checks passed **3/3** after correction. Artifacts:
`/tmp/minu-codex-2b9a2g-focused.log` and
`/tmp/minu-codex-2b9a2g-busy-fix.log`. The handoff also records an initial test-only
optional-iterator-return typecheck correction. An earlier full **477/477** pass
before callback receiver compatibility is retained in
`/tmp/minu-codex-2b9a2g-affected.log`; only the final full log above represents the
final receiver-aware target. Prior unclassified eager-startup/Pi failures remain
unexplained; none is erased by these runs.

Coordinator typecheck and **39/39** focused new route/client/managed-worker cases
passed across the two changed test files at normal concurrency, zero skips. These
cover strict auth/body/result rejection, callback/connection isolation and receivers,
late admission/native-stop publication barrier and active streams, pending/bound
publication plus separately observed fixture exit, busy/preparing then explicit idle
request, delayed/failed visible facts and duplicates/SIGTERM, terminal publication/
lock-return failure, lost acknowledgment/disconnect, closure failure after ack,
worker loss, fresh fencing, ordinary stop/signals before retirement and v4/eager/
unregistered/uncorrelated compatibility. Logs:
`/tmp/minu-codex-2b9a2g-coordinator-{typecheck,focused}.log`.

Complete submitted hashes match; only the six authorized approved entries differ,
with no added/missing source/test paths. Regenerated exact six-file patch and
tracked/scoped whitespace checks pass. Artifacts:
`/tmp/minu-codex-2b9a2g-coordinator-{hashes,whitespace}.log` and
`/tmp/minu-codex-2b9a2g-coordinator.diff`. No coordinator source edits.

Request independent review of only this six-file increment, including untracked
content. Focus on separate strict retirement/ordinary authorization, actual full
connection and captured callback context, fresh checks across ready/retiring and
duplicate overlap, read-only preflight versus locked authoritative producer checks,
unadmitted-busy release versus admitted terminal attempt, callback binding/isolation,
and native-stop-before-publication-barrier-before-server/stream/closed ordering.
Verify no close/ack from a merely visible fact or failed producer, no self-join,
signal/stop/disconnect/duplicate races, bounded strict client with no resend/fallback,
and privacy. Preserve initial failure/rework evidence and inspect fixture cleanup;
reuse unchanged native producer/storage/collector approvals outside concrete concerns.

Publication acknowledgment and bridge closure are not production physical-worker-
exit confirmation. No OS absence/controller final CAS, production-v5/default/
migration policy, public suspension/history/cold resume, recovery/escalation,
witness/framework/dependency or Pi change. All 44 items remain required. Await a
scoped verdict before advancing; existing native/lifecycle/startup/Pi/conformance/
integration gates remain open, with no broad/workspace or real-native acceptance.

### 2b9a.2g independent approval — private retirement/publication-gated closure only

The independent verifier approved **2b9a.2g only**, with no actionable findings.
Independent typecheck, **477/477** required tests at normal file concurrency/zero
skips, **2/2** independent HTTP stop/retirement barrier probes, paused-preparation
correction, approved baseline/complete snapshot/exact patch and scoped whitespace
checks passed. Evidence:
`/tmp/codex-verifier-2b9a2g-{typecheck,affected,rpc-barrier,final-hashes}.log` and
`/tmp/codex-verifier-2b9a2g-rpc-barrier.test.mjs`. The probes hold an in-flight ordinary
RPC stop while retirement is admitted, checking that neither stop acknowledgment
nor server closure precedes pending publication, and that failed publication blocks
both without exposing the private diagnostic canary. Only one native stop occurs.

The coordinator matched and recorded `/tmp/minu-codex-approved-2b9a2g.sha256`,
identical to `/tmp/minu-codex-2b9a2g-source.sha256`; check:
`/tmp/minu-codex-approved-2b9a2g-check.log`. No source edits or new test cycle
accompany this receipt. Authorization separation, actual-connection-bound locked
producer checks, admitted-attempt acknowledgment/closure barrier and terminal
publication failure are approved private control properties. Initial 35/36 busy/
preparation failure, its targeted correction and receiver-fix evidence remain
preserved as recorded above; old startup/Pi gates remain unexplained.

Acknowledgment is not physical worker exit. Controller OS absence/finalization,
production-v5/unsupported-platform/default/migration policy, public suspension/
history/cold resume and recovery/group-exit acceptance remain unfinished. All 44
items remain required; no full-workspace, namespace-attestation or real-native/
model/tool acceptance is claimed.

### 2b9a.2h proposal handoff — historical read-only scope

Request a short read-only proposal for the smallest private controller-side bridge
between recorded correlated native quiescence, fresh approved Darwin PID-slot
observation and existing retirement-finalization CAS. Baseline:
`/tmp/minu-codex-approved-2b9a2g.sha256`. Define exact internal API/files, result
semantics and focused test map; prefer existing coordination patterns and explain
any new module/fixture. No source edits, tests or OS/process probes are authorized
by this proposal request.

Keep this separate from requesting retirement: consume an explicitly addressed
operation/connection/native snapshot with its expected revision. Before any OS
query, read and validate exact v5 retiring owner/session/generation/fence/full
connection/claim/domain/intent and required native fact. Snapshot expectations;
never accept a caller-supplied absence/fact boolean as proof, reconstruct native
success, issue another retirement/stop, or substitute RPC acknowledgment/endpoint/
registry disappearance for physical absence.

Run only the approved observer outside the lifecycle lock, using the recorded
original PID and matching launcher/worker domain. Only fresh same-domain
`pid_absent`/direct ESRCH may support finalization; occupied/reused PID, permission
failure, unsupported collection, mismatch or uncertainty must leave metadata
unchanged and unavailable. No termination signal, recovery or replacement authority.

Reacquire the lock and revalidate the exact captured operation/connection/native/
domain/native fact and revision before one `finalizeRetirement` CAS. Reject stale
revisions rather than silently rebasing/reprobing/retrying. Define exact already-
retired/cached and uncertain-publication inspection semantics separately, preserving
fresh authority/current revision, immutable facts and no automatic mutating retry.
An error can leave old/new persisted state; a later read is inspection, not permission
to restart a failed producer or fabricate a successful RPC response.

Cover mutation/fencing during observation, before/after-publication uncertainty,
concurrent finalizers, wrong/missing facts/correlation, observer negative outcomes,
caller mutation, v4/uncorrelated/ineligible rejection and preservation of binding/
history/ordinary paths. Reuse approved collector/observer/storage/control evidence;
propose only focused deterministic boundary tests and any minimal supported-host
integration needed to connect the layers, with redacted private identifiers.

A private retired record under the accepted local-host assumption still does not
mean public suspended/resumable state, transcript durability, descendant/group exit
or namespace attestation. Keep production-v5/default/migration policy, new public/
managed-client/index/CLI/Conversations wiring, history/cold resume, native replay/
replacement, force recovery, witness/opt-in/dependency/framework and Pi changes out.
Return the bounded proposal for scoping before code.

### 2b9a.2h implementation handoff — private controller absence/finalization only

Accept the three-file controller proposal. Only change:
- `packages/codex/src/managed-worker.ts`
- `packages/codex/test/managed-worker.test.ts`
- `packages/codex/test/fixtures/registration-controller.ts`

Baseline: `/tmp/minu-codex-approved-2b9a2g.sha256`; saved before-images:
`/tmp/minu-codex-2b9a2h-baseline/packages/codex/`; preflight:
`/tmp/minu-codex-2b9a2h-baseline.log`. All approved hashes and three before-images
match. Scoping used inspection only; no source edits, tests or OS/process probes.
No new module, permanent fixture, production override or API/configuration flag.
Explain a concrete dependency before expanding scope.

**Internal API and outcomes:**

Add private-module helper `finalizeCodexWorkerRetirement(root, { identity,
expectedRevision, connection, intent })`, not a public/index/managed-client method
or retirement request. Snapshot all nested inputs before awaits. Accept no native
fact, absence result, boolean or alternative observer from the caller. Reuse the
existing observer/store primitives without modifying them or weakening their bounds.

Use distinct discriminants `finalized`, `pid_present`, `unconfirmed` and
`already_retired`. `finalized` means this invocation's one CAS and complete lock
wrapper succeeded. Negative observations mean no manifest mutation, never signaling/
replacement authority. `already_retired` is only read-only inspection of matching
committed material at the caller's explicitly supplied current revision; no OS
query/mutation, new liveness proof or reconstructed successful RPC. Errors are fresh
generic/redacted failures without private diagnostic causes or copied fields.

**Authority/observation/publication sequence:**

1. Under the lifecycle lock validate expected revision, addressed owner/session/
   generation and clear explicit-resume fence, exact full connection/claim and
   eligible v5 retiring intent/native binding. Require structurally valid matching
   stored launcher/worker correlation and the correct native fact before any OS
   query. Validate malformed expected inputs/unsupported states before observation.
   Retain detached private snapshots of the complete target, domain and native fact.
2. Initially matching retired material may return only `already_retired` after
   fresh authority/current-revision/complete immutable-fact checks and full lock
   return. Stale expected revision cannot adopt another finalizer's newer commit.
3. For retiring material release the lock fully, then call approved
   `observeDarwinPidAbsence` once on the recorded original PID and its validated
   matching domain. This helper already obtains fresh same-domain observations and
   uses fixed signal zero; no endpoint/RPC/registry inference or fallback. Only
   exact `pid_absent` may support publication. Other outcomes remain unavailable.
4. Reacquire the lock after observation for **all** outcomes, including present or
   unconfirmed. Require the same captured revision, connection/operation/native/
   domain/native fact and fresh authority before returning a negative result or
   writing. Any change, including a harmless revision increment, rejects; no silent
   rebase, second observation, retry or adoption of a concurrent winner.
5. On `pid_absent`, call existing `finalizeRetirement` once at that captured/current
   revision, using absence fields derived only from the validated captured PID/
   domain. Read back exact matching retired correlation/native/absence facts and
   revision, then await complete lease/lock wrapper return before `finalized`.

Before/after-publication, readback or lock-return error remains that invocation's
failure even if the file committed. Never automatically read-and-relabel it as
success, repeat CAS/observation, request retirement again, restart a producer,
reset claims/fences, reopen admission, replace or replay. No global failure ledger
or supervisor is needed: a later explicit current-revision inspection may report
`already_retired`, but cannot steal `finalized` completion or retroactively resolve
the failed/pending invocation. Historical reads and native binding remain preserved.

**Verification and scope limits:**

Use the existing controller fixture solely for deterministic approved OS-query/
signal-zero boundaries and FS/publication/lock-return gates. Keep overrides and
synthetic identifiers in test/fixture code; delegate unrelated builtins and never
add production provider injection, command-path/environment knobs or nonzero
observer signaling. The finalizer must issue no launch, reconnect, retirement,
stop, interrupt, deregistration or metadata repair request.

Cover pending/bound native prerequisites/success; exact malformed/unsupported/
missing/wrong facts/domain/intent/connection/revision/owner/generation and zero OS
queries on ineligibility; present/reused PID, EPERM/unknown errors, unsupported or
mismatched domain; caller mutation; lock availability and authority/fact/revision
changes during observation (also negative-result paths); concurrent finalizers;
actual before/after-rename/readback/lock-return uncertainty; no retry/stolen finalized
completion; exact current-revision already-retired inspection without observation/
mutation; stale/fenced history, ordinary rejection and unchanged native binding.

Include one redacted supported-Darwin integration: real correlated pending owned
fixture retirement, separately observed fixture disappearance, then one fresh
observer/finalization call. Record unsupported hosts honestly and do not claim real
Darwin acceptance there. Native/model/tool execution is not required. Reuse unchanged
collector/observer/storage/control approvals rather than rerunning their suites.
Existing exact owned-fixture cleanup is permitted, without a new recovery path.

Run `pnpm check` and affected storage/registration/pending-worker test files together
at normal file concurrency with unchanged bounds/deadlines. Preserve any initial
failure; later greens do not explain prior startup/Pi gates. Return exact three-file
patch against before-images, complete source/test/fixture snapshot, observed checks
and limitations for independent scoped review before advancing.

No production-v5/unsupported-platform/default/migration policy, bridge/client/
owned-worker/pending-worker/index or public AgentRuntime/managed-client/CLI/
Conversations wiring, public suspension/history/cold resume, native replacement/
replay, force recovery/group escalation, witness/opt-in/dependency/framework or Pi
change. No real Codex/model/tool calls or broad workspace cycle. Private retired
under the accepted local-host assumption is not public suspended/resumable status,
transcript durability, descendant/group exit or namespace attestation. All 44 items
remain required and existing acceptance gates stay open.

### 2b9a.2h implementation received — historical review handoff

Author implemented private `finalizeCodexWorkerRetirement` only in the three
approved managed-worker module/test/controller-fixture files. No public export or
production-v5 switch. Inputs are detached before awaits; complete eligible native
facts/correlation/authority are checked before observation. One approved observer
call runs after full preflight lock return; every outcome reacquires the lock and
requires the original revision and exact facts. Only direct absence reaches one
CAS, matching retired readback and full lock return before `finalized`. Current-
revision `already_retired` remains inspection only. Errors are fresh/redacted,
with no retry, rebase, reconstructed completion or recovery authority.

Review target: `/tmp/minu-codex-2b9a2h-source.sha256` relative to
`/tmp/minu-codex-approved-2b9a2g.sha256`. Before-images:
`/tmp/minu-codex-2b9a2h-baseline/packages/codex/`; exact patch:
`/tmp/minu-codex-2b9a2h.diff`; author handoff:
`/tmp/minu-codex-2b9a2h-handoff.md`.

Author typecheck and **449/449** storage/registration/pending-worker tests passed
together at normal file concurrency, zero skips/cancellations and unchanged bounds.
Log: `/tmp/minu-codex-2b9a2h-affected.log`. Sixty added cases include a redacted,
unmocked supported-Darwin pending-fixture retirement, separately observed fixture
disappearance and fresh observer/finalization call. No native app-server/thread/
model/tool allocation. Unchanged observer/collector/storage/control approvals are
reused; this is not broad/workspace or real-native acceptance.

Initial **58/60** focused results remain in
`/tmp/minu-codex-2b9a2h-focused.log`. Both failures occurred inside bound fixture
setup, at worker reservation after premature native binding, before finalizer use.
The approved store correctly rejected that ordering. Author moved fixture binding
after readiness/correlation and before retirement intent; the two affected cases
passed **2/2** in `/tmp/minu-codex-2b9a2h-fixture-fix.log`. Coordinator inspected the
failure stacks and corrected setup; no store safeguard/assertion waiver or production
fix was introduced. These results do not classify the earlier eager-startup/Pi gates.

Coordinator typecheck and **40/40** focused cases passed, zero skips: pending/bound
preservation, selected malformed/missing prerequisites with zero queries, all five
negative observation modes, observation-time revision/fact/authority changes across
positive and negative paths, caller mutation, publication/readback/lock-return
uncertainty, concurrent finalizers and inspection without stolen completion. The
redacted unmocked Darwin round trip also passed. Logs:
`/tmp/minu-codex-2b9a2h-coordinator-{typecheck,focused}.log`.

Complete submitted hashes match after checks; exactly the three authorized entries
differ from approved g, with no missing/extra source/test paths. Regenerated patch
matches the submitted patch, and tracked/scoped whitespace passes. Artifacts:
`/tmp/minu-codex-2b9a2h-coordinator-{hashes,whitespace}.log` and
`/tmp/minu-codex-2b9a2h-coordinator.diff`. No coordinator source edits.

Request independent review of this three-file increment, including untracked
content. Focus on complete prerequisites before any query, original PID/domain,
fully unlocked fresh observation, same-revision/fact/authority revalidation for
all outcomes, one absence-derived CAS/readback/full lock return, exact inspection
without observation/mutation, concurrent/stale contenders and terminal uncertainty.
Inspect deterministic gates and the unmocked redacted boundary; preserve initial
fixture-failure evidence and reuse unchanged-layer approvals absent a concrete risk.

No independent approval yet. Production-v5/unsupported-platform/migration policy,
public suspension/history/cold resume, recovery/group exit, CLI/Conversations and
existing native/startup/Pi/conformance/workspace gates remain open. Private retired
is not public suspended/resumable status, transcript durability or namespace
attestation. All 44 requirements remain required; await a scoped verdict before
advancing.

### 2b9a.2h independent approval — private controller finalization only

The independent verifier approved **2b9a.2h only**, with no actionable findings.
Independent `pnpm check`, **449/449** required storage/registration/pending-worker
tests at normal concurrency/zero skips, the unmocked redacted Darwin round trip,
approved before-images, complete snapshot, exact patch and scoped whitespace
checks passed. Logs:
`/tmp/codex-verifier-2b9a2h-{typecheck,affected,final-hashes}.log`.

The verdict confirms fully unlocked observation, same-revision/authority
revalidation for every outcome, CAS plus matching readback and complete lock return,
inspection-only `already_retired`, and failed publication remaining failure.
Earlier author/coordinator evidence and initial fixture failures remain preserved.

Approved complete source/test snapshot:
`/tmp/minu-codex-approved-2b9a2h.sha256`, identical to
`/tmp/minu-codex-2b9a2h-source.sha256`. Receipt hash check:
`/tmp/minu-codex-approved-2b9a2h-check.log`. This receipt changes documentation only;
no source edits or another test cycle. Approval does not close production-v5/
unsupported-platform policy, public suspension, native-history/resume, recovery,
startup/Pi, full-workspace, real-native or the other required acceptance gates.
R14 and the full 44-item delivery remain incomplete.

### Integrated managed suspend/resume — authorized implementation

Owner message 190 approves the macOS-first rollout proposed in messages 188–189.
Implement this as one end-to-end milestone, not further private-seam approval
cycles. Node and the public Runtime API remain portable; the current restart-safe
host/boot/PID observation backend is Darwin-specific. Cross-platform lifecycle
support remains unfinished, not an inherent Node restriction or a waived requirement.

**Approved rollout:** new Darwin managed sessions use v5; existing v4 records and
controls remain unchanged, with no migration/enrollment. Other platforms retain
v4 create/turn/reconnect and explicitly reject unsupported suspend/cold resume.
On Darwin, unavailable required provenance fails closed, without downgrade or
teardown authority over ready/adopted workers. In-process start stays unchanged.
Keep the accepted local-host assumption, no opt-in/witness, read-only sandbox and
approvalPolicy never. Platform/legacy limitations remain explicit open delivery
limits, not full 44-item acceptance.

**Baseline/scope:** `/tmp/minu-codex-approved-2b9a2h.sha256`; complete before-images:
`/tmp/minu-codex-lifecycle-baseline/packages/codex/`, with saved `source.sha256` and
preflight `/tmp/minu-codex-lifecycle-baseline.log`. Baseline setup ran hash/file
operations only, no new test cycle or OS/process probes.

Implement in these existing `packages/codex/src/` files:
`client.ts`, `managed-client.ts`, `managed-native.ts`, `native-resume.ts`,
`managed-store.ts`, `managed-worker.ts`, `owned-worker.ts`, `pending-worker.ts`,
`worker-client.ts`, `worker-bridge.ts`. Corresponding existing Codex runtime,
managed-native/runtime/store/worker, pending-worker, bridge and events tests and
related existing fixtures are in scope, particularly app-server, registration
fault/controller and managed-runtime-consumer. Update README, this plan and the
functionality matrix. Explain a concrete dependency before expanding production
scope; no new framework/dependency/core interface, UI surface or Pi fix.

**Complete behavior:**
1. Preserve lazy allocation: valid first input, one native binding before dispatch.
2. Expose idle-only public suspend through authenticated seal/intent/native-exit/
   native-fact publication, exact worker absence and finalization. Busy work is
   not interrupted. No hidden resend, ordinary-stop fallback or silent rebase.
3. Capture bounded native-history identity while admission is sealed. After owned
   shutdown, inspect the same persisted thread using an owned temporary app-server
   without thread creation/input dispatch. Verify checkpoint/history/turn-item
   identity and publish a bounded correlated eligibility receipt. Missing/mismatched
   history or uncertain inspection cleanup stays unavailable. Never equate native
   exit or private retired metadata alone with public suspension/resumability.
4. Inventory/status and fresh controllers derive suspended eligibility from durable
   receipts; active requires fresh authenticated living-worker authority. Ambiguous,
   fenced or incomplete material stays unavailable and private identifiers stay private.
5. Clean cold resume uses one guarded resume epoch retaining predecessor retirement/
   history evidence, never a bare registration reset. Preserve stable Runtime ID,
   exact native thread, owner/workspace/policy and one new worker reservation. Validate
   exact thread/history before authenticated readiness. Bound resume never starts a
   new thread or replays prior input; failures retain uncertainty/fences without retry.
6. Preserve prior messages, accept one new turn, and repeat suspend/resume. Native
   history is not a durable caller-turn exactly-once ledger; document that boundary.

**Verification/cadence:** focused tests while building, then `pnpm check` and one
combined Codex regression run at integration, normal file concurrency/unchanged
existing deadlines. Cover busy races, contention, lost acknowledgments, crash/
publication windows, stale epochs, missing/unsafe history, caller mutation, platform
refusal and legacy compatibility. Required public process-boundary loop:
create → turn → idle suspend → inventory → new controller process → exact-thread
resume → identical prior history → new turn → repeat. Reuse unchanged evidence;
preserve/classify initial failures rather than retrying until green.

Validate real Codex persistence against an owned controlled loopback provider;
no paid/external model or real tool calls. Record binary/version/platform and actual
results without private identifiers. One independent integration review after the
whole loop, with finding-driven correction only as necessary; no internal-seam
review handoffs. Return exact patch, complete snapshot and concise observed evidence.
Required workspace/release gates still apply at integration; prior Pi/startup
failures remain open and must not be hidden or repaired out of scope. Destroy,
forced recovery, other platforms and all remaining requirements stay required and
outside this clean suspend/resume milestone. No overall lifecycle/release acceptance
until its applicable gates actually pass.

### Integrated managed suspend/resume implementation — historical review handoff

The working tree now implements the approved macOS-first public loop. New public
Darwin managed sessions select v5; the internal fixture/legacy factory default stays
v4, and non-Darwin public creation remains v4. No legacy enrollment or provenance
fallback was added. Public suspend uses the authenticated retirement producer and
same-revision absence finalizer; only confirmed occupied PID slots are observed
again during its bounded exit wait. Errors/unconfirmed observations are not retried.

A bounded intent capability captures native turn/item identity and a SHA-256 history
checkpoint while local admission is sealed, before shutdown. Native history must
also contain the Runtime messages actually observed by the owning execution. After
retirement, an owned inspection-only app-server reads the exact persisted thread
without start/resume/input; its exit must be confirmed before the controller records
verified eligibility. Inspection/history failure leaves private retired material
unavailable, not publicly suspended. Receipts contain hashes/counts, not prompts.

Cold resume is an atomic new-generation epoch retaining one complete immediate
predecessor retirement/history receipt (bounded depth, not an unbounded audit log).
It preserves native binding/configuration/sandbox and permits one reserved worker.
That worker reopens the exact native thread and checks history before readiness;
uncertain startup retains cleanup authority and never resets/retries the claim.
Never-used identities stay lazy. Inventory is read-only. Caller-turn idempotency is
still per-worker retention, not a durable caller ledger or exactly-once tool promise.

Observed author evidence:
- pnpm check passed.
- Two-cycle public fixture loop passed across actual controller processes:
  create/turn/suspend/inventory/controller exit/same-thread resume/preserved history/
  second turn/second suspend, then another resumed-history comparison.
- Focused public lifecycle checks passed 9/9; receipt/epoch checks passed 14/14;
  prior private retirement/seam regressions passed 73/73 at the earlier build stage.
- Combined final Codex regression: 782/782 passed, normal file concurrency, zero
  skips/failures; /tmp/minu-codex-lifecycle-codex-regression.log.
- Required full workspace pnpm test/build: 850/850 passed, normal file concurrency,
  zero skips/failures; /tmp/minu-codex-lifecycle-workspace.log.
- Real Codex CLI 0.167.0 passed two turns, idle suspension, a fresh adapter, exact
  native resume and equal prior messages, followed by another suspend against a
  controlled owned loopback Responses provider. Exactly two /v1/responses requests;
  no paid/external model or actual tool calls. Dedicated canonical temporary
  CODEX_HOME/workspace were removed after success. IDs were redacted.
  Probe: /tmp/minu-codex-lifecycle-real.mjs; success log:
  /tmp/minu-codex-lifecycle-real-2.log.
- Initial typecheck found one missing v5 narrowing after a manifest reread; fixed.
  The first real-probe harness used a noncanonical macOS /var temporary path and
  correctly failed private-root validation before native/model requests (0 calls).
  Canonicalized the harness path, removed its owned temporary directory, then ran
  the successful probe. Initial logs remain preserved; no runtime-test failure
  occurred in this integrated milestone's observed checks.

No independent integration acceptance is claimed yet. Existing earlier startup/Pi
intermittent failures are not explained by the passing workspace run. Destroy,
forced recovery, other-platform cold lifecycle, discovery/skills/images and all
remaining checklist requirements are still required unfinished work. Real-model/
tool, power-loss durability, descendant/group recovery and full release/Conversations
acceptance are not supplied by this milestone. No source/default edits outside the
approved Codex scope, core API change, dependency/framework, witness/opt-in or Pi fix.

### Integrated Darwin suspend/resume — independent milestone approval

Verifier message 205 approves this milestone after resolving the single HIGH
resumed-startup cleanup finding; no actionable findings remain. Initial independent
review passed typecheck and 23 focused cases but reproduced three failures: resumed
native allocations had no cleanup owner after lock return/domain/bridge failure.
The initial three-probe failure log remains unchanged at
`/tmp/codex-verifier-lifecycle-cleanup.log`.

The four-file correction retains the exact allocation through full lock return,
installs startup cleanup before domain/bridge setup and transfers ownership to the
bridge. Existing abort arbitration preserves ready/adopted workers; unconfirmed
native cleanup cannot become successful worker shutdown. Independent typecheck,
**366/366** affected tests including five permanent regressions, **3/3 unchanged
reproductions**, hashes, reviewed before-images, exact patch and whitespace passed.
All three reproductions show one native-stop attempt and worker/app-server exit.
Logs: `/tmp/codex-verifier-lifecycle-cleanup-{typecheck,affected,recheck,final-hashes}.log`.
The initial permanent-test child-exit wait cancellation and its test-only ref fix
remain preserved in the author handoff/logs; no deadlines were increased.

Reviewed final target: `/tmp/minu-codex-lifecycle-cleanup-source.sha256` (includes
then-current documentation). Final complete source/test/fixture-only approved
snapshot: `/tmp/minu-codex-approved-lifecycle.sha256`, derived without source changes
and checked in `/tmp/minu-codex-approved-lifecycle-source-check.log`. Documentation
before this receipt is saved under `/tmp/minu-codex-lifecycle-approval-docs-before/`.
Receipt is documentation/hash-only, without source edits or another test cycle.
Prior author **782/782 Codex**, **850/850 workspace** and controlled Codex 0.167.0
loopback evidence are reused, not fresh correction evidence. Actual controller
process restart is covered by fixtures; the real binary probe uses a fresh adapter.

Approval covers new Darwin v5 clean managed suspend/resume, not all lifecycle,
platform/legacy, real model/tool or release acceptance. Destroy/recovery, remaining
native capabilities, CLI/Conversations, conformance and historical startup/Pi gates
remain open. Product-scope discrepancy: the current matrix excludes R42–R44, while
earlier handoffs required them later; this technical approval does not itself
approve that scope change. Obtain the owner-decision reference before settling it.

### Non-destructive destroy (R16) — historical implementation authorization

Implement the required exact-owner managed `destroy` using existing lifecycle,
authority and storage patterns: atomically reject busy/admission races, confirm
eligible owned shutdown, remove only Runtime resume metadata and retain Codex native
history. Preserve wrong-owner, stale-controller, concurrent resume and uncertain-
cleanup safeguards. No force recovery, automatic repair, migration, platform
expansion, copied history or new framework. Work within existing Codex code/tests/
fixtures and documentation; explain a concrete dependency before expanding scope.
Use focused checks during implementation and one behavior-level integration review
when working. Do not reopen private-seam proposal cycles or repeat unchanged broad
checks without a concrete reason. Other requirements are not dropped.

### R16 implementation handoff — historical behavior-level review

Public `destroy(id, ownerId)` now reuses verified idle suspension for active Darwin
v5 sessions, then removes Runtime resume metadata using the existing lifecycle lock
and exact revision/generation. Already verified suspension and never-launched pending
metadata (including v4) need no new native allocation. Busy/preparation, wrong owner,
fences, unconfirmed shutdown/history, ordinary stop without a receipt and unsupported
active registrations reject. This is not a force recovery or platform expansion.

The existing suspend helper accepts an internal expected generation for destroy's
shutdown handoff: a stale request cannot suspend a replacement worker. The deletion
lease separately verifies eligibility/revision and atomically renames the metadata-only
session directory out of inventory. It unlinks only `manifest.json`, never recursively
removes data, rejects unknown directory entries, and retains the lifecycle lock inode
for queued/stale callers. Publication, cleanup and complete lock-return errors remain
failures even if canonical metadata has disappeared. No history deletion/archiving,
replacement thread, automatic retry, metadata repair or new lifecycle framework.

Changed code/tests: `client.ts`, `managed-client.ts`, `managed-store.ts`,
`managed-runtime.test.ts`, `managed-store.test.ts`. Source before-images match the
approved lifecycle snapshot; documentation before-images capture current coordinator
updates, not a reconstructed approved document version.

Observed author checks:
- `pnpm check` passed.
- 16 focused destruction cases passed, including physical worker/native exit,
  byte-preserved native history, unrelated-session isolation, busy/preparation,
  both destroy/cold-resume orderings, generation handoff, uncertain history,
  wrong owners/fences/non-metadata files and before/after-rename/full-lock errors.
- Five normal-concurrency affected suites exercised 576 cases. Initial run passed
  575; one old availability assertion still expected `destroy` to be absent.
  Corrected that assertion to require the newly implemented method and reran the
  complete 72-case public managed suite: 72/72 passed. The other 504 affected cases
  already passed unchanged; no deadline or concurrency changes or repeated broad run.
- An initial TypeScript error in a new fixture call used the wrong existing factory
  signature; corrected before executing focused cases. Failure evidence is retained.

Artifacts: `/tmp/minu-codex-destroy.diff`, `/tmp/minu-codex-destroy-source.sha256`,
`/tmp/minu-codex-destroy-handoff.md`, `/tmp/minu-codex-destroy-baseline/`.
Logs: `/tmp/minu-codex-destroy-focused-2.log`,
`/tmp/minu-codex-destroy-affected.log` (initial availability failure retained),
`/tmp/minu-codex-destroy-public-final.log`, `/tmp/minu-codex-destroy-check-final.log`.
Prior workspace/controlled-native evidence is reused for unchanged code, not claimed
as fresh destroy verification. No full workspace/native/model/tool run was repeated.

No owner decision reference supporting the matrix's R42–R44 exclusion was found in
the supplied conversation or repository. The earlier plan/header and final checklist
still require them; MVP/KISS instructions do not themselves reduce scope. Preserve
that discrepancy pending an exact owner decision reference, not an inferred reduction.
R16 behavior-level independent acceptance and full delivery remain pending.

### R16 destroy MVP — independent scoped approval

Verifier message 209 approves R16 within its documented eligibility limits, with no
actionable findings. Independent typecheck, **271/271 storage/public tests** at normal
concurrency/zero skips, full snapshot, approved source/test before-images, exact
patch and whitespace checks passed. Logs:
`/tmp/codex-verifier-destroy-{typecheck,affected,final-hashes}.log`.

Confirmed eligible shutdown precedes metadata-only deletion; native history and
lock identity remain intact. Both destroy/resume race orderings, stale-generation
rejection, ownership/busy checks and publication uncertainty passed. Active v4/
non-Darwin and uncertain/ordinary-stopped-without-receipt material remain unsupported;
this is not force recovery or full R11–R22 lifecycle/platform acceptance.

Reviewed target: `/tmp/minu-codex-destroy-source.sha256` (includes then-current docs).
Approved complete source/test/fixture-only snapshot:
`/tmp/minu-codex-approved-destroy.sha256`; check:
`/tmp/minu-codex-approved-destroy-source-check.log`. Before receipt, documentation was
saved under `/tmp/minu-codex-destroy-approval-docs-before/`. No source changes or new
test cycle accompany this receipt. Earlier workspace/native evidence is reused,
not rerun; the original availability-assertion failure remains preserved.

R42–R44: neither author nor reviewer found/approved a supporting owner scope change.
Restore the matrix to the earlier required later-phase classification, native
R01–R41 first. This corrects unsupported wording; it is not a new owner decision or
scope expansion. MVP/KISS removes optional complexity, not agreed functionality.

### Native launch and input capabilities (R24–R28) — historical authorization

Implement the smallest complete native-backed launch/input flow in the Codex
package: model/reasoning/skill discovery and effective defaults, exact selections
(including explicit empty skills), bounded ordered image transport with image-aware
turn identity, and honest live capability reporting. Reuse existing native protocol,
input validation, worker/bridge and persistence patterns; preserve text operation,
new Darwin lifecycle and legacy behavior. Codex remains the harness/history source
of truth. No new framework/dependency, copied transcript, recovery redesign,
platform backend or unrelated Pi/Core interface/consumer change. Explain a concrete
dependency or native protocol limitation before expanding production scope; do not
substitute blanket refusal for implemented support or fabricate effective settings.

Invalid input must be rejected before dispatch; preserve pre-allocation structural
validation, cancellation, owner/generation fences and no replay/replacement. Image
bytes and private native paths/credentials must not leak through messages, events,
discovery or diagnostics. Use focused checks during implementation, one combined
Codex integration check and one behavior-level independent review when the launch/
input flow works. Reuse unchanged evidence and preserve initial failures. Native
metadata discovery/controlled loopback-provider probes are allowed; no paid/external
model or actual tool calls. Baseline is the approved destroy source/test snapshot.

Narrow native-default resolution agreement (response to author message 211):
`config/read` leaves effective defaults null and `model/list` lacks a provider;
`/tmp/minu-codex-capabilities-investigation.md` records this on Codex 0.167.0.
For explicit launch discovery only, `capabilities()` may own one temporary RPC and
one ephemeral `thread/start` to obtain native-resolved defaults, using read-only
sandbox/approval never, no user turn, managed allocation/registration, shared config
mutation or persistent native history. Validate that native ephemeral mode is
honored on the supported version in an isolated home. Do not guess a provider or
build a separate settings resolver/cache/framework. Return discovered defaults only
after confirmed owned-process shutdown; unsupported/malformed responses, cancellation
or cleanup uncertainty remain generic failure/unavailability, without retry or
invented fallback. Reuse the existing owned inspection/cleanup pattern. This is not
a fallback for live session/input capability observations, managed creation or lazy
allocation: those must not open a native thread merely for observation. Preserve
custom-provider text behavior when catalog metadata is unavailable; report unknown
reasoning/vision honestly rather than enforcing unjustified catalog membership.
Return a bounded patch, complete snapshot and concise observed checks/limitations.
R31–R33 observations/diagnostics, R19–R20 recovery/fences, consumer integration,
conformance, historical gates and required later-phase work remain queued—not dropped.

### R24–R28 implementation handoff — historical integrated review

Implemented native-backed launch discovery, exact selections and bounded image input.
`native-capabilities.ts` bounds native metadata, resolves opaque skill IDs and exact
per-thread skill overrides, and validates the single ephemeral discovery thread.
`input.ts` only shares ordered typed input encoding/fingerprinting. Existing worker,
manifest, bridge and native lifecycle patterns remain authoritative; no framework,
dependency, Core/Pi/consumer change or copied history system was added.

Explicit discovery owns one temporary RPC/ephemeral read-only, approval-never thread.
No user/model/tool call or managed registration; verified defaults return only after
confirmed shutdown. Native response policy/ephemerality/path are checked. Actual
0.167.0 isolated-home verification also found no listed thread or persisted rollout
following discovery. Custom-provider text and exact native-acknowledged reasoning
remain available without catalog metadata; known unsupported reasoning rejects.
Vision support is never guessed: missing metadata/live allocation is unavailable,
known text-only models report false. Live observations never use ephemeral discovery.
Per-thread live skill verification stays false because native skills/list is global
cwd-scoped metadata, not an observation of a thread's effective skill selection.

Explicit skill sets, including [], map to complete per-thread native skills.config
entries without modifying shared settings. Re-resolve on allocation/resume; unknown
IDs fail rather than silently enabling harness defaults. Image input reuses Core's
MIME/base64/count/byte bounds, preserves image-only input and order, hashes typed
pixels into retained turn identity, and releases private pixel references after
preparation/dispatch. Native projections omit image parts; native diagnostic errors
are generic even on later text-only turns containing historical images. The private
RPC boundary discards native error payloads on steer/read/control paths too. Runtime
resends neither inputs nor failed discovery; native model rerouting fails visibly.
Text requests omit image fields, retaining the older worker wire envelope. A
reachable worker whose native process has exited does not advertise live capabilities.
Live vision reads actual opened/pinned model metadata, not saved configuration, and
sends no deadline-bearing native catalog request that could stop existing work.

Two concrete plumbing dependencies were fixed within the existing implementation:
- Registered preparation interrupts previously queued behind allocation's lock.
  Only interrupt authorization now uses the existing read-only preflight pattern;
  actual dispatched interrupts retain locked fresh-generation/fence checks.
- Valid image envelopes exceed the old 2-MiB bridge/8-MiB native frame/history limits.
  Bound affected transports/history at Core's 34 MiB. The first integration exposed
  quadratic native frame-prefix scanning at that size; accumulate pipe fragments
  and join only complete frames. Existing byte/UTF-8/oversize/deadline checks pass
  with unchanged deadlines; no new process or buffering framework.

Observed author evidence on the delivery target:
- `pnpm check` passed: `/tmp/minu-codex-capabilities-check-release.log`.
- **824/824 Codex tests**, normal concurrency, zero skips/failures/cancellations:
  `/tmp/minu-codex-capabilities-regression-release.log`. Includes 21 new launch/input
  cases and preserved storage/registration/lifecycle/streaming regressions.
- Real Codex **0.167.0** owned loopback-provider loop passed after the final changes:
  `/tmp/minu-codex-capabilities-real-final-824.log` using
  `/tmp/minu-codex-capabilities-real.mjs`. Exactly two synthetic Responses requests,
  no paid/external inference or real tools; native selected skills/pixels, live
  vision, exact cold-history comparison and non-destructive destroy verified.
  Config bytes remained unchanged; discovery made zero model calls/no conversation.

Initial evidence remains: three incremental TypeScript issues in new code/fixtures;
preparation cancellation failure; initial integration 814/817 with two obsolete
feature-negative assertions plus the frame performance failure; a later timeout
from duplicate fake model rows/unregistered unexpected-success cleanup. Corrected
fixture metadata and failure cleanup without weakening assertions or changing
concurrency/deadlines. See `/tmp/minu-codex-capabilities-handoff.md` for exact logs.

Artifacts: `/tmp/minu-codex-capabilities.diff`,
`/tmp/minu-codex-capabilities-source.sha256`,
`/tmp/minu-codex-capabilities-handoff.md`,
`/tmp/minu-codex-capabilities-baseline/`. Source/test before-images match approved R16;
document before-images retain the coordinator's default-resolution agreement.
No fresh full-workspace, paid-model/tool, cross-version or release acceptance is
claimed. Historical startup/Pi gates, recovery/platform gaps, R31–R33, integration,
conformance and required R42–R44 remain open. One integrated independent review is
next; author evidence is not that acceptance.

### R24–R28 — independent milestone approval

Verifier message 228 approves the integrated launch/input milestone after the single
MEDIUM provider-ID finding was corrected. No actionable findings remain. Initial
review passed typecheck/325 affected cases, image-rejection and uncertainty probes;
focused re-review passed typecheck/six regressions, the unchanged Codex 0.167.0
provider probe (zero user/model/tool calls), final hashes, exact correction and
whitespace checks. Logs: `/tmp/codex-verifier-capabilities-provider-id-{typecheck,focused,recheck,final-hashes}.log`.

Explicit provider validation now accepts bounded literal native-compatible strings,
independent of discovery-output sanitization; native exact acknowledgment remains.
The earlier managed-image rejection correction preserves native/text usability
without downgrading uncertain dispatch/lock return. All original failures/probes,
pre-correction artifacts and focused correction reports remain preserved. Prior
824-Codex/318-image-correction/94-provider-correction and controlled-native evidence
is reused, not a new whole-suite or paid/backend/tool acceptance claim.

Reviewed target: `/tmp/minu-codex-capabilities-source.sha256` (then-current docs
included). Approved complete source/test/fixture-only locator:
`/tmp/minu-codex-approved-capabilities.sha256`; check:
`/tmp/minu-codex-approved-capabilities-source-check.log`. Pre-receipt docs:
`/tmp/minu-codex-capabilities-approval-docs-before/`. Receipt changes documentation
only; no source edits or another test cycle. Full adapter/product delivery,
platform/legacy lifecycle, recovery/fences, consumer integration, conformance,
real model/tool acceptance and historical startup/Pi gates remain open.

### Next MVP milestone — live observation and diagnostics (R31–R33)

Implement the existing Core contracts in Codex: exact-owner `inspectSessionProfile`,
bounded `inspectSessionEvents`, and explicit `openDiagnostic`. Reuse Core profile/
event projections and limits, existing worker/authentication and private-file
patterns. Profile fields need existing-worker evidence, not saved launch config or
launch discovery. Report unsupported/unrepresentable fields as not_verified; global
skills are not proof of instructions loaded/used on a turn. Events are the current
worker's bounded ordered Runtime-bridge codes, with truthful capture/eviction data,
not raw native logs or delivery acknowledgment.

Profile/event observation must not launch/resume threads, allocate pending native
work, stop working sessions, mutate metadata/config or repair/reconnect uncertain
material. Honor cancellation and owner/generation/connection fences; older/unknown/
unavailable sessions return honest unavailability under the existing contract.
Diagnostic opening is an explicit action on an eligible adapter-owned bounded,
private, sanitized diagnostic using a verified local viewer; no arbitrary paths,
shell commands, raw pixels/credentials, fabricated open success or automatic TUI
attachment. Tests may stub the viewer boundary; do not actually open desktop apps
without separate approval. Preserve unsupported/headless host conditions honestly.

Keep production scope in Codex plus related tests/fixtures/docs. No Core interface,
Pi/consumer, dependency, event framework, native-history copy, lifecycle redesign or
platform recovery backend. Explain only concrete blockers/dependencies before
expanding scope. Author runs focused checks; one behavior-level independent review
at completion, with affected correction checks only. Coordinator verifies scope/
evidence without routine duplicate test runs (owner message 221; response 224). Reuse valid
unchanged evidence; one broad integration run when justified, not duplicate full
Codex-plus-workspace runs. Preserve current work and failure evidence; baseline is
the approved capabilities snapshot. Recovery/fences, consumer integration/conformance,
historical/native acceptance and required later-phase work remain queued, not dropped.

### R31–R33 implementation handoff — behavior-level review pending

Implemented existing Core profile/event contracts over authenticated read-only worker
resources. Fresh adapters route from exact-owner ready manifests without binding
controls or invoking launch/reconnect/repair. Recheck the full connection/generation/
fence after transport. Core time/byte limits, caller aborts and physical read slots
bound optional work, including work that outlives cancellation. Worker observation
preflight uses the existing read-only authority check, never an allocation lock or
native request; actual control fencing remains unchanged.

Profiles project actual opened native model/provider/reasoning acknowledgments.
Unallocated/unrepresentable fields remain not_verified; no saved config/discovery
fallback. Skills remain not_verified because global discovery is not per-thread
command/instruction evidence. Native offline/stopping and unavailable workers do
not produce apparently live profiles. The current-worker journal records only
Core codes/timestamps/sequence, retaining 200 entries with truthful eventsDropped
and recordingSince. Reads do not record themselves or imply downstream delivery.

Explicit openDiagnostic writes a Core-projected profile/event snapshot to one
bounded 0600 per-session file under the private owner's .diagnostics directory,
never a resume/session directory or native history. Refuse unsafe links/files/modes;
check current authority before publication and launch. Current viewer eligibility
is managed macOS desktop: fixed canonical root-owned non-writable system open and
TextEdit, no shell/arbitrary app/path, clean launcher environment, bounded wait and
zero exit required. SSH/headless/unsupported/direct session modes reject honestly.
No default file association or raw native log/prompt/image/credential is used.
Success means launcher acceptance, not proof that a window was read.

Observed author checks:
- pnpm check passed: /tmp/minu-codex-observations-check-final.log.
- 19/19 focused tests: /tmp/minu-codex-observations-focused-final.log.
- Earlier 125/125 affected cases: /tmp/minu-codex-observations-affected-1.log.
- One combined final Codex integration run: 855/855, normal concurrency, zero skips,
  /tmp/minu-codex-observations-codex-integration.log. The wider run was justified by
  shared worker authorization/control plumbing; no duplicate workspace run.
- All viewer spawning was stubbed; no desktop app/model/tool calls. One new test
  header-union TypeScript error was fixed before execution; initial compiler log
  /tmp/minu-codex-observations-check-3.log remains. No deadlines were increased.

Artifacts: /tmp/minu-codex-observations.diff,
/tmp/minu-codex-observations-source.sha256,
/tmp/minu-codex-observations-handoff.md,
/tmp/minu-codex-observations-baseline/. Baseline source/test matches approved
capabilities; document before-images preserve the current coordinator receipt.
No Core/Pi/consumer/dependency, native-history copy, recovery or process backend
change. Prior native/workspace evidence is reused only for unchanged behavior;
real GUI, other viewers/modes, remaining acceptance and full delivery stay open.

Batch coordination status (owner agreement, message 231): R31–R33 implementation
is complete; author reported `pnpm check`, 19/19 focused tests, 125/125 affected
cases, and one combined Codex integration run at 855/855. Artifacts are preserved
under `/tmp/minu-codex-observations-*`. R31–R33 was included in the combined normal
lifecycle/API/CLI batch review and accepted against
`/tmp/minu-codex-normal-batch-corrections-source.sha256`; see the finding-focused
correction record below. Continue remaining delivery work without treating
milestones as approval stops. Foreman coordinates scope, blockers and evidence-based
acceptance; no routine duplicate test runs or second technical review.

### Normal public API/CLI integration checkpoint (R34, author-verified)

- Added thin `@minu/runtime` factory/CLI package using the existing adapters and
  Commander dependency. Pi remains the default, not an error fallback. The shared
  package owns `minu-runtime`; the legacy Pi CLI module remains intact.
- Qualified `codex:<id>` references preserve CLI adapter identity across controller
  restarts; explicit conflicting selection rejects. Bare legacy Pi IDs keep their
  old routing. Every Codex session command requires the exact explicit owner.
- Added Codex `connectManaged`: existing ready-worker authentication only, reusing
  `reconnectCodexWorker`, without launch, resume epochs, repair or native allocation.
  Normal CLI reads/controls never implicitly cold-resume. Explicit resume retains
  existing verified Darwin history/retirement eligibility.
- Exposed managed creation/inventory/suspend/resume/destroy, existing control/history
  and streaming operations, caller turn IDs, launch discovery/choices, bounded local
  image input, sanitized profile/observations and explicit diagnostic opening.
  This adds no process framework, transcript, external dependency or Core contract.
- Author verification: `pnpm check`; nine focused API/CLI/fence cases; one additional
  follow success/rejection case; then one full workspace run **931/931**, normal
  concurrency, no skips. The workspace run includes Codex; no duplicate Codex run.
  Offline install, linked command help, package dry-run inventory and whitespace
  checks passed. Two test compiler mistakes and one incorrect expected error string
  were corrected with original logs retained. Initial prebuild bin-link warning was
  resolved by shipping a source launcher instead of pointing installation at an
  unbuilt file. No runtime test defect, deadline increase or concurrency reduction.
- All CLI boundaries used owned process fixtures, including first input, exact-owner
  rejection, image-only/duplicate turns, native input rejection, cold history resume,
  destroy and CLI-controller replacement. No actual desktop, paid inference or real
  model/tool call. Real-native lower-layer evidence is reused, not relabeled fresh.
- Artifacts: `/tmp/minu-codex-cli.diff`, `/tmp/minu-codex-cli-source.sha256`,
  `/tmp/minu-codex-cli-handoff.md` and baseline
  `/tmp/minu-codex-cli-baseline/`; R31–R33 artifacts remain separately preserved.

The normal lifecycle/API/CLI batch is accepted against
`/tmp/minu-codex-normal-batch-corrections-source.sha256` after the single independent
review and finding-focused correction recheck (APPROVE, message 255). This does not
complete explicit recovery/human fencing, platform/legacy
cold lifecycle, Conversations loading/shipped packaging/selection policy, generic
conformance, real model/tool acceptance or historical startup/Pi gates. The passing
workspace run does not explain those earlier failures. R01–R44 remain required. Owner direction (message 269): add Codex as an
adapter choice in the existing per-agent setup. The Channels source integration is
now independently approved (reviewer message 274); deployment/release acceptance
remains blocked until Runtime source is committed and the normal pin/release gates
are completed.

#### Finding-focused correction after the single batch review

The reviewer found two MEDIUM CLI defects: identity authentication queued behind
native preparation, and successful `--follow` closed observation before delayed
terminal delivery. Identity now uses the existing read-only authorization path;
pre/post reconnect identity checks and dispatched-interrupt fencing are unchanged.
Follow awaits both successful sending and terminal observation; send failure still
closes observation promptly, and premature stream end is an error.

Both unchanged verifier probes passed. Four permanent regressions cover real-CLI
preparation cancellation with wrong-owner rejection, delayed final output, prompt
send-failure closure, and premature stream end. Typecheck and **419/419 affected
cases** passed at normal concurrency with no skips. The earlier **931/931 workspace
run is reused**, not a fresh result after these corrections. No broad rerun, native
model/tool call or actual desktop launch. Correction artifacts are preserved under
`/tmp/minu-codex-normal-batch-corrections-*`; original review/failure evidence and
before-images remain intact. Finding-focused recheck approved both corrections with
no blocking findings (reviewer message 255).

### Channels per-agent source integration (R35–R37 source scope)

Codex is wired into the existing per-agent setup, preserving Pi as default and
existing Pi bindings. The reviewed source delta adds loader registration, adapter-
aware identity/routing, live-only managed reconnect on restoration, and isolated
bundled worker paths. Reviewer approved the 16-file source delta with no actionable
findings (message 274), against `/tmp/minu-codex-channels-source.sha256`.
Author reports `pnpm check`, web check, 170/170 affected backend tests and one
Chromium setup scenario. No real model/backend or production deployment was tested.

Release remains blocked: Runtime source needed by the pin is uncommitted in the
Runtime `feat/codex-adapter` checkout at base `86f8110`; the current release pin does
not contain it. A scoped reviewed Runtime commit and normal pin update, followed by
required release/artifact gates, are still needed. Do not bypass release gates or
claim production readiness. Recovery/human-resume fencing, real model/tool
acceptance and other R01–R44 requirements remain open.
