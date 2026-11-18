import { appendFileSync } from "node:fs";
import { writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { CodexManagedStore, type CodexManifestLease } from "../../src/managed-store.js";

const mode = process.argv[2];
if (mode === "domain-retire-close-error") {
  const http = createRequire(import.meta.url)("node:http") as typeof import("node:http");
  const create = http.createServer;
  http.createServer = ((...args: any[]) => {
    const server = (create as any)(...args);
    server.close = (callback: (error?: Error) => void) => { queueMicrotask(() => callback(new Error("PRIVATE close failure"))); return server; };
    return server;
  }) as typeof create;
  syncBuiltinESMExports();
}
let publishing = false;
if (mode.startsWith("resume-")) {
  let root = "";
  process.prependOnceListener("message", (launch: any) => { root = launch.managedRoot; });
  const require = createRequire(import.meta.url);
  if (mode.startsWith("resume-domain")) {
    const cp = require("node:child_process") as typeof import("node:child_process"), exec = cp.execFile;
    cp.execFile = ((file: any, ...args: any[]) => {
      if (file !== "/usr/sbin/ioreg" && file !== "/usr/sbin/sysctl") return (exec as any)(file, ...args);
      queueMicrotask(() => args.at(-1)(new Error("Injected resumed-worker domain failure"), Buffer.alloc(0), Buffer.alloc(0))); return {};
    }) as typeof exec;
  }
  if (mode === "resume-bridge") {
    const http = require("node:http") as typeof import("node:http");
    http.createServer = (() => { throw new Error("Injected resumed-worker bridge failure"); }) as typeof http.createServer;
  }
  syncBuiltinESMExports();
  const { CodexAgentRuntime } = await import("../../src/client.js");
  const stop = CodexAgentRuntime.prototype.stop;
  CodexAgentRuntime.prototype.stop = function(id: string) {
    appendFileSync(join(root, ".resume-stop-attempts"), "stop\n");
    if (mode.endsWith("unconfirmed")) return Promise.reject(new Error("Injected unconfirmed native cleanup"));
    return stop.call(this, id);
  };
}
if (mode.startsWith("domain-")) {
  const require = createRequire(import.meta.url);
  const fs = require("node:fs/promises") as typeof import("node:fs/promises");
  const cp = require("node:child_process") as typeof import("node:child_process");
  Object.defineProperty(process, "platform", { value: "darwin" });
  const lstat = fs.lstat, realpath = fs.realpath;
  const sources = new Set(["/", "/usr", "/usr/sbin", "/usr/sbin/ioreg", "/usr/sbin/sysctl"]);
  fs.lstat = (async (path: any, ...args: any[]) => sources.has(String(path))
    ? { uid: 0, mode: 0o555, isSymbolicLink: () => false, isDirectory: () => !String(path).endsWith("ioreg") && !String(path).endsWith("sysctl"), isFile: () => String(path).endsWith("ioreg") || String(path).endsWith("sysctl") }
    : (lstat as any)(path, ...args)) as typeof fs.lstat;
  fs.realpath = (async (path: any, ...args: any[]) => sources.has(String(path)) ? String(path) : (realpath as any)(path, ...args)) as typeof fs.realpath;
  let root = ""; const releases: Array<() => void> = [];
  process.prependOnceListener("message", (launch: any) => { root = launch.managedRoot; });
  process.on("message", (command: any) => { if (command?.type === "test-release-domain") for (const release of releases.splice(0)) release(); });
  const execFile = cp.execFile;
  cp.execFile = ((file: any, ...args: any[]) => {
    if (file !== "/usr/sbin/ioreg" && file !== "/usr/sbin/sysctl") return (execFile as any)(file, ...args);
    appendFileSync(join(root, ".domain-queries"), `worker:${file.endsWith("ioreg") ? "ioreg" : "sysctl"}\n`);
    const callback = args.at(-1);
    const boot = mode === "domain-mismatch" ? "bbbbbbbb-cccc-4ddd-8eee-ffffffffffff" : "66666666-7777-4888-8999-aaaaaaaaaaaa";
    const output = file.endsWith("ioreg") ? '+-o Fixture <class IOPlatformExpertDevice, id 1>\n    {\n      "IOPlatformUUID" = "11111111-2222-4333-8444-555555555555"\n    }\n' : mode === "domain-worker-malformed" ? "PRIVATE malformed" : `${boot}\n`;
    const done = () => callback(mode === "domain-worker-unavailable" ? new Error("PRIVATE query detail") : null, Buffer.from(output), Buffer.alloc(0));
    if (mode === "domain-worker-pause") {
      const timer = setTimeout(() => callback(new Error("Fixture query timeout"), Buffer.alloc(0), Buffer.alloc(0)), 2_000);
      releases.push(() => { clearTimeout(timer); done(); });
    } else queueMicrotask(done);
    return {};
  }) as typeof cp.execFile;
  const send = process.send!.bind(process) as (...args: any[]) => boolean;
  process.send = ((...args: any[]) => {
    if (args[0]?.type === "ready") {
      if (mode === "domain-lost-ack") {
        const callback = args.find(value => typeof value === "function");
        process.disconnect(); queueMicrotask(() => callback?.(new Error("PRIVATE lost acknowledgment"))); return true;
      }
      const message = structuredClone(args[0]);
      if (mode === "domain-missing-report") delete message.processDomain;
      else if (mode === "domain-array-report") message.processDomain = [message.processDomain];
      else if (mode === "domain-boolean-report") message.processDomain = true;
      else if (mode === "domain-nil-report") message.processDomain.bootSessionUuid = "00000000-0000-0000-0000-000000000000";
      else if (mode === "domain-extra-report") message.processDomain.extra = true;
      else if (mode === "domain-uppercase-report") message.processDomain.bootSessionUuid = message.processDomain.bootSessionUuid.toUpperCase();
      else if (mode === "domain-wrong-pid") message.connection.pid++;
      else if (mode === "domain-wrong-owner") message.connection.ownerId = "other-owner";
      else if (mode === "domain-wrong-session") message.connection.sessionId = "other-session";
      else if (mode === "domain-wrong-generation") message.connection.generation = "other-generation";
      else if (mode === "domain-wrong-claim") message.connection.claimId = "other-claim";
      else if (mode === "domain-wrong-token") message.connection.token = "b".repeat(64);
      else if (mode === "domain-wrong-endpoint") message.connection.endpoint = "http://127.0.0.1:12345";
      else if (mode === "domain-wrong-version") message.connection.version = 2;
      args[0] = message;
    }
    return send(...args);
  }) as typeof process.send;
  syncBuiltinESMExports();
}
if (mode === "ready-fsync") {
  const fs = createRequire(import.meta.url)("node:fs/promises") as typeof import("node:fs/promises");
  const open = fs.open;
  fs.open = async (...args) => {
    const handle = await open(...args);
    if (publishing && String(args[0]).endsWith(".session")) {
      handle.sync = async () => { throw new Error("injected readiness directory fsync failure"); };
    }
    return handle;
  };
  syncBuiltinESMExports();
}
if (mode === "adopt-ipc") {
  const send = process.send!.bind(process) as (...args: any[]) => boolean;
  process.send = ((...args: any[]) => {
    if (args[0]?.type !== "ready") return send(...args);
    const callback = args.find(value => typeof value === "function");
    send({ type: "test-published" });
    process.once("disconnect", () => callback?.(new Error("injected IPC confirmation failure")));
    return true;
  }) as typeof process.send;
}

const original = CodexManagedStore.prototype.withSessionLock;
CodexManagedStore.prototype.withSessionLock = function<T>(
  id: string, ownerId: string, operation: (lease: CodexManifestLease) => Promise<T>, timeoutMs?: number,
): Promise<T> {
  const root = (this as unknown as { root: string }).root;
  return (async () => {
    let published = false, nativePublished = false;
    const result = await original.call(this, id, ownerId, async (lease: CodexManifestLease) => operation({
      ...lease,
      recordNativeQuiesce: async (...args) => {
        if (mode === "domain-retire-before") throw new Error("PRIVATE native fact failure");
        const value = await lease.recordNativeQuiesce(...args); nativePublished = true;
        if (mode === "domain-retire-after") throw new Error("PRIVATE native fact uncertainty");
        return value;
      },
      publishWorkerReady: async (revision, connection) => {
        if (mode === "ready-before") throw new Error("injected readiness publication failure");
        if (mode === "ready-delay") await new Promise(resolve => setTimeout(resolve, 300));
        publishing = true;
        let result;
        try { result = await lease.publishWorkerReady(revision, connection); }
        finally { publishing = false; }
        published = true;
        if (mode === "ready-after" || mode === "resume-ready-after") throw new Error("injected post-publication failure");
        if (mode === "ready-pause") {
          process.on("message", () => {});
          await writeFile(join(root, ".test-ready-paused"), String(process.pid), { mode: 0o600 });
          await new Promise<void>(() => {});
        }
        if (mode === "ready-disconnect") process.disconnect();
        return result;
      },
    }), timeoutMs) as T;
    if (mode === "resume-lock-return" && result && typeof (result as any).runtime === "object" && (result as any).session) {
      throw new Error("Injected resumed-worker open lock-return failure");
    }
    if (nativePublished && ["domain-retire-visible", "domain-retire-lock-error"].includes(mode)) {
      await writeFile(join(root, ".retirement-fact-visible"), "visible", { mode: 0o600 });
      const deadline = Date.now() + 5_000;
      while (true) {
        try { await readFile(join(root, ".retirement-release")); break; }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
        if (Date.now() >= deadline) throw new Error("Fixture retirement gate timed out");
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      if (mode === "domain-retire-lock-error") throw new Error("PRIVATE fact lock-return failure");
    }
    if (published && mode === "adopt-post-publication") {
      // Pause only after the real lock has released, so a second consumer can
      // authenticate and dispatch before the publisher reports an exception.
      const fail = new Promise<void>(resolve => process.on("message", message => {
        if ((message as { type?: string })?.type === "test-fail-publication") resolve();
      }));
      process.send?.({ type: "test-published" });
      await fail;
      throw new Error("injected post-publication/lock-release failure");
    }
    return result;
  })();
};
await import("../../src/owned-worker.js");
