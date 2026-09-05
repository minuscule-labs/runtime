import { randomUUID } from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { StringDecoder } from "node:string_decoder";

export type RpcEvent = Record<string, unknown>;

export interface PiRpcProcessOptions {
  systemPromptFile?: string;
  appendSystemPromptFile?: string;
  disableSkillDiscovery?: boolean;
  skillPaths?: string[];
  command?: string;
}

interface PendingRequest {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
}

export class PiRpcProcess {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<string, PendingRequest>();
  private buffer = "";
  private readonly decoder = new StringDecoder("utf8");
  private eventHandler: (event: RpcEvent) => void = () => {};

  constructor(cwd: string, onStderr: (text: string) => void, options: PiRpcProcessOptions = {}) {
    if (options.systemPromptFile !== undefined && options.appendSystemPromptFile !== undefined) {
      throw new Error("systemPromptFile and appendSystemPromptFile cannot both be set");
    }
    const args = ["--approve", "--mode", "rpc", "--no-extensions"];
    if (options.systemPromptFile !== undefined) {
      args.push("--system-prompt", options.systemPromptFile);
    }
    if (options.appendSystemPromptFile !== undefined) {
      args.push("--append-system-prompt", options.appendSystemPromptFile);
    }
    if (options.disableSkillDiscovery) args.push("--no-skills");
    for (const skillPath of options.skillPaths ?? []) args.push("--skill", skillPath);
    this.child = spawn(options.command ?? process.env.PI_COMMAND ?? "pi", args, {
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env: process.env,
    });
    this.child.stdout.on("data", (chunk: Buffer) => this.consume(chunk));
    this.child.stdin.on("error", (error) => this.failAll(error));
    this.child.stderr.on("data", (chunk: Buffer) => onStderr(chunk.toString("utf8")));
    this.child.on("error", (error) => this.failAll(error));
    this.child.on("exit", (code, signal) =>
      this.failAll(new Error(`Pi RPC exited (${signal ?? code ?? "unknown"})`)),
    );
  }

  onEvent(handler: (event: RpcEvent) => void): void {
    this.eventHandler = handler;
  }

  onExit(handler: (code: number | null, signal: NodeJS.Signals | null) => void): void {
    this.child.once("exit", handler);
  }

  async request(type: string, fields: Record<string, unknown> = {}, timeoutMs = 15_000): Promise<unknown> {
    const id = randomUUID();
    const result = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Pi RPC ${type} timed out`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
    });
    this.child.stdin.write(`${JSON.stringify({ id, type, ...fields })}\n`);
    return result;
  }

  async stop(): Promise<void> {
    if (this.child.exitCode !== null || this.child.signalCode !== null) return;
    this.child.kill("SIGTERM");
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        this.child.kill("SIGKILL");
        resolve();
      }, 5_000);
      this.child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  private consume(chunk: Buffer): void {
    this.buffer += this.decoder.write(chunk);
    while (true) {
      const newline = this.buffer.indexOf("\n");
      if (newline < 0) return;
      let line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      if (!line) continue;
      try {
        this.handle(JSON.parse(line) as RpcEvent);
      } catch (error) {
        this.eventHandler({ type: "rpc_parse_error", error: String(error), line });
      }
    }
  }

  private handle(event: RpcEvent): void {
    if (event.type === "response" && typeof event.id === "string") {
      const request = this.pending.get(event.id);
      if (!request) return;
      this.pending.delete(event.id);
      clearTimeout(request.timer);
      if (event.success === false) request.reject(new Error(String(event.error ?? "Pi RPC request failed")));
      else request.resolve(event.data);
      return;
    }
    this.eventHandler(event);
  }

  private failAll(error: Error): void {
    for (const request of this.pending.values()) {
      clearTimeout(request.timer);
      request.reject(error);
    }
    this.pending.clear();
  }
}
