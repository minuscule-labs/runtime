# Claude Code full Runtime: spec v1

Status: **ready for implementation (Part A)**. Branch `feat/claude-full-runtime`, based on `main` at `d8beb75`
(which includes managed recovery, #25). Part B (Channels) starts after Part A merges.

## 1. Goal

Ship `@minu/runtime-claude-code` as a **fully functioning** Runtime adapter, on a par with what Pi
agents can do in Channels today. Today's managed adapter is a read-only, text-only MVP. This spec
removes those limits:

- **Native auth.** The adapter uses the user's existing Claude Code login: `~/.claude` (or
  `$CLAUDE_CONFIG_DIR`) and the macOS keychain. Runtime and Channels never read, copy, store or
  prompt for credentials. If the user isn't logged in, the adapter reports that clearly.
- **Native harness.** It uses the user's installed `claude` executable by default, with the SDK's
  bundled engine as an explicit option, and the user's native configuration (settings, CLAUDE.md,
  skills, MCP servers, plugins and hooks).
- **Full capability.** Model and effort selection; skill selection; image input; steering;
  interruption; and the full native tool set (Edit, Write, Bash, …) under an explicit permission
  policy. None of these may be rejected with "not supported yet".

## 2. Current restrictions to remove (from `main`)

| Where | Restriction |
|---|---|
| `client.ts` `open()` | `model`, `reasoningLevel` and `skillIds` throw "not supported yet" |
| `client.ts` query options | `tools` defaults to Read/Grep/Glob; `permissionMode: "default"`; `settingSources: []`; `disableAllHooks`; `strictMcpConfig` with empty `mcpServers`; `plugins: []`; `env` replaces the environment |
| `client.ts` `onUserDialog` | any dialog takes the session offline |
| `client.ts` ~503, `native-history.ts` | `claude_code_version` / row `version` pinned to `2.1.321` |
| `native-history.ts` | `unsupported_format` for unknown blocks/records; 1 MiB text / 8 MiB file / 2,000-message caps |
| `managed-runtime.ts` constructor | `nativeConfigRoot` must be private (`mode & 0o077 == 0`) and equal `env.CLAUDE_CONFIG_DIR`; `env` required |
| `managed-runtime.ts` `startManaged` | only `cwd` / `systemPrompt` / `appendSystemPrompt` allowed; images rejected in `send` / `startTurn`; `steer` unsupported; `capabilities()` empty |
| `worker-lifecycle.ts` `requireClaudeCodeMvpPolicy` | requires isolated config, default permissions, a Read/Grep/Glob subset, and no model/reasoning/skills |
| `managed-store.ts` | the manifest `policy` encodes that MVP policy |

## 3. Design

### 3.1 Native auth and config root
- New option `nativeConfigRoot?: string`. When omitted, resolve it as Claude Code does:
  `$CLAUDE_CONFIG_DIR` if set, otherwise `~/.claude`. Then `realpath` it, and require that it's a
  directory owned by the current uid. **Drop the `0o077` mode check**, because a normal `~/.claude`
  is world-readable. Never create, chmod or write into it.
- The worker's environment **inherits** `process.env` (`HOME` is needed for keychain access),
  overlaid with optional `envOverrides`. Remove the "env replaces everything" rule for managed
  sessions. Keep removing `NODE_OPTIONS`, `NODE_PATH`, `CLAUDE_CODE_PROJECT_DIR_NAME` and
  `CLAUDE_CODE_RESUME_INTERRUPTED_TURN`, since these break identity or history. Set
  `CLAUDE_CONFIG_DIR` only when the caller passed `nativeConfigRoot` explicitly.
- **Auth preflight.** `capabilities()` and `startManaged()` call the SDK's `accountInfo()` (or the
  equivalent init result) on a short-lived query. If it's unauthenticated, throw a specific,
  non-secret error, `ClaudeCodeAuthRequiredError` ("Claude Code is not logged in; run `claude` to
  sign in"), without starting a session. Never log account details beyond a boolean or an
  account-type label.
- `ANTHROPIC_API_KEY` in the inherited environment is honored natively. The adapter adds no
  special handling.

### 3.2 Executable
- New option `executable?: string | "bundled"`. The default resolves the installed `claude` by
  searching `PATH`, then `~/.claude/local/claude`, and requires it to be a regular, executable file
  owned by the user or root. `"bundled"` uses the SDK's pinned engine. Record the resolved path and
  the reported `claude_code_version` in the manifest.
- Each managed session pins the **executable path and version it was created with**. Resume
  refuses a changed major version, and allows minor/patch changes when the history parser accepts
  the file (§3.5). This replaces the exact `2.1.321` pin with a **supported range**, declared as a
  constant (for example `>=2.1.300 <3`) and covered by tests.

### 3.3 Permission policy (tools)
- New option `permissions: "full" | "edits" | "readOnly" | { mode, allowedTools?, disallowedTools? }`.
  - **`"full"`**, Pi parity and the default for Channels: `permissionMode: "bypassPermissions"`
    with `allowDangerouslySkipPermissions: true`, all native tools.
  - **`"edits"`**: `acceptEdits` plus all tools. Bash and other non-edit tools are allowed only
    through `canUseTool`.
  - **`"readOnly"`**: today's behavior, kept for compatibility.
- The library default stays **`"readOnly"`**, so library callers have to opt in to `"full"`
  explicitly. Channels opts in.
- **Headless dialogs.** Disallow tools that need a human in the loop (`AskUserQuestion`,
  `ExitPlanMode`, and any others the SDK lists as interactive) through `disallowedTools`. If
  `onUserDialog` still fires, fail **only that turn** with a clear error and leave the session
  usable, unless the native process is unhealthy.
- Store the chosen policy in the manifest. Resume uses the stored policy; changing it needs a new
  session.

### 3.4 Native configuration
- `settingSources: ["user", "project", "local"]`, and hooks enabled.
- Native MCP config, so drop `strictMcpConfig` and the empty `mcpServers`. Load native plugins and
  skills. Add an option `isolateConfiguration: true` that restores today's isolated behavior for
  callers who want it, such as tests.
- These are the user's own settings running as the user. Document that no new trust is granted:
  this matches running `claude` in that `cwd`.

### 3.5 Native history (resume and `messages()`)
- Accept every content block and record type the supported range emits:
  - tool_use and tool_result for every tool;
  - images, as placeholders such as `"[image]"` in projected text;
  - thinking, redacted_thinking and server tool blocks;
  - compaction / summary records;
  - sidechain/subagent records, skipped for projection but validated structurally.
- Unknown **metadata** record types are skipped. Unknown **chain** records still fail closed with
  `unsupported_format`.
- **Caps.** The file cap becomes 64 MiB and the line cap 8 MiB. The text cap applies only to the
  *projected* messages returned to callers: keep the newest N messages within 4 MiB rather than
  failing, and mark the truncation with a leading system message. Stop, resume and eligibility
  checks validate **structure and the completed-input match only**, never total size. This
  closes the "history too large makes the session permanently unusable" finding from #24.
- The live `state.messages` uses the same projection bound, so `/messages` never exceeds the bridge
  cap.
- Build a fixture corpus from history written by the bundled 2.1.321 engine with Edit, Bash and
  image turns: generate it locally with the synthetic provider and commit the sanitized `.jsonl`
  files.

### 3.6 Launch options (`AgentStartConfig`)
- **`model`**: `{ provider: "anthropic", id }`. Validate the id against `supportedModels()` and pass
  it as `model`. Any other provider is rejected.
- **`reasoningLevel`**: map `off → maxThinkingTokens: 0`; `minimal`/`low`/`medium`/`high`/`xhigh`/`max`
  → `effort`, restricted to `supportedEffortLevels` for the chosen model. Reject an unsupported
  level; never downgrade silently.
- **`skillIds`**: pass them as `skills` (an allow-list). An empty array means no skills; omitted
  means native defaults. Validate them against discovered skills.
- **`capabilities({ cwd })`** returns:
  - `models` from `supportedModels()`;
  - `reasoningLevels` from the union of supported effort levels, plus `off`;
  - `skills` from the SDK init result for that `cwd`;
  - `defaultModel` and `defaultReasoningLevel` from the init result.

  Implement it with a short-lived query that sends no prompt, never dispatches user input, and
  cleans up with confirmed exit.
- Persist model, reasoning and skills in the managed manifest's `launchConfig`, and re-apply them
  on resume.

### 3.7 Input and control
- **Images**: accept `RuntimeImageContent` (limits from `runtimeInput` in core) and send them as SDK
  image blocks. `inputCapabilities()` reports `images: true` when the chosen model supports vision.
- **Steering**: `steer(id, input)` queues a user message into the live streaming input while a turn
  is running. The SDK's streaming input delivers it at the next native boundary. Report
  `sessionCapabilities().steer`, or the existing capability flags, accordingly.
- **Interrupt** stays as it is. After an interrupted or failed turn, normal `suspend`/`stop` must
  work once the native process is idle again. This closes the #24 finding that only a completed
  last dispatch was stoppable. Keep `forceStopManaged` as the fallback.

### 3.8 Process family under full tools
With Bash enabled, native subprocesses can leave the worker's process group (`setsid`, daemons).
Update `docs/claude-code-process-family-contract.md` to v3:
- Group termination covers the worker family, not processes that escaped it. This is the same as
  Pi's guarantee.
- Recovery semantics from #25 are unchanged.
- The "no-escape" assumption is dropped, and absence proof covers only the group.

## 4. Work items (Part A, runtime). Commit each separately, with its tests.

1. **A1** Config root, inherited environment and auth preflight (§3.1), plus `ClaudeCodeAuthRequiredError`.
2. **A2** Executable resolution, the version range, and recording both in the manifest (§3.2).
3. **A3** Permission policy and headless-dialog handling (§3.3). The managed `policy` schema becomes a
   versioned manifest bump; old manifests read as `readOnly`.
4. **A4** Native configuration sources with an `isolateConfiguration` escape hatch (§3.4).
5. **A5** History parser widening, projection bound, the new caps, and the fixture corpus (§3.5).
6. **A6** Model, reasoning, skills and `capabilities()` (§3.6).
7. **A7** Images, steering, and stop after an interrupted or failed turn (§3.7).
8. **A8** Contract v3 and README: replace the "durable text-only MVP" section with full usage, auth
   and permission docs (§3.8).
9. **A9** Shared headless conformance: the Claude Code cases pass with `permissions: "full"`, and add
   an Edit/Bash turn case that uses the synthetic provider to request a tool call.
10. **A10** Owner-per-call managed API on `ClaudeCodeAgentRuntime` (§6). With a no-argument constructor
    (plus optional `{ permissions, managedRoot, executable, nativeConfigRoot }`), `startManaged`,
    `resume`, `suspend`, `forceStopManaged`, `destroy`, `getManagedSession` and `listManagedSessions`
    take `ownerId` per call, as `CodexAgentRuntime` does. The default `managedRoot` is
    `~/.minu/runtime/claude-code` (mode 0700, created if missing). `ClaudeCodeManagedRuntime` stays
    as the per-owner implementation underneath.

### 4.1 Scope decision: Pi parity first (as implemented)

The goal is functional parity with the Pi adapter; further capabilities are evaluated after that.

- **Built:** A1 (native config root, inherited environment, auth preflight); A3 (permission policy, manifest v5; native
  configuration by default with `isolateConfiguration` as the escape hatch, i.e. the native part of A4); A6 (model,
  reasoning, skills, `capabilities()`); A7 (images, steering, stop after an interrupted or failed turn); minimal A2
  (engine version recorded, supported range `>=2.1.300 <3`, resume refuses a changed major); minimal A5 (only the history
  rows the real engine writes for tool, image and steering turns); A9 (shared headless conformance with `permissions:
  "full"` plus real-engine Write/Bash turns); A10 (owner-per-call managed API on `ClaudeCodeAgentRuntime`); A11
  (`inspectSessionProfile`, `inspectSessionEvents`, `inspectSessionIntegrations`, integrations via `mcpServerStatus()`).
- **Deferred (still specified above):** A8 (contract v3 and README), the larger A5 (64 MiB caps, projection bound,
  fixture corpus), executable path pinning and manifest recording. Executable selection is Pi-simple: the installed `claude` found on
  PATH is the default, `executable: "bundled"` selects the SDK engine, any other value is an explicit path, A4's per-session `isolateConfiguration` manifest field beyond `policy.configuration`.
- **Deviation from 3.3:** an interactive dialog takes the owned session offline, as Pi and Codex do and as the shared
  refusal contract asserts (rather than failing only the turn).
- **Opt-in real smoke test:** `MINU_CLAUDE_REAL_SMOKE=1 node --test packages/claude-code/dist/test/real-smoke.test.js`
  (uses the real native login and model; skipped by default, never run by the implementer).

## 5. Testing rules

- Credential-free by default: the existing synthetic providers and native fixtures, with dummy
  keys and private disposable `HOME` / `CLAUDE_CONFIG_DIR`. **The implementer must not run against
  a real login or model.**
- Add one **opt-in** real smoke test, skipped unless `MINU_CLAUDE_REAL_SMOKE=1`. It starts a managed
  session against the user's native login and installed `claude`, runs one Read turn and one tiny
  Edit in a temp directory, stops it, resumes it and destroys it. Document the command; don't run
  it.
- Don't weaken existing assertions. Where MVP refusals become features (for example "model
  selection rejected"), replace each with a test of the new behavior *and* a test of the
  rejection path that remains (an unsupported model or effort).
- Required before handing off: `pnpm check`, `pnpm test` (0 failures; the existing macOS EPERM
  recovery flake is known and should be reported, not fixed here) and `pnpm test:headless`.

## 6. Part B: Channels (after Part A merges; separate spec pass)

These are listed so Part A's API fits them. Don't implement them in Part A.
- Add `"claude-code"` to `loadLocalRuntimes`. The constructor takes no required arguments, and the
  owner id passes per call, as for Pi and Codex. **Part A must make `ClaudeCodeAgentRuntime` handle
  managed sessions for any `ownerId` per call**, merging `ClaudeCodeManagedRuntime` behind
  owner-scoped stores, so Channels can construct it with only `{ permissions: "full",
  managedRoot }`. Add this as work item **A10**.
- Release packaging bundles the adapter and worker entry, and relies on the installed `claude`. No
  native binary ships.
- Show a "Claude Code not logged in" state in the per-agent setup when `ClaudeCodeAuthRequiredError`
  is raised. Model, reasoning and skill pickers come from `capabilities()`.
- Black-box test: per-agent Claude Code turn, restart without replay, and recovery through
  `forceStopManaged`.

## 7. Acceptance (Part A)
- [ ] A1–A10 are committed with tests, and contract v3 plus the README are updated.
- [ ] `pnpm check`, `pnpm test` and `pnpm test:headless` are green locally (macOS EPERM flake excepted
      and reported). Counts are recorded.
- [ ] The opt-in real smoke test is written and documented, and not run by the implementer.
- [ ] Not pushed, merged or published by the implementer.
