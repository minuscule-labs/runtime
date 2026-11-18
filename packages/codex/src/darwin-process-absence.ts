import { collectDarwinProcessDomainObservation } from "./darwin-process-domain.js";

export type DarwinPidObservation = "pid_absent" | "pid_present" | "unconfirmed";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function validUuid(value: unknown): value is string {
  return typeof value === "string" && UUID.test(value) && !/^(?:0|-)+$/.test(value) && !/^(?:f|-)+$/i.test(value);
}

/** Private PID-slot observation under Runtime's local-host assumption. Matching
 * OS observations do not attest deployment/namespace conditions or worker identity.
 * This is neither authenticated shutdown/exit proof nor signaling/recovery authority.
 */
export async function observeDarwinPidAbsence(pid: unknown, expected: unknown): Promise<DarwinPidObservation> {
  try {
    if (process.platform !== "darwin" || typeof pid !== "number" || !Number.isInteger(pid)
      || pid < 1 || pid > 0x7fffffff || !expected || typeof expected !== "object" || Array.isArray(expected)) return "unconfirmed";
    const keys = Object.keys(expected);
    if (keys.length !== 2 || keys.some(key => key !== "ioPlatformUuid" && key !== "bootSessionUuid")) return "unconfirmed";
    const input = expected as Record<string, unknown>;
    // Snapshot all caller-owned values before the first await. No coercion or
    // previously cached successful collection/query can authorize this query.
    const target = pid;
    const host = input.ioPlatformUuid;
    const boot = input.bootSessionUuid;
    if (!validUuid(host) || !validUuid(boot)) return "unconfirmed";
    const fresh = await collectDarwinProcessDomainObservation();
    if (!fresh || fresh.ioPlatformUuid !== host || fresh.bootSessionUuid !== boot) return "unconfirmed";
    try {
      process.kill(target, 0);
      // An occupied/reused PID says nothing about the original worker's identity.
      return "pid_present";
    } catch (error) {
      return error !== null && typeof error === "object" && "code" in error && error.code === "ESRCH"
        ? "pid_absent" : "unconfirmed";
    }
  } catch { return "unconfirmed"; }
}
