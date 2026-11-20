import { randomUUID } from "node:crypto";
import type { McpServerStatus } from "@anthropic-ai/claude-agent-sdk";
import { SESSION_EVENT_CODES, SESSION_EVENTS_LIMITS, SESSION_INTEGRATIONS_LIMITS, sessionEvents, sessionIntegrations, sessionProfile,
  type AgentReasoningLevel, type RuntimeIntegrationSnapshot, type RuntimeSessionEvent, type RuntimeSessionEventCode,
  type RuntimeSessionEvents, type RuntimeSessionProfile } from "@minu/runtime-core";

/** Fixed codes only, scoped to this worker; never accepts raw payloads or caller IDs. Observation never fails work. */
export class ClaudeCodeSessionEventLog {
  private readonly recordingSince = new Date().toISOString();
  private readonly events: RuntimeSessionEvent[] = [];
  private sequence = 0;
  private failed = false;
  record(code: RuntimeSessionEventCode): void {
    if (this.failed) return;
    try {
      if (!SESSION_EVENT_CODES.includes(code) || this.sequence >= Number.MAX_SAFE_INTEGER) throw new Error("Unavailable");
      this.events.push({ sequence: ++this.sequence, observedAt: new Date().toISOString(), code });
      if (this.events.length > SESSION_EVENTS_LIMITS.events) this.events.shift();
    } catch { this.failed = true; this.events.length = 0; }
  }
  snapshot(): RuntimeSessionEvents {
    if (this.failed) throw new Error("Claude Code session events unavailable");
    return sessionEvents({ version: 1, source: "runtime_bridge", capturedAt: new Date().toISOString(),
      recordingSince: this.recordingSince, eventsDropped: this.sequence - this.events.length, events: this.events });
  }
}

/** What the live engine reported for one session. Anything not observed stays not_verified (never launch-time promises). */
export interface ClaudeCodeObservedProfile { model?: string; reasoning?: AgentReasoningLevel; skills?: string[] }
export function claudeCodeProfile(observed: ClaudeCodeObservedProfile | undefined): RuntimeSessionProfile {
  return sessionProfile({ version: 1, capturedAt: new Date().toISOString(),
    model: observed?.model ? { status: "verified", provider: "anthropic", id: observed.model } : { status: "not_verified" },
    reasoning: observed?.reasoning ? { status: "verified", level: observed.reasoning } : { status: "not_verified" },
    skills: observed?.skills ? { status: "verified", commandIds: observed.skills, complete: true } : { status: "not_verified" } });
}

const identifier = (value: string) => { const safe = value.replace(/[^a-zA-Z0-9_.-]/g, "_").replace(/\.\.+/g, "_").replace(/^[^a-zA-Z0-9]+/, "m"); return (safe || "mcp").slice(0, 200); };
const SOURCES: Record<string, "user" | "project" | "extension"> = { user: "user", project: "project", local: "project", plugin: "extension" };
const CONNECTIONS: Record<McpServerStatus["status"], "connected" | "failed" | "authentication_required" | "connecting" | "disabled"> =
  { connected: "connected", failed: "failed", "needs-auth": "authentication_required", pending: "connecting", disabled: "disabled" };

/** MCP servers only (built-in tools are not integrations). Names, counts and states; never configs, URLs, errors, schemas or descriptions. */
export function projectClaudeCodeIntegrations(statuses: unknown, workerId = randomUUID()): RuntimeIntegrationSnapshot {
  const list = Array.isArray(statuses) ? statuses as McpServerStatus[] : [];
  const used = new Set<string>(), integrations: unknown[] = [], tools: unknown[] = [];
  let complete = Array.isArray(statuses);
  for (const entry of list.slice(0, SESSION_INTEGRATIONS_LIMITS.integrations)) {
    if (!entry || typeof entry.name !== "string" || !(entry.status in CONNECTIONS)) { complete = false; continue; }
    let id = identifier(entry.name); for (let n = 2; used.has(id); n++) id = `${identifier(entry.name).slice(0, 190)}_${n}`;
    used.add(id);
    const connection = CONNECTIONS[entry.status], listed = Array.isArray(entry.tools) ? entry.tools : [];
    const known = entry.status === "connected" && Array.isArray(entry.tools);
    if (!known && entry.status !== "disabled") complete = false;
    for (const tool of listed) if (tool && typeof tool.name === "string") tools.push({ name: identifier(tool.name), integrationId: id, visibility: "declared", routes: ["model"], reachability: "reachable" });
    integrations.push({ id, name: id, kind: "mcp", source: SOURCES[String(entry.source ?? entry.scope)] ?? "unknown",
      configured: entry.status === "disabled" ? "disabled" : "enabled", connection,
      toolCoverage: known ? "complete" : entry.status === "disabled" ? "complete" : "unknown",
      ...(entry.status === "failed" ? { failureCode: "connection_failed" } : entry.status === "needs-auth" ? { failureCode: "authentication_required" } : {}),
      ...(known ? { offeredCount: listed.length, registeredCount: listed.length, callableCount: listed.length, reachableCount: listed.length } : {}) });
  }
  if (list.length > SESSION_INTEGRATIONS_LIMITS.integrations) complete = false;
  return sessionIntegrations({ version: 1, capturedAt: new Date().toISOString(), status: "available", workerId,
    coverage: { configuration: Array.isArray(statuses) ? "complete" : "unknown", tools: complete ? "complete" : "partial" },
    operations: { inspect: "supported", reconnect: "unsupported", reloadConfiguration: "unsupported" },
    integrations, tools, issues: [] });
}
