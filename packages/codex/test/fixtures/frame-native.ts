import { record } from "../../src/rpc.js";

// Deterministic native fixture: replace only this thread's message delta while
// preserving the ordinary harness protocol, controls and terminal response.
const padding = Number(process.argv[2]);
const prefix = process.argv[3] === "utf8" ? 'é🐈"\\\n' : "";
if (!Number.isSafeInteger(padding) || padding < 0 || padding > 300_000) throw new Error("Invalid frame fixture padding");
process.argv.splice(2, 2);
const stringify = JSON.stringify;
JSON.stringify = (value: unknown) => {
  const message = record(value);
  const params = record(message?.params);
  if (message?.method === "item/agentMessage/delta" && params?.threadId === "native-thread") params.delta = prefix + "x".repeat(padding);
  return stringify(value);
};
await import("./app-server.js");
