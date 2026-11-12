import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { lstat, mkdir, open, realpath, rename, rm } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { sessionEvents, sessionProfile, type RuntimeSessionEvents, type RuntimeSessionProfile } from "@minu/runtime-core";

const OPENER = "/usr/bin/open", APP = "/System/Applications/TextEdit.app";
const LIMIT = 64 * 1024;
async function trustedExecutable(file: string): Promise<void> {
  for (let path = file; ; path = dirname(path)) {
    const stat = await lstat(path);
    if (stat.isSymbolicLink() || stat.uid !== 0 || (stat.mode & 0o022) || await realpath(path) !== path
      || (path === file ? !stat.isFile() || !(stat.mode & 0o111) : !stat.isDirectory())) throw new Error("Viewer unavailable");
    if (dirname(path) === path) return;
  }
}
export async function diagnosticAvailable(): Promise<boolean> {
  if (process.platform !== "darwin" || process.env.SSH_CONNECTION || process.env.SSH_TTY) return false;
  try { await trustedExecutable(OPENER); await trustedExecutable(`${APP}/Contents/MacOS/TextEdit`); return true; }
  catch { return false; }
}
async function privateDirectory(path: string): Promise<void> {
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) || (process.getuid && stat.uid !== process.getuid())
    || await realpath(path) !== path) throw new Error("Diagnostic unavailable");
}
async function privateFile(path: string): Promise<Awaited<ReturnType<typeof open>>> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o077) || stat.size > LIMIT
      || (process.getuid && stat.uid !== process.getuid())) throw new Error("Diagnostic unavailable");
    return file;
  } catch (error) { await file.close(); throw error; }
}
/** Explicit local action only. Fixed system viewer, never a shell or caller-supplied executable. */
async function launch(file: string): Promise<void> {
  if (!await diagnosticAvailable()) throw new Error("Viewer unavailable");
  const child = spawn(OPENER, ["-a", APP, "--", file], { stdio: "ignore", shell: false,
    env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", ...(process.env.HOME ? { HOME: process.env.HOME } : {}) } });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("Viewer unavailable")); }, 2000);
    child.once("error", () => { clearTimeout(timer); reject(new Error("Viewer unavailable")); });
    child.once("exit", code => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error("Viewer unavailable")); });
  });
}
/** Only projected DTOs are written. Separate from .session directories/resume metadata. */
export async function openCodexDiagnostic(root: string, id: string, ownerId: string,
  profile: RuntimeSessionProfile, events: RuntimeSessionEvents, authorize: () => Promise<void>): Promise<void> {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(id) || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(ownerId)) throw new Error("Diagnostic unavailable");
  if (!await diagnosticAvailable()) throw new Error("Viewer unavailable");
  const owner = join(root, createHash("sha256").update(ownerId).digest("hex")), directory = join(owner, ".diagnostics");
  await privateDirectory(root); await privateDirectory(owner);
  await mkdir(directory, { mode: 0o700 }).catch(error => { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; });
  await privateDirectory(directory);
  const file = join(directory, `${id}.json`), temporary = join(directory, `.snapshot-${randomUUID()}`);
  try { const previous = await privateFile(file); await previous.close(); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const data = JSON.stringify({ version: 1, capturedAt: new Date().toISOString(), profile: sessionProfile(profile), events: sessionEvents(events) });
  if (Buffer.byteLength(data) > LIMIT) throw new Error("Diagnostic unavailable");
  await authorize();
  try {
    const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { await handle.writeFile(data); await handle.sync(); } finally { await handle.close(); }
    await rename(temporary, file);
    const dir = await open(directory, constants.O_RDONLY); try { await dir.sync(); } finally { await dir.close(); }
    const pinned = await privateFile(file);
    try { await authorize(); await launch(file); } finally { await pinned.close(); }
  } finally { await rm(temporary, { force: true }); }
}
