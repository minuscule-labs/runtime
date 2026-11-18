import { sessionIntegrations, unavailableIntegrationSnapshot, SESSION_INTEGRATIONS_LIMITS, type RuntimeIntegrationSnapshot } from "@minu/runtime-core";
import { PiRpcUnsupportedCommandError } from "./pi-rpc.js";

interface IntegrationRpc { request(type: string, fields?: Record<string, unknown>, timeoutMs?: number): Promise<unknown> }
const object = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};

/** Native projection only. Unknowns stay unknown; schemas/descriptions/errors are never copied. */
export function projectPiIntegrations(input: unknown): RuntimeIntegrationSnapshot {
  const raw = object(input);
  const entries = Array.isArray(raw.integrations) ? raw.integrations : [];
  const nativeTools = Array.isArray(raw.tools) ? raw.tools : [];
  const tools = nativeTools.slice(0, SESSION_INTEGRATIONS_LIMITS.tools).map(value => {
    const tool = object(value);
    return { name: tool.name, integrationId: tool.integrationId,
      visibility: tool.exposure === "hidden" ? "hidden" : tool.declared === true ? "declared"
        : tool.exposure === "codemode" || tool.exposure === "deferred" ? "discoverable" : "unknown",
      routes: [...(tool.declared === true ? ["model"] : []), ...(tool.callable === true ? ["indirect"] : [])],
      // A callable host API alone does not prove an agent has a declared dispatcher reaching it.
      reachability: tool.declared === true ? "reachable" : tool.callable === false ? "not_reachable" : "unknown" };
  });
  const snapshot = sessionIntegrations({ version: raw.version, capturedAt: raw.capturedAt, status: raw.status,
    coverage: { ...object(raw.coverage), ...(!Array.isArray(raw.integrations) ? { configuration: "unknown" } : {}),
      ...(!Array.isArray(raw.tools) ? { tools: "unknown" } : {}) },
    operations: raw.operations,
    integrations: entries.slice(0, SESSION_INTEGRATIONS_LIMITS.integrations).map(value => {
      const entry = object(value);
      const owned = tools.filter(tool => tool.integrationId === entry.id);
      return { id: entry.id, name: entry.name, kind: entry.kind, source: entry.source,
        configured: entry.enabled === true ? "enabled" : entry.enabled === false ? "disabled" : "unknown",
        connection: entry.connection === "needs-auth" ? "authentication_required" : entry.connection,
        failureCode: entry.failureCode, toolCoverage: entry.toolCoverage, offeredCount: entry.offeredCount, registeredCount: entry.registeredCount, callableCount: entry.callableCount,
        // Do not inherit native counts that conflate indirect callability with proven agent reachability.
        ...(object(raw.coverage).tools === "complete" && entry.toolCoverage === "complete" && owned.length === entry.registeredCount
          && owned.every(tool => tool.reachability !== "unknown") && nativeTools.length <= SESSION_INTEGRATIONS_LIMITS.tools
          ? { reachableCount: owned.filter(tool => tool.reachability === "reachable").length } : {}) };
    }), tools, issues: raw.issues });
  if (entries.length > SESSION_INTEGRATIONS_LIMITS.integrations || nativeTools.length > SESSION_INTEGRATIONS_LIMITS.tools) {
    snapshot.status = "partial";
    if (entries.length > SESSION_INTEGRATIONS_LIMITS.integrations) snapshot.coverage.configuration = "partial";
    if (nativeTools.length > SESSION_INTEGRATIONS_LIMITS.tools) snapshot.coverage.tools = "partial";
    if (!snapshot.issues.includes("truncated")) snapshot.issues.push("truncated");
  }
  return sessionIntegrations(snapshot);
}

/** One physical read per worker. Cancellation fences delivery without releasing the native slot. */
export function createSessionIntegrationsReader(rpc: IntegrationRpc, nativeSessionId: string) {
  let reading = false;
  let stalled = false;
  return async (signal: AbortSignal): Promise<RuntimeIntegrationSnapshot> => {
    signal.throwIfAborted();
    if (reading || stalled) throw new Error("Session integrations unavailable");
    reading = true;
    const started = performance.now();
    const task = (async () => {
      try {
        let result: unknown;
        try { result = await rpc.request("get_integrations", {}, SESSION_INTEGRATIONS_LIMITS.readMs); }
        catch (error) {
          signal.throwIfAborted();
          if (error instanceof PiRpcUnsupportedCommandError) {
            const remaining = Math.floor(SESSION_INTEGRATIONS_LIMITS.readMs - (performance.now() - started));
            if (remaining <= 0) throw new Error("Session integrations unavailable");
            const state = object(await rpc.request("get_state", {}, remaining));
            signal.throwIfAborted();
            if (state.sessionId !== nativeSessionId) throw new Error("Session integrations unavailable");
            return unavailableIntegrationSnapshot("unsupported");
          }
          throw error;
        }
        signal.throwIfAborted();
        const raw = object(result);
        if (raw.sessionId !== nativeSessionId) throw new Error("Session integrations unavailable");
        if (Buffer.byteLength(JSON.stringify(raw), "utf8") > SESSION_INTEGRATIONS_LIMITS.bytes) throw new Error("Session integrations unavailable");
        return projectPiIntegrations(raw.snapshot);
      } catch {
        if (performance.now() - started >= SESSION_INTEGRATIONS_LIMITS.readMs - 5) stalled = true;
        throw new Error("Session integrations unavailable");
      } finally { reading = false; }
    })();
    return new Promise<RuntimeIntegrationSnapshot>((resolve, reject) => {
      const abort = () => reject(new DOMException("Session integration read aborted", "AbortError"));
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
      void task.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
    });
  };
}
