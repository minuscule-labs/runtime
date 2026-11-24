import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { query, type ModelInfo, type SDKUserMessage, type SlashCommand } from "@anthropic-ai/claude-agent-sdk";
import { ClaudeCodeAuthRequiredError, ClaudeCodeNotInstalledError, ClaudeCodeUnsupportedVersionError, claudeCodeAccountStatus, resolveClaudeCodeExecutable } from "./native-config.js";
import { claudeCodeVersionSupported } from "./native-history.js";

export interface ClaudeCodeProbeOptions {
  cwd: string;
  /** Omit for the installed `claude` on PATH, "bundled" for the SDK engine, or an explicit path. */
  executable?: string;
  /** Complete environment for the short-lived process (already inherited + overlaid). */
  env: Record<string, string>;
  /** Restores the isolated (no user/project/local settings, hooks, MCP or plugins) behavior. */
  isolate?: boolean;
  startupTimeoutMs?: number;
  shutdownTimeoutMs?: number;
  signal?: AbortSignal;
}
export interface ClaudeCodeProbe {
  version?: string;
  authenticated: boolean;
  /** Label only (subscription/provider kind); never an account identifier. */
  accountType?: string;
  models: ModelInfo[];
  /** User/project/plugin-defined commands, i.e. skills. Claude Code's own builtin commands are excluded. */
  skills: SlashCommand[];
}
export type { ModelInfo, SlashCommand };

function timeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms); })])
    .finally(() => clearTimeout(timer));
}

/** Short-lived native process that sends NO prompt and never dispatches user input: it only reads the initialize
 * answer (account, models, commands, version) and then closes with CONFIRMED exit of the process it spawned.
 * Persists nothing (no transcript is created). Failure to confirm exit is an error, never a silent leak. */
export async function probeClaudeCode(options: ClaudeCodeProbeOptions): Promise<ClaudeCodeProbe> {
  options.signal?.throwIfAborted();
  const executable = await resolveClaudeCodeExecutable(options.executable, options.env);
  const abort = new AbortController();
  let child: ChildProcess | undefined;
  let missing = false;
  let done!: () => void;
  const gone = new Promise<void>(resolve => { done = resolve; });
  // No user message is ever yielded; the generator only parks until the probe closes.
  async function* idle(): AsyncGenerator<SDKUserMessage> {
    await new Promise<void>(resolve => abort.signal.addEventListener("abort", () => resolve(), { once: true }));
  }
  const cancel = () => abort.abort(options.signal?.reason);
  options.signal?.addEventListener("abort", cancel, { once: true });
  const probe = query({
    prompt: idle(),
    options: {
      cwd: options.cwd, abortController: abort, env: { ...options.env, MINU_RUNTIME_PROBE: "1" }, pathToClaudeCodeExecutable: executable,
      tools: [], persistSession: false, permissionMode: "default",
      settingSources: options.isolate ? [] : ["user", "project", "local"],
      ...(options.isolate ? { settings: { disableAllHooks: true }, strictMcpConfig: true, mcpServers: {}, plugins: [] } : {}),
      spawnClaudeCodeProcess: spawnOptions => {
        const spawned = spawn(spawnOptions.command, spawnOptions.args, {
          cwd: spawnOptions.cwd, env: spawnOptions.env, signal: spawnOptions.signal,
          stdio: ["pipe", "pipe", "ignore"], windowsHide: true,
        });
        child = spawned;
        spawned.once("exit", () => done());
        spawned.once("error", error => { if ((error as NodeJS.ErrnoException).code === "ENOENT" && existsSync(options.cwd)) missing = true; if (!spawned.pid) done(); });
        return spawned;
      },
    },
  });
  // Drain independently so a chatty process can never stall initialization.
  void (async () => { try { for await (const _ of probe) { /* no prompt: nothing is expected */ } } catch { /* reported via init/exit */ } })();
  let failure: unknown, result: ClaudeCodeProbe | undefined;
  try {
    const init = await timeout(probe.initializationResult(), options.startupTimeoutMs ?? 30_000, "Claude Code startup timed out");
    options.signal?.throwIfAborted();
    const status = claudeCodeAccountStatus(init.account);
    result = {
      authenticated: status.authenticated, ...(status.accountType ? { accountType: status.accountType } : {}),
      ...(typeof init.claude_code_version === "string" ? { version: init.claude_code_version } : {}),
      models: Array.isArray(init.models) ? init.models : [],
      skills: Array.isArray(init.commands) ? init.commands.filter(command => command && command.builtin !== true) : [],
    };
  } catch (error) { failure = error; }
  finally { options.signal?.removeEventListener("abort", cancel); }
  try { probe.close(); } finally { abort.abort(); }
  if (child) {
    try { await timeout(gone, options.shutdownTimeoutMs ?? 10_000, "Claude Code probe shutdown is unconfirmed"); }
    catch (error) { throw new Error("Claude Code probe shutdown is unconfirmed", { cause: failure ?? error }); }
  }
  if (missing) throw new ClaudeCodeNotInstalledError();
  if (failure) throw failure;
  return result!;
}

/** Throws the specific, non-secret auth error without ever having started a session. */
export async function requireClaudeCodeAuth(options: ClaudeCodeProbeOptions): Promise<ClaudeCodeProbe> {
  const probe = await probeClaudeCode(options);
  if (!probe.authenticated) throw new ClaudeCodeAuthRequiredError();
  // A reported but unsupported version is refused here; an engine that reports none is left to the later checks.
  if (probe.version !== undefined && !claudeCodeVersionSupported(probe.version)) throw new ClaudeCodeUnsupportedVersionError();
  return probe;
}
