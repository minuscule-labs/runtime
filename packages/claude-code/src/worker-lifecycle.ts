import { setTimeout as delay } from "node:timers/promises";
import { ClaudeCodeManagedStore, type ClaudeCodeManagedManifest } from "./managed-store.js";
import { inspectClaudeCodeHistory } from "./native-history.js";
import { ClaudeCodeWorkerClient } from "./worker-client.js";
import { encodeClaudeCodeWorkerRegistration } from "./worker-registration.js";

const unavailable = () => new Error("Claude Code managed lifecycle unavailable");

/** Trusted-host/pinned-family eligibility, NOT OS containment or PID attestation. */
export function requireClaudeCodeMvpPolicy(m: ClaudeCodeManagedManifest): void {
  if (process.platform === "win32" || m.policy.configuration !== "isolated" || m.policy.permissionMode !== "default"
    || !m.policy.tools || m.policy.tools.some(tool => !["Read", "Grep", "Glob"].includes(tool))
    || m.launchConfig.model !== undefined || m.launchConfig.reasoningLevel !== undefined || m.launchConfig.skillIds !== undefined) throw unavailable();
}
export function claudeCodeLiveWorker(m: ClaudeCodeManagedManifest, workerExecutable: string) {
  requireClaudeCodeMvpPolicy(m);
  if (m.requiresExplicitResume || m.worker.state !== "live" || m.worker.generation !== m.generation
    || m.worker.workerExecutable !== workerExecutable || m.worker.registration.processGroupId !== m.worker.registration.pid) throw unavailable();
  const scope = { sessionId: m.id, ownerId: m.ownerId, generation: m.generation, reservationId: m.worker.reservationId,
    workerExecutable, cwd: m.launchConfig.cwd, nativeConfigRoot: m.policy.nativeConfigRoot };
  return { scope, registration: m.worker.registration, bytes: encodeClaudeCodeWorkerRegistration(m.worker.registration, scope) };
}

/** Call under the session lease with no native writer. Does NOT derive settlement:
 * only an independently committed completed dispatch may request this extra check.
 * Failed/interrupted/uncertain latest inputs remain unavailable in the MVP. */
export async function claudeCodeCleanHistory(m: ClaudeCodeManagedManifest) {
  requireClaudeCodeMvpPolicy(m);
  if (m.native.state === "pending" && m.lastDispatch.state === "none") return [];
  if (m.native.state !== "bound" || m.lastDispatch.state !== "settled" || m.lastDispatch.outcome !== "completed") throw unavailable();
  const history = await inspectClaudeCodeHistory({ nativeSessionId: m.native.sessionId, canonicalCwd: m.launchConfig.cwd,
    nativeConfigRoot: m.policy.nativeConfigRoot, completedInput: {
      nativeMessageId: m.lastDispatch.nativeMessageId, fingerprint: m.lastDispatch.fingerprint,
    } });
  if (history.state !== "present") throw unavailable();
  return history.messages;
}
function cleanDispatch(m: ClaudeCodeManagedManifest): boolean {
  return m.native.state === "pending" ? m.lastDispatch.state === "none"
    : m.native.state === "bound" && m.lastDispatch.state === "settled" && m.lastDispatch.outcome === "completed";
}
/** Signal 0 ONLY: ESRCH means absent. EPERM leaves absence unproven, allowing
 * the caller's bounded read-only wait to continue; it never authorizes clearing.
 * Used only for the qualified current fresh-origin group under the accepted contract.
 * No nonzero signals, recovered-PID control, process-name search or fallback. */
function groupAbsent(group: number): boolean {
  try { process.kill(-group, 0); return false; }
  catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return true;
    if (code === "EPERM") return false;
    throw unavailable();
  }
}

/** Healthy normal stop only. No lease across HTTP, no forced recovery or replay.
 * Unknown reply may still retire; absence + unchanged state + materialized history
 * are separate gates. Every mutation is attempted once; lost returns stay uncertain. */
export async function suspendClaudeCodeWorker(store: ClaudeCodeManagedStore, id: string, ownerId: string,
  workerExecutable: string, timeoutMs = 15_000): Promise<void> {
  try {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000) throw unavailable();
    const end = performance.now() + timeoutMs;
    const remaining = () => { const ms = Math.ceil(end - performance.now()); if (ms <= 0) throw unavailable(); return ms; };
    const snapshot = await store.read(id, ownerId); if (!snapshot || !cleanDispatch(snapshot)) throw unavailable();
    const live = claudeCodeLiveWorker(snapshot, workerExecutable), frozen = JSON.stringify(snapshot);
    const exact = (current: ClaudeCodeManagedManifest | undefined) => { if (!current || JSON.stringify(current) !== frozen) throw unavailable(); };
    await store.withWorkerAdmission(live.scope, live.bytes, async (_, current) => { exact(current); }, remaining());
    // Require a living, authenticated idle worker before the one normal-stop request.
    const client = new ClaudeCodeWorkerClient(live.registration, Math.min(2_000, remaining()));
    if (await client.status() !== "idle") throw unavailable(); remaining();
    await store.withWorkerAdmission(live.scope, live.bytes, async (_, current) => { exact(current); }, remaining());
    try { await client.requestQuiesceIdle(); } catch { /* No retry: physical absence remains mandatory. */ }
    while (true) {
      remaining();
      if (groupAbsent(live.registration.pid)) break;
      await delay(Math.min(20, remaining()));
    }
    await store.withSessionLock(id, ownerId, async lease => {
      const current = await store.read(id, ownerId); exact(current); remaining();
      if (!groupAbsent(live.registration.pid)) throw unavailable();
      await claudeCodeCleanHistory(current!); remaining();
      if (!groupAbsent(live.registration.pid)) throw unavailable();
      // Fence BEFORE clear. A lost mutation return cannot leave an automatically
      // resumable slot. Clear preserves binding/input/fence and rotates generation.
      const fenced = await lease.update(current!.revision, { requiresExplicitResume: true });
      await lease.clearWorkerAfterExit(fenced.revision, snapshot.generation, live.scope.reservationId, live.registration.pid);
    }, remaining());
    remaining(); // A late committed return is uncertainty, never an on-time success.
  } catch { throw unavailable(); }
}

/** Explicit clean resume preparation only; never clears an occupied/uncertain slot.
 * The caller subsequently uses the existing one-shot launcher, outside this lease. */
export async function prepareClaudeCodeResume(store: ClaudeCodeManagedStore, id: string, ownerId: string): Promise<void> {
  try {
    const initial = await store.read(id, ownerId); if (!initial) throw unavailable();
    await store.withSessionLock(id, ownerId, async lease => {
      const m = await store.read(id, ownerId);
      if (!m || JSON.stringify(m) !== JSON.stringify(initial) || m.worker.state !== "none" || !m.requiresExplicitResume) throw unavailable();
      await claudeCodeCleanHistory(m);
      await lease.update(m.revision, { requiresExplicitResume: false });
    });
  } catch { throw unavailable(); }
}
