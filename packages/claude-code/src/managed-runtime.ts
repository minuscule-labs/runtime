import { randomUUID } from "node:crypto";
import { lstat, realpath } from "node:fs/promises";
import type { Socket } from "node:net";
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ChildProcess } from "node:child_process";
import { runtimeInput, type AgentRuntime, type AgentStartConfig, type ManagedAgentSession, type ManagedSessionSummary,
  type RuntimeImageContent, type RuntimeActivityOptions } from "@minu/runtime-core";
import { ClaudeCodeManagedStore, type ClaudeCodeManagedManifest } from "./managed-store.js";
import { decodeClaudeCodeWorkerBootstrap, type ClaudeCodeWorkerBootstrap } from "./worker-entry.js";
import { launchClaudeCodeWorker } from "./worker-launch.js";
import { waitForClaudeCodeWorkerReady } from "./worker-readiness.js";
import { ClaudeCodeWorkerClient } from "./worker-client.js";
import { workerIdentity, type ClaudeCodeWorkerConnection } from "./worker-protocol.js";
import { recoverClaudeCodeWorker } from "./worker-recovery.js";
import { claudeCodeCleanHistory, claudeCodeLiveWorker, prepareClaudeCodeResume, suspendClaudeCodeWorker } from "./worker-lifecycle.js";

export interface ClaudeCodeManagedRuntimeOptions {
  /** One exact owner per controller instance. Never discovers another owner's sessions. */
  ownerId: string;
  storeRoot: string;
  /** Existing owner-private canonical native config root. Authentication stays native-owned. */
  nativeConfigRoot: string;
  nativeOptions: ClaudeCodeWorkerBootstrap["nativeOptions"];
  /** Trusted host overrides, not user/tool-selected commands. Must obey the family contract. */
  workerExecutable?: string;
  nodeExecutable?: string;
  timeoutMs?: number;
}
const unavailable = () => new Error("Claude Code managed operation unavailable");

/** Durable text-only controller. Native owns its loop/tools/auth. Forced recovery is explicit
 * (forceStopManaged/destroy) and absence-proven; no configuration inheritance, transcript repair, input replay or durable turn ledger. */
export class ClaudeCodeManagedRuntime implements AgentRuntime {
  private readonly options: ClaudeCodeManagedRuntimeOptions;
  private readonly store: ClaudeCodeManagedStore;
  // Original local handles remain private, not recovered-PID control capabilities.
  private readonly ownedChildren = new Map<string, ChildProcess>();
  constructor(options: ClaudeCodeManagedRuntimeOptions) {
    try {
      this.options = structuredClone(options);
      workerIdentity({ sessionId: "validation", ownerId: options.ownerId, generation: "validation" });
      const timeout = options.timeoutMs ?? 15_000;
      if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 30_000) throw unavailable();
      if (typeof options.storeRoot !== "string" || typeof options.nativeConfigRoot !== "string"
        || !isAbsolute(options.nativeConfigRoot) || resolve(options.nativeConfigRoot) !== options.nativeConfigRoot
        || options.nativeConfigRoot.includes("\0")) throw unavailable();
      this.store = new ClaudeCodeManagedStore(options.storeRoot);
      if (!options.nativeOptions?.env || options.nativeOptions.env.CLAUDE_CONFIG_DIR !== options.nativeConfigRoot
        || ["NODE_OPTIONS", "NODE_PATH", "CLAUDE_CODE_PROJECT_DIR_NAME", "CLAUDE_CODE_RESUME_INTERRUPTED_TURN"]
          .some(key => options.nativeOptions.env[key] !== undefined)) throw unavailable();
    } catch { throw unavailable(); }
  }
  private async guard<T>(operation: () => Promise<T>): Promise<T> {
    try { return await operation(); } catch { throw unavailable(); }
  }
  private owner(ownerId: string) { if (ownerId !== this.options.ownerId) throw unavailable(); }
  private async host() {
    const entry = await realpath(this.options.workerExecutable ?? fileURLToPath(new URL("./worker-entry.js", import.meta.url)));
    if (!(await lstat(entry)).isFile()) throw unavailable();
    for (const file of [this.options.nodeExecutable, this.options.nativeOptions.executable]) {
      if (file !== undefined && !(await lstat(await realpath(file))).isFile()) throw unavailable();
    }
    const root = this.options.nativeConfigRoot, info = await lstat(root);
    if (await realpath(root) !== root || !info.isDirectory() || (info.mode & 0o077) || info.uid !== process.getuid?.()) throw unavailable();
    return entry;
  }
  private preflight(id: string, generation: string, cwd: string, entry: string): void {
    decodeClaudeCodeWorkerBootstrap(JSON.stringify({ version: 1, type: "bootstrap", storeRoot: this.options.storeRoot,
      scope: { sessionId: id, ownerId: this.options.ownerId, generation, reservationId: randomUUID(), workerExecutable: entry,
        cwd, nativeConfigRoot: this.options.nativeConfigRoot }, nativeOptions: this.options.nativeOptions }));
  }
  private nativeRoot(m: ClaudeCodeManagedManifest): void {
    if (m.policy.nativeConfigRoot !== this.options.nativeConfigRoot) throw unavailable();
  }
  private session(m: ClaudeCodeManagedManifest): ManagedAgentSession {
    return { id: m.id, ownerId: m.ownerId, runtime: "claude-code", ownership: "owned", cwd: m.launchConfig.cwd };
  }
  private async live(id: string) {
    const m = await this.store.read(id, this.options.ownerId); if (!m) throw unavailable(); this.nativeRoot(m);
    const live = claudeCodeLiveWorker(m, await this.host());
    await this.store.withWorkerAdmission(live.scope, live.bytes, async () => {});
    return { ...live, manifest: m, client: new ClaudeCodeWorkerClient(live.registration, 2_000) };
  }
  private inputClient(registration: ClaudeCodeWorkerConnection): ClaudeCodeWorkerClient {
    // First input may allocate/initialize native lazily. Short status budgets must
    // not time out a healthy SDK startup after accepting uncertain input.
    return new ClaudeCodeWorkerClient(registration, Math.min(2_147_483_647, (this.options.nativeOptions.startupTimeoutMs ?? 30_000) + 5_000));
  }
  private async launch(id: string): Promise<ManagedAgentSession> {
    const attempt = await launchClaudeCodeWorker({ storeRoot: this.options.storeRoot, sessionId: id, ownerId: this.options.ownerId,
      workerExecutable: await this.host(), nodeExecutable: this.options.nodeExecutable, nativeOptions: this.options.nativeOptions });
    if (attempt.child) {
      this.ownedChildren.set(id, attempt.child); attempt.child.unref();
      (attempt.child.stdin as Socket | null)?.unref();
    }
    if (attempt.state !== "adopted" || !attempt.registration) throw unavailable();
    if ((await waitForClaudeCodeWorkerReady({ store: this.store, scope: attempt.scope, registration: attempt.registration,
      timeoutMs: this.options.timeoutMs ?? 15_000 })).state !== "ready") throw unavailable();
    const m = await this.store.read(id, this.options.ownerId); if (!m) throw unavailable(); return this.session(m);
  }
  start(config: AgentStartConfig = {}) { return this.startManaged(config, this.options.ownerId); }
  startManaged(config: AgentStartConfig, ownerId: string): Promise<ManagedAgentSession> {
    return this.guard(async () => {
      this.owner(ownerId);
      config = structuredClone(config);
      if (!config || typeof config !== "object" || Array.isArray(config) || Object.keys(config).some(key => !["cwd", "systemPrompt", "appendSystemPrompt"].includes(key))
        || (config.systemPrompt !== undefined && config.appendSystemPrompt !== undefined)
        || [config.systemPrompt, config.appendSystemPrompt].some(value => value !== undefined && typeof value !== "string")) throw unavailable();
      const cwd = await realpath(config.cwd ?? process.cwd()), entry = await this.host(), id = randomUUID(), generation = randomUUID();
      if (!(await lstat(cwd)).isDirectory()) throw unavailable();
      // Reuse the real preflight decoder BEFORE creating launch metadata.
      this.preflight(id, generation, cwd, entry);
      await this.store.create({ version: 4, runtime: "claude-code", id, ownerId, revision: 0, generation, requiresExplicitResume: false,
        native: { state: "pending" }, worker: { state: "none" }, lastDispatch: { state: "none" }, launchConfig: { ...config, cwd },
        policy: { configuration: "isolated", permissionMode: "default", nativeConfigRoot: this.options.nativeConfigRoot, tools: ["Read", "Grep", "Glob"] }, createdAt: new Date().toISOString() });
      // A failed launch/readiness must not orphan the manifest or a worker: run the stop path, and drop the
      // record only once absence is proven. Otherwise it stays fenced and listed for a later forceStopManaged.
      try { return await this.launch(id); }
      catch (error) { await recoverClaudeCodeWorker(this.store, id, ownerId, { remove: true }).catch(() => {}); throw error; }
    });
  }
  suspend(id: string, ownerId: string): Promise<void> {
    return this.guard(async () => {
      this.owner(ownerId); const m = await this.store.read(id, ownerId); if (!m) throw unavailable(); this.nativeRoot(m);
      await suspendClaudeCodeWorker(this.store, id, ownerId, await this.host(), this.options.timeoutMs);
    });
  }
  stop(id: string) { return this.suspend(id, this.options.ownerId); }
  /** Fence, one admission-bypassing stop, then absence proof or verified termination. Never clears on uncertainty. */
  forceStopManaged(id: string, ownerId: string): Promise<void> {
    return this.guard(async () => {
      this.owner(ownerId);
      if (await recoverClaudeCodeWorker(this.store, id, ownerId) === "missing") throw unavailable();
      this.ownedChildren.delete(id);
    });
  }
  /** Stops (with absence proof) unless already stopped, then drops Runtime resume metadata; native history stays. */
  destroy(id: string, ownerId: string): Promise<void> {
    return this.guard(async () => {
      this.owner(ownerId);
      await recoverClaudeCodeWorker(this.store, id, ownerId, { remove: true });
      this.ownedChildren.delete(id);
    });
  }
  resume(id: string, ownerId: string, options?: { allowStopped?: boolean }): Promise<ManagedAgentSession> {
    return this.guard(async () => {
      this.owner(ownerId); const m = await this.store.read(id, ownerId); if (!m) throw unavailable(); this.nativeRoot(m);
      if (m.worker.state === "live" && !m.requiresExplicitResume) {
        const live = await this.live(id);
        if ((await waitForClaudeCodeWorkerReady({ store: this.store, scope: live.scope, registration: live.bytes,
          timeoutMs: this.options.timeoutMs ?? 15_000 })).state !== "ready") throw unavailable();
        return this.session(m); // Reconnect only; no launch or input replay.
      }
      if (options?.allowStopped !== true) throw unavailable();
      this.preflight(id, m.generation, m.launchConfig.cwd, await this.host());
      await prepareClaudeCodeResume(this.store, id, ownerId);
      // A failed relaunch leaves the session fenced and suspended (never a half-started occupied slot).
      try { return await this.launch(id); }
      catch (error) { await recoverClaudeCodeWorker(this.store, id, ownerId).catch(() => {}); throw error; }
    });
  }
  private async summary(m: ClaudeCodeManagedManifest, signal?: AbortSignal, requestMs = 1_000): Promise<ManagedSessionSummary> {
    signal?.throwIfAborted();
    let state: ManagedSessionSummary["state"] = "unavailable";
    if (m.worker.state === "none" && m.requiresExplicitResume) state = "suspended";
    else if (m.worker.state === "live" && requestMs > 0) try {
      this.nativeRoot(m);
      const live = claudeCodeLiveWorker(m, await this.host());
      await this.store.withWorkerAdmission(live.scope, live.bytes, async () => {});
      if (await new ClaudeCodeWorkerClient(live.registration, requestMs).status(signal) !== "offline") state = "active";
    } catch { /* Unknown/unreachable is never permission to launch/clear. */ }
    return { id: m.id, ownerId: m.ownerId, state, createdAt: m.createdAt,
      ...(state === "unavailable" ? { unavailableReason: "session_metadata_unavailable" as const } : {}) };
  }
  getManagedSession(id: string, ownerId: string, options?: { signal?: AbortSignal }): Promise<ManagedSessionSummary | undefined> {
    return this.guard(async () => { this.owner(ownerId); options?.signal?.throwIfAborted(); const m = await this.store.read(id, ownerId);
      return m && this.summary(m, options?.signal); });
  }
  listManagedSessions(ownerId: string, options?: { signal?: AbortSignal }): Promise<ManagedSessionSummary[]> {
    return this.guard(async () => {
      this.owner(ownerId); options?.signal?.throwIfAborted(); const all = await this.store.list(ownerId), result: ManagedSessionSummary[] = [];
      const end = performance.now() + 5_000;
      for (let i = 0; i < all.length; i += 8) result.push(...await Promise.all(all.slice(i, i + 8)
        .map(m => this.summary(m, options?.signal, Math.max(0, Math.min(1_000, Math.ceil(end - performance.now())))))));
      options?.signal?.throwIfAborted(); return result;
    });
  }
  startTurn(id: string, turnId: string, input: string, images?: RuntimeImageContent[]) {
    return this.guard(async () => {
      const parts = runtimeInput(input, images); if (parts.images.length || Buffer.from(parts.input).toString() !== parts.input) throw unavailable();
      if (typeof turnId !== "string" || Buffer.from(turnId).toString() !== turnId) throw unavailable();
      const live = await this.live(id), previous = live.manifest.lastDispatch;
      if (previous.state !== "none" && previous.turnId === turnId && previous.generation !== live.manifest.generation) throw unavailable();
      return this.inputClient(live.registration).startTurn(turnId, parts.input);
    });
  }
  send(id: string, input: string, images?: RuntimeImageContent[]) {
    return this.guard(async () => { const parts = runtimeInput(input, images); if (parts.images.length || Buffer.from(parts.input).toString() !== parts.input) throw unavailable();
      const live = await this.live(id); await this.inputClient(live.registration).send(parts.input); });
  }
  turn(id: string, turnId: string) { return this.guard(async () => (await this.live(id)).client.turn(turnId)); }
  status(id: string) { return this.guard(async () => {
    const m = await this.store.read(id, this.options.ownerId); if (!m) throw unavailable(); this.nativeRoot(m);
    if (m.worker.state === "none" && m.requiresExplicitResume) return "offline" as const;
    return (await this.live(id)).client.status();
  }); }
  inputCapabilities(id: string) { return this.guard(async () => (await this.live(id)).client.inputCapabilities()); }
  sessionCapabilities(id: string) { return this.guard(async () => (await this.live(id)).client.sessionCapabilities().then(value => { if (!value) throw unavailable(); return value; })); }
  capabilities() { return Promise.resolve({ models: [], reasoningLevels: [], skills: [] }); }
  steer(_id: string, _input: string): Promise<void> { return Promise.reject(new Error("Claude Code managed steering is unsupported")); }
  interrupt(id: string) {
    return this.guard(async () => { const live = await this.live(id), dispatch = live.manifest.lastDispatch;
      if (dispatch.state === "dispatching") await live.client.interrupt(dispatch.turnId);
      else if (await live.client.status() !== "idle") throw unavailable(); });
  }
  messages(id: string) {
    return this.guard(async () => {
      const m = await this.store.read(id, this.options.ownerId); if (!m) throw unavailable(); this.nativeRoot(m);
      if (m.worker.state !== "none") return (await this.live(id)).client.messages();
      return this.store.withSessionLock(id, m.ownerId, async () => {
        const current = await this.store.read(id, m.ownerId);
        if (!current || JSON.stringify(current) !== JSON.stringify(m) || !current.requiresExplicitResume) throw unavailable();
        return claudeCodeCleanHistory(current);
      });
    });
  }
  async *events(id: string, signal?: AbortSignal) {
    const abort = new AbortController(), cancel = () => abort.abort();
    signal?.addEventListener("abort", cancel, { once: true }); if (signal?.aborted) cancel();
    try { yield* (await this.live(id)).client.events(abort.signal); }
    catch { if (!signal?.aborted) throw unavailable(); }
    finally { abort.abort(); signal?.removeEventListener("abort", cancel); }
  }
  async *activityEvents(id: string, options: RuntimeActivityOptions) {
    try { yield* (await this.live(id)).client.activityEvents(options.signal); }
    catch { if (!options.signal.aborted) throw unavailable(); }
  }
}
