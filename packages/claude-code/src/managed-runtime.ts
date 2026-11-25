import { randomUUID } from "node:crypto";
import { lstat, realpath } from "node:fs/promises";
import type { Socket } from "node:net";
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ChildProcess } from "node:child_process";
import { runtimeInput, type AgentRuntime, type AgentStartConfig, type ManagedAgentSession, type ManagedSessionSummary,
  type RuntimeImageContent, type RuntimeActivityOptions, type RuntimeLaunchCapabilities } from "@minu/runtime-core";
import { CLAUDE_CODE_FORBIDDEN_ENV, ClaudeCodeAuthRequiredError, ClaudeCodeNotInstalledError, ClaudeCodeUnsupportedVersionError, claudeCodeNativeEnvironment, resolveClaudeCodeConfigRoot } from "./native-config.js";
import { claudeCodeCapabilities, validateClaudeCodeSelection, verifyClaudeCodeSelection } from "./launch-options.js";
import { resolveClaudeCodePermissions, type ClaudeCodePermissions } from "./permissions.js";
import { requireClaudeCodeAuth } from "./probe.js";
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
  /** Optional. Omitted resolves as Claude Code does ($CLAUDE_CONFIG_DIR, else ~/.claude), realpath'd and owned by this user.
   * Authentication stays native-owned: never read, copied, stored or prompted for. Never created, chmodded or written. */
  nativeConfigRoot?: string;
  /** Library default "readOnly": callers opt in to "full" (Pi parity) explicitly. Stored per session in the manifest;
   * resume uses the stored policy, and changing it needs a new session. */
  permissions?: ClaudeCodePermissions;
  /** Restore the isolated behavior (no user/project/local settings, hooks, MCP or plugins). Default: native configuration. */
  isolateConfiguration?: boolean;
  /** `env` OVERLAYS the inherited process environment; it never replaces it. */
  nativeOptions?: ClaudeCodeWorkerBootstrap["nativeOptions"];
  /** Trusted host overrides, not user/tool-selected commands. Must obey the family contract. */
  workerExecutable?: string;
  nodeExecutable?: string;
  timeoutMs?: number;
}
const unavailable = () => new Error("Claude Code managed operation unavailable");
/** The only public errors that stay distinguishable: callers show a login/install/update state for them. */
const publicError = (error: unknown) => error instanceof ClaudeCodeAuthRequiredError || error instanceof ClaudeCodeNotInstalledError
  || error instanceof ClaudeCodeUnsupportedVersionError ? error : unavailable();

/** Durable controller. Native owns its loop/tools/auth and (unless isolated) its configuration. Forced recovery is explicit
 * (forceStopManaged/destroy) and absence-proven; no transcript repair, input replay or durable turn ledger. */
export class ClaudeCodeManagedRuntime implements AgentRuntime {
  private readonly options: ClaudeCodeManagedRuntimeOptions;
  private readonly nativeOptions: NonNullable<ClaudeCodeManagedRuntimeOptions["nativeOptions"]>;
  private readonly store: ClaudeCodeManagedStore;
  // Original local handles remain private, not recovered-PID control capabilities.
  private readonly ownedChildren = new Map<string, ChildProcess>();
  constructor(options: ClaudeCodeManagedRuntimeOptions) {
    try {
      this.options = structuredClone(options);
      workerIdentity({ sessionId: "validation", ownerId: options.ownerId, generation: "validation" });
      const timeout = options.timeoutMs ?? 15_000;
      if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 30_000) throw unavailable();
      const explicit = options.nativeConfigRoot, env = options.nativeOptions?.env ?? {};
      if (typeof options.storeRoot !== "string" || (explicit !== undefined && (typeof explicit !== "string"
        || !isAbsolute(explicit) || resolve(explicit) !== explicit || explicit.includes("\0")))
        || CLAUDE_CODE_FORBIDDEN_ENV.some(key => env[key] !== undefined)
        || (explicit !== undefined && env.CLAUDE_CONFIG_DIR !== undefined && env.CLAUDE_CONFIG_DIR !== explicit)) throw unavailable();
      resolveClaudeCodePermissions(options.permissions); // Invalid policies fail at construction.
      this.store = new ClaudeCodeManagedStore(options.storeRoot);
      // CLAUDE_CONFIG_DIR is set for the worker only when the caller passed a root (or an explicit override).
      this.nativeOptions = { ...options.nativeOptions, env: { ...env, ...(explicit !== undefined ? { CLAUDE_CONFIG_DIR: explicit } : {}) } };
    } catch { throw unavailable(); }
  }
  private async guard<T>(operation: () => Promise<T>): Promise<T> {
    try { return await operation(); } catch (error) { throw publicError(error); }
  }
  private owner(ownerId: string) { if (ownerId !== this.options.ownerId) throw unavailable(); }
  private async host() {
    const entry = await realpath(this.options.workerExecutable ?? fileURLToPath(new URL("./worker-entry.js", import.meta.url)));
    if (!(await lstat(entry)).isFile()) throw unavailable();
    for (const file of [this.options.nodeExecutable, this.nativeOptions.executable]) {
      if (file === undefined || file === "bundled") continue;
      try { if (!(await lstat(await realpath(file))).isFile()) throw unavailable(); }
      catch (error) { throw file === this.nativeOptions.executable && (error as NodeJS.ErrnoException).code === "ENOENT" ? new ClaudeCodeNotInstalledError() : error; }
    }
    await this.root();
    return entry;
  }
  /** Explicit root, else as Claude Code resolves it for the effective (inherited + overlaid) environment. */
  private root(): Promise<string> {
    return resolveClaudeCodeConfigRoot(this.options.nativeConfigRoot, claudeCodeNativeEnvironment(this.nativeOptions.env));
  }
  private async preflight(id: string, generation: string, cwd: string, entry: string): Promise<void> {
    const nativeConfigRoot = await this.root();
    decodeClaudeCodeWorkerBootstrap(JSON.stringify({ version: 1, type: "bootstrap", storeRoot: this.options.storeRoot,
      scope: { sessionId: id, ownerId: this.options.ownerId, generation, reservationId: randomUUID(), workerExecutable: entry,
        cwd, nativeConfigRoot }, nativeOptions: this.nativeOptions }));
  }
  private async nativeRoot(m: ClaudeCodeManagedManifest): Promise<void> {
    if (m.policy.nativeConfigRoot !== await this.root()) throw unavailable();
  }
  private session(m: ClaudeCodeManagedManifest): ManagedAgentSession {
    return { id: m.id, ownerId: m.ownerId, runtime: "claude-code", ownership: "owned", cwd: m.launchConfig.cwd };
  }
  private async live(id: string) {
    const m = await this.store.read(id, this.options.ownerId); if (!m) throw unavailable(); await this.nativeRoot(m);
    const live = claudeCodeLiveWorker(m, await this.host());
    await this.store.withWorkerAdmission(live.scope, live.bytes, async () => {});
    return { ...live, manifest: m, client: new ClaudeCodeWorkerClient(live.registration, 2_000) };
  }
  private inputClient(registration: ClaudeCodeWorkerConnection): ClaudeCodeWorkerClient {
    // First input may allocate/initialize native lazily. Short status budgets must
    // not time out a healthy SDK startup after accepting uncertain input.
    return new ClaudeCodeWorkerClient(registration, Math.min(2_147_483_647, (this.nativeOptions.startupTimeoutMs ?? 30_000) + 5_000));
  }
  private async launch(id: string): Promise<ManagedAgentSession> {
    const attempt = await launchClaudeCodeWorker({ storeRoot: this.options.storeRoot, sessionId: id, ownerId: this.options.ownerId,
      workerExecutable: await this.host(), nodeExecutable: this.options.nodeExecutable, nativeOptions: this.nativeOptions });
    if (attempt.child) {
      this.ownedChildren.set(id, attempt.child); attempt.child.unref();
      (attempt.child.stdin as Socket | null)?.unref();
    }
    if (attempt.state !== "adopted" || !attempt.registration) throw unavailable();
    if ((await waitForClaudeCodeWorkerReady({ store: this.store, scope: attempt.scope, registration: attempt.registration,
      timeoutMs: this.options.timeoutMs ?? 15_000 })).state !== "ready") throw unavailable();
    const m = await this.store.read(id, this.options.ownerId); if (!m) throw unavailable(); return this.session(m);
  }
  /** Models, reasoning levels and skills for this cwd from a short-lived prompt-less query. Requires a native login. */
  capabilities(config: Pick<AgentStartConfig, "cwd"> = {}): Promise<RuntimeLaunchCapabilities> {
    return this.guard(async () => {
      const cwd = await realpath(config?.cwd ?? process.cwd());
      if (!(await lstat(cwd)).isDirectory()) throw unavailable();
      await this.root();
      return claudeCodeCapabilities(await requireClaudeCodeAuth({ cwd, executable: this.nativeOptions.executable,
        env: claudeCodeNativeEnvironment(this.nativeOptions.env), startupTimeoutMs: this.nativeOptions.startupTimeoutMs,
        shutdownTimeoutMs: this.nativeOptions.shutdownTimeoutMs, isolate: this.options.isolateConfiguration }));
    });
  }
  start(config: AgentStartConfig = {}) { return this.startManaged(config, this.options.ownerId); }
  startManaged(config: AgentStartConfig, ownerId: string): Promise<ManagedAgentSession> {
    return this.guard(async () => {
      this.owner(ownerId);
      config = structuredClone(config);
      if (!config || typeof config !== "object" || Array.isArray(config) || Object.keys(config).some(key => !["cwd", "systemPrompt", "appendSystemPrompt", "model", "reasoningLevel", "skillIds"].includes(key))
        || (config.systemPrompt !== undefined && config.appendSystemPrompt !== undefined)
        || [config.systemPrompt, config.appendSystemPrompt].some(value => value !== undefined && typeof value !== "string")) throw unavailable();
      validateClaudeCodeSelection(config);
      const cwd = await realpath(config.cwd ?? process.cwd()), entry = await this.host(), id = randomUUID(), generation = randomUUID();
      if (!(await lstat(cwd)).isDirectory()) throw unavailable();
      // Reuse the real preflight decoder BEFORE creating launch metadata.
      await this.preflight(id, generation, cwd, entry);
      // Auth preflight: a short-lived query that sends no prompt. Unauthenticated throws the specific error
      // BEFORE any manifest or worker exists.
      const probe = await requireClaudeCodeAuth({ cwd, executable: this.nativeOptions.executable, env: claudeCodeNativeEnvironment(this.nativeOptions.env),
        startupTimeoutMs: this.nativeOptions.startupTimeoutMs, shutdownTimeoutMs: this.nativeOptions.shutdownTimeoutMs, isolate: this.options.isolateConfiguration });
      // Unsupported model/effort/skills are refused, never silently replaced, and before any manifest exists.
      verifyClaudeCodeSelection(config, probe);
      const policy = resolveClaudeCodePermissions(this.options.permissions);
      await this.store.create({ version: 5, runtime: "claude-code", id, ownerId, revision: 0, generation, requiresExplicitResume: false,
        native: { state: "pending" }, worker: { state: "none" }, lastDispatch: { state: "none" }, launchConfig: { ...config, cwd },
        policy: { configuration: this.options.isolateConfiguration ? "isolated" : "native", nativeConfigRoot: await this.root(), ...policy, ...(probe.version ? { engineVersion: probe.version } : {}) }, createdAt: new Date().toISOString() });
      // A failed launch/readiness must not orphan the manifest or a worker: run the stop path, and drop the
      // record only once absence is proven. Otherwise it stays fenced and listed for a later forceStopManaged.
      try { return await this.launch(id); }
      catch (error) { await recoverClaudeCodeWorker(this.store, id, ownerId, { remove: true }).catch(() => {}); throw error; }
    });
  }
  suspend(id: string, ownerId: string): Promise<void> {
    return this.guard(async () => {
      this.owner(ownerId); const m = await this.store.read(id, ownerId); if (!m) throw unavailable(); await this.nativeRoot(m);
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
      this.owner(ownerId); const m = await this.store.read(id, ownerId); if (!m) throw unavailable(); await this.nativeRoot(m);
      if (m.worker.state === "live" && !m.requiresExplicitResume) {
        const live = await this.live(id);
        if ((await waitForClaudeCodeWorkerReady({ store: this.store, scope: live.scope, registration: live.bytes,
          timeoutMs: this.options.timeoutMs ?? 15_000 })).state !== "ready") throw unavailable();
        return this.session(m); // Reconnect only; no launch or input replay.
      }
      if (options?.allowStopped !== true) throw unavailable();
      await this.preflight(id, m.generation, m.launchConfig.cwd, await this.host());
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
      await this.nativeRoot(m);
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
      const parts = runtimeInput(input, images); if (Buffer.from(parts.input).toString() !== parts.input) throw unavailable();
      if (typeof turnId !== "string" || Buffer.from(turnId).toString() !== turnId) throw unavailable();
      const live = await this.live(id), previous = live.manifest.lastDispatch;
      if (previous.state !== "none" && previous.turnId === turnId && previous.generation !== live.manifest.generation) throw unavailable();
      return this.inputClient(live.registration).startTurn(turnId, parts.input, parts.images.length ? parts.images : undefined);
    });
  }
  send(id: string, input: string, images?: RuntimeImageContent[]) {
    return this.guard(async () => { const parts = runtimeInput(input, images); if (Buffer.from(parts.input).toString() !== parts.input) throw unavailable();
      const live = await this.live(id); await this.inputClient(live.registration).send(parts.input, parts.images.length ? parts.images : undefined); });
  }
  turn(id: string, turnId: string) { return this.guard(async () => (await this.live(id)).client.turn(turnId)); }
  status(id: string) { return this.guard(async () => {
    const m = await this.store.read(id, this.options.ownerId); if (!m) throw unavailable(); await this.nativeRoot(m);
    if (m.worker.state === "none" && m.requiresExplicitResume) return "offline" as const;
    return (await this.live(id)).client.status();
  }); }
  inputCapabilities(id: string) { return this.guard(async () => (await this.live(id)).client.inputCapabilities()); }
  sessionCapabilities(id: string) { return this.guard(async () => (await this.live(id)).client.sessionCapabilities().then(value => { if (!value) throw unavailable(); return value; })); }
  /** Queues a message into the running turn; refused unless a dispatch is in flight (never starts or replays a turn). */
  steer(id: string, input: string): Promise<void> {
    return this.guard(async () => {
      const text = runtimeInput(input, undefined).input, live = await this.live(id), dispatch = live.manifest.lastDispatch;
      if (dispatch.state !== "dispatching") throw unavailable();
      await live.client.steer(dispatch.turnId, text);
    });
  }
  interrupt(id: string) {
    return this.guard(async () => { const live = await this.live(id), dispatch = live.manifest.lastDispatch;
      if (dispatch.state === "dispatching") await live.client.interrupt(dispatch.turnId);
      else if (await live.client.status() !== "idle") throw unavailable(); });
  }
  /** Read-only observations of an EXISTING exact-owner worker: never starts, resumes or wakes anything; undefined when none is live. */
  private async observe<T>(id: string, ownerId: string, signal: AbortSignal | undefined, read: (client: ClaudeCodeWorkerClient, signal: AbortSignal) => Promise<T>): Promise<T | undefined> {
    return this.guard(async () => {
      this.owner(ownerId); signal?.throwIfAborted();
      const m = await this.store.read(id, ownerId);
      if (!m || m.worker.state !== "live" || m.requiresExplicitResume) return undefined;
      await this.nativeRoot(m);
      const live = await this.live(id), abort = AbortSignal.any([AbortSignal.timeout(2_000), ...(signal ? [signal] : [])]);
      return read(live.client, abort);
    });
  }
  inspectSessionProfile(id: string, ownerId: string, options: { signal?: AbortSignal } = {}) { return this.observe(id, ownerId, options.signal, (client, signal) => client.inspectProfile(signal)); }
  inspectSessionEvents(id: string, ownerId: string, options: { signal?: AbortSignal } = {}) { return this.observe(id, ownerId, options.signal, (client, signal) => client.inspectEvents(signal)); }
  inspectSessionIntegrations(id: string, ownerId: string, options: { signal?: AbortSignal } = {}) { return this.observe(id, ownerId, options.signal, (client, signal) => client.inspectIntegrations(signal)); }
  messages(id: string) {
    return this.guard(async () => {
      const m = await this.store.read(id, this.options.ownerId); if (!m) throw unavailable(); await this.nativeRoot(m);
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
