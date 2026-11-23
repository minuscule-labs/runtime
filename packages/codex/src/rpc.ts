import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { StringDecoder } from "node:string_decoder";

import { RUNTIME_INPUT_LIMITS } from "@minu/runtime-core";
import { CodexNotInstalledError } from "./errors.js";
const MAX_FRAME_BYTES = RUNTIME_INPUT_LIMITS.transportBytes;

/** Marks a rejected native request without retaining private native diagnostics. */
export class CodexRpcResponseError extends Error {}

export interface CodexRpcOptions {
  command?: string;
  /** Arguments before the standard app-server arguments; useful for executable wrappers. */
  args?: string[];
  requestTimeoutMs?: number;
  shutdownTimeoutMs?: number;
}

export interface CodexNotification {
  method: string;
  params: Record<string, unknown>;
}

interface PendingRequest {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
}

export function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

/** One dedicated app-server, never a connection to the shared Codex daemon. */
export class CodexRpcProcess {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<string, PendingRequest>();
  private readonly decoder = new StringDecoder("utf8");
  private readonly buffered: string[] = [];
  private bufferedBytes = 0;
  private failure?: Error;
  private stopPromise?: Promise<void>;
  private exited = false;
  private resolveExit!: () => void;
  private readonly exitPromise = new Promise<void>((resolve) => { this.resolveExit = resolve; });
  private readonly requestTimeoutMs: number;
  private readonly shutdownTimeoutMs: number;
  onNotification: (event: CodexNotification) => void = () => {};
  onFailure: (error: Error) => void = () => {};

  constructor(cwd: string, options: CodexRpcOptions = {}) {
    this.requestTimeoutMs = options.requestTimeoutMs ?? 15_000;
    this.shutdownTimeoutMs = options.shutdownTimeoutMs ?? 5_000;
    for (const value of [this.requestTimeoutMs, this.shutdownTimeoutMs]) {
      if (!Number.isSafeInteger(value) || value < 1) throw new RangeError("Codex deadlines must be positive integers");
    }
    this.child = spawn(options.command ?? "codex", [...options.args ?? [], "app-server", "--listen", "stdio://"], {
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env: process.env,
    });
    // Drain diagnostics without retaining or publishing credentials, paths or raw output.
    this.child.stderr.resume();
    this.child.stdout.on("data", (chunk: Buffer) => this.consume(chunk));
    this.child.stdin.on("error", () => this.abort(new Error("Codex app-server input closed")));
    this.child.stdout.on("error", () => this.abort(new Error("Codex app-server output failed")));
    this.child.on("error", (error: NodeJS.ErrnoException) => {
      if (!this.child.pid) this.markExited();
      this.abort(error.code === "ENOENT" ? new CodexNotInstalledError() : new Error("Unable to launch Codex app-server"));
    });
    this.child.once("exit", () => {
      this.markExited();
      this.abort(new Error("Codex app-server exited"));
    });
  }

  async initialize(): Promise<void> {
    await this.request("initialize", {
      clientInfo: { name: "minu_runtime", title: "MinuRuntime", version: "0.0.1" },
      capabilities: { experimentalApi: false, requestAttestation: false },
    });
    this.notify("initialized");
  }

  request(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    if (this.failure || this.stopPromise) return Promise.reject(this.failure ?? new Error("Codex app-server is stopping"));
    const id = randomUUID();
    const result = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        // The outcome is uncertain: do not leave a worker accepting new work after a deadline.
        this.abort(new Error(`Codex ${method} timed out; session stopped`));
      }, this.requestTimeoutMs);
      this.pending.set(id, { resolve, reject, timer });
    });
    this.write({ id, method, params });
    return result;
  }

  notify(method: string): void {
    if (this.failure || this.stopPromise) throw this.failure ?? new Error("Codex app-server is stopping");
    this.write({ method });
  }

  abort(error: Error): void {
    if (!this.failure) {
      this.failure = error;
      this.buffered.length = 0; this.bufferedBytes = 0;
      this.failPending(error);
      this.onFailure(error);
    }
    void this.stop().catch(() => {});
  }

  stop(): Promise<void> {
    this.stopPromise ??= this.shutdown();
    return this.stopPromise;
  }

  private async shutdown(): Promise<void> {
    this.failPending(new Error("Codex app-server stopped"));
    if (this.exited) return;
    this.child.kill("SIGTERM");
    if (await this.waitForExit()) return;
    this.child.kill("SIGKILL");
    if (!await this.waitForExit()) throw new Error("Codex app-server exit could not be confirmed");
  }

  private waitForExit(): Promise<boolean> {
    if (this.exited) return Promise.resolve(true);
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), this.shutdownTimeoutMs);
      void this.exitPromise.then(() => { clearTimeout(timer); resolve(true); });
    });
  }

  private markExited(): void {
    this.exited = true;
    this.resolveExit();
  }

  private write(frame: unknown): void {
    try {
      this.child.stdin.write(`${JSON.stringify(frame)}\n`, (error) => {
        if (error) this.abort(new Error("Codex app-server input failed"));
      });
    } catch {
      this.abort(new Error("Codex app-server input failed"));
    }
  }

  private consume(chunk: Buffer): void {
    if (this.failure) return;
    const decoded = this.decoder.write(chunk);
    let start = 0;
    while (!this.failure && start < decoded.length) {
      const newline = decoded.indexOf("\n", start);
      const part = decoded.slice(start, newline < 0 ? undefined : newline);
      this.bufferedBytes += Buffer.byteLength(part);
      if (this.bufferedBytes > MAX_FRAME_BYTES) {
        this.abort(new Error("Codex protocol frame exceeds limit")); return;
      }
      if (newline < 0) { if (part) this.buffered.push(part); return; }
      // Join only a complete frame: rescanning/flattening the growing prefix on
      // every pipe chunk becomes quadratic at valid image transport sizes.
      const line = this.buffered.length ? this.buffered.join("") + part : part;
      this.buffered.length = 0; this.bufferedBytes = 0;
      start = newline + 1;
      if (!line.trim()) continue;
      try {
        const frame = record(JSON.parse(line));
        if (!frame) throw new Error("Invalid frame");
        this.handle(frame);
      } catch {
        this.abort(new Error("Invalid Codex protocol frame"));
      }
    }
  }

  private handle(frame: Record<string, unknown>): void {
    if (typeof frame.method === "string") {
      if (frame.id !== undefined) {
        // There is no approval/user-input surface in Runtime yet. An error response
        // plus process shutdown refuses even unknown future interactive methods.
        this.write({ id: frame.id, error: { code: -32601, message: "Interactive requests are unsupported by MinuRuntime" } });
        this.abort(new Error("Codex requested an unsupported interactive operation; session stopped"));
        return;
      }
      this.onNotification({ method: frame.method, params: record(frame.params) ?? {} });
      return;
    }
    if (typeof frame.id !== "string") return;
    const request = this.pending.get(frame.id);
    if (!request) return;
    this.pending.delete(frame.id);
    clearTimeout(request.timer);
    if (frame.error !== undefined) {
      // A control/read failure can include earlier image inputs or credentials,
      // not only the current request. Never retain/publish native error payloads.
      request.reject(new CodexRpcResponseError("Codex native request failed"));
    } else if (Object.hasOwn(frame, "result")) request.resolve(frame.result);
    else {
      request.reject(new Error("Invalid Codex response"));
      this.abort(new Error("Invalid Codex response"));
    }
  }

  private failPending(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
}
