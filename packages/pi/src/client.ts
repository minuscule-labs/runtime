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
  RuntimeMessage,
} from "@minu/runtime-core";
import { readRegistration, registryDirectory } from "./registry.js";

export class SessionOfflineError extends Error {}

async function registrationFor(sessionId: string) {
  const registration = await readRegistration(sessionId);
  if (!registration) throw new SessionOfflineError(`Pi session is offline: ${sessionId}`);
  return registration;
}

async function checkedFetch(sessionId: string, path: string, init?: RequestInit): Promise<Response> {
  const registration = await registrationFor(sessionId);
  let response: Response;
  try {
    response = await fetch(`${registration.endpoint}${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${registration.token}`,
        ...init?.headers,
      },
    });
  } catch (error) {
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

export class PiAgentRuntime implements AgentRuntime {
  async start(config: AgentStartConfig = {}): Promise<AgentSession> {
    if (config.systemPrompt !== undefined && config.appendSystemPrompt !== undefined) {
      throw new Error("systemPrompt and appendSystemPrompt cannot both be set");
    }
    const cwd = resolve(config.cwd ?? process.cwd());
    const launchId = randomUUID();
    const directory = registryDirectory();
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const readyFile = resolve(directory, `.launch-${launchId}.json`);
    const logFile = resolve(directory, `.launch-${launchId}.log`);
    const promptFile = resolve(directory, `.launch-${launchId}.prompt`);
    const worker = fileURLToPath(new URL("./owned-worker.js", import.meta.url));
    const workerArgs = [worker, "--cwd", cwd, "--ready-file", readyFile, "--log-file", logFile];
    if (config.systemPrompt !== undefined) {
      await writeFile(promptFile, config.systemPrompt, { mode: 0o600 });
      workerArgs.push("--system-prompt-file", promptFile);
    }
    if (config.appendSystemPrompt !== undefined) {
      await writeFile(promptFile, config.appendSystemPrompt, { mode: 0o600 });
      workerArgs.push("--append-system-prompt-file", promptFile);
    }
    const child = spawn(process.execPath, workerArgs, {
      detached: true,
      stdio: "ignore",
      env: process.env,
    });
    child.unref();

    try {
      for (let attempt = 0; attempt < 150; attempt++) {
        try {
          const result = JSON.parse(await readFile(readyFile, "utf8")) as {
            sessionId?: string;
            error?: string;
          };
          if (result.error) throw new Error(result.error);
          if (result.sessionId) {
            return { id: result.sessionId, runtime: "pi", ownership: "owned", cwd };
          }
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
        await delay(100);
      }
      throw new Error(`Timed out starting Pi runtime. See ${logFile}`);
    } finally {
      await Promise.all([rm(readyFile, { force: true }), rm(promptFile, { force: true })]);
    }
  }

  async send(sessionId: string, input: string): Promise<void> {
    await checkedFetch(sessionId, "/send", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ input }),
    });
  }

  async steer(sessionId: string, input: string): Promise<void> {
    await checkedFetch(sessionId, "/steer", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ input }),
    });
  }

  async interrupt(sessionId: string): Promise<void> {
    await checkedFetch(sessionId, "/interrupt", { method: "POST" });
  }

  async status(sessionId: string): Promise<AgentStatus> {
    try {
      const response = await checkedFetch(sessionId, "/status");
      const body = (await response.json()) as { status: AgentStatus };
      return body.status;
    } catch (error) {
      if (error instanceof SessionOfflineError) return "offline";
      throw error;
    }
  }

  async messages(sessionId: string): Promise<RuntimeMessage[]> {
    const response = await checkedFetch(sessionId, "/messages");
    const body = (await response.json()) as { messages: RuntimeMessage[] };
    return body.messages;
  }

  async stop(sessionId: string): Promise<void> {
    await checkedFetch(sessionId, "/stop", { method: "POST" });
    for (let attempt = 0; attempt < 50; attempt++) {
      if ((await this.status(sessionId)) === "offline") return;
      await delay(100);
    }
    throw new Error(`Timed out stopping Pi session: ${sessionId}`);
  }

  async *events(sessionId: string): AsyncIterable<AgentEvent> {
    const controller = new AbortController();
    try {
      const response = await checkedFetch(sessionId, "/events", { signal: controller.signal });
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
}
