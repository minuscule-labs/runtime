import assert from "node:assert/strict";
import test from "node:test";
import type { AgentStatus } from "@minu/runtime-core";
import { createPiBridgeServer } from "../src/server.js";

function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((accept, fail) => { resolve = accept; reject = fail; });
  return { promise, resolve, reject };
}

for (const phase of ["preparing", "dispatched"] as const) {
  for (const outcome of ["resolve", "reject"] as const) {
    test(`stale canceled finalizer cannot clear reused-ID ${phase} state after ${outcome}`, async () => {
      const oldRead = deferred();
      const oldReadSettled = deferred();
      const newWork = deferred();
      const newEntered = deferred();
      const sent: string[] = [];
      const messages = [{ role: "assistant" as const, content: "initial" }];
      let status: AgentStatus = "idle";
      let reads = 0;
      let interrupts = 0;
      let stops = 0;
      const bridge = await createPiBridgeServer({
        sessionId: "retention", token: "test", turnRetentionLimit: 1, stopRequiresIdle: true,
        getStatus: () => status,
        async getMessages() {
          const read = reads++;
          if (read === 0) {
            try { await oldRead.promise; } finally { oldReadSettled.resolve(); }
          }
          if (read === 3 && phase === "preparing") { newEntered.resolve(); await newWork.promise; }
          return [...messages];
        },
        async send(input) {
          sent.push(input);
          if (input === "new instance" && phase === "dispatched") {
            status = "working";
            newEntered.resolve();
            await newWork.promise;
          }
          messages.push({ role: "assistant", content: input });
          status = "idle";
        },
        async interrupt() { interrupts += 1; status = "idle"; newWork.resolve(); },
        stop() { stops += 1; },
      });
      const request = (path: string, body?: unknown) => fetch(`${bridge.endpoint}${path}`, {
        headers: { authorization: "Bearer test" }, ...(body ? { method: "POST", body: JSON.stringify(body) } : {}),
      });
      const turn = async (id: string) => (await (await request(`/turns/${id}`)).json() as { turn: { status: string; input: string } | null }).turn;
      const waitForStatus = async (id: string, expected: string) => {
        for (let attempt = 0; attempt < 100; attempt += 1) {
          if ((await turn(id))?.status === expected) return;
          await new Promise((resolve) => setTimeout(resolve, 5));
        }
        throw new Error(`Turn ${id} did not become ${expected}`);
      };
      try {
        assert.equal((await request("/turns", { turnId: "reused", input: "old instance" })).status, 202);
        assert.equal((await request("/interrupt", {})).status, 202);
        assert.equal((await request("/turns", { turnId: "filler", input: "filler" })).status, 202);
        await waitForStatus("filler", "completed");
        assert.equal(await turn("reused"), null, "The original ID must actually be evicted");

        assert.equal((await request("/turns", { turnId: "reused", input: "new instance" })).status, 202);
        await newEntered.promise;
        if (outcome === "resolve") oldRead.resolve(); else oldRead.reject(new Error("stale read failed"));
        await oldReadSettled.promise;
        // An HTTP round trip crosses the stale finalizer's microtask boundary.
        assert.equal((await turn("reused"))?.status, "running");
        assert.equal((await request("/turns", { turnId: "intruder", input: "intruder" })).status, 409);
        assert.equal((await request("/send", { input: "intruder" })).status, 409);
        assert.equal((await request("/stop", {})).status, 409);
        assert.equal(stops, 0);
        assert.equal((await request("/interrupt", {})).status, 202);
        assert.equal(interrupts, phase === "dispatched" ? 1 : 0, "Dispatched work still requires its native interrupt");
        newWork.resolve();
        await waitForStatus("reused", "interrupted");
        assert.deepEqual(sent, phase === "dispatched" ? ["filler", "new instance"] : ["filler"]);
      } finally {
        oldRead.resolve();
        newWork.resolve();
        await bridge.close();
      }
    });
  }
}
