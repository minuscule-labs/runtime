import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { bootChanged, processGroupAbsent, terminateVerifiedGroup } from "@minu/runtime-core";
import { CodexManagedStore, type CodexWorkerAbsenceProof } from "./managed-store.js";
import { CodexWorkerClient } from "./worker-client.js";

const unavailable = () => new Error("Codex managed recovery unavailable");
export interface CodexRecoveryTimeouts { requestMs: number; graceMs: number; termMs: number; killMs: number }
/** Fits inside Channels' 90 s forceStopManaged budget: 2 s request, 7 s graceful absence, 5 s TERM + 5 s KILL. */
export const CODEX_RECOVERY_TIMEOUTS: CodexRecoveryTimeouts = { requestMs: 2_000, graceMs: 7_000, termMs: 5_000, killMs: 5_000 };
const ENTRY = fileURLToPath(new URL("./owned-worker.js", import.meta.url));

/** Explicit recovery. Fence FIRST, one best-effort admission-bypassing stop, then ABSENCE PROOF (reboot or own-group
 * ESRCH) or marker-verified group termination; never clear on uncertainty. Succeeds whatever the dispatch/history
 * state: resume validates that separately. A retired worker already exited (proven at retirement) and keeps its
 * resumable, unfenced record. `remove` is destroy: once the slot is none the Runtime metadata goes too. */
export async function recoverCodexWorker(store: CodexManagedStore, id: string, ownerId: string,
  options: { remove?: boolean; timeouts?: Partial<CodexRecoveryTimeouts> } = {}): Promise<"missing" | "stopped" | "removed"> {
  const timeouts = { ...CODEX_RECOVERY_TIMEOUTS, ...options.timeouts };
  try {
    return await store.withSessionLock(id, ownerId, async lease => {
      let m = await store.read(id, ownerId);
      if (!m) return "missing";
      if (m.worker.state === "retired") return options.remove ? (await lease.removeStoppedSession(m.revision), "removed" as const) : "stopped";
      if (!m.requiresExplicitResume && !(options.remove && m.worker.state === "none")) m = await lease.update(m.revision, { requiresExplicitResume: true });
      const worker = m.worker;
      if (worker.state !== "none") {
        const connection = "connection" in worker ? worker.connection : undefined;
        // Legacy darwin v5 records predate bootIdentity but carry the boot session of their process domain.
        const boot = worker.bootIdentity ?? (m.version === 5 && m.processDomain ? `darwin:${m.processDomain.worker.bootSessionUuid}` : undefined);
        const group = worker.pgid;
        const absent = async (): Promise<CodexWorkerAbsenceProof | undefined> => {
          if (await bootChanged(boot)) return "boot";
          if (group && processGroupAbsent(group) === "absent") return "group";
          return undefined;
        };
        let proof = await absent();
        if (!proof && connection) {
          // Only an authenticated live endpoint can be asked; a dead/corrupt one falls through to proof.
          try { await new CodexWorkerClient(connection).forceStop(timeouts.requestMs); } catch { /* Best effort, never retried. */ }
          const end = Date.now() + timeouts.graceMs;
          while (!(proof = await absent()) && Date.now() < end) await delay(50);
        }
        if (!proof) {
          // Signals need the exact markers AND a recorded own group; legacy/unmarked workers stay fenced.
          if (!worker.marked || !group) throw unavailable();
          await terminateVerifiedGroup({ pgid: group, entryPath: ENTRY, markers: { session: id, owner: ownerId, generation: worker.generation },
            termMs: timeouts.termMs, killMs: timeouts.killMs });
          proof = "group";
        }
        m = await lease.clearWorkerAfterProvenAbsence(m.revision, m.generation, worker.claimId, proof);
      }
      if (options.remove) { await lease.removeStoppedSession(m.revision); return "removed"; }
      return "stopped";
    });
  } catch { throw unavailable(); }
}
