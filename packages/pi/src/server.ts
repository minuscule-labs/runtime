import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { AgentEvent, AgentStatus, RuntimeMessage } from "@minu/runtime-core";

const MAX_INPUT_BYTES = 1024 * 1024;

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

      if (request.method === "POST" && url.pathname === "/interrupt") {
        if (!options.interrupt) {
          json(response, 405, { error: "This Runtime adapter does not support interruption" });
          return;
        }
        if (options.getStatus() !== "working") {
          throw new SessionBusyError("Pi session must be working to interrupt it");
        }
        await options.interrupt();
        json(response, 202, { status: "interrupting" });
        return;
      }

      if (request.method === "POST" && url.pathname === "/send") {
        if (options.getStatus() !== "idle") throw new SessionBusyError("Pi session is working");
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
