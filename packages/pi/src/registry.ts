import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export interface PiSessionRegistration {
  sessionId: string;
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

function registrationPath(sessionId: string): string {
  if (!/^[a-zA-Z0-9_-]+$/.test(sessionId)) throw new Error(`Invalid session id: ${sessionId}`);
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

export async function listRegistrations(): Promise<PiSessionRegistration[]> {
  let names: string[];
  try {
    names = await readdir(registryDirectory());
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }

  const registrations = await Promise.all(
    names.filter((name) => name.endsWith(".json")).map((name) => readRegistration(name.slice(0, -5))),
  );
  return registrations.filter((item): item is PiSessionRegistration => item !== undefined);
}
