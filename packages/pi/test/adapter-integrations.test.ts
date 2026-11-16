import assert from "node:assert/strict";
import test from "node:test";
import { unavailableIntegrationSnapshot, sessionIntegrations, type AgentRuntime } from "@minu/runtime-core";

test("adapters may omit integration inspection without implying absence", () => {
  const runtime: Pick<AgentRuntime, "inspectSessionIntegrations"> = {};
  assert.equal(runtime.inspectSessionIntegrations, undefined);
  const result = sessionIntegrations(unavailableIntegrationSnapshot("unsupported"));
  assert.equal(result.status, "unsupported");
  assert.equal(result.operations.inspect, "unsupported");
  assert.deepEqual(result.coverage, { configuration: "unknown", tools: "unknown" });
});

test("partial adapter observations need no Pi/MCP or lifecycle implementation", () => {
  const result = sessionIntegrations({ version: 1, capturedAt: new Date().toISOString(), status: "partial",
    coverage: { configuration: "unknown", tools: "partial" },
    operations: { inspect: "supported", reconnect: "unsupported", reloadConfiguration: "unknown" },
    integrations: [{ id: "native_extension", name: "native_extension", kind: "native", source: "native", configured: "unknown", connection: "not_applicable", toolCoverage: "unknown" }],
    tools: [{ name: "native_tool", integrationId: "native_extension", visibility: "unknown", routes: ["model"], reachability: "unknown" }], issues: [] });
  assert.equal(result.integrations[0]?.kind, "native");
  assert.equal(result.integrations[0]?.offeredCount, undefined);
  assert.equal(result.integrations[0]?.registeredCount, undefined);
  assert.equal(result.operations.reloadConfiguration, "unknown");
});
