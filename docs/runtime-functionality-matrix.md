# Runtime functionality requirements

**All 44 items (R01–R44) remain required.**
This is a functionality requirement checklist, not an adapter comparison. Deliver
native R01–R41 first; R42–R44 remain required later-phase work. Missing required
implementation is unfinished work, not optional functionality.

The requirements apply to a complete Runtime integration. Optional methods in the
[`AgentRuntime` TypeScript interface][contract] preserve API compatibility; the `?`
does **not** make their product functionality optional. Requirements, delivery phase
and implementation progress are separate. ACP, native TUI attachment and interactive
approval UI (R42–R44) are scheduled after native delivery, not removed from scope.
MVP/KISS constrains implementation complexity; it does not by itself waive agreed
functionality. No owner-decision reference supporting their exclusion was found.

See the [implementation plan](codex-adapter-plan.md) for sequencing. This document
sets the completion target; individual implementation slices may deliver only part
of it. It does not claim the current Codex integration is complete.

## Required functionality

Everything in this section is **Required**.

### Execution and control

| ID | Functionality | Completion criterion |
| --- | --- | --- |
| R01 | Owned sessions and workspace — `start` | Start the selected native harness in the requested workspace with an unambiguous Runtime identity; validate launch and clean up failed startup. |
| R02 | Text input — `send` | Submit to an idle session, reject busy input, wait for settlement and surface failed/interrupted work rather than reporting success. |
| R03 | Stable turn IDs and lookup — `startTurn`, `turn` | Matching retries reuse the same retained turn; different input conflicts. Running and terminal results are recoverable within a documented, bounded retention window. |
| R04 | Session status — `status` | Report idle/working/offline consistently; specify and test unknown/unreachable-session behavior. |
| R05 | History and final response — `messages` | Return normalized textual history, preserve steering, deduplicate native echoes, distinguish commentary from final output and omit private native metadata/reasoning/image bytes. |
| R06 | Streaming events — `events` | Stream status, response text and tool lifecycle through the worker/consumer boundary; correlate the correct session/turn and bound slow-reader resources. |
| R07 | Safe activity — `activityEvents` | Expose only the curated phase/timestamp vocabulary, coalesce repeated observations and honor cancellation without exposing raw agent/tool content. |
| R08 | Active guidance — `steer` | Target the current active turn at the harness's safe boundary; reject idle/settled targets and fence late control operations from subsequent turns. |
| R09 | Interruption — `interrupt` | Interrupt active work; distinguish acknowledgment from actual settlement. Never imply tool-side-effect rollback. |
| R10 | Stop — `stop` | Stop only an eligible owned session and meet its documented shutdown confirmation. Managed stop preserves resume material; externally attached sessions cannot be terminated by Runtime. |

### Durable sessions, safety and recovery

| ID | Functionality | Completion criterion |
| --- | --- | --- |
| R11 | Owner-scoped durable creation — `startManaged` | Persist a stable Runtime ID and launch configuration in the exact owner's scope; distinguish saved configuration from verified native readiness. |
| R12 | First-input lifecycle | Do not allocate a lazy native thread before valid first input. Validate launch, create at most once under contention, record the exact native binding before dispatch and preserve crash uncertainty. |
| R13 | Session inventory — `listManagedSessions` | List only the exact owner's sessions using sanitized active/suspended/unavailable summaries; never expose raw manifests or silently omit corrupt registrations. |
| R14 | Idle suspension — `suspend` | Preserve identity/history and atomically reject busy admission races; status-check-then-stop alone is insufficient. |
| R15 | Resume — `resume` | Reopen the same mapped native history with the same Runtime ID; verify owner/workspace/policy, reuse an already-live worker and refuse corrupt or ambiguous resume material. |
| R16 | Non-destructive destruction — `destroy` | Stop the eligible worker and remove Runtime resume metadata without deleting native history; preserve busy/ownership safeguards. |
| R17 | Consumer reconnect | A consumer restart can rediscover an existing living worker and recover its retained running/terminal turns without redispatch. |
| R18 | Worker registration and replacement fencing | Persist authenticated worker identity and generation; prevent stale controllers/connections or concurrent lifecycle operations from authorizing a second active worker. |
| R19 | Explicit recovery — `forceStopManaged` | Recover a busy/unreachable exact-owner worker, confirm the required physical exit and protect unrelated sessions; fail closed if process/group ownership cannot be verified. |
| R20 | Human-resume fence | Explicit recovery stops automatic/stale resume until an explicit human-authorized resume; a failed resume must not clear the fence. |
| R21 | Safe persistence and locking | Use owner-private bounded storage, immutable identities, revision checks and crash-safe publication/serialization; reject unsafe links, permissions and unsupported formats without silent repair. |
| R22 | Worker-loss and uncertain-input handling | Preserve unavailable/uncertain states; never fabricate native history, silently replace a bound thread or blindly replay input whose dispatch outcome is unknown. |

Turn idempotency has a documented retention/lifetime boundary. Durable native
history does not by itself provide a durable caller-turn ledger or exactly-once
tool execution. Reconnect, native resume and uncertain-input recovery must be
tested as separate guarantees.

For lazy Codex creation, `pending` means no creation attempted; `creating` means
uncertain allocation; `bound` means one native ID was recorded—not that a first
turn completed or an empty native thread is resumable.

### Configuration, discovery and input

| ID | Functionality | Completion criterion |
| --- | --- | --- |
| R23 | Persona/system instructions | Support append and replacement modes while preserving native semantics; reject conflicting modes. |
| R24 | Launch discovery — `capabilities` | Discover models, supported reasoning, selectable skills and verified effective defaults without exposing credentials or native paths. |
| R25 | Exact model/reasoning selection | Validate explicit selections and fail unsupported/mismatched choices; never silently fall back. Not every model must implement every reasoning level. |
| R26 | Skill selection | Enforce an explicit selected skill set, including an empty set disabling discovered skills; omission preserves documented harness defaults. Discovery alone does not satisfy selection. |
| R27 | Image input | Carry ordered typed pixels to a verified vision-capable model; enforce MIME/base64/count/byte bounds, image-aware turn identity, cancellation and no pixel leakage through polling/events. Reject genuinely incompatible models rather than drop images. |
| R28 | Honest live capabilities — `inputCapabilities`, `sessionCapabilities` | Query the current session/model; advertise only verified support and return honest unavailability. Missing implementation is not evidence that the native harness lacks a feature. |
| R29 | Native authentication and integrations | Honor the harness's authorized configuration, skills/extensions/plugins and MCP setup; ensure the actual worker receives required environment credentials without provisioning secrets or treating skills as authorization grants. |
| R30 | Explicit execution/interaction policy | Apply the requested sandbox/trust policy without bypass. Unexpected interactive requests must fail clearly instead of hanging, auto-approving or fabricating user answers. |

A required feature may have genuine model/host/version eligibility conditions.
For example, a text-only model cannot consume pixels, and a host may lack a local
diagnostic viewer. Implementing the feature and handling those conditions safely
is required; returning `false` everywhere because the implementation is missing
does not complete the requirement. No requirement implies identical native tools,
permissions, extension APIs or model behavior across harnesses.

### Observation and diagnostics

| ID | Functionality | Completion criterion |
| --- | --- | --- |
| R31 | Live session profile — `inspectSessionProfile` | Read bounded, exact-owner evidence of the existing worker's model/reasoning/skill-command identifiers without waking it or falling back to saved launch config. Mark unavailable fields honestly. |
| R32 | Structured session observations — `inspectSessionEvents` | Read a bounded, ordered, sanitized bridge-event snapshot with capture/eviction semantics; no raw logs, prompts, tool payloads, writes or implied downstream delivery confirmation. |
| R33 | Local diagnostic action — `openDiagnostic` | Explicitly open an eligible adapter-owned bounded/private diagnostic using a verified local viewer; do not return raw paths/content or fabricate success. |

Skill discovery/command evidence is not proof that instructions were loaded or used
on a turn. Required profile/capability reporting must not claim that stronger proof
without supporting evidence.

### Consumer integration and acceptance

| ID | Functionality | Completion criterion |
| --- | --- | --- |
| R34 | Standalone CLI | Select and operate the intended adapter; expose supported lifecycle/control functions without a hidden hardcoded harness choice. |
| R35 | Conversations integration and packaging | Wire the adapter into the application loader and shipped package; expose required launch choices and lifecycle behavior through the actual consumer. |
| R36 | Adapter-aware identity and routing | Persist adapter identity, scope model/skill choices correctly and route only to the intended session. Preserve existing bindings rather than reinterpret their IDs under another adapter. Owner direction: expose adapter selection in the existing per-agent setup; preserve routing and identity safeguards. |
| R37 | End-to-end restart/delivery behavior | Exercise consumer restart, worker loss, explicit resume/recovery and routing through public APIs; fence stale delivery and never confuse native settlement with successful public response delivery. |
| R38 | Shared conformance tests | Run common execution, state, history, retry, control and ownership scenarios against each complete integration; specify session modes and observable error/status semantics. Interface type-checking alone is insufficient. |
| R39 | Failure/race verification | Exercise real process/network/filesystem boundaries, concurrent lifecycle operations, wrong owners/generations, startup/shutdown failures, disconnects and uncertain outcomes; demonstrate isolation from other sessions. |
| R40 | Native integration acceptance | Record controlled native startup, model/tool execution, persistence/resume and shutdown evidence for supported versions/platforms. Protocol fixtures and a fake provider are useful but are not real model/tool acceptance. |
| R41 | Delivery evidence and independent assessment | Record source revision, supported environment, relevant regression/build/package results, independent assessment and limitations. Test counts or a partial checkpoint approval do not establish product completion. |

Existing supported session modes must not regress. Native TUI/externally attached
mode, where present, has different control permissions from Runtime-owned mode;
conformance tests must not assume that every session may be stopped or relaunched.

## Required later-phase functionality

R42–R44 remain required after native R01–R41. Native milestone completion is not
completion of this later-phase scope. Existing supported session modes and
ownership safeguards must still be preserved.

| ID | Functionality | Completion constraints |
| --- | --- | --- |
| R42 | Generic ACP adapter/interoperability | Preserve Runtime ownership, lifecycle and safety guarantees; not a protocol switch for the current native adapters. |
| R43 | Native interactive TUI attachment and registration of externally started native sessions | Verify attachment/detachment and capabilities; preserve existing attached sessions and never grant Runtime stop authority over externally owned sessions. |
| R44 | Interactive approval/user-answer UI | Tie explicit human answers to the correct session/turn with cancellation and bounded waiting; never fabricate approval or answers. |

Without an approval UI, headless permission/user-answer requests must still fail
clearly and safely rather than hang, auto-approve or fabricate answers (R30).

## Implementation progress — separate from requirements

Snapshot: `feat/codex-adapter` working tree based on `86f8110`. The integrated
**Darwin managed suspend/resume, R16 destroy MVP and R24–R28 launch/input
capabilities are independently approved**, including the finding-driven corrections. Earlier execution, ownership,
registration, fencing, streaming and privacy approvals remain intact.
Latest complete approved Codex source/test/fixture snapshot:
`/tmp/minu-codex-approved-capabilities.sha256`.
Latest reviewed behavior target, including its then-current documentation:
`/tmp/minu-codex-capabilities-source.sha256`.

- New Darwin managed sessions use v5. Clean idle suspend seals admission, captures
  bounded native-history identity, confirms owned native shutdown and same-domain
  worker absence, then verifies persisted history before publishing eligibility.
- A fresh controller can resume the same Runtime ID/native thread through one
  guarded generation transition, preserving history and permitting one worker.
  Codex remains the transcript source of truth; Runtime stores only bounded
  validation/predecessor data. No input replay or durable caller-turn ledger.
- Inventory is sanitized/read-only. Ambiguous, fenced, incomplete or corrupt
  material stays unavailable. Existing v4 and other-platform controls remain
  compatible, without migration/enrollment; their cold lifecycle remains unsupported.
- Actual-controller-restart fixtures cover repeated turns/suspend/resume. Controlled
  Codex 0.167.0 evidence covers two turns, fresh-adapter resume and preserved history
  against a loopback provider, not paid/external model or actual tool acceptance.
- The HIGH resumed-startup cleanup leak is resolved: ownership survives complete
  lock return and bridge handoff. Unconfirmed cleanup remains failure; ready/adopted
  workers are not revoked. This completes the approved Darwin R14/R15 path, not the
  whole R11–R22 lifecycle/recovery scope or universal platform/legacy support.
- Non-destructive `destroy` (R16) is independently approved for verified clean
  suspension and never-launched pending metadata. Active
  sessions reuse the existing idle suspend path; metadata removal uses the same
  owner/session lock, exact revision and generation. Native history and lock domains
  are retained; busy/uncertain/fenced and stale-generation attempts fail closed.
  Active v4 and unsupported-platform destruction remain unavailable rather than
  acquiring new recovery authority. Explicit recovery/fences,
  CLI/Conversations, shared conformance and remaining acceptance work stay required
  and unfinished.
- R31–R33 live profiles/structured observations and managed local diagnostics are
  implemented, pending behavior-level independent review. Profiles use only current
  worker/native acknowledgment evidence; missing or unrepresentable fields remain
  not_verified, with no discovery/config fallback. Core event codes retain the last
  200 observations with explicit capture/eviction semantics. Reads are owner/fence-
  checked, cancellation/byte/time bounded and do not wake or stop native work.
  Explicit diagnostic snapshots are sanitized/private, separate from resume/native
  history, and use a verified fixed system viewer. Current viewer support is macOS
  desktop managed sessions only; unsupported/headless/direct modes fail honestly.
- Native launch/input (R24–R28) is independently approved: native catalog/default
  discovery, per-thread exact/empty skill selection,
  per-model reasoning validation, bounded ordered image transport/turn identity,
  authenticated live observations and unavailable-versus-incompatible distinction.
  Explicit discovery alone owns one ephemeral thread; lazy/live queries never do.
  Custom text survives missing catalog metadata; unverified reasoning/vision is not
  advertised. Global skills are not claimed as verified live per-thread state.
- Earlier intermittent startup/Pi failures remain unexplained by the passing
  workspace run. Real model/tool, descendant/group recovery, power-loss durability
  and complete delivery acceptance are not supplied by this milestone.
- R42–R44 wording is restored to the earlier required later-phase scope. The
  conflicting exclusion had no supporting owner-decision reference; neither MVP/KISS
  guidance nor a technical milestone approval authorizes a product-scope reduction.

### Evidence currently recorded

- R31–R33 author implementation: typecheck, **19 focused observation/diagnostic tests**,
  **125 affected cases** at an earlier build and **855/855 final Codex tests** passed
  at normal concurrency, zero skips/failures. Desktop spawning was stubbed; no apps,
  model/tool calls, full workspace or real GUI acceptance was attempted. Profile
  identity versus changed saved settings, code privacy/eviction, unbound reads,
  cancellation/physical slots, deadline/byte limits, fences and verified private
  diagnostic/viewer failure boundaries were exercised. One new test header type
  error was corrected before execution; its log is preserved. Existing wider
  workspace/native evidence is reused only for unchanged paths. Artifacts:
  `/tmp/minu-codex-observations-{source.sha256,diff,handoff.md}`. Independent review
  remains pending; this does not approve full adapter/release completion.

- R24–R28 independent approval (message 228): the provider-input regression is
  resolved, with typecheck, six focused regressions, the unchanged Codex 0.167.0
  provider probe, final snapshot, exact correction and whitespace checks passed.
  Initial integrated review passed 325 affected cases and the managed-image/uncertainty
  probes. Explicit provider strings remain literal/bounded without weakening exact
  native acknowledgment or public discovery privacy. Managed image rejection no
  longer strands valid text; lock-return/dispatch uncertainty still fails closed.
  Earlier 824-Codex, 318-image-correction, 94-provider-correction and controlled-native
  evidence is reused at its recorded scope, not a fresh whole-suite/workspace run.
  Approved source/test locator: `/tmp/minu-codex-approved-capabilities.sha256`.
  This receipt changes documentation only, with no source edits or tests. Remaining
  native, recovery, consumer, conformance, real-model/tool and historical gates remain.
- R24–R28 implementation-stage evidence (retained; predates final corrections): final typecheck and **824/824
  Codex tests** at normal concurrency/zero skips passed. The real Codex 0.167.0
  loopback-provider loop verified ephemeral discovery without persisted history or
  model calls, exact selected skills, pixels, live vision, cold history and metadata-
  only destroy with exactly two synthetic Responses calls and no real tools. Earlier
  failed runs remain recorded: public preparation cancellation waited behind auth's
  allocation lock; the 34-MiB frame expansion exposed quadratic prefix processing;
  two old assertions still rejected newly supported input/config. Narrow fixes
  retained deadlines, ownership/fences and bounded transports. A later fixture-only
  duplicate model row invalidated its unsupported-reasoning assertion and left a
  test-owned process alive on unexpected success; the timeout log is preserved,
  metadata deduplicated and failure cleanup fixed without weakening assertions.
  Native failure diagnostics are generic even for text after earlier images, so
  historical pixels cannot leak via native error snapshots. No paid/external
  model, complete workspace rerun or full release acceptance is claimed. Artifacts:
  `/tmp/minu-codex-capabilities-{source.sha256,handoff.md,diff}`.

- R16 destroy MVP: independent typecheck and **271/271 storage/public tests** passed
  at normal concurrency/zero skips, with complete hashes, approved source/test
  before-images, exact patch and whitespace checks. Metadata-only deletion preserves
  native history and lock identity; owner/busy/generation/race/uncertainty safeguards
  passed. Eligible clean suspension and never-launched pending metadata only; active
  v4/non-Darwin and uncertain/stopped-without-receipt cases remain unsupported. Author
  72/72 final public tests plus 504 other affected passes are separate evidence; the
  original obsolete availability assertion failure remains documented. Reviewed
  target: `/tmp/minu-codex-destroy-source.sha256`; approved source/test locator:
  `/tmp/minu-codex-approved-destroy.sha256`. No source edits or extra test cycle for
  this receipt; prior workspace/native evidence reused, not rerun. Not full delivery.
- Integrated Darwin suspend/resume: independent integration approval after one HIGH
  startup-cleanup correction. Independent typecheck, **366/366** affected tests
  (including five permanent regressions), **3/3 unchanged cleanup reproductions**,
  complete snapshot, reviewed source/test before-images, exact patch and whitespace
  passed. Each original reproducer now observes one native-stop attempt and both
  processes exited; uncertain cleanup and durable readiness/adoption are covered.
  Author **782/782 Codex**, **850/850 workspace** and controlled-native evidence
  predate the correction and were reused, not rerun or claimed as fresh. The red
  three-probe log and initial harness failures remain preserved. Final reviewed
  target: `/tmp/minu-codex-lifecycle-cleanup-source.sha256`; source/test-only approved
  locator: `/tmp/minu-codex-approved-lifecycle.sha256`. Receipt changes documentation
  only; no source edits or extra test cycle. No overall product/release acceptance.
- Private controller absence/finalization 2b9a.2h: author typecheck and **449/449**
  storage/registration/pending-worker tests passed at normal concurrency, zero
  skips. Coordinator typecheck and **40/40** focused cases passed, including the
  redacted unmocked Darwin pending-fixture retirement/disappearance/fresh-finalization
  boundary. Complete snapshot, exact three-file patch and scoped whitespace checks
  passed. Initial **58/60** fixture setup failures are preserved: native binding
  preceded worker reservation; moving binding after readiness/correlation and before
  intent passed **2/2** corrected cases without changing store safeguards. Target:
  `/tmp/minu-codex-2b9a2h-source.sha256`; handoff:
  `/tmp/minu-codex-2b9a2h-handoff.md`. Independent assessment approved **2b9a.2h
  only**: typecheck, **449/449** required tests at normal concurrency/zero skips,
  unmocked redacted Darwin round trip, before-images/snapshot/exact patch/whitespace
  passed. Approved snapshot: `/tmp/minu-codex-approved-2b9a2h.sha256`. Receipt is
  documentation/hash-only, without source changes or another test cycle. No
  production-v5 switch, public suspension/history/resume, recovery or real-native/
  workspace acceptance; unchanged-layer evidence is reused and existing gates stay open.
- Private retirement/publication-gated closure 2b9a.2g: final author typecheck and
  **477/477** required affected tests passed at normal concurrency/zero skips,
  including worker-events and public v4 controls. Coordinator typecheck and **39/39**
  focused new cases passed, with complete hashes, exact six-file patch and scoped
  whitespace checks. Initial **35/36** focused preparing-work failure is preserved:
  redundant owner preflight locking delayed busy rejection behind allocation; the
  read-only-preflight correction retains authoritative producer locks/callback checks
  and passed 3/3 focused regressions. A test-only typecheck fix and later receiver-
  compatibility fix are recorded; final 477-test evidence is from the corrected
  target, not its earlier full pass. Independent assessment approved **2b9a.2g
  only**: typecheck, 477/477 required tests at normal concurrency/zero skips, 2/2
  HTTP stop/retirement barrier probes, paused-preparation correction and baseline/
  snapshot/exact patch/whitespace checks passed. Approved snapshot:
  `/tmp/minu-codex-approved-2b9a2g.sha256`. No source changes or extra test cycle
  accompany the receipt. No controller absence/finalization, v5 switch, public
  suspension/history/resume or real-native/workspace acceptance.
- Worker-local native-fact producer 2b9a.2f: author typecheck and **373/373** storage/
  registration/pending-worker tests passed at normal concurrency. Coordinator
  typecheck and **28/28** selected evidence/capture/uncertainty/duplicate/fence cases
  passed, with complete hashes, exact two-file patch and scoped whitespace checks.
  Independent assessment approved **2b9a.2f only**: typecheck, 373/373 affected
  tests at normal concurrency/zero skips, baseline/snapshot/exact patch/whitespace
  checks passed. Approved snapshot: `/tmp/minu-codex-approved-2b9a2f.sha256`.
  No initial runtime/typecheck failure is reported; no source changes or extra test
  cycle accompany the receipt. Existing launch/collector and native client/RPC
  approvals are reused; no worker-exit/public wiring, production-v5 switch or
  history/real-native/workspace acceptance is claimed. Prior gates remain open.
- Explicit-v5 launch-domain correlation 2b9a.2e: author typecheck and **395/395**
  affected tests passed at normal concurrency, including the redacted unmocked
  Darwin launcher/worker round trip. Coordinator typecheck and **28/28** selected
  wiring/correlation/fencing/adoption/uncertainty/compatibility cases passed,
  including that real Darwin boundary, zero skips, with complete hashes, exact
  five-file patch and scoped whitespace checks. Independent assessment approved
  **2b9a.2e only**: typecheck, 395/395 affected tests at normal concurrency/zero
  skips, redacted unmocked Darwin wiring, baseline/snapshot/exact patch/whitespace
  checks passed. Approved snapshot: `/tmp/minu-codex-approved-2b9a2e.sha256`.
  No initial test/typecheck failure is reported for this increment. V4 defaults
  remain unchanged; no source changes or extra test cycle accompany the receipt.
  No production switch, native-fact/worker-exit workflow or public suspension/
  history/resume is claimed. Matching observations rely on the accepted local-host
  assumption, not deployment/namespace attestation or exit proof. Prior startup/Pi
  and integration gates remain open.
- Internal seal/intent/shutdown seam 2b9a.2d: author typecheck and **295/295**
  storage/registration/pending-worker tests passed at normal concurrency. Coordinator
  typecheck and **26/26** selected capability/drain/uncertainty/admission/stop/fence
  cases passed, with complete hashes, exact two-file patch and scoped whitespace
  checks. Independent assessment approved **2b9a.2d only**: typecheck, 295/295
  affected tests, 2/2 capability/lock-return probes, baseline/snapshot/exact patch/
  whitespace checks passed. Approved snapshot:
  `/tmp/minu-codex-approved-2b9a2d.sha256`. The handoff retains the initial rename-
  mock TS7006 correction; no runtime failure is reported for this increment. V4
  defaults remain unchanged; no source edits or extra test cycle accompany the
  receipt. No production provenance/native-fact/worker-exit workflow, public
  suspension, history/cold resume, broad workspace or real model/tool acceptance
  is claimed.
- Remaining retirement-assertion storage/CAS 2b9a.2c3: author typecheck and
  **254/254** affected tests passed at normal concurrency. Coordinator typecheck
  and **28/28** selected schema/correlation/fence/replay/bypass/publication cases
  passed, with complete hashes, exact two-file patch and scoped whitespace checks.
  Independent assessment approved **2b9a.2c3 only**: typecheck, 254/254 affected
  tests, a synthetic-retirement consumer-boundary probe, baseline/snapshot/exact
  patch/whitespace checks passed. Approved snapshot:
  `/tmp/minu-codex-approved-2b9a2c3.sha256`. Data assertions/private retired
  records do not establish actual shutdown/exit, authenticated producers, public
  suspension or history/resume acceptance. V4 defaults remain unchanged; no source
  changes or extra test cycle accompany the approval receipt.
- Retirement-intent storage 2b9a.2c2: author typecheck and **198/198** storage/
  registration/pending-worker tests passed at normal concurrency. Coordinator
  typecheck and **12/12** selected intent/CAS/fencing/bypass/publication cases
  passed, with complete submitted hashes, exact two-file patch and whitespace
  checks. Independent assessment approved **2b9a.2c2 only**: typecheck, 198/198
  affected tests, a lazy-actor/ordinary-consumer fencing probe, baseline/snapshot/
  exact patch/whitespace checks passed. Approved snapshot:
  `/tmp/minu-codex-approved-2b9a2c2.sha256`. This is correlated intent only—not
  actual idle/seal, native quiesce, worker exit, completed retirement or public
  lifecycle acceptance. V4 defaults are unchanged; no extra test/broad cycle.
- V5 correlation storage 2b9a.2c1: author typecheck and **112/112** storage/
  registration tests passed at normal concurrency. Coordinator typecheck and
  **7/7** selected CAS/replay/fenced-history/snapshot/publication cases passed,
  with complete submitted hashes, exact two-file patch and whitespace checks.
  Independent assessment approved **2b9a.2c1 only** after typecheck, 112/112
  storage/registration tests and 2/2 additional workflow probes, with baseline/
  snapshot/exact patch/whitespace checks. A review-only factory return-shape
  assumption was corrected and preserved in the plan; no source correction or
  assertion waiver was involved. Approved snapshot:
  `/tmp/minu-codex-approved-2b9a2c1.sha256`. V4 defaults remain unchanged; no
  retirement, producer/public wiring, independent provenance or worker-exit proof
  is implemented/approved here. No extra test cycle/broad acceptance is claimed.
- Private 2b9a.2b PID-slot observer: author and coordinator each passed typecheck
  and **50/50** focused tests, zero skips, including actual owned-fixture Darwin
  presence/absence. The submitted snapshot/patch and scoped whitespace match; all
  prior approved source entries remain unchanged and only two allowed new files
  were added. Independent assessment approved **2b9a.2b only**: typecheck, 50/50
  focused tests with zero skips, actual Darwin owned-fixture checks, prior hashes,
  complete snapshot/exact patch and scoped whitespace checks passed. Approved
  snapshot: `/tmp/minu-codex-approved-2b9a2b.sha256`. No worker identity, deployment/
  namespace, authenticated shutdown/exit, lifecycle or broad-workspace acceptance
  is claimed; no new test cycle accompanies this approval receipt.
- Unwired 2b9a.2a collector: author and coordinator each passed typecheck and
  **40/40** focused tests, zero skips, including real Darwin parent/owned-fixture
  observations and owned-query timeout/overflow cleanup. Only three authorized new
  files were added; prior approved sources are unchanged and all new files are in
  `/tmp/minu-codex-2b9a2a-source.sha256`. Independent assessment approved this
  observation-only checkpoint after typecheck, 40/40 tests, installed/matching-XNU
  source-semantics checks, prior hashes/exact patch and scoped whitespace checks.
  Approved snapshot: `/tmp/minu-codex-approved-2b9a2a.sha256`. Redacted OS/version/
  semantics evidence: `/tmp/minu-codex-2b9a2a-os-evidence.md`. The initial parser-
  layout failure was classified/corrected, not hidden by the final pass. No
  deployment/namespace/exit, public lifecycle or broad-workspace acceptance is
  claimed; no new test cycle accompanies the approval receipt.
- Worker-local 2b9a.1 author typecheck and **41/41** pending-worker tests passed at
  normal concurrency. Coordinator typecheck, **8/8** selected authority/admission/
  shutdown-interleaving tests, hashes, exact two-file baseline diff and whitespace
  checks passed. Independent assessment approved **2b9a.1 only**: typecheck,
  **41/41** pending-worker tests, **5/5** additional authority/fencing probes,
  before-images/exact patch, snapshot and scoped whitespace checks passed.
  `/tmp/minu-codex-approved-2b9a1.sha256` matches the submitted source snapshot;
  this does not implement or approve public suspension/retirement/resume and is
  not a new broad/full-workspace or real-native acceptance pass.
- A failed agent turn left a 2b8 streaming draft and
  [handoff](codex-managed-streams-2b8-handoff.md) on disk. Coordinator hashes match
  the saved draft; it is preserved, not approved or rewritten. The saved author
  log reports 248/248, not a new coordinator/independent test result. The owner
  requested smaller chunks: review/repair 2b8a worker-source primitives first,
  then server, client and public integration; no whole-2b8 approval is implied.
- Source-only 2b8a review requested changes for array-valued status acceptance.
  The coordinator corrected the string guard and added three direct regressions
  (red before / green after); typecheck, **4/4** focused validator/queue tests and
  **13/13** unchanged source-only probes passed. Independent reassessment approved
  **2b8a only**, closing the finding. Reviewed-tree hash locator:
  `/tmp/minu-codex-2b8a-reviewed-tree.sha256` is not whole-tree approval. Server
  cleanup findings were subsequently closed; client/public streaming and final
  integration remain unapproved.
- Server-only 2b8b review requested changes for two resource-cleanup defects:
  backpressure timeout retained a stalled live socket, and disconnect during
  initial authorization still opened a late source/second authorization. Six server
  tests and 13 bridge tests passed, but direct HTTP probes had two failures/two
  passes. The bounded correction must close only the failed transport, install
  early cancellation and preserve pending-auth accounting; later checkpoints stay
  unreviewed. See the [handoff](codex-adapter-plan.md#2b8b-server-cleanup-correction--bounded-rework-handoff).
- Returned 2b8b correction: two server files and five new direct HTTP regressions.
  Author checks passed **18/18** server/bridge and **6/6** existing boundary tests;
  coordinator typecheck, hashes and **4/4** unchanged direct HTTP probes passed.
  Stalled-reader connections/queued bytes are now zero and initial-auth cancellation
  opens no late source. Independent reassessment approved **2b8b only**, closing
  both findings with 18/18 server/bridge, 6/6 boundary and 4/4 unchanged probes passing.
  Locator: `/tmp/minu-codex-2b8b-reviewed-tree.sha256` is not full-tree approval;
  no public/whole-2b8 or broad-suite acceptance is claimed.
- Client-only 2b8c review requested changes: queue overhead rejects the top 21 bytes
  of otherwise legal wire frames. Typecheck and 18 focused reader tests passed,
  but a real-bridge/native-fixture maximum-frame probe failed after native work
  completed. The shared-helper interaction needs separate wire/queue accounting
  and exact-limit/plus-one regressions without relaxing either bound. Public wiring
  and final integration remain unreviewed; see the [correction scope](codex-adapter-plan.md#2b8c-frame-accounting-correction--bounded-rework-handoff).
- Returned 2b8c accounting correction: only the shared queue accounting changed in
  production; wire length and the unchanged 32-byte queue charge are separate.
  Author **12/12** boundary and **22/22** helper/reader checks passed. Coordinator
  hashes, typecheck and the unchanged real-bridge maximum-frame probe passed.
  Independent reassessment approved **2b8c only**, closing the finding with 12/12
  boundary and 22/22 helper/reader checks passing. Locator:
  `/tmp/minu-codex-2b8c-reviewed-tree.sha256` is not whole-tree approval.
- Coordinator 2b8d integration check on that unchanged tree: typecheck and **275/275**
  Codex tests passed at normal concurrency, with no skipped tests, before the
  privacy correction/final approval below. This is not a full-workspace run and
  does not classify earlier startup failures or close the separate Pi gate.
- Independent 2b8d review requested changes for raw decoder text exposed through
  safe-activity errors, despite 275/275 tests passing. Coordinator sanitized the
  activity catch path with a fresh fixed error/no raw cause and added three canary
  regressions (red then green). Typecheck, 10 focused activity/cancellation tests
  and two selected unchanged public privacy/gap probes passed. Raw diagnostics and
  failure-versus-cancellation semantics remain distinct. Independent reassessment
  approved **2b8d**, repeating typecheck, 10/10 focused tests, 2/2 selected unchanged
  probes, snapshot and scoped whitespace checks. This completes bounded 2b8
  streaming; prior 275-test evidence is reused, not a fresh broad/full-workspace
  pass. The approved snapshot matches the privacy-source locator. No full lifecycle,
  native model/tool or release acceptance is implied; existing gates stay open.
- 2b7 [implementation handoff](codex-managed-entry-2b7-handoff.md): public managed
  entry/living-worker routing is approved after the correction below. Author checks passed
  **207/207** affected tests at normal concurrency; coordinator source hashes,
  typecheck and **30/30** public managed tests passed. New process-boundary tests
  cover consumer exit/reconnect and retained turns without replay. No complete
  lifecycle, full-workspace, native model/tool or Conversations acceptance is claimed.
- Initial independent 2b7 review: **REQUEST_CHANGES — MEDIUM**. Typecheck and **207/207**
  affected tests passed, but both additional stop-interleaving probes failed:
  concurrent stop returned 409, and a previously started resume overwrote confirmed
  stop state for the same worker. Shared pending/confirmed state without caching
  failed shutdown as success, regressions and reassessment were required. See the [bounded correction](codex-adapter-plan.md#2b7-stop-confirmation-correction--bounded-rework-handoff).
- Returned 2b7 stop correction: two-file exact-worker binding/pending-stop state
  preservation and seven regressions. Author public tests passed **37/37**;
  coordinator typecheck, both unchanged stop-interleaving probes, hashes and
  whitespace checks passed. Independent reassessment **approved 2b7**, with **37/37**
  public tests and both unchanged stop probes passing; the finding is closed.
  Approved snapshot: `/tmp/minu-codex-approved-2b7.sha256`. No new broad/full-workspace
  or complete managed-lifecycle acceptance is claimed.
- 2b6 [implementation handoff](codex-registration-2b6-handoff.md): version-4 private
  registration, launch claims and authenticated living-worker reconnect are
  now independently approved internally after the corrections below. The coordinator verified the
  author's source hashes, typecheck and **86/86** affected storage/pending-worker/
  bridge/registration tests at normal file concurrency. Earlier author parallel
  eager-worker startup failures remain unclassified despite this passing run; no
  new full-workspace or native acceptance result is claimed.
- Initial independent 2b6 assessment: **REQUEST_CHANGES — HIGH**. Typecheck and **86/86**
  affected tests passed, but two additional concurrent-adopter probes failed:
  controller timeout or IPC disconnect before confirmation terminated an already
  adopted worker, losing its retained results while leaving ready/bound records.
  That assessment required both cleanup paths to be corrected and regression-tested;
  its findings were subsequently closed. Evidence and the bounded rework handoff are in the
  [plan](codex-adapter-plan.md#finding-driven-2b6-rework-handoff).
- Returned 2b6 correction: shared locked/CAS pre-ready abort and concurrent-adopter
  regressions. Author checks passed **29/29** registration and **113/113** affected
  tests at normal concurrency. The coordinator verified the new snapshot, passed
  typecheck and both supplied race assertions with a cleanup-only `child.ref()`
  harness copy; the original probe/assertions are preserved.
- Independent 2b6 reassessment closed the HIGH adoption/cleanup finding. Typecheck,
  **113/113** affected tests and both original adoption probes passed. One **MEDIUM**
  finding remained: fresh aborts ignored persisted generation/explicit-resume fences;
  two independent probes granted cleanup and incremented revision after those
  fences changed. Selector and direct lease guards plus persisted-fence regressions
  were required before approval. See the [bounded handoff](codex-adapter-plan.md#fresh-abort-fence-correction--bounded-rework-handoff).
- Returned fresh-abort correction: two-file selector/lease guards and four persisted-
  fence/idempotency regressions. Author registration checks passed **33/33**;
  coordinator typecheck, **26/26** storage tests, unchanged independent fence probes
  and source hashes passed. Final independent reassessment **approved 2b6**, with
  **59/59** storage/registration tests at normal concurrency and both unchanged fence
  probes passing; both findings are closed. Approved snapshot:
  `/tmp/minu-codex-approved-2b6.sha256`. No new full-workspace/public lifecycle
  acceptance is claimed.
- Latest author checks (2b5 finding-driven rework): typecheck and **24/24 pending-
  worker tests passed**. Startup/binding cleanup failures now cover retained failed
  lookup/matching retries without relaxing identity fences, admitting new work or
  claiming an unconfirmed native shutdown succeeded.
  The full workspace run passed **218/219** (all 151 Codex tests passed) and exposed
  an unchanged-baseline Pi readiness-file JSON-read race. One isolated Pi run passed
  6/6, and a targeted partial-read probe reproduced the race. The plan records logs,
  source-hash comparison and the outstanding workspace gate; no green full-run claim.
  The earlier 195/195 result belongs to 2b4, not this delta.
- Independent 2b5 assessment initially requested changes for inaccessible retained
  failed turns despite 151/151 Codex tests passing. After rework, **37/37 worker/
  bridge tests**, typecheck, the previously failing lookup/retry probe and whitespace
  checks passed; the verifier approved the internal checkpoint with no actionable
  findings. No fresh full-workspace run. The independently confirmed Pi readiness
  race remains an open integration gate.
- Independent 2b4 assessment: **107/107 focused tests** plus eight additional
  fault/fencing probes passed. Approval is for that internal checkpoint only;
  the independent reviewer did not rerun the full workspace suite.
- Existing [execution tests][execution-tests], [worker tests][worker-tests],
  [storage tests][storage-tests], [allocation tests][allocation-tests] and
  [pending-worker tests][pending-worker-tests] protect implemented slices. They are
  not one generic black-box conformance suite. The owner requested Codex build-out
  first, then that required generic suite; feature-specific tests continue now.
- Codex `0.160.0` has reviewer-reported native persistence/resume evidence using a
  localhost fake provider; `0.167.0` has startup/binding/stop evidence without a
  model turn. Neither establishes real model/tool acceptance. The plan records
  the temporary plugin-clone cleanup permission failure in the latter smoke.
- Earlier native smoke evidence is historical, not real model/tool acceptance or
  approval of public managed lifecycle. No native model/tool calls were made for 2b5.

### Required completion checklist

- [x] Independently assess the bounded internal first-input worker (2b5 only).
- [x] Independently assess internal durable registration (2b6); both findings closed.
- [x] Independently assess bounded public entry/living-worker routing (2b7).
- [x] Independently assess bounded managed events/activity streaming (2b8a–2b8d).
- [x] Independently assess worker-local idle quiescing (2b9a.1; not public suspend).
- [x] Independently assess unwired Darwin OS observations (2b9a.2a; not exit proof).
- [x] Independently assess private Darwin PID-slot facts (2b9a.2b; not worker proof).
- [x] Independently assess v5 correlation storage (2b9a.2c1; not retirement).
- [x] Independently assess retirement-intent storage (2b9a.2c2; not shutdown proof).
- [x] Independently assess retirement-assertion storage/CAS (2b9a.2c3; not exit proof).
- [x] Independently assess internal seal/intent/shutdown seam (2b9a.2d; not public suspend).
- [x] Independently assess explicit-v5 launch-domain correlation (2b9a.2e; not exit proof).
- [x] Independently assess worker-local native-fact producer (2b9a.2f; not worker exit).
- [x] Independently assess private retirement/closure barrier (2b9a.2g; not absence proof).
- [x] Independently assess private controller absence/finalization (2b9a.2h only).
- [x] Independently assess integrated Darwin suspend/resume, including startup cleanup.
- [x] Independently assess R16 non-destructive destroy within its MVP eligibility limits.
- [ ] Complete/verify remaining public managed lifecycle, full fencing and safe recovery
      (R11–R22); recovery/fences and platform/legacy eligibility gaps remain.
- [x] Independently assess native discovery, skills, images and live capabilities
      (R24–R28; documented native/model eligibility and evidence limits apply).
- [x] Independently assess implemented live profile, structured observations and
      diagnostic actions (R31–R33) within the accepted normal lifecycle/API/CLI batch.
- [ ] Complete shared conformance and remaining state/error/session-mode semantics
      (R01–R10, R38); bounded 2b8 streaming approval does not close this wider gate.
- [ ] Complete CLI/Conversations selection, packaging, routing and restart/delivery
      acceptance without regressing existing sessions (R34–R37). Normal standalone
      CLI/shared factory implementation now covers explicit selection, qualified IDs,
      exact-owner existing-worker controls and supported lifecycle/discovery/input/
      observation actions. Author verification: 931/931 workspace cases including
      six CLI/factory cases and two new live-connect API cases; finding-focused
      corrections passed 419/419 affected cases. The single independent batch review
      approved the corrected snapshot `/tmp/minu-codex-normal-batch-corrections-source.sha256`.
      R34 is accepted within scope. The Channels per-agent source integration for
      R35–R37 passed one independent review (message 274; source hash
      `/tmp/minu-codex-channels-source.sha256`); reported checks include 170/170
      affected backend cases and one Chromium setup scenario. Release remains blocked
      because the current Runtime pin at 86f8110 lacks the uncommitted Codex source.
      A reviewed Runtime commit, normal pin update, release/artifact gates, and actual
      deployment/restart acceptance remain outstanding. This is not full R35–R37
      acceptance.
- [ ] Close native integration, failure/race, regression and independent-assessment
      gates with revision/version/platform-specific evidence (R39–R41).
- [ ] Close all 44 required rows (R01–R44) before declaring the full Runtime
      checklist complete. Deliver native R01–R41 first; R42–R44 remain required
      later-phase work. A completed bounded phase is not completion of that scope;
      missing required work must not be reclassified as optional.

[contract]: ../packages/core/src/index.ts
[execution-tests]: ../packages/codex/test/runtime.test.ts
[worker-tests]: ../packages/codex/test/worker-bridge.test.ts
[storage-tests]: ../packages/codex/test/managed-store.test.ts
[allocation-tests]: ../packages/codex/test/managed-native.test.ts
[pending-worker-tests]: ../packages/codex/test/pending-worker.test.ts
