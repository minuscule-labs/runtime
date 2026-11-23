import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { chmod, link, mkdir, mkdtemp, readFile, realpath, rename, rm, stat, symlink, truncate, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { appendFileSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { CLAUDE_HISTORY_LIMITS, ClaudeCodeHistoryError, inspectClaudeCodeHistory } from "../src/native-history.js";
import { nativeHistoryProvider } from "./fixtures/native-history-provider.js";

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "minu-claude-history-")));
  const cwd = join(root, "workspace"), config = join(root, "config");
  await mkdir(cwd, { mode: 0o700 });
  await mkdir(config, { mode: 0o700 });
  const project = join(config, "projects", cwd.replace(/[^a-zA-Z0-9]/g, "-"));
  await mkdir(project, { recursive: true, mode: 0o700 });
  const id = randomUUID();
  const path = join(project, `${id}.jsonl`);
  const options = { nativeSessionId: id, canonicalCwd: cwd, nativeConfigRoot: config };
  const row = (type = "user", content: unknown = "hello", parentUuid: string | null = null): Record<string, any> => ({
    parentUuid, isSidechain: false, type, message: { role: type, content }, uuid: randomUUID(),
    timestamp: "2026-11-09T20:00:00.000Z", cwd, sessionId: id, version: "2.1.321",
  });
  const save = async (rows = [row()]) => writeFile(path, rows.map((r) => JSON.stringify(r)).join("\n") + "\n", { mode: 0o600 });
  return { root, cwd, config, project, path, id, options, row, save,
    cleanup: () => rm(root, { recursive: true, force: true }) };
}
function rejected(code: ClaudeCodeHistoryError["code"]) {
  return (error: unknown) => {
    assert.ok(error instanceof ClaudeCodeHistoryError);
    assert.equal(error.code, code);
    assert.equal(error.message, `Claude Code native history rejected (${code})`);
    return true;
  };
}

test("exact history is normalized, bounded evidence is returned and bytes are never modified", async () => {
  const f = await fixture();
  try {
    const user = f.row(); const assistant = f.row("assistant", [{ type: "text", text: "answer" }], user.uuid);
    await f.save([user, assistant]);
    const before = await readFile(f.path);
    const result = await inspectClaudeCodeHistory(f.options);
    assert.equal(result.state, "present");
    if (result.state !== "present") return;
    assert.deepEqual(result.messages.map(({ role, content }) => ({ role, content })), [
      { role: "user", content: "hello" }, { role: "assistant", content: "answer" },
    ]);
    assert.equal(result.evidence.records, 2);
    assert.equal(result.evidence.bytes, before.length);
    assert.match(result.evidence.sha256, /^[a-f0-9]{64}$/);
    assert.deepEqual(await readFile(f.path), before);
    assert.deepEqual(Object.keys(result).sort(), ["evidence", "messages", "state"]);
  } finally { await f.cleanup(); }
});

// Derived from the exact three-field non-chain record captured by D5c from
// bundled 2.1.321 after real Read execution; no provider/native work in these tests.
test("pinned tools-used metadata preserves Read history without changing the chain or bytes", async () => {
  const f = await fixture();
  try {
    const user = f.row("user", "read fixture");
    const use = f.row("assistant", [{ type: "tool_use", id: "read-1", name: "Read", input: { file_path: "PRIVATE_INPUT" } }], user.uuid);
    const tool = f.row("user", [{ type: "tool_result", tool_use_id: "read-1", content: "FAMILY_NEEDLE alpha fixture" }], use.uuid);
    const answer = f.row("assistant", [{ type: "text", text: "family-Read-ok" }], tool.uuid);
    const metadata = { type: "tools-used", tools: ["Read"], sessionId: f.id };
    // Bookkeeping neither becomes a message nor changes the next parent/leaf.
    for (const position of [0, 2, 4]) {
      const rows = [user, use, tool, answer]; rows.splice(position, 0, metadata);
      await f.save([...rows, { type: "last-prompt", sessionId: f.id, leafUuid: answer.uuid }]);
      const before = await readFile(f.path);
      const result = await inspectClaudeCodeHistory(f.options);
      assert.equal(result.state, "present");
      if (result.state !== "present") return;
      assert.deepEqual(result.messages.map(m => [m.role, m.content, m.toolName]), [
        ["user", "read fixture", undefined], ["tool", "FAMILY_NEEDLE alpha fixture", "Read"], ["assistant", "family-Read-ok", undefined],
      ]);
      assert.deepEqual(result.evidence, { records: 6, bytes: before.length, sha256: createHash("sha256").update(before).digest("hex") });
      assert.doesNotMatch(JSON.stringify(result), /PRIVATE_INPUT|tools-used|sessionId|completed|settled|resumable/);
      assert.deepEqual(await readFile(f.path), before);
    }
  } finally { await f.cleanup(); }
});

test("tools-used bookkeeping alone cannot create history or settle a user-only input", async () => {
  const f = await fixture();
  try {
    // Names are bounded opaque bookkeeping, not permissions or executable tools.
    for (const tools of [[], ["Read"], ["é".repeat(64), "PRIVATE_METADATA_NAME"]]) {
      const metadata = { type: "tools-used", tools, sessionId: f.id };
      await f.save([metadata]);
      await assert.rejects(inspectClaudeCodeHistory(f.options), rejected("invalid_history"));
      await f.save([f.row(), metadata]);
      const result = await inspectClaudeCodeHistory(f.options);
      assert.equal(result.state, "present");
      if (result.state === "present") assert.deepEqual(result.messages.map(m => [m.role, m.content]), [["user", "hello"]]);
      assert.doesNotMatch(JSON.stringify(result), /PRIVATE_METADATA_NAME|completed|settled|response|resumable/);
    }
  } finally { await f.cleanup(); }
});

const invalidToolsUsed: [string, Record<string, unknown>, ClaudeCodeHistoryError["code"]][] = [
  ["missing tools", { tools: undefined }, "invalid_history"],
  ["null tools", { tools: null }, "invalid_history"],
  ["string tools", { tools: "Read" }, "invalid_history"],
  ["object tools", { tools: {} }, "invalid_history"],
  ["null name", { tools: [null] }, "invalid_history"],
  ["number name", { tools: [42] }, "invalid_history"],
  ["object name", { tools: [{}] }, "invalid_history"],
  ["empty name", { tools: [""] }, "invalid_history"],
  ["oversize name", { tools: ["é".repeat(65)] }, "invalid_history"],
  ["missing session", { sessionId: undefined }, "invalid_history"],
  ["wrong session", { sessionId: randomUUID() }, "invalid_history"],
  ["wrong cwd", { cwd: "/not-the-authorized-workspace" }, "invalid_history"],
  ["uuid", { uuid: randomUUID() }, "unsupported_format"],
  ["parentUuid", { parentUuid: null }, "unsupported_format"],
  ["sidechain", { isSidechain: true }, "unsupported_format"],
  ["compaction", { isCompactSummary: true }, "unsupported_format"],
  ["new shape", { futureField: "PRIVATE_METADATA" }, "unsupported_format"],
  ["version field", { version: "2.1.321" }, "unsupported_format"],
  ["different version", { version: "2.2.0" }, "unsupported_format"],
];
for (const [name, patch, code] of invalidToolsUsed) test(`tools-used refuses ${name}`, async () => {
  const f = await fixture();
  try {
    await f.save([f.row(), { type: "tools-used", tools: ["Read"], sessionId: f.id, ...patch }]);
    const before = await readFile(f.path);
    await assert.rejects(inspectClaudeCodeHistory(f.options), rejected(code));
    assert.deepEqual(await readFile(f.path), before);
  } finally { await f.cleanup(); }
});

test("a final last-prompt may name an ancestor when everything after it is the completed dispatch's own response (real-engine ordering)", async () => {
  const f = await fixture();
  try {
    // Observed from the real engine: `last-prompt` and `atis-latch` land BEFORE the final assistant row and are not rewritten at exit.
    const user = f.row(), call = f.row("assistant", [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "echo" } }], user.uuid);
    call.message.stop_reason = "tool_use";
    const result = f.row("user", [{ type: "tool_result", tool_use_id: "t1", content: "ok" }], call.uuid);
    const answer = f.row("assistant", [{ type: "text", text: "tools finished" }], result.uuid); answer.message.stop_reason = "end_turn";
    const completedInput = { nativeMessageId: user.uuid, fingerprint: createHash("sha256").update("hello").digest("hex") };
    const last = (leafUuid: string) => ({ type: "last-prompt", sessionId: f.id, leafUuid });
    const latch = { type: "atis-latch", sessionId: f.id };
    // The real engine names its FINAL assistant row before writing it, so any later row of the chain is a valid leaf here too.
    for (const leaf of [user.uuid, call.uuid, result.uuid, answer.uuid]) {
      await f.save([user, call, last(leaf), latch, result, answer]);
      assert.equal((await inspectClaudeCodeHistory({ ...f.options, completedInput })).state, "present", `leaf ${leaf}`);
    }
    for (const leaf of [user.uuid, call.uuid, result.uuid, answer.uuid]) {
      await f.save([user, call, result, answer, last(leaf)]);
      assert.equal((await inspectClaudeCodeHistory({ ...f.options, completedInput })).state, "present", `final leaf ${leaf}`);
    }
    // Still refused: a trailing hidden/visible user row, a leaf from an EARLIER turn, an unknown leaf, no last-prompt at all.
    const earlier = f.row("user", "earlier turn"), earlierAnswer = f.row("assistant", [{ type: "text", text: "earlier" }], earlier.uuid); earlierAnswer.message.stop_reason = "end_turn";
    const second = { ...f.row("user", "hello", earlierAnswer.uuid) }, secondAnswer = f.row("assistant", [{ type: "text", text: "done" }], second.uuid); secondAnswer.message.stop_reason = "end_turn";
    const secondInput = { nativeMessageId: second.uuid, fingerprint: completedInput.fingerprint };
    const cases: [string, Record<string, any>[], typeof completedInput][] = [
      ["trailing user row", [user, call, last(call.uuid), result, answer, f.row("user", "later input", answer.uuid)], completedInput],
      ["trailing hidden row", [user, call, last(call.uuid), result, answer, { ...f.row("user", "hidden", answer.uuid), isMeta: true }], completedInput],
      ["leaf from an earlier turn", [earlier, earlierAnswer, second, secondAnswer, last(earlier.uuid)], secondInput],
      ["unknown leaf", [user, call, last(randomUUID()), result, answer], completedInput],
      ["no last-prompt", [user, call, result, answer], completedInput],
    ];
    for (const [name, rows, input] of cases) {
      await f.save(rows);
      await assert.rejects(inspectClaudeCodeHistory({ ...f.options, completedInput: input }), rejected("invalid_history"), name);
    }
  } finally { await f.cleanup(); }
});

test("completed-input eligibility requires the committed mapped text, terminal end_turn, final leaf and drained native queue", async () => {
  const f = await fixture();
  try {
    const user = f.row(), answer = f.row("assistant", [{ type: "text", text: "answer" }], user.uuid);
    answer.message.stop_reason = "end_turn";
    const enqueue = { type: "queue-operation", operation: "enqueue", content: "hello", timestamp: user.timestamp, sessionId: f.id };
    const dequeue = { type: "queue-operation", operation: "dequeue", timestamp: user.timestamp, sessionId: f.id };
    const leaf = { type: "last-prompt", sessionId: f.id, leafUuid: answer.uuid };
    const options = { ...f.options, completedInput: { nativeMessageId: user.uuid, fingerprint: createHash("sha256").update("hello").digest("hex") } };
    const valid = [enqueue, dequeue, user, answer, leaf]; await f.save(valid);
    const result = await inspectClaudeCodeHistory(options); assert.equal(result.state, "present");
    assert.doesNotMatch(JSON.stringify(result), /settled|completed|resumable|fingerprint/);
    const invalid = [
      [enqueue, dequeue, user],
      [enqueue, dequeue, user, { ...answer, message: { ...answer.message, stop_reason: "tool_use" } }, leaf],
      [enqueue, dequeue, user, answer],
      [...valid, f.row("user", "later input", answer.uuid)],
      [...valid, enqueue],
      [...valid, enqueue, dequeue],
      [dequeue, user, answer, leaf],
      [{ ...enqueue, content: "wrong queued text" }, dequeue, user, answer, leaf],
      [enqueue, { ...dequeue, operation: "unknown" }, user, answer, leaf],
      [enqueue, dequeue, user, { ...answer, isMeta: true }, leaf],
      [enqueue, dequeue, user, { ...answer, message: { ...answer.message, content: [{ type: "tool_use", id: "unfinished", name: "Read", input: {} }] } }, leaf],
    ];
    for (const rows of invalid) {
      await f.save(rows); const before = await readFile(f.path);
      await assert.rejects(inspectClaudeCodeHistory(options), error => error instanceof ClaudeCodeHistoryError);
      assert.deepEqual(await readFile(f.path), before);
    }
    const snapshot: Record<string, any> = { ...f.row("attachment", "", answer.uuid), attachment: { type: "prompt_snapshot", systemPrompt: ["PRIVATE_SNAPSHOT"] } };
    await f.save([enqueue, dequeue, user, answer, snapshot, { ...leaf, leafUuid: snapshot.uuid }]);
    assert.equal((await inspectClaudeCodeHistory(options)).state, "present");
    await f.save([...valid, f.row("assistant", "another completion", answer.uuid)]);
    await assert.rejects(inspectClaudeCodeHistory(options), error => error instanceof ClaudeCodeHistoryError);
    const thinking = f.row("assistant", [{ type: "thinking", thinking: "PRIVATE_REASONING" }], user.uuid);
    thinking.message.id = "same-response"; thinking.message.stop_reason = "end_turn";
    const text = { ...answer, parentUuid: thinking.uuid, message: { ...answer.message, id: "same-response" } };
    await f.save([enqueue, dequeue, user, thinking, text, leaf]);
    assert.equal((await inspectClaudeCodeHistory(options)).state, "present");
    await f.save([enqueue, dequeue, user, thinking, { ...text, message: { ...text.message, id: "different-response" } }, leaf]);
    await assert.rejects(inspectClaudeCodeHistory(options), rejected("invalid_history"));
    await f.save(valid);
    for (const completedInput of [{ ...options.completedInput, nativeMessageId: randomUUID() }, { ...options.completedInput, fingerprint: "0".repeat(64) }]) {
      await assert.rejects(inspectClaudeCodeHistory({ ...options, completedInput }), rejected("invalid_history"));
    }
  } finally { await f.cleanup(); }
});

for (const visibility of ["isMeta", "isVisibleInTranscriptOnly", "synthetic"]) {
  for (const role of ["user", "assistant"]) {
    test(`completed-input rejects hidden ${role} structure (${visibility}) independently of public redaction`, async () => {
      const f = await fixture();
      try {
        const user = f.row(), answer = f.row("assistant", "answer", user.uuid);
        answer.message.id = "committed-response"; answer.message.stop_reason = "end_turn";
        const options = { ...f.options, completedInput: { nativeMessageId: user.uuid, fingerprint: createHash("sha256").update("hello").digest("hex") } };
        for (const position of ["after", "before"]) for (const snapshotTail of [true, false]) for (const array of [false, true]) {
          for (const responseId of role === "assistant" ? ["unrelated-response", "committed-response"] : [undefined]) {
            const hidden = f.row(role, array ? [{ type: "text", text: "PRIVATE_UNCOMPLETED_TAIL" }] : "PRIVATE_UNCOMPLETED_TAIL",
              position === "after" ? answer.uuid : user.uuid);
            if (visibility === "synthetic") hidden.message.model = "<synthetic>"; else hidden[visibility] = true;
            if (role === "assistant") { hidden.message.id = responseId; hidden.message.stop_reason = "end_turn"; }
            const rows = position === "after" ? [user, answer, hidden] : [user, hidden, { ...answer, parentUuid: hidden.uuid }];
            let leaf = rows.at(-1)!.uuid;
            if (snapshotTail) {
              const snapshot: Record<string, any> = { ...f.row("attachment", "", leaf), attachment: { type: "prompt_snapshot" } };
              delete snapshot.message; rows.push(snapshot); leaf = snapshot.uuid;
            }
            rows.push({ type: "last-prompt", sessionId: f.id, leafUuid: leaf });
            await f.save(rows); const before = await readFile(f.path);
            const publicHistory = await inspectClaudeCodeHistory(f.options);
            assert.equal(publicHistory.state, "present");
            if (publicHistory.state === "present") assert.deepEqual(publicHistory.messages.map(m => [m.role, m.content]), [["user", "hello"], ["assistant", "answer"]]);
            assert.doesNotMatch(JSON.stringify(publicHistory), /PRIVATE_UNCOMPLETED_TAIL/);
            await assert.rejects(inspectClaudeCodeHistory(options), rejected("invalid_history"),
              `${position}/snapshot=${snapshotTail}/array=${array}/response=${responseId}`);
            assert.deepEqual(await readFile(f.path), before);
          }
        }
      } finally { await f.cleanup(); }
    });
  }
}

test("completed-input preserves hidden pre-target bookkeeping and structurally paired hidden tool results", async () => {
  const f = await fixture();
  try {
    for (const visibility of ["isMeta", "isVisibleInTranscriptOnly", "synthetic"]) {
      const prefix = f.row("user", "PRIVATE_PRE_TARGET");
      const filler = f.row("assistant", "PRIVATE_FILLER", prefix.uuid);
      if (visibility === "synthetic") { prefix.message.model = "<synthetic>"; filler.message.model = "<synthetic>"; }
      else { prefix[visibility] = true; filler[visibility] = true; }
      filler.message.stop_reason = "end_turn";
      const user = f.row("user", "hello", filler.uuid);
      const use = f.row("assistant", [{ type: "tool_use", id: "read", name: "Read", input: {} }], user.uuid);
      const result = f.row("user", [{ type: "tool_result", tool_use_id: "read", content: "PRIVATE_TOOL_RESULT" }], use.uuid);
      if (visibility === "synthetic") result.message.model = "<synthetic>"; else result[visibility] = true;
      const answer = f.row("assistant", "answer", result.uuid); answer.message.stop_reason = "end_turn";
      const enqueue = { type: "queue-operation", operation: "enqueue", content: "hello", timestamp: user.timestamp, sessionId: f.id };
      const dequeue = { type: "queue-operation", operation: "dequeue", timestamp: user.timestamp, sessionId: f.id };
      await f.save([enqueue, dequeue, prefix, filler, user, use, result, answer, { type: "last-prompt", sessionId: f.id, leafUuid: answer.uuid }]);
      const history = await inspectClaudeCodeHistory({ ...f.options, completedInput: {
        nativeMessageId: user.uuid, fingerprint: createHash("sha256").update("hello").digest("hex"),
      } });
      assert.equal(history.state, "present");
      if (history.state === "present") assert.deepEqual(history.messages.map(m => [m.role, m.content]), [["user", "hello"], ["assistant", "answer"]]);
      assert.doesNotMatch(JSON.stringify(history), /PRIVATE_/);
    }
  } finally { await f.cleanup(); }
});

test("completed-input snapshots extend only the direct completed tail and do not reopen its response", async () => {
  const f = await fixture();
  try {
    const user = f.row(), thinking = f.row("assistant", [{ type: "thinking", thinking: "PRIVATE_THINKING" }], user.uuid);
    thinking.message.id = "same-response"; thinking.message.stop_reason = "end_turn";
    const answer = f.row("assistant", "answer", thinking.uuid);
    answer.message.id = "same-response"; answer.message.stop_reason = "end_turn";
    const snapshot: Record<string, any> = { ...f.row("attachment", "", answer.uuid), attachment: { type: "prompt_snapshot" } };
    delete snapshot.message;
    const second = { ...snapshot, uuid: randomUUID(), parentUuid: snapshot.uuid };
    const options = { ...f.options, completedInput: { nativeMessageId: user.uuid, fingerprint: createHash("sha256").update("hello").digest("hex") } };
    await f.save([user, thinking, answer, snapshot, second, { type: "last-prompt", sessionId: f.id, leafUuid: second.uuid }]);
    assert.equal((await inspectClaudeCodeHistory(options)).state, "present");
    const reopened = { ...answer, uuid: randomUUID(), parentUuid: snapshot.uuid };
    await f.save([user, thinking, answer, snapshot, reopened, { type: "last-prompt", sessionId: f.id, leafUuid: reopened.uuid }]);
    await assert.rejects(inspectClaudeCodeHistory(options), rejected("invalid_history"));
    const emptyInput = f.row("user", [], user.uuid);
    await f.save([user, emptyInput, { ...answer, parentUuid: emptyInput.uuid }, { type: "last-prompt", sessionId: f.id, leafUuid: answer.uuid }]);
    await assert.rejects(inspectClaudeCodeHistory(options), rejected("invalid_history"));
  } finally { await f.cleanup(); }
});

test("absent file/project/config returns missing without creating anything or scanning other roots", async () => {
  const f = await fixture();
  try {
    assert.deepEqual(await inspectClaudeCodeHistory(f.options), { state: "missing" });
    await assert.rejects(stat(f.path), { code: "ENOENT" });
    await rm(f.project, { recursive: true });
    assert.deepEqual(await inspectClaudeCodeHistory(f.options), { state: "missing" });
    await rm(f.config, { recursive: true });
    assert.deepEqual(await inspectClaudeCodeHistory(f.options), { state: "missing" });
    await assert.rejects(stat(f.config), { code: "ENOENT" });
  } finally { await f.cleanup(); }
});

for (const patch of [
  { nativeSessionId: "../escape" }, { nativeSessionId: "ABCDEF12-1111-1111-1111-111111111111" },
  { nativeConfigRoot: "relative" }, { canonicalCwd: "relative" }, { nativeConfigRoot: "/a/../b" },
  { canonicalCwd: "/missing-workspace" }, { nativeConfigRoot: "/root\0" },
]) test(`invalid identity/path refused: ${JSON.stringify(patch)}`, async () => {
  const f = await fixture();
  try {
    await assert.rejects(inspectClaudeCodeHistory({ ...f.options, ...patch }), (error: unknown) => error instanceof ClaudeCodeHistoryError);
  } finally { await f.cleanup(); }
});

test("wrong workspace never falls back, even for a project-key collision", async () => {
  const f = await fixture();
  try {
    await f.save();
    const other = join(f.root, "other-workspace"); await mkdir(other, { mode: 0o700 });
    assert.deepEqual(await inspectClaudeCodeHistory({ ...f.options, canonicalCwd: other }), { state: "missing" });
    const dash = join(f.root, "a-b"), underscore = join(f.root, "a_b");
    await mkdir(dash); await mkdir(underscore);
    const project = join(f.config, "projects", dash.replace(/[^a-zA-Z0-9]/g, "-"));
    await mkdir(project, { mode: 0o700 });
    await writeFile(join(project, `${f.id}.jsonl`), JSON.stringify({ ...f.row(), cwd: dash }) + "\n", { mode: 0o600 });
    await assert.rejects(inspectClaudeCodeHistory({ ...f.options, canonicalCwd: underscore }), rejected("invalid_history"));
  } finally { await f.cleanup(); }
});

for (const which of ["file", "project", "projects", "config", "workspace", "ancestor"]) {
  test(`symlinked ${which} is refused`, async () => {
    const f = await fixture();
    try {
      await f.save();
      const path = which === "file" ? f.path : which === "project" ? f.project : which === "projects" ? join(f.config, "projects")
        : which === "workspace" ? f.cwd : which === "ancestor" ? f.root : f.config;
      const moved = `${path}-real`;
      await rename(path, moved); await symlink(moved, path);
      try { await assert.rejects(inspectClaudeCodeHistory(f.options), (error: unknown) => error instanceof ClaudeCodeHistoryError); }
      finally { await rm(path); await rename(moved, path); }
    } finally { await f.cleanup(); }
  });
}
for (const which of ["file", "project", "projects", "config"]) {
  test(`nonprivate ${which} is refused`, async () => {
    const f = await fixture();
    try {
      await f.save();
      const path = which === "file" ? f.path : which === "project" ? f.project : which === "projects" ? join(f.config, "projects") : f.config;
      await chmod(path, which === "file" ? 0o640 : 0o750);
      await assert.rejects(inspectClaudeCodeHistory(f.options), rejected("unsafe_file"));
    } finally { await f.cleanup(); }
  });
}

for (const which of ["file", "project", "projects", "config"]) {
  test(`native roots accept a world-readable ${which} but still refuse group/other writable ones`, async () => {
    const f = await fixture();
    try {
      await f.save();
      const path = which === "file" ? f.path : which === "project" ? f.project : which === "projects" ? join(f.config, "projects") : f.config;
      const native = { ...f.options, nativeRoot: true };
      await chmod(path, which === "file" ? 0o644 : 0o755);
      assert.equal((await inspectClaudeCodeHistory(native)).state, "present");
      await assert.rejects(inspectClaudeCodeHistory(f.options), rejected("unsafe_file"), "private mode still refuses it");
      await chmod(path, which === "file" ? 0o664 : 0o775);
      await assert.rejects(inspectClaudeCodeHistory(native), rejected("unsafe_file"));
    } finally { await f.cleanup(); }
  });
}

test("hardlinks and nonregular transcript paths are refused", async () => {
  const f = await fixture();
  try {
    await f.save(); await link(f.path, join(f.root, "linked"));
    await assert.rejects(inspectClaudeCodeHistory(f.options), rejected("unsafe_file"));
    await rm(f.path); await mkdir(f.path);
    await assert.rejects(inspectClaudeCodeHistory(f.options), rejected("unsafe_file"));
    await rm(f.path, { recursive: true });
    const fifo = spawnSync("mkfifo", [f.path]); assert.equal(fifo.status, 0);
    await assert.rejects(inspectClaudeCodeHistory(f.options), rejected("unsafe_file"));
  } finally { await f.cleanup(); }
});

const mutations: [string, (f: Awaited<ReturnType<typeof fixture>>) => Record<string, any>[], ClaudeCodeHistoryError["code"]][] = [
  ["wrong session", f => [{ ...f.row(), sessionId: randomUUID() }], "invalid_history"],
  ["missing session", f => [{ ...f.row(), sessionId: undefined }], "invalid_history"],
  ["wrong cwd", f => [{ ...f.row(), cwd: f.root }], "invalid_history"],
  ["missing cwd", f => [{ ...f.row(), cwd: undefined }], "invalid_history"],
  ["wrong parent", f => [f.row("user", "hello", randomUUID())], "invalid_history"],
  ["cycle", f => { const row = f.row(); row.parentUuid = row.uuid; return [row]; }, "invalid_history"],
  ["duplicate", f => { const row = f.row(); return [row, row]; }, "invalid_history"],
  ["branch", f => { const row = f.row(); return [row, f.row("assistant", "one", row.uuid), f.row("assistant", "two", row.uuid)]; }, "invalid_history"],
  ["sidechain", f => [{ ...f.row(), isSidechain: true }], "invalid_history"],
  ["team", f => [{ ...f.row(), teamName: "other" }], "invalid_history"],
  ["bad timestamp", f => [{ ...f.row(), timestamp: "nonsense" }], "invalid_history"],
  ["bad role", f => [{ ...f.row(), message: { role: "assistant", content: "no" } }], "invalid_history"],
  ["bad content", f => [f.row("user", [{ type: "text", text: 42 }])], "invalid_history"],
  ["bad image", f => [f.row("user", [{ type: "image", source: {} }])], "invalid_history"],
  ["unknown content", f => [f.row("user", [{ type: "future-block" }])], "unsupported_format"],
  ["bad reasoning", f => [f.row("assistant", [{ type: "thinking", thinking: 42 }])], "invalid_history"],
  ["orphan tool result", f => [f.row("user", [{ type: "tool_result", tool_use_id: "absent", content: "no" }])], "invalid_history"],
  ["bad tool input", f => [f.row("assistant", [{ type: "tool_use", id: "tool", name: "Read", input: "no" }])], "invalid_history"],
  ["unsupported version (major)", f => [{ ...f.row(), version: "3.0.0" }], "unsupported_format"],
  ["unsupported version (below range)", f => [{ ...f.row(), version: "2.1.299" }], "unsupported_format"],
  ["malformed version", f => [{ ...f.row(), version: "latest" }], "unsupported_format"],
  ["compaction", f => [f.row(), { type: "system", subtype: "compact_boundary", sessionId: f.id }], "unsupported_format"],
  ["unknown record with a uuid", f => [f.row(), { type: "future-record", sessionId: f.id, uuid: randomUUID() }], "unsupported_format"],
  ["unknown record with a parentUuid", f => [f.row(), { type: "future-record", sessionId: f.id, parentUuid: null }], "unsupported_format"],
  ["unknown record with a message", f => [f.row(), { type: "future-record", sessionId: f.id, message: { role: "user", content: "hidden input" } }], "unsupported_format"],
  ["unknown record with a role", f => [f.row(), { type: "future-record", sessionId: f.id, role: "user" }], "unsupported_format"],
  ["unknown record with content", f => [f.row(), { type: "future-record", sessionId: f.id, content: "hidden input" }], "unsupported_format"],
  ["unknown record for another session", f => [f.row(), { type: "future-record", sessionId: randomUUID() }], "invalid_history"],
  ["unknown record for another workspace", f => [f.row(), { type: "future-record", sessionId: f.id, cwd: "/not-the-authorized-workspace" }], "invalid_history"],
  ["unknown record with an unsupported version", f => [f.row(), { type: "future-record", sessionId: f.id, version: "3.0.0" }], "unsupported_format"],
  ["wrong last-prompt leaf", f => [f.row(), { type: "last-prompt", sessionId: f.id, leafUuid: randomUUID() }], "invalid_history"],
  ["compact summary", f => [{ ...f.row(), isCompactSummary: true }], "unsupported_format"],
  ["queued delivery", f => { const row = f.row(); return [row, { ...f.row("attachment", "", row.uuid), attachment: { type: "queued_command", prompt: "hidden input" } }]; }, "unsupported_format"],
  ["wrong environment", f => { const row = f.row(); return [row, { ...f.row("attachment", "", row.uuid), attachment: { type: "environment", snapshot: { workingDirectory: f.root } } }]; }, "invalid_history"],
];
for (const [name, rows, code] of mutations) test(`rejects ${name}`, async () => {
  const f = await fixture();
  try { await f.save(rows(f)); await assert.rejects(inspectClaudeCodeHistory(f.options), rejected(code)); }
  finally { await f.cleanup(); }
});

for (const content of ["", "{}\n", "not json\n", "null\n", "[]\n", "{\"type\":", "\n", Buffer.from([0xff, 10])]) {
  test(`corrupt JSONL is refused: ${JSON.stringify(content)}`, async () => {
    const f = await fixture();
    try { await writeFile(f.path, content, { mode: 0o600 }); await assert.rejects(inspectClaudeCodeHistory(f.options), rejected("invalid_history")); }
    finally { await f.cleanup(); }
  });
}

test("truncated final records and metadata-only evidence cannot certify present history", async () => {
  const f = await fixture();
  try {
    await writeFile(f.path, JSON.stringify(f.row()), { mode: 0o600 });
    await assert.rejects(inspectClaudeCodeHistory(f.options), rejected("invalid_history"));
    await f.save([{ type: "queue-operation", operation: "enqueue", sessionId: f.id }]);
    await assert.rejects(inspectClaudeCodeHistory(f.options), rejected("invalid_history"));
  } finally { await f.cleanup(); }
});

test("rows observed from the installed engine on a real subscription login (2.1.311) are accepted, unknown ones still fail closed", async () => {
  const f = await fixture();
  try {
    const user = f.row(), kinds = ["credential_org", "mcp_instructions_delta", "deferred_tools_record"];
    let parent = user; const attachments = kinds.map(type => { const row = { ...f.row("attachment", "", parent.uuid), attachment: { type } }; parent = row; return row; });
    const answer = f.row("assistant", [{ type: "text", text: "alpha" }], parent.uuid); answer.message.stop_reason = "end_turn";
    const title = { type: "ai-title", sessionId: f.id, aiTitle: "A title" };
    const options = { ...f.options, completedInput: { nativeMessageId: user.uuid, fingerprint: createHash("sha256").update("hello").digest("hex") } };
    await f.save([user, ...attachments, title, answer, { type: "last-prompt", sessionId: f.id, leafUuid: answer.uuid }]);
    assert.equal((await inspectClaudeCodeHistory(options)).state, "present");
  } finally { await f.cleanup(); }
});

test("invented future non-chain rows and attachment types are tolerated before the terminal row only", async () => {
  const f = await fixture();
  try {
    const user = f.row();
    const future: Record<string, any> = { ...f.row("attachment", "", user.uuid), attachment: { type: "future_unknown_attachment", anything: [1, 2] } };
    const answer = f.row("assistant", [{ type: "text", text: "alpha" }], future.uuid); answer.message.stop_reason = "end_turn";
    const options = { ...f.options, completedInput: { nativeMessageId: user.uuid, fingerprint: createHash("sha256").update("hello").digest("hex") } };
    const bookkeeping = { type: "future-bookkeeping", sessionId: f.id, cwd: f.cwd, version: "2.1.321", counters: { a: 1 } };
    const leaf = { type: "last-prompt", sessionId: f.id, leafUuid: answer.uuid };
    // Structure-only read, and the completed-input read, both accept them.
    await f.save([user, bookkeeping, future, bookkeeping, answer, leaf]);
    const plain = await inspectClaudeCodeHistory(f.options);
    assert.equal(plain.state, "present");
    if (plain.state === "present") assert.deepEqual(plain.messages.map(m => m.content), ["hello", "alpha"]);
    assert.equal((await inspectClaudeCodeHistory(options)).state, "present");
    // An unknown attachment AFTER the terminal row is refused (only prompt_snapshot may follow), and so is a non-attachment chain row.
    const after: Record<string, any> = { ...f.row("attachment", "", answer.uuid), attachment: { type: "future_unknown_attachment" } };
    await f.save([user, future, answer, after, { ...leaf, leafUuid: after.uuid }]);
    await assert.rejects(inspectClaudeCodeHistory(options), rejected("unsupported_format"));
    const snapshot: Record<string, any> = { ...f.row("attachment", "", answer.uuid), attachment: { type: "prompt_snapshot" } };
    await f.save([user, future, answer, snapshot, { ...leaf, leafUuid: snapshot.uuid }]);
    assert.equal((await inspectClaudeCodeHistory(options)).state, "present");
    // Unknown attachment shapes without a string type, and unknown chain row types, remain refused.
    await f.save([user, { ...f.row("attachment", "", user.uuid), attachment: {} }]);
    await assert.rejects(inspectClaudeCodeHistory(f.options), rejected("unsupported_format"));
    await f.save([user, { ...f.row("future-chain", "x", user.uuid) }]);
    await assert.rejects(inspectClaudeCodeHistory(f.options), rejected("unsupported_format"));
  } finally { await f.cleanup(); }
});

test("the supported version range (>=2.1.300 <3) accepts newer minor/patch engines", async () => {
  const f = await fixture();
  try {
    for (const version of ["2.1.300", "2.1.321", "2.1.999", "2.2.0", "2.9.4"]) {
      await f.save([{ ...f.row(), version }]);
      assert.equal((await inspectClaudeCodeHistory(f.options)).state, "present", version);
    }
  } finally { await f.cleanup(); }
});

test("normalization excludes private metadata, hidden prompts, image bytes, reasoning and synthetic fillers", async () => {
  const f = await fixture();
  try {
    const user = f.row("user", [{ type: "text", text: "visible" }, { type: "image", source: { type: "base64", media_type: "image/png", data: "PRIVATE_PIXELS" } }]);
    const answer = f.row("assistant", [{ type: "thinking", thinking: "PRIVATE_REASONING", signature: "PRIVATE_SIGNATURE" },
      { type: "text", text: "answer" }, { type: "tool_use", id: "tool-1", name: "Read", input: { path: "PRIVATE_TOOL_INPUT" } }], user.uuid);
    const tool = f.row("user", [{ type: "tool_result", tool_use_id: "tool-1", content: [{ type: "text", text: "tool text" }, { type: "image", source: { type: "base64", media_type: "image/png", data: "PRIVATE_TOOL_PIXELS" } }] }], answer.uuid);
    const hidden: Record<string, any> = { ...f.row("user", "PRIVATE_PROMPT", tool.uuid), isMeta: true };
    const filler = f.row("assistant", [{ type: "text", text: "No response requested." }], hidden.uuid); filler.message.model = "<synthetic>";
    await f.save([user, answer, tool, hidden, filler]);
    const result = await inspectClaudeCodeHistory(f.options);
    assert.equal(result.state, "present");
    if (result.state !== "present") return;
    assert.deepEqual(result.messages.map(m => [m.role, m.content]), [["user", "visible\n[image]"], ["assistant", "answer"], ["tool", "tool text\n[image]"]]);
    assert.equal(result.messages[2].toolName, "Read");
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE_|No response requested|sessionId|cwd/);
  } finally { await f.cleanup(); }
});

for (const flag of ["isMeta", "isVisibleInTranscriptOnly"]) {
  for (const value of [undefined, false, true]) {
    test(`visibility flag ${flag}=${String(value)} preserves native visibility`, async () => {
      const f = await fixture();
      try {
        const user = { ...f.row("user", "user text"), [flag]: value };
        const assistant = { ...f.row("assistant", [{ type: "text", text: "assistant text" }], user.uuid), [flag]: value };
        await f.save([user, assistant]);
        const result = await inspectClaudeCodeHistory(f.options);
        assert.equal(result.state, "present");
        if (result.state === "present") {
          assert.deepEqual(result.messages.map(m => m.content), value === true ? [] : ["user text", "assistant text"]);
        }
      } finally { await f.cleanup(); }
    });
  }
  for (const value of ["true", "false", "", 0, 1, null, {}, []]) {
    test(`malformed visibility flag ${flag}=${JSON.stringify(value)} is refused`, async () => {
      const f = await fixture();
      try {
        for (const role of ["user", "assistant"]) {
          const user = f.row();
          const malformed = { ...f.row(role, [{ type: "text", text: "PRIVATE_FLAG_TEXT" }], role === "user" ? null : user.uuid), [flag]: value };
          await f.save(role === "user" ? [malformed] : [user, malformed]);
          await assert.rejects(inspectClaudeCodeHistory(f.options), rejected("invalid_history"));
        }
      } finally { await f.cleanup(); }
    });
  }
}

test("user-only uncertain input is evidence, never a fabricated terminal result", async () => {
  const f = await fixture();
  try {
    await f.save();
    const result = await inspectClaudeCodeHistory(f.options);
    assert.equal(result.state, "present");
    if (result.state === "present") assert.deepEqual(result.messages.map(m => m.role), ["user"]);
    assert.doesNotMatch(JSON.stringify(result), /completed|settled|response|resumable/);
  } finally { await f.cleanup(); }
});

test("file, line, record, output message and text limits refuse instead of silently truncating", async () => {
  const f = await fixture();
  try {
    await f.save(); await truncate(f.path, CLAUDE_HISTORY_LIMITS.bytes + 1);
    await assert.rejects(inspectClaudeCodeHistory(f.options), rejected("too_large"));
    await f.save([f.row("user", "x".repeat(CLAUDE_HISTORY_LIMITS.lineBytes))]);
    await assert.rejects(inspectClaudeCodeHistory(f.options), rejected("too_large"));
    const meta = { type: "mode", sessionId: f.id };
    await f.save(Array(CLAUDE_HISTORY_LIMITS.records + 1).fill(meta));
    await assert.rejects(inspectClaudeCodeHistory(f.options), rejected("too_large"));
    const rows: Record<string, any>[] = []; let parent: string | null = null;
    for (let i = 0; i <= CLAUDE_HISTORY_LIMITS.messages; i++) { const row = f.row("user", "x", parent); rows.push(row); parent = row.uuid; }
    await f.save(rows); await assert.rejects(inspectClaudeCodeHistory(f.options), rejected("too_large"));
    const first = f.row("user", "x".repeat(CLAUDE_HISTORY_LIMITS.textBytes / 2));
    await f.save([first, f.row("assistant", "y".repeat(CLAUDE_HISTORY_LIMITS.textBytes / 2 + 1), first.uuid)]);
    await assert.rejects(inspectClaudeCodeHistory(f.options), rejected("too_large"));
  } finally { await f.cleanup(); }
});

test("pre-aborted and in-flight cancellation propagate without changing environment", async () => {
  const f = await fixture();
  try {
    await f.save(); const before = { ...process.env };
    const controller = new AbortController(); const reason = new Error("cancel history"); controller.abort(reason);
    await assert.rejects(inspectClaudeCodeHistory({ ...f.options, signal: controller.signal }), error => error === reason);
    const inflight = new AbortController();
    const reading = inspectClaudeCodeHistory({ ...f.options, signal: inflight.signal });
    setImmediate(() => inflight.abort(reason));
    await assert.rejects(reading, error => error === reason);
    assert.deepEqual({ ...process.env }, before);
  } finally { await f.cleanup(); }
});

for (const mutation of ["append", "replace-file", "replace-project"]) {
  test(`changes during snapshot parsing are refused: ${mutation}`, async () => {
    const f = await fixture();
    try {
      await f.save();
      // The first parse checkpoint follows two read checkpoints (data and EOF)
      // for this <64KiB file. Perform a real filesystem mutation synchronously
      // there, rather than rely on scheduler-sensitive sleeps or mocked IO.
      const signal = new AbortController().signal;
      const original = signal.throwIfAborted.bind(signal);
      let calls = 0;
      signal.throwIfAborted = () => {
        original();
        if (++calls !== 7) return;
        if (mutation === "append") appendFileSync(f.path, JSON.stringify({ type: "mode", sessionId: f.id }) + "\n");
        else if (mutation === "replace-file") {
          renameSync(f.path, `${f.path}.old`);
          writeFileSync(f.path, JSON.stringify(f.row("user", "replacement")) + "\n", { mode: 0o600 });
        } else {
          renameSync(f.project, `${f.project}.old`); mkdirSync(f.project, { mode: 0o700 });
          writeFileSync(f.path, JSON.stringify(f.row("user", "replacement")) + "\n", { mode: 0o600 });
        }
      };
      await assert.rejects(inspectClaudeCodeHistory({ ...f.options, signal }), rejected("changed"));
      assert.ok(calls >= 7, "mutation checkpoint must run");
    } finally { await f.cleanup(); }
  });
}

test("accepts real bundled-engine history before and after exact-ID resume", { timeout: 45_000 }, async () => {
  const f = await fixture(); const provider = await nativeHistoryProvider();
  const env = { PATH: process.env.PATH, HOME: f.root, CLAUDE_CONFIG_DIR: f.config,
    ANTHROPIC_API_KEY: "local-synthetic-only", ANTHROPIC_BASE_URL: provider.url, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1" };
  const opts = { cwd: f.cwd, env, tools: [] as string[], settingSources: [] as [], settings: { disableAllHooks: true },
    strictMcpConfig: true, mcpServers: {}, plugins: [], persistSession: true, verbatimPrompts: true };
  try {
    for (let turn = 0; turn < 2; turn++) {
      const q = query({ prompt: `native history ${turn}`, options: { ...opts, ...(turn ? { resume: f.id } : { sessionId: f.id }) } });
      try { for await (const message of q) if (message.type === "result") assert.equal(message.subtype, "success"); }
      finally { q.close(); }
      const result = await inspectClaudeCodeHistory(f.options);
      assert.equal(result.state, "present");
      if (result.state !== "present") return;
      assert.deepEqual(result.messages.map(m => m.content), turn ? ["native history 0", "history reply 1", "native history 1", "history reply 2"]
        : ["native history 0", "history reply 1"]);
    }
    const longCwd = join(f.root, "a".repeat(100), "b".repeat(100));
    await mkdir(longCwd, { recursive: true, mode: 0o700 });
    const longId = randomUUID();
    const longQuery = query({ prompt: "long workspace history", options: { ...opts, cwd: longCwd, sessionId: longId } });
    try { for await (const message of longQuery) if (message.type === "result") assert.equal(message.subtype, "success"); }
    finally { longQuery.close(); }
    const longResult = await inspectClaudeCodeHistory({ ...f.options, canonicalCwd: longCwd, nativeSessionId: longId });
    assert.equal(longResult.state, "present");
    if (longResult.state === "present") assert.deepEqual(longResult.messages.map(m => m.content), ["long workspace history", "history reply 3"]);
    assert.equal(provider.calls(), 3);
  } finally { await provider.close(); await f.cleanup(); }
});
