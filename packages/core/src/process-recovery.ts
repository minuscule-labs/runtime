import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";

// spawn, not execFile: bounded stdout from a fixed argv, and independent of any execFile test double.
const execute = (file: string, args: string[], options: { timeout: number; env?: NodeJS.ProcessEnv }) =>
  new Promise<{ stdout: string }>((resolve, reject) => {
    const child = spawn(file, args, { env: options.env ?? process.env, stdio: ["ignore", "pipe", "ignore"] });
    let stdout = "";
    const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("Process query timed out")); }, options.timeout);
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk; if (stdout.length > 64 * 1024) child.kill("SIGKILL"); });
    child.once("error", error => { clearTimeout(timer); reject(error); });
    child.once("close", code => {
      if (process.env.MINU_RECOVERY_DIAGNOSTIC === "1" && file === "ps" && args.includes("args=")) console.error("RECOVERY_PS_DIAGNOSTIC", JSON.stringify({ code, stdout }));
      clearTimeout(timer); code === 0 && stdout.length <= 64 * 1024 ? resolve({ stdout }) : reject(new Error("Process query failed"));
    });
  });
const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
type Kill = (pid: number, signal: NodeJS.Signals | 0) => unknown;

/** Opaque, platform-prefixed boot identity; undefined when it cannot be read (no proof either way). */
export async function readBootIdentity(): Promise<string | undefined> {
  try {
    if (process.platform === "linux") {
      const id = (await readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim();
      return /^[0-9a-f-]{32,36}$/i.test(id) ? `linux:${id.toLowerCase()}` : undefined;
    }
    if (process.platform === "darwin") {
      const { stdout } = await execute("/usr/sbin/sysctl", ["-n", "kern.bootsessionuuid"], { timeout: 2_000, env: { LANG: "C", LC_ALL: "C" } });
      const id = stdout.trim();
      return /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id) ? `darwin:${id.toLowerCase()}` : undefined;
    }
  } catch { /* Unreadable: no proof. */ }
  return undefined;
}

/** True only when both identities are known and differ: a reboot proves earlier processes are gone. */
export async function bootChanged(recorded: string | undefined, current: () => Promise<string | undefined> = readBootIdentity): Promise<boolean> {
  if (!recorded) return false;
  const now = await current();
  return now !== undefined && now !== recorded;
}

const validGroup = (pgid: number) => Number.isSafeInteger(pgid) && pgid > 1;

/** ESRCH proves an own group is gone, EPERM is unproven, and anything else fails closed. Never for a bare PID. */
export function processGroupAbsent(pgid: number, kill: Kill = process.kill): "absent" | "present" | "unproven" {
  if (!validGroup(pgid)) throw new Error("Invalid process group");
  try { kill(-pgid, 0); return "present"; }
  catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return "absent";
    if (code === "EPERM") return "unproven";
    throw error;
  }
}

export interface VerifiedTerminationOptions {
  pgid: number;
  /** Expected worker entry path, as it appears in the command line. */
  entryPath: string;
  markers: { session: string; owner: string; generation: string };
  termMs: number;
  killMs: number;
  kill?: Kill;
  /** Injectable `ps -ww -p <pgid> -o pgid= -o args=` stdout. */
  readProcess?: (pgid: number) => Promise<string>;
}

/** The process group `ps` reports for a live PID, or undefined. Used to verify a fresh fork's own group before recording it. */
export async function readProcessGroup(pid: number): Promise<number | undefined> {
  try {
    const { stdout } = await execute("ps", ["-ww", "-p", String(pid), "-o", "pgid="], { timeout: 2_000 });
    const group = Number(stdout.trim());
    return Number.isSafeInteger(group) && group > 0 ? group : undefined;
  } catch { return undefined; }
}

const readProcessStdout = async (pgid: number) =>
  (await execute("ps", ["-ww", "-p", String(pgid), "-o", "pgid=", "-o", "args="], { timeout: 2_000 })).stdout;

function marked(command: string, flag: string, value: string): boolean {
  const needle = `--minu-runtime-${flag} ${value}`;
  const at = command.indexOf(needle);
  return at > 0 && command[at - 1] === " " && (at + needle.length === command.length || command[at + needle.length] === " ")
    && command.split(`--minu-runtime-${flag} `).length === 2;
}

/** Signals only a group whose leader's command line carries the exact worker identity.
 * Resolves once ESRCH proves the group gone; throws (group state unknown) otherwise. */
export async function terminateVerifiedGroup(options: VerifiedTerminationOptions): Promise<void> {
  const { pgid, entryPath, markers, termMs, killMs } = options;
  const kill = options.kill ?? process.kill;
  if (process.platform === "win32") throw new Error("Process recovery is unavailable");
  const first = processGroupAbsent(pgid, kill);
  if (first === "absent") return;
  if (first === "unproven") throw new Error("Process group could not be inspected; no process was signalled");
  const match = (await (options.readProcess ?? readProcessStdout)(pgid).catch(() => "")).trim().match(/^(\d+)\s+(.+)$/);
  const command = match?.[2] ?? "";
  if (Number(match?.[1]) !== pgid || !command.includes(` ${entryPath} `)
    || !marked(command, "session", markers.session) || !marked(command, "owner", markers.owner)
    || !marked(command, "generation", markers.generation)) {
    throw new Error("Process identity could not be verified; no process was signalled");
  }
  for (const [signal, ms] of [["SIGTERM", termMs], ["SIGKILL", killMs]] as const) {
    try { kill(-pgid, signal); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
    const deadline = Date.now() + ms;
    while (processGroupAbsent(pgid, kill) === "present" && Date.now() < deadline) await delay(25);
    if (processGroupAbsent(pgid, kill) === "absent") return;
  }
  throw new Error("Process group did not exit");
}
