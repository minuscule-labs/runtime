#!/usr/bin/env node
import { Command, Option } from "commander";
import type { AgentEvent } from "@minu/runtime-core";
import { PiAgentRuntime } from "./client.js";
import { listRegistrations } from "./registry.js";

function renderEvent(event: AgentEvent): void {
  if (event.type === "message_delta") process.stdout.write(event.delta);
  else if (event.type === "tool_started") console.log(`\n[tool] ${event.toolName}`);
  else if (event.type === "tool_completed" && event.isError) console.log(`[tool error] ${event.toolName}`);
  else if (event.type === "status") console.log(`[status] ${event.status}`);
  else if (event.type === "error") console.error(`[error] ${event.message}`);
}

async function followSend(runtime: PiAgentRuntime, sessionId: string, input: string): Promise<void> {
  const iterator = runtime.events(sessionId)[Symbol.asyncIterator]();
  const initial = await iterator.next();
  if (!initial.done) renderEvent(initial.value);
  const sending = runtime.send(sessionId, input);
  try {
    while (true) {
      const next = await iterator.next();
      if (next.done) break;
      renderEvent(next.value);
      if (next.value.type === "turn_completed") break;
    }
    await sending;
    process.stdout.write("\n");
  } finally {
    await iterator.return?.();
  }
}

async function main(): Promise<void> {
  const runtime = new PiAgentRuntime();
  const program = new Command()
    .name("minu-runtime")
    .description("Manage Runtime-owned and attached Pi agent sessions")
    .showHelpAfterError();

  program
    .command("start")
    .description("Start a Runtime-owned headless Pi session")
    .option("--cwd <path>", "working directory")
    .addOption(
      new Option("--system-prompt <text>", "replace Pi's default system prompt").conflicts(
        "appendSystemPrompt",
      ),
    )
    .addOption(
      new Option(
        "--append-system-prompt <text>",
        "append persistent persona instructions to Pi's system prompt",
      ).conflicts("systemPrompt"),
    )
    .action(
      async (options: {
        cwd?: string;
        systemPrompt?: string;
        appendSystemPrompt?: string;
      }) => {
        const session = await runtime.start(options);
        console.log(`${session.id}\t${session.ownership}\t${session.cwd}`);
      },
    );

  program
    .command("sessions")
    .description("List registered Pi sessions")
    .action(async () => {
      const sessions = await listRegistrations();
      if (sessions.length === 0) {
        console.log("No online Pi sessions.");
        return;
      }
      for (const session of sessions) {
        const status = await runtime.status(session.sessionId);
        console.log(`${session.sessionId}\t${status}\t${session.ownership ?? "attached"}\t${session.cwd}`);
      }
    });

  program
    .command("status")
    .description("Print one session's status")
    .argument("<session-id>")
    .action(async (sessionId: string) => console.log(await runtime.status(sessionId)));

  program
    .command("send")
    .description("Send input to an idle session and wait for the turn to settle")
    .option("--follow", "render events while the turn runs")
    .argument("<session-id>")
    .argument("<message...>")
    .action(async (sessionId: string, message: string[], options: { follow?: boolean }) => {
      const input = message.join(" ");
      if (options.follow) await followSend(runtime, sessionId, input);
      else {
        console.log(`Sending to ${sessionId}; waiting for Pi to settle...`);
        await runtime.send(sessionId, input);
        console.log(`${sessionId} is idle.`);
      }
    });

  program
    .command("steer")
    .description("Steer a working session at its next safe model boundary")
    .argument("<session-id>")
    .argument("<message...>")
    .action(async (sessionId: string, message: string[]) => {
      await runtime.steer(sessionId, message.join(" "));
      console.log(`${sessionId} accepted the steering message.`);
    });

  program
    .command("interrupt")
    .description("Abort a working session without undoing tool side effects")
    .argument("<session-id>")
    .action(async (sessionId: string) => {
      await runtime.interrupt(sessionId);
      console.log(`${sessionId} is interrupting.`);
    });

  program
    .command("messages")
    .description("Print normalized session history")
    .argument("<session-id>")
    .action(async (sessionId: string) => {
      for (const message of await runtime.messages(sessionId)) {
        console.log(`[${message.role}${message.toolName ? `:${message.toolName}` : ""}] ${message.content}`);
      }
    });

  program
    .command("watch")
    .description("Stream normalized session events")
    .argument("<session-id>")
    .action(async (sessionId: string) => {
      for await (const event of runtime.events(sessionId)) renderEvent(event);
    });

  program
    .command("stop")
    .description("Stop a Runtime-owned session")
    .argument("<session-id>")
    .action(async (sessionId: string) => {
      await runtime.stop(sessionId);
      console.log(`${sessionId} stopped.`);
    });

  await program.parseAsync(process.argv);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
