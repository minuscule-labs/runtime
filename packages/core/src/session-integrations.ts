/** Harness-neutral, presentation-safe observations. Native IDs/configuration never cross this contract. */
export type RuntimeIntegrationCoverage = "complete" | "partial" | "unknown";
export type RuntimeIntegrationSupport = "supported" | "unsupported" | "unknown";
export const SESSION_INTEGRATIONS_LIMITS = { bytes: 128 * 1024, readMs: 2_000, integrations: 128, tools: 512 } as const;
export const INTEGRATION_ISSUE_CODES = ["configuration_invalid", "connection_failed", "authentication_required", "discovery_failed", "registration_failed", "provider_unavailable", "invalid_observation", "truncated"] as const;
export type RuntimeIntegrationIssue = typeof INTEGRATION_ISSUE_CODES[number];
export interface RuntimeIntegration {
  id: string;
  name: string;
  kind: "mcp" | "native" | "other";
  source: "user" | "project" | "extension" | "native" | "unknown";
  configured: "enabled" | "disabled" | "unknown";
  connection: "disabled" | "connecting" | "connected" | "disconnected" | "authentication_required" | "failed" | "closed" | "not_applicable" | "unknown";
  toolCoverage: RuntimeIntegrationCoverage;
  failureCode?: "connection_failed" | "authentication_required" | "discovery_failed" | "registration_failed";
  offeredCount?: number;
  registeredCount?: number;
  callableCount?: number;
  reachableCount?: number;
}
export interface RuntimeIntegrationTool {
  name: string;
  integrationId?: string;
  visibility: "declared" | "discoverable" | "hidden" | "unknown";
  routes: Array<"model" | "indirect">;
  /** Route evidence, not authorization to execute a business request. */
  reachability: "reachable" | "not_reachable" | "unknown";
}
export interface RuntimeIntegrationSnapshot {
  version: 1;
  capturedAt: string;
  status: "available" | "partial" | "unsupported" | "unavailable";
  /** Opaque per-worker observation identity; not a native session ID, PID, or endpoint. */
  workerId?: string;
  coverage: { configuration: RuntimeIntegrationCoverage; tools: RuntimeIntegrationCoverage };
  operations: { inspect: RuntimeIntegrationSupport; reconnect: RuntimeIntegrationSupport; reloadConfiguration: RuntimeIntegrationSupport };
  integrations: RuntimeIntegration[];
  tools: RuntimeIntegrationTool[];
  issues: RuntimeIntegrationIssue[];
}
const object = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const identifier = (value: unknown): value is string => typeof value === "string" && value.length <= 256 && /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(value) && !value.includes("..");
const coverage = (value: unknown): RuntimeIntegrationCoverage => value === "complete" || value === "partial" ? value : "unknown";
const support = (value: unknown): RuntimeIntegrationSupport => value === "supported" || value === "unsupported" ? value : "unknown";

export function unavailableIntegrationSnapshot(status: "unsupported" | "unavailable"): RuntimeIntegrationSnapshot {
  return { version: 1, capturedAt: new Date().toISOString(), status,
    coverage: { configuration: "unknown", tools: "unknown" },
    operations: { inspect: status === "unsupported" ? "unsupported" : "unknown", reconnect: "unknown", reloadConfiguration: "unknown" },
    integrations: [], tools: [], issues: [] };
}

/** Explicit reconstruction is required at every transport boundary. Do not spread native snapshots. */
export function sessionIntegrations(input: unknown): RuntimeIntegrationSnapshot {
  const raw = object(input);
  if (raw.version !== 1 || typeof raw.capturedAt !== "string" || raw.capturedAt.length !== 24
    || !Number.isFinite(Date.parse(raw.capturedAt)) || new Date(raw.capturedAt).toISOString() !== raw.capturedAt
    || !["available", "partial", "unsupported", "unavailable"].includes(String(raw.status))) throw new Error("Session integrations unavailable");
  const rawCoverage = object(raw.coverage), operations = object(raw.operations);
  const snapshot: RuntimeIntegrationSnapshot = { version: 1, capturedAt: raw.capturedAt, status: raw.status as RuntimeIntegrationSnapshot["status"],
    ...(typeof raw.workerId === "string" && /^[a-f0-9-]{36}$/.test(raw.workerId) ? { workerId: raw.workerId } : {}),
    coverage: { configuration: coverage(rawCoverage.configuration), tools: coverage(rawCoverage.tools) },
    operations: { inspect: support(operations.inspect), reconnect: support(operations.reconnect), reloadConfiguration: support(operations.reloadConfiguration) },
    integrations: [], tools: [], issues: [] };
  const issues = new Set<RuntimeIntegrationIssue>();
  if (Array.isArray(raw.issues)) for (const issue of raw.issues.slice(0, 32)) {
    if (INTEGRATION_ISSUE_CODES.includes(issue as RuntimeIntegrationIssue)) issues.add(issue as RuntimeIntegrationIssue);
    else issues.add("invalid_observation");
  }
  let invalidConfiguration = !Array.isArray(raw.integrations), invalidTools = !Array.isArray(raw.tools);
  const entries = Array.isArray(raw.integrations) ? raw.integrations : [];
  const tools = Array.isArray(raw.tools) ? raw.tools : [];
  if (entries.length > SESSION_INTEGRATIONS_LIMITS.integrations || tools.length > SESSION_INTEGRATIONS_LIMITS.tools) issues.add("truncated");
  for (const value of entries.slice(0, SESSION_INTEGRATIONS_LIMITS.integrations)) {
    const entry = object(value);
    if (!identifier(entry.id) || !identifier(entry.name) || snapshot.integrations.some(item => item.id === entry.id)) { invalidConfiguration = true; continue; }
    const integration: RuntimeIntegration = { id: entry.id, name: entry.name,
      kind: entry.kind === "mcp" || entry.kind === "native" ? entry.kind : "other",
      source: ["user", "project", "extension", "native"].includes(String(entry.source)) ? entry.source as RuntimeIntegration["source"] : "unknown",
      configured: entry.configured === "enabled" || entry.configured === "disabled" ? entry.configured : "unknown",
      connection: ["disabled", "connecting", "connected", "disconnected", "authentication_required", "failed", "closed", "not_applicable"].includes(String(entry.connection)) ? entry.connection as RuntimeIntegration["connection"] : "unknown",
      toolCoverage: coverage(entry.toolCoverage) };
    if (typeof entry.failureCode === "string" && ["connection_failed", "authentication_required", "discovery_failed", "registration_failed"].includes(entry.failureCode)) integration.failureCode = entry.failureCode as RuntimeIntegration["failureCode"];
    for (const key of ["offeredCount", "registeredCount", "callableCount", "reachableCount"] as const) {
      if (typeof entry[key] === "number" && Number.isSafeInteger(entry[key]) && entry[key] >= 0) integration[key] = entry[key];
    }
    snapshot.integrations.push(integration);
  }
  for (const value of tools.slice(0, SESSION_INTEGRATIONS_LIMITS.tools)) {
    const tool = object(value);
    if (!identifier(tool.name) || snapshot.tools.some(item => item.name === tool.name)) { invalidTools = true; continue; }
    let routes = Array.isArray(tool.routes) ? [...new Set(tool.routes.filter((route): route is "model" | "indirect" => route === "model" || route === "indirect"))] : [];
    let reachability: RuntimeIntegrationTool["reachability"] = tool.reachability === "reachable" || tool.reachability === "not_reachable" ? tool.reachability : "unknown";
    if (tool.visibility === "hidden") {
      if (routes.length || reachability === "reachable") invalidTools = true;
      routes = []; reachability = "not_reachable";
    } else if (reachability === "reachable" && routes.length === 0) { reachability = "unknown"; invalidTools = true; }
    snapshot.tools.push({ name: tool.name,
      ...(identifier(tool.integrationId) && snapshot.integrations.some(item => item.id === tool.integrationId) ? { integrationId: tool.integrationId } : {}),
      visibility: tool.visibility === "declared" || tool.visibility === "discoverable" || tool.visibility === "hidden" ? tool.visibility : "unknown",
      routes, reachability });
  }
  if (invalidConfiguration || invalidTools) issues.add("invalid_observation");
  if (entries.length > SESSION_INTEGRATIONS_LIMITS.integrations || invalidConfiguration) snapshot.coverage.configuration = "partial";
  if (tools.length > SESSION_INTEGRATIONS_LIMITS.tools || invalidTools) snapshot.coverage.tools = "partial";
  snapshot.issues = [...issues];
  // Reserve the HTTP envelope and permit safe truncation rather than discarding a useful partial read.
  while (new TextEncoder().encode(JSON.stringify(snapshot)).byteLength > SESSION_INTEGRATIONS_LIMITS.bytes - 512) {
    if (snapshot.tools.length) { snapshot.tools.pop(); snapshot.coverage.tools = "partial"; }
    else if (snapshot.integrations.length) { snapshot.integrations.pop(); snapshot.coverage.configuration = "partial"; }
    else throw new Error("Session integrations unavailable");
    if (!snapshot.issues.includes("truncated")) snapshot.issues.push("truncated");
  }
  if (snapshot.status === "unsupported" || snapshot.status === "unavailable") {
    snapshot.coverage = { configuration: "unknown", tools: "unknown" };
    snapshot.integrations = []; snapshot.tools = [];
    if (snapshot.status === "unsupported") snapshot.operations.inspect = "unsupported";
  } else if (snapshot.issues.length || snapshot.coverage.configuration !== "complete" || snapshot.coverage.tools !== "complete") snapshot.status = "partial";
  if (snapshot.coverage.tools !== "complete") for (const integration of snapshot.integrations) integration.toolCoverage = "partial";
  return snapshot;
}
