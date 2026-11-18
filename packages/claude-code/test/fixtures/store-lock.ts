import { ClaudeCodeManagedStore } from "../../src/managed-store.js";

const [root, id, ownerId, mode, revision] = process.argv.slice(2);
const store = new ClaudeCodeManagedStore(root);
try {
  if (mode === "hold") {
    await store.withSessionLock(id, ownerId, async () => {
      process.send?.({ type: "held" });
      await new Promise<void>(resolve => process.once("message", () => resolve()));
    });
    process.send?.({ type: "released" }, () => process.disconnect());
  } else {
    const result = await store.update(id, ownerId, Number(revision), { generation: "child-generation" });
    process.send?.({ type: "updated", result }, () => process.disconnect());
  }
} catch (error) {
  process.send?.({ type: "failed", name: error instanceof Error ? error.constructor.name : "Error" }, () => process.disconnect());
}
