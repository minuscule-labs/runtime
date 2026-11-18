import { isAbsolute, resolve } from "node:path";
import { workerIdentity, workerToken } from "./worker-protocol.js";

export const CLAUDE_CODE_WORKER_REGISTRATION_MAX_BYTES = 16 * 1024;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const SCOPE_KEYS = ["sessionId", "ownerId", "generation", "reservationId", "workerExecutable", "cwd", "nativeConfigRoot"] as const;
const KEYS = ["version", "runtime", "ownership", ...SCOPE_KEYS, "pid", "processGroupId", "endpoint", "token", "createdAt"] as const;

export interface ClaudeCodeWorkerRegistrationScope {
  sessionId: string;
  ownerId: string;
  generation: string;
  reservationId: string;
  workerExecutable: string;
  cwd: string;
  nativeConfigRoot: string;
}
/** Private descriptor only. A valid PID/group is NOT verified process ownership. */
export interface ClaudeCodeWorkerRegistration extends ClaudeCodeWorkerRegistrationScope {
  version: 1;
  runtime: "claude-code";
  ownership: "owned";
  pid: number;
  /** null carries no group-recovery eligibility. */
  processGroupId: number | null;
  endpoint: string;
  /** Private worker transport token, never a provider credential. */
  token: string;
  createdAt: string;
}
export class ClaudeCodeWorkerRegistrationError extends Error {
  constructor(readonly code: "invalid_registration" | "invalid_scope" | "scope_mismatch" | "unsupported_version" | "invalid_payload" | "invalid_utf8" | "invalid_json" | "payload_too_large") {
    super(`Claude Code worker registration rejected (${code})`);
    this.name = "ClaudeCodeWorkerRegistrationError";
  }
}
// Only locally generated rejections carry trusted codes. Do not classify caller
// exceptions with instanceof/property reads: Proxy traps and code getters can run
// arbitrary caller code, and even exported error instances can contain secrets.
const rejections = new WeakMap<object, ClaudeCodeWorkerRegistrationError["code"]>();
function reject(code: ClaudeCodeWorkerRegistrationError["code"]): never {
  const error = new ClaudeCodeWorkerRegistrationError(code);
  rejections.set(error, code);
  throw error;
}
function sanitized(error: unknown, fallback: "invalid_registration" | "invalid_scope"): ClaudeCodeWorkerRegistrationError {
  const code = (typeof error === "object" && error !== null) || typeof error === "function"
    ? rejections.get(error) : undefined;
  return new ClaudeCodeWorkerRegistrationError(code ?? fallback);
}

/** Snapshot data properties only; never invoke getters or retain caller objects. */
function snapshot(value: unknown, keys: readonly string[], code: "invalid_registration" | "invalid_scope"): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) reject(code);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) reject(code);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const names = Reflect.ownKeys(descriptors);
  if (names.length !== keys.length || names.some(key => typeof key !== "string" || !keys.includes(key))) reject(code);
  const result: Record<string, unknown> = {};
  for (const key of keys) {
    const descriptor = descriptors[key];
    if (!descriptor || !("value" in descriptor)) reject(code);
    result[key] = descriptor.value;
  }
  return result;
}
function path(value: unknown): value is string {
  return typeof value === "string" && !value.includes("\0") && Buffer.byteLength(value, "utf8") <= 4096
    && Buffer.from(value, "utf8").toString("utf8") === value && isAbsolute(value) && resolve(value) === value;
}
function validateScope(value: Record<string, unknown>, code: "invalid_registration" | "invalid_scope"): void {
  try { workerIdentity(value as unknown as ClaudeCodeWorkerRegistrationScope); }
  catch { reject(code); }
  if (typeof value.reservationId !== "string" || !UUID.test(value.reservationId)
    || !path(value.workerExecutable) || !path(value.cwd) || !path(value.nativeConfigRoot)) reject(code);
}
function expectedScope(value: unknown): Record<string, unknown> {
  try {
    const expected = snapshot(value, SCOPE_KEYS, "invalid_scope");
    validateScope(expected, "invalid_scope");
    return expected;
  } catch (error) {
    throw sanitized(error, "invalid_scope");
  }
}
function validate(value: unknown, expected: Record<string, unknown>): ClaudeCodeWorkerRegistration {
  const data = snapshot(value, KEYS, "invalid_registration");
  if (data.version !== 1) reject("unsupported_version");
  if (data.runtime !== "claude-code" || data.ownership !== "owned") reject("invalid_registration");
  validateScope(data, "invalid_registration");
  for (const key of SCOPE_KEYS) if (data[key] !== expected[key]) reject("scope_mismatch");
  if (!Number.isInteger(data.pid) || typeof data.pid !== "number" || data.pid < 1 || data.pid > 2_147_483_647
    || !(data.processGroupId === null || data.processGroupId === data.pid)) reject("invalid_registration");
  if (typeof data.endpoint !== "string") reject("invalid_registration");
  try {
    const url = new URL(data.endpoint);
    // Same explicit-port loopback contract as the worker client. origin equality
    // also rejects alternate IP spellings, leading-zero ports and trailing '/'.
    if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || !url.port
      || Number(url.port) < 1 || url.origin !== data.endpoint) reject("invalid_registration");
  } catch { reject("invalid_registration"); }
  try { workerToken(data.token as string); } catch { reject("invalid_registration"); }
  if (typeof data.createdAt !== "string" || !Number.isFinite(Date.parse(data.createdAt))
    || new Date(data.createdAt).toISOString() !== data.createdAt) reject("invalid_registration");
  return data as unknown as ClaudeCodeWorkerRegistration;
}

/** Pure codec: no publication/discovery, authentication, liveness or stop authority. */
export function encodeClaudeCodeWorkerRegistration(
  registration: ClaudeCodeWorkerRegistration, scope: ClaudeCodeWorkerRegistrationScope,
): Uint8Array {
  const expected = expectedScope(scope);
  try {
    const validated = validate(registration, expected);
    const bytes = new TextEncoder().encode(JSON.stringify(validated));
    if (bytes.byteLength > CLAUDE_CODE_WORKER_REGISTRATION_MAX_BYTES) reject("payload_too_large");
    return bytes;
  } catch (error) {
    throw sanitized(error, "invalid_registration");
  }
}

/** Decode only the exact expected owner/session/generation/reservation/path scope. */
export function decodeClaudeCodeWorkerRegistration(
  payload: Uint8Array, scope: ClaudeCodeWorkerRegistrationScope,
): ClaudeCodeWorkerRegistration {
  const expected = expectedScope(scope);
  try {
    if (!(payload instanceof Uint8Array)) reject("invalid_payload");
    if (payload.byteLength > CLAUDE_CODE_WORKER_REGISTRATION_MAX_BYTES) reject("payload_too_large");
    let source: string;
    try {
      // Preserve BOM so JSON.parse rejects it rather than silently repairing it.
      source = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(payload);
    } catch { reject("invalid_utf8"); }
    let value: unknown;
    try { value = JSON.parse(source); } catch { reject("invalid_json"); }
    return validate(value, expected);
  } catch (error) {
    throw sanitized(error, "invalid_registration");
  }
}
