import { constants } from "node:fs";
import { access, lstat, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, isAbsolute, join, resolve } from "node:path";

/** Distinguishable (and non-secret) so callers can show a "not logged in" state. Never carries account details. */
export class ClaudeCodeAuthRequiredError extends Error {
  constructor() {
    super("Claude Code is not logged in; run `claude` to sign in");
    this.name = "ClaudeCodeAuthRequiredError";
  }
}

/** Break identity or history; always removed from the inherited environment (and refused as overrides). */
export const CLAUDE_CODE_FORBIDDEN_ENV = Object.freeze(
  ["NODE_OPTIONS", "NODE_PATH", "CLAUDE_CODE_PROJECT_DIR_NAME", "CLAUDE_CODE_RESUME_INTERRUPTED_TURN"]);

/** Inherit the process environment (HOME is needed for keychain access), overlay explicit overrides, drop the forbidden keys.
 * CLAUDE_CONFIG_DIR is only set here when the caller passed it (explicit root or override); otherwise native resolution applies. */
export function claudeCodeNativeEnvironment(
  overrides: Record<string, string | undefined> = {}, base: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries({ ...base, ...overrides })) if (value !== undefined) env[key] = value;
  for (const key of CLAUDE_CODE_FORBIDDEN_ENV) delete env[key];
  return env;
}

/** The root Claude Code itself would use for this environment: $CLAUDE_CONFIG_DIR, else ~/.claude. */
export function claudeCodeEffectiveConfigRoot(env: Record<string, string | undefined>): string {
  const configured = env.CLAUDE_CONFIG_DIR;
  const root = configured !== undefined && configured !== "" ? configured : join(env.HOME || homedir(), ".claude");
  if (root.includes("\0") || !isAbsolute(root)) throw new Error("Claude Code configuration root must be absolute");
  return resolve(root);
}

/** realpath'd, owned by the current user, a directory. A normal ~/.claude is world-readable, so no mode check.
 * Never creates, chmods or writes into it. */
export async function resolveClaudeCodeConfigRoot(
  explicit: string | undefined, env: Record<string, string | undefined>,
): Promise<string> {
  if (explicit !== undefined && (typeof explicit !== "string" || explicit.includes("\0") || !isAbsolute(explicit))) {
    throw new Error("Claude Code configuration root must be absolute");
  }
  const root = await realpath(explicit ?? claudeCodeEffectiveConfigRoot(env));
  const metadata = await lstat(root);
  if (!metadata.isDirectory() || (process.getuid && metadata.uid !== process.getuid())) {
    throw new Error("Claude Code configuration root must be a directory owned by the current user");
  }
  return root;
}

/** Account label only. Absent credentials, or a first-party backend with no token/key/account, mean "not logged in".
 * Third-party backends (Bedrock, Vertex, ...) authenticate externally and are not judged here. */
export function claudeCodeAccountStatus(account: unknown): { authenticated: boolean; accountType?: string } {
  const value = (account && typeof account === "object" ? account : {}) as Record<string, unknown>;
  const text = (key: string) => typeof value[key] === "string" && value[key] ? value[key] as string : undefined;
  const provider = text("apiProvider");
  const credential = text("tokenSource") ?? text("email") ?? (text("apiKeySource") !== "none" ? text("apiKeySource") : undefined);
  const authenticated = (provider !== undefined && provider !== "firstParty") || credential !== undefined;
  return { authenticated, ...(authenticated ? { accountType: text("subscriptionType") ?? provider ?? "api" } : {}) };
}

/** Simple, like Pi (`PI_COMMAND ?? "pi"`): use the installed `claude`. `undefined` searches PATH of the effective environment,
 * "bundled" selects the SDK's pinned engine, anything else is an explicit absolute path. Nothing is pinned or recorded. */
export async function resolveClaudeCodeExecutable(
  executable: string | undefined, env: Record<string, string | undefined>,
): Promise<string | undefined> {
  if (executable === "bundled") return undefined;
  if (executable !== undefined) return executable;
  for (const directory of (env.PATH ?? "").split(delimiter)) {
    if (!directory || !isAbsolute(directory)) continue;
    const candidate = join(directory, "claude");
    try {
      const metadata = await stat(candidate);
      if (metadata.isFile()) { await access(candidate, constants.X_OK); return candidate; }
    } catch { /* Not here. */ }
  }
  throw new Error("Claude Code executable not found: install `claude`, or pass executable (a path, or \"bundled\")");
}
