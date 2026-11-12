import { execFile } from "node:child_process";
import { lstat, realpath } from "node:fs/promises";

/** Private OS observations only. No deployment, namespace or exit attestation.
 * IOPlatformUUID: IOPlatformExpertDevice's OSString platform UUID (IOKitKeys.h).
 * kern.bootsessionuuid: XNU's read-only bootsessionuuid_string sysctl, NOT
 * kern.uuid (the kernel image UUID), a hostname or installation identifier.
 * Successful reads do not establish unsandboxed/host-local/uncloned conditions.
 */
export interface DarwinProcessDomainObservation {
  ioPlatformUuid: string;
  bootSessionUuid: string;
}

const IOREG = "/usr/sbin/ioreg";
const SYSCTL = "/usr/sbin/sysctl";
const REGISTRY_LIMIT = 64 * 1024;
const BOOT_LIMIT = 128;
const QUERY_TIMEOUT_MS = 2_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function uuid(value: string): string | undefined {
  if (!UUID.test(value) || /^(?:0|-)+$/.test(value) || /^(?:f|-)+$/i.test(value)) return undefined;
  return value.toLowerCase();
}

/** Minimal parser for exactly the fixed commands below; raw diagnostics stay private. */
export function parseDarwinProcessDomainObservation(registry: Uint8Array, boot: Uint8Array): DarwinProcessDomainObservation | undefined {
  try {
    if (registry.byteLength > REGISTRY_LIMIT || boot.byteLength > BOOT_LIMIT) return undefined;
    const decoder = new TextDecoder("utf-8", { fatal: true });
    const lines = decoder.decode(registry).replace(/[ \t\n]+$/, "").split("\n");
    if (lines.length < 4 || !/^\+-o [^\r\n]+ +<class IOPlatformExpertDevice, [^<>\r\n]+>$/.test(lines[0])
      || lines[1] !== "    {" || lines.at(-1) !== "    }") return undefined;
    let platform: string | undefined;
    for (const line of lines.slice(2, -1)) {
      if (!/^ {6}"[^"\r\n]+" = [^\r\n]+$/.test(line)) return undefined;
      if (!line.startsWith('      "IOPlatformUUID" = ')) continue;
      if (platform !== undefined) return undefined;
      const match = /^ {6}"IOPlatformUUID" = "([^"]+)"$/.exec(line);
      platform = match ? uuid(match[1]) : undefined;
      if (!platform) return undefined;
    }
    const bootText = decoder.decode(boot).replace(/\n$/, "");
    const session = uuid(bootText);
    return platform && session ? { ioPlatformUuid: platform, bootSessionUuid: session } : undefined;
  } catch { return undefined; }
}

async function trustedPath(path: string, directory: boolean): Promise<void> {
  const info = await lstat(path);
  if (info.isSymbolicLink() || info.uid !== 0 || (info.mode & 0o022)
    || (directory ? !info.isDirectory() : !info.isFile() || !(info.mode & 0o111))
    || await realpath(path) !== path) throw new Error("Darwin OS source unavailable");
}

function readSource(file: string, args: string[], maxBuffer: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    execFile(file, args, {
      cwd: "/", env: { LANG: "C", LC_ALL: "C" }, encoding: "buffer", shell: false,
      timeout: QUERY_TIMEOUT_MS, maxBuffer,
      // Bounds only the query child owned by execFile, never an observed worker.
      killSignal: "SIGKILL",
    }, (error, stdout, stderr) => {
      if (error || !Buffer.isBuffer(stdout) || !Buffer.isBuffer(stderr) || stderr.length || stdout.length > maxBuffer) {
        reject(new Error("Darwin OS source unavailable"));
      } else resolve(stdout);
    });
  });
}

/** Unwired collector. Undefined means unsupported/unavailable, with no fallback. */
export async function collectDarwinProcessDomainObservation(): Promise<DarwinProcessDomainObservation | undefined> {
  if (process.platform !== "darwin") return undefined;
  try {
    // Fixed root-owned, non-writable paths; no PATH lookup, shell, inherited
    // DYLD/configuration environment or workspace-relative executable lookup.
    for (const directory of ["/", "/usr", "/usr/sbin"]) await trustedPath(directory, true);
    await Promise.all([trustedPath(IOREG, false), trustedPath(SYSCTL, false)]);
    const [registry, boot] = await Promise.all([
      readSource(IOREG, ["-r", "-d", "1", "-c", "IOPlatformExpertDevice", "-k", "IOPlatformUUID", "-w", "0"], REGISTRY_LIMIT),
      readSource(SYSCTL, ["-n", "kern.bootsessionuuid"], BOOT_LIMIT),
    ]);
    return parseDarwinProcessDomainObservation(registry, boot);
  } catch { return undefined; }
}
