import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, appendFile, chmod, mkdir, open, rename, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export const DEFAULT_DIAGNOSTIC_LOG_LIMIT_BYTES = 1024 * 1024;

export async function resolveLocalDiagnosticOpener(
  platform = process.platform,
): Promise<string | undefined> {
  const candidates = platform === "darwin"
    ? ["/usr/bin/open"]
    : platform === "linux"
      ? ["/usr/bin/xdg-open", "/bin/xdg-open"]
      : [];
  for (const candidate of candidates) {
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {}
  }
  return undefined;
}

export async function openLocalDiagnosticFile(filePath: string, opener: string): Promise<void> {
  const metadata = await stat(filePath);
  if (!metadata.isFile()) throw new Error("Runtime diagnostic is not a regular file");
  const child = spawn(opener, [filePath], { detached: true, stdio: "ignore" });
  await new Promise<void>((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", reject);
  });
  child.unref();
}

export class BoundedDiagnosticLog {
  private pending = Promise.resolve();

  constructor(
    private readonly filePath: string,
    private readonly limitBytes = DEFAULT_DIAGNOSTIC_LOG_LIMIT_BYTES,
  ) {
    if (!Number.isSafeInteger(limitBytes) || limitBytes < 1) {
      throw new RangeError("Diagnostic log limit must be a positive integer");
    }
  }

  append(text: string): Promise<void> {
    const operation = this.pending.catch(() => {}).then(() => this.appendNow(text));
    this.pending = operation;
    return operation;
  }

  private async appendNow(text: string): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true, mode: 0o700 });
    const incoming = Buffer.from(text);
    let existingSize = 0;
    try {
      existingSize = (await stat(this.filePath)).size;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (existingSize + incoming.length <= this.limitBytes) {
      await appendFile(this.filePath, incoming, { mode: 0o600 });
      await chmod(this.filePath, 0o600);
      return;
    }

    const incomingTail = incoming.subarray(Math.max(0, incoming.length - this.limitBytes));
    const rollingTarget = Math.floor(this.limitBytes / 2);
    const retainedLimit = Math.max(0, rollingTarget - incomingTail.length);
    let existingTail = Buffer.alloc(0);
    const bytesToRead = Math.min(existingSize, retainedLimit);
    if (bytesToRead > 0) {
      const handle = await open(this.filePath, "r");
      try {
        existingTail = Buffer.alloc(bytesToRead);
        const { bytesRead } = await handle.read(
          existingTail,
          0,
          bytesToRead,
          existingSize - bytesToRead,
        );
        existingTail = existingTail.subarray(0, bytesRead);
      } finally {
        await handle.close();
      }
    }
    const temporary = `${this.filePath}.${process.pid}.tmp`;
    await writeFile(temporary, Buffer.concat([existingTail, incomingTail]), { mode: 0o600 });
    await rename(temporary, this.filePath);
    await chmod(this.filePath, 0o600);
  }
}
