#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import { realpath } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { RUNTIME_INPUT_LIMITS } from "@minu/runtime-core";
import { ClaudeCodeManagedRuntime } from "./managed-runtime.js";

/** Minimal JSON CLI. User turn content is stdin ONLY, never argv or a manifest. */
export async function runClaudeCodeCli(args = process.argv.slice(2)): Promise<void> {
  const [command, ...rest] = args, flags = new Map<string, string>();
  const verbs = ["create", "status", "list", "get", "turn", "run", "history", "interrupt", "stop", "resume", "events", "activity"];
  if (!verbs.includes(command)) throw new Error("invalid_command");
  for (let i = 0; i < rest.length; i += 2) {
    if (!["--owner", "--state", "--native-root", "--cwd", "--id", "--turn-id"].includes(rest[i])
      || !rest[i + 1] || flags.has(rest[i])) throw new Error("invalid_arguments");
    flags.set(rest[i], rest[i + 1]);
  }
  const required = (key: string) => { const value = flags.get(key); if (!value) throw new Error("invalid_arguments"); return value; };
  const ownerId = required("--owner"), nativeConfigRoot = required("--native-root"), storeRoot = required("--state");
  const env: Record<string, string> = { CLAUDE_CONFIG_DIR: nativeConfigRoot };
  // No implicit credential/config inheritance beyond this explicit operator path.
  for (const key of ["HOME", "PATH", "TMPDIR", "ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL", "NO_PROXY", "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC"]) {
    if (process.env[key] !== undefined) env[key] = process.env[key]!;
  }
  const runtime = new ClaudeCodeManagedRuntime({ ownerId, storeRoot, nativeConfigRoot, nativeOptions: { env } });
  const print = (value: unknown) => process.stdout.write(JSON.stringify(value) + "\n");
  if (command === "create") { print(await runtime.startManaged({ cwd: flags.get("--cwd") }, ownerId)); return; }
  if (command === "list") { print(await runtime.listManagedSessions(ownerId)); return; }
  const id = required("--id");
  switch (command) {
    case "get": print(await runtime.getManagedSession(id, ownerId) ?? null); break;
    case "status": print(await runtime.status(id)); break;
    case "history": print(await runtime.messages(id)); break;
    case "turn": print(await runtime.turn(id, required("--turn-id")) ?? null); break;
    case "run": {
      const chunks: Buffer[] = []; let bytes = 0;
      for await (const chunk of process.stdin) {
        bytes += chunk.length; if (bytes > RUNTIME_INPUT_LIMITS.transportBytes) throw new Error("invalid_input"); chunks.push(Buffer.from(chunk));
      }
      const input = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
      if (!input || Object.keys(input).some(key => !["turnId", "input"].includes(key))) throw new Error("invalid_input");
      let turn = await runtime.startTurn(id, input.turnId, input.input);
      while (turn.status === "running") { await delay(25); const value = await runtime.turn(id, turn.id); if (!value) throw new Error("unavailable"); turn = value; }
      print(turn); if (turn.status !== "completed") process.exitCode = 1; break;
    }
    case "interrupt": await runtime.interrupt(id); print({ acknowledged: true }); break;
    case "stop": await runtime.suspend(id, ownerId); print({ suspended: true }); break;
    case "resume": print(await runtime.resume(id, ownerId, { allowStopped: true })); break;
    case "events": case "activity": {
      const abort = new AbortController(), cancel = () => abort.abort();
      process.once("SIGINT", cancel); process.once("SIGTERM", cancel);
      try {
        const stream = command === "events" ? runtime.events(id, abort.signal) : runtime.activityEvents(id, { signal: abort.signal });
        for await (const value of stream) print(value);
      } finally { process.off("SIGINT", cancel); process.off("SIGTERM", cancel); }
      break;
    }
  }
}
if (process.argv[1] && await realpath(process.argv[1]) === await realpath(fileURLToPath(import.meta.url))) void runClaudeCodeCli().catch(() => {
  process.stderr.write('{"error":"claude_code_command_failed"}\n'); process.exitCode = 1;
});
