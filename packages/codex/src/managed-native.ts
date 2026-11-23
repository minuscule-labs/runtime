import { realpath } from "node:fs/promises";
import { resolve } from "node:path";
import type { AgentSession, AgentStartConfig, ManagedAgentSession } from "@minu/runtime-core";
import { CodexAgentRuntime, type CodexAgentRuntimeOptions } from "./client.js";
import { CodexManagedStore, CodexManifestConflictError, assertCodexWorkerClaim, type CodexManagedManifest } from "./managed-store.js";
import type { CodexWorkerClaim } from "./worker-identity.js";
import { validateCodexConfig } from "./native-capabilities.js";

export interface CodexManagedIdentity {
  id: string;
  ownerId: string;
  generation: string;
}

/** Internal preparation only: saves identity/policy, not a live or validated native session. */
export async function createPendingCodexSession(
  store: CodexManagedStore,
  identity: CodexManagedIdentity,
  config: AgentStartConfig,
  sandbox: "read-only" | "workspace-write" | "danger-full-access" = "read-only",
  version: 4 | 5 = 4,
): Promise<ManagedAgentSession> {
  validateCodexConfig(config);
  const manifest: CodexManagedManifest = JSON.parse(JSON.stringify({
    ...identity, version, runtime: "codex", revision: 0, requiresExplicitResume: false,
    native: { state: "pending" }, worker: { state: "none" }, launchConfig: { ...config, cwd: resolve(config.cwd ?? process.cwd()) },
    sandbox, createdAt: new Date().toISOString(),
  }));
  // Snapshotted above, before any await. Canonical before anything is persisted: the store and worker require a
  // real path (macOS /tmp is a symlink); a missing workspace fails here.
  manifest.launchConfig.cwd = await realpath(manifest.launchConfig.cwd);
  await store.create(manifest);
  return { id: manifest.id, ownerId: manifest.ownerId, runtime: "codex", ownership: "owned", cwd: manifest.launchConfig.cwd };
}

export interface CodexNativeAllocation {
  runtime: CodexAgentRuntime;
  /** Private in-process address; it is not the stable managed Runtime ID. */
  session: AgentSession;
  threadId: string;
}

/** A failed allocation must retain shutdown authority if cleanup could not confirm exit. */
export class CodexNativeCleanupError extends Error {
  constructor(readonly allocation: CodexNativeAllocation) {
    super("Codex native allocation exit could not be confirmed");
  }
}

/** Internal one-shot first-use primitive, not turn admission or worker registration.
 * The caller must already own the worker generation. Before any input is sent,
 * persist intent, launch/validate one thread, and bind its exact native ID.
 * An interrupted/failed allocation stays creating/bound; never auto-recreate it.
 */
export async function allocatePendingCodexThread(
  store: CodexManagedStore,
  identity: CodexManagedIdentity,
  options: Omit<CodexAgentRuntimeOptions, "sandbox"> = {},
  claim?: CodexWorkerClaim,
): Promise<CodexNativeAllocation> {
  // Caller mutation cannot change which identity is checked after lock acquisition.
  identity = { ...identity };
  options = { ...options, ...(options.args ? { args: [...options.args] } : {}) };
  claim = claim ? { ...claim } : undefined;
  let allocated: CodexNativeAllocation | undefined;
  try {
    return await store.withSessionLock(identity.id, identity.ownerId, async lease => {
      const manifest = await store.read(identity.id, identity.ownerId);
      if (!manifest || manifest.generation !== identity.generation || manifest.requiresExplicitResume) {
        throw new CodexManifestConflictError("Codex managed identity is unavailable or fenced");
      }
      assertCodexWorkerClaim(manifest, claim);
      if (manifest.native.state !== "pending") {
        throw new CodexManifestConflictError("Codex native creation is already bound or uncertain");
      }
      // Once this commits, all subsequent failures are uncertain. There is no
      // rollback to pending, including when startup fails before a native reply.
      const creating = await lease.beginNativeCreation(manifest.revision);
      try {
        const runtime = new CodexAgentRuntime({ ...options, sandbox: manifest.sandbox });
        const native = await runtime.createNativeThread(manifest.launchConfig);
        allocated = { runtime, session: native.session, threadId: native.threadId };
        await lease.bindNativeThread(creating.revision, native.threadId);
        return allocated;
      } catch (error) {
        // A failed binding must stop its process before releasing the lifecycle lock.
        if (allocated) {
          try { await allocated.runtime.stop(allocated.session.id); }
          catch { throw new CodexNativeCleanupError(allocated); }
        }
        throw error;
      }
    });
  } catch (error) {
    // This also covers a binding fsync or lock-release failure after publication.
    // Do not return a live process unless the complete locked operation succeeded.
    if (error instanceof CodexNativeCleanupError) throw error;
    if (allocated) {
      try { await allocated.runtime.stop(allocated.session.id); }
      catch { throw new CodexNativeCleanupError(allocated); }
    }
    throw error;
  }
}
