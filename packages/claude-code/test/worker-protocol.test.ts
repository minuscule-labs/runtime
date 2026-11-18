import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ClaudeCodeWorkerError, envelope, unseal, workerAcknowledgment, workerActivity,
  workerCapabilities, workerEvent, workerMessage, workerStatus, workerTurn,
} from "../src/worker-protocol.js";

const identity = { sessionId: "logical-id", ownerId: "owner", generation: "generation" };
const now = new Date().toISOString();
const turn = { id: "turn", input: "input", status: "completed", createdAt: now, updatedAt: now,
  response: { role: "assistant", content: "answer" } };

test("worker response projections reject malformed contracts and discard unrequested metadata", () => {
  assert.equal(unseal(identity, envelope(identity, "idle")), "idle");
  assert.throws(() => unseal(identity, envelope({ ...identity, generation: "other" }, "idle")), ClaudeCodeWorkerError);
  assert.equal(workerStatus("working"), "working");
  assert.deepEqual(workerTurn({ ...turn, rawInput: "PRIVATE", response: { ...turn.response, provider: "PRIVATE" } }), turn);
  assert.deepEqual(workerMessage({ role: "tool", content: "result", toolName: "Read", raw: "PRIVATE" }), { role: "tool", content: "result", toolName: "Read" });
  assert.deepEqual(workerActivity({ phase: "working", observedAt: now, prompt: "PRIVATE" }), { phase: "working", observedAt: now });
  const event = { type: "message_delta", sessionId: identity.sessionId, timestamp: now, delta: "text" };
  assert.deepEqual(workerEvent({ ...event, token: "PRIVATE" }, identity.sessionId), event);
  workerAcknowledgment({ acknowledged: true });
  for (const invalid of [null, {}, { acknowledged: false }, { acknowledged: "true" }]) assert.throws(() => workerAcknowledgment(invalid), ClaudeCodeWorkerError);
  for (const invalid of [null, "unknown", {}]) assert.throws(() => workerStatus(invalid), ClaudeCodeWorkerError);
  for (const patch of [{ status: "private-native-error" }, { id: "" }, { updatedAt: "invalid" }, { response: { role: "assistant", content: 42 } }]) {
    assert.throws(() => workerTurn({ ...turn, ...patch }), ClaudeCodeWorkerError);
  }
  assert.throws(() => workerEvent({ ...event, sessionId: "wrong" }, identity.sessionId), ClaudeCodeWorkerError);
  assert.throws(() => workerEvent({ ...event, type: "unknown" }, identity.sessionId), ClaudeCodeWorkerError);
  assert.throws(() => workerEvent({ ...event, type: "tool_completed", isError: "false" }, identity.sessionId), ClaudeCodeWorkerError);
  assert.throws(() => workerActivity({ phase: "tool:PRIVATE", observedAt: now }), ClaudeCodeWorkerError);
  assert.throws(() => workerMessage({ role: "reasoning", content: "PRIVATE" }), ClaudeCodeWorkerError);
  assert.equal(workerCapabilities(null), null);
  const capabilities = { version: 1, safeActivityEvents: true, interrupt: true, reconnectExisting: true,
    interactiveAttach: false, openDiagnostic: false, liveSkillVerification: false };
  assert.deepEqual(workerCapabilities({ ...capabilities, nativePath: "PRIVATE" }), capabilities);
  assert.throws(() => workerCapabilities({ ...capabilities, interrupt: "true" }), ClaudeCodeWorkerError);
});
