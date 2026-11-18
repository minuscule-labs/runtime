// Test supervisor only: real native SDK protocol fixture behind the production bridge.
import { randomBytes } from "node:crypto";
import { ClaudeCodeAgentRuntime } from "../../src/client.js";
import { createClaudeCodeWorkerBridge } from "../../src/worker-bridge.js";
import { ClaudeCodeWorkerError } from "../../src/worker-protocol.js";

let current = true;
let bridge: Awaited<ReturnType<typeof createClaudeCodeWorkerBridge>> | undefined;
process.on("message", async (message: any) => {
  try {
    if (message.type === "start") {
      const runtime = new ClaudeCodeAgentRuntime({ executable: message.executable, startupTimeoutMs: 5_000 });
      const session = await runtime.start({ cwd: message.cwd });
      bridge = await createClaudeCodeWorkerBridge({
        ...message.identity, token: randomBytes(32).toString("hex"), nativeSessionId: session.id, runtime,
        admit: async operation => {
          if (!current) throw new ClaudeCodeWorkerError("stale_generation", 409);
          return operation();
        },
      });
      process.send?.({ type: "ready", connection: bridge.connection });
    } else if (message.type === "fence") {
      current = false; process.send?.({ type: "fenced" });
    } else if (message.type === "close") {
      current = true; // The fixture supervisor, not an old HTTP caller, owns final cleanup.
      await bridge?.close();
      process.exit(0);
    }
  } catch { process.send?.({ type: "failed" }); }
});
