# Claude Code MVP process-family contract — v1

## Decision and current status

The owner accepted this **conditional MVP trust boundary** in conversation
messages 98–99, with documentation and the possibility of strengthening it later.
This is not an OS-containment guarantee or an assertion that validation is done.

**Current status:** accepted conditional boundary, supported by the bounded pinned
Read/Grep/Glob observations below—not universal containment or full native acceptance.
D6/D7 fresh launch and healthy self-retirement are independently closed. The current
combined batch author-implements controller normal stop/history eligibility/resume,
opt-in managed API and CLI. Original author/independent 582-test runs passed, but
integrated review found one hidden-history-tail gap. The corrected combined
implementation is now independently APPROVED (message 128), including 172/172
current affected tests. Verifier assessment is PASS for the reviewed implementation
(message 132), not MVP/release completion. Real authentication/model/tool acceptance
still requires owner-approved source/scenario/budget; neither approval waives it.
Publishing a feature PR is not production or release acceptance. Existing populated
`group:null` workers are not migrated or treated as eligible exit domains.

The local rebase/EPERM-wait correction and its current verification are recorded in
the plan; those later changes are not covered by the earlier independent approvals.

This contract is a documented milestone boundary, not a new runtime flag/schema or
removal of R01–R41 from the full delivery target. See
[implementation plan](claude-code-adapter-plan.md).

## Trusted configuration and assumption

Initial validation target:

- Darwin arm64, Node 22.23.0.
- Claude Agent SDK 0.3.321 and its pinned Claude Code 2.1.321 engine.
- Trusted local host/operator, Runtime implementation and launch inputs; owner-private
  metadata and authenticated exact-owner/session/generation transport.
- Fresh controlled POSIX worker launch in its own process group, with actual
  fork-returned identity recorded before private bootstrap/publication.
- Existing isolated native configuration: hooks disabled, no plugin/MCP inheritance,
  native default model and requested Read/Grep/Glob policy (see observed schema
  limitation below). No unreviewed executable
  wrapper, Node/loader preload, extension, detached task/agent facility or external
  local-agent delegation. Authentication remains harness-owned where authorized;
  a real supported authentication path still needs separate acceptance.

**Conditional assumption:** relevant locally managed work stays in that trusted
launch process family. Neither the worker, native harness nor an owned tool/helper
may escape the domain or delegate continuing managed work to a local agent/service
outside it. No outside process may later revive equivalent managed work for the
same binding. A non-null group value is useful only when its fresh controlled origin
and eligible configuration are established—not because the codec accepts it.

Relevant work includes Runtime's worker, its native harness and owned subprocesses
that can continue acting for that session, accepting input or writing its history.
A remote model provider is not a locally owned process, and Runtime does not promise
rollback or cancellation of already-performed remote/tool side effects.

Process-group inheritance alone does **not** establish the assumption. Read-only
tool exposure is neither an OS sandbox nor a workspace filesystem boundary.
Permissions/admin policies still apply; an unverified effective configuration is
not eligible merely because launch settings requested isolation.

## What exit evidence may and may not establish

An eligible normal-retirement implementation must combine:

1. Exact current owner/session/generation/reservation/descriptor and idle-only
   admission; fence input before stopping native work.
2. Successful owned native cleanup and worker self-teardown outside the held
   lifecycle admission. Lost reply/creator IPC is not a replacement or replay signal.
3. Genuine absence of the trusted required local domain, independently of a stop
   ACK/socket closure/offline status. The original creator's retained ChildProcess
   and a controller after restart have different available evidence. Normal controller
   observation uses only signal 0 on the current qualified, trusted fresh-origin group;
   Only ESRCH proves absence. EPERM leaves absence unproven: during the existing
   bounded read-only wait it can be followed by a fresh probe, never another stop.
   Persistent EPERM, an EPERM during final admission, and other probe errors cannot
   authorize clearing. Trusted origin is a private-metadata/controlled-launch
   invariant, not codec validity or OS attestation.
4. Fresh exact-snapshot/revision/fence checks under the lifecycle lease before any
   permitted metadata clear. Do not silently rebase after observing absence.
5. Separate exact native-history eligibility/validation before resume. A safe parsed
   file/hash alone does not prove latest-dispatch materialization or power-loss
   durability, and history text never manufactures caller settlement. The current
   normal path first requires an independently committed completed dispatch, then
   its exact native input UUID/literal UTF-8 fingerprint, drained queue/closed tools,
   pinned end_turn and final-leaf correspondence. Only observed split thinking/text
   rows of ONE API response and prompt_snapshot tail bookkeeping may extend that
   completed leaf. Public redaction never disables structural input/tail checks:
   hidden trailing inputs/unrelated responses refuse, while supported pre-target
   bookkeeping/paired tool results stay non-public. Snapshots must directly extend
   the completed cursor and cannot reopen its response. Interrupted/failed/unknown/
   missing/unsupported history refuses.
   These are clean app-restart checks, not a general power-loss durability certificate.

Only after the relevant evidence and validated contract apply may domain absence
support normal retirement. The current conditional implementation is independently
reviewed; it is not a universal or OS-enforced exit proof or release acceptance.
Present/ambiguous/unreadable domains, unknown origin, legacy `group:null`, changed
scope/fence, uncertain creation/dispatch or unproven history remain unavailable.
No guessed cleanup, automatic migration, replacement thread or input replay.

This does not authorize TERM/KILL against recovered PIDs/groups, process-name
matching, forced busy/unreachable recovery, a new supervisor/witness or OS helper.
Full R19/R20 recovery/fencing remains separate required work beyond this MVP.

## Validation and evidence limits

Validate the actual pinned native configuration with disposable private roots and
controlled local-provider/tool tasks. Record source/environment/configuration,
actual known worker/native identities, observed launch-group membership, shutdown
and eligible-history evidence. Synthetic Node fixtures alone are insufficient for
the native path. A local synthetic provider does not establish real model/provider
quality or authentication/subscription compatibility.

The bounded D5c/D5c2 paths support this **conditional** pinned configuration. Actual
Read completed in D5c; separate D5c2 completed Grep and Glob with explicit native
completion evidence and committed Runtime settlement. Captured native/worker exits
and fresh own-group absence were separate observations, not inferred from stop ACK.
The Read `tools-used` parser incompatibility was corrected and independently closed:
148 selected offline tests and unchanged captured-file/mapped-user checks passed.

Budgets remain distinct: initial D5c used 8 local requests / 2 attempts / 1 completed
Read, including one classified setup retry; D5c2 used one fresh worker, two completed
Grep/Glob turns and exactly 4 local Messages requests, zero retries/count_tokens.
Its post-native-exit exact history validated with both mapped UUIDs and expected
tool/final-text correspondence (31 records / 51,830 bytes). Reports are recorded in
the implementation plan. Coworker read these reports, not independently repeated
the native experiments. No real provider/authentication or native resume acceptance.

Known worker/native groups were observed, but not every transient helper inside the
native executable. No escape was observed; universal no-escape was not established.
D6/D7 launch and healthy self-retirement are independently reviewed; legacy-null
and generic-stop behavior is retained. The combined controller/API/CLI batch now
composes the remaining normal-path checks above and is independently approved. Tests
exercise actual bundled native text/thinking and separate CLI process exits using
local synthetic providers/dummy credentials only. A non-null group, stop ACK or
worker self-exit never replaces the independent domain/metadata/history gates.
Force recovery, native auth/subscription and other-platform acceptance remain open.

Native offered Read/Grep/Glob plus `DeferredToolPlaceholder`, described as reserved
for deferred loading and never to be called. The placeholder was not selected or
executed; its broader policy semantics remain unverified. Requested tools must not
be advertised as an independently established exact three-name provider schema.
Evidence and correction status are recorded in the implementation plan.

Targeted observations support this **conditional** contract for the tested path;
they cannot prove universal no-escape behavior or turn groups into OS enforcement.
Any observed escape, external managed-work delegation, untracked writer or ambiguous
exit invalidates the proposed proof path: keep resume disabled and report it rather
than weakening checks. Evidence and review status remain explicit in the implementation plan; this document
does not itself authorize production group changes or retirement/resume.

## Revalidation and possible future strengthening

Revalidate affected evidence before relying on this contract after changes to:

- SDK/native engine, Node/OS/platform or native spawn/shutdown behavior;
- worker launch/group setup, private bootstrap, retirement or metadata origin;
- enabled tools, hooks/plugins/MCP, wrappers/preloads, admin settings or delegated
  agent/background-task behavior;
- native environment/authentication/configuration inputs that affect process launch;
- native history format/persistence behavior or observed lifecycle failures.

Do not silently transfer old evidence to a new version/configuration, or reinterpret
old registrations as fresh isolated launches. Record the changed contract/evidence
and preserve unavailable states until eligibility is re-established.

If the product needs safety without this trust assumption, separately assess stronger
OS-enforced containment or a stronger native lifecycle contract. That is a possible
future update—not an implementation commitment or authorization now. Such a change
must state the guarantee, migration/compatibility consequences and verification
before replacing this boundary. A new field or private token alone is not containment.
