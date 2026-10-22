/** Existing-session observations only: never launch settings, prompts, paths or turn usage. */
export interface RuntimeSessionProfile {
  version: 1;
  capturedAt: string;
  model: { status: "verified"; provider: string; id: string } | { status: "not_verified" };
  reasoning: { status: "verified"; level: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" } | { status: "not_verified" };
  /** Commands available in this process, not evidence of instructions loaded or used in a turn. */
  skills: { status: "verified"; commandIds: string[]; complete: boolean } | { status: "not_verified" };
}
export const SESSION_PROFILE_LIMITS = { bytes: 16 * 1024, skills: 64, readMs: 2_000 } as const;

/** Explicit reconstruction on both sides of a transport; unknown fields never pass through. */
export function sessionProfile(input: unknown): RuntimeSessionProfile {
  const object = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const raw = object(input);
  if (raw.version !== 1 || typeof raw.capturedAt !== "string" || raw.capturedAt.length !== 24
    || !Number.isFinite(Date.parse(raw.capturedAt)) || new Date(raw.capturedAt).toISOString() !== raw.capturedAt) throw new Error("Session profile unavailable");
  const id = (value: unknown, maximum: number) => typeof value === "string" && value.length <= maximum
    && /^[a-zA-Z0-9][a-zA-Z0-9_.:/@+-]*$/.test(value) && !value.includes("..") && !value.includes("://") && !/^[a-zA-Z]:\//.test(value);
  const model = object(raw.model), reasoning = object(raw.reasoning), skills = object(raw.skills);
  const levels = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
  const profile: RuntimeSessionProfile = {
    version: 1, capturedAt: raw.capturedAt,
    model: model.status === "verified" && id(model.provider, 100) && id(model.id, 300)
      ? { status: "verified", provider: model.provider as string, id: model.id as string } : { status: "not_verified" },
    reasoning: reasoning.status === "verified" && levels.includes(reasoning.level as typeof levels[number])
      ? { status: "verified", level: reasoning.level as typeof levels[number] } : { status: "not_verified" },
    skills: { status: "not_verified" },
  };
  if (skills.status === "verified" && Array.isArray(skills.commandIds) && typeof skills.complete === "boolean") {
    const valid = skills.commandIds.slice(0, SESSION_PROFILE_LIMITS.skills).filter((value): value is string =>
      typeof value === "string" && /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,199}$/.test(value));
    profile.skills = { status: "verified", commandIds: [...new Set(valid)],
      complete: skills.complete && skills.commandIds.length <= SESSION_PROFILE_LIMITS.skills && valid.length === skills.commandIds.length };
  }
  if (new TextEncoder().encode(JSON.stringify(profile)).byteLength > SESSION_PROFILE_LIMITS.bytes) throw new Error("Session profile unavailable");
  return profile;
}
