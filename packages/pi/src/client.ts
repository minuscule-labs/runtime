import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  AgentEvent,
  AgentRuntime,
  AgentSession,
  AgentStartConfig,
  AgentStatus,
  AgentTurn,
  RuntimeActivityEvent,
  RuntimeActivityOptions,
  RuntimeActivityPhase,
  RuntimeLaunchCapabilities,
  RuntimeMessage,
  RuntimeSkillCapability,
} from "@minu/runtime-core";
import { PiRpcProcess } from "./pi-rpc.js";
import { readRegistration, registryDirectory } from "./registry.js";

export class SessionOfflineError extends Error {}

async function registrationFor(sessionId: string) {
  const registration = await readRegistration(sessionId);
  if (!registration) throw new SessionOfflineError(`Pi session is offline: ${sessionId}`);
  return registration;
}

const SHORT_REQUEST_TIMEOUT_MS = 10_000;
const CONTROL_REQUEST_TIMEOUT_MS = 30 * 60_000;
const DEFAULT_START_TIMEOUT_MS = 30_000;

async function checkedFetch(
  sessionId: string,
  path: string,
  init?: RequestInit,
  timeoutMs?: number,
): Promise<Response> {
  const registration = await registrationFor(sessionId);
  let response: Response;
  const timeoutSignal = timeoutMs === undefined ? undefined : AbortSignal.timeout(timeoutMs);
  const signal = init?.signal && timeoutSignal
    ? AbortSignal.any([init.signal, timeoutSignal])
    : init?.signal ?? timeoutSignal;
  try {
    response = await fetch(`${registration.endpoint}${path}`, {
      ...init,
      signal,
      headers: {
        authorization: `Bearer ${registration.token}`,
        ...init?.headers,
      },
    });
  } catch (error) {
    if (timeoutSignal?.aborted && !init?.signal?.aborted) {
      throw new Error(`Pi session request timed out after ${timeoutMs}ms: ${path}`);
    }
    throw new SessionOfflineError(`Could not reach Pi session ${sessionId}: ${String(error)}`);
  }
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `Runtime request failed (${response.status})`);
  }
  return response;
}

async function delay(milliseconds: number): Promise<void> {
  await new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

async function terminateChild(child: ReturnType<typeof spawn>): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>((resolveExit) => child.once("exit", () => resolveExit()));
  child.kill("SIGTERM");
  if (await Promise.race([exited.then(() => true), delay(5_000).then(() => false)])) return;
  child.kill("SIGKILL");
  await Promise.race([exited, delay(1_000)]);
}

interface DiscoveredPiSkill extends RuntimeSkillCapability {
  path: string;
}

async function discoverSkills(rpc: PiRpcProcess): Promise<DiscoveredPiSkill[]> {
  const available = (await rpc.request("get_commands")) as { commands?: unknown[] };
  const seen = new Set<string>();
  return (available.commands ?? []).flatMap((value) => {
    if (!value || typeof value !== "object") return [];
    const command = value as Record<string, unknown>;
    const sourceInfo = command.sourceInfo;
    if (command.source !== "skill" || typeof command.name !== "string"
      || !sourceInfo || typeof sourceInfo !== "object"
      || typeof (sourceInfo as Record<string, unknown>).path !== "string"
      || seen.has(command.name)) return [];
    seen.add(command.name);
    return [{
      id: command.name,
      name: command.name.startsWith("skill:") ? command.name.slice(6) : command.name,
      description: typeof command.description === "string" ? command.description : "",
      path: (sourceInfo as Record<string, unknown>).path as string,
    }];
  });
}

export interface PiAgentRuntimeOptions {
  requestTimeoutMs?: number;
  controlRequestTimeoutMs?: number;
  startTimeoutMs?: number;
  workerPath?: string;
}

export class PiAgentRuntime implements AgentRuntime {
  constructor(private readonly options: PiAgentRuntimeOptions = {}) {
    for (const [name, value] of Object.entries({
      requestTimeoutMs: options.requestTimeoutMs,
      controlRequestTimeoutMs: options.controlRequestTimeoutMs,
      startTimeoutMs: options.startTimeoutMs,
    })) {
      if (value !== undefined && (!Number.isSafeInteger(value) || value < 1)) {
        throw new RangeError(`${name} must be a positive integer`);
      }
    }
  }

  async capabilities(config: Pick<AgentStartConfig, "cwd"> = {}): Promise<RuntimeLaunchCapabilities> {
    const rpc = new PiRpcProcess(resolve(config.cwd ?? process.cwd()), () => {});
    try {
      const available = (await rpc.request("get_available_models")) as { models?: unknown[] };
      const models = (available.models ?? []).flatMap((value) => {
        if (!value || typeof value !== "object") return [];
        const model = value as Record<string, unknown>;
        if (typeof model.provider !== "string" || typeof model.id !== "string") return [];
        return [{
          provider: model.provider,
          id: model.id,
          name: typeof model.name === "string" ? model.name : model.id,
          reasoning: model.reasoning === true,
        }];
      });
      const skills = (await discoverSkills(rpc)).map(({ path: _path, ...skill }) => skill);
      return {
        models,
        reasoningLevels: ["off", "minimal", "low", "medium", "high", "xhigh", "max"],
        skills,
      };
    } finally {
      await rpc.stop();
    }
  }

  async start(config: AgentStartConfig = {}): Promise<AgentSession> {
    if (config.systemPrompt !== undefined && config.appendSystemPrompt !== undefined) {
      throw new Error("systemPrompt and appendSystemPrompt cannot both be set");
    }
    if (config.model && (!config.model.provider.trim() || !config.model.id.trim())) {
      throw new Error("model provider and id must be non-empty");
    }
    if (config.model && (config.model.provider.length > 100 || config.model.id.length > 300)) {
      throw new Error("model provider or id is too large");
    }
    if (config.skillIds !== undefined && (!Array.isArray(config.skillIds)
      || config.skillIds.length > 100
      || config.skillIds.some((id) => typeof id !== "string" || !id.trim() || id !== id.trim() || id.length > 200)
      || new Set(config.skillIds).size !== config.skillIds.length)) {
      throw new Error("skillIds must contain at most 100 unique, non-empty skill ids");
    }
    const cwd = resolve(config.cwd ?? process.cwd());
    let skillPaths: string[] | undefined;
    if (config.skillIds !== undefined) {
      const discovery = new PiRpcProcess(cwd, () => {});
      try {
        const skills = await discoverSkills(discovery);
        const byId = new Map(skills.map((skill) => [skill.id, skill.path]));
        skillPaths = config.skillIds.map((id) => {
          const path = byId.get(id);
          if (!path) throw new Error(`Pi skill is not available: ${id}`);
          return path;
        });
      } finally {
        await discovery.stop();
      }
    }
    const launchId = randomUUID();
    const directory = registryDirectory();
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const readyFile = resolve(directory, `.launch-${launchId}.json`);
    const logFile = resolve(directory, `.launch-${launchId}.log`);
    const promptFile = resolve(directory, `.launch-${launchId}.prompt`);
    const worker = this.options.workerPath
      ? resolve(this.options.workerPath)
      : fileURLToPath(new URL("./owned-worker.js", import.meta.url));
    const workerArgs = [worker, "--cwd", cwd, "--ready-file", readyFile, "--log-file", logFile];
    if (config.systemPrompt !== undefined) {
      await writeFile(promptFile, config.systemPrompt, { mode: 0o600 });
      workerArgs.push("--system-prompt-file", promptFile);
    }
    if (config.appendSystemPrompt !== undefined) {
      await writeFile(promptFile, config.appendSystemPrompt, { mode: 0o600 });
      workerArgs.push("--append-system-prompt-file", promptFile);
    }
    if (config.model) {
      workerArgs.push("--model-provider", config.model.provider.trim(), "--model-id", config.model.id.trim());
    }
    if (config.reasoningLevel) workerArgs.push("--reasoning-level", config.reasoningLevel);
    if (skillPaths !== undefined) {
      workerArgs.push("--disable-skill-discovery");
      for (const path of skillPaths) workerArgs.push("--skill-path", path);
    }
    const child = spawn(process.execPath, workerArgs, {
      detached: false,
      stdio: "ignore",
      env: process.env,
    });
    let cancelled = false;
    const failed = new Promise<never>((_resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code, signal) => {
        setTimeout(async () => {
          try {
            const result = JSON.parse(await readFile(readyFile, "utf8")) as { error?: string };
            if (result.error) {
              reject(new Error(result.error));
              return;
            }
          } catch {}
          reject(new Error(`Pi Runtime worker exited before readiness (${signal ?? code ?? "unknown"}). See ${logFile}`));
        }, 20);
      });
    });
    const timeoutMs = this.options.startTimeoutMs ?? DEFAULT_START_TIMEOUT_MS;
    let started = false;
    try {
      const ready = (async () => {
        const deadline = Date.now() + timeoutMs;
        while (!cancelled && Date.now() < deadline) {
          try {
            const result = JSON.parse(await readFile(readyFile, "utf8")) as {
              sessionId?: string;
              error?: string;
            };
            if (result.error) throw new Error(result.error);
            if (result.sessionId) {
              if (child.exitCode !== null || child.signalCode !== null) {
                throw new Error(`Pi Runtime worker exited during startup. See ${logFile}`);
              }
              return result.sessionId;
            }
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          }
          await delay(Math.min(100, Math.max(1, deadline - Date.now())));
        }
        throw new Error(`Timed out starting Pi runtime after ${timeoutMs}ms. See ${logFile}`);
      })();
      const sessionId = await Promise.race([ready, failed]);
      started = true;
      child.unref();
      return { id: sessionId, runtime: "pi", ownership: "owned", cwd };
    } finally {
      cancelled = true;
      if (!started) await terminateChild(child);
      await Promise.all([rm(readyFile, { force: true }), rm(promptFile, { force: true })]);
    }
  }

  async send(sessionId: string, input: string): Promise<void> {
    await checkedFetch(sessionId, "/send", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ input }),
    }, this.options.controlRequestTimeoutMs ?? CONTROL_REQUEST_TIMEOUT_MS);
  }

  async startTurn(sessionId: string, turnId: string, input: string): Promise<AgentTurn> {
    const response = await checkedFetch(sessionId, "/turns", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ turnId, input }),
    }, this.options.requestTimeoutMs ?? SHORT_REQUEST_TIMEOUT_MS);
    return ((await response.json()) as { turn: AgentTurn }).turn;
  }

  async turn(sessionId: string, turnId: string): Promise<AgentTurn | undefined> {
    const response = await checkedFetch(sessionId, `/turns/${encodeURIComponent(turnId)}`, undefined, this.options.requestTimeoutMs ?? SHORT_REQUEST_TIMEOUT_MS);
    const body = (await response.json()) as { turn: AgentTurn | null };
    return body.turn ?? undefined;
  }

  async steer(sessionId: string, input: string): Promise<void> {
    await checkedFetch(sessionId, "/steer", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ input }),
    }, this.options.requestTimeoutMs ?? SHORT_REQUEST_TIMEOUT_MS);
  }

  async interrupt(sessionId: string): Promise<void> {
    await checkedFetch(sessionId, "/interrupt", { method: "POST" }, this.options.requestTimeoutMs ?? SHORT_REQUEST_TIMEOUT_MS);
  }

  async status(sessionId: string): Promise<AgentStatus> {
    try {
      const response = await checkedFetch(sessionId, "/status", undefined, this.options.requestTimeoutMs ?? SHORT_REQUEST_TIMEOUT_MS);
      const body = (await response.json()) as { status: AgentStatus };
      return body.status;
    } catch (error) {
      if (error instanceof SessionOfflineError) return "offline";
      throw error;
    }
  }

  async messages(sessionId: string): Promise<RuntimeMessage[]> {
    const response = await checkedFetch(sessionId, "/messages", undefined, this.options.requestTimeoutMs ?? SHORT_REQUEST_TIMEOUT_MS);
    const body = (await response.json()) as { messages: RuntimeMessage[] };
    return body.messages;
  }

  async stop(sessionId: string): Promise<void> {
    await checkedFetch(sessionId, "/stop", { method: "POST" }, this.options.requestTimeoutMs ?? SHORT_REQUEST_TIMEOUT_MS);
    for (let attempt = 0; attempt < 50; attempt++) {
      if ((await this.status(sessionId)) === "offline") return;
      await delay(100);
    }
    throw new Error(`Timed out stopping Pi session: ${sessionId}`);
  }

  private async *eventStream(sessionId: string, signal?: AbortSignal): AsyncIterable<AgentEvent> {
    const controller = new AbortController();
    const streamSignal = signal ? AbortSignal.any([controller.signal, signal]) : controller.signal;
    try {
      const response = await checkedFetch(sessionId, "/events", { signal: streamSignal });
      if (!response.body) throw new Error("Runtime event stream has no body");
      const decoder = new TextDecoder();
      let buffer = "";
      for await (const chunk of response.body) {
        buffer += decoder.decode(chunk, { stream: true });
        while (true) {
          const boundary = buffer.indexOf("\n\n");
          if (boundary < 0) break;
          const frame = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          for (const line of frame.split("\n")) {
            if (line.startsWith("data: ")) yield JSON.parse(line.slice(6)) as AgentEvent;
          }
        }
      }
    } finally {
      controller.abort();
    }
  }

  events(sessionId: string): AsyncIterable<AgentEvent> {
    return this.eventStream(sessionId);
  }

  async *activityEvents(
    sessionId: string,
    options: RuntimeActivityOptions,
  ): AsyncIterable<RuntimeActivityEvent> {
    const activeTools = new Set<string>();
    let currentPhase: RuntimeActivityPhase | undefined;
    try {
      for await (const event of this.eventStream(sessionId, options.signal)) {
        if (typeof event.timestamp !== "string" || !Number.isFinite(Date.parse(event.timestamp))) continue;
        let nextPhase: RuntimeActivityPhase | undefined;
        if (event.type === "status") {
          if (event.status === "working" && activeTools.size === 0) nextPhase = "working";
          else if (event.status !== "working") {
            activeTools.clear();
            currentPhase = undefined;
          }
        } else if (event.type === "turn_started") {
          activeTools.clear();
          nextPhase = "working";
        } else if (event.type === "tool_started") {
          if (typeof event.toolCallId !== "string" || event.toolCallId.length === 0) continue;
          activeTools.add(event.toolCallId);
          nextPhase = "using_tools";
        } else if (event.type === "tool_completed") {
          if (typeof event.toolCallId !== "string" || !activeTools.delete(event.toolCallId)) continue;
          nextPhase = activeTools.size > 0 ? "using_tools" : "working";
        } else if (event.type === "message_delta" && activeTools.size === 0) {
          nextPhase = "responding";
        } else if (event.type === "turn_completed") {
          activeTools.clear();
          currentPhase = undefined;
        }
        if (nextPhase && nextPhase !== currentPhase) {
          currentPhase = nextPhase;
          yield { phase: nextPhase, observedAt: event.timestamp };
        }
      }
    } catch (error) {
      if (!options.signal.aborted) throw error;
    }
  }
}
