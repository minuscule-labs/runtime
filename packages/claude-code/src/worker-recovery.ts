import { setTimeout as delay } from "node:timers/promises";
import { bootChanged, processGroupAbsent, terminateVerifiedGroup } from "@minu/runtime-core";
import { ClaudeCodeManagedStore, type ClaudeCodeManagedManifest, type ClaudeCodeWorkerAbsenceProof } from "./managed-store.js";
import { ClaudeCodeWorkerClient } from "./worker-client.js";

const unavailable = () => new Error("Claude Code managed recovery unavailable");
export interface ClaudeCodeRecoveryTimeouts { requestMs: number; graceMs: number; termMs: number; killMs: number }
/** Fits inside Channels' 90 s forceStopManaged budget: 2 s request, 7 s graceful absence, 5 s TERM + 5 s KILL. */
export const CLAUDE_CODE_RECOVERY_TIMEOUTS: ClaudeCodeRecoveryTimeouts = { requestMs: 2_000, graceMs: 7_000, termMs: 5_000, killMs: 5_000 };

/** Recorded process facts for any occupied slot. Reserved never forked (fork follows the committed `starting`). */
function recorded(worker: ClaudeCodeManagedManifest["worker"]) {
  if (worker.state === "none") return undefined;
  const process = worker.state === "live" ? worker.registration : worker.state === "starting" ? worker.process : null;
  return { group: process?.processGroupId ?? null, unstarted: worker.state === "reserved" };
}

/** Explicit recovery. Fence FIRST, one best-effort admission-bypassing stop, then ABSENCE PROOF (reboot or own
 * group ESRCH) or marker-verified group termination; never clear on uncertainty. Succeeds regardless of dispatch
 * or history state: resume validates those separately, and only after absence. `remove` is destroy: after the slot
 * is `none` the Runtime resume metadata goes too (native history stays). Holds the session lock throughout. */
export async function recoverClaudeCodeWorker(store: ClaudeCodeManagedStore, id: string, ownerId: string,
  options: { remove?: boolean; timeouts?: Partial<ClaudeCodeRecoveryTimeouts> } = {}): Promise<"missing" | "stopped" | "removed"> {
  const timeouts = { ...CLAUDE_CODE_RECOVERY_TIMEOUTS, ...options.timeouts };
  try {
    return await store.withSessionLock(id, ownerId, async lease => {
      let m = await store.read(id, ownerId);
      if (!m) return "missing";
      // A never-started/stopped slot needs no fence for destroy; every occupied slot is fenced before any stop attempt.
      if (!m.requiresExplicitResume && !(options.remove && m.worker.state === "none")) {
        m = await lease.update(m.revision, { requiresExplicitResume: true });
      }
      const worker = m.worker;
      if (worker.state !== "none") {
        const facts = recorded(worker)!;
        let proof: ClaudeCodeWorkerAbsenceProof | undefined = facts.unstarted ? "unstarted" : undefined;
        const absent = async (): Promise<ClaudeCodeWorkerAbsenceProof | undefined> => {
          if (await bootChanged(worker.bootIdentity)) return "boot";
          if (facts.group && processGroupAbsent(facts.group) === "absent") return "group";
          return undefined;
        };
        proof ??= await absent();
        if (!proof && worker.state === "live") {
          // Only an authenticated live endpoint can be asked; a corrupt/dead one just falls through to proof.
          try { await new ClaudeCodeWorkerClient(worker.registration, timeouts.requestMs).requestForceStop(AbortSignal.timeout(timeouts.requestMs)); }
          catch { /* Best effort, never retried and never a dependency. */ }
          const end = Date.now() + timeouts.graceMs;
          while (!(proof = await absent()) && Date.now() < end) await delay(50);
        }
        if (!proof) {
          // Signals need the exact markers AND a recorded own group; legacy/unmarked workers stay fenced.
          if (!worker.marked || !facts.group) throw unavailable();
          await terminateVerifiedGroup({ pgid: facts.group, entryPath: worker.workerExecutable,
            markers: { session: id, owner: ownerId, generation: worker.generation }, termMs: timeouts.termMs, killMs: timeouts.killMs });
          proof = "group";
        }
        m = await lease.forceClearWorker(m.revision, m.generation, worker.reservationId, proof);
      }
      if (options.remove) { await lease.removeSession(m.revision); return "removed"; }
      return "stopped";
    });
  } catch (error) {
    if (process.env.MINU_RECOVERY_DIAGNOSTIC === "1") console.error("RECOVERY_FAILURE_DIAGNOSTIC", error);
    throw unavailable();
  }
}
