# Managed-session recovery for Claude Code and Codex: spec v1

Status: **ready for implementation**. Branch `feat/managed-recovery`, based on `main` at `52160fd`.
Review sources: findings on minuscule-labs/runtime#24 (Claude Code) and #23 (Codex).

## 1. Problem

Pi can recover managed sessions. The Claude Code and Codex adapters cannot. Today a single crash,
reboot, failed launch or interrupted turn can leave a managed session stuck for good. It can't be
used, stopped, destroyed or replaced. Channels needs `forceStopManaged` for explicit stop, restart
and replacement (`agent-host.ts`, `runtime_stop` / `runtime_restart`, `replaceStoppedSession`).
Neither adapter implements it, so Channels reports "Owner-scoped Runtime recovery is unavailable"
for Codex today, and Claude Code can't be added to Channels at all.

Gaps this spec closes (numbering from the review summaries):

| # | Gap | Claude Code | Codex |
|---|-----|-------------|-------|
| G1 | A dead or stale worker (crash, OOM, reboot) can't be recovered | stuck `live` | stuck `ready` |
| G2 | No stop or destroy after an interrupted, failed or pre-dispatch turn | stop refused | session left offline |
| G3 | A failed launch or resume loses the session | orphaned manifest or worker | `aborted` can't be cleared |
| G8 | Symlinked `cwd` / `--managed-root` rejected | n/a (already `realpath`s) | stuck in `creating` |

Out of scope for v1: G4 (lock held during native startup), G5 (per-event admission cost), history
size caps, in-process `stop()` retention, and duplicated helpers. List them in the PR as follow-ups.

## 2. Contract every adapter must meet

Use Pi's `forceStopManaged` / `destroy` in `packages/pi/src/client.ts` and
`packages/pi/src/worker-recovery.ts` as the reference behavior. It matches the `AgentRuntime` doc
comments in `packages/core/src/index.ts`.

### 2.1 `forceStopManaged(id, ownerId)`

1. Take the session lifecycle lock. Check that the owner matches exactly. A missing or destroyed
   session throws.
2. **Fence first.** Persist `requiresExplicitResume: true` before any stop attempt, so a lost
   return can never leave a slot that resumes automatically.
3. If an authenticated worker endpoint is reachable, send it one best-effort stop request that
   **bypasses idle/busy admission** (a 2 s timeout is fine). Do not retry it or depend on its reply.
4. Wait, within a bounded time, for **absence proof** (§2.3). If there's none, use **verified
   termination** (§2.4). If absence still can't be proven, throw and leave the session fenced.
   Never clear on uncertainty.
5. Once absence is proven, clear the worker slot to `none` and rotate the generation. Keep the
   native binding, the last dispatch and the resume material unchanged. **Succeed even if the
   history or transcript is ineligible**; `resume` validates that separately.
6. Idempotent: calling it on an already-stopped session (worker `none`) succeeds without changes,
   apart from setting the fence if it isn't already set.
7. Works while the session is busy, interrupted, failed, unreachable, `reserved`, `starting`,
   `aborted` or `live`/`ready`.

After a successful call, `getManagedSession` returns `state: "suspended"` and `status()` returns
`"offline"`.

### 2.2 `destroy(id, ownerId)`

Run `forceStopManaged`'s stop-and-prove-absence path, unless the worker is already `none`. Then
remove the Runtime resume metadata. Native transcripts and history are **not** deleted. Destroy
must succeed for stopped, crashed, aborted and never-started sessions on every supported
platform, including Linux for Codex. A missing session is a no-op only if it never existed for
this owner. Keep each adapter's existing error style.

### 2.3 Absence proof (no signals)

A worker counts as proven absent when **any** of these holds:

- **Boot changed.** The recorded boot identity differs from the current one. Use
  `bootSessionUuid` on macOS (Codex already records it in `darwin-process-domain.ts`) and
  `/proc/sys/kernel/random/boot_id` on Linux. A reboot proves every process from the earlier boot
  is gone. If the boot identity can't be read, this check gives no proof either way.
- **Own group gone.** The worker was launched in its own process group (`pgid === pid`, recorded at
  launch) and `process.kill(-pgid, 0)` throws `ESRCH`. `EPERM` means **unproven**, as the existing
  Claude Code exit probe already handles. Any other error fails closed.

A bare-PID `ESRCH` is **not** proof for a worker that shares its parent's group, because native
children may survive it.

### 2.4 Verified termination (signals)

Only when the boot is unchanged, the group is still present, and the worker's identity is verified:

- Read `ps -ww -p <pgid> -o pgid= -o args=`. Require `pgid` to equal the recorded group, and the
  command line to carry the exact identity markers from §3.1 (`--minu-runtime-session <id>`,
  `--minu-runtime-owner <ownerId>`, `--minu-runtime-generation <generation>`) plus the expected
  worker entry path. Any mismatch throws **without signaling**.
- Send `SIGTERM` to `-pgid`, then poll for up to 5 s. If the group is still there, send `SIGKILL`
  to `-pgid` and poll for up to 5 s more. Prove absence with `ESRCH` on the group.
- Never signal a bare PID, a group that isn't the worker's own, or anything found by process name.

Put §2.3 and §2.4 in **one shared module**, `packages/core/src/process-recovery.ts`, and export it
from core. Suggested API: `readBootIdentity()`, `processGroupAbsent(pgid)` returning
`"absent" | "present" | "unproven"`, and
`terminateVerifiedGroup({ pgid, entryPath, markers, termMs, killMs })`.
Pi keeps its own `worker-recovery.ts` for now; migrating it is a follow-up.

### 2.5 Contract change for Claude Code

`docs/claude-code-process-family-contract.md` currently forbids TERM/KILL and recovered-PID
control, and lists forced recovery as future work (R19/R20). Update it to v2: allow §2.4 for
workers launched **with** the §3.1 markers and their own group, and keep the existing ban for
legacy `group:null` and unmarked workers. Those legacy workers can still be cleared through
boot-change proof alone. Otherwise they stay fenced, and that's documented.

## 3. Work items

Do them in order. Commit each item separately with tests, so the branch can be reviewed one commit
at a time.

### 3.0 Shared
- **S1** Add `packages/core/src/process-recovery.ts` (§2.3, §2.4) with unit tests. Use real child
  process groups: spawn a detached fixture that spawns a grandchild, then verify group
  termination, marker-mismatch refusal (no signal sent), `EPERM`/unknown-error handling (inject a
  `kill` function), and a boot-identity mismatch.

### 3.1 Claude Code (`packages/claude-code`)
- **C1 Launch identity.** In `worker-launch.ts`, pass the §2.4 markers as argv on the worker fork,
  and record `bootIdentity` in the worker record. This needs a manifest schema version bump in
  `managed-store.ts`. Older manifests stay readable, and a missing boot identity means "no boot
  proof". Keep `processGroupId === pid`.
- **C2 `forceStopManaged`.** Implement it on `ClaudeCodeManagedRuntime` following §2.1. Clear the
  worker through a new lease operation alongside `clearWorkerAfterExit`, one that doesn't require a
  clean dispatch or clean history. Add an adapter-private bridge route for the admission-bypassing
  stop request. It needs the same authentication as the existing routes, and the worker must exit
  its native process family on receiving it.
- **C3 `destroy`.** §2.2. Remove the manifest directory after proven absence. Native history in
  `nativeConfigRoot` is left in place.
- **C4 Stale and partial states.** `forceStopManaged` and `destroy` must handle `reserved`,
  `starting` (with or without a recorded process) and `live` with a dead endpoint. Readiness or
  auth failures go through absence proof; they never trigger a guessed clear.
- **C5 `startManaged` failure.** If launch or readiness fails after the manifest is created, run
  the §2.1 stop path for that id before throwing. If absence is proven, remove the manifest (the
  same as destroy). Otherwise leave it fenced, so `listManagedSessions` shows it and
  `forceStopManaged` can clear it later.
- **C6 After force-stop.** `getManagedSession` returns `suspended`. `resume(…, { allowStopped:
  true })` re-checks history: eligible history relaunches as today, and ineligible history throws
  and leaves the session fenced and suspended. Channels maps that to `session_resume_failed`,
  which permits replacement. Normal `suspend`/`stop` keep their current strict semantics.

### 3.2 Codex (`packages/codex`)
- **X1 Launch identity and group.** In `managed-worker.ts`, fork the owned worker with
  `detached: true` (its own group) and the §2.4 markers in argv, and record `pgid` plus boot
  identity on every platform. Keep the existing Darwin observation. Workers recorded without a
  group are legacy: they can only be cleared by boot-change proof, otherwise they stay fenced.
- **X2 `forceStopManaged`.** Implement it in `managed-client.ts` and expose it on
  `CodexAgentRuntime` (`client.ts`), following §2.1. Request stop through the authenticated
  bridge, then use proof or verified termination. The resulting manifest has worker `none`,
  `requiresExplicitResume: true`, and native binding and history untouched.
- **X3 `destroy`.** Replace the live-suspend requirement with the §2.2 path. It must pass on Linux.
- **X4 `aborted` / `reserved`.** `forceStopManaged` clears these slots to `none` after absence
  proof. A recorded `pid` with no group is legacy, as in X1. After that, `resume` can relaunch.
- **X5 Interrupt before dispatch** (`pending-worker.ts` ~526). Settle the turn as `interrupted`
  without marking the whole session unavailable, if the native thread can still be used. If it
  can't, it's acceptable to leave the session `unavailable`, but `forceStopManaged` and `destroy`
  must then work on it. Add a regression test for each outcome you implement.
- **X6 Real paths.** `realpath` the managed `cwd` at create time (`managed-native.ts`, ~25) before
  anything is persisted, and `realpath` `--managed-root` in `packages/runtime/src/cli.ts` (~57).
  Test with a symlinked temp directory, since macOS `/tmp` is one.

### 3.3 Shared conformance
- **K1** Extend `test/headless-conformance.test.mjs` with a shared force-stop contract for all
  three adapters. Start a session and make it busy (held turn), then call `forceStopManaged`. The
  native PID must be gone, `getManagedSession` must return `suspended`, a second call must be a
  no-op, and `destroy` must succeed afterwards. Also add a "worker killed externally" case:
  SIGKILL the worker group from the test, then `forceStopManaged` succeeds through group-absence
  proof.

## 4. Testing rules

- Credential-free fixtures only: the existing synthetic providers, the persistent native fixture
  and the Codex `app-server` fixture. **No real model, auth or network.**
- Don't weaken or delete existing assertions. If behavior intentionally changes (for example, a
  test that asserted "stop refused, manifest unchanged" now also covers force-stop), keep the old
  assertion for normal `stop` and add new ones for force-stop. Explain each changed assertion in
  its commit message.
- Each fixture's teardown must leave no live process groups. Assert that in the new tests.
- Required before handing off: `pnpm check`; `pnpm test` with 0 failures (the existing 2 opt-in Pi
  skips are expected); and `pnpm test:headless` passing for all three adapters, with any new
  cases. Run on macOS. If a Linux path can't be exercised locally, say so explicitly. Don't claim
  it was tested.

## 5. Acceptance

- [ ] S1, C1–C6, X1–X6 and K1 are implemented, with one or more commits each, each with tests.
- [ ] Process-family contract v2 is committed, and its README section is updated.
- [ ] All three test commands are green locally, and the results (counts) are recorded in the PR
      description.
- [ ] Draft PR opened against `main`, listing deferred items (G4, G5, history caps, Pi migration
      to the shared module).
- [ ] Not merged, tagged or published. Channels is not changed by this work; Claude-in-Channels is
      a separate follow-up once this merges.

## 6. Implementation notes and pitfalls

- Each adapter wraps errors in a single generic message (`unavailable()`). Keep that public
  surface, but make sure force-stop failures still leave the record **fenced**, never half-cleared.
- The Claude Code store's `withWorkerAdmission` validates the registration bytes. Force-stop must
  not need a valid registration, because a corrupt or dead registration is exactly the case being
  recovered.
- Codex `CodexManagedStore` has many worker states (`reserved | aborted | ready | retired | …`).
  Add one lease operation, for example `clearWorkerAfterProvenAbsence(revision, generation,
  claimId, proof)`, instead of loosening the existing transitions.
- Keep timeouts bounded so they fit inside Channels' 90 s `forceStopManaged` timeout: about 2 s for
  the stop request, about 7 s for graceful absence, then 5 s + 5 s for TERM/KILL.
- Every new fork needs its group verified (`ps` `pgid`) before it's recorded. A worker that fails
  that check isn't eligible for §2.4.
