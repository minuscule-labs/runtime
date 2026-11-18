// Run in a fresh process: Pi's worker inherits its environment, so isolate before imports/startup.
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { dirname, delimiter, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const home = await mkdtemp(join(tmpdir(), "runtime-headless-home-"));
try {
  await Promise.all(["tmp", "codex", "claude"].map(name => mkdir(join(home, name))));
  const child = spawn(process.execPath, ["--test", "test/headless-conformance.test.mjs"], {
    cwd: root, stdio: "inherit",
    env: {
      HOME: home, TMPDIR: join(home, "tmp"), CODEX_HOME: join(home, "codex"),
      CLAUDE_CONFIG_DIR: join(home, "claude"), MINU_RUNTIME_DIR: join(home, "runtime"),
      PATH: [dirname(process.execPath), "/usr/bin", "/bin"].join(delimiter),
      ...(process.env.MINU_RUNTIME_CODEX_TEST_ROOT
        ? { MINU_RUNTIME_CODEX_TEST_ROOT: process.env.MINU_RUNTIME_CODEX_TEST_ROOT } : {}),
    },
  });
  process.exitCode = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", code => resolve(code ?? 1));
  });
} finally { await rm(home, { recursive: true, force: true }); }
