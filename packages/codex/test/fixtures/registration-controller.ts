import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { CodexManagedStore, type CodexManifestLease } from "../../src/managed-store.js";
import type { CodexManagedIdentity } from "../../src/managed-native.js";
import type { CodexAgentRuntimeOptions } from "../../src/client.js";

process.once("message", async (launch: { root: string; identity: CodexManagedIdentity; mode: string; native: CodexAgentRuntimeOptions; target?: Parameters<typeof import("../../src/managed-worker.js")["finalizeCodexWorkerRetirement"]>[1] }) => {
  const require = createRequire(import.meta.url);
  const cp = require("node:child_process") as typeof import("node:child_process");
  const fork = cp.fork;
  let worker: ReturnType<typeof fork> | undefined;
  let expireStartup: (() => void) | undefined;
  const domainReleases: Array<() => void> = [];
  const finalizer = launch.mode.startsWith("domain-finalize");
  let finalizing = false;
  if (finalizer) {
    const targetPid = launch.target?.connection.pid, kill = process.kill.bind(process);
    process.kill = ((pid: number, signal?: NodeJS.Signals | number) => {
      if (pid !== targetPid || signal !== 0) return kill(pid, signal);
      appendFileSync(join(launch.root, ".domain-signals"), "zero\n");
      if (launch.mode.endsWith("present")) return true;
      const error = new Error("PRIVATE signal detail") as NodeJS.ErrnoException;
      error.code = launch.mode.endsWith("permission") ? "EPERM" : launch.mode.endsWith("unknown") ? "PRIVATE" : "ESRCH";
      throw error;
    }) as typeof process.kill;
  }
  if (launch.mode.startsWith("domain-")) {
    Object.defineProperty(process, "platform", { value: "darwin" });
    const fs = require("node:fs/promises") as typeof import("node:fs/promises");
    const lstat = fs.lstat, realpath = fs.realpath, rename = fs.rename;
    if (finalizer) fs.rename = async (...args: Parameters<typeof rename>) => {
      if (!finalizing || !["domain-finalize-before-rename", "domain-finalize-after-rename"].includes(launch.mode)) return rename(...args);
      if (launch.mode.endsWith("after-rename")) await rename(...args);
      throw new Error("PRIVATE finalization publication uncertainty");
    };
    const sources = new Set(["/", "/usr", "/usr/sbin", "/usr/sbin/ioreg", "/usr/sbin/sysctl"]);
    fs.lstat = (async (path: any, ...args: any[]) => sources.has(String(path))
      ? { uid: 0, mode: 0o555, isSymbolicLink: () => false, isDirectory: () => !String(path).endsWith("ioreg") && !String(path).endsWith("sysctl"), isFile: () => String(path).endsWith("ioreg") || String(path).endsWith("sysctl") }
      : (lstat as any)(path, ...args)) as typeof fs.lstat;
    fs.realpath = (async (path: any, ...args: any[]) => sources.has(String(path)) ? String(path) : (realpath as any)(path, ...args)) as typeof fs.realpath;
    const execFile = cp.execFile;
    cp.execFile = ((file: any, ...args: any[]) => {
      if (file !== "/usr/sbin/ioreg" && file !== "/usr/sbin/sysctl") return (execFile as any)(file, ...args);
      appendFileSync(join(launch.root, ".domain-queries"), `launcher:${file.endsWith("ioreg") ? "ioreg" : "sysctl"}\n`);
      const callback = args.at(-1);
      const output = file.endsWith("ioreg") ? '+-o Fixture <class IOPlatformExpertDevice, id 1>\n    {\n      "IOPlatformUUID" = "11111111-2222-4333-8444-555555555555"\n    }\n' : launch.mode.endsWith("unconfirmed") ? 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff\n' : '66666666-7777-4888-8999-aaaaaaaaaaaa\n';
      const done = () => callback(launch.mode === "domain-launcher-unavailable" ? new Error("PRIVATE query detail") : null, Buffer.from(output), Buffer.alloc(0));
      if (launch.mode === "domain-launcher-pause" || launch.mode.startsWith("domain-finalize-pause-")) domainReleases.push(done); else queueMicrotask(done);
      return {};
    }) as typeof cp.execFile;
  }
  if (launch.mode === "domain-finalize-unsupported") Object.defineProperty(process, "platform", { value: "unsupported" });
  if (launch.mode === "adopt-timeout") {
    const originalTimeout = globalThis.setTimeout;
    globalThis.setTimeout = ((callback: (...args: any[]) => void, milliseconds?: number, ...args: any[]) => {
      if (milliseconds === 5555) expireStartup = () => callback(...args);
      return originalTimeout(callback, milliseconds, ...args);
    }) as typeof setTimeout;
  }
  process.on("message", command => {
    if (command !== "trigger") return;
    if (launch.mode === "domain-launcher-pause" || launch.mode.startsWith("domain-finalize-pause-")) { for (const release of domainReleases.splice(0)) release(); }
    else if (launch.mode === "domain-worker-pause") worker?.send({ type: "test-release-domain" });
    else if (launch.mode.startsWith("domain-adopt-")) { /* Authentication gate below observes this trigger. */ }
    else if (launch.mode === "adopt-timeout") expireStartup?.();
    else if (launch.mode === "adopt-ipc") { if (worker?.connected) worker.disconnect(); }
    else if (worker?.connected) worker.send({ type: "test-fail-publication" });
  });
  cp.fork = ((modulePath: Parameters<typeof fork>[0], args: string[], options: Parameters<typeof fork>[2]) => {
    const child = launch.mode.startsWith("domain-") || launch.mode.startsWith("ready-") || ["adopt-ipc", "adopt-post-publication"].includes(launch.mode)
      ? fork(new URL("./registration-worker-fault.js", import.meta.url), [launch.mode], options)
      : fork(modulePath, args, options);
    worker = child;
    if (launch.mode.startsWith("domain-")) {
      const send = child.send.bind(child) as (...args: any[]) => boolean;
      child.send = ((...args: any[]) => {
        if (args[0]?.type === "launch") {
          if (Object.keys(args[0]).some(key => !["type", "managedRoot", "claimId", "identity", "options"].includes(key))) throw new Error("Unexpected private launch provenance field");
          appendFileSync(join(launch.root, ".domain-protocol"), "no-inherited-observation\n");
          if (launch.mode === "domain-injected") args[0] = { ...args[0], processDomain: { ioPlatformUuid: "PRIVATE caller value", bootSessionUuid: "PRIVATE caller value" },
            options: { ...args[0].options, processDomain: { ioPlatformUuid: "PRIVATE native option", bootSessionUuid: "PRIVATE native option" } } };
        }
        return send(...args);
      }) as typeof child.send;
    }
    if (launch.mode.startsWith("adopt-")) {
      const emit = child.emit;
      child.emit = function(event: string | symbol, ...values: any[]) {
        if (event === "message" && (values[0]?.type === "test-published"
          || (launch.mode === "adopt-timeout" && values[0]?.type === "ready"))) {
          process.send?.({ type: "adoptable" });
          return true; // Withhold the launcher's IPC confirmation, not durable readiness.
        }
        return (emit as (...args: any[]) => boolean).call(child, event, ...values);
      } as typeof child.emit;
    }
    process.send?.({ type: "spawned", pid: child.pid });
    return child;
  }) as typeof fork;
  syncBuiltinESMExports();
  const original = CodexManagedStore.prototype.withSessionLock;
  CodexManagedStore.prototype.withSessionLock = async function<T>(
    id: string, ownerId: string, operation: (lease: CodexManifestLease) => Promise<T>, timeoutMs?: number,
  ): Promise<T> {
    let finalized = false;
    const value = await (original.call(this, id, ownerId, async (lease: CodexManifestLease) => operation({
      ...lease,
      finalizeRetirement: async (...args) => {
        appendFileSync(join(launch.root, ".finalize-attempts"), "write\n");
        finalizing = true;
        let next;
        try { next = await lease.finalizeRetirement(...args); } finally { finalizing = false; }
        finalized = true;
        if (launch.mode === "domain-finalize-readback") {
          const fs = require("node:fs/promises") as typeof import("node:fs/promises");
          await fs.writeFile(join(launch.root, createHash("sha256").update(next.ownerId).digest("hex"), `${next.id}.session`, "manifest.json"),
            JSON.stringify({ ...next, revision: next.revision + 1 }));
        }
        return next;
      },
      recordProcessDomain: async (revision, domain) => {
        if (launch.mode === "domain-record-before") throw new Error("PRIVATE pre-publication detail");
        if (launch.mode === "domain-adopt-failure") throw new Error("PRIVATE adopted publication failure");
        const next = await lease.recordProcessDomain(revision, domain);
        if (launch.mode === "domain-record-after") throw new Error("PRIVATE post-publication detail");
        return next;
      },
      reserveWorker: async (revision, claimId) => {
        if (launch.mode === "reserve-before") throw new Error("injected reservation failure");
        const next = await lease.reserveWorker(revision, claimId);
        if (launch.mode === "reserve-after") throw new Error("injected reservation publication uncertainty");
        if (launch.mode === "pause-reserve") {
          process.on("message", () => {});
          process.send?.({ type: "paused" });
          await new Promise<void>(() => {});
        }
        return next;
      },
      recordWorkerPid: async (revision, claimId, pid) => {
        if (launch.mode === "pid-before") throw new Error("injected PID publication failure");
        const next = await lease.recordWorkerPid(revision, claimId, pid);
        if (launch.mode === "pid-after") throw new Error("injected PID publication uncertainty");
        if (launch.mode === "pause-pid") {
          process.on("message", () => {});
          process.send?.({ type: "paused" });
          await new Promise<void>(() => {});
        }
        return next;
      },
    }), timeoutMs) as Promise<T>);
    if (finalized && ["domain-finalize-lock-delay", "domain-finalize-lock-error"].includes(launch.mode)) {
      const triggered = new Promise<void>(resolve => process.once("message", () => resolve()));
      process.send?.({ type: "finalized-visible" }); await triggered;
      if (launch.mode.endsWith("error")) throw new Error("PRIVATE finalization lock-return uncertainty");
    }
    return value;
  };
  const { launchOrReconnectCodexWorker, finalizeCodexWorkerRetirement } = await import("../../src/managed-worker.js");
  if (launch.mode.startsWith("domain-adopt-")) {
    const { CodexWorkerClient } = await import("../../src/worker-client.js");
    const verify = CodexWorkerClient.prototype.verifyIdentity;
    CodexWorkerClient.prototype.verifyIdentity = async function() {
      const result = await verify.call(this);
      const triggered = new Promise<void>(resolve => process.once("message", () => resolve()));
      process.send?.({ type: "adoptable" }); await triggered;
      return result;
    };
  }
  if (launch.mode === "domain-auth-fence" || launch.mode === "domain-auth-revision") {
    const { CodexWorkerClient } = await import("../../src/worker-client.js");
    const verify = CodexWorkerClient.prototype.verifyIdentity;
    CodexWorkerClient.prototype.verifyIdentity = async function() {
      const result = await verify.call(this);
      const store = new CodexManagedStore(launch.root); const current = (await store.read(launch.identity.id, launch.identity.ownerId))!;
      await store.update(current.id, current.ownerId, current.revision, { requiresExplicitResume: launch.mode === "domain-auth-fence" });
      return result;
    };
  }
  if (launch.mode === "post-ready-auth") {
    const { CodexWorkerClient } = await import("../../src/worker-client.js");
    CodexWorkerClient.prototype.verifyIdentity = async () => { throw new Error("injected reconnect failure"); };
  }
  try {
    if (finalizer) {
      const operation = finalizeCodexWorkerRetirement(launch.root, launch.target!);
      if (launch.mode === "domain-finalize-mutate") {
        launch.target!.identity.ownerId = "changed-owner"; launch.target!.connection.token = "b".repeat(64);
        launch.target!.intent.operationId = "changed-operation";
        if (launch.target!.intent.native.state === "bound") launch.target!.intent.native.threadId = "changed-native";
      }
      const result = await operation;
      process.send?.({ type: "done", ok: true, result }, () => process.disconnect()); return;
    }
    const connection = await launchOrReconnectCodexWorker(launch.root, launch.identity, {
      native: launch.native, startupTimeoutMs: launch.mode.startsWith("adopt-") ? 5555 : launch.mode === "ready-delay" ? 100 : 3_000,
    });
    if (launch.mode === "controller-ready") {
      process.on("message", () => {});
      process.send?.({ type: "done", ok: true, connection });
    } else process.send?.({ type: "done", ok: true, connection }, () => process.disconnect());
  } catch (error) {
    process.send?.({ type: "done", ok: false, name: error instanceof Error ? error.constructor.name : "Error", hasCause: error instanceof Error && "cause" in error }, () => process.disconnect());
  }
});
