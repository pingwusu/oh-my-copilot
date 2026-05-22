# Hooks Parity Plan: omc -> omcp (v3 -- Direct 1:1 Native Port + Copilot-Advantage Exploitation)

**Date:** 2026-05-22
**Status:** Draft v3 (supersedes v2; post-research rewrite)
**Word count target:** <=3500

---

## v3 Context

v2 was built on the assumption that Copilot CLI has only 6 hook events and that several omc events (UserPromptSubmit, PermissionRequest, PostToolUseFailure, SubagentStart/Stop, PreCompact, Stop, SessionEnd) have no Copilot equivalent. Three parallel research agents (official docs, Claude cross-reference, empirical bundle extraction from `@github/copilot/app.js` `aWr` Set) proved this wrong:

- **Copilot CLI 1.0.48 exposes 13 hook events**, not 6.
- **All 11 omc events that omcp needs have direct Copilot equivalents.** No approximation layer needed.
- v2's "Option C+ approximation layer" (mapping `UserPromptSubmit->PreSubmit`, `Stop->PreEnd`) is obsoleted -- those were Claude-Code-style misnomers that Copilot silently ignores (the P0 bug fixed in v0.9.1, commit `6934357`).
- v2's "Step 0: verify advise stdout reaches model" is **resolved** -- Copilot's `additionalContext` field in hook output JSON is the documented injection mechanism (already used in `src/hooks/wiki/session-hooks.ts:65,98`).
- v2's subagent tracking deferral is **lifted** -- `subagentStart` and `SubagentStop` are real Copilot events.
- Copilot has **3 capabilities Claude lacks** that unlock novel applications.

**This plan is Option D: direct 1:1 native port + Copilot-advantage exploitation.** Options A/B/C/C+ from v2 are all obsolete.

---

## RALPLAN-DR Summary

### Principles (5)

1. **Direct 1:1 mapping, zero approximation.** Every omc hook event has an exact Copilot counterpart. Use PascalCase aliases where available; use `subagentStart` (camelCase only) for the sole exception (`hook-types.ts:25`).
2. **Exploit Copilot superiorities, not just match Claude.** `modifiedArgs`, `modifiedResult`, and `interrupt` are capabilities Claude Code does not have. Port omc hooks first, then build novel applications on top.
3. **Library modules and event hooks remain separate concerns.** factcheck/sentinel-gate are libraries consumed by the team runtime, not hook-event subscribers (`hook-types.ts:44-48` vs `src/team/` call-sites). Port them into `src/lib/` or `src/team/`.
4. **HookResult contract must expand.** Current contract is `noop | advise | block` (`hook-types.ts:39-42`). Copilot supports `modifiedArgs`, `modifiedResult`, and `interrupt` which need new result kinds.
5. **Each hook ships with a regression test.** Hooks are invisible at runtime if broken. The v0.9.1 P0 (3 dead hooks) must never recur.

### Decision Drivers (top 3)

1. **13-event ground truth eliminates all approximation risk.** The mapping is exact for every omc event omcp needs.
2. **Anti-hallucination + long-running ralph/ralplan/team is the user's stated priority.** persistent-mode, factcheck, sentinel-gate, todo-continuation, omc-orchestrator remain highest priority.
3. **Copilot's `modifiedArgs`/`modifiedResult`/`interrupt` unlock applications impossible in omc.** Arg rewriting, output sanitization, and hard-stop are novel capabilities that justify the omcp project's existence beyond mere parity.

---

## Authoritative Event Mapping

| # | Copilot camelCase | PascalCase Alias | Claude Code Equivalent | omcp `HookEvent` |
|---|-------------------|------------------|------------------------|-------------------|
| 1 | `sessionStart` | `SessionStart` | `SessionStart` | `SessionStart` |
| 2 | `sessionEnd` | `SessionEnd` | `SessionEnd` | `SessionEnd` |
| 3 | `userPromptSubmitted` | `UserPromptSubmit` | `UserPromptSubmit` | `UserPromptSubmit` |
| 4 | `preToolUse` | `PreToolUse` | `PreToolUse` | `PreToolUse` |
| 5 | `postToolUse` | `PostToolUse` | `PostToolUse` | `PostToolUse` |
| 6 | `postToolUseFailure` | `PostToolUseFailure` | `PostToolUseFailure` | `PostToolUseFailure` |
| 7 | `errorOccurred` | `ErrorOccurred` | *(none)* | `ErrorOccurred` |
| 8 | `agentStop` | `Stop` | `Stop` | `Stop` |
| 9 | `subagentStop` | `SubagentStop` | `SubagentStop` | `SubagentStop` |
| 10 | `subagentStart` | *(none -- camelCase only)* | `SubagentStart` | `subagentStart` |
| 11 | `preCompact` | `PreCompact` | `PreCompact` | `PreCompact` |
| 12 | `permissionRequest` | `PermissionRequest` | `PermissionRequest` | `PermissionRequest` |
| 13 | `notification` | `Notification` | `Notification` | `Notification` |

**Citation:** `COPILOT_VALID_EVENTS` at `copilot-config.ts:145-173`. `HookEvent` type at `hook-types.ts:15-28`. Regression test at `copilot-hook-events-validation.test.ts:22-86`.

---

## omc Hook Classification -- Direct 1:1 Ports (Shell Hooks)

All 20 omc shell hooks now have direct Copilot event targets. No approximation needed.

| # | Shell Hook | Claude Event | Copilot Event | Difficulty |
|---|-----------|-------------|---------------|------------|
| 1 | keyword-detector | UserPromptSubmit | UserPromptSubmit | TRIVIAL |
| 2 | skill-injector | UserPromptSubmit | UserPromptSubmit | TRIVIAL |
| 3 | session-start | SessionStart | SessionStart | TRIVIAL |
| 4 | project-memory-session | SessionStart | SessionStart | TRIVIAL |
| 5 | setup-init | SessionStart | SessionStart | SIMPLE |
| 6 | setup-maintenance | SessionStart | SessionStart | SIMPLE |
| 7 | pre-tool-enforcer | PreToolUse | PreToolUse | TRIVIAL |
| 8 | permission-handler | PermissionRequest | PermissionRequest | TRIVIAL |
| 9 | post-tool-verifier | PostToolUse | PostToolUse | TRIVIAL |
| 10 | project-memory-posttool | PostToolUse | PostToolUse | TRIVIAL |
| 11 | post-tool-use-failure | PostToolUseFailure | PostToolUseFailure | TRIVIAL |
| 12 | subagent-tracker(start) | SubagentStart | subagentStart | SIMPLE |
| 13 | subagent-tracker(stop) | SubagentStop | SubagentStop | SIMPLE |
| 14 | verify-deliverables | SubagentStop | SubagentStop | MEDIUM |
| 15 | pre-compact | PreCompact | PreCompact | TRIVIAL |
| 16 | project-memory-precompact | PreCompact | PreCompact | TRIVIAL |
| 17 | context-guard-stop | Stop | Stop | TRIVIAL |
| 18 | persistent-mode | Stop | Stop | SIMPLE |
| 19 | code-simplifier | Stop | Stop | SIMPLE |
| 20 | session-end | SessionEnd | SessionEnd | TRIVIAL |

**Key change from v2:** Rows 8 (PermissionRequest), 11 (PostToolUseFailure), 12-14 (subagent lifecycle), 15-16 (PreCompact) were all marked DEFERRED/N/A/APPROXIMATE in v2. All are now DIRECT.

---

## omc Programmatic Modules -- Library Ports

| # | Module | omc Event(s) | Port Priority | Copilot Event |
|---|--------|-------------|---------------|---------------|
| 1 | factcheck (library) | Library | **HIGH** | `src/lib/factcheck.ts` |
| 2 | sentinel-gate (library) | Library | **HIGH** | `src/team/sentinel-gate.ts` |
| 3 | persistent-mode | Stop | **HIGH** | Stop -- DIRECT |
| 4 | todo-continuation | Stop | **HIGH** | Stop -- DIRECT |
| 5 | omc-orchestrator | PreToolUse+PostToolUse | **HIGH** | DIRECT |
| 6 | preemptive-compaction | PostToolUse | **HIGH** | PostToolUse+PreCompact -- DIRECT |
| 7 | rules-injector | PostToolUse | MEDIUM | PostToolUse -- DIRECT |
| 8 | recovery | PostToolUse | MEDIUM | PostToolUse -- DIRECT |
| 9 | auto-slash-command | UserPromptSubmit | MEDIUM | UserPromptSubmit -- DIRECT |
| 10 | background-notification | PostToolUse | MEDIUM | PostToolUse+Notification -- DIRECT |
| 11 | notepad | PreCompact+PostToolUse | LOW | PreCompact+PostToolUse -- DIRECT |

---

## Copilot-Advantage Applications

These are novel capabilities enabled by Copilot hook features that Claude Code does not have. They justify omcp beyond mere omc parity.

### 1. `preToolUse.modifiedArgs` -- Rewrite tool arguments before execution

**Host event:** `PreToolUse`
**Copilot mechanism:** Hook returns `{ modifiedArgs: {...} }` and Copilot replaces the tool's input arguments before invoking the tool. Claude Code has no equivalent.

**Applications:** Bash safety net (auto `--dry-run` on destructive cmds), path normalizer (resolve `../` chains in Write/Edit args), shell-quoting sanitizer (fix unescaped `$()`), cost optimizer (narrow over-broad search scope), secret redactor (replace tokens with `$env:` refs).

**Implementation:** New `HookResult` variant `{ kind: "modifiedArgs"; args: unknown }`. Hook runner returns modified args in stdout JSON. `PreToolUse` already wired (`copilot-config.ts:137`).

### 2. `postToolUse.modifiedResult` -- Rewrite tool output before model sees it

**Host event:** `PostToolUse`
**Copilot mechanism:** Hook returns `{ modifiedResult: "..." }` and Copilot replaces the tool's output in the model's context window. This is the most powerful Copilot-only capability. Claude Code has no equivalent.

**Applications:** Hallucination shield (factcheck on tool output BEFORE model sees it -- proactive, not reactive), PII redactor (scrub credit cards/SSNs/API keys from Read/Bash output), output truncator (smart truncation of outputs >5000 chars to relevant excerpts), schema enforcer (validate tool output structure, inject error on mismatch), annotation injector (prepend file age/author/coverage metadata).

**Implementation:** New `HookResult` variant `{ kind: "modifiedResult"; result: string }`. PostToolUse hook runner returns `modifiedResult` field in stdout JSON. Foundation for "surgeon mode" cross-cutting pattern.

### 3. `permissionRequest.interrupt: true` -- Hard-stop the agent

**Host event:** `PermissionRequest`
**Copilot mechanism:** Hook returns `{ interrupt: true }` and Copilot immediately terminates the agent. Claude Code can only `deny` (which blocks the tool call but lets the agent continue and potentially retry).

**Applications:** Catastrophic command guard (hard-stop on `rm -rf /`, `DROP TABLE`, `git push --force origin main`), budget exhaustion stop (cumulative cost tracking, interrupt at threshold), loop detector (interrupt after N identical tool calls), external kill switch (check `.omcp/state/kill-switch` file for human-in-the-loop abort).

**Implementation:** New `HookResult` variant `{ kind: "interrupt" }`. PermissionRequest hook runner returns `{ interrupt: true }` in stdout JSON. Hardest stop available -- no retry, no continuation.

### 4. `errorOccurred` -- Cross-session error intelligence

**Host event:** `ErrorOccurred` (Copilot-only, no Claude equivalent)

**Applications:** Error aggregator (append to `.omcp/state/errors.jsonl` with timestamp/session/stack), auto-recovery advisor (inject recovery steps on repeated error patterns), flaky test detector (flag tests failing >30% across sessions).

### 5. `notification` -- Real-time status integration

**Host event:** `Notification` (Copilot-only, no Claude equivalent)

**Applications:** HUD status updates (pipe to HUD state file for real-time display), idle alerts (detect notification gaps, dispatch Discord/Slack/Telegram alert), audit stream (append-only notification log).

**Implementation:** Background notification dispatcher already exists (`src/hooks/background-notifications.ts:46-104`). Wire `Notification` event to dispatch pipeline.

### Cross-Cutting "Supercharger" Patterns

These combine multiple Copilot advantages:

1. **Surgeon mode** (`modifiedArgs` + `modifiedResult`): Every tool call passes through safety/logging middleware. Args are sanitized pre-execution; results are annotated post-execution. Full tool-call middleware stack.
2. **Hallucination shield** (`modifiedResult` + factcheck): Proactive output rewriting, not just post-hoc detection. factcheck runs on tool output BEFORE the model processes it.
3. **Cost governor** (`modifiedArgs` + `modifiedResult` + `interrupt`): Args downgrade expensive calls, results truncate bloated outputs, interrupt kills runaway sessions.
4. **Auditable mode** (all middleware): Every tool call logged with original args, modified args, original result, modified result. Produces distillation-ready training data.

---

## Recommended Option

**Option D: Direct 1:1 native port + Copilot-advantage exploitation.**

This supersedes all v2 options:
- **Option A** (aggressive port with fake Task tool mapping) -- obsolete; subagent events exist natively.
- **Option B** (strict 6-event match only) -- obsolete; there are 13 events, not 6.
- **Option C** (adaptive approximation) -- obsolete; no approximation needed.
- **Option C+** (modified adaptive) -- obsolete; all v2's "approximate" mappings are now exact.

Option D delivers ~2x value over v2: full parity (zero gaps) PLUS novel applications impossible in omc.

---

## Phased Execution Plan

### Phase 1: P0 Cleanup + Foundation [MOSTLY DONE]

**Status:** v0.9.1 (commit `6934357`) shipped the critical fixes.

**Completed:**
- `OMCP_HOOK_EVENTS` corrected to 5 real Copilot events (`copilot-config.ts:136-142`)
- `HookEvent` type expanded to all 13 events (`hook-types.ts:15-28`)
- `COPILOT_VALID_EVENTS` const with 13 camelCase + 12 PascalCase aliases (`copilot-config.ts:145-173`)
- Regression test for event name validity (`copilot-hook-events-validation.test.ts:22-86`)
- `VALID_EVENTS` array in runtime aligned (`runtime.ts:406-420`)

**Remaining:**
- Expand `OMCP_HOOK_EVENTS` from 5 to all 13 events (wire all events in `~/.copilot/config.json`)
- Expand `HookResult` type with `modifiedArgs`, `modifiedResult`, `interrupt` variants (`hook-types.ts:39-42`)
- Add `additionalContext` output field to `runFireCli` stdout JSON (`runtime.ts:440-451`)

**Acceptance:** `OMCP_HOOK_EVENTS` length === 13. `HookResult` union has 6 variants. `omcp hook fire Notification --json` is accepted (not "unknown event").

### Phase 2: Anti-Hallucination Core Ports [USER PRIORITY]

Port the 6 highest-priority hooks/libraries using direct 1:1 event mapping:

| Module | Event | Source Reference |
|--------|-------|-----------------|
| persistent-mode | Stop | Ralph/ralplan persistence backbone |
| todo-continuation | Stop | Enforce task completion across turns |
| omc-orchestrator | PreToolUse + PostToolUse | Coordinate execution mode behaviors |
| factcheck (library) | N/A (library) | Claims validation engine for sentinel-gate |
| sentinel-gate (library) | N/A (library) | Readiness gate for team workers |
| preemptive-compaction | PostToolUse + PreCompact | Context overflow prevention |

**Acceptance:** persistent-mode returns advise when ralph-state.json is active. sentinel-gate blocks worker launch when factcheck fails. preemptive-compaction fires on both PostToolUse and PreCompact. Each has unit test.

### Phase 3: Subagent Lifecycle + Session Hooks [NO LONGER DEFERRED]

Port subagent tracking (previously deferred as "impossible"):

| Module | Event |
|--------|-------|
| subagent-tracker (start) | subagentStart (camelCase only!) |
| subagent-tracker (stop) | SubagentStop |
| verify-deliverables | SubagentStop |
| keyword-detector | UserPromptSubmit |
| skill-injector | UserPromptSubmit |
| session-start/end | SessionStart / SessionEnd |
| permission-handler | PermissionRequest |
| post-tool-use-failure | PostToolUseFailure |
| pre-compact + project-memory-precompact | PreCompact |

**Acceptance:** `subagentStart` hook fires when `/fleet` dispatches a worker (verified via `omcp hook fire subagentStart --json`). `verify-deliverables` runs on SubagentStop. All 20 shell hooks from the classification table have omcp implementations with unit tests.

### Phase 4: Hallucination Shield [COPILOT SUPERCHARGER]

Build the `modifiedResult`-based proactive factcheck -- the single most novel application.

**Work:**
- Implement `modifiedResult` handler in `PostToolUse` hook runner
- Create `hallucination-shield` hook: runs factcheck on tool output, annotates suspicious claims with `[UNVERIFIED]` markers, truncates hallucinated paths/URLs
- Create `pii-redactor` hook: regex-based scrubbing of credit cards, SSNs, API keys from tool output
- Create `output-truncator` hook: smart truncation of outputs > 5000 chars (preserve first/last N lines + matched patterns)

**Acceptance:** `hallucination-shield` modifies a PostToolUse result containing a fabricated file path to include `[UNVERIFIED: file not found]` annotation. PII redactor replaces a credit card number in Bash output with `[REDACTED]`. Output truncator reduces a 10000-line Read result to ~200 lines with `[...truncated N lines...]` markers.

### Phase 5: Cost Governor + Audit Middleware [COPILOT SUPERCHARGER]

Build the `modifiedArgs` + `interrupt` applications.

**Work:**
- Implement `modifiedArgs` handler in `PreToolUse` hook runner
- Create `bash-safety-net` hook: inject `--dry-run` on destructive commands via modifiedArgs
- Create `cost-governor` hook: track cumulative tool calls in `.omcp/state/cost.json`; interrupt via PermissionRequest when budget exceeded
- Create `loop-detector` hook: track repeated similar tool calls; interrupt after N repeats
- Create `audit-logger` hook: log full tool-call lifecycle (args -> modifiedArgs -> result -> modifiedResult) to `.omcp/state/audit.jsonl`

**Acceptance:** `bash-safety-net` rewrites `rm -rf /tmp/test` to `rm -rf /tmp/test --dry-run` (or blocks). Cost governor interrupts after configurable threshold. Audit logger produces valid JSONL with both original and modified fields.

### Phase 6: Telemetry + Status Integration

Wire the two Copilot-only events with no Claude equivalent.

**Work:**
- Create `error-aggregator` hook on `ErrorOccurred`: append to `.omcp/state/errors.jsonl`
- Create `auto-recovery-advisor` hook on `ErrorOccurred`: pattern-match recurring errors, inject recovery advice
- Wire `Notification` event to existing background notification dispatcher (`src/hooks/background-notifications.ts:46`)
- Create `idle-alert` hook on `Notification`: detect notification gaps > threshold, dispatch external alert

**Acceptance:** `ErrorOccurred` events produce entries in `errors.jsonl`. Notification events reach the background dispatcher. `omcp doctor` includes error pattern summary.

---

## Pre-mortem (3 scenarios)

**Scenario 1: `modifiedArgs`/`modifiedResult` JSON protocol differs from documentation**
- **Trigger:** Copilot CLI expects a different stdout schema for arg/result rewriting than what the docs describe.
- **Detection:** Phase 4/5 integration tests fail -- modified args/results not applied.
- **Mitigation:** Empirical probe in Phase 1 remaining work: create a smoke hook returning `{ modifiedResult: "CANARY" }` on PostToolUse, verify Copilot applies it. If schema differs, adapt `HookResult` serialization. Fallback: use `advise` to inject correction text post-hoc (degrades to v2 behavior for Phase 4/5 features only).

**Scenario 2: persistent-mode hits timeout during ralph iteration 50+**
- **Trigger:** State file I/O slow under large `.omcp/state/ralph-state.json` after many iterations.
- **Detection:** `runtime.ts:185-196` logs timeout to stderr. Hook fire logged in `.omcp/state/hooks/fired.jsonl` with duration_ms.
- **Mitigation:** persistent-mode uses atomic read (no lock files). On timeout returns `{kind:"noop"}` (graceful degradation). State file is bounded (single JSON object, not append-only). Increase timeout to 15000ms for persistent-mode via `LoadOptions.timeoutMs` (`runtime.ts:44`).

**Scenario 3: Copilot CLI 1.1.x changes event names or adds new ones**
- **Trigger:** Upstream Copilot update renames/adds events.
- **Detection:** `copilot-hook-events-validation.test.ts` fails if COPILOT_VALID_EVENTS diverges from runtime.
- **Mitigation:** `COPILOT_VALID_EVENTS` and `OMCP_HOOK_EVENTS` are isolated constants (`copilot-config.ts:136,145`). Pin minimum Copilot CLI version in docs. Add version-check advisory on SessionStart.

---

## Expanded Test Plan

**Unit tests (per hook):**
- Each hook's `run(ctx)` returns expected `HookResult` for given `HookContext`.
- persistent-mode: returns advise when ralph-state active; noop when inactive; noop when stale (>2h).
- factcheck: PASS/FAIL/WARN for valid/invalid/partial claims.
- sentinel-gate: blocks when factcheck FAIL; passes when PASS.
- hallucination-shield: modifies result containing fabricated path; passes through clean result unchanged.
- bash-safety-net: rewrites `rm -rf /` args; passes through safe commands unchanged.
- cost-governor: returns interrupt when budget exceeded; noop when under budget.
- loop-detector: returns interrupt after N identical calls; noop for varied calls.

**Integration tests (multi-hook dispatch):**
- `fireHooks("Stop", ctx)` dispatches to persistent-mode + todo-continuation + context-guard-stop in order.
- `fireHooks("PreToolUse", ctx)` dispatches to pre-tool-enforcer + omc-orchestrator + bash-safety-net; modifiedArgs from safety-net is applied.
- `fireHooks("PostToolUse", ctx)` dispatches to post-tool-verifier + hallucination-shield + output-truncator; modifiedResult is chained.
- `fireHooks("subagentStart", ctx)` dispatches subagent-tracker. Case-sensitive: "SubagentStart" must NOT match.
- `loadHooks()` discovers all registered hooks from plugin dir and repo-local `.omcp/hooks/`.

**E2E tests:**
- `omcp hook fire Stop --json < payload.json` triggers persistent-mode advise when ralph-state.json exists.
- `omcp hook fire PostToolUse --json < large-output.json` returns modifiedResult with truncation.
- `omcp hook fire PermissionRequest --json < dangerous-cmd.json` returns interrupt for `rm -rf /`.

**Observability:**
- Hook fire events logged to `.omcp/state/hooks/fired.jsonl` with `{timestamp, event, hook, result_kind, duration_ms}`.
- `omcp doctor` checks: (a) all 13 events wired in config.json, (b) no stale lock files, (c) fired.jsonl rotation at 10MB, (d) error pattern summary from errors.jsonl.

---

## Acceptance Criteria

1. **All 13 Copilot events wired** in `OMCP_HOOK_EVENTS` and `~/.copilot/config.json` after `omcp setup`.
2. **HookResult expanded** to 6 variants: `noop`, `advise`, `block`, `modifiedArgs`, `modifiedResult`, `interrupt` (`hook-types.ts`).
3. **Every Phase-2 hook observable** firing via `.omcp/state/hooks/fired.jsonl` under a live Copilot CLI session.
4. **20 shell hooks + 11 programmatic modules ported.** Zero gaps, zero approximations.
5. **Hallucination shield functional:** `modifiedResult` rewrites suspicious PostToolUse output with annotations.
6. **Cost governor functional:** `interrupt` fires when cumulative tool calls exceed configurable threshold.
7. **Subagent lifecycle tracked:** subagentStart/SubagentStop hooks fire on `/fleet` dispatch and completion.
8. **No Claude-specific references** in shipped hooks: no `$CLAUDE_PLUGIN_ROOT`, no `hookSpecificOutput`, no `<system-reminder>` generation.
9. **Observability:** `fired.jsonl` logging + `omcp doctor` hook health checks operational.
10. **Regression test suite green:** `copilot-hook-events-validation.test.ts` + all new hook unit tests pass.

---

## ADR: Hook Parity Approach

**Decision:** Option D -- direct 1:1 native port of all 20 omc shell hooks and 11 programmatic modules to their exact Copilot event counterparts, plus novel applications exploiting Copilot's `modifiedArgs`, `modifiedResult`, and `interrupt` capabilities.

**Drivers:**
1. Copilot CLI 1.0.48 has 13 hook events -- all 11 omc events used by omcp have direct equivalents.
2. User priority is anti-hallucination for ralph/ralplan/team long-running loops.
3. `modifiedArgs`/`modifiedResult`/`interrupt` enable applications impossible in omc, justifying omcp's existence beyond parity.

**Alternatives considered:**
- **Option A** (aggressive port with fake Task tool mapping): Obsoleted -- subagent events exist natively.
- **Option B** (strict 6-event match): Obsoleted -- there are 13 events, not 6.
- **Option C** (adaptive approximation): Obsoleted -- no approximation needed.
- **Option C+** (modified adaptive, v2 recommendation): Obsoleted -- all "approximate" mappings are now exact.

**Why chosen:** Option D is strictly superior -- it delivers everything C+ would have delivered (zero gaps vs 5 gaps), plus novel Copilot-advantage applications. The research proving 13 events eliminated the core constraint that forced approximation in v2.

**Consequences:**
- `OMCP_HOOK_EVENTS` expands from 5 to 13 (more config.json entries, but all trivially auto-managed by `mergeCopilotHooks`).
- `HookResult` expands from 3 to 6 variants (breaking change for any external hook authors -- document in CHANGELOG).
- Phase 4/5 (Copilot-advantage features) are novel code, not ports -- higher implementation risk, needs empirical validation of `modifiedArgs`/`modifiedResult` protocol.

**Follow-ups:**
- Empirical smoke test of `modifiedArgs`/`modifiedResult` protocol in Phase 1 remaining work.
- Document Copilot-advantage features in `docs/architecture/copilot-advantages.md`.
- Upstream feature request to Claude Code for `modifiedArgs`/`modifiedResult` equivalents.
- Re-evaluate when Copilot CLI 1.1.x ships (may add more events or change protocol).
