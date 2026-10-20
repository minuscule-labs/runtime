import { sessionProfile, SESSION_PROFILE_LIMITS, type RuntimeSessionProfile } from "@minu/runtime-core";

interface ProfileRpc { request(type: string, fields?: Record<string, unknown>, timeoutMs?: number): Promise<unknown> }

/** One bounded RPC read at a time. A hard-stalled profile read disables only further profile reads. */
export function createSessionProfileReader(rpc: ProfileRpc, nativeSessionId: string) {
  let reading = false;
  let stalled = false;
  return async (signal: AbortSignal): Promise<RuntimeSessionProfile> => {
    signal.throwIfAborted();
    if (reading || stalled) throw new Error("Session profile unavailable");
    reading = true;
    const deadline = performance.now() + SESSION_PROFILE_LIMITS.readMs;
    const request = async (type: string) => {
      signal.throwIfAborted();
      const remaining = Math.floor(deadline - performance.now());
      if (remaining <= 0) { stalled = true; throw new Error("Session profile unavailable"); }
      try { return await rpc.request(type, {}, remaining); }
      catch { if (performance.now() >= deadline - 5) stalled = true; throw new Error("Session profile unavailable"); }
    };
    const task = (async () => {
      try {
        const raw = await request("get_state") as Record<string, unknown>;
        signal.throwIfAborted();
        if (!raw || raw.sessionId !== nativeSessionId) throw new Error("Session profile unavailable");
        // Only state from this process; never a capability-discovery process or manifest.
        const model = raw.model as Record<string, unknown> | undefined;
        let skills: unknown = { status: "not_verified" };
        try {
          const commands = await request("get_commands") as { commands?: unknown[] };
          signal.throwIfAborted();
          if (Array.isArray(commands?.commands)) {
            const commandIds: unknown[] = [];
            let complete = true;
            // Bound iteration as well as output. Non-skill commands are not evidence about skills.
            for (const value of commands.commands.slice(0, 1024)) {
              if (!value || typeof value !== "object") { complete = false; continue; }
              const command = value as Record<string, unknown>;
              if (command.source === "skill") commandIds.push(command.name);
            }
            skills = { status: "verified", commandIds, complete: complete && commands.commands.length <= 1024 };
          }
        } catch { signal.throwIfAborted(); if (stalled) throw new Error("Session profile unavailable"); }
        signal.throwIfAborted();
        const current = await request("get_state") as Record<string, unknown>;
        signal.throwIfAborted();
        const currentModel = current?.model as Record<string, unknown> | undefined;
        if (current?.sessionId !== nativeSessionId || currentModel?.provider !== model?.provider
          || currentModel?.id !== model?.id || current.thinkingLevel !== raw.thinkingLevel) throw new Error("Session profile unavailable");
        return sessionProfile({ version: 1, capturedAt: new Date().toISOString(),
          model: { status: "verified", provider: model?.provider, id: model?.id },
          reasoning: { status: "verified", level: raw.thinkingLevel }, skills });
      } finally { reading = false; }
    })();
    // Caller cancellation fences delivery but does not release the physical RPC slot early.
    return new Promise<RuntimeSessionProfile>((resolve, reject) => {
      const abort = () => reject(new DOMException("Session profile read aborted", "AbortError"));
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
      void task.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
    });
  };
}
