# Claude Code Runtime implementation

## Current rebase and stop correction — owner messages 146 and 148

The feature branch is rebased onto `main` at `f5eb857`, preserving both Pi's
unsupported integration-command classification and the headless UI refusal fence.
Owner message 148 approved committing the correction and updating only this feature
branch/PR with a lease-protected force push; no default-branch push is authorized.

The stop failure is now reproduced/classified: after acknowledged quiesce, Darwin
can report EPERM on a signal-0 group probe before a later ESRCH. Under boundary-test
load, six of twelve fresh CLI stops failed at that probe before the correction.
EPERM now leaves absence unproven and continues only the existing bounded read-only
wait. It does NOT grant clearing. Fresh ESRCH, unchanged metadata/history and all
existing admission/fence/deadline checks remain mandatory; stop is never replayed.
Persistent EPERM times out without mutation, and other probe errors still refuse.
Previously preserved failed fixtures are not repaired, cleared or retried.

Three focused regressions pass (two failed before the code correction). The same
loaded reproduction now passes 12/12, including four actual EPERM-to-ESRCH cases;
267 boundary tests also pass. Final rebased workspace run: **614 passed, 2 skipped,
0 failures** (616 total). The skips are main's existing explicit Pi native-artifact
integration tests, whose opt-in commands were not supplied; no Claude case was
excluded. Typecheck passed. Earlier failing results below remain historical, not
silently erased. No real credentials or paid/external provider calls were used.
This correction has local verification, not a new independent review or real-auth
acceptance; the real authentication/model/tool release gate remains open.

## Previous delivery checkpoint — draft PR preparation

Owner message 140 authorizes creating a PR from `feat/claude-code-adapter` to `main`.
The scope is the reviewed intermediate Claude implementation, its related shared
headless safeguards, documentation/package wiring and seven CLI-only black-box tests.
The latter independently passed 7/7 with typecheck using private fixtures and zero
model-endpoint requests; no adapter/store internals are imported by those tests.

**Current integration gate is NOT green:** PR preparation ran the full worktree
suite once: 598/599 passed, zero cancellations/skips. The CLI black-box empty-session
stop/resume case failed at its initial `stop`; its isolated fixture was preserved.
Read-only follow-up found pending/no-dispatch metadata with a recorded live worker,
but public lookup reports unavailable and status fails. Root cause is unclassified;
no failed stop was retried, forced cleanup performed, state reset or gate weakened.
Typecheck and the local package/export check passed. The PR remains draft pending
this failure's resolution as well as the real-auth gate below; prior approvals do
not supersede this later integration result.

Implementation review and verifier assessment are PASS within their documented
scope. Real authentication/model/tool acceptance still requires an approved local
credential source, scenario and request/spend budget. Creating a draft PR is not
release acceptance, deployment or full R01–R41 completion. Current PR checks and
publication state are recorded in the PR; uncommitted/unpublished statements in
historical checkpoint receipts below describe their original snapshots.

## Authority and scope

The owner's acceptance baseline is `runtime/docs/runtime-functionality-matrix.md`
in the primary checkout. Initial snapshot read for this plan:
`fa48dafc723fcc6bcbc4b278b91395e965f6055c60b834cb8f22b9115340b7f6` (SHA-256).
Re-read for the registration-store checkpoint at:
`e8edad1fd795f09511259735b051b0d0556211792eef1d6ed026a5d28772e02b`.
The owner subsequently clarified that R42–R44 (ACP, native TUI attachment and
interactive approval UI) are future considerations, not delivery requirements.
The matrix and this plan were updated for that explicit scope decision; the
independently advancing Codex implementation progress was not changed. Current
matrix scope-change snapshot: `4100144b02b38faaea89cba3f60a53b79631dc4198eb6bb4e408ff71b5f84fec`.
Subsequently re-read at `46e9ae6447cc84fda13bf050d2eff107c85ee129bd87bb4c48b20a41c9c6e470`;
the independent Codex progress section continues to advance. Latest full read for
launch/readiness planning: `bcf9df9f0fe9dad4b98be527c1a03a6ecbc7eb175c360158afa393e9b5f7d105`.
R01–R41 remain required. This plan is Claude-specific progress, not a replacement
requirements matrix.

Development baseline: `feat/claude-code-adapter`, based on
`f0ffbfcc5f24e75174bff1919aa5cd41ce22d732`. PR target: `main`.
Current user scope is Runtime only. Channels/Conversations implementation comes
afterward. Native-first remains the direction; ACP is not a protocol shortcut.

## Approved intermediate MVP — owner messages 88–90

Owner approved continuing with the proposed reliable TEXT-ONLY durable MVP, including
survival of Runtime/app restart. This is an intermediate milestone, NOT removal or
completion of the authoritative R01–R41 requirements. Primary matrix is unchanged.
Reuse the approved worker/store/bridge; no new framework or unrequested abstractions.

MVP contract: exact-owner stable Runtime ID/workspace, native default model, existing
read-only tool exposure, one verified authentication path, create/readiness, literal
text send/stream/status/history/interrupt, reconnect to a living worker, and clean
stop/same-history resume ONLY after genuine eligible shutdown/history evidence.
Read/Grep/Glob exposure is NOT an OS sandbox or workspace filesystem boundary.
Native loop/tools/authentication remain harness-owned. No credential provisioning
or real paid/model/auth acceptance call is authorized merely by this milestone.

Planned target is the existing observed Darwin arm64 / Node 22.23.0 / SDK 0.3.321 /
Claude 2.1.321 combination; supported-platform/native authentication acceptance is
still to be established. The one authentication path is not yet selected/verified;
no subscription compatibility claim. Minimal exact-owner inventory/public controls
and standalone CLI complete the MVP vertical path; Channels remains afterward.

MVP sequence (implementation/checks continue across milestones; combined review cadence below):
1. **D4 independently closed:** exact published worker -> bounded authenticated readiness snapshot.
2. **Normal lifecycle author-implemented:** D5a/D6/D7 are independently closed;
   D5c/D5c2 support the owner-accepted conditional pinned-family contract. The current
   batch adds qualified domain absence, exact-state/CAS clear, completed-input
   materialization checks and explicit same-history resume; combined implementation approved.
3. **Public wiring author-implemented:** opt-in ClaudeCodeManagedRuntime, exact-owner
   inventory/reconnect and standalone text-only CLI. Existing Pi/default routing unchanged.
4. **Combined implementation APPROVED (message 128):** hidden-tail finding closed;
   current author AND independent typecheck/172 affected tests pass. Original 582
   full-run evidence is reused only for unchanged areas. Verifier PASS (message 132)
   covers the reviewed implementation only; REAL auth/model/tool acceptance remains
   NEEDS_INPUT pending owner-approved credential source, scenario and budget.

Defer FOR THIS MILESTONE: forced busy/unreachable recovery, model/reasoning pickers,
steering, explicit skills/images, broader native plugin/MCP/config inheritance,
rich diagnostics and additional platforms. ACP/TUI/approval UI remain outside
agreed scope entirely. Full matrix work remains pending after the MVP.
Uncertain/unresponsive sessions stay unavailable: no guessed kill/clear, second
worker, input replay or weakened resume proof. R19/R20 independent emergency
fencing/recovery remain mandatory for full delivery. The feature branch exports
the opt-in managed MVP for review/testing; this is not production acceptance or
deployment. Implementation review and verifier are PASS;
real-auth/release acceptance remains open.

## Review cadence — owner message 112 supersedes per-slice stops

Owner requested LARGER implementation batches across multiple milestones before
coworker/reviewer/verifier involvement, rather than independent review after each
internal slice. The earlier small-chunk review stops below are historical and are
superseded for current unfinished work; existing independent evidence remains valid
within its original scope. This changes cadence, not requirements or safety gates.

Current implementation batch, owned by coworker:
1. Complete normal lifecycle: healthy retirement, controller-observed eligible
   domain absence, exact-state/CAS clear, history eligibility and same-history resume.
2. Complete minimal public managed API/inventory/reconnect and CLI vertical path.
3. Complete relevant local restart/failure/conformance and integrated build/package/
   CI checks. Real authentication/model/tool acceptance still needs separate explicit
   authorization; missing approval remains a documented release gate, not a reason
   to claim synthetic acceptance is real.

Use focused self-checks during implementation, broader checks at the combined
integration point, and brief progress check-ins when a milestone is done. Continue
to the next milestone without waiting for an independent per-slice approval. Send
ONE combined concrete baseline/target/evidence/limitations handoff to the reviewer
after the implementation batch; address findings against that integrated target.
Verifier assessment follows the completed/reviewed milestone batch, not each helper.
Do not silently claim that completing the intermediate MVP completes full R01–R41.

D7's standalone review completed before the deferral arrived: APPROVE, 112 selected
tests, /tmp/minu-sol-claude-worker-retirement-review.md. Retain that evidence; no new
standalone D7 test/re-review cycles. The current three-milestone batch below goes
to ONE integrated review. Do not change source based on unconfirmed assumptions. No real-provider/authentication
acceptance approval, trust-boundary waiver, forced recovery or architecture is
approved by batching. Escalate only concrete blockers, required permissions or
scope/trust decisions; do not turn routine progress into an approval checkpoint.
All work remains uncommitted/unpublished; primary Codex/Channels stay untouched.

## Current combined MVP batch — review/verifier PASS; real-auth release gate open

This is the current status; earlier checkpoint sections describe historical scope.
Owner message 112 authorizes milestone batching, not waived safeguards or full parity.
Original integrated handoff: /tmp/minu-claude-mvp-integrated-handoff.md. Original
reviewed fingerprints: /tmp/minu-claude-mvp-review-target.sha256 (not overwritten).
Sol-med requested ONE structural history-tail correction in
/tmp/minu-sol-claude-mvp-integrated-review.md; no other actionable findings.
Current correction: /tmp/minu-claude-mvp-hidden-tail-rework-handoff.md;
/tmp/minu-claude-mvp-hidden-tail-review-target.sha256 pins the changed target.
Sol-med independently closed the finding and APPROVED the combined implementation
in message 128: /tmp/minu-sol-claude-mvp-hidden-tail-rereview.md. Independent current
check logs: /tmp/minu-sol-claude-hidden-tail-check.log and
/tmp/minu-sol-claude-hidden-tail-affected-tests.log (172/172, zero failures/skips).
No source edits; all 13 current fingerprints match. Original 582 is reused only for
unchanged areas; no aggregate/full-592 claim. Verifier assessment COMPLETE, PASS for
reviewed implementation with Rigorous assurance (message 132), report
/tmp/minu-claude-mvp-verifier-assessment.md. No suites/native/provider calls rerun;
13/13 source fingerprints and current package bytes independently checked. REAL auth
is still an unmet required release criterion, not waived by either approval.

**1. Normal lifecycle.** New src/worker-lifecycle.ts composes existing store/client/
worker primitives. Require the current supported isolated profile/known entry,
nonnull PID==group and exact live admission; confirm authenticated idle status and
send ONE idle-quiesce request without a lease across HTTP. Lost ACK never retries
stop. Read-only signal-0 ESRCH on that qualified fresh-origin group is distinct from
ACK/socket status. Permission/unknown errors stay unavailable, never mean exited.
After absence, reacquire the real lease, compare the COMPLETE original manifest,
check absence/history again, fence explicit resume before CAS clear and rotate the
worker generation while preserving native binding/input evidence. Never silently
rebase changed fences/revisions, clear legacy null groups or infer exit from RPC.
Final monotonic check rejects late success while preserving any actual committed
checkpoint; mutations are not replayed or rolled back after lost/late confirmation.
This remains conditional on trusted pinned-family origin/no escape/no external work,
not OS incarnation attestation or power-loss durability.

Native history's OPTIONAL completedInput check requires an INDEPENDENTLY committed
completed last dispatch, exact mapped native UUID/literal UTF-8 fingerprint, closed
tool results, drained known queue events, end_turn and matching final leaf. Pinned
native can persist a prompt_snapshot after end_turn, and thinking/text as separate
end_turn rows sharing ONE API message ID; those observed forms are supported, not
arbitrary later responses/inputs. This checks materialization, never manufactures
caller settlement/results. Missing/changed/unknown/branch/compacted history refuses.
Interrupted/failed/uncertain latest inputs cannot grant clean resume. An interrupted
but healthy live worker may finish a fresh clean turn; failed/unreachable recovery
remains outside the MVP. Pending/never-created stays native-lazy, not missing-bound
history fallback. Resume requires an explicit allowStopped:true and repeats history
validation before a one-shot launch. Configuration preflight occurs BEFORE clearing
that fence (root/executables/env/managed limits), not after an invalid resume mutates.

**2. API and CLI.** New src/managed-runtime.ts exports ClaudeCodeManagedRuntime,
one owner per controller, explicit state/native roots and native environment. Create,
text/turns/send/events/activity/status/history/interrupt, active reconnect, metadata
inventory and clean stop/resume are wired to existing exact admissions. No credentials
or user turn text enter manifests/argv; the private frame carries native env. No
host-default store selection. Unknown input outcomes stay unavailable. Readiness is
a snapshot; each command re-admits. Caller-result retention remains living-worker
only (1,000-ID bound); transcript history does NOT restore a durable turn ledger.
The known old-epoch last ID refuses redispatch; applications use fresh IDs after
explicit worker resume. Broader durable caller-ID parity is not claimed.

New src/cli.ts/bin minu-claude-runtime/root script runtime:claude uses JSON output,
owner/state/native-root/session flags and stdin-only bounded fatal-UTF8 turn JSON.
Symlink bin entry is tested; actual independent CLI processes exit while their
isolated workers remain reachable. Existing runtime command/Channels stay Pi-only.
Forced recovery/destroy, selectors/steering/images/skills, rich diagnostics/profiles,
broader inheritance and extra platforms are NOT added by this batch.

**3. Original integration verification/package (BEFORE finding correction).** Author
AND independent pnpm check/pnpm test passed **582/582**, zero failures/cancellations/
skips; independent log /tmp/minu-sol-claude-mvp-tests.log. This is not a full run of
the later correction. It included existing
actual-native tests plus public API/CLI clean-stop/same-history cases. New actual
bundle tests use ONLY disposable private roots/dummy API keys/localhost synthetic
providers, hard-capped at two Messages calls per new case. One covers thinking+text;
one exercises stdin-only text across actual CLI process exits. A delayed fake SDK
startup (>2s) separately proves input acceptance uses its initialization budget,
not a short status-query deadline, /tmp/minu-claude-mvp-startup-budget-tests.log. No upstream forward,
real auth/model/provider acceptance, paid calls, global config, primary Codex/Channels
writes/builds, commit or push. Separately, 12/12 shared headless checks passed again against current Claude/Pi
and the pinned private Codex snapshot, /tmp/minu-claude-mvp-shared-headless-tests.log;
not added to the 582 run. No active Codex checkout/build was used. Remote Linux/macOS CI was not triggered; default gate is
unchanged and includes the new tests. Tested host remains Darwin arm64/Node 22.23.0 /
SDK 0.3.321/native 2.1.321. Real credentials/auth path and subscription are unverified.

Logs: /tmp/minu-claude-mvp-check.log, /tmp/minu-claude-mvp-integrated-tests.log,
/tmp/minu-claude-mvp-package-check.log, /tmp/minu-claude-mvp-package-files.log,
/tmp/minu-claude-mvp-bin-tests.log. Packed artifact:
/tmp/minu-claude-mvp-final-review.uRRFoK/pack/minu-runtime-claude-code-0.0.1.tgz;
compiled exports/types/CLI/lifecycle/entry are present. Not an npm publication.

Development evidence is retained, not relabeled: initial native text eligibility
rejected a real post-end_turn prompt_snapshot, and multi-block validation later found
thinking/text share an end_turn API ID. Corrected using preserved exact files + unit
cases before rerunning the native paths. Logs: /tmp/minu-claude-batch-native-integration-first-failure.log,
/tmp/minu-claude-batch-native-diagnostic.log, /tmp/minu-claude-mvp-multiblock-tests.log;
offline rechecks /tmp/minu-claude-batch-{text-history,multiblock-history,history}-recheck.log.
The very first test fixture removed its failed native tree; the classified diagnostic
and later native artifacts were preserved. Do not claim all original trees remain.

First full integration under shell umask 077 passed 577/579: TWO unchanged storage
fixture tests expected public 0755/0644 creation, masked private by that environment.
No production/store or test gate was weakened; targeted checks under standard 022
and subsequent full runs passed. /tmp/minu-claude-mvp-integration-umask-failure.log,
/tmp/minu-claude-mvp-umask-recheck.log. Final 582 result is its own actual execution,
not a sum of those earlier runs. Remaining release gate: user-authorized real auth/
model/tool acceptance with agreed credential source/budget, then review/verifier
handoff; full R01–R41 and their deferred work remain required.

### Combined-review finding correction — independently closed; combined implementation approved

Review message 122 found that isMeta/isVisibleInTranscriptOnly/<synthetic> rows could
skip completedInput structure, and a following prompt_snapshot could mask a later
uncompleted input. Original offline probe deterministically reproduced it; the
original broad 582 passes did not cover this path. That uncorrected baseline was NOT
approved; approval applies to the pinned corrected target after independent closure.

Changed ONLY src/native-history.ts plus its tests and managed-runtime.test.ts:
- Structural completed-input checks now run independently of public redaction.
  Hidden rows cannot certify the mapped input/terminal response or conceal later
  input/unrelated responses. Hidden PRE-target bookkeeping and structurally paired
  hidden tool results remain supported; default history projection is unchanged.
- A completion snapshot must directly parent the current completed leaf and closes
  same-response continuation. Thinking/text rows may share ONE API response before
  snapshots; snapshots cannot bridge an intervening input or reopen that response.
  A later empty user array is not a structurally paired tool-result message.
- Ten new tests cover both visibility flags/synthetic rows, user/assistant roles,
  before/after completion, string/block text, snapshot/no snapshot, same/unrelated
  response, supported pre-target/tool bookkeeping and legitimate snapshot sequences.
  Two real-store/worker consumer regressions prove rejected stop/resume preserves
  exact metadata/history, explicit-resume fencing and zero replacement launches.

Nine selected regressions failed before the source fix (including both lifecycle
cases); /tmp/minu-claude-hidden-tail-red.log. Current 11/11 focused checks pass,
/tmp/minu-claude-hidden-tail-focused-tests.log. Current pnpm check and **172/172**
FULL affected-file tests pass, zero failures/cancellations/skips: native-history,
native-session, managed-session, managed-runtime and CLI. No native tests excluded;
actual bundled paths use only existing controlled localhost/dummy-credential cases.
/tmp/minu-claude-hidden-tail-check.log, /tmp/minu-claude-hidden-tail-affected-tests.log.
The original reviewer probe now rejects invalid_history unchanged. Three preserved
native-file offline rechecks (Grep/Glob, text snapshot, thinking/text) still validate
with unchanged known hashes; no calls/settlement/clear/resume in those rechecks.
/tmp/minu-claude-hidden-tail-{original-probe,history,text-history,multiblock-history}-recheck.log.

Repacked corrected artifact /tmp/minu-claude-hidden-tail-integrated.xbxL9k/pack/minu-runtime-claude-code-0.0.1.tgz;
/tmp/minu-claude-hidden-tail-package{,-files}.log confirms compiled entrypoints/types.
Full unrelated Core/Pi/transport/store/default-CI/shared-headless runs are reused
ONLY for unchanged code at their prior 582/12 targets; not rerun or summed with 172.
No current 592/full-suite claim. No schema/ledger/process-control/auth changes,
provider-forward/paid calls, primary Codex/Channels writes/builds, commits/pushes.
Real auth/model/tool acceptance, other platforms and full R01–R41 remain open.
The bounded implementation verifier assessment is PASS, not overall MVP completion. Source snapshots and exact fingerprints are in the correction handoff.
Independent approval report /tmp/minu-sol-claude-mvp-hidden-tail-rereview.md confirms
172/172, original probe rejection and three unchanged captured native hashes. No
unresolved implementation findings from this combined review; no production,
release, real-provider or verifier acceptance is implied by its APPROVE.

### Verifier result — implementation PASS; release acceptance NEEDS_INPUT

Message 132 records /tmp/minu-claude-mvp-verifier-assessment.md (2026-11-11T04:00:41Z):
Rigorous assurance; no required implementation finding. Verified 13/13 fingerprints,
inspected risk-relevant contracts/evidence and audited the corrected package: 51
source/test files + 102 JS/declaration files match current worktree, seven required
entrypaths present. Manifest SHA e02ee0a59ffa67687b03dce3cfc64cb00088815733cd598f8c562c4721d1451f;
archive SHA 90c6a963a20ecc3f58b4222c8908891b2e2cf67753eb1c927198a413d13554f3.
No test suites, native processes or provider requests were newly executed by verifier.
Current independent 172/172 accepted; original 582 reused ONLY for unchanged areas;
separate author 12/12 headless stays separate. This closes the bounded assessment,
NOT production/MVP completion or full R01–R41. Required CI/release gates remain.

NEXT: request owner approval for the remaining real-world acceptance, not more
implementation/review cycles. Proposed (NOT approved): dedicated API key from an
explicitly approved secure local environment source, direct Anthropic API, native
default model and ONE read-only fixture task in a fresh private session/workspace,
then normal cleanup/evidence capture under the existing conditional family contract.
Owner must select authentication mode/source, approve the scenario and set a request/
spend budget before any credential access or external/paid request. Do not post keys
in chat or put credentials/transcripts in argv/manifests. Do not guess a budget,
claim an unenforced dollar ceiling, use global native authentication or add retries.
If an approved bound cannot be enforced, stop and agree the execution constraints
before calling. Alternative subscription authentication remains unselected/unverified.
Revalidate evidence affected by the chosen authentication/environment configuration.
No commits/pushes/publication/deployment/default-switch are authorized by this step.

## Work packages and coordination

1. **Durable metadata, locks and dispatch uncertainty — coworker (internal slices implemented).**
   Add internal owner-private bounded manifests, immutable identities and launch
   policy, revisions, crash-safe publication and exact-session serialization.
   Persist one-shot native-creation intent and exact binding before any future
   input dispatch. This is groundwork for R11/R12/R18/R20/R21/R22, not completed
   managed lifecycle. Do not enable public managed methods in this slice.
2. **Native resume/configuration boundary — sol-med.**
   Read-only spike reported complete; observations and limits are recorded below.
   Internal `src/native-history.ts` plus dedicated tests has been delivered and
   the local hidden-flag finding has been corrected. Coworker observed 22/22 flag
   checks and the later 232/232 combined run, including all 85 helper scenarios.
   Managed admission/launch integration remains unfinished, not blocked on that
   now-closed parser finding.
   Contract: `inspectClaudeCodeHistory({ nativeSessionId, canonicalCwd,
   nativeConfigRoot, signal? })`. Return a bounded normalized text-history snapshot
   for present evidence, or an explicit missing result; reject unsafe, corrupt,
   ambiguous, wrong-session/workspace or oversized evidence. This does not certify
   native readiness, prior turn settlement or Runtime ownership.
   Validate exact canonical workspace and exact native UUID/config root; do not
   search across projects, mutate global environment, follow unsafe links, perform
   unbounded SDK reads or repair native files. Inspect the pinned native format
   before implementing validation; do not invent schema/chain semantics.
   No launch/resume/model call from this helper. Ownership/generation/lifecycle
   locks remain the caller's precondition. Never derive Runtime turn results or
   replay input from native history. Cover real bundled-engine persisted history
   with an isolated home/local synthetic provider, plus unsafe/corrupt/missing and
   wrong-workspace refusals. No paid calls/inherited credentials.
   File ownership is limited to `src/native-history.ts`, corresponding tests and
   test fixtures; do not edit client/store/locks/core/package/plan or commit/push.
   Return exact source fingerprints, observed checks and limitations for integration.
3. **Independent bounded assessment — verifier (requested when connected).**
   Review the initial adapter and new metadata/lock slice against the matrix.
   Prioritize ownership, unsafe storage, CAS/lock lifetime, cancellation, native
   identity, uncertainty and side-effect boundaries. Review only; report concrete
   defects separately from unfinished later packages. Do not treat a checkpoint
   approval as product acceptance.
4. **Worker and managed lifecycle — coworker.**
   Internal transport/client has independent approval for the two finding-driven
   corrections only. The persistent native opening blocker is independently closed.
   Sol-med's codec sanitization correction is locally approved by coworker.
   Registration reservations/publication and metadata-backed admission are
   implemented internally; the UTF-8 finding is independently closed. The internal
   worker-side native binding/dispatch driver is author-verified. After the five
   headless chunks closed, the owner approved continuing in small slices.
   Initialization/admission (slice A) and first-input binding/dispatch-intent
   (slice B), and terminal observation/durable settlement (slice C) are
   independently closed within their bounded internal contracts. D1 recommends
   existing live publication as adoption, not readiness. D2's private worker-side
   bootstrap and all three D3 parent launch/publication checkpoints are independently
   closed within scope. Last combined worktree regression is 510/510 (before D4),
   author evidence only. D4's private readiness helper is independently closed.
   D5a idle-only quiesce is independently closed. Owner accepted the conditional
   process-family contract; D5c/D5c2 supply bounded Read/Grep/Glob native evidence,
   with the history correction independently closed. D6 fresh isolated launch is
   independently closed. D7 healthy self-retirement awaits independent review;
   controller exit/clear/history eligibility, resume and public enablement are unfinished.
   OS/recovered-process provenance, supervised launcher, public routing and
   recovery remain unfinished; internal approvals do not complete them.
   Dedicated long-lived worker, authenticated loopback transport/event streaming,
   durable registration/generation fencing, live-turn reconnect, atomic idle
   suspension, same-history resume, non-destructive destroy and exact-owner
   confirmed recovery/human-resume fence (R06/R10–R22).
5. **Native controls/configuration/input.**
   Resolve steering and commentary/final semantics (R05/R08); native discovery,
   exact model/reasoning and skill selection, verified images/live capabilities
   and authorized native integration inheritance (R23–R30). Current refusal of a
   feature remains missing implementation, not proof the native harness lacks it.
   R30 headless interaction refusal remains required without an approval UI. Claude
   now fails unexpected blocking user dialogs without fabricating a dismissal;
   its callback deadline/cancellation corrections are independently closed. Pi's
   owned RPC dialog guard and Codex's bounded existing-refusal verification are
   independently closed. Shared headless conformance is independently closed
   below; all five bounded chunks are complete. Wider R30/R38 delivery remains
   unfinished, including CI/package integration and native acceptance.
6. **Observability and Runtime delivery.**
   Existing-worker bounded profile/events, private local diagnostics, adapter
   selection in the Runtime CLI, shared conformance and failure/race acceptance
   (R31–R34/R38/R39). Record exact revision/environment and independent assessment
   (R41). R40 real model/tool/authentication/persistence acceptance remains separate
   from synthetic-provider evidence; no subscription compatibility claim is made.
7. **Required subsequent consumer phase; separate future considerations.**
   Channels/Conversations packaging, adapter-aware bindings and restart/delivery
   acceptance (R35–R37) remain required after Runtime. ACP, native TUI/external
   attachment and interactive approval UI (R42–R44) are outside the agreed delivery
   scope and require separate approval if pursued. Headless permission/user-answer
   requests must still fail clearly and safely without fabricated approval (R30).
   No new UI helper text.

## Current evidence and limits

Initial in-process adapter author checks: typecheck and 97/97 workspace tests,
including real bundled-engine/localhost synthetic-provider multi-turn,
interruption and denied-write checks. SDK is pinned to 0.3.321.
This is not R40 real model/tool acceptance, subscription-policy verification,
cross-platform acceptance or independent approval.

The existing initial client disables native integration inheritance and has no
managed methods. R29 and the remainder above remain unfinished. Its 1,000-turn
instance-local retention is not a durable turn ledger or exactly-once tools.
Unknown session IDs currently reject; cross-adapter semantics still need R38
reconciliation rather than silently changing existing Pi behavior.

## Metadata checkpoint — author evidence, independent assessment pending

Added internal `packages/claude-code/src/{managed-store,lifecycle-lock}.ts` and
storage tests/child-process fixtures; no client/core/Pi/Channels changes in this
checkpoint. This follows Runtime's existing private-directory, SQLite-lock and
atomic-publication patterns, without importing the uncommitted Codex package.
Claude's schema records a prospective exact native UUID in `creating` before
launch; only that UUID may subsequently become `bound`. Neither state proves
native history exists or that a turn was accepted/completed.

New identities must begin at pending revision zero. Launch policy/owner/identity
are immutable; revisions and expiring mutation leases protect updates. No
provider credentials, environment or permission grants are serialized. Stored model/skill
intent is not verified native support; the eventual worker must enforce it.
Existing empty/corrupt registrations are refused, not overwritten or omitted.
These fields are not yet operational worker-generation/human-resume fences.

Observed on the uncommitted worktree:

- `pnpm check` — passed.
- `node --test packages/claude-code/dist/test/managed-store.test.js` — 27/27 passed.
  Covers real filesystem/private-link/permission/size failures, exact owners,
  concurrent creation/CAS, pinned readers, expired/concurrent/unawaited leases,
  child SIGKILL around publication/update, lock-holder death, and the mixed-process
  local-timeout/case-alias lost-update regression. This macOS filesystem confirmed
  the case aliases reached the same lock inode. Log:
  `/tmp/minu-claude-managed-store-tests.log`.
- Tracked and new-file whitespace checks — passed.
- Initial unchanged client/native/Pi evidence is reused; no fresh full-workspace
  run, native resume, real model/tool call, power-loss test or independent approval
  is claimed for this internal storage checkpoint.

SHA-256 source fingerprints:

- `src/managed-store.ts`: `8b85969e2da41f82807ffce717c33f2f2badf69f64e20a37b0ec4c12c17fb7de`
- `src/lifecycle-lock.ts`: `409022aa1ca48ce722f5062c4c93e1564d88912193aa067b6de24f42d7325208`
- `test/managed-store.test.ts`: `5603465d3c03e06be7732e78c4cfe5dd907b39ddaad23d3d69faeda9426679f9`

## Dispatch-uncertainty checkpoint — author evidence, review pending

Before native launch/resume integration, extended the internal managed manifest to
unshipped **version 2** with `lastDispatch`: `none`, `dispatching` or `settled`.
Version 1 is refused; no implicit migration/repair. The earlier source fingerprints
and 27-test checkpoint above are historical.

A lease records caller turn ID, a SHA-256 input fingerprint, native message UUID
and generation before future dispatch. Only the exact unfenced owner/generation,
revision and input identity can record an observed terminal outcome. Pending or
creating native identities cannot admit input. Stale terminal results cannot
settle a later input. Existing dispatch intent cannot be reset through metadata
patching or replaced by new input, including after a generation/fence change.
The most recent terminal caller/native ID cannot be silently redispatched as new.
This last-input uncertainty guard is not a durable result/idempotency ledger and
contains no prompts, images or terminal response text.

Observed author checks on the uncommitted worktree:

- `pnpm check` — passed.
- `node --test packages/claude-code/dist/test/managed-store.test.js packages/claude-code/dist/test/managed-dispatch.test.js`
  — 39/39 passed (27 storage plus 12 dispatch scenarios). Includes generation and
  recovery fences, wrong owners, identity/stale-result refusal, all three terminal
  outcomes, forbidden input-reset patches, snapshot isolation and separate-process
  SIGKILL immediately before/after dispatch-intent and settlement publication.
  Log: `/tmp/minu-claude-dispatch-tests.log`.
- Tracked and changed/new-file whitespace checks — passed.
- Unchanged client/Pi evidence is reused. No new full-workspace run, native model
  call, worker launch, automatic recovery or power-loss guarantee is claimed.

Source SHA-256:

- `src/managed-store.ts`: `0b6f2439511404c68bbc65f89d577a43fa2c6c6a9b2464df8349cdad8d5ea45a`
- `test/managed-store.test.ts`: `038eb2915bbd506ebb4dc06b12be9f614c5b4647a8a461cb3f09731b5187c267`
- `test/managed-dispatch.test.ts`: `da315465d3303003cba2faa591c30c33dacbb14b4e848ced6fe6f4aff6d0c192`
- `test/fixtures/store-crash.ts`: `d3bd8cf07569e0e53b4077defbc63293bd938bb25c07e741eaa68ae0b247a73b`

The worker must still actually persist/admit dispatch under these leases, preserve
its live-turn ledger on consumer reconnect, capture/validate the exact authorized
native config root and fence native launch/replacement. No public managed APIs or
native integration-inheritance change are enabled by this storage checkpoint.

## Worker transport checkpoint — historical target before independent review

Added internal `src/worker-{bridge,client,protocol}.ts`, transport/protocol tests and
worker/consumer process fixtures. These are not public package exports or a
production managed-worker launcher. Existing client/core/Pi/Channels source and
native integration-inheritance policy are unchanged.

The loopback HTTP bridge checks token plus exact logical session, owner and
generation on every route, projects normalized events under logical identity,
provides retained-turn/status/history/control access and curated activity, and
bounds JSON/frame sizes, per-reader queues, stream count, write-drain time and
client connection/request waits. The client rejects redirects/non-loopback or
mismatched identities/turns, validates projections and never automatically retries
or chooses a fallback endpoint. Consumer interruption/disconnection does not stop
native work. A lost admission acknowledgment remains uncertain; callers recover
by the original stable ID, not an automatic replacement POST.

**Important:** header identity is not operational persisted-generation fencing.
The bridge requires an `admit` callback that the future supervisor must implement
against the exact-owner/generation lifecycle lease, including through dispatch.
Tests currently provide a fixture admission authority. There is no durable worker
registration/discovery, actual managed launcher, lazy native allocation/resume,
process-group recovery or public managed API yet. The native-history parser is
not wired into launch by this transport checkpoint.

A remote stop acknowledgment waits for the underlying Runtime/native stop; it is
explicitly not independent proof of worker/group exit. Supervisor close separately
confirms the fixture worker exit and listener closure. Raw streams are not a replay
log; only retained native Runtime turn records support this living-worker reconnect.

Observed on the uncommitted worktree based on `f0ffbfcc5f24e75174bff1919aa5cd41ce22d732`:

- `pnpm check` — passed.
- Focused worker bridge/protocol tests — 11/11 passed. Real child worker and a
  separate consumer process exercise exit/reconnect and retained running results;
  real HTTP checks reject wrong tokens/owners/sessions/generations and stale
  fixture admission. Tests include activity cancellation/projection, native-stop
  versus worker-exit distinction, malformed input, stream-count bounds, a paused
  wire reader under 16MiB of SDK deltas, lost-ack polling without a duplicate POST,
  redirects, deadline/size limits and mismatched worker/turn responses.
- One worker-boundary test uses the actual bundled Claude Code engine plus an
  isolated home/dummy credential and localhost synthetic provider for two turns,
  response/history recovery through a fresh client and normalized streamed text.
  Other transport failure scenarios use the real SDK with a native protocol peer.
- `pnpm test` — **232/232 passed**, combining initial Claude/Pi, all 85 corrected
  history-validator cases, 39 storage/dispatch cases and 11 transport/protocol
  cases. Log: `/tmp/minu-claude-worker-integrated-tests.log`.
- Tracked and new-source/test whitespace checks — passed.
- No real credentials/paid provider calls, R40 real-model/tool acceptance,
  cross-platform acceptance, independent transport approval or overall matrix
  completion is claimed.

SHA-256:

- `src/worker-bridge.ts`: `a247f0bc7266d3689a506e4c6d2c034a1555cca7b48202de56a353c58b11f0f1`
- `src/worker-client.ts`: `92a942af0f46b3c0cea40ec02d361384d29612280d7cd5ec7a22ff83af0f2c69`
- `src/worker-protocol.ts`: `954f2bef90a8af29ff34f99fd820931a763d4302a57fd3fe81e98f9a21c6834a`
- `test/worker-bridge.test.ts`: `8213e90aa48f4594f6b47b322882f730722dffa987926b5c42f5f91ce331cda4`
- `test/worker-protocol.test.ts`: `ace27221813acb199f66158a355d84d21a4874d8120e8e1e20c1cff4a7036c2d`

Sol-med independently returned **REQUEST_CHANGES** for this pinned target:
HIGH established streams continued delivering after generation revocation; MEDIUM
untargeted delayed controls could affect a later active turn. Sol-med reported
11/11 focused tests plus two separate loopback repros, without source edits or a
full-suite rerun. Report: `/tmp/minu-sol-worker-transport-review.md`;
reproducer: `/tmp/minu-sol-worker-review-probes.mjs`.
The reviewer confirmed the native-stop/worker-exit distinction and did not treat
deferred launcher/registration work as a transport defect. Rework follows below;
independent closure remains pending. Verifier remains unconnected.

## Transport finding-driven rework — independently approved for the two corrections

Modified only internal worker bridge/client, their existing call-site tests and
new `test/worker-fencing.test.ts`. No core/legacy Pi/in-process control API,
manifest schema, native-history helper, dependencies or inheritance policy changed.

- Stream queue/header setup now has its own generation admission; every actual
  event/activity frame write is separately revalidated while authority is held.
  Idle waiting and socket drain happen outside the lease. Revoked frames are
  discarded and the connection is closed. Bytes already written while authorized
  cannot be recalled from network buffers; there is no claim of retroactive erasure
  or immediate idle teardown without a new write/revocation notification.
- Worker `interrupt(expectedTurnId, signal?)` and
  `steer(expectedTurnId, input, signal?)` now send a required retained caller turn
  target. The bridge checks that target is still running under its mutation and
  generation admission before invoking the session-level native operation. It
  rejects missing/unknown/settled targets and never substitutes a later turn.
  The bridge must be the sole turn/control admission path for that owned session;
  it excludes subsequent bridge turns until control returns. Stop remains a
  deliberate whole-session action, not a turn-targeted control. This unshipped
  internal protocol does not fall back to the earlier targetless request shape.
- Native steering remains unsupported in the initial Runtime. Steering target
  fencing is verified with a controlled Runtime; this does not complete R08.

Observed author checks:

- `pnpm check` — passed (after correcting a test-only TypeScript iterator-union
  annotation; the first static run failed before tests executed).
- `node --test packages/claude-code/dist/test/worker-bridge.test.js packages/claude-code/dist/test/worker-protocol.test.js packages/claude-code/dist/test/worker-fencing.test.js`
  — **20/20 passed**. Nine new real-loopback regressions cover event AND activity
  revocation after setup, between lookup/setup and while frame admission waits;
  idle leases are released and valid work remains admissible. A holding proxy
  tests delayed interrupt AND steer from A arriving after B starts, with positive
  matching-target controls and missing/unknown/settled-target refusals. Existing
  11 transport/protocol/native-boundary cases also pass with the new request shape.
  Log: `/tmp/minu-claude-worker-fencing-rework-tests.log`.
- Changed source/test and tracked whitespace checks — passed.
- The 232/232 workspace run above predates this rework. Unchanged Pi/client/history/
  storage evidence is reused; no fresh full-suite run or independent closure is
  claimed. No paid model calls or real credentials were used.

Updated SHA-256:

- `src/worker-bridge.ts`: `7a802d361b6ae45685347a9e504ac4121790b04766c642c87d8162569312a52d`
- `src/worker-client.ts`: `24441b35ab6dad6b49225a78f7b66bf95449a3ad248f740863d790432e7e19f0`
- `test/worker-bridge.test.ts`: `4137bcd9162c5fed8577941c2eac8c4f5ee156254c3fedda7e961ee29561d841`
- `test/worker-fencing.test.ts`: `e52db62cc55eda979ed97ca2899ed6447fabedeac5d41aae5617b557f9193b58`
- `worker-protocol.ts` and its tests are unchanged from the earlier checkpoint.

Sol-med independently approved these two corrections after 20/20 focused tests
and adapted loopback probes: post-revocation frames are blocked; delayed A-targeted
interrupt returns 409 while B remains running, and a B-targeted interrupt succeeds.
No additional actionable finding in this bounded rework. Report:
`/tmp/minu-sol-worker-transport-rereview.md`; probe evidence:
`/tmp/minu-sol-worker-review-recheck.log`. The reviewed fingerprints match those
above. No reviewer source edits, independent full-suite run or overall managed
lifecycle acceptance is claimed. Verifier remains unconnected.

Persisted registration/managed launcher/admission integration and overall Runtime
matrix acceptance remain unfinished; the next native primitive below is separately
reviewed work, not covered by this transport approval.

## Persistent native opening checkpoint — historical target before independent review

Added internal `src/native-session.ts` and `test/native-session.test.ts`; factored
protected launch/turn-admission/evidence hooks in the existing Claude client.
No public managed methods or new package exports, shared core/Pi/Channels changes,
manifest format changes, native integration inheritance or automatic replay.

- Create uses only exact `sessionId`, requires valid first text input but does not
  dispatch it, preserves persistence and refuses existing/corrupt exact history.
  Resume uses only `resume` after the strict read-only history validator accepts
  the exact native UUID/canonical workspace/config root. Missing bound history
  never falls back to a new ID/process or a synthetic bootstrap prompt.
- Native and Runtime session identities are separate; native frames/prompts use
  the mapped UUID while public state/events use the stable Runtime ID. Hydrated
  text is not reconstructed caller turns, terminal results or idempotency state.
  The pinned native version must report 2.1.321. Observed persistent init metadata
  must match workspace/version/manual permission mode.
- Caller-provided native message UUIDs support future persist-before-dispatch
  admission. Internal evidence distinguishes an observed native terminal frame,
  definite undispatched cancellation and uncertain process/transport failure.
  Busy stop is not invented native settlement. The future supervisor must still
  use this evidence with the durable dispatch guard; the primitive does not do so.
- Native config root must match the worker's authorized effective environment;
  no global environment mutation, credential extraction, fresh-home redirection
  or setting/integration inheritance change. Known interrupted-turn replay
  environment is refused, including false-looking strings rather than guessing.
- Missing native config/projects/project directories are prepared as 0700 only
  after valid create input. Existing nonprivate/redirected storage is rejected,
  never chmodded/repaired. Native project encoding is reused via a new internal
  export from `native-history.ts`; its validation/parsing behavior is unchanged.
- Cancellation during opening preserves the signal reason after confirmed process
  cleanup; the startup signal is detached on success so a late abort cannot stop
  subsequent work. Launch config/identity is snapshotted before asynchronous IO.

Observed issue and correction: the first real create/resume integration check
failed because the native engine created missing project directories with modes
rejected by the strict validator. Preparing only missing directories as private
fixed that boundary without weakening inspection or changing existing modes.
An initial test-only default-parameter union annotation was also corrected.

Observed author evidence on Node 22.23.0, Darwin arm64:

- `pnpm check` — passed.
- 17 native-opening scenarios passed, including a real bundled-engine two-turn
  same-native-UUID restart under a separate stable Runtime ID, empty-init refusal,
  existing-history create refusal, wrong workspace/config root and corrupt-history
  prelaunch checks, no silent directory repair, snapshot/cancellation/startup cleanup,
  exact mapped message identity and native-versus-uncertain settlement evidence.
- Combined initial runtime/native plus opening check passed 34/34 after the
  filesystem correction. The final integrated run includes the additional three
  directory/snapshot scenarios and malformed-config assertions.
- `pnpm test` — **258/258 passed**, including 85 history, 39 storage/dispatch,
  20 transport/protocol/fencing, 20 initial Claude and 17 native-opening cases plus
  77 existing Pi cases. Log: `/tmp/minu-claude-native-session-integrated-tests.log`.
- Claude native integration checks use isolated homes, dummy credentials and
  localhost synthetic providers. This is not R40 real model/tool/authentication,
  subscription-policy, cross-platform or production managed-lifecycle acceptance.

Source SHA-256:

- `src/client.ts`: `71aadee896de5ea52edb52997fb56407bcf1b1632c697e7d680820fc511e5602`
- `src/native-session.ts`: `6ee3ed5cad58ef04f2a49ee697c824306580a022542f9d5bc29993fa387bd96e`
- `src/native-history.ts`: `ae9a883cc731369827f09ed61fe324c9cf065468cda6397496b701d6e36ff5aa`
- `test/native-session.test.ts`: `e29827f56f14978558b78b3262c259d6f8d04c9e768bcf8f765b3f07d2fdefe9`
- `test/fixtures/claude.ts`: `9d881752c878fdb2fcea2cd8550c7916815e950789eadb24e21d55df1ab9778d`

The caller must hold exact-owner/generation/policy and uncertainty admission across
opening, capture immutable authorized native config root, persist one-shot binding
before input, deduplicate retained caller turns and persist exact dispatch identity
before `startMappedTurn`. Those storage/worker bindings remain unimplemented.
Observed unsolicited native assistant/stream/tool activity fails the persistent
session; observing after spawn is not proof that no side effect already occurred.
Strict native history branching/compaction/sidechain limitations remain. Package
index still exports only the initial in-process adapter.

Sol-med independently returned **REQUEST_CHANGES** for one reproduced HIGH
history-location mismatch: `CLAUDE_CODE_PROJECT_DIR_NAME` was accepted by native
launch while preparation/inspection used the default workspace key. A real pinned
engine completed one localhost synthetic turn in the override directory; exact
inspection returned missing and subsequent same-ID resume refused. The reviewer
observed 37/37 focused tests but that suite lacked override coverage. Report:
`/tmp/minu-sol-native-opening-review.md`; reproducer:
`/tmp/minu-sol-native-opening-review-probe.mjs`. No reviewer source edits or paid
calls. Registration codec work was still unstarted at that review checkpoint.
Native/public IDs, privacy/persistence, cleanup/cancellation and settlement context
were inspected; unfinished supervisor ownership/fencing was not itself a finding.

## Native history-location rework — independently approved blocker closure

Persistent create AND resume now reject any defined
`CLAUDE_CODE_PROJECT_DIR_NAME` before directory preparation, history inspection or
native process spawn. Empty/false-looking values also refuse; no silent environment
stripping, alternate-directory search, storage repair or fallback creation.

Persistent opening snapshots its effective authorized environment (explicit
replacement or inherited host) and passes that same snapshot to the SDK. A host
environment change during asynchronous preparation therefore cannot reintroduce
an unvalidated override or redirect the worker after validation. Explicit replacement
environments are not merged with host values. Legacy ephemeral launch environment
behavior is unchanged. No provider credentials or environment are serialized into
Runtime storage, logs or events by this change.

Observed author checks:

- `pnpm check` — passed.
- `node --test packages/claude-code/dist/test/native-session.test.js packages/claude-code/dist/test/runtime.test.js packages/claude-code/dist/test/native.test.js`
  — **40/40 passed**. Three added regressions cover configured override variants
  in both modes with no project-directory preparation/native PID/input; inherited
  host override refusal and explicit replacement non-inheritance in disposable
  child processes; and actual native-peer environment capture proving a late host
  override injected during real directory preparation is not passed to the child.
  The parent test environment remains unchanged. Existing real-engine same-ID
  create/stop/resume and initial Runtime/native cases still pass.
  Log: `/tmp/minu-claude-project-override-rework-tests.log`.
- The 258/258 integrated run above predates this rework. Unchanged Pi, history,
  storage and transport evidence is reused; no fresh full-suite or independent
  closure is claimed. The tests used isolated homes/protocol peers/local synthetic
  providers, not paid credentials/model calls.

Updated SHA-256:

- `src/client.ts`: `f33b1166ac684cfa108ad36820dc924ff24e3035d18fd5e9fc8a4cab587875d3`
- `test/native-session.test.ts`: `939df3bde557eb1e78ac0cc622271f652a19a2471c81290b5ab433bb19e23b7a`
- `test/fixtures/native-opening-environment.ts`: `b4ef6f9d8b4d1970326a7070a5ce572a52bc0160fe79252c767abe64499be8d2`
- `test/fixtures/claude.ts`: `132275e4aa15e82315de47acfc9c41c70940f227f8b7bf6c2a4b78cbbce22dd9`
- `native-session.ts` and the history helper are unchanged from the preceding target.

Sol-med independently approved the bounded correction, observing **40/40** focused
tests and an adapted real-engine refusal probe for BOTH create and resume:
projects remained absent and providerCalls=0. The reviewed client/test fingerprints
match those above. Report: `/tmp/minu-sol-native-opening-rereview.md`; independent
test/probe logs: `/tmp/minu-sol-native-opening-rereview-tests.log` and
`/tmp/minu-sol-native-opening-rereview-probe.log`. No reviewer source edits or
independent full-suite/product approval. This closes the project-directory blocker
and authorized the separate codec author assignment below.

## Registration-codec contract — sol-med delivery recorded below

Original conditional assignment (now delivered): if native review finds a blocking issue, report it first. Otherwise implement only
`src/worker-registration.ts` and `test/worker-registration.test.ts`; do not modify
client/history/store/locks/transport/core/package/plan, commit/push or perform live
process/filesystem/network operations from this codec.

Internal contract: a pure bounded encode/decode validator for a private descriptor,
not publication, discovery, liveness, endpoint authentication or process-stop proof.
Use `ClaudeCodeWorkerRegistration` with exactly: `version: 1`, `runtime:
"claude-code"`, `ownership: "owned"`, `sessionId`, `ownerId`, `generation`,
`reservationId`, `pid`, `processGroupId`, `workerExecutable`, `cwd`,
`nativeConfigRoot`, `endpoint`, `token`, `createdAt`.

- Both encode/decode take expected session/owner/generation/reservation,
  workerExecutable/cwd/nativeConfigRoot scope and compare exactly, without case
  folding, path rebasing, fallback identities or inferred defaults.
- IDs match existing worker identity bounds; reservation is a lowercase UUID.
  PID is a positive signed-32-bit integer; processGroupId is that same PID or null
  (null is not group recovery eligibility). Worker executable/cwd/native root are
  absolute normalized NUL-free paths, at most 4096 UTF-8 bytes, equal to expected.
  These are string checks, not canonical filesystem/process provenance proof.
- Endpoint must be exact canonical HTTP 127.0.0.1 origin with a valid nonzero port,
  no credentials/path/query/fragment. Token is the existing 64-character lowercase
  hex private transport token, never a provider credential. createdAt is canonical
  ISO UTC generated by Date.toISOString(). Unknown or missing fields/formats refuse.
- Maximum encoded/decoded UTF-8 is 16KiB. Reject malformed JSON/UTF-8, oversized
  payloads and unsupported versions rather than truncating, repairing or migrating.
  Encoding returns a fresh bounded byte payload; decoding returns only validated
  descriptor fields. Errors are fixed bounded codes/messages, never raw payloads,
  paths, tokens, environment, prompts or underlying parser diagnostics.
- Export pure `encodeClaudeCodeWorkerRegistration` and
  `decodeClaudeCodeWorkerRegistration` plus the private types/error/size limit.
  Keep tests local/pure and cover scope isolation, process/group/endpoint/path
  bounds, secret-bearing extras, malformed/oversized data and snapshot isolation.

The subsequent store/launcher work (coworker) must independently ensure owner-
private atomic persistence under the exact lifecycle lease, reservation/CAS,
actual worker PID/executable/group identity, authenticated ready handshake and
physical exit before clearing a registration. Codec success never authorizes kill,
replacement, resume or native input. Return source hashes/checks/limitations with
an explicit Conversation mention of coworker; independent native assessment and
codec author evidence must remain separate claims.

## Registration-codec delivery — historical finding, correction closed below

Sol-med implemented only `src/worker-registration.ts` and its dedicated test, after
the separate independent native-opening review cleared. Author handoff:
`/tmp/minu-sol-worker-registration-handoff.md`; author reported typecheck and
136/136 pure tests. Coworker subsequently read source/tests, checked the exact
contract above and its existing protocol consumers, and observed all 136 cases
passing within the 197-test focused registration/store run below. An additional
pure local probe then reproduced the bounded-error defect below. **REQUEST_CHANGES**
at that initial codec checkpoint. This is coworker's local assessment of sol-med's codec,
not independent approval of coworker's store or overall managed lifecycle.

Fingerprints (unchanged by coworker):

- `src/worker-registration.ts`: `ec3252df4a1c96cfde0640d1b938dd709effba3c986e19eede9e3977aec1f577`
- `test/worker-registration.test.ts`: `70ef86323733606af8291159c17c31275c408d530911fe7691902eb18af333bf`

**MEDIUM — error sanitization bypass:** `expectedScope` and both exported codec
catch blocks rethrow any instance of the exported registration-error class. Caller
Proxy traps or a byte-array accessor can throw a caller-created instance whose
message/cause were modified; the codec forwards that exact object, leaking the
untrusted PRIVATE marker and cause instead of a fresh bounded rejection. Three
pure counterexamples reproduce (descriptor trap, expected-scope trap, payload
byteLength accessor). This is a programmatic hostile-input contract defect, not
a demonstrated remote JSON/native-IPC exploit. Report:
`/tmp/minu-coworker-worker-codec-review.md`; probe:
`/tmp/minu-claude-worker-codec-error-probe.mjs`; failing probe output:
`/tmp/minu-claude-worker-codec-error-probe.log`. The 136 existing codec tests pass
but do not cover caller-thrown instances of the codec's own error class.

Requested sol-med rework only the two codec-owned files: normalize caller-thrown
exceptions into fresh fixed bounded errors without message/cause or unsafe error-
code getter forwarding, preserve documented internal rejection codes and add the
three regressions plus hostile/invalid code-property coverage. Return exact hashes,
checks and an explicit coworker mention. Acceptance was pending that correction;
local finding closure is recorded below.

The codec has no filesystem/network/process operations. Successful validation
proves shape and supplied-string equality only, not liveness, authentication,
PID/group/executable provenance, native persistence, replacement or exit authority.

## Registration-store checkpoint — historical target before independent review

Extended the unshipped manifest to **version 3**. Versions 1/2 refuse rather than
infer worker state or silently migrate. Immutable launch policy now includes the
exact authorized `nativeConfigRoot`; normalized path strings are not filesystem
canonicalization/authorization. Added private worker state:
`none → reserved → starting(process:null) → starting(process:PID/group) → live`.
The future launcher MUST commit `starting` before fork. A crash after that commit
with no recorded PID is intentionally uncertain and cannot be released/replaced.

All transitions use the existing exact-owner lifecycle lease and revision CAS.
Ready publication snapshots a bounded codec payload before IO, checks generation,
reservation, executable/cwd/native-root scope and the previously recorded PID/group,
and atomically embeds the private transport descriptor/token in the 0600 manifest.
No provider credentials, environment or transcript are persisted. Registration
publication is not an authenticated readiness handshake or OS provenance check.

Only the current unfenced pre-fork `reserved` attempt can be released without
process exit evidence. A fresh revision or adopted top-level generation cannot
launder an old reservation's release authority; dedicated regressions cover both
a persisted human fence and a changed generation. For recorded starting/live workers, `clearWorkerAfterExit` requires the exact
reservation/PID and rotates the generation, preserving native binding, dispatch
uncertainty and any human-resume fence. **Physical exit is the caller's independent
precondition for exact worker AND managed native/group exit: PID equality or a
native-stop acknowledgment is NOT exit evidence.** No process is launched/signalled
by this store. Uncertain allocation/input, empty bound history and explicit-resume
fences refuse a new reservation; settled bound history still requires the native
opening validator before any future resume.

`withWorkerAdmission` checks the current unfenced generation and exact complete
private live descriptor, then holds the real lifecycle lease through the supplied
operation. Idle/drain waits remain outside admission in the existing bridge.
It is exercised with the actual loopback bridge, not yet installed by a production
worker entrypoint. Native binding/dispatch still must use the supplied lease rather
than recursively reacquire the lock. It does not establish OS process identity or
provide out-of-band recovery authority.

Observed author evidence on Node 22.23.0, Darwin arm64:

- `pnpm check` — passed. An initial TypeScript narrowing error in the new unknown-
  worker validation was corrected before executing tests; no failing test hidden.
- `node --test packages/claude-code/dist/test/{managed-store,managed-dispatch,managed-worker,worker-registration}.test.js`
  — **197/197 passed**: 61 store/dispatch/registration-integration cases and 136
  unchanged pure codec cases. New 22 cases cover CAS/owner/generation/nonce scope,
  irreversible start/PID binding, bounded/snapshotted publication, corruption and
  immutable policy, allocation/input/recovery fences, exact cleanup/rotation,
  real SQLite admission lifetime, real loopback post-revocation frame refusal,
  manifest overflow without partial token publication, and child SIGKILL before
  AND after publication for all five worker transitions.
  Log: `/tmp/minu-claude-worker-store-tests.log` (use `rg -a`: one existing codec
  malformed-field test name contains its test NUL).
- Focused execution used a disposable HOME/config root, dummy key and unreachable
  localhost provider via an allowlisted environment. New filesystem-only crash
  children also explicitly replace environment/preloads. No native harness or
  provider was launched by the new registration-store tests.
- Tracked and changed/new-file whitespace checks — passed.
- The historical 258/258 workspace run predates native override, codec and store
  changes; no current full-suite or independent store approval is claimed.
  Run combined workspace/native/process checks at the real launcher integration.

SHA-256 for this checkpoint:

- `src/managed-store.ts`: `61ba35c43d085d4661eb783d3a2fbf312322c174627c2efd9c80e248a5bedc18`
- `test/managed-worker.test.ts`: `cd8fa5e5ee6027b035b34da8c5867663efb12e0941d3fe1d73af42b4315b7345`
- `test/managed-store.test.ts`: `79bb754bbc65c5dd4f9c3d1f88846a9b97a704bfaf61c464d0fae9ab820614cb`
- `test/managed-dispatch.test.ts`: `b04929187d09c2d43c4ac544e414a7ff0c07a5ee16009c2001654930945aba68`
- `test/fixtures/store-worker-crash.ts`: `0f31b2e9f0481451d2896aded566cb1b29a1eea0f8e783c9f5f77487ebd03d2a`
- `src/lifecycle-lock.ts` is unchanged at `409022aa1ca48ce722f5062c4c93e1564d88912193aa067b6de24f42d7325208`.

No public managed methods/exports, real launcher/discovery, native input integration,
suspend/resume/destroy/recovery or inheritance-policy changes are enabled. Before
R19/R20 acceptance, recovery must durably fence even a worker holding a busy or
unresponsive lifecycle lease; a normal RPC or waiting on that same lock is not a
sufficient recovery design. Starting-without-PID must not be automatically cleared.
A native-stop acknowledgment, metadata state or this codec cannot substitute for
confirmed exact worker/group exit. Verifier remains unconnected/review pending.

## Codec sanitization correction — local finding closure

Sol-med changed only the codec and its test, normalizing caller exceptions into
fresh bounded errors through private internally generated rejection identities;
no caller error properties/prototypes/getters are inspected. Publicly returned
errors are not trusted if thrown back. New checks cover 28 hostile combinations
and preserve documented internal error codes. Author handoff:
`/tmp/minu-sol-worker-registration-rework-handoff.md`.

Coworker read the correction/tests and observed all **138 codec tests** passing
within the 201-test combined run below, plus all three original unchanged safety
probes passing. No caller identity/cause was forwarded. **APPROVE** for this
bounded correction; the MEDIUM codec finding is locally closed. Report:
`/tmp/minu-coworker-worker-codec-rereview.md`; probe evidence:
`/tmp/minu-coworker-worker-codec-recheck.log`. Coworker made no codec source edits.
This does not independently approve coworker's store or overall managed lifecycle.

Updated SHA-256:

- `src/worker-registration.ts`: `72340515465187bad9031c07986b186fb4a712a72a166d26877bec657ba633fe`
- `test/worker-registration.test.ts`: `3c780fdb5f726edc088270a064f8b98864776f5fbf23f0a1273f8c0e1652b82e`

## Manifest UTF-8 correction — independently approved finding closure

Sol-med independently requested **MEDIUM** changes on the frozen registration-store
checkpoint: `Buffer.toString("utf8")` silently repaired corrupt bytes before JSON
and registration validation. Corrupting BOTH saved cwd occurrences with 0xFF kept
their repaired strings equal, so a malformed live descriptor was accepted with
U+FFFD workspace paths. The permissive decoder predates registration, but the new
object-based registration validation materially exposes it. The reviewer observed
61/61 focused store tests passing and a separate real-filesystem reproduction.
No additional actionable reservation/admission issue was reported; OS provenance
and future launcher/recovery work were not treated as delivered. Report:
`/tmp/minu-sol-worker-store-review.md`; original probe:
`/tmp/minu-sol-worker-store-corruption-probe.mjs`.

Coworker changed only the manifest read boundary and two test files: fatal UTF-8
decoding now precedes JSON parsing. BOM is preserved for strict JSON refusal, not
stripped. Encoding/JSON failures return one fixed bounded error without underlying
parser/path/payload diagnostics or cause; schema validation remains separate.
Invalid storage is not rewritten, skipped from inventory or admitted. No format,
launch policy, worker transition, native input, process control or public API change.

Observed author checks on Node 22.23.0, Darwin arm64:

- `pnpm check` — passed.
- `node --test packages/claude-code/dist/test/{managed-store,managed-dispatch,managed-worker,worker-registration}.test.js`
  — **201/201 passed**: 63 store/dispatch/registration cases plus 138 corrected
  codec cases. Two new tests cover raw-byte corruption in matching live cwd scopes,
  valid Unicode INCLUDING a genuine encoded U+FFFD, malformed/truncated UTF-8, BOM,
  malformed JSON, read/list/update/admission refusal, bounded diagnostics and exact
  preservation of corrupt bytes. Log: `/tmp/minu-claude-worker-store-rework-tests.log`.
- Original codec safety probe — all three pass, as recorded above.
- Adapted corruption assertions — passed: invalidUtf8=true, rejected=true,
  storageUnchanged=true. Original peer probe is preserved unchanged. Recheck:
  `/tmp/minu-coworker-worker-store-corruption-recheck.mjs`; log:
  `/tmp/minu-coworker-worker-store-corruption-recheck.log`.
- Checks use disposable HOME/config, dummy credentials and allowlisted environment;
  no native harness, paid call, real credentials or global configuration changes.
- Historical 258-test full-workspace evidence predates these changes. No fresh full
  suite, independent store closure or product/native acceptance is claimed.

Current correction fingerprints:

- `src/managed-store.ts`: `d7da26e053f3f7a1fe5a1bc4ef8351dfb876b0b255541e184a8f2ad141b8a408`
- `test/managed-store.test.ts`: `639b6d43b7618cc30135b3ab2df4f64a9edf8dc412230ff5dbf77644bca5c665`
- `test/managed-worker.test.ts`: `5350da2691460d5d3775c3db49d10d6793b4ad65f87ae187d4e78a71e997e53a`
- Dispatch tests, crash fixture, locks and transport are unchanged from the preceding
  registration-store snapshot.

Sol-med independently approved the correction/store checkpoint after **63/63**
focused store tests and the adapted original two-field corruption scenario: read,
list and admission rejected; operationEntered=false; bytes unchanged. Valid Unicode
remained exact and fingerprints matched. Report:
`/tmp/minu-sol-worker-store-rereview.md`; probe evidence:
`/tmp/minu-sol-worker-store-corruption-recheck.log`. No reviewer source edits,
independent full-suite/typecheck or product lifecycle approval. The finding is
closed; do not add another cycle absent a concrete new concern. Public managed
APIs and verifier assessment remain unfinished.

## Worker-side managed native driver — author verified, independent review pending

Added only `src/managed-session.ts`, its test and the new `fixtures/managed-native.ts`.
No store/client/native-helper/transport/core/Pi/Channels/dependency changes. Package
index still exports only the initial adapter. This is an internal single-session
worker facade over the native SDK, not a replacement agent loop or public managed
launcher. It is created before the bridge, initialized once AFTER private worker
publication, and made remotely admissible only after initialization succeeds.

- Requires real metadata-backed owner/generation/complete-descriptor admission for
  commands. AsyncLocalStorage plus explicit expiry ties the supplied lifecycle
  lease to the admitted async call chain: unrelated calls cannot borrow a global
  active lease, and retained descendants cannot use it after callback return.
  Saved launch policy and native binding are checked against the living facade.
- Initialization verifies self PID, claims one facade per worker epoch even after
  failure/stop, snapshots the authorized environment, validates the workspace and
  supported policy, and refuses uncertain creating/dispatch/empty-bound states.
  Self PID is NOT executable/group/incarnation provenance or recovery authority.
  Native inheritance/tools-defaults and explicit model/reasoning/skill intent still
  refuse as unimplemented rather than silently falling back.
- Pending workers allocate no native process/thread before valid text input.
  The first admitted caller records creating(UUID), opens without dispatch, binds
  that exact UUID, and persists exact caller/fingerprint/native-message intent
  BEFORE mapped SDK dispatch, all under the supplied lease. The separate SDK child
  reads the production manifest before handling user input to verify this order.
  Runtime/native IDs remain separate; no hidden bootstrap prompt or replacement.
- Bound initialization uses the exact history validator/native resume path. No
  replay or caller-turn reconstruction from text; missing/uncertain history refuses.
  A previous persisted caller ID without a retained result cannot be redispatched.
- Worker-lifetime retained turns deduplicate exact input and keep failed preparation
  records accessible. SHA equality also requires exact JS text equality. There is
  no eviction-and-reuse: at the configured limit (default/max 1,000 accepted IDs),
  new caller IDs refuse for that worker lifetime. This is not a durable result
  ledger or exactly-once tools; cold resume begins a new lifetime, not blind retry.
- Only native terminal evidence or definite undispatched cancellation may persist
  settlement. The ordered observer targets the matching turn; late A idle/error
  frames cannot settle B. Terminal publication follows queued text/tool frames.
  Native crash, stop acknowledgment, failed dispatch/publication or lost settlement
  confirmation never fabricates settled metadata. Failed results remain locally
  recoverable while allocation/input uncertainty stays durable.
- Native text/tools and curated activity pass through the actual loopback bridge;
  only one logical turn-start/terminal is emitted. Control acknowledgments do not
  settle turns. Privileged self-cleanup outside admission closes owned native
  handles/observers even after revocation but does NOT clear metadata or prove
  worker/group exit. An opening failure without a returned handle conservatively
  reports shutdown unconfirmed; the future supervisor must prove physical exit.

Verification on Node 22.23.0 / Darwin arm64:

- `pnpm check` — passed. Initial static errors for the known post-open native handle
  and a test-only client method name were corrected before the final checks.
- Focused `node --test packages/claude-code/dist/test/managed-session.test.js` —
  **18/18 passed**, no skips on this host. Includes actual SDK protocol peer +
  real filesystem/SQLite/HTTP: lazy allocation and persist-before-dispatch,
  exact retry/conflict and retained reconnect, ordered two-turn text/tool/activity
  streams, async-chain lease isolation/expiry, self-PID/single-epoch constraints,
  interrupt ack versus settlement, observed failed/interrupted outcomes, native
  crash/startup/binding/settlement failures, history resume/refusal, uncertainty and
  recovery/policy/generation fences, environment snapshots and lifetime bounds.
  Log: `/tmp/minu-claude-managed-session-tests.log`.
- Building the streaming regression exposed premature terminal publication when
  reconciling a queued working frame against a newer native turn snapshot. The
  observer now reconciles only ordered terminal boundaries with an explicit
  observed turn target. Two-turn ordering assertions cover late A-status/B overlap.
  An initial oversized-input fixture also incorrectly assumed 128KiB; it now uses
  the existing shared 1MiB limit rather than changing/weakening the production gate.
- `pnpm test` — **441/441 passed**, no failures, at this combined driver integration
  point. Log: `/tmp/minu-claude-managed-session-integrated-tests.log`. This is current
  author workspace evidence; earlier 258/201 evidence remains historical/scoped.
- Tracked and new-driver whitespace checks — passed.
- Tests use disposable homes/config, dummy credentials and allowlisted environment.
  New driver scenarios use a real SDK + protocol child, not a real model/tool. The
  workspace includes prior bundled-engine/local synthetic-provider cases. No paid
  calls, inherited real credentials or global configuration changes. R40 actual
  model/tool/authentication, subscription policy and cross-platform acceptance
  remain unverified.

SHA-256:

- `src/managed-session.ts`: `cb46926569c5a4854359b5374e1386dda97b87989e21e4c2539ed19dc2f20376`
- `test/managed-session.test.ts`: `6c1adb79b84a3d87817b1fef534c47c8f50676d318385dd85bc00c8dc4df1898`
- `test/fixtures/managed-native.ts`: `1ec46ec6981e13d6fd70bdc6adc3ca904e575c644455327034e1834287b8196e`
- Approved store remains `d7da26e053f3f7a1fe5a1bc4ef8351dfb876b0b255541e184a8f2ad141b8a408`.

Read-only driver review requested from sol-med; exact scope and follow-up investigation
contract: `/tmp/minu-claude-managed-session-handoff.md`. If clear, investigate the
minimum provable owned-worker startup/group-exit/recovery boundary using only own
disposable children. Do not implement unproven process heuristics or modify shared
sources. Coworker retains supervised launcher/lifecycle integration. R19/R20 still
need durable out-of-band fencing when a worker holds an unresponsive lease. Public
managed APIs remain disabled. All matrix requirements remain required; no commit,
push, primary Codex or Channels changes, or overall product acceptance.

## Revised scope / R30 headless handling — chunk 1 independently approved

Owner scope clarification removes R42–R44 from completion gates; they require a
separate decision if pursued. R01–R41 remain required, including safe headless
permission/user-answer handling. This supersedes the older external driver
handoff's R01–R44 wording. There is no new approval UI commitment.

Read-only cross-adapter assessment found:

- Codex's primary RPC rejects interactive server requests and aborts its owned
  process; existing source/test inspected only, not changed or rerun here.
- Pi's RPC forwards `extension_ui_request` records, but owned-worker does not
  handle blocking select/confirm/input/editor dialogs. Native docs say these wait
  for a response, with optional timeouts; dropping them can leave work waiting.
  Pi's `--approve` is PROJECT TRUST, not a user-dialog answer. Notifications are
  nonblocking and must not be mistaken for questions. This is a source/doc gap,
  not live Pi acceptance. No Pi or active Codex source edits.
- Claude already denies permission requests by default and SDK MCP elicitation
  defaults to decline. Its separate unexpected `request_user_dialog` path was
  unhandled: the SDK deliberately leaves it unanswered. Native normally emits
  only declared renderer kinds, but unexpected frames must still fail safely.

Added only an owned-session `onUserDialog` handler in `client.ts`: mark the exact
owned session failed/offline with a bounded error, confirm known native-process
shutdown, and fail the request. Do NOT synthesize a human answer or dismissal,
declare dialog-rendering support, stop another session, or affect external
attachments. Existing permission policy, sandbox claims and native inheritance
settings are unchanged; canUseTool is not a universal native-tool gate.

Observed author checks:

- Added dialog/elicitation fixture scenarios and four headless regressions.
  Before the correction, both known/future dialog cases timed out, **2/3** checks
  failed; default MCP elicitation declined as expected. Log:
  `/tmp/minu-claude-headless-red.log`. The added isolation case verifies another
  owned session still works after the offending session stops.
- `pnpm check` passed.
- `node --test packages/claude-code/dist/test/{runtime,native,native-session,managed-session,worker-bridge,worker-protocol,worker-fencing}.test.js`
  — **82/82 passed**, no skips, Node 22.23.0 / Darwin arm64. Includes actual SDK
  protocol request/refusal, fixed private-data-free failure, physical native exit,
  unrelated-session isolation and the affected persistent/managed/worker cases.
  Log: `/tmp/minu-claude-headless-tests.log`.
- Disposable native homes, allowlisted env, dummy credentials/local synthetic
  providers; no paid calls, inherited real credentials or global config changes.
- Earlier 441/441 workspace evidence PREDATES this R30 correction. No new full
  workspace, independent R30/driver approval, R40 or product completion claim.

Chunk 1 reviewed SHA-256 (historical baseline for chunk 2):

- `src/client.ts`: `2313234e421912577f08d21c42284c8a71e271971814175780ab151781d15e2b`
- `test/runtime.test.ts`: `1c71e718ac3ba4ae44b4883268432ff1e5edf70fb4ee86583a4e9faf3aac5b47`
- `test/fixtures/claude.ts`: `bf664fa9dc3c9c6314f0a5f356e75325f3138abd6940d47c7cda97660dd8514e`

Sol-med independently **APPROVED chunk 1 only**, observing 82/82 affected tests and
separate known/unknown-dialog probes. Both probes confirmed owned native-process
exit BEFORE any later explicit runtime.stop cleanup, with no fabricated answer or
private dialog text. Report: `/tmp/minu-sol-headless-dialog-review.md`; probe:
`/tmp/minu-sol-headless-dialog-review-probe.log`. No reviewer source changes or
independent full-suite/driver/provenance approval. Chunk 1 is closed.

The owner's smaller-chunk sequence is now:

1. Claude saved dialog refusal — independently closed.
2. Claude permission-callback timeout/cancellation — independently closed.
3. Pi blocking-dialog handling without changing project trust — independently closed.
4. Verify Codex's existing refusal — independently closed; active work untouched.
5. Common cross-adapter conformance cases — independently closed.

All five bounded headless chunks are closed. The owner approved continuing with
the existing managed driver's initialization/admission review. Slice A is now
independently closed, as are slice B's first-input binding/dispatch intent and
slice C's terminal observation/durable settlement.
D1's launch/readiness/adoption study is complete; D2's private worker bootstrap
composition and D3's three parent launch/publication checkpoints are independently
closed within scope. Readiness supervision, cleanup,
OS/recovered process provenance and public lifecycle remain separate; no public
managed API is enabled.

The headless chunks did not include driver/provenance work; subsequent bounded
A/B/C driver reviews/corrections are recorded below. D1 does not include recovered
OS/group provenance. Shared direction remains native adapter-specific refusal
under one behavioral contract, not an approval UI or new framework. R01–R41 remain
required; R42–R44 need separate scope approval.

## Headless chunk 2 — historical target before independent deadline finding

Only `src/client.ts`, new `test/permission.test.ts` and the existing protocol fixture
changed. Uses the existing `controlTimeoutMs` (default 10 seconds), not new config
or a separate policy framework. Default denial and timely explicit allow/deny
policies are preserved; native auto-authorized tools remain outside this callback.

Configured callbacks now receive a signal tied to native request withdrawal,
Runtime stop and the exact captured turn's interrupt/settlement lifetime. Callback
waiting is raced against cancellation/deadline. A withdrawn/cancelled request is
refused without inventing turn settlement; a late A decision cannot grant B.
Deadline, callback error or missing/null decision fails the exact owned session,
confirms known native-process shutdown and uses fixed non-sensitive failure text.
Null/out-of-band responses are explicitly unsupported: Runtime cannot verify that
some external approval transport already replied. No replay or rollback is implied.

Callbacks receive the original request metadata plus the scoped signal. Their
async results are discarded after expiry; arbitrary trusted callback code that
ignores cancellation may still run, and this is not CPU preemption/OS sandboxing.
Per-turn controllers are aborted by existing finish/interrupt paths. Native
request cancellation alone does not stop a healthy session or fabricate a result.

Observed author checks on Node 22.23.0 / Darwin arm64:

- `pnpm check` passed after correcting a Promise-union inference annotation before
  tests ran; no production policy/gate was weakened.
- `node --test packages/claude-code/dist/test/permission.test.js` — **6/6 passed**.
  Actual SDK + isolated protocol child covers hung callback/deadline/automatic exit,
  late allow, native withdrawal without fabricated settlement, interrupted A versus
  pending B, stop cancellation, null/error refusal without private diagnostics,
  and timely explicit allow/deny. Log: `/tmp/minu-claude-permission-tests.log`.
- `node --test packages/claude-code/dist/test/{permission,runtime,native,native-session,managed-session,worker-bridge,worker-protocol,worker-fencing}.test.js`
  — **88/88 passed**, no skips. Covers the changed shared finish/interrupt hooks and
  existing persistent/worker behavior. Log:
  `/tmp/minu-claude-permission-regression-tests.log`.
- Tracked and changed/new-file whitespace checks passed.
- Disposable HOME/config, allowlisted env, dummy credentials and localhost
  synthetic providers only. No paid calls, inherited credentials or global edits.
- No new full-suite or independent chunk 2 approval. Historical 441/441 predates
  chunks 1/2; affected driver tests passing is not review approval of that driver.

Current SHA-256:

- `src/client.ts`: `155086078c1539f9dbf7a59469092ca63daae030b132d9666e380c1f2f0d3946`
- `test/permission.test.ts`: `22df6c6ec0db3c6dc766209fda09bf83b40afe6ee65c83d6d7e829b4abb34380`
- `test/fixtures/claude.ts`: `e5ff29bdf8cf7d9ee46151f7fa95617d115caad6bcd7d7453a71ade610f5fc6d`
- Chunk 1 runtime tests remain `1c71e718ac3ba4ae44b4883268432ff1e5edf70fb4ee86583a4e9faf3aac5b47`.
- Deferred driver source remains `cb46926569c5a4854359b5374e1386dda97b87989e21e4c2539ed19dc2f20376`.

Requested sol-med's read-only review of chunk 2 ONLY; scope/hashes/criteria:
`/tmp/minu-claude-permission-handoff.md`. Do not start Pi/Codex/conformance or reopen
larger driver/provenance work until this chunk closes. Public managed APIs remain
disabled. No commit/push, Pi/Codex/Channels changes, R40 or product completion.

## Chunk 2 monotonic deadline correction — independently closed

Sol-med independently requested **MEDIUM** changes after 88/88 existing affected
tests passed: an async callback doing 80ms of synchronous work returned allow under
a 20ms limit. Its Promise resolved before the starved timer ran, so the native peer
received an expired approval. Report: `/tmp/minu-sol-permission-review.md`; original
probe: `/tmp/minu-sol-permission-deadline-probe.mjs`. No reviewer source changes or
other actionable finding; review stayed within chunk 2.

Changed only `client.ts` and `permission.test.ts`. A monotonic expiry is captured
before waiting and checked after awaiting the result AND immediately before
forwarding its copied decision. If expired, the existing fixed timeout/abort/
offline/known-process shutdown path runs. Timer-based asynchronous bounds remain;
this does not preempt synchronous callback code or add any framework/configuration.

Observed author evidence:

- New 80ms/20ms regression failed before the source fix (completed rather than
  failed). Log: `/tmp/minu-claude-permission-overdue-red.log`.
- `pnpm check` passed.
- Affected permission/runtime/native/opening/driver/worker tests — **89/89 passed**,
  no skips on Node 22.23.0 / Darwin arm64, including all **7 permission tests**.
  New regression asserts no allow reply, timeout/offline failure, signal abort and
  automatic physical native exit before explicit stop cleanup. Log:
  `/tmp/minu-claude-permission-rework-tests.log`.
- Original unchanged peer probe now reports ≈80ms callback, success=false, fixed
  timeout error, offline status and empty replies. Log:
  `/tmp/minu-claude-permission-deadline-recheck.log`. The probe logs observations;
  the new repository regression supplies explicit safety assertions.
- Disposable HOME/config, allowlisted env, dummy credentials/local providers;
  no paid calls, inherited real credentials or global settings changes.
- At this author checkpoint, independent closure was still pending. No fresh full
  suite or product acceptance. Subsequent independent closure is recorded below.

Current SHA-256:

- `src/client.ts`: `99251941446a4ebdc12ce19da066cdc83c10c394ace6513f8bb0e92815022853`
- `test/permission.test.ts`: `9eddad418c7ba3c03fdca85df0ff8839db2427e3e106e864a1c2586e45bf4a67`
- Fixture unchanged at `e5ff29bdf8cf7d9ee46151f7fa95617d115caad6bcd7d7453a71ade610f5fc6d`.

Sol-med independently **APPROVED** the bounded correction in
`/tmp/minu-sol-permission-rereview.md`: 89/89 affected tests passed, exact target
fingerprints matched, and the unchanged 80ms/20ms probe returned timeout/offline
with no native approval reply. No source edits or independent full-suite claim.
Chunk 2 is closed. That approval does not cover other adapters, deferred driver/
provenance or complete Runtime delivery.

## Headless chunk 3 — Pi owned RPC dialog guard; independently closed

Scope is only `packages/pi/src/pi-rpc.ts`, the fixed-error forwarding branch in
`packages/pi/src/owned-worker.ts`, and new `packages/pi/test/headless-ui.test.ts`.
Compared against unchanged HEAD `f0ffbfcc5f24e75174bff1919aa5cd41ce22d732`:

- Baseline `pi-rpc.ts`: `5fe0a228b8fa19804db82965631560be8f2424678f30cc68b6774b2ef7173ccb`.
- Baseline `owned-worker.ts`: `ca1028b1ce59d970af45f919ab4b7a1ce79a140713fcd0600a1b627513e6d951`.

The owned RPC transport refuses blocking `select`/`confirm`/`input`/`editor` and
unknown/missing/malformed UI methods. It rejects pending and future requests with
`Pi requested unsupported interactive input`, publishes only a fixed internal
error, fences remaining buffered/later frames, and automatically stops its exact
owned child using existing TERM/KILL/confirmed-exit behavior. A refusal is not
itself proof of physical exit; tests wait for the child exit separately. Observer
failure cannot prevent shutdown or turn the private dialog into parse diagnostics.
No fabricated answer, cancellation or `extension_ui_response` is sent.

The documented fire-and-forget methods `notify`, `setStatus`, `setWidget`,
`setTitle` and `set_editor_text` retain their existing event behavior and receive
no reply. The constructor's `--approve --mode rpc` is unchanged: project resource
trust is not answering an interactive request. No tool restrictions, new policy
configuration, UI, framework, native-extension changes or attached-TUI controls.
The worker forwards the fixed error; its existing native-exit shutdown supplies
turn failure/offline. No worker/group lifecycle/provenance completion is claimed.

Observed author evidence on Node 22.23.0 / Darwin arm64:

- New confirm regression failed before the guard: missing expected rejection.
  Log: `/tmp/minu-pi-headless-red.log`.
- `pnpm check` passed. One test initially supplied an unsupported extra argument
  to the existing events API; the test was corrected without changing the API.
- New focused file — **13/13 passed**, no skips. Real subprocess pipes cover all
  blocking methods, unknown/malformed methods, late buffered settlement, refusal
  of further dispatch, fixed private diagnostics, observer failure, unaffected
  notifications and a separate healthy process. Owned worker/HTTP/SSE integration
  confirms send failure, fixed error/offline, no turn completion and automatic
  native exit before explicit stop cleanup.
- A real workspace-installed Pi **0.84.3** CLI and explicit disposable extension
  exercised `ctx.ui.confirm` via a slash command without a model call. The process
  exited automatically and code after the dialog never received a decision.
  This is native protocol evidence, not real model/tool/authentication acceptance.
- `node --test packages/pi/dist/test/*.test.js` — **90/90 passed**, no skips.
  Logs: `/tmp/minu-pi-headless-focused.log`, `/tmp/minu-pi-headless-regression.log`.
- Tests ran with `env -i`, disposable HOME/TMPDIR, allowlisted PATH, and no provider
  credentials or global configuration changes. No paid calls. Whitespace checks
  passed, including the untracked test file.

Current chunk 3 SHA-256:

- `packages/pi/src/pi-rpc.ts`: `3e6f97cf1960410852c84f18cf349de708d03cdb14ad500e47f2fe5e97abb9ad`.
- `packages/pi/src/owned-worker.ts`: `915150cc00b6c8cd73fbf0f851ebe9a10e3df2322c96638fa4a46f7806acf2e4`.
- `packages/pi/test/headless-ui.test.ts`: `5a8251e12a2319669b6cc3c6579481cb6950f9a60bed592a05f5701c7cc066f6`.

Sol-med independently **APPROVED chunk 3 only**, running 90/90 Pi tests in an
isolated environment, including the real native-extension dialog case. No
findings or source edits. Report: `/tmp/minu-sol-pi-headless-review.md`; independent
log: `/tmp/minu-sol-pi-headless-review-tests.log`. Chunk 3 is closed. No broader
R30, full-workspace, process-group/provenance or product approval is implied.

## Headless chunk 4 — existing Codex refusal verification independently closed

Verification only; no Codex or other adapter source/test/build-output edits.
The Claude worktree has no Codex package. The active primary Runtime checkout is
`/Users/davidkennedy/Workspaces/minuscule-labs/runtime`, HEAD
`86f81102db9ddacade58009d040a95253188992b`, with an untracked Codex package.
To avoid touching its active implementation or derived outputs, copied a hashed
Codex source/test/config + core-source snapshot into
`/tmp/minu-codex-headless-snapshot.IGT29c`. Exact copy was checked against the
before/after primary manifest before building. Dependencies use existing installed
tooling; private core linkage and all build/test output stay inside the snapshot.

The existing owned app-server transport handles any string-method JSON-RPC server
request (defined id, not a notification) with a best-effort fixed -32601 error,
then fails pending/future work and stops its captured child. Buffered/later records
are fenced. Public failure is fixed:
`Codex requested an unsupported interactive operation; session stopped`.
A notification without id retains its existing behavior. Native approvalPolicy
`never` and configured read-only/workspace-write sandbox values are unchanged;
this verification does not establish OS sandbox effectiveness or a universal tool
gate. No UI, fabricated answer, replay or new shared abstraction was added.

Observed author checks on Node 22.23.0 / Darwin arm64:

- Snapshot `tsc -b packages/codex --pretty false` passed. This covers the captured
  source/test revision, not a build claim about subsequent primary edits.
  Log: `/tmp/minu-codex-headless-check.log`.
- All **7/7 RPC tests** passed: existing unknown-request refusal, normal responses,
  split UTF-8, bad/oversized frames, bounded deadline with TERM/KILL escalation,
  missing executable and configuration validation.
- **5/5 selected boundary tests** passed: existing interactive refusal in direct
  Runtime, worker bridge and pending worker; two launch-policy preservation cases.
  Pattern: `interactive|launches an owned Codex|defaults to read-only`, across
  `runtime`, `worker-bridge` and `pending-worker` test files. Passing these selected
  cases is not managed driver/lifecycle review or the entire Codex suite.
- Eight additional asserted protocol-peer process probes passed: command/file
  approvals, user input, elicitation and unknown methods; requests during startup,
  idle and active request waiting; numeric/null ids; TERM-resistant child; normal
  notifications; late buffered frames; fixed/private diagnostics; refusal of future
  dispatch; unrelated healthy process. Every case observed physical owned-child
  exit BEFORE explicit stop cleanup. No successful answer/approval was returned.
  A structured error was observed in two cases; other cases exited before peer
  receipt. Delivery of the best-effort error is not falsely claimed.
- Tests ran with `env -i`, disposable HOME/TMPDIR/CODEX_HOME and allowlisted PATH;
  only synthetic subprocess protocol peers, no native Codex binary/provider calls,
  paid calls, inherited credentials or global configuration changes.

Logs: `/tmp/minu-codex-headless-rpc-tests.log`,
`/tmp/minu-codex-headless-boundary-tests.log`, `/tmp/minu-codex-headless-probe.log`.
Probe: `/tmp/minu-codex-headless-probe.mjs`; peer:
`/tmp/minu-codex-headless-peer.mjs`. Snapshot source manifest SHA-256:
`a37e3157b8cb973ed8f269fb1fe45bdd189b0e83b8701d1524909078b797d546`.

The primary package advanced during verification in TWO unexecuted test files,
`event-stream.test.ts` and `managed-runtime.test.ts`. Production/core source,
fixtures and the four selected test files still match the snapshot. Captured
comparison: `/tmp/minu-codex-headless-primary-delta.diff`; no overwrite, rebase or
broad retest was needed for this bounded unchanged target.

Key Codex SHA-256 (remaining files/config are pinned by the snapshot manifest):

- `src/rpc.ts`: `908b312e44657632c67a05e7c6437177feb5dd1db1eeb587cf16f9e42f8c1846`.
- `src/client.ts`: `f122b670e29a4a8b8a1b4f894decfed881f016db12e734335c380d41df77837d`.
- `test/rpc.test.ts`: `21dc697c463cdda26bcbee754652e85e5e5d104bf3932d02a01e74d6c345d3f3`.
- `test/runtime.test.ts`: `8f296396a46f965495f28f2a77552cd41bec6e19eb5114abc055221c26fdca3a`.
- `test/worker-bridge.test.ts`: `d37ca4a077a67759b8cb3ac20ffb5a0816c951f06459a5f87eefc159b23d3d19`.
- `test/pending-worker.test.ts`: `41828a81a468a218c95209c79ddd1052a1090c2167c99e1af709e16bddbdd2e4`.
- `test/fixtures/app-server.ts`: `5813860b6cb271617803e534ffa458eeb9e44f7beac3cd9837bcbac47c6c436c`.

Sol-med independently **APPROVED chunk 4 verification only**, checking the full
snapshot manifest and passing 12 focused tests plus all 8 asserted probes in an
isolated environment. No findings, source edits or primary builds. Report:
`/tmp/minu-sol-codex-headless-review.md`. This closes chunk 4, not real Codex-binary,
full-suite, shared conformance or managed lifecycle/provenance acceptance.

## Headless chunk 5 — common behavioral conformance independently closed

Tests only: new `test/headless-conformance.test.mjs`, isolated launcher
`test/run-headless-conformance.mjs`, synthetic Pi peer
`test/fixtures/pi-headless.mjs`, one `package.json` script and the README Development
usage paragraph. No production adapter/core, dependency, CI, existing fixture or
policy changes. Claude/Pi implementation fingerprints are unchanged.

One set of assertions exercises the PUBLIC send/status/events/stop APIs of all
three real adapter implementations, with protocol-specific fixture setup only:

1. Known unsupported interaction: failed send, fixed observable error without
   private question data, offline, actual owned-native exit BEFORE cleanup stop,
   no successful answer, no future dispatch, unrelated session still healthy.
2. Unknown future interaction: same contract, without assuming all future methods
   are supported. No invented cancellation/answer.
3. Nonblocking native activity: successful send/idle, living native process and
   observable native tool activity, with no new interaction answer.
4. Explicit stop while native work remains unresolved: failed rather than
   manufactured-success send, offline and confirmed native exit. This is stop
   cancellation, NOT a new human-answer/callback cancellation interface.

These are four cases per adapter, **12/12 passed**, no skips. Error responses are
allowed where the native protocol supports them; no delivery guarantee is made
for a response racing physical shutdown. Claude default permission denial,
callback deadlines/withdrawal/late results and MCP decline remain separately
covered by its adapter-specific tests, not fake common approval APIs. Codex's
terminal event name is not confused with turn success; assertions use send outcome.

The launcher rebuilds an allowlisted child environment before adapter imports and
startup (private HOME/TMPDIR/CODEX_HOME/CLAUDE_CONFIG_DIR/registry; Node/system PATH).
No credentials, paid/provider/model calls or global settings. Protocol peers are
synthetic; actual OS processes, SDK/native transport and Pi worker/HTTP/SSE are
exercised. The existing real Pi-extension and bundled Claude/synthetic-provider
cases also pass in the separate workspace suite, not relabeled shared-native R40.

The explicit `pnpm test:headless` integration command supplements existing
`pnpm test`; no existing gate was changed. It is not yet a default CI gate. All
three built adapters are required and missing Codex artifacts fail nonzero, never
silently skip. By default Codex is resolved only in this checkout. Until packages
are integrated together, an explicit absolute `MINU_RUNTIME_CODEX_TEST_ROOT` can
name a built artifact root; no discovery/fallback to active primary occurs.
Verification reused the independently checked Codex snapshot
`/tmp/minu-codex-headless-snapshot.IGT29c`, manifest SHA-256
`a37e3157b8cb973ed8f269fb1fe45bdd189b0e83b8701d1524909078b797d546`.
Its source/derived output and active primary Codex were not edited or built.
The unknown Codex case adjusts a copy of its synthetic peer in a private temp
folder; it never patches the original fixture or implementation.

Observed author evidence on Node 22.23.0 / Darwin arm64:

- `node --check` passed for all three new .mjs files; `pnpm check` passed.
- `MINU_RUNTIME_CODEX_TEST_ROOT=/tmp/minu-codex-headless-snapshot.IGT29c pnpm test:headless`
  — **12/12 passed**, no skips. Log: `/tmp/minu-headless-conformance-tests.log`.
- Empty explicit artifact root: launcher exits **1** with the required-artifact
  diagnostic. Log: `/tmp/minu-headless-missing-artifacts.log`.
- Full CURRENT Claude-worktree `pnpm test` — **465/465 passed**, no skips, in an
  isolated allowlisted environment. Log: `/tmp/minu-headless-integration-tests.log`.
  This includes core/Pi/Claude, NOT the external Codex suite or the separate 12-case
  command. Counts are separate, not a fabricated single 477-test run.
- The first full-suite launcher attempt exited 127 before any test ran because the
  minimal PATH lacked pnpm. Resolved once by explicitly allowlisting the installed
  pnpm bin alongside Node/system bins; no failing tests were hidden or retried.
- Tracked/new-file whitespace checks passed. No commit/push/publication, dependency
  installs, primary-source writes or CI modifications.

Chunk 5 SHA-256:

- `package.json`: `cf6e1c43b444455a42cc571869858127d45f404623ff61c5db46e0489ba149b0`.
- `test/headless-conformance.test.mjs`: `dccb4b7acb1fa2032334a241d6c73fc4257683a2aacdda819dcb71267c7b4610`.
- `test/run-headless-conformance.mjs`: `6f04118b71c370f715dea60631b4b654ccfd2c999f229d3bc2ecc38b1b2a5b55`.
- `test/fixtures/pi-headless.mjs`: `d5fc6a6cc5d7571a44174beceb30e759b637c9c5689de21c7c3e027c927a6e43`.

Sol-med independently **APPROVED chunk 5 only**, finding no actionable issues and
passing all 12 shared checks plus the missing-artifact nonzero-exit check. Target
hashes and the full frozen Codex source manifest matched. No source changes or
active primary writes/builds. Report: `/tmp/minu-sol-headless-conformance-review.md`;
independent logs: `/tmp/minu-sol-headless-conformance-tests.log`,
`/tmp/minu-sol-headless-missing-artifacts.log`,
`/tmp/minu-sol-headless-conformance-codex-check.log`.

This closes all five planned bounded headless chunks. The 465/465 current-worktree
regression remains author evidence, not an independently rerun or aggregated
477-test claim. No further test/review cycle for these unchanged chunks is needed
without a concrete unresolved concern. Larger driver/provenance and new lifecycle
work remain separate. R01–R41, broader conformance and CI/package integration
remain unfinished, not waived. Real native model/tool/authentication, subscription
and cross-platform acceptance remain unverified. R42–R44 are future considerations.
Public Claude managed APIs remain disabled; Channels untouched. All changes remain
uncommitted; no push/publication.

## Managed driver slice A — initialization/admission independently closed

Owner message 60 approved the next small slice. This is a bounded review of the
existing constructor, initialize/admit/authority/current and their immediate stop/
opening boundary, NOT resumption of the older whole-driver/conditional-process
investigation. Dispatch ledger, reconciliation, producer/discovery, supervised
launcher and OS/group provenance remain separate. All headless approvals stand.

The initial read-only review made no production edits. Its historical baseline,
before the finding correction below:

- `src/managed-session.ts`: `cb46926569c5a4854359b5374e1386dda97b87989e21e4c2539ed19dc2f20376`.
- `test/managed-session.test.ts`: `6c1adb79b84a3d87817b1fef534c47c8f50676d318385dd85bc00c8dc4df1898`.
- `test/fixtures/managed-native.ts`: `1ec46ec6981e13d6fd70bdc6adc3ca904e575c644455327034e1834287b8196e`.

The scope requires exact private descriptor/current generation/fences, one
validated epoch claim and no retry on a facade, self-PID logical validation (not
OS provenance), verified workspace/environment/immutable policy, pending lazy
initialization and exact bound history without replay/fallback. Commands must
belong to the active admitted async chain, and descendants must expire when its
callback finishes. Streams use existing bridge setup/frame admission rather than
holding a lease while idle. Store leases are callback-scoped, not timer grants.

Local MEDIUM finding reproduced: after seeding valid bound/settled history,
`closeOwnedNative()` returns before initialization. A later valid `initialize()`
still opens a native child, then rejects with stopped-during-initialization.
The child remains alive until a SECOND cleanup. No input is sent and metadata is
unchanged. At the review baseline the final stopped check followed bound opening
(`initialize` around lines 112–118). Sol-med independently confirmed this MEDIUM
issue, including close while initialization queues behind the real lifecycle
lease; an entry-only guard cannot solve that interleaving. No other actionable
initialization/admission finding was reported. Report:
`/tmp/minu-sol-claude-init-admission-review.md`. This is not a recovered-process
signalling/group-provenance finding or a complete driver review.

Observed on Node 22.23.0 / Darwin arm64:

- `pnpm check` passed.
- **9/9 selected existing initialization/admission tests passed**, no skips,
  despite lacking this stopped-before-init sequence. Log:
  `/tmp/minu-claude-init-admission-tests.log`.
- New asserted probe reproduced native spawn/aliveness after the first close and
  rejected initialization, no input and unchanged revision. Its finally cleanup
  closed the actual SDK protocol-peer child and bridge. Log:
  `/tmp/minu-claude-init-after-close-probe.log`; source:
  `/tmp/minu-claude-init-after-close-probe.mjs`, SHA-256
  `dd40eb3ec667bad406e77db5632e462d8f59d72f0e101c68dbe39255085a62dd`.
- Initial probe packaging failed before execution because it guessed core's output
  as dist/src/index.js; corrected to the package's declared dist/index.js export.
  This was not a production test failure or hidden safety retry.
- Real SDK subprocess pipes, SQLite/filesystem/loopback, private disposable roots,
  allowlisted environment, dummy key/unreachable localhost default. No paid calls,
  real credentials, global config or unrelated/recovered PID signals.

Initial bounded review request: `/tmp/minu-claude-driver-init-admission-handoff.md`.
The older whole-driver handoff's R01–R44 wording/conditional process investigation
remain superseded; larger driver, dispatch and OS provenance work is not reopened.

### Finding correction — post-await prelaunch stop fence

Changed only `src/managed-session.ts` and `test/managed-session.test.ts`.
Initialization now rechecks stopped state AFTER admission/workspace validation
awaits and before caching policy/tools or entering bound native opening. No await
separates the guard from creation of the existing tracked opening/abort handle.
The original final check remains, so stopping during an already-started opening
still cannot mark readiness. Existing activation/epoch claim and abort/cleanup
semantics are preserved. No new entry-only shortcut, API, configuration or helper.

Two deterministic no-spawn regressions cover close-before-init and close while
initialize queues behind an actual lifecycle lease. They assert absence of the
child PID/input markers BEFORE the fixture's second cleanup, no trace or metadata
change, uninitialized admission and refused activation retry. The queued case
starts initialize synchronously while holding the real lock, closes, then releases
the lock; no timing sleep, stubbed admission or production test hook is used.

Observed author evidence on Node 22.23.0 / Darwin arm64:

- Both new tests failed before the source guard because the child PID file existed
  (`Missing expected rejection` for ENOENT). Log:
  `/tmp/minu-claude-init-stop-red.log`. Existing cleanup removed both test children.
- `pnpm check` passed after the test addition and after the source correction.
- All **20/20 managed-session tests passed**, no skips, including both new cases.
  Log: `/tmp/minu-claude-init-stop-tests.log`. This is the focused driver regression
  file, not an independent review of dispatch/settlement or a new full suite.
- Disposable HOME/TMPDIR/native state, allowlisted environment, dummy/local-only
  credentials and actual SDK protocol-peer subprocesses/SQLite/filesystem/HTTP.
  No paid calls, real credentials, global settings, dependency changes or primary
  Codex/Channels source/build changes. Whitespace checks passed.

Slice A reviewed correction SHA-256 (historical baseline for slice B):

- `src/managed-session.ts`: `74d4a730cbf0365970aad64aae95eaa68bc65e6bad6f8192f8be759fe03332fc`.
- `test/managed-session.test.ts`: `b11255dc012594c3562a3813879d51ac31185ddb04b9292adb85274f2f81fc26`.
- Native fixture unchanged: `1ec46ec6981e13d6fd70bdc6adc3ca904e575c644455327034e1834287b8196e`.

Sol-med independently **APPROVED** the initialization/stop correction, completing
the blocked bounded slice A review. All 20 driver regressions passed independently;
both adapted close-before-init and queued-init probes confirmed no native spawn,
no input, unchanged metadata and refused retry. No source edits. Report:
`/tmp/minu-sol-claude-init-stop-rereview.md`; independent evidence:
`/tmp/minu-sol-claude-init-stop-rereview-tests.log`,
`/tmp/minu-sol-claude-init-after-close-recheck.log`,
`/tmp/minu-sol-claude-init-queued-close-recheck.log`.
No broader driver/lifecycle, group/provenance or product approval is implied.

## Managed driver slice B — first-input binding/dispatch intent independently closed

A separate small slice covers `startTurn` input/retained-ID admission, lazy native
creating/binding, dispatch-intent persistence and mapped SDK input, including its
prelaunch stop boundary. It does not reopen slice A or review terminal observer/
settlement, production launcher, process/group provenance or recovery. Public
managed methods remain disabled. Prior store/native-opening/transport reviews
remain scoped dependencies, not repeated whole-component reviews.

Required local behavior: validate text before native budget; record creating UUID
before native startup; bind exact native UUID and persist caller/fingerprint/
native-message/generation intent before SDK input. Retained same-input IDs recover
copies without redispatch; conflicting exact JS text rejects even if lossy hashes
collide. Uncertain/failed preparation and bounded lifetime ledger must not silently
reset, evict/reuse IDs or launch replacement input. This is not a durable caller
result ledger or exactly-once history across worker replacement.

Local reproduction found the analogous first-input gap: close can return while
`beginNativeCreation` is returning its real persisted result under the held lease.
After return, the old path opens a new child before noticing stopped. UNLIKE slice
A, the preparation catch eventually stops that late child before startTurn returns;
no child is left alive at return, no input is sent, and creating uncertainty and
failed caller retention already remain intact. The defect is late allocation after
completed close, not a new permanent leak or lost dispatch intent.
Probe: `/tmp/minu-claude-first-input-close-probe.mjs`, SHA-256
`10b35ce15ea9c9021f94bf93d6d790ed50730b9c2e6d99819a63bfba88d5add6`;
log: `/tmp/minu-claude-first-input-close-probe.log`.

Changed only the driver/test files: one stopped check after the awaited creation
intent and before `openNative`, plus one regression. The test wraps only the real
lease's `beginNativeCreation` result to pause after successful persistence while
retaining actual admission/SQLite locking. It closes outside admission, releases
the result and asserts no child PID/input marker even before fixture cleanup,
unchanged creating/none metadata (revision 5), empty user trace, retained failed
caller lookup and refusal of replacement input. No production hook, stubbed
persistence, metadata rollback or new policy/abstraction.

Observed author evidence on Node 22.23.0 / Darwin arm64:

- New regression failed before the guard at the post-close PID-file ENOENT
  assertion. Log: `/tmp/minu-claude-first-input-stop-red.log`.
- `pnpm check` passed before/after the source correction.
- All **21/21 managed-session tests passed**, no skips. Log:
  `/tmp/minu-claude-first-input-stop-tests.log`. Existing positive order tests
  observe the production manifest from a separate SDK protocol child BEFORE user
  input and confirm bound native UUID + dispatch intent/native-message UUID.
- Disposable roots, env -i/allowlisted PATH, dummy/unreachable-local fixture
  configuration and actual SDK/SQLite/filesystem/loopback. No paid/provider/model
  calls, real credentials, global settings, dependency changes or primary writes.
  No new full-workspace run; the earlier 465/465 predates slices A/B.

Slice B reviewed SHA-256 (test baseline before slice C coverage):

- `src/managed-session.ts`: `fe2a13b191dab19ef395184776df133e3a5b433d4362531d151124a366ce0455`.
- `test/managed-session.test.ts`: `f6687bdd73878789dc1b7b4c1de93eff0590d4daf1dba5ec31559213437eabf8`.
- Native fixture unchanged: `1ec46ec6981e13d6fd70bdc6adc3ca904e575c644455327034e1834287b8196e`.

Sol-med independently **APPROVED slice B only**, with no actionable findings and
21/21 driver regressions passed. The adapted stop probe confirms no late native
allocation, preserved creating uncertainty and retained failure. Additional real
lease-mutation/lost-confirmation probes for bindNativeSession and beginDispatch
preserved bound/none and bound/dispatching metadata respectively, sent no input,
kept fixed failed retries and refused replacement. No source edits or scope
expansion into terminal settlement. Report:
`/tmp/minu-sol-claude-first-input-review.md`; independent logs:
`/tmp/minu-sol-claude-first-input-tests.log`,
`/tmp/minu-sol-claude-first-input-close-recheck.log`,
`/tmp/minu-sol-claude-first-input-confirmation-probe.log`.

## Managed driver slice C — terminal observation/durable settlement independently closed

Separate bounded scope: observeNative, reconcile, finish and their stop/observer
completion paths. Verify exact expected-turn targeting, raw text/tool frames before
terminal publication, explicit native/definite-undispatched evidence, exact leased
settlement before success, and fail-closed retained results when observation or
settlement confirmation is unavailable. No transcript-derived completion, native
replacement, metadata rollback or replay. Native/worker/group exit and recovered
process authority remain separate from native result/stop acknowledgement.

The initial author checkpoint made no production implementation change. Driver
baseline was `fe2a13b191dab19ef395184776df133e3a5b433d4362531d151124a366ce0455`.
One initial regression in `test/managed-session.test.ts` performs the real admitted
settleDispatch mutation successfully, then throws a private confirmation error.
Unlike the existing chmod-before-write failure, the on-disk record really is
settled/completed. Runtime must still expose a fixed failed/uncertain retained
caller with no response or success event, go unavailable, leak no injected private
error and refuse conflicting/new input. The committed record must remain exact,
not be rolled back or overwritten; no retry mutation or new input is allowed.

Observed author evidence on Node 22.23.0 / Darwin arm64:

- `pnpm check` passed.
- All **22/22 managed-session tests passed**, no skips. Log:
  `/tmp/minu-claude-terminal-settlement-tests.log`. Coverage includes existing
  two-turn loopback raw-frame ordering, actual native interrupted/failed results,
  interrupt ACK without result, crash uncertainty and pre-write settlement failure,
  plus the new successful-commit/lost-confirmation case.
- That initial lost-confirmation case passed without a production fix; no red
  baseline was claimed for it. It asserts exactly one settlement attempt,
  one user-input trace, failed retained retries, no replacement, and no success or
  private error in public events even though completed metadata exists on disk.
- Actual SDK protocol peers and real private filesystem/SQLite/loopback, env -i/
  private HOME/TMPDIR, allowlisted PATH, dummy/unreachable-local configuration.
  No paid/provider/model calls, credentials, global configuration, dependency or
  primary-source changes. The existing event subscriber is explicitly aborted
  by the test; logical unavailable status is not presented as native/group exit.
- No new full-workspace run. Historical 465/465 predates slices A/B and is not
  relabeled current evidence. Executing this whole focused test file does not
  itself establish independent C review or complete managed lifecycle acceptance.

Initially reviewed slice C pins (before observer-failure correction below):

- `src/managed-session.ts`: `fe2a13b191dab19ef395184776df133e3a5b433d4362531d151124a366ce0455` (unchanged).
- `test/managed-session.test.ts`: `04bdac1de16717875bf3b132b9cff41090abde14462f3693b848a7529094aa97`.
- Native fixture unchanged: `1ec46ec6981e13d6fd70bdc6adc3ca904e575c644455327034e1834287b8196e`.

Sol-med's bounded C review requested **MEDIUM** changes: exceptional raw observer
termination still entered final reconciliation, which could publish a genuinely
completed native response even after losing its preceding raw output. A scoped
subscription-failure probe yielded working/turn_started, held the first real delta
until real native completed evidence existed, then threw before delivering it.
Observed bad result: zero raw deltas, completed response/success event and durable
completed settlement. The native evidence was real; ordered observation failed.
Report: `/tmp/minu-sol-claude-terminal-review.md`; final asserted probe/log:
`/tmp/minu-sol-claude-terminal-observation-failure-probe.mjs` / `.log`.
Ordinary small-buffer probes passed and an earlier ineffective interception was
not treated as evidence. No natural overflow/OS-crash reproduction is claimed.

### Exceptional-observer correction

Changed only the driver/test files. A local observationFailed flag now records an
exception before known-handle shutdown. Final reconciliation runs only on normal
draining, never on the exception path; the existing finally then publishes the
fixed failed/uncertain retained execution and closes streams. Existing already
confirmed results are not rolled back. Normal terminal/native-undispatched and
lost-settlement-confirmation handling remain unchanged. No API/config/schema or
new production test hook, launcher or process-provenance change.

One new regression wraps only the actual native event subscription after the
real bind mutation, before driver subscription. It forwards normal frames and a
prior fully settled turn, then holds the second turn's actual delta until genuine
native completed response/evidence exists and throws a private observation error.
No result/evidence, turn lookup, native producer or persistence is stubbed.
It asserts injected failure, failed/no-response caller, no second-turn delta or
success event/private text, zero settlement attempts and exact original
second-turn dispatching metadata, stable failed retry/refused replacement, prior
confirmed result retained, two user inputs only, and actual known-child exit
before fixture cleanup. Reflection is confined to installing this test wrapper;
public loopback events/results provide the safety assertions.

Observed author evidence on Node 22.23.0 / Darwin arm64:

- The new regression failed before the source change: completed instead of failed.
  Log: `/tmp/minu-claude-observer-failure-red.log`. Cleanup disposed the known child.
- `pnpm check` passed after test addition and source correction.
- All **23/23 managed-session tests passed**, no skips, including ordinary ordered
  terminal settlement, pre-write and lost-confirmation failures, A/B regressions
  and the new failed-subscription case. Log:
  `/tmp/minu-claude-observer-failure-tests.log`.
- Private disposable HOME/state/TMPDIR, env -i/allowlisted PATH, dummy local fixture
  configuration, actual SDK protocol child/SQLite/filesystem/HTTP. No paid calls,
  real credentials, global settings, dependency or primary-source changes.
  No new full suite or broadened lifecycle/provenance/native acceptance claim.

Correction pins:

- `src/managed-session.ts`: `2c1e3236baf21f8883d372cc2b087d93bdfe9d16c86894b51fbdc2a089d1ddc2`.
- `test/managed-session.test.ts`: `5888102987af103b7626a1673f6b19a787e0488b3e32c8293bfb9a0d60bff854`.
- Native fixture unchanged: `1ec46ec6981e13d6fd70bdc6adc3ca904e575c644455327034e1834287b8196e`.

Sol-med independently **APPROVED** the observer correction and bounded slice C,
with no actionable findings. All 23 driver regressions passed independently. The
adapted original fault probe, retaining actual native completed evidence and lost
raw-frame injection, now returns failed/uncertain with zero success events and
settlement attempts, unchanged dispatching metadata, stable failure and no replay.
Prior confirmed results remain intact. No source edits. Report:
`/tmp/minu-sol-claude-observer-rereview.md`; logs:
`/tmp/minu-sol-claude-observer-rereview-tests.log`,
`/tmp/minu-sol-claude-terminal-observation-failure-recheck.log`.
This closes A/B/C's bounded internal driver reviews, not broader lifecycle or OS
process/group authority. No further same-finding review cycle is needed without
a concrete unresolved concern.

## Driver integration checkpoint — post-A/B/C author regression (predates D2)

After A/B/C closed, ran the full current Claude-worktree `pnpm test` once at this
combined integration point: **470/470 passed**, no skips, on Node 22.23.0 / Darwin
arm64. Includes the TypeScript build and current core/Pi/Claude regressions.
Log: `/tmp/minu-claude-driver-integrated-tests.log`.
Ran with env -i, disposable HOME/TMPDIR/native config roots and explicitly
allowlisted installed Node/pnpm/system bins. No paid calls, real credentials,
global config or primary writes/builds. This run predates the new D2 bootstrap;
it does not verify D2.

This is AUTHOR evidence, not independently repeated or a full active Codex suite.
The separate 12 shared headless checks remain previously independently approved;
no new run or fabricated 482-test aggregate is claimed. Historical 465/465 is now
superseded for this worktree checkpoint. Native model/tool/authentication,
subscription, cross-platform/CI and complete R01–R41 delivery remain unverified.
Public managed APIs remain disabled; all changes uncommitted/unpublished.

## D1 — known-child launch/readiness/adoption study complete

Completed design task only, not production approval or a whole-lifecycle review.
Read-only investigation request:
`/tmp/minu-claude-launch-readiness-study-handoff.md`. Coworker retains production
producer/lifecycle ownership; sol-med is asked for an evidence-backed minimal
contract using the EXISTING approved store/codec/driver where sufficient.

Scope: dormant known ChildProcess/private-IPC launch; commit starting before fork
and record actual PID/group before permission to proceed; distinguish bootstrap
listener preparation, durable adoption and driver/native readiness; exact current
CAS/fences for pre-publication abort versus refusal to kill an already-adopted
worker after timeout/disconnect/lost acknowledgment/concurrent adoption. Preserve
starting-without-PID, native/input uncertainty and human-resume fence. Never put
credentials/environment/transcript or tokens on argv or serialized manifests,
except the already-authorized private transport token in the 0600 registration.

Sol-med recommends existing exact live publication as durable adoption, followed
by one initialization and fresh admitted status before readiness. Three disposable
IPC/real-store scenarios passed: serialized pre-publication abort versus competing
publication, lost publish ACK/disconnect without post-adoption cleanup authority,
and persisted generation/human fences refusing stale cleanup. Protocol baseline
selected for D2 only; this is not production producer/group proof. Report:
`/tmp/minu-sol-claude-launch-readiness-study.md`; probe/log:
`/tmp/minu-sol-claude-d1-study.mjs`, `/tmp/minu-sol-claude-d1-study.log`.

A pre-publication abort must keep the real lease through the authority decision,
known-child cooperative exit confirmation and clear, preventing intervening
publication. clearWorkerAfterExit itself is NOT unfenced abort authorization.
No new schema, supervisor/guardian, witness or native helper is justified by D1.

Only a few directly owned disposable Node/private-state experiments, no Claude/
provider/model calls, real credentials or global settings. Use real store leases
for CAS examples; signals only if necessary to directly known fresh unpublished
fixture children. No arbitrary/recovered PID signals or post-root-death group
signalling. Prefer owned fixture IPC/self-exit for adopted fixture cleanup. Separate
observations from recommendations; do not infer worker/native/group exit from
metadata, self PID, readiness/stop ACK or connection closure.

D1 does NOT solve recovered process/group provenance or R19/R20's durable emergency
fencing while a worker holds an unresponsive lifecycle lease. Waiting for that
lease or a healthy RPC must not be presented as the recovery solution. Those are
still required, separate blockers before public managed enablement. Primary Codex/
Channels remain untouched; no production source change or broad process study is
started by this request. D1 is complete as a bounded recommendation; the
experiments were not independently repeated by coworker.

## D2 — private dormant worker bootstrap independently closed

Only new internal `src/worker-entry.ts` plus `test/worker-entry.test.ts` and
`test/fixtures/worker-entry.ts`. No changes to the approved driver/store/codec/
bridge, public index, schemas, core/Pi, primary Codex, Channels or CI. No production
parent producer, abort/destroy/recovery API or process-group helper is added.

The first private IPC string is bounded to 64KiB and supplies explicit private
native environment/options, scope and store root. Missing env and unsupported
callbacks/tools fail rather than inherit credentials or silently drop behavior.
Controlled Node startup inputs, canonical entry/cwd, current unfenced starting
scope and recorded self PID are required before listener preparation. Parent
commit-before-fork / actual known ChildProcess recording-before-bootstrap remain
required PRODUCER obligations, not OS provenance proved by the child's PID check.

The existing driver is constructed before the existing bridge. A second gate
keeps all HTTP routes unavailable until initialize plus fresh admitted idle status
succeed. One frozen candidate/token/timestamp is privately handed off. Only the
exact canonical published live descriptor permits one authoritative initialize;
pending remains native-lazy, bound opens exact validated history without replay.
Publication observation is bounded/monotonic, independently of native startup
limits. No activation hint, duplicate frame, lost ACK or IPC closure substitutes
for adoption. Timeout/mismatch/fence/failed initialization leaves the listener
unavailable, without retry, fallback, metadata clearing or automatic process kill.

All production commands still use real driver/store admission. The exported run
function returns the existing LOCAL privileged cleanup handle, never an IPC/HTTP
admin route. The fixture ONLY uses private stdin for explicit owned self-disposal
when creator IPC has disconnected; it calls actual owned native cleanup and checks
captured native peer absence separately. It does not bypass production admission
or prove universal group absence. Actual main-entry malformed cases exit 1 before
native permission; post-candidate unavailable workers deliberately remain alive.

Author checks: `pnpm check` and **60/60 affected tests passed**, zero skips:
`node --test packages/claude-code/dist/test/{worker-entry,managed-session,worker-bridge,worker-fencing}.test.js`.
Includes **18 new entry cases** using separately forked Node entries, real store/
SQLite leases and real driver/bridge. Bound initialization uses real SDK with the
existing synthetic protocol peer, not a real Claude/provider/tool call. Tests
cover publication vs readiness under held lease, IPC disconnect/lost confirmation,
late publication, exact descriptor mismatch, queued admission generation/human
fences, terminal failed initialization, missing PID, local scope mismatches,
missing env/unsupported callback and malformed/non-string/oversized private input.
The latter three fork actual production main, not just the fixture wrapper.

First development run had only observed test-expectation failures: existing public
client reports http_503 rather than bridge-body operation_failed. Corrected tests,
not production behavior; no red-baseline claim. Current logs:
`/tmp/minu-claude-worker-entry-check.log`,
`/tmp/minu-claude-worker-entry-affected-tests.log`.
Env -i, disposable owner-private HOME/native config/state, allowlisted Node/system
PATH, dummy private auth/local unreachable endpoint; Node 22.23.0 / Darwin arm64.
No paid/provider/tool calls, inherited real credentials/global config, arbitrary/
recovered process/group signals, primary writes/builds or commits/pushes. Git diff
check plus explicit new-file trailing-whitespace search passed.

Frozen SHA-256 (all package-relative):
- src/worker-entry.ts: `21ad72ae4e8c82ba679dc46e6d9c615de1c3f63c6b49e1ccc3333ce466cdb91f`
- test/worker-entry.test.ts: `2628b4bfedf84487cb9cda2108478d3633db70229c65c72999841f7d8ddecbc4`
- test/fixtures/worker-entry.ts: `dc9e580f7e5fb3e206c891209cf0320d1e19662fa4afdb19e1f7e7af678dbdde`
Driver/store/codec/bridge hashes remain the approved A/B/C/D1 references.

Bounded read-only review request: `/tmp/minu-claude-worker-entry-handoff.md`.
Sol-med independently APPROVED D2 with no actionable findings: **60/60 affected
tests passed**, including 18 bootstrap cases. Exact publication, readiness gate,
IPC loss, timeout/mismatch/fences and no fallback/reactivation were confirmed;
hashes matched, no source edits. Report:
`/tmp/minu-sol-claude-worker-entry-review.md`; independent log:
`/tmp/minu-sol-claude-worker-entry-tests.log`.
This closes D2 only at its named hashes. D3's tiny shared decoder-export delta is
reviewed separately below; no blanket approval of newer source is claimed.
Full 470/470 predates this addition; no new full-suite or real native/model/tool/
auth/subscription/cross-platform claim.
Production parent producer/discovery, serialized known-child abort, readiness
supervision, physical exit/provenance and R19/R20 independent emergency fencing /
recovery remain required separate work. No claim that a healthy RPC or waiting for
the same lifecycle lease solves unresponsive-worker recovery. Public managed APIs
remain disabled and all changes remain uncommitted/unpublished.

## D3 — all three parent launcher checkpoints independently closed

Owner message 76 requests smaller chunks after the Runtime turn failed. Saved
source/test hashes were intact; 79/79 is historical author evidence only, not
independent approval. Preserve that work, making only concrete finding-driven
corrections below; no full rerun merely because the response failed.

Close these reviews separately, in order:
1. **D3a (independently closed):** private preflight, reservation and confirmed
   starting before physical fork; preserved lost-start/fork-failure uncertainty.
2. **D3b (independently closed):** actual PID recording and bounded private bootstrap exchange.
3. **D3c (independently closed):** exact candidate publication and lost-confirmation handling.

Readiness supervision and authorized cleanup/recovery remain later separate work.
No code refactor/split is needed just to define these review checkpoints. Do not
start the next review before closing the current one.

New internal `src/worker-launch.ts` + `test/worker-launch.test.ts` + controlled
`test/fixtures/worker-launch-peer.ts`. Tiny dependency delta in worker-entry.ts:
existing decode is renamed/exported as decodeClaudeCodeWorkerBootstrap and used
by the same receiver. The initial export had no validation/activation behavior
change; parent reuses it before mutation instead of duplicating the private codec.
The later managed-limit validation correction is recorded under D3a below. No new schema, public
index/API, core/Pi, primary Codex, Channels, dependency or CI changes.

The producer snapshots explicit private native options before its first await;
function/callback cloning fails rather than silently dropping it into JSON.
Canonical trusted HOST interpreter/entry and bounded frame are checked before
reservation. Under the real lifecycle lease it reserves, commits starting before
physical fork, retains the actual ChildProcess, records its actual PID BEFORE
sending bootstrap, validates bounded ordered private replies/full candidate scope
and actual PID/null group, then publishes once. Lease release precedes any native
initialization/readiness wait. Startup env is only authorized config root plus
explicit HOME/PATH/TMPDIR; no process.env, Node preload flags, credential argv or
serialized native env/credential fields. Entry/interpreter overrides are trusted
host inputs, not new user/tool executable selection.

Private result is ADOPTED or UNAVAILABLE, never READY. Unavailable may mean unknown
adoption, not no work or permission to retry/clear/kill. Lost publish confirmation
re-admits only the frozen canonical candidate to classify current adoption; no
publication retry, new token, fallback, metadata release/clear or native/input
reset/replay. Lost start/PID confirmation and known fork failure retain exact
committed uncertainty. Creator IPC is disconnected after the attempt, without a
stop instruction; D2 can observe publication independently. Returned registration
bytes/ChildProcess are LOCAL PRIVATE material, not UI/profile output or recovered
PID/process-control authority.

D3 intentionally uses detached:false / processGroupId:null. No isolated-group,
OS-incarnation/executable or containment proof is claimed. It can leave dormant
unavailable children/metadata. Production abort/retirement and supervisor readiness
remain separate requirements before enabling public APIs; no abort/destroy verb
is added. Holding this healthy parent lease is NOT R19/R20's independent emergency
fence/recovery path for an unresponsive lease-holding worker.

Historical pre-finding author verification (not current limit-correction evidence):
- `pnpm check` passed: `/tmp/minu-claude-worker-launch-check.log`.
- **79/79 affected checks passed**, no skips, including **19 new producer cases**:
  `node --test packages/claude-code/dist/test/{worker-launch,worker-entry,managed-session,worker-bridge,worker-fencing}.test.js`;
  `/tmp/minu-claude-worker-launch-affected-tests.log`.
- Earlier standalone 18/18 (`/tmp/minu-claude-worker-launch-tests.log`) predates
  the final explicit-root guard/test; current target evidence is 79/79 above.
- Tracked diff check plus explicit untracked target whitespace check passed.

Tests observe real metadata synchronously AT the actual builtin fork call, then
use actual Node IPC/entries and store/SQLite leases. Real committed mutations lose
return confirmation by scoped wrapper, never simulated persistence. Cover exact
fork/bootstrap order/private env, adoption NOT readiness (peer has no listener),
real D2 native-lazy activation after release/disconnect, concurrent one-fork
exclusion, lost start/PID/publish returns, known sync fork fault, wrong scope/PID/
group/oversized/ready-only/hanging replies, persisted generation/human fence and
private preflight failures. Local inspection also added an explicit storeRoot
presence guard: a missing root must not invoke the store constructor's host
default. Its regression isolates HOME to the fixture and restores it; no red-
baseline execution is claimed. Test stdin self-disposal is not production cleanup
or metadata-clear authority. D3 cases stay pending and launch no SDK peer/native work.
Reused D2/driver tests use synthetic SDK peers only, no real Claude/provider/tools.

Development first run timed out at 90s: test cleanup incorrectly awaited close
rather than physical exit after IPC detachment; Darwin also inserted benign
__CF_USER_TEXT_ENCODING beyond the exact spawn environment. Cleanup failure then
contaminated later scoped mutation wrappers. Fixed TEST lifecycle/assertions/
immediate restoration only. Targeted two-case cleanup check passed, then full
18/18 and 78/78 before the final explicit-root addition; current 79/79 covers it.
No production change was made in response to those initial harness failures. Retained log:
`/tmp/minu-claude-worker-launch-development-failures.log`; targeted check:
`/tmp/minu-claude-worker-launch-cleanup-check.log`. No owned fixture processes or
native PID artifacts remained after the timed-out tool; only its own disposable
failure root was removed, without recovered process signals.

Pre-finding D3 target SHA-256 (package-relative; D3a rework hashes below):
- src/worker-launch.ts: `cedef664935bc3fd502c0affefed0730be0ca454038ca97ea3579a6baae9849a`
- src/worker-entry.ts: `a1edf39fb3820cb53473709946750c81c51d99730171472163d70afc7399fd4b`
  (D2 baseline `21ad72ae4e8c82ba679dc46e6d9c615de1c3f63c6b49e1ccc3333ce466cdb91f`)
- test/worker-launch.test.ts: `7434b28eb4e3f7446b12fe76cd7d78c58150aa29ccf07c37d14c6d6378f355f6`
- test/fixtures/worker-launch-peer.ts: `1fc258ce592272c8aeda25a832cc20df9312015fafecb4631189fae3652157e5`
Driver/store/registration codec/bridge and D2 fixture hashes remain unchanged.

The broader `/tmp/minu-claude-worker-launch-handoff.md` remains historical patch
context, SUPERSEDED as an assignment by the smaller sequential reviews. D3a's
preflight request and finding rework are closed at their named scope/hashes.
Final D3c request: `/tmp/minu-claude-worker-launch-publication-handoff.md`.
D3a/b/c are independently closed within scope; no open launcher review assignment.
Env -i, disposable owner-private HOME/config/state,
allowlisted Node/system PATH, explicit child env and dummy local-only credentials;
Node 22.23.0 / Darwin arm64. No paid calls, real credentials/global config,
arbitrary/recovered PID/group signals, primary writes/builds, commits/pushes or
new full-suite/cross-platform/CI/model/tool/auth/subscription claim. Historical
470/470 predates D2/D3. Readiness/discovery, serialized authorized abort/exit proof,
R19/R20 independent emergency fencing/recovery and public routing remain required
and unfinished. Public managed APIs remain disabled; all changes uncommitted.

## D3a — managed-limit finding and preflight checkpoint independently closed

Sol-med requested changes: 1,001 retained turns / 4,097 event buffer passed parent
preflight but failed the managed constructor AFTER fork, leaving avoidable durable
starting/recorded-PID state. Report:
`/tmp/minu-sol-claude-launch-preflight-review.md`; independent 8/8 existing focused
cases passed despite both separate probes reproducing this MEDIUM finding.

Only production correction is in the existing shared bootstrap numeric validator:
turnRetentionLimit <= 1,000; eventBufferLimit <= 4,096, matching the unchanged
managed constructor. Other numeric options retain their positive safe-integer /
2,147,483,647 bounds. Parent validation therefore fails before reservation; child
uses the same validator. No changes to launcher sequencing, PID/IPC/publication,
metadata, driver, codec, bridge or fixtures. No new helper/schema or rollback.

Two new upper-bound regressions failed before the fix with missing expected
rejection (0/2): `/tmp/minu-claude-preflight-limits-red.log`. They now require fixed
parent rejection, zero forks and exact unchanged manifest. A positive case supplies
BOTH ceilings and completes actual managed pending initialization/fresh idle status
without native allocation; this setup does not approve D3b/c.

Current author typecheck passed. **11/11 D3a focused tests passed**, zero skips:
`/tmp/minu-claude-preflight-limits-tests.log`. Separately **41/41 immediate shared
bootstrap/driver tests passed**, zero skips:
`/tmp/minu-claude-preflight-limits-affected-tests.log`. Typecheck log:
`/tmp/minu-claude-preflight-limits-check.log`. No new full-suite/79-case run or
fabricated single 52-test run. All checks env -i, disposable private HOME/config/
state, allowlisted Node/system PATH, dummy local auth; existing driver tests use
synthetic SDK peers only. No paid/real Claude/provider/model/tool calls, inherited
credentials/global settings, signals, primary writes/builds, commits or pushes.

Current SHA-256:
- src/worker-entry.ts: `a581c5e3b9aa1b62f78abb4470fcb3239afb1ad8f6db0528053b58e006e954be`
- test/worker-launch.test.ts: `b0ba95fca525e652e51cd95f2afc838f5d050dd26e7b38604e31348047867cdc`
- src/worker-launch.ts unchanged: `cedef664935bc3fd502c0affefed0730be0ca454038ca97ea3579a6baae9849a`
- managed-session.ts unchanged: `2c1e3236baf21f8883d372cc2b087d93bdfe9d16c86894b51fbdc2a089d1ddc2`

Finding-only read-only request:
`/tmp/minu-claude-preflight-limits-rework-handoff.md`. Sol-med independently
APPROVED the finding and D3a only: **11/11 focused tests passed**, both original
adapted probes now reject with zero forks/exact unchanged metadata, and supported
ceilings initialize successfully. Hashes matched; no source edits. Report:
`/tmp/minu-sol-claude-preflight-limits-rereview.md`; independent logs:
`/tmp/minu-sol-claude-preflight-limits-rereview-tests.log`,
`/tmp/minu-sol-claude-launch-preflight-limits-recheck.log`.
The separate 41-case run remains author evidence, not independently repeated.
D3b/c are not approved by that closure. Readiness, authorized cleanup, physical
exit/provenance, R19/R20 independent fencing/recovery and broader acceptance remain
unfinished. Public APIs disabled; all changes uncommitted/unpublished.

## D3b — actual PID recording/private IPC independently closed

Next small review only; no new source/test changes or broad rerun. Request:
`/tmp/minu-claude-worker-launch-ipc-handoff.md`. Current hashes remain the D3a
corrected references above (worker-launch.ts unchanged throughout).

Scope is AFTER actual fork through bounded prepared-candidate string receipt:
record actual ChildProcess PID/null group under the real lease BEFORE private
bootstrap; preserve lost-record/unknown-PID uncertainty; ordered bounded private
exchange, send callback/error/exit/deadline behavior and listener/disconnect
cleanup without kill/clear/replay/replacement. A ready hint is not adoption or
readiness. Logical PID/IPC checks are not OS/group provenance.

Sol-med independently APPROVED D3b only, no actionable findings. **7/7 focused
tests passed**, zero skips, plus three local ChildProcess/lease-boundary probes:
missing exposed PID, send callback error/backpressure, and premature prepared
packet. Each preserves exact committed uncertainty with no bootstrap/retry/reset
as applicable; PID persistence precedes send and waits remain bounded. These are
controlled faults retaining real fork/store operations, not natural OS failure
claims. Hashes matched; no source edits. Report:
`/tmp/minu-sol-claude-worker-launch-ipc-review.md`; independent logs:
`/tmp/minu-sol-claude-worker-launch-ipc-tests.log`,
`/tmp/minu-sol-claude-worker-launch-ipc-probe.log`.

Semantic candidate decoding/publishWorker/lost-publication confirmation were
explicitly NOT reviewed. Existing positive fixture continuations do not approve
those later contracts. Latest 11/41 author and D3a/b independent evidence remain
separate; historical 79 is not a new current producer/full-suite run. Public
managed APIs remain disabled. No readiness/cleanup/recovery implementation or old
broad process investigation is started.

## D3c — exact publication/lost-confirmation independently closed

Completed small read-only review; no new code during the handoff. Request:
`/tmp/minu-claude-worker-launch-publication-handoff.md`. Hashes remain the D3a/b
references above. Scope starts at semantic registration decode against exact
expected scope and actual known child PID/null group, then canonical frozen
candidate bytes, current lease/revision/generation/reservation publication and
lost-return classification via exact current withWorkerAdmission. No repeat
mutation/token/worker, reset/release/clear, fallback or inferred native settlement.
Release the parent lease before initialization/readiness waiting. ADOPTED is not
READY; UNAVAILABLE can mean UNKNOWN adoption, never cleanup/replay permission.

Sol-med independently APPROVED D3c, no actionable findings. **7/7 focused tests
passed**, zero skips, plus two real-mutation fault probes: failure before publish
preserves exact starting/recorded-PID revision 3 and frozen descriptor; successful
publication followed by persisted generation/human fence and lost return preserves
exact live/fenced revision 5 and returns unavailable, not adopted. One publication
attempt, no replay/reset/clear/kill; no source edits. Report:
`/tmp/minu-sol-claude-worker-launch-publication-review.md`; independent logs:
`/tmp/minu-sol-claude-worker-publication-tests.log`,
`/tmp/minu-sol-claude-worker-publication-probe.log`.

All three scoped D3 checkpoints are closed, not the complete supervised lifecycle.
Readiness supervision, authorized cleanup/physical exit, OS/group provenance,
R19/R20 independent fencing/recovery, public managed routing and broader
configuration/native model/tool/auth/subscription/cross-platform/CI acceptance
remain required separate work. Public managed APIs stay disabled; changes remain
uncommitted/unpublished.

## Post-launch integration checkpoint — author regression (predates D4)

After D2 and D3a/b/c closed, ran the full current worktree command once at this
combined integration point: `pnpm test` (TypeScript build + core/Pi/Claude tests)
**510/510 passed**, zero failures/cancellations/skips. Node 22.23.0 / Darwin arm64.
Log: `/tmp/minu-claude-launch-integrated-tests.log`. This verifies the D3a/b/c-reviewed
target BEFORE D4; the later readiness helper/optional admission budget are NOT
verified by that historical full run.

Used env -i, disposable HOME/TMPDIR/CODEX_HOME/CLAUDE_CONFIG_DIR and explicit
installed Node/pnpm/system PATH. No paid calls, real/inherited credentials,
global configuration or primary Codex/Channels writes/builds. Author integration
evidence only, not independently repeated or a full active Codex suite. Historical
470/470 predates D2/D3 and is superseded for this worktree checkpoint. The separate
12 shared headless checks remain previously independently approved, not rerun or
combined into this total.

No readiness, abort/recovery, process-group authority, real model/tool/auth,
subscription, cross-platform/CI or R01–R41 completion claim. Public managed APIs
remain disabled; all changes uncommitted/unpublished. The next readiness-only slice
was subsequently approved through the MVP decision and is recorded below; no new
lifecycle implementation/reviewer assignment occurred during this older full run.

## D4 — private exact-worker readiness independently closed

First approved MVP chunk only. New internal src/worker-readiness.ts snapshots one
scope/canonical descriptor, validates existing exact store admission, releases the
lease for authenticated GET /status, then revalidates before confirming idle/working.
No lease crosses HTTP, which needs the same lock on the worker. 503 retries only
that bounded read on the SAME endpoint; other failures/offline are unavailable.
No launch, input, manifest mutation/repair, new token/worker, stop/kill/clear or
fallback. Missing owner/session returns before admission can create its scope;
normal admission still uses permanent SQLite lock I/O, not a zero-I/O claim.

Default 5s, maximum 30s logical timeout: monotonic post-await/final checks prevent
late success; the remaining budget bounds HTTP and each admission acquisition.
Only shared production delta is optional fourth withWorkerAdmission timeoutMs
(default unchanged at 5,000), forwarded to existing withSessionLock. No storage/
schema/CAS/lease algorithm changes. Cancellation aborts HTTP and returns a fixed
AbortError; lock/OS reads finish cooperatively without dropping physical leases.
Ready is a snapshot of admitted command readiness, NOT model/provider/auth/history
or physical-exit proof/future authority. Pending remains native-lazy; every future
command independently re-admits. No public index/API wiring yet.

Author checks: pnpm check passed. **41/41 readiness/managed-worker tests passed**
(18 new readiness, 23 existing registration/admission), zero skips. Separately
**1/1 actual producer/bootstrap integration passed**, zero skips: one fork, fresh
ready/idle, exact unchanged manifest and no SDK/native allocation. Logs:
`/tmp/minu-claude-readiness-check.log`,
`/tmp/minu-claude-readiness-affected-tests.log`,
`/tmp/minu-claude-readiness-bootstrap-test.log`.
No new full/510-case run or fabricated aggregate total.

Real filesystem/SQLite/loopback coverage includes idle/working, same-lock HTTP
admission, delayed readiness, unpublished/wrong descriptor, generation/human fence
and private-file descriptor replacement during a reply, stalled body, starved
post-admission timer, contended lock budget, cancellation, caller buffer/scope
mutation, offline/wrong identity/redirect and invalid budgets. The HTTP fixture is
not a native worker; the separate real D2/D3 path tests actual bootstrap composition.
Descriptor replacement is deliberate fault injection, not retirement authority.

First development run was 17/18: starvation test counted nested server admission
as an extra client check (3 vs 2); result already unavailable. Corrected TEST setup
only, targeted case passed, then final 41/41 + 1/1 passed. No production correction/
red-baseline claim. Logs: `/tmp/minu-claude-readiness-development-failures.log`,
`/tmp/minu-claude-readiness-starvation-check.log`.

All runtime checks env -i, disposable private HOME/config/state, explicit allowlisted
Node/system PATH, dummy values. No paid/provider/model/tool/real Claude execution,
inherited real credentials/global settings, signals, primary Codex/Channels builds/
writes, commits/pushes. Diff and explicit untracked whitespace checks passed.

Current package-relative hashes:
- src/worker-readiness.ts: `a9a87e102f49dad330eda5043a9fa8c36a0145c6d424f37be416f3012637f8bc`
- src/managed-store.ts: `9f1bf09db5fffb02016c9dc8e8e25b6b89c3eea39282541ecebc731a1b1cabd1`
  baseline `d7da26e053f3f7a1fe5a1bc4ef8351dfb876b0b255541e184a8f2ad141b8a408`
- test/worker-readiness.test.ts: `7c74075d6ba0e68cbffbcda3a9bd8dc5b76b119f99ef82a430f2854c620fa442`
- test/worker-launch.test.ts: `affd67bea419d758ef6f2fb3c571b0a9220e351d6f9aa7314f25e625ae65c535`
  (one added integration case/import; baseline `b0ba95fca525e652e51cd95f2afc838f5d050dd26e7b38604e31348047867cdc`)
Unchanged producer/entry/client references are frozen in the handoff. No bridge,
native driver, codec, fixture, package, core/Pi or public API change.

Bounded read-only request: `/tmp/minu-claude-worker-readiness-handoff.md`.
Sol-med independently APPROVED D4, no actionable findings: **41/41 affected tests**
and separately **1/1 real bootstrap check** passed, no skips. Same-lock HTTP
bracketing, exact descriptor/generation/fence checks, deadline/cancellation and
revocation behavior confirmed; no source edits. Report:
`/tmp/minu-sol-claude-worker-readiness-review.md`; independent logs:
`/tmp/minu-sol-claude-readiness-tests.log`,
`/tmp/minu-sol-claude-readiness-bootstrap-test.log`.
This is readiness-only approval, not future authority or physical/model health.
Normal stop/resume/exit proof, public wiring and MVP acceptance remain unfinished;
force recovery deferred for MVP only, not waived from full delivery. No new
supervisor/provenance/emergency-fence investigation was started by D4. Public APIs
disabled; changes uncommitted/unpublished.

## D5a — atomic idle-only quiesce independently closed

Next small NORMAL-lifecycle boundary only, not complete suspension/resume. Added
private POST /quiesce-idle and client requestQuiesceIdle using the existing bridge
mutation gate and real admission callback. Status==idle, one-way stopping fence
and runtime.stop run within that SAME admission. A separate status request then
stop would leave a new-turn race and is insufficient.

Busy/offline returns 409 without stopping/fencing/interrupting that session. Once
idle is admitted, new mutation/input is fenced before awaiting native shutdown;
stop failure/lost ACK leaves it fenced, with no automatic retry/reset. Reply only
after native stop resolves. Same owner/session/generation authentication and
current persisted admission apply. Existing generic /stop/close/control behavior
unchanged; repeated quiesce is rejected once stopping (one-way per worker).

This is native-stop ACK ONLY: no worker/group exit, history durability or resume
permission. Current producer remains detached:false / group:null; that makes
physical exit/provenance an explicit unresolved gate before clearing/replacement/
resume. No new group setup, signals, retirement metadata, supervisor/witness,
controller cleanup or recovery path is introduced by D5a. No public API wiring.

Author checks: pnpm check and **51/51 affected tests passed**, zero skips:
`node --test packages/claude-code/dist/test/{worker-quiesce,managed-session,worker-bridge,worker-fencing}.test.js`.
Logs `/tmp/minu-claude-quiesce-check.log`, `/tmp/minu-claude-quiesce-tests.log`.
Includes 7 new actual filesystem/SQLite/loopback/fake-runtime cases and 2 new
actual SDK-peer managed-driver cases, plus existing affected regressions. Covers
busy refusal with continued use, deterministic turn-wins/quiesce-wins idle-check
races, admission held through native confirmation, no early ACK, failure/private
error sanitization, lost ACK/no replay and wrong-owner/generation/human-fence denial.
Exact metadata remains unchanged. No red baseline/production correction claimed.

Pending stays native-lazy; after a completed synthetic turn the captured SDK child
is actually absent after ACK. The listener STILL answers offline afterward, proving
this does not establish worker exit. Fake-runtime fixture cleanup bypass is local
TEST listener disposal after deliberate revocation, not a production admission/
cleanup grant. No metadata clear/resume attempted. New tests never infer group
absence from a fake counter or native PID alone.

Env -i, disposable private HOME/config/state, allowlisted Node/system PATH, dummy
local-only auth; Darwin arm64/Node 22.23.0. Existing bridge regression includes a
bundled native-engine check against a localhost SYNTHETIC provider; new managed
cases use synthetic SDK peers. No paid/external real-model/tool execution,
inherited real credentials/global settings, arbitrary/recovered process/group
signals, primary writes/builds, commits or pushes. Diff/explicit target whitespace
checks passed. No full regression rerun; 510/510 predates D4/D5a.

Frozen package-relative SHA-256:
- src/worker-bridge.ts: `a942d975825715c466f7f0cfd9e3ca7376ffaf611499c35358affbc1d6d08ee2`
  baseline `7a802d361b6ae45685347a9e504ac4121790b04766c642c87d8162569312a52d`
- src/worker-client.ts: `224733ffa3ed4a35e10537a39cca9140cbc6fd937d9afa75d33ba1d6698756fa`
  baseline `24441b35ab6dad6b49225a78f7b66bf95449a3ad248f740863d790432e7e19f0`
- test/worker-quiesce.test.ts: `2cbf9d81683442da67f22c38ed380aad38cb6f526dcde91b98f1b97b0f655544`
- test/managed-session.test.ts: `d346246f757365672a56c3a2343ea9db0313da980628912daa14a3ea32965716`
  baseline `5888102987af103b7626a1673f6b19a787e0488b3e32c8293bfb9a0d60bff854`
Managed driver/store, producer/entry/readiness, codec and fixtures remain unchanged.
No schema/package/dependency/core/Pi/primary Codex/Channels/CI changes.

Bounded read-only request: `/tmp/minu-claude-worker-quiesce-handoff.md`.
Sol-med independently APPROVED D5a only, no actionable findings: **51/51 affected
tests passed**, zero skips. Atomic idle check/fence/native stop, busy refusal with
continued usability, failure/lost ACK retaining the fence, identity and current
admission checks confirmed. Hashes matched; no source edits. Report:
`/tmp/minu-sol-claude-worker-quiesce-review.md`; independent log:
`/tmp/minu-sol-claude-worker-quiesce-tests.log`.
Normal physical exit/retirement + eligible same-history resume remain unapproved
and must be designed/proven before public enablement. Full R19/R20 out-of-band
recovery/fencing remains required later; this healthy lease/RPC path is not that
solution. All public managed APIs disabled, work uncommitted.

## D5b — study complete; conditional boundary accepted, native validation pending

New bounded READ-ONLY study, not implementation or the old broad conditional OS/
process investigation. Request: `/tmp/minu-claude-normal-exit-study-handoff.md`.
No source changes, new author tests or broad rerun. D5a's 51 independent checks
remain scoped to atomic native-stop acknowledgment, not worker/group exit.
Sol-med completed the bounded study at
`/tmp/minu-sol-claude-normal-exit-study.md`; two disposable Node probes passed:
`/tmp/minu-sol-claude-normal-exit-study.mjs` and matching `.log`.
Coworker read the report, not independently repeated the experiments.

Concrete failure the simpler path cannot handle: the native-stop callback/HTTP ACK
and worker disappearance do not establish required native/group absence. Current
producer is detached:false/group:null, and the listener remains after quiesce.
clearWorkerAfterExit requires independently established worker AND required native/
group exit; this precondition must not be weakened or fulfilled by assertion.

Study asks for the smallest healthy-idle retirement protocol using current v3
primitives, distinguishing an original known ChildProcess from a controller after
app restart. Evaluate ONE fresh-launch isolated POSIX group candidate AS A PROPOSAL
ONLY, plus worker self-closure outside admission, lost-ACK handling, non-signalling
absence evidence and strict same-snapshot CAS. Existing codec allows group==pid
or null, but valid fields are not origin/containment proof. No group:null migration,
PID-name matching, force kills, native-loop replacement or transcript settlement
inference. Exact eligible history/materialized durability remains separate.

At most two directly controlled disposable Node probes may demonstrate a descendant
outliving its isolated root and/or healthy retirement/stale-CAS refusal. Signal-0
observation of a fresh OWN fixture group is not permission to signal it. Cooperative
fixture self-exit only; no nonzero/recovered signals, process-table sweep, real
Claude/SDK/provider/model/tool calls, real credentials/global settings or repository/
primary writes/builds. Synthetic Node proof is NOT arbitrary native containment,
OS attestation, cross-platform or production lifecycle acceptance.

Return confirmed observations vs assumptions, minimal protocol/file-test map and
any required owner decision at `/tmp/minu-sol-claude-normal-exit-study.md`. If a new
mechanism is needed, explain its concrete necessity and propose it; do not implement
new schema, supervisor/guardian/witness, native helper, group setup or public API
without agreement. No implementation automatically follows this study. Forced
busy/unreachable recovery remains deferred for MVP, not waived from full R19/R20.
Public resume/managed APIs remain disabled. D5b concludes current populated
group:null workers lack sufficient required-domain exit evidence. A narrow pending/
never-created case with the original retained child and a proven no-descendants
contract is distinct, not populated same-history resume.

Confirmed Node observations: root + direct-child exit can leave a live descendant;
genuine fresh group absence does NOT authorize clearing after revision/generation/
human-fence changes. No successful clear/resume or native containment test occurred.

Minimal candidate remains fresh controlled detached POSIX groups, healthy self-
retirement outside admission, non-signalling absence observation and strict exact-
snapshot CAS. Existing v3 fields can correlate such a trusted launch, but group
inheritance is NOT containment: a descendant could detach/delegate managed work.
No actual Claude escape was demonstrated; absence of a native no-escape proof is
not evidence of containment. Read-only tools/hooks/MCP isolation/private metadata
are not OS enforcement. Do not migrate/reinterpret old group:null records.

OWNER DECISION: messages 98–99 ACCEPT the conditional trusted process-family
boundary for the intermediate MVP, SUBJECT TO VALIDATION, and require documentation
and possible future strengthening. Contract v1:
[Claude Code MVP process-family contract](claude-code-process-family-contract.md).
This is neither OS containment nor completed native validation. Existing populated
group:null stays ineligible; no automatic migration/reinterpretation. No stronger
supervisor/witness/native helper/new schema is authorized. At this decision point,
D5c validation was next and production isolated launch/retirement/resume were
unimplemented/disabled; D5c2 evidence and the later D6 launch-only increment follow below.

History remains a distinct gate: safe exact-file parsing/hash does not establish
latest-dispatch materialization or power-loss durability. Normal same-history
resume must retain binding/input/fence state and establish required history
eligibility from the pinned native persistence contract/evidence; never fabricate
settlement from text, reset missing history or replay uncertain input.

## D5c — partial native evidence; history correction independently closed

Documentation-only/coordinated validation increment. Owner acceptance and future
update/revalidation triggers are recorded in docs/claude-code-process-family-contract.md
and linked from README. Initial native validation changed no production code;
the narrow history correction is recorded below. No production group behavior
change. Existing Node study evidence is not mislabeled native containment or a
retirement/resume grant.

Bounded task: `/tmp/minu-claude-native-family-validation-handoff.md`. One targeted
actual bundled Claude 2.1.321 / SDK 0.3.321 run on Darwin arm64/Node 22.23.0 using an
explicit TEMP isolated worker launch and actual store/entry/driver/bridge, not a
modified production producer. Native default model, isolated settings/no hooks/MCP/
plugins, Read/Grep/Glob on private regular-text fixtures only. At most 3 logical
mapped turns / 8 localhost synthetic Messages requests; never forward upstream.
No real auth/model credentials, paid calls, user workspace, global config or
repository/primary writes/builds. No native/Bash/subagent/delegation expansion.

Observe actual known worker/native identities and launch-group membership, actual
local native tool results, real caller/evidence + committed settlement, separate
exact-history/mapped user-message correspondence and cooperative shutdown/domain
absence facts. Signal 0 observation only for the fresh own group; no nonzero group/
recovered PID controls. No clear/native resume/input replay in this task. Known-
process sampling supports the conditional pinned contract, not universal no-escape
or enforcement; unsupported effective policy/history/exit is a concrete blocker.

Report delivered: `/tmp/minu-sol-claude-native-family-validation.md`: BLOCKED.
Actual bundled 2.1.321 executed Read successfully under the real driver/store/bridge;
Runtime committed completed dispatch. Known native/worker group membership, their
cooperative exits and fresh own-group absence were observed separately. Native
history was unsupported_format because of the new non-chain tools-used record.
No clear/resume was attempted, and no universal containment claim follows.

Budget exhausted: 8 local Messages requests, 2 logical turn attempts, 1 completed
Read, 0 Grep/Glob. Initial probe incorrectly asserted exactly three offered tool
schemas and caused 6 local retry requests; ONE classified setup retry used the
remaining 2. Native also offered DeferredToolPlaceholder, described as a reserved
non-callable deferred-loading placeholder; it was never selected/executed. Its
broader policy semantics were not independently established. Do not mislabel the
setup failure as native escape or advertise an exact three-name provider schema.

No production process-family implementation follows automatically. History latest-
dispatch materialization/durability and later real auth/model/tool acceptance remain
separate from a valid parser/hash and synthetic provider. Public managed/resume APIs
stay disabled until applicable safety/integration gates. Full R01–R41 unchanged.

Contract future-update path: revalidate after changes to SDK/native/Node/OS, launch/
retirement/metadata origin, tools/hooks/MCP/plugins/preloads/environment/auth/admin
configuration, native persistence or observed lifecycle failures. Fail unavailable
on escape/untracked work/ambiguous evidence. Stronger OS containment/native contract
is a possible separately scoped future update, not an implementation commitment.

### D5c history correction — independently closed

Bounded producer-owned correction only in src/native-history.ts: recognize the
observed exact type/tools/sessionId shape, require an array of nonempty string names
at most 128 UTF-8 bytes each (same bound as tool_use names), reject extra/chain fields
and malformed identity/names. It is non-message bookkeeping, not capability,
permission, settlement or exit evidence; it does not update the parent/leaf. No
other metadata format or filesystem/chain/byte/record/output limits were relaxed.

21 fixture regressions added to test/native-history.test.ts. Two positive regressions
failed before the source change. Current author evidence: Claude project TypeScript
build passes; 148 selected offline helper/native-opening/driver tests pass. THREE
actual-native tests were explicitly excluded by name to avoid additional provider
requests/engine runs; the runner reports zero skipped among the selected tests.
This is a focused run, NOT a full suite/default gate or completed D5c validation.

Separately, read-only inspection of the preserved exact D5c JSONL now passes: 21
records / 44,827 bytes, SHA-256
205b80bd9e5ab833df964ab2cde12d874d51a3c4c557a8722adeb783b4eb8520.
Mapped user UUID correspondence and the expected user/tool/assistant projection
were checked; bytes unchanged. Zero provider calls, no worker/process control,
manifest mutation, metadata clear, replay or native resume. Parser acceptance is
NOT a resume eligibility/settlement/power-loss durability grant.

Current src/native-history.ts SHA-256:
774ef6c34c6e790ab454322af7599ed7b6f2246b134b64945a7d1b9b66970b55;
test/native-history.test.ts:
4338b4aad95a1ae9a01a85aad18545137a42d66417e48454a99d4caf03ec9f5a.
Logs: /tmp/minu-claude-tools-used-red.log (2 expected pre-fix failures),
/tmp/minu-claude-tools-used-check.log,
/tmp/minu-claude-tools-used-affected-tests.log,
/tmp/minu-claude-tools-used-history-recheck.log. Offline recheck script:
/tmp/minu-claude-tools-used-history-recheck.mjs.
Review handoff: /tmp/minu-claude-tools-used-history-handoff.md.

Sol-med APPROVE, correction ONLY:
/tmp/minu-sol-claude-tools-used-history-review.md. Independently repeated 148
selected offline tests (three actual-native cases excluded) and the preserved-file
recheck with exact mapped-user correspondence and unchanged bytes/hash. Source/test
hashes matched. No new provider calls/source edits; no independent build claim.
Independent logs: /tmp/minu-sol-claude-tools-used-offline-tests.log and
/tmp/minu-sol-claude-tools-used-captured-recheck.log. The compatibility finding is
closed, NOT D5c as a whole or normal-retirement/resume eligibility.

No new native validation budget, group production changes or broader process study
is opened by this correction. At this checkpoint the producer was still detached:false/
group:null, and Grep/Glob needed a separately bounded follow-on task after independent
closure (D5c2 below). Populated legacy records stay ineligible. Latest full-worktree
evidence remains historical 510/510 before D4/D5a.

### D5c2 — Grep/Glob conditional native paths supported within budget

Separate bounded continuation of the owner-approved native validation, AFTER the
history correction's independent closure; not a retry/reset of the exhausted first
8-request budget. Handoff /tmp/minu-claude-native-search-validation-handoff.md.
ONE fresh disposable experimental worker, at most TWO mapped turns (Grep and Glob)
and FOUR local Messages requests total, including failures/retries. No whole-run
retry or paid/external provider/real-auth work. Reuse the corrected provider setup;
reserved DeferredToolPlaceholder is recorded, not requested or asserted absent.
No extra tools, source edits, production launch changes, clear or native resume.

Use the actual bundled engine/real driver/store/bridge, private allowlisted env and
regular-text workspace fixtures. Check real tool results, native completion evidence
and committed settlement separately from exact history/correspondence, input fencing,
native-stop ACK, owned native/worker exits and fresh own-group absence. No claim that
known-PID sampling proves all transient helpers/no escape. New incompatibility or
ambiguous evidence is a blocker; do not weaken policy/validation or expand the task.

Report /tmp/minu-sol-claude-native-search-validation.md delivered: supported within
budget. ONE fresh experimental worker, TWO completed Grep/Glob turns, FOUR local
Messages requests, ZERO count_tokens/retries/overrun. Native evidence=native and
actual committed completed settlement were captured independently of history for
both callers. Actual bundled 2.1.321 / SDK 0.3.321 / Node 22.23.0 / Darwin arm64;
isolated config, default model, dummy local auth and synthetic localhost provider.

After captured native exit, the exact UUID/cwd/config-root history validated:
31 records / 51,830 bytes, SHA-256
9a053927591eb7670ef3a133556978cd8b2ecbfab8e24cf960c893c81539fa58.
Both mapped user UUIDs occur once; actual tool/result identities and final text
correspond. Native-stop ACK, native exit, worker exit 0 and fresh own-group ESRCH
were separate observations; no metadata clear/native resume. This is not power-loss
durability or a general eligibility certificate. Coworker read the report; no
independent native repetition. Prior Read budget/evidence remains separate.

Known worker/native group membership was observed, not every transient internal
helper. Same unexecuted DeferredToolPlaceholder, no unknown extra offered tools;
its broader semantics remain unverified. No observed escape or concrete blocker,
not universal no-escape/OS containment. The owner-accepted conditional assumption
remains required. Full native auth/provider/platform/R40 acceptance is not complete.

Script/log /tmp/minu-sol-claude-native-search-validation.mjs and .log;
redacted evidence /tmp/minu-sol-claude-native-search-evidence.json;
private retained root /private/tmp/minu-sol-native-search-zOcbyl. Raw descriptor/env/
prompt material stays private. Both controlled processes exited; source hashes
matched the task. No production/source edits, primary builds or paid calls.

## D6 — fresh isolated launch only; independently closed

Following the accepted conditional boundary and D5c/D5c2 observations, implement
ONLY fresh POSIX launch in existing worker-launch.ts: detached:true, actual retained
ChildProcess PID persisted as PID/group before private bootstrap, candidate must
match BOTH actual values. Windows fails before mutation/fork because detached there
does not establish the required POSIX group. No new schema/helper/framework or
OS attestation claim; a non-null group alone is NOT retirement/resume eligibility.

Unchanged: preflight/managed ceilings, real lease/CAS, commit-before-fork, missing-
PID/lost-confirmation uncertainty, private frame/environment handling, exact frozen
publication/re-admission, adoption vs readiness, creator IPC detachment, no replay/
reset/replacement/clear/signals. Production entry/store/codec are unchanged: entry
already reflects the exact recorded group. Legacy group:null remains readable and
untouched; occupied bound/settled starting/live legacy records cannot launch anew.

Changed tests: worker-launch.test.ts (real known-PID ps group==PID, descriptor/store
roundtrip/readiness, cooperative test exit + fresh-group signal-0 absence with
UNCHANGED metadata, Windows preflight refusal, two legacy null-group guards),
worker-entry.test.ts (one fresh-group dormant/publication/readiness case while
retaining existing null-group cases), fixtures/worker-launch-peer.ts (valid group
and null-group negative candidate; wrong-PID remains a valid codec fault).
No actual-native/provider requests in this increment: existing SDK protocol peers
only. No nonzero group/recovered-PID controls; no production retirement or resume.

Two new launch regressions failed before source change (null group and missing
Windows refusal): /tmp/minu-claude-isolated-red.log. Claude-project TypeScript build
passes, /tmp/minu-claude-isolated-check.log. Author affected run: 87/87 across launch,
entry, readiness and real store/admission tests, no skips/cancellations/failures:
/tmp/minu-claude-isolated-affected-tests.log. Not a full suite, native-platform
acceptance or independent review. Full regression remains historical 510/510.

D6 reviewed SHA-256, package-relative (later D7 changes are recorded separately):
- src/worker-launch.ts 66f86aba522328f106d64c9b75662f07d4412afe1914933f9377b7786614d7f0
- test/worker-launch.test.ts ec983b6e831fc9e089586ef516a63f4e9cf68f5382526be2cd9db254e66203b4
- test/worker-entry.test.ts a7603adef9fb5e25b051e41cc442b0452c28756f9336f0cd1f470cc9d1f78826
- test/fixtures/worker-launch-peer.ts d96aaa3754fb422bd08796164b5566d6c883544096685d6c6679f7aa30a61f03
Exact pre-change copies: /tmp/minu-claude-isolated-<basename>.before.
Review task /tmp/minu-claude-isolated-launch-handoff.md. Sol-med APPROVE, D6 ONLY:
/tmp/minu-sol-claude-isolated-launch-review.md. Independently repeated 87/87 affected
tests, fingerprints matched, no source edits/actual-native calls. Independent log:
/tmp/minu-sol-claude-isolated-launch-tests.log. Native/process-domain exit proof,
retirement, clear and resume remained outside D6 approval. All changes stay
uncommitted/unpublished; primary Codex and Channels remain untouched.

## D7 — healthy self-retirement independently closed before cadence change

Use the existing bridge/driver/entry, no supervisor/helper/schema or recovery layer.
Bridge returns a LOCAL idleQuiesced promise only after successful atomic idle native
stop AND admission release. The response gets a bounded finish/close attempt using
the existing 1s drain budget; lost ACK or unfinished delivery cannot indefinitely
block that signal. Busy, revoked, failed stop and generic /stop never resolve it.
After confirmed idle quiesce, bridge.close closes transport/pumps WITHOUT readmitting
or repeating runtime.stop; native was already confirmed by that exact request.
Generic/failed-stop explicit cleanup semantics remain unchanged.

Only entry compositions whose recorded group equals self PID opt in. On the local
signal, ready becomes false, bridge closes, closeOwnedNative confirms captured
cleanup/observer completion OUTSIDE admission, then worker self-exits 0. Cleanup
failure reports fixed unavailable; no replacement/reset or automatic retry. Legacy
null-group entries retain native-stop-only behavior. No metadata clear, generation
rotation, history repair/replay/resume, or nonzero group/recovered-PID signaling.
Self-exit and ACK are still NOT controller-observed domain absence/clear authority.

Two new isolated pending/bound self-retirement regressions failed before source
change because the worker remained alive. The bound SDK protocol peer completes a
mapped turn before quiesce; native/worker/fresh-group absence is checked with exact
UNCHANGED manifest state, retaining bound/settled evidence. This peer does NOT
persist the latest turn, so this is expressly NOT history/resume eligibility proof.
Pending remains native-lazy. Generic-stop and legacy-null entries do not self-retire.

Bridge tests cover completion after admission, no readmission/repeated stop even
with a subsequent persisted generation/human fence, lost ACK, and a scoped HTTP end
fault that neither finishes nor closes until bounded teardown. Failed/busy/revoked
and generic-stop cases do not signal retirement. No provider/native tool work.

Author Claude-project TypeScript build passes: /tmp/minu-claude-retirement-check.log.
Red regressions: /tmp/minu-claude-retirement-red.log (2 expected failures).
Focused entry/quiesce run: 33/33, /tmp/minu-claude-retirement-focused-tests.log.
Separate wider affected run: 112 selected tests pass across entry/quiesce/bridge/
driver/launch/readiness, /tmp/minu-claude-retirement-affected-tests.log. ONE bundled-
native/provider bridge case explicitly excluded by name; zero skips among selected
tests is not a claim that case ran. No full suite, actual-native/provider attempts,
paid calls or independent review claim. Existing synthetic protocol peers only.
Full-worktree evidence remains historical 510/510 before D4/D5a and later edits.

D7 current SHA-256, package-relative:
- src/worker-bridge.ts 908325c9e7a5795064f3251e704c8b922d5af3a47275f721bbb9807a0769af13
- src/worker-entry.ts 8b950e123017d5e99e7b61f86c0960aaa3fcc2f510b9a4512eb92cde9c655c6f
- test/worker-entry.test.ts 1255d3b5d65a0c9608b3a38124689054933c9654933bb702d9aaf7f92b40988c
- test/worker-quiesce.test.ts b910881f09762248df5381047543b8068febc7186ff1873379392ab7152faf5f
Exact pre-change copies: /tmp/minu-claude-retirement-<basename>.before.
D7 review had already completed before deferral: Sol-med APPROVE, no findings,
/tmp/minu-sol-claude-worker-retirement-review.md, independent 112 selected affected
tests /tmp/minu-sol-claude-worker-retirement-tests.log (one actual-native case excluded).
Hashes matched, no source edits. Reuse that scoped evidence; current controller/
history/public work is handled by the combined milestone review, not another D7 stop.
No new provider budget or broad process study. Existing populated group:null stays
ineligible. Controller proof, history eligibility, restart integration, real auth/
model/tool/platform/package acceptance and full R19/R20 remain separate unfinished work.

## Native-history helper — local finding closed; managed integration still pending

Sol-med delivered `src/native-history.ts`, dedicated tests and a local provider
fixture at helper SHA-256
`44e6fc0b9353736f88d30f30e64225327962ae426c37fef0f31ea494d59cc8f4`.
Author-reported typecheck and 63/63 focused checks; pinned native linear-format
subset only. Branching, compaction and unknown formats intentionally refuse.
Handoff: `/tmp/minu-sol-native-history-implementation.md`.

Coworker read the implementation/tests and independently reproduced a concrete
corrupt-input projection defect at `native-history.ts`'s hidden-message test:
a valid-shaped native user row with `isMeta: "true"` was accepted as `present`
and projected `PRIVATE_HIDDEN_PROMPT` into normalized public history. Malformed
hidden flags must be rejected, not treated as false. Requested rework is to type-
validate `isMeta` and `isVisibleInTranscriptOnly` when present, with negative tests
for non-booleans and positive tests preserving absent/false/true semantics. The
helper remains unmodified by coworker. Sol-med added optional-boolean validation
for both flags before normalization. Corrected source SHA-256:
`a3f55fbb1550732ace2388e3783ca174843615c3ded74e046fb1a61330b8dfdf`;
test SHA-256: `951f4e8393ccb160a4156e280fff8fb39407b7c6f205180fe68695af77a1ae87`.
Coworker observed typecheck, 22/22 dedicated flag cases and the 232/232 integrated
run including all 85 helper cases; the reproduced finding is closed. Other native
ownership/launch/uncertainty responsibilities remain with the worker, not the
parser. This is a local integration assessment, not verifier approval.

## Native-boundary investigation — peer-reported evidence

Sol-med reported SDK 0.3.321 / Claude Code 2.1.321 on Darwin arm64, seven
localhost synthetic-provider calls with isolated HOME/config and no inherited
credentials, paid calls or repository edits. This is targeted native-process
boundary evidence, not R40 real-model/tool/authentication acceptance.

- Materialized completed history reopens under the same UUID. Create must use
  only `sessionId`; reopen must use only `resume`, with persistence enabled.
- Empty initialized sessions have no resumable history. A bound ID is not evidence
  of persistence or dispatch; absent bound history must not reset to pending or
  fallback-create.
- Native wrong-workspace resume succeeded and reused original history. Runtime
  must validate its recorded canonical workspace before spawning; successful
  native initialization is not workspace authorization. Exact-directory native
  history lookups rejected that wrong workspace in the probe.
- Crash/interruption resume showed no provider calls during bounded 2.5/2-second
  idle observations. This is not universal no-replay proof: tools in flight,
  startup hooks, hosted/background/queued recovery were not exercised. Preserve
  dispatch uncertainty and prelaunch fencing; native filler is not a Runtime
  terminal result.
- Native settings allow rules can bypass `canUseTool`; hooks/MCP can execute at
  startup. Integration inheritance therefore requires explicit policy, not simply
  removing isolation or advertising universal callback enforcement. No native
  integration-policy change is enabled by this investigation.
- SDK history helpers resolve host configuration independently from query child
  `env`. Use the exact authorized config root explicitly or a dedicated worker's
  stable environment; never mutate global environment across sessions/owners.

Artifacts: `/tmp/minu-sol-claude-native-boundary-findings.md`,
`/tmp/minu-sol-native-resume-probe.mjs`,
`/tmp/minu-sol-native-resume-probe-expanded.log`.
These are sol-med's observations; coworker has read the report/reproducer, not
independently repeated the spike. That investigation preceded the helper delivery
and local rework finding recorded above. Production worker admission remains unimplemented;
verifier remains unconnected/review pending.

## Verification cadence

For the metadata slice: typecheck plus focused actual-filesystem and child-process
tests for private storage, immutability, safe publication, stale writes, owner
isolation, expired/concurrent mutation leases, lock contention/crash release and
native-binding uncertainty. Reuse unchanged initial-adapter/Pi evidence.
Run integrated workspace/build/package gates when worker/client changes are
combined. Later native resume and worker replacement require distinct real-native
and real-process evidence; fixtures do not replace those boundaries.

Do not commit/push, alter the primary Codex worktree, modify Channels, provision
secrets, run paid-provider acceptance or claim review completion without separate
observed evidence.
