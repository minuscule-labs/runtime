import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { ClaudeCodeWorkerClient } from "../../src/worker-client.js";
import { envelope } from "../../src/worker-protocol.js";

assert.ok(global.gc, "This isolated fixture requires --expose-gc");
for (const collect of [false, true]) {
  const identity = { sessionId: "session", ownerId: "owner", generation: "generation" };
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/x-ndjson" });
    response.write(JSON.stringify(envelope(identity, {
      type: "status", sessionId: identity.sessionId, status: "idle", timestamp: new Date().toISOString(),
    })) + "\n");
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const abort = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const client = new ClaudeCodeWorkerClient({ ...identity,
      endpoint: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, token: "a".repeat(64) });
    const reader = client.events(abort.signal)[Symbol.asyncIterator]();
    assert.equal((await reader.next()).value?.type, "status");
    const pending = reader.next();
    if (collect) for (let index = 0; index < 5; index++) { global.gc(); await delay(10); }
    abort.abort();
    const result = await Promise.race([pending, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`Event reader did not cancel (forced GC: ${collect})`)), 1_000);
    })]);
    assert.equal(result.done, true);
    await reader.return?.();
  } finally {
    clearTimeout(timer);
    abort.abort();
    // This fixture owns the server and every connection; no native worker exists.
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
}
