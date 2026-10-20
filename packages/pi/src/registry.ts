import { mkdir, readFile, readdir, rename, rm, writeFile, lstat, open } from "node:fs/promises";
import { constants } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

export interface PiSessionRegistration {
  /** Public Runtime address; managed sessions use their stable managed id. */
  sessionId: string;
  /** Present only for owner-scoped managed sessions. */
  ownerId?: string;
  endpoint: string;
  token: string;
  pid: number;
  cwd: string;
  sessionFile?: string;
  ownership?: "owned" | "attached";
  logFile?: string;
  updatedAt: string;
}

export function registryDirectory(): string {
  return process.env.MINU_RUNTIME_DIR ?? join(homedir(), ".minu", "runtime-pi", "sessions");
}

const SESSION_ID_PATTERN = /^[a-zA-Z0-9_-]+$/;

function registrationPath(sessionId: string): string {
  if (!SESSION_ID_PATTERN.test(sessionId)) throw new Error(`Invalid session id: ${sessionId}`);
  return join(registryDirectory(), `${sessionId}.json`);
}

export async function writeRegistration(registration: PiSessionRegistration): Promise<void> {
  const directory = registryDirectory();
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const destination = registrationPath(registration.sessionId);
  const temporary = `${destination}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(registration, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, destination);
}

export async function removeRegistration(sessionId: string): Promise<void> {
  await rm(registrationPath(sessionId), { force: true });
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export async function readRegistration(sessionId: string): Promise<PiSessionRegistration | undefined> {
  try {
    const parsed = JSON.parse(await readFile(registrationPath(sessionId), "utf8")) as PiSessionRegistration;
    if (parsed.sessionId !== sessionId || !processExists(parsed.pid)) {
      await removeRegistration(sessionId);
      return undefined;
    }
    return parsed;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

/** A bounded, owner-private peek. Unlike readRegistration, never cleans up or migrates anything. */
export async function inspectRegistration(sessionId: string): Promise<Pick<PiSessionRegistration, "sessionId" | "ownerId" | "endpoint" | "token" | "pid" | "ownership"> | undefined> {
  const directory = registryDirectory();
  if (!process.getuid || !constants.O_NOFOLLOW || !isAbsolute(directory) || directory.length > 4096) return undefined;
  let handle;
  try {
    const dir = await lstat(directory);
    if (!dir.isDirectory() || dir.isSymbolicLink() || dir.uid !== process.getuid() || (dir.mode & 0o077)) return undefined;
    handle = await open(registrationPath(sessionId), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid() || (stat.mode & 0o077) || stat.size > 32 * 1024) return undefined;
    const buffer = Buffer.alloc(32 * 1024 + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > 32 * 1024) return undefined;
    const raw = JSON.parse(buffer.toString("utf8", 0, bytesRead));
    if (raw.sessionId !== sessionId || raw.ownership !== "owned" || typeof raw.ownerId !== "string"
      || !Number.isSafeInteger(raw.pid) || raw.pid < 1 || !processExists(raw.pid)
      || typeof raw.token !== "string" || !/^[a-zA-Z0-9_-]{1,512}$/.test(raw.token)) return undefined;
    const endpoint = new URL(raw.endpoint);
    if (endpoint.protocol !== "http:" || !["127.0.0.1", "[::1]"].includes(endpoint.hostname)
      || endpoint.username || endpoint.password || endpoint.pathname !== "/" || endpoint.search || endpoint.hash) return undefined;
    return { sessionId, ownerId: raw.ownerId, ownership: "owned", endpoint: endpoint.origin, token: raw.token, pid: raw.pid };
  } catch { return undefined; }
  finally { await handle?.close(); }
}

export async function listRegistrations(): Promise<PiSessionRegistration[]> {
  let names: string[];
  try {
    names = await readdir(registryDirectory());
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }

  const registrationNames = names.filter((name) => {
    if (!name.endsWith(".json")) return false;
    return SESSION_ID_PATTERN.test(name.slice(0, -5));
  });
  const registrations = await Promise.all(registrationNames.map(async (name) => {
    const sessionId = name.slice(0, -5);
    try {
      return await readRegistration(sessionId);
    } catch {
      // One interrupted/corrupt registration must not hide healthy sessions.
      await removeRegistration(sessionId).catch(() => {});
      return undefined;
    }
  }));
  return registrations.filter((item): item is PiSessionRegistration => item !== undefined);
}
