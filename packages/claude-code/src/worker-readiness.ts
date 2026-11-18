import { setTimeout as delay } from "node:timers/promises";
import { ClaudeCodeManagedStore } from "./managed-store.js";
import { ClaudeCodeWorkerClient } from "./worker-client.js";
import { ClaudeCodeWorkerError } from "./worker-protocol.js";
import {
  decodeClaudeCodeWorkerRegistration, encodeClaudeCodeWorkerRegistration,
  type ClaudeCodeWorkerRegistrationScope,
} from "./worker-registration.js";

export type ClaudeCodeWorkerReadiness = { state: "ready"; status: "idle" | "working" } | { state: "unavailable" };
export interface ClaudeCodeWorkerReadinessOptions {
  store: ClaudeCodeManagedStore;
  scope: ClaudeCodeWorkerRegistrationScope;
  registration: Uint8Array;
  timeoutMs?: number;
  signal?: AbortSignal;
}

/** Read-only readiness snapshot for ONE exact published worker, not discovery or
 * future authority. Pending remains native-lazy; ready is not model/auth/history
 * or physical-exit proof. No start, input, metadata mutation, retry of a mutation,
 * cleanup or fallback. Lock/OS reads finish cooperatively; expired results cannot
 * become ready. Never hold the lifecycle lease across HTTP (worker admission
 * needs that same lease). Every later command must re-admit independently. */
export async function waitForClaudeCodeWorkerReady(options: ClaudeCodeWorkerReadinessOptions): Promise<ClaudeCodeWorkerReadiness> {
  const { store, signal } = options, timeout = options.timeoutMs ?? 5_000;
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 30_000) throw new Error("Invalid Claude Code readiness deadline");
  const end = performance.now() + timeout;
  const cancelled = () => { if (signal?.aborted) throw new DOMException("Claude Code readiness check cancelled", "AbortError"); };
  const remaining = () => {
    cancelled();
    const value = Math.ceil(end - performance.now());
    if (value < 1) throw new Error("Claude Code readiness unavailable");
    return value;
  };
  try {
    cancelled();
    // Snapshot caller-owned scope/bytes synchronously, before the first await.
    const scope = { ...options.scope };
    const registration = decodeClaudeCodeWorkerRegistration(options.registration, scope);
    const bytes = encodeClaudeCodeWorkerRegistration(registration, scope);
    // Do not create a missing owner/session merely to acquire its admission lock.
    const manifest = await store.read(scope.sessionId, scope.ownerId);
    remaining();
    if (!manifest) return { state: "unavailable" };
    while (true) {
      await store.withWorkerAdmission(scope, bytes, async () => {}, remaining());
      const client = new ClaudeCodeWorkerClient(registration, remaining());
      let status;
      try { status = await client.status(signal); }
      catch (error) {
        remaining();
        // The existing pre-initialization bridge gate returns 503. Only repeat
        // this read-only observation, never another endpoint or a launch action.
        if (!(error instanceof ClaudeCodeWorkerError) || error.code !== "http_503") return { state: "unavailable" };
        await delay(Math.min(25, remaining()), undefined, { signal });
        continue;
      }
      remaining();
      if (status === "offline") return { state: "unavailable" };
      // Revalidate after the reply; a late healthy response cannot revive a revoked
      // generation, human fence or replaced descriptor.
      await store.withWorkerAdmission(scope, bytes, async () => {}, remaining());
      remaining();
      return { state: "ready", status };
    }
  } catch {
    cancelled();
    return { state: "unavailable" };
  }
}
