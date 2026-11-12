import { CodexManagedStore, type CodexManifestLease } from "../../src/managed-store.js";
import { CodexRpcProcess } from "../../src/rpc.js";

// Child-only fault probes; no production failure-injection hooks.
const mode = process.argv[2];
const original = CodexManagedStore.prototype.withSessionLock;
CodexManagedStore.prototype.withSessionLock = async function<T>(
  id: string, ownerId: string, operation: (lease: CodexManifestLease) => Promise<T>, timeoutMs?: number,
): Promise<T> {
  const result = await original.call(this, id, ownerId, async lease => operation(
    mode === "binding-cleanup-unconfirmed"
      ? { ...lease, bindNativeThread: async () => { throw new Error("Injected binding failure"); } }
      : lease,
  ), timeoutMs) as T;
  if (mode === "fence-before-dispatch" && result && typeof (result as any).threadId === "string" && (result as any).runtime) {
    const manifest = await this.read(id, ownerId);
    await this.update(id, ownerId, manifest!.revision, { generation: "replacement-generation" });
  }
  return result;
};
if (mode === "startup-cleanup-unconfirmed" || mode === "binding-cleanup-unconfirmed") {
  CodexRpcProcess.prototype.stop = () => Promise.reject(new Error("Injected unconfirmed native exit"));
}
await import("../../src/owned-worker.js");
