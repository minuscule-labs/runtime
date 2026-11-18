import { ClaudeCodeWorkerClient } from "../../src/worker-client.js";
process.once("message", async (connection: any) => {
  try {
    const client = new ClaudeCodeWorkerClient(connection);
    const turn = await client.startTurn("retained-turn", "hold");
    process.send?.({ type: "accepted", turn }, () => process.exit(0));
  } catch { process.exit(1); }
});
