import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { managedWorkerProcessExists, type ManagedSessionManifest } from "./managed-sessions.js";

const execute = promisify(execFile);
const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export function processGroupExists(pid: number): boolean {
  try { process.kill(-pid, 0); return true; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw error;
  }
}

/** Never signal a bare persisted PID: it may have been reused by an unrelated process. */
export async function terminateManagedWorker(manifest: ManagedSessionManifest, workerPath: string): Promise<void> {
  const pid = manifest.workerPid;
  if (process.platform === "win32" || !pid) {
    throw new Error("Runtime worker shutdown could not be confirmed; process recovery is unavailable");
  }
  const isolated = manifest.workerProcessGroup === pid;
  if (isolated && !processGroupExists(pid)) return;
  const { stdout } = await execute("ps", ["-ww", "-p", String(pid), "-o", "pgid=", "-o", "args="], { timeout: 2_000 });
  const match = stdout.trim().match(/^(\d+)\s+(.+)$/);
  const command = match?.[2] ?? "";
  const identity = `--runtime-session-id ${manifest.managedSessionId} --runtime-owner-id ${manifest.ownerId}`;
  if ((isolated && Number(match?.[1]) !== pid)
    || (!command.includes(`${identity} `) && !command.endsWith(identity))
    || command.split("--runtime-session-id ").length !== 2 || command.split("--runtime-owner-id ").length !== 2
    || !command.startsWith(`${process.execPath} ${workerPath} --cwd `)
    || (isolated && !command.endsWith(" --isolated-process-group"))) {
    throw new Error("Runtime worker identity could not be verified; no process was signalled");
  }
  if (!isolated) {
    // Older workers share their parent's process group. Signal only the verified
    // worker, never that group; require its observed descendants to exit as well.
    const tree = await execute("ps", ["-axo", "pid=,ppid="], { timeout: 2_000, maxBuffer: 1024 * 1024 });
    const rows = tree.stdout.trim().split("\n").map(line => line.trim().split(/\s+/).map(Number));
    const descendants = new Set([pid]);
    let size = 0;
    while (size !== descendants.size) {
      size = descendants.size;
      for (const [child, parent] of rows) if (child && parent && descendants.has(parent)) descendants.add(child);
    }
    process.kill(pid, "SIGTERM");
    const deadline = Date.now() + 7_000;
    while ([...descendants].some(managedWorkerProcessExists) && Date.now() < deadline) await delay(50);
    if ([...descendants].some(managedWorkerProcessExists)) {
      throw new Error("Legacy Runtime worker shutdown could not be confirmed; no shared process group was signalled");
    }
    return;
  }
  // The lifecycle lock prevents another worker for this managed ID from starting.
  // This group was created solely for the verified worker and its subprocesses.
  for (const signal of ["SIGTERM", "SIGKILL"] as const) {
    try { process.kill(-pid, signal); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
    const deadline = Date.now() + 5_000;
    while (processGroupExists(pid) && Date.now() < deadline) await delay(50);
    if (!processGroupExists(pid)) return;
  }
  throw new Error("Runtime worker process group did not exit; session remains fenced");
}
