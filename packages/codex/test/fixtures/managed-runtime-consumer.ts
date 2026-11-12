import { CodexAgentRuntime, type CodexAgentRuntimeOptions } from "../../src/index.js";

process.once("message", async (request: { options: CodexAgentRuntimeOptions; ownerId: string; cwd: string;
  id?: string; turnId: string; input: string; lifecycle?: boolean }) => {
  try {
    const runtime = new CodexAgentRuntime(request.options);
    const session = request.id ? await runtime.resume(request.id, request.ownerId)
      : await runtime.startManaged({ cwd: request.cwd }, request.ownerId);
    const prior = request.lifecycle ? await runtime.messages(session.id) : undefined;
    const turn = await runtime.startTurn(session.id, request.turnId, request.input);
    if (request.lifecycle) {
      const deadline = Date.now() + 4_000;
      while ((await runtime.turn(session.id, request.turnId))?.status === "running") {
        if (Date.now() >= deadline) throw new Error("Lifecycle fixture turn timed out");
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      const history = await runtime.messages(session.id);
      await runtime.suspend(session.id, request.ownerId);
      const inventory = await runtime.listManagedSessions(request.ownerId);
      process.send?.({ ok: true, session, prior, history, inventory }, () => process.exit(0)); return;
    }
    const stream = runtime.events(session.id);
    await stream.next();
    process.send?.({ ok: true, session, turn }, () => process.exit(0));
    // Deliberate exit with an open observation socket, not session stop. The
    // registered worker owns work; socket loss must never stop or replay it.
  } catch {
    process.send?.({ ok: false }, () => process.disconnect());
    process.exitCode = 1;
  }
});
