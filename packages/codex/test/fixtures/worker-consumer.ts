import { CodexWorkerClient, type CodexWorkerMethod } from "../../src/worker-client.js";
import type { CodexWorkerConnection } from "../../src/worker-bridge.js";

process.once("message", async (message: { connection: CodexWorkerConnection; method: CodexWorkerMethod; args: { turnId?: string; input?: string } }) => {
  try {
    const result = await new CodexWorkerClient(message.connection).request(message.method, message.args);
    process.send?.({ result }, () => process.disconnect());
  } catch {
    process.send?.({ failed: true }, () => process.disconnect());
    process.exitCode = 1;
  }
});
