import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { dirname } from "node:path";

export class ClaudeCodeLifecycleBusyError extends Error {}

// POSIX record locks can be dropped when *any* descriptor for that inode is
// closed by this process. Serialize locally before touching the lock file at all.
const localLocks = new Map<string, Promise<void>>();

async function waitForLocalLock(previous: Promise<void>, deadline: number): Promise<void> {
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new ClaudeCodeLifecycleBusyError("ClaudeCode lifecycle operation is already in progress");
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new ClaudeCodeLifecycleBusyError("ClaudeCode lifecycle operation is already in progress")), remaining);
    void previous.then(() => { clearTimeout(timer); resolve(); });
  });
}

/** Internal lock files are permanent identities: never unlink/recreate a live lock.
 * SQLite's OS locks are released on process death; no PID-based stale-lock deletion.
 */
export async function withClaudeCodeLifecycleLock<T>(path: string, operation: () => Promise<T>, timeoutMs = 5_000): Promise<T> {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new Error("Invalid ClaudeCode lifecycle lock deadline");
  const deadline = Date.now() + timeoutMs;
  // Store roots/owner directories are verified canonical before this call, but
  // supported session IDs contain ASCII case variants. They may address one
  // inode on case-insensitive filesystems. Fold only the queue key, never the
  // filesystem path or exact identity; conservative contention on case-sensitive
  // filesystems is preferable to closing a live holder's lock inode.
  const queueKey = path.toLowerCase();
  const previous = localLocks.get(queueKey) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const queued = previous.then(() => gate);
  localLocks.set(queueKey, queued);
  try {
    await waitForLocalLock(previous, deadline);
    return await withFileLock(path, operation, deadline);
  } finally {
    release();
    // A timed-out waiter still chains behind the active holder. Removing its
    // queue entry now could let a new local caller bypass that holder.
    void queued.then(() => { if (localLocks.get(queueKey) === queued) localLocks.delete(queueKey); });
  }
}

async function withFileLock<T>(path: string, operation: () => Promise<T>, deadline: number): Promise<T> {
  const { DatabaseSync } = await import("node:sqlite");
  let created = false;
  try {
    const file = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { await file.sync(); } finally { await file.close(); }
    created = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  let database: InstanceType<typeof DatabaseSync> | undefined;
  try {
    const metadata = await file.stat();
    if (!metadata.isFile() || metadata.nlink !== 1 || (metadata.mode & 0o077)
      || (process.getuid && metadata.uid !== process.getuid())) throw new Error("ClaudeCode lifecycle lock must be a private regular file");
    if (created) {
      const directory = await open(dirname(path), "r");
      try { await directory.sync(); } finally { await directory.close(); }
    }
    database = new DatabaseSync(path);
    // No persistent SQL data or sidecar journal is needed for a mutex.
    database.exec("PRAGMA busy_timeout = 0; PRAGMA journal_mode = MEMORY");
    while (true) {
      if (Date.now() >= deadline) throw new ClaudeCodeLifecycleBusyError("ClaudeCode lifecycle operation is already in progress");
      try { database.exec("BEGIN IMMEDIATE"); break; }
      catch (error) {
        const code = (error as { errcode?: number }).errcode;
        if (typeof code !== "number" || (code & 0xff) !== 5) throw error;
        if (Date.now() >= deadline) throw new ClaudeCodeLifecycleBusyError("ClaudeCode lifecycle operation is already in progress");
        await new Promise(resolve => setTimeout(resolve, Math.min(25, Math.max(1, deadline - Date.now()))));
      }
    }
    try { return await operation(); }
    finally { database.exec("ROLLBACK"); }
  } finally { database?.close(); await file.close(); }
}
