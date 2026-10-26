import assert from "node:assert/strict";
import test from "node:test";
import { runtimeInput, RUNTIME_INPUT_LIMITS, type RuntimeImageContent } from "@minu/runtime-core";
import { createPiBridgeServer } from "../src/server.js";

const image: RuntimeImageContent = { type: "image", data: Buffer.from("bounded pixels").toString("base64"), mimeType: "image/png" };

test("typed image input rejects paths, URLs, malformed base64, MIME and count/byte overflow", () => {
  assert.deepEqual(runtimeInput("", [image]), { input: "", images: [image] });
  assert.deepEqual(runtimeInput("legacy", undefined), { input: "legacy", images: [] });
  for (const invalid of [[{ ...image, data: "/private/image.png" }], [{ ...image, data: "https://image.invalid/" }],
    [{ ...image, data: "a===" }], [{ ...image, data: "AB==" }], [{ ...image, mimeType: "image/svg+xml" }],
    Array(5).fill(image), "not an array"]) assert.throws(() => runtimeInput("look", invalid));
  assert.throws(() => runtimeInput("", []));
  assert.throws(() => runtimeInput("a".repeat(RUNTIME_INPUT_LIMITS.textBytes + 1), []));
  const large = { ...image, data: Buffer.alloc(RUNTIME_INPUT_LIMITS.imageBytes).toString("base64") };
  assert.throws(() => runtimeInput("look", [large, large, image]), /Combined images/);
  assert.throws(() => runtimeInput("look", [{ ...large, data: Buffer.alloc(RUNTIME_INPUT_LIMITS.imageBytes + 1).toString("base64") }]), /too large/);
});

test("image turns are retry-safe, bound to ordered pixels, and never return images in polling", async () => {
  const received: RuntimeImageContent[][] = [];
  let supports = true;
  let capabilityReads = 0;
  const messages = [{ role: "assistant" as const, content: "before" }];
  const bridge = await createPiBridgeServer({
    sessionId: "image-session", token: "test", getStatus: () => "idle",
    async supportsImages() { capabilityReads += 1; await new Promise((resolve) => setTimeout(resolve, 5)); return supports; },
    async send(_input, _id, images) { received.push(images ?? []); messages.push({ role: "assistant", content: "after" }); },
    async getMessages() { return [...messages]; },
  });
  const request = (path: string, body?: unknown) => fetch(`${bridge.endpoint}${path}`, {
    headers: { authorization: "Bearer test", "content-type": "application/json" },
    ...(body ? { method: "POST", body: JSON.stringify(body) } : {}),
  });
  try {
    assert.deepEqual(await (await request("/input-capabilities")).json(), { capabilities: { version: 1, images: true } });
    const payload = { turnId: "once", input: "look", images: [image] };
    const results = await Promise.all([request("/turns", payload), request("/turns", payload)]);
    assert.deepEqual(results.map((result) => result.status).sort(), [200, 202]);
    for (const result of results) assert.doesNotMatch(await result.text(), /bounded pixels|data|mimeType/);
    let turn;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      turn = (await (await request("/turns/once")).json() as { turn: { status: string } }).turn;
      if (turn.status !== "running") break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.equal(turn?.status, "completed");
    assert.deepEqual(received, [[image]]);
    const other = { ...image, data: Buffer.from("different pixels").toString("base64") };
    assert.equal((await request("/turns", { ...payload, images: [other] })).status, 409);
    const ordered = { ...payload, turnId: "order", images: [image, other] };
    assert.equal((await request("/turns", ordered)).status, 202);
    assert.equal((await request("/turns", { ...ordered, images: [other, image] })).status, 409);
    supports = false;
    const beforeReplay = capabilityReads;
    assert.equal((await request("/turns", payload)).status, 200); // Recovery never needs the model or pixels again.
    assert.equal(capabilityReads, beforeReplay);
    assert.equal((await request("/send", { input: "look", images: [image] })).status, 400);
    assert.deepEqual(await (await request("/input-capabilities")).json(), { capabilities: { version: 1, images: false } });
  } finally { await bridge.close(); }
});

test("bridge carries images beyond the old text transport limit and sanitizes dispatch failures", async () => {
  const large = { ...image, data: Buffer.alloc(1024 * 1024).toString("base64") };
  let received: RuntimeImageContent[] | undefined;
  let fail = false;
  const bridge = await createPiBridgeServer({ sessionId: "large-image", token: "test", getStatus: () => "idle",
    async supportsImages() { return true; },
    async send(_input, _id, images) { received = images; if (fail) throw new Error(image.data); } });
  const send = () => fetch(`${bridge.endpoint}/send`, { method: "POST", headers: { authorization: "Bearer test" }, body: JSON.stringify({ input: "", images: [large] }) });
  try {
    assert.equal((await send()).status, 200);
    assert.deepEqual(received, [large]);
    fail = true;
    const failed = await send();
    assert.equal(failed.status, 500);
    assert.deepEqual(await failed.json(), { error: "Image dispatch failed" });
  } finally { await bridge.close(); }
});

test("legacy/attached bridges reject images before dispatch", async () => {
  let calls = 0;
  const bridge = await createPiBridgeServer({ sessionId: "legacy", token: "test", getStatus: () => "idle", async send() { calls += 1; } });
  try {
    const response = await fetch(`${bridge.endpoint}/send`, { method: "POST", headers: { authorization: "Bearer test" }, body: JSON.stringify({ input: "look", images: [image] }) });
    assert.equal(response.status, 400);
    assert.equal(calls, 0);
  } finally { await bridge.close(); }
});
