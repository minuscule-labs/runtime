import { createHash } from "node:crypto";
import { isAbsolute } from "node:path";
import type { AgentReasoningLevel, AgentStartConfig, RuntimeLaunchCapabilities } from "@minu/runtime-core";
import { record, type CodexRpcProcess } from "./rpc.js";

export const CODEX_REASONING = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
const identifier = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/;
export function publicId(value: unknown): value is string {
  return typeof value === "string" && identifier.test(value) && !value.includes("://") && !value.includes("../") && !/^[A-Za-z]:[\\/]/.test(value)
    && !/^(?:sk|rk)-[A-Za-z0-9_-]{16,}$/.test(value);
}
export function reasoning(value: unknown): AgentReasoningLevel | undefined {
  const level = value === "none" ? "off" : value;
  return CODEX_REASONING.includes(level as AgentReasoningLevel) ? level as AgentReasoningLevel : undefined;
}
export function validateCodexConfig(config: AgentStartConfig): void {
  if (!config || typeof config !== "object" || Array.isArray(config)
    || (config.systemPrompt !== undefined && typeof config.systemPrompt !== "string")
    || (config.appendSystemPrompt !== undefined && typeof config.appendSystemPrompt !== "string")
    || (config.systemPrompt !== undefined && config.appendSystemPrompt !== undefined)
    // Explicit native IDs are not public discovery labels. Preserve them exactly.
    || (config.model !== undefined && (!config.model || typeof config.model.provider !== "string" || !config.model.provider.trim()
      || Buffer.byteLength(config.model.provider, "utf8") > 512 || /[\x00-\x1f\x7f]|[\uD800-\uDFFF]/u.test(config.model.provider)
      || typeof config.model.id !== "string" || !config.model.id.trim() || config.model.id.length > 512 || /[\x00-\x1f\x7f]/.test(config.model.id)))
    || (config.reasoningLevel !== undefined && !CODEX_REASONING.includes(config.reasoningLevel))
    || (config.skillIds !== undefined && (!Array.isArray(config.skillIds) || config.skillIds.length > 256
      || new Set(config.skillIds).size !== config.skillIds.length || config.skillIds.some(id => typeof id !== "string" || !/^codex-skill-[a-f0-9]{64}$/.test(id))))) {
    throw new Error("Invalid Codex launch selection");
  }
}
export interface NativeModel { id: string; levels: AgentReasoningLevel[]; defaultLevel?: AgentReasoningLevel; images?: boolean }
export async function nativeModels(rpc: CodexRpcProcess): Promise<NativeModel[]> {
  const models: NativeModel[] = [], cursors = new Set<string>(); let cursor: string | undefined;
  for (let page = 0; page < 10; page++) {
    const response = record(await rpc.request("model/list", { limit: 100, ...(cursor ? { cursor } : {}) }));
    if (!response || !Array.isArray(response.data) || response.data.length > 100) throw new Error("Invalid native model catalog");
    for (const entry of response.data) {
      const model = record(entry);
      if (!model || !publicId(model.model) || models.some(m => m.id === model.model)
        || !Array.isArray(model.supportedReasoningEfforts) || model.supportedReasoningEfforts.length > 32
        || model.supportedReasoningEfforts.some(value => typeof record(value)?.reasoningEffort !== "string")
        || (model.defaultReasoningEffort !== undefined && model.defaultReasoningEffort !== null && typeof model.defaultReasoningEffort !== "string")) throw new Error("Invalid native model metadata");
      const levels = model.supportedReasoningEfforts.map(v => reasoning(record(v)?.reasoningEffort)).filter((v): v is AgentReasoningLevel => v !== undefined);
      const modalities = model.inputModalities;
      if (modalities !== undefined && (!Array.isArray(modalities) || modalities.length > 16 || modalities.some(value => typeof value !== "string"))) throw new Error("Invalid native input metadata");
      models.push({ id: model.model, levels: [...new Set(levels)], defaultLevel: reasoning(model.defaultReasoningEffort),
        ...(Array.isArray(modalities) && modalities.every(v => typeof v === "string") ? { images: modalities.includes("image") } : {}) });
    }
    if (response.nextCursor === null) return models;
    if (typeof response.nextCursor !== "string" || !response.nextCursor || response.nextCursor.length > 4096 || cursors.has(response.nextCursor)) throw new Error("Invalid model continuation");
    cursor = response.nextCursor; cursors.add(cursor);
  }
  throw new Error("Native model catalog exceeds bounds");
}
// Plugin skills are reported as "plugin:skill".
const skillName = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}(?::[A-Za-z0-9][A-Za-z0-9_-]{0,127})?$/;
interface NativeSkill { id: string; name: string; description: string; path: string }
export async function nativeSkills(rpc: CodexRpcProcess, cwd: string): Promise<NativeSkill[]> {
  const response = record(await rpc.request("skills/list", { cwds: [cwd], forceReload: true }));
  if (!response || !Array.isArray(response.data) || response.data.length !== 1) throw new Error("Invalid native skill catalog");
  const entry = record(response.data[0]);
  if (!entry || entry.cwd !== cwd || !Array.isArray(entry.errors) || entry.errors.length || !Array.isArray(entry.skills) || entry.skills.length > 256) throw new Error("Native skills unavailable");
  const skills: NativeSkill[] = [];
  for (const value of entry.skills) {
    const skill = record(value);
    if (!skill || typeof skill.path !== "string" || !isAbsolute(skill.path) || skill.path.length > 4096 || typeof skill.enabled !== "boolean"
      || typeof skill.name !== "string" || !skillName.test(skill.name) || typeof skill.description !== "string") throw new Error("Invalid native skill metadata");
    const id = `codex-skill-${createHash("sha256").update(skill.path).digest("hex")}`;
    if (skills.some(s => s.id === id)) throw new Error("Duplicate native skill identity");
    // Descriptions are human-authored, not an authority to publish native paths.
    const description = skill.description.length <= 1024 && !/[\\/\r\n\x00-\x1f]|(?:api[_-]?key|bearer\s|sk-[A-Za-z0-9])/i.test(skill.description) ? skill.description : "";
    skills.push({ id, name: skill.name, description, path: skill.path });
  }
  return skills;
}
export async function skillOverrides(rpc: CodexRpcProcess, cwd: string, ids: string[]): Promise<Record<string, unknown>> {
  const skills = await nativeSkills(rpc, cwd);
  if (ids.some(id => !skills.some(s => s.id === id))) throw new Error("Selected native skill is unavailable");
  return { skills: { config: skills.map(skill => ({ path: skill.path, enabled: ids.includes(skill.id) })) } };
}

/** The caller owns this temporary RPC and must confirm shutdown before returning. */
export async function discoverNativeLaunch(rpc: CodexRpcProcess, cwd: string): Promise<RuntimeLaunchCapabilities> {
  const models = await nativeModels(rpc), skills = await nativeSkills(rpc, cwd);
  const response = record(await rpc.request("thread/start", { cwd, ephemeral: true, sandbox: "read-only", approvalPolicy: "never" }));
  const thread = record(response?.thread);
  if (!response || !thread || typeof thread.id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(thread.id) || thread.ephemeral !== true || thread.path !== null || thread.cwd !== cwd || response.cwd !== cwd
    || record(thread.status)?.type !== "idle" || response.approvalPolicy !== "never" || record(response.sandbox)?.type !== "readOnly"
    || !publicId(response.model) || !publicId(response.modelProvider)
    || (response.reasoningEffort !== null && typeof response.reasoningEffort !== "string")) throw new Error("Native ephemeral discovery could not be verified");
  const selected = models.find(m => m.id === response.model);
  const level = reasoning(response.reasoningEffort) ?? (response.reasoningEffort === null ? selected?.defaultLevel : undefined);
  return { models: models.map(model => ({ provider: response.modelProvider as string, id: model.id, name: model.id, reasoning: model.levels.some(level => level !== "off") })),
    reasoningLevels: CODEX_REASONING.filter(level => models.some(model => model.levels.includes(level))),
    skills: skills.map(({ id, name, description }) => ({ id, name, description })),
    defaultModel: { provider: response.modelProvider, id: response.model }, ...(level ? { defaultReasoningLevel: level } : {}) };
}
