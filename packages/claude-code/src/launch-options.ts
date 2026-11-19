import type { ModelInfo, Options, SlashCommand } from "@anthropic-ai/claude-agent-sdk";
import type { AgentReasoningLevel, AgentStartConfig, RuntimeLaunchCapabilities } from "@minu/runtime-core";

const PROVIDER = "anthropic";
const EFFORT = ["low", "medium", "high", "xhigh", "max"] as const;
type Effort = typeof EFFORT[number];

/** What the native engine reported at initialization (never user-supplied). */
export interface ClaudeCodeDiscovery { models: ModelInfo[]; skills: SlashCommand[] }

function find(models: ModelInfo[], id: string): ModelInfo | undefined {
  return models.find(model => model.value === id || model.resolvedModel === id);
}
/** The engine's alias row for "whatever the user's login/settings select". */
function defaultRow(models: ModelInfo[]): ModelInfo | undefined { return models.find(model => model.value === "default"); }
function efforts(model: ModelInfo | undefined): Effort[] {
  return model?.supportsEffort === false ? [] : (model?.supportedEffortLevels ?? []).filter((level): level is Effort => EFFORT.includes(level));
}

/** Pure projection of discovery into the shared capabilities shape. Ids and names only: no credentials or accounts. */
export function claudeCodeCapabilities(discovery: ClaudeCodeDiscovery): RuntimeLaunchCapabilities {
  const levels = new Set<AgentReasoningLevel>(["off"]);
  for (const model of discovery.models) for (const level of efforts(model)) levels.add(level);
  const fallback = defaultRow(discovery.models);
  return {
    models: discovery.models.map(model => ({ provider: PROVIDER, id: model.value, name: model.displayName || model.value,
      reasoning: efforts(model).length > 0 })),
    reasoningLevels: ["off", ...EFFORT.filter(level => levels.has(level))],
    skills: discovery.skills.map(skill => ({ id: skill.name, name: skill.name, description: skill.description ?? "" })),
    ...(fallback ? { defaultModel: { provider: PROVIDER, id: fallback.value } } : {}),
  };
}

/** Shape check only (usable before any process exists). */
export function validateClaudeCodeSelection(config: AgentStartConfig): void {
  const { model, reasoningLevel, skillIds } = config;
  if (model !== undefined && (!model || typeof model !== "object" || Array.isArray(model) || model.provider !== PROVIDER
    || typeof model.id !== "string" || !model.id.trim() || model.id !== model.id.trim() || Buffer.byteLength(model.id) > 200
    || Object.keys(model).some(key => !["provider", "id"].includes(key)))) throw new Error("Unsupported Claude Code model selection");
  if (reasoningLevel !== undefined && !["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(reasoningLevel)) {
    throw new Error("Unsupported Claude Code reasoning level");
  }
  if (skillIds !== undefined && (!Array.isArray(skillIds) || skillIds.length > 64 || new Set(skillIds).size !== skillIds.length
    || skillIds.some(id => typeof id !== "string" || !id.trim() || id !== id.trim() || Buffer.byteLength(id) > 200))) {
    throw new Error("skillIds must contain at most 64 unique, non-empty skill ids");
  }
}

/** Launch-time SDK options for the selections (model/effort/thinking). Skills are applied by `claudeCodeSkillOptions`. */
export function claudeCodeSelectionOptions(config: AgentStartConfig): Pick<Options, "model" | "effort" | "maxThinkingTokens"> {
  const level = config.reasoningLevel;
  return {
    ...(config.model ? { model: config.model.id } : {}),
    ...(level === "off" ? { maxThinkingTokens: 0 } : level !== undefined ? { effort: level as Effort } : {}),
  };
}
export function claudeCodeSkillOptions(config: AgentStartConfig): Pick<Options, "skills"> {
  return config.skillIds === undefined ? {} : { skills: [...config.skillIds] };
}

/** Checks the selections against what THIS engine reports. Never downgrades silently: anything unsupported throws. */
export function verifyClaudeCodeSelection(config: AgentStartConfig, discovery: ClaudeCodeDiscovery): void {
  validateClaudeCodeSelection(config);
  const row = config.model ? find(discovery.models, config.model.id) : defaultRow(discovery.models);
  if (config.model && !row) throw new Error("Unsupported Claude Code model selection");
  const level = config.reasoningLevel;
  if (level !== undefined && level !== "off" && !efforts(row).includes(level as Effort)) throw new Error("Unsupported Claude Code reasoning level");
  if (config.skillIds) {
    const known = new Set(discovery.skills.map(skill => skill.name));
    if (config.skillIds.some(id => !known.has(id))) throw new Error("Unknown Claude Code skill");
  }
}

/** Vision support of the selected (or default) model. The engine reports no per-model flag; every Claude model it lists
 * accepts images, so a discovered model means true and anything undiscovered means not verified (false). */
export function claudeCodeSupportsImages(config: AgentStartConfig, discovery: ClaudeCodeDiscovery): boolean {
  return !!(config.model ? find(discovery.models, config.model.id) : defaultRow(discovery.models));
}

/** From the initialize answer. Skills are the non-builtin commands (user/project/plugin/MCP defined). */
export function claudeCodeDiscovery(init: { models?: ModelInfo[]; commands?: SlashCommand[] }): ClaudeCodeDiscovery {
  return { models: Array.isArray(init.models) ? init.models : [],
    skills: Array.isArray(init.commands) ? init.commands.filter(command => command && command.builtin !== true) : [] };
}
