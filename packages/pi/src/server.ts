import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { AgentEvent, AgentStatus, AgentTurn, RuntimeMessage } from "@minu/runtime-core";

const MAX_INPUT_BYTES = 1024 * 1024;
const DEFAULT_TURN_RETENTION_LIMIT = 1_000;

export class SessionBusyError extends Error {}

export interface PiBridgeServerOptions {
  sessionId: string;
  token: string;
  getStatus(): AgentStatus;
  send(input: string, operationId: string): Promise<void>;
  steer?(input: string): Promise<void>;
  interrupt?(): Promise<void>;
  getMessages?(): Promise<RuntimeMessage[]>;
  stop?(): Promise<void> | void;
  /** Completed turn ids remain idempotent within this bounded, insertion-ordered window. */
  turnRetentionLimit?: number;
}

export interface PiBridgeServer {
  endpoint: string;
  publish(event: AgentEvent): void;
  close(): Promise<void>;
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_INPUT_BYTES) throw new Error("Input exceeds 1 MiB");
    chunks.push(buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(`${JSON.stringify(body)}\n`);
}

export async function createPiBridgeServer(options: PiBridgeServerOptions): Promise<PiBridgeServer> {
  const streams = new Set<ServerResponse>();
  const turns = new Map<string, AgentTurn>();
  const turnRetentionLimit = options.turnRetentionLimit ?? DEFAULT_TURN_RETENTION_LIMIT;
  if (!Number.isSafeInteger(turnRetentionLimit) || turnRetentionLimit < 1) {
    throw new Error("turnRetentionLimit must be a positive integer");
  }
  let activeTurnId: string | undefined;

  const copyTurn = (turn: AgentTurn): AgentTurn => ({
    ...turn,
    response: turn.response ? { ...turn.response } : undefined,
  });

  const pruneTurns = (): void => {
    if (turns.size <= turnRetentionLimit) return;
    for (const [id, candidate] of turns) {
      if (candidate.status === "running") continue;
      turns.delete(id);
      if (turns.size <= turnRetentionLimit) return;
    }
  };

  const messageEquals = (left: RuntimeMessage, right: RuntimeMessage): boolean =>
    left.role === right.role
    && left.content === right.content
    && left.timestamp === right.timestamp
    && left.toolName === right.toolName;

  const runTurn = async (turn: AgentTurn): Promise<void> => {
    try {
      const before = await options.getMessages?.() ?? [];
      await options.send(turn.input, turn.id);
      if (turn.status === "interrupted") return;
      const after = await options.getMessages?.() ?? [];
      let sharedPrefix = 0;
      while (sharedPrefix < before.length && sharedPrefix < after.length
        && messageEquals(before[sharedPrefix]!, after[sharedPrefix]!)) sharedPrefix += 1;
      const responseMessage = after
        .slice(sharedPrefix)
        .reverse()
        .find((message) => message.role === "assistant");
      if (!responseMessage) throw new Error("Agent turn produced no assistant response");
      turn.status = "completed";
      turn.response = { ...responseMessage };
      turn.updatedAt = new Date().toISOString();
    } catch (error) {
      if (turn.status === "interrupted") return;
      turn.status = "failed";
      turn.error = error instanceof Error ? error.message : String(error);
      turn.updatedAt = new Date().toISOString();
    } finally {
      if (activeTurnId === turn.id) activeTurnId = undefined;
      pruneTurns();
    }
  };

  const publish = (event: AgentEvent): void => {
    const frame = `data: ${JSON.stringify(event)}\n\n`;
    for (const stream of streams) stream.write(frame);
  };

  const server = createServer(async (request, response) => {
    try {
      if (request.headers.authorization !== `Bearer ${options.token}`) {
        json(response, 401, { error: "Unauthorized" });
        return;
      }

      const url = new URL(request.url ?? "/", "http://runtime.local");
      if (request.method === "GET" && url.pathname === "/status") {
        json(response, 200, { sessionId: options.sessionId, status: options.getStatus() });
        return;
      }

      if (request.method === "GET" && url.pathname === "/messages") {
        json(response, 200, { messages: await options.getMessages?.() ?? [] });
        return;
      }

      if (request.method === "GET" && url.pathname === "/events") {
        response.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
          connection: "keep-alive",
        });
        streams.add(response);
        response.write(`data: ${JSON.stringify({
          type: "status",
          sessionId: options.sessionId,
          status: options.getStatus(),
          timestamp: new Date().toISOString(),
        })}\n\n`);
        request.on("close", () => streams.delete(response));
        return;
      }

      if (request.method === "POST" && url.pathname === "/steer") {
        if (!options.steer) {
          json(response, 405, { error: "This Runtime adapter does not support steering" });
          return;
        }
        if (options.getStatus() !== "working") {
          throw new SessionBusyError("Pi session must be working to steer it");
        }
        const body = (await readJson(request)) as { input?: unknown };
        if (typeof body.input !== "string" || body.input.trim().length === 0) {
          json(response, 400, { error: "input must be a non-empty string" });
          return;
        }
        await options.steer(body.input);
        json(response, 202, { status: "steering" });
        return;
      }

      const turnMatch = url.pathname.match(/^\/turns\/(.+)$/);
      if (request.method === "GET" && turnMatch) {
        const turnId = decodeURIComponent(turnMatch[1]!);
        const turn = turns.get(turnId);
        json(response, 200, { turn: turn ? copyTurn(turn) : null });
        return;
      }

      if (request.method === "POST" && url.pathname === "/turns") {
        const body = (await readJson(request)) as { turnId?: unknown; input?: unknown };
        if (typeof body.turnId !== "string" || !body.turnId.trim() || body.turnId.length > 512) {
          json(response, 400, { error: "turnId must be a non-empty string of at most 512 characters" });
          return;
        }
        if (typeof body.input !== "string" || body.input.trim().length === 0) {
          json(response, 400, { error: "input must be a non-empty string" });
          return;
        }
        const existing = turns.get(body.turnId);
        if (existing) {
          if (existing.input !== body.input) {
            json(response, 409, { error: "turnId is already associated with different input" });
            return;
          }
          json(response, 200, { turn: copyTurn(existing) });
          return;
        }
        if (options.getStatus() !== "idle" || activeTurnId) {
          throw new SessionBusyError("Pi session is working");
        }
        const timestamp = new Date().toISOString();
        const turn: AgentTurn = {
          id: body.turnId,
          status: "running",
          input: body.input,
          createdAt: timestamp,
          updatedAt: timestamp,
        };
        turns.set(turn.id, turn);
        activeTurnId = turn.id;
        void runTurn(turn);
        json(response, 202, { turn: copyTurn(turn) });
        return;
      }

      if (request.method === "POST" && url.pathname === "/interrupt") {
        if (!options.interrupt) {
          json(response, 405, { error: "This Runtime adapter does not support interruption" });
          return;
        }
        if (options.getStatus() !== "working") {
          throw new SessionBusyError("Pi session must be working to interrupt it");
        }
        await options.interrupt();
        if (activeTurnId) {
          const turn = turns.get(activeTurnId);
          if (turn) {
            turn.status = "interrupted";
            turn.updatedAt = new Date().toISOString();
          }
        }
        json(response, 202, { status: "interrupting" });
        return;
      }

      if (request.method === "POST" && url.pathname === "/send") {
        if (options.getStatus() !== "idle" || activeTurnId) {
          throw new SessionBusyError("Pi session is working");
        }
        const body = (await readJson(request)) as { input?: unknown };
        if (typeof body.input !== "string" || body.input.trim().length === 0) {
          json(response, 400, { error: "input must be a non-empty string" });
          return;
        }
        const operationId = randomUUID();
        await options.send(body.input, operationId);
        json(response, 200, { operationId, status: "completed" });
        return;
      }

      if (request.method === "POST" && url.pathname === "/stop") {
        if (!options.stop) {
          json(response, 405, { error: "Attached Pi sessions cannot be stopped by Runtime" });
          return;
        }
        json(response, 202, { status: "stopping" });
        setImmediate(() => void options.stop?.());
        return;
      }

      json(response, 404, { error: "Not found" });
    } catch (error) {
      const status = error instanceof SessionBusyError ? 409 : 500;
      json(response, status, { error: error instanceof Error ? error.message : String(error) });
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address() as AddressInfo;

  return {
    endpoint: `http://127.0.0.1:${address.port}`,
    publish,
    async close() {
      for (const stream of streams) stream.end();
      streams.clear();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}
