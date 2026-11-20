import type { Options, PermissionMode } from "@anthropic-ai/claude-agent-sdk";

/** What a session may do natively. Not an OS sandbox or a filesystem boundary.
 * - "full":     Pi parity. bypassPermissions + every native tool.
 * - "edits":    acceptEdits + every native tool; Bash and other non-edit tools only through `canUseTool` (denied without one).
 * - "readOnly": Read/Grep/Glob (the library default, so callers opt in to "full" explicitly). */
export type ClaudeCodePermissions = "full" | "edits" | "readOnly"
  | { mode: ClaudeCodePermissionMode; allowedTools?: string[]; disallowedTools?: string[] };
export type ClaudeCodePermissionMode = "default" | "acceptEdits" | "bypassPermissions" | "dontAsk";
export type ClaudeCodePermissionLabel = "full" | "edits" | "readOnly" | "custom";

/** Serializable, resolved form stored in the manifest. `tools: null` means every native tool. */
export interface ClaudeCodePermissionPolicy {
  permissions: ClaudeCodePermissionLabel;
  permissionMode: ClaudeCodePermissionMode;
  tools: string[] | null;
  allowedTools?: string[];
  disallowedTools?: string[];
}
export const CLAUDE_CODE_PERMISSION_MODES: readonly string[] = ["default", "acceptEdits", "bypassPermissions", "dontAsk"];
/** Tools that wait for a human. Runtime is headless, so they are never offered to the model. */
export const CLAUDE_CODE_INTERACTIVE_TOOLS = Object.freeze(["AskUserQuestion", "ExitPlanMode", "EnterPlanMode"]);
export const CLAUDE_CODE_READ_ONLY_TOOLS = Object.freeze(["Read", "Grep", "Glob"]);

function toolList(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > 128 || new Set(value).size !== value.length
    || value.some(item => typeof item !== "string" || !item.trim() || Buffer.byteLength(item) > 256 || item.includes("\0"))) {
    throw new Error("Invalid Claude Code tool list");
  }
  return [...value];
}

export function resolveClaudeCodePermissions(permissions: ClaudeCodePermissions = "readOnly"): ClaudeCodePermissionPolicy {
  if (permissions === "readOnly") return { permissions, permissionMode: "default", tools: [...CLAUDE_CODE_READ_ONLY_TOOLS] };
  if (permissions === "edits") return { permissions, permissionMode: "acceptEdits", tools: null };
  if (permissions === "full") return { permissions, permissionMode: "bypassPermissions", tools: null };
  if (!permissions || typeof permissions !== "object" || Array.isArray(permissions)
    || !CLAUDE_CODE_PERMISSION_MODES.includes(permissions.mode)
    || Object.keys(permissions).some(key => !["mode", "allowedTools", "disallowedTools"].includes(key))) {
    throw new Error("Invalid Claude Code permissions");
  }
  const allowedTools = toolList(permissions.allowedTools), disallowedTools = toolList(permissions.disallowedTools);
  return { permissions: "custom", permissionMode: permissions.mode, tools: null,
    ...(allowedTools ? { allowedTools } : {}), ...(disallowedTools ? { disallowedTools } : {}) };
}

/** SDK query options for a policy. Interactive tools are always disallowed, whatever the policy says. */
export function claudeCodePermissionOptions(policy: ClaudeCodePermissionPolicy, explicitTools?: string[]):
Pick<Options, "tools" | "permissionMode" | "allowDangerouslySkipPermissions" | "allowedTools" | "disallowedTools"> {
  const tools = explicitTools ?? policy.tools;
  return {
    tools: tools ?? { type: "preset", preset: "claude_code" },
    permissionMode: policy.permissionMode as PermissionMode,
    allowDangerouslySkipPermissions: policy.permissionMode === "bypassPermissions",
    ...(policy.allowedTools ? { allowedTools: [...policy.allowedTools] } : {}),
    disallowedTools: [...new Set([...(policy.disallowedTools ?? []), ...CLAUDE_CODE_INTERACTIVE_TOOLS])],
  };
}
