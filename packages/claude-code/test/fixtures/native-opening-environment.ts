// Isolated host-environment probe; never mutates the parent test process environment.
import { createRequire, syncBuiltinESMExports } from "node:module";
import { openClaudeCodeNativeSession } from "../../src/native-session.js";
process.once("message", async (request: any) => {
  let handle: Awaited<ReturnType<typeof openClaudeCodeNativeSession>> | undefined;
  let result: { opened: boolean; overrideRejected?: boolean; cleanupFailed?: boolean; environmentChangedDuringPrepare?: boolean };
  let exit = 0;
  let injected = false;
  if (request.injectOverrideDuringPrepare) {
    // Fault injection only in this disposable child: mutate the host environment
    // after validation while actual directory preparation is outstanding.
    const fs = createRequire(import.meta.url)("node:fs/promises") as typeof import("node:fs/promises");
    const mkdir = fs.mkdir;
    fs.mkdir = (async (...args: Parameters<typeof mkdir>) => {
      const value = await mkdir(...args);
      if (!injected) { injected = true; process.env.CLAUDE_CODE_PROJECT_DIR_NAME = "late-override"; }
      return value;
    }) as typeof mkdir;
    syncBuiltinESMExports();
  }
  try {
    handle = await openClaudeCodeNativeSession({ cwd: request.cwd }, request.native, {
      executable: request.executable, env: request.replacementEnv,
      startupTimeoutMs: 2_000, shutdownTimeoutMs: 2_000,
    });
    result = { opened: true, ...(request.injectOverrideDuringPrepare ? { environmentChangedDuringPrepare: injected } : {}) };
  } catch (error) {
    const overrideRejected = error instanceof Error
      && error.message === "Persistent Claude Code project-directory override is not supported";
    result = { opened: false, overrideRejected };
    if (!overrideRejected) exit = 1;
  }
  if (handle) {
    try { await handle.runtime.stop(handle.session.id); }
    catch { result.cleanupFailed = true; exit = 1; }
  }
  process.send?.(result, () => process.exit(exit));
});
