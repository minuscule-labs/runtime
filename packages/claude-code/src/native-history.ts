import { createHash } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { lstat, open, realpath, type FileHandle } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { setImmediate } from "node:timers/promises";
import type { RuntimeMessage } from "@minu/runtime-core";

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
export const CLAUDE_HISTORY_LIMITS = Object.freeze({
  bytes: 8 * 1024 * 1024, lineBytes: 1024 * 1024, records: 20_000,
  messages: 2_000, textBytes: 1024 * 1024,
});

/** Supported native engine range (row `version`); anything outside fails closed as unsupported_format. */
export const CLAUDE_CODE_SUPPORTED_RANGE = ">=2.1.300 <3";
export function claudeCodeVersionSupported(version: unknown): boolean {
  const match = typeof version === "string" ? /^(\d+)\.(\d+)\.(\d+)(?:[-+][0-9A-Za-z.-]+)?$/.exec(version) : null;
  if (!match) return false;
  const [major, minor, patch] = [Number(match[1]), Number(match[2]), Number(match[3])];
  return major === 2 && (minor > 1 || (minor === 1 && patch >= 300));
}

export interface ClaudeCodeHistoryOptions {
  nativeSessionId: string;
  canonicalCwd: string;
  /** Exact authorized native home, not Runtime's manifest storage directory. */
  nativeConfigRoot: string;
  signal?: AbortSignal;
  /** The root is the user's native Claude Code configuration (not Runtime-private storage). */
  nativeRoot?: boolean;
  /** Managed sessions can be steered: accept the engine's queued_command deliveries (structure-only reads) instead of failing closed. */
  acceptQueuedDeliveries?: boolean;
  /** Extra clean-resume check against an ALREADY committed completed dispatch.
   * Never derives caller settlement; requires pinned end_turn + final leaf materialization. */
  completedInput?: { nativeMessageId: string; fingerprint: string;
    /** sha256 of each steering message Runtime recorded for this dispatch. Only these queued deliveries may appear mid-turn. */
    steers?: string[] };
}
export type ClaudeCodeHistorySnapshot =
  | { state: "missing" }
  | { state: "present"; messages: RuntimeMessage[]; evidence: { sha256: string; bytes: number; records: number } };

/** Deliberately omits file paths, native payloads and underlying filesystem errors. */
export class ClaudeCodeHistoryError extends Error {
  constructor(readonly code: "invalid_input" | "unsafe_file" | "changed" | "invalid_history" | "unsupported_format" | "unsupported_host" | "too_large") {
    super(`Claude Code native history rejected (${code})`);
    this.name = "ClaudeCodeHistoryError";
  }
}
function reject(code: ClaudeCodeHistoryError["code"]): never { throw new ClaudeCodeHistoryError(code); }
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const absent = (error: unknown) => object(error) && error.code === "ENOENT";
function absolute(value: string): boolean {
  return typeof value === "string" && !value.includes("\0") && isAbsolute(value) && resolve(value) === value;
}
function identity(a: Stats, b: Stats): boolean { return a.dev === b.dev && a.ino === b.ino; }
// Default: private (0o077 clear). "native" configuration roots (a normal ~/.claude is world-readable) only
// require owner ownership and no group/other WRITE access; reads never become authority to trust another user's file.
function safe(metadata: Stats, directory: boolean, native = false): boolean {
  return (directory ? metadata.isDirectory() : metadata.isFile() && metadata.nlink === 1)
    && !(metadata.mode & (native ? 0o022 : 0o077)) && (!process.getuid || metadata.uid === process.getuid());
}

// Pinned SDK 0.3.321: rd/gl/xTe/eC. No env-dependent project-directory override,
// collision fallback, legacy directory search or cross-project lookup is performed.
function projectKey(cwd: string): string {
  const normalized = process.platform === "darwin" ? cwd.normalize("NFC") : cwd;
  const escaped = normalized.replace(/[^a-zA-Z0-9]/g, "-");
  if (escaped.length <= 200) return escaped;
  let hash = 0;
  for (let i = 0; i < normalized.length; i++) hash = ((hash << 5) - hash + normalized.charCodeAt(i)) | 0;
  return `${escaped.slice(0, 200)}-${Math.abs(hash).toString(36)}`;
}
// Internal creation uses the identical pinned encoding; not a public Runtime API.
export { projectKey as claudeCodeNativeProjectKey };

interface PinnedDirectory { path: string; metadata: Stats; handle: FileHandle }
async function verifyDirectory(directory: PinnedDirectory, native = false): Promise<void> {
  const current = await lstat(directory.path);
  const held = await directory.handle.stat();
  if (!safe(current, true, native) || !safe(held, true, native) || !identity(current, directory.metadata)
    || !identity(held, directory.metadata) || await realpath(directory.path) !== directory.path) reject("changed");
}

/**
 * Read-only, bounded evidence inspection for pinned native 2.1.321 linear histories.
 * Caller must hold exact-owner/generation lifecycle admission and prevent native
 * writers until launch. This is NOT ownership, readiness or turn-settlement proof.
 * Unsupported branching/compaction/queued-delivery formats fail closed; no repair,
 * SDK reads, environment mutation, launch, fallback creation or replay takes place.
 */
export async function inspectClaudeCodeHistory(options: ClaudeCodeHistoryOptions): Promise<ClaudeCodeHistorySnapshot> {
  options = { ...options, ...(options.completedInput ? { completedInput: { ...options.completedInput } } : {}) };
  const { nativeSessionId, canonicalCwd, nativeConfigRoot, signal, completedInput } = options;
  const native = options.nativeRoot === true;
  signal?.throwIfAborted();
  // The safety contract requires POSIX ownership and no-follow directory opens.
  if (!process.getuid || !constants.O_NOFOLLOW || !constants.O_DIRECTORY) reject("unsupported_host");
  if (typeof nativeSessionId !== "string" || !UUID.test(nativeSessionId)
    || !absolute(canonicalCwd) || !absolute(nativeConfigRoot)
    || (completedInput !== undefined && (!object(completedInput) || typeof completedInput.nativeMessageId !== "string"
      || typeof completedInput.fingerprint !== "string" || !UUID.test(completedInput.nativeMessageId) || !/^[a-f0-9]{64}$/.test(completedInput.fingerprint)))) reject("invalid_input");
  const directories: PinnedDirectory[] = [];
  let file: FileHandle | undefined;
  try {
    if (await realpath(canonicalCwd) !== canonicalCwd || !(await lstat(canonicalCwd)).isDirectory()) reject("invalid_input");
    const paths = [nativeConfigRoot, join(nativeConfigRoot, "projects"), join(nativeConfigRoot, "projects", projectKey(canonicalCwd))];
    for (const path of paths) {
      signal?.throwIfAborted();
      let metadata: Stats;
      try { metadata = await lstat(path); }
      catch (error) {
        if (!absent(error)) throw error;
        for (const directory of directories) await verifyDirectory(directory, native);
        return { state: "missing" };
      }
      if (!safe(metadata, true, native) || await realpath(path) !== path) reject("unsafe_file");
      const handle = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      directories.push({ path, metadata, handle });
      await verifyDirectory(directories.at(-1)!, native);
    }
    const path = join(paths[2], `${nativeSessionId}.jsonl`);
    let metadata: Stats;
    try { metadata = await lstat(path); }
    catch (error) {
      if (!absent(error)) throw error;
      for (const directory of directories) await verifyDirectory(directory, native);
      return { state: "missing" };
    }
    if (!safe(metadata, false, native) || await realpath(path) !== path) reject("unsafe_file");
    if (metadata.size > CLAUDE_HISTORY_LIMITS.bytes) reject("too_large");
    // NONBLOCK prevents a regular-file-to-FIFO replacement from hanging open().
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const before = await file.stat();
    if (!safe(before, false, native) || !identity(before, metadata)) reject("changed");
    const buffer = Buffer.alloc(CLAUDE_HISTORY_LIMITS.bytes + 1);
    let length = 0;
    while (length < buffer.length) {
      signal?.throwIfAborted();
      const { bytesRead } = await file.read(buffer, length, Math.min(64 * 1024, buffer.length - length), length);
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length > CLAUDE_HISTORY_LIMITS.bytes) reject("too_large");
    const after = await file.stat();
    const current = await lstat(path);
    if (!safe(after, false, native) || !safe(current, false, native) || !identity(before, current)
      || before.size !== length || after.size !== length || current.size !== length
      || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs
      || before.mtimeMs !== current.mtimeMs || before.ctimeMs !== current.ctimeMs) reject("changed");
    for (const directory of directories) await verifyDirectory(directory, native);
    const bytes = buffer.subarray(0, length);
    const parsed = await parse(bytes, options);
    // Check again after cooperative parsing, before returning the snapshot.
    signal?.throwIfAborted();
    const final = await lstat(path);
    if (!safe(final, false, native) || !identity(before, final) || final.size !== length
      || final.mtimeMs !== before.mtimeMs || final.ctimeMs !== before.ctimeMs) reject("changed");
    for (const directory of directories) await verifyDirectory(directory, native);
    return { state: "present", messages: parsed.messages, evidence: {
      sha256: createHash("sha256").update(bytes).digest("hex"), bytes: length, records: parsed.records,
    } };
  } catch (error) {
    signal?.throwIfAborted();
    if (error instanceof ClaudeCodeHistoryError) throw error;
    throw new ClaudeCodeHistoryError("unsafe_file");
  } finally {
    await file?.close();
    for (const directory of directories.reverse()) await directory.handle.close();
  }
}

const CHAIN = new Set(["user", "assistant", "attachment"]);
// Non-chain records observed in the pinned engine's persisted text sessions.
const METADATA = new Set(["queue-operation", "atis-latch", "api-request-shape", "api-request-blob", "api-request", "last-prompt", "cost-state", "mode", "tools-used"]);
const ATTACHMENTS = new Set(["environment", "model", "session_context", "date", "prompt_snapshot",
  // Observed from the bundled engine in tool/agent turns (bookkeeping, never input).
  "deferred_tools_delta", "agent_listing_delta", "skill_listing", "auto_mode", "remote_session_change",
  // Written after Write/Edit/Bash change a tracked file (observed from the real engine).
  "edited_text_file"]);
function opaqueBlock(block: Record<string, unknown>): void {
  if (block.type === "image") {
    const source = block.source;
    if (!object(source) || !(source.type === "base64" ? typeof source.data === "string" && typeof source.media_type === "string"
      : source.type === "url" && typeof source.url === "string")) reject("invalid_history");
  } else if (block.type === "thinking") {
    if (typeof block.thinking !== "string" || (block.signature !== undefined && typeof block.signature !== "string")) reject("invalid_history");
  } else if (block.type === "redacted_thinking") {
    if (typeof block.data !== "string") reject("invalid_history");
  } else reject("unsupported_format");
}
async function parse(bytes: Buffer, options: ClaudeCodeHistoryOptions): Promise<{ messages: RuntimeMessage[]; records: number }> {
  if (!bytes.length || bytes.at(-1) !== 10) reject("invalid_history");
  let source: string;
  try { source = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch { reject("invalid_history"); }
  const lines = source!.slice(0, -1).split("\n");
  if (lines.length > CLAUDE_HISTORY_LIMITS.records) reject("too_large");
  const messages: RuntimeMessage[] = [];
  const seen = new Set<string>();
  const toolNames = new Map<string, string>();
  let parent: string | null = null;
  let textBytes = 0;
  let users = 0;
  let matchedInput = false, terminal: string | undefined, terminalResponse: string | undefined, lastPrompt: string | undefined;
  // A queued prompt is its text, or `null` for block content (images), which the engine records without `content`.
  let queued: string | null | undefined, dequeued: string | null | undefined;
  // Steering: the enqueue/remove pair and queued_command delivery of messages Runtime itself recorded for this dispatch.
  let steerQueued: string | undefined, steerRemoved: string | undefined;
  const steers = new Set(options.completedInput?.steers ?? []);
  let imageMetaOk = false;
  const append = (role: RuntimeMessage["role"], content: string, timestamp: number, toolName?: string) => {
    if (!content) return;
    textBytes += Buffer.byteLength(content);
    if (messages.length >= CLAUDE_HISTORY_LIMITS.messages || textBytes > CLAUDE_HISTORY_LIMITS.textBytes) reject("too_large");
    messages.push({ role, content, timestamp, ...(toolName === undefined ? {} : { toolName }) });
  };
  for (let index = 0; index < lines.length; index++) {
    if (index % 100 === 0) { await setImmediate(); options.signal?.throwIfAborted(); }
    const line = lines[index];
    if (Buffer.byteLength(line) > CLAUDE_HISTORY_LIMITS.lineBytes) reject("too_large");
    let entry: unknown;
    try { entry = JSON.parse(line); } catch { reject("invalid_history"); }
    if (!object(entry) || typeof entry.type !== "string") reject("invalid_history");
    const row = entry as Record<string, unknown>;
    for (const flag of ["isMeta", "isVisibleInTranscriptOnly"]) {
      if (row[flag] !== undefined && typeof row[flag] !== "boolean") reject("invalid_history");
    }
    if (row.sessionId !== options.nativeSessionId || (row.cwd !== undefined && row.cwd !== options.canonicalCwd)) reject("invalid_history");
    if (row.version !== undefined && !claudeCodeVersionSupported(row.version)) reject("unsupported_format");
    if (!CHAIN.has(row.type as string)) {
      if (!METADATA.has(row.type as string) || row.uuid !== undefined || row.parentUuid !== undefined) reject("unsupported_format");
      if (options.completedInput && row.type === "queue-operation") {
        if (Object.keys(row).some(key => !["type", "operation", "timestamp", "sessionId", "content"].includes(key))
          || typeof row.timestamp !== "string" || !Number.isFinite(Date.parse(row.timestamp))) reject("unsupported_format");
        if (row.operation === "enqueue" && (typeof row.content === "string" || row.content === undefined)
          && queued === undefined && dequeued === undefined && steerQueued === undefined && steerRemoved === undefined) {
          if (matchedInput && typeof row.content === "string" && steers.has(createHash("sha256").update(row.content).digest("hex"))) steerQueued = row.content;
          else queued = row.content ?? null;
        } else if (row.operation === "dequeue" && row.content === undefined && queued !== undefined && dequeued === undefined) {
          dequeued = queued; queued = undefined;
        } else if (row.operation === "remove" && typeof row.content === "string" && (steerQueued === row.content || (!matchedInput && queued === row.content))) {
          // Before the committed input these are earlier, already-settled turns' steering (structure only); after it only the
          // recorded steering of THIS dispatch is accepted (the enqueue was only classified as one if its hash was recorded).
          steerRemoved = row.content; steerQueued = undefined; if (!matchedInput) queued = undefined;
        } else reject("invalid_history");
      }
      if (row.type === "last-prompt") {
        // The engine appends this asynchronously, so mid-file it may name an earlier row than the chain tip; it must still name a
        // row of this chain. The completed-input check below requires the LAST one to be the terminal leaf.
        if (typeof row.leafUuid !== "string" || !seen.has(row.leafUuid)) reject("invalid_history");
        lastPrompt = row.leafUuid as string;
      }
      if (row.type === "tools-used") {
        // Exact non-chain bookkeeping shape observed in pinned 2.1.321 Read
        // history. Names are opaque metadata, never permissions or settlement.
        if (Object.keys(row).some(key => key !== "type" && key !== "tools" && key !== "sessionId")) reject("unsupported_format");
        if (!Array.isArray(row.tools) || row.tools.some(name => typeof name !== "string" || !name || Buffer.byteLength(name) > 128)) reject("invalid_history");
      }
      continue;
    }
    if (!claudeCodeVersionSupported(row.version) || row.isCompactSummary === true) reject("unsupported_format");
    if (row.cwd !== options.canonicalCwd || row.isSidechain !== false || row.teamName !== undefined
      || typeof row.uuid !== "string" || !UUID.test(row.uuid) || seen.has(row.uuid)
      || row.parentUuid !== parent || typeof row.timestamp !== "string" || !Number.isFinite(Date.parse(row.timestamp))) reject("invalid_history");
    seen.add(row.uuid as string);
    parent = row.uuid as string;
    if (row.type === "attachment") {
      if (object(row.attachment) && row.attachment.type === "queued_command") {
        // Only a mid-turn delivery of a steering message Runtime recorded (exact text, once), never new input after the tail.
        const prompt = row.attachment.prompt;
        if (!options.acceptQueuedDeliveries && !options.completedInput) reject("unsupported_format");
        if (typeof prompt !== "string" || (row.attachment.source_uuid !== undefined
          && (typeof row.attachment.source_uuid !== "string" || !UUID.test(row.attachment.source_uuid)))) reject("unsupported_format");
        // Structure-only reads (resume, messages) just validate it; the completed-input check requires an exact recorded delivery.
        if (options.completedInput && (terminal || steerRemoved !== prompt
          || (matchedInput && !steers.delete(createHash("sha256").update(prompt).digest("hex"))))) reject("unsupported_format");
        steerRemoved = undefined;
        continue;
      }
      if (!object(row.attachment) || !ATTACHMENTS.has(row.attachment.type as string)) reject("unsupported_format");
      if (options.completedInput && terminal) {
        // Pinned text sessions may snapshot the effective prompt AFTER end_turn.
        // Only that non-input bookkeeping can advance the completed leaf.
        if (row.attachment.type !== "prompt_snapshot") reject("unsupported_format");
        if (row.parentUuid !== terminal) reject("invalid_history");
        terminal = row.uuid as string; terminalResponse = undefined;
      }
      if (row.attachment.type === "environment" && (!object(row.attachment.snapshot)
        || row.attachment.snapshot.workingDirectory !== options.canonicalCwd)) reject("invalid_history");
      continue;
    }
    if (!object(row.message) || row.message.role !== row.type) reject("invalid_history");
    const message = row.message as Record<string, unknown>;
    if (row.type === "user") users++;
    // These are native bookkeeping/hidden prompts, not public response text.
    const hidden = row.isMeta === true || row.isVisibleInTranscriptOnly === true || message.model === "<synthetic>";
    const timestamp = Date.parse(row.timestamp as string);
    const content = message.content;
    if (options.completedInput) {
      // Visibility only filters public text; it must not bypass input/tail checks.
      // Native persists thinking/text blocks of ONE completed API response as
      // separate assistant rows carrying the same message id and end_turn.
      if (terminal && !(row.type === "assistant" && !hidden && terminalResponse !== undefined
        && message.id === terminalResponse && message.stop_reason === "end_turn")) reject("invalid_history");
      // A prompt is its single text block (or string); image blocks accompany it and never change its identity/fingerprint.
      const blocks = Array.isArray(content) && content.length && content.every(block => object(block) && (block.type === "text" || block.type === "image"))
        ? content as Record<string, unknown>[] : undefined;
      const texts = blocks?.filter(block => block.type === "text");
      const text = typeof content === "string" ? content
        : blocks && texts!.length <= 1 && (texts!.length === 0 || typeof texts![0].text === "string") ? (texts![0]?.text as string | undefined) ?? "" : undefined;
      const hasImage = !!blocks?.some(block => block.type === "image");
      if (row.type === "user" && !hidden && text !== undefined && dequeued !== undefined) {
        if (dequeued === null ? typeof content === "string" : text !== dequeued) reject("invalid_history");
        dequeued = undefined;
      }
      if (row.uuid === options.completedInput.nativeMessageId) {
        if (row.type !== "user" || hidden || text === undefined || Buffer.from(text).toString() !== text
          || createHash("sha256").update(text).digest("hex") !== options.completedInput.fingerprint) reject("invalid_history");
        matchedInput = true; terminal = undefined; terminalResponse = undefined; imageMetaOk = hasImage;
      } else if (matchedInput && row.type === "user" && imageMetaOk && hidden && row.isMeta === true && Array.isArray(content) && content.length === 1
        && object(content[0]) && content[0].type === "text" && typeof content[0].text === "string" && content[0].text.startsWith("[Image: source: ")) {
        // The engine's hidden pointer to a stored image, directly after the committed image input. Not a new prompt.
      } else if (matchedInput && row.type === "user" && (typeof content === "string"
        || !Array.isArray(content) || !content.length || content.some(block => !object(block) || block.type !== "tool_result"))) {
        // A later native/user prompt is not the committed last dispatch we checked.
        reject("invalid_history");
      }
      if (matchedInput && row.type === "assistant") {
        if (hidden) reject("invalid_history");
        imageMetaOk = false;
        terminal = message.stop_reason === "end_turn" ? row.uuid as string : undefined;
        terminalResponse = terminal && typeof message.id === "string" ? message.id : undefined;
      }
    }
    if (typeof content === "string") {
      if (!hidden) append(row.type as "user" | "assistant", content, timestamp);
      continue;
    }
    if (!Array.isArray(content)) reject("invalid_history");
    const texts: string[] = [];
    const flush = () => {
      if (!hidden) append(row.type as "user" | "assistant", texts.join("\n"), timestamp);
      texts.length = 0;
    };
    for (const block of content as unknown[]) {
      if (!object(block) || typeof block.type !== "string") reject("invalid_history");
      if (block.type === "text") {
        if (typeof block.text !== "string") reject("invalid_history");
        texts.push(block.text as string);
      } else if (block.type === "tool_use") {
        if (row.type !== "assistant" || typeof block.id !== "string" || !block.id || Buffer.byteLength(block.id) > 256
          || typeof block.name !== "string" || !block.name || Buffer.byteLength(block.name) > 128
          || !object(block.input) || toolNames.has(block.id)) reject("invalid_history");
        toolNames.set(block.id as string, block.name as string);
      } else if (block.type === "tool_result") {
        flush();
        if (row.type !== "user" || typeof block.tool_use_id !== "string" || !toolNames.has(block.tool_use_id)) reject("invalid_history");
        let result: string;
        if (typeof block.content === "string") result = block.content;
        else if (Array.isArray(block.content)) {
          const parts: string[] = [];
          for (const part of block.content) {
            if (!object(part) || typeof part.type !== "string") reject("invalid_history");
            if (part.type === "text") {
              if (typeof part.text !== "string") reject("invalid_history");
              parts.push(part.text as string);
            } else if (part.type === "image") { opaqueBlock(part); parts.push("[image]"); }
            else reject("unsupported_format");
          }
          result = parts.join("\n");
        } else reject("invalid_history");
        if (!hidden) append("tool", result!, timestamp, toolNames.get(block.tool_use_id as string));
        toolNames.delete(block.tool_use_id as string);
      } else {
        opaqueBlock(block);
        if (block.type === "image") texts.push("[image]"); // Placeholder only: pixels never enter text history.
      }
      // Image pixels, reasoning/signatures and tool inputs never enter text
      // history. Unknown block formats fail closed rather than being repaired.
    }
    flush();
  }
  if (!users || (options.completedInput && (!matchedInput || !terminal || terminal !== parent || lastPrompt !== terminal || toolNames.size || queued !== undefined || dequeued !== undefined || steerQueued !== undefined || steerRemoved !== undefined))) reject("invalid_history");
  return { messages, records: lines.length };
}
