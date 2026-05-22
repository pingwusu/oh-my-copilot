# Phase 2 deferred hooks — dependency blockers

**Date:** 2026-05-22
**Status:** 3 of 6 Phase 2 hooks blocked on missing omcp subsystems
**Scope:** v3 plan Phase 2 — anti-hallucination core ports

---

## What landed in Phase 2 (this session)

| Hook / Library | Status | Files | Lines |
|---|---|---|---|
| factcheck (library) | ✓ ported | src/lib/factcheck/{index,types,checks,config,sentinel}.ts + 1 test | ~855 src + 299 test |
| sentinel-gate (library) | ✓ ported | src/team/sentinel-gate.ts + 1 test | 191 src + 235 test |
| preemptive-compaction (hook) | dispatched (Batch B in flight) | src/hooks/preemptive-compaction/ | ~378 + tests |

## What deferred and why

### 1. persistent-mode (omc src/hooks/persistent-mode/index.ts, 1255 lines)

**Blockers (per omc's import list at lines 1-51):**

| Imported from omc | Maps to in omcp | Status |
|---|---|---|
| `getClaudeConfigDir` (`utils/paths`) | — (intentionally absent — Claude-only) | drop in port |
| `atomicWriteJsonSync` (`lib/atomic-write`) | `atomicWriteFileSync` (`src/runtime/atomic-write`) | adapt |
| `resolveToWorktreeRoot`, `resolveSessionStatePath`, `getOmcRoot` (`lib/worktree-paths`) | — (omcp doesn't have worktree-paths) | **port required** |
| `readModeState` (`lib/mode-state-io`) | — | **port required** |
| `readUltraworkState`, `writeUltraworkState`, … (`hooks/ultrawork`) | — (omcp has no ultrawork hook) | **port required** |
| `readRalphState`, `writeRalphState`, `incrementRalphIteration`, `clearRalphState`, `getPrdCompletionStatus`, `getRalphContext`, `readVerificationState`, `startVerification`, `recordArchitectFeedback`, `getArchitectVerificationPrompt`, `getArchitectRejectionContinuationPrompt`, `detectArchitectApproval`, `detectArchitectRejection`, `clearVerificationState` (`hooks/ralph`) | — (omcp has no ralph hook directory) | **port required (large)** |
| `checkIncompleteTodos`, `getNextPendingTodo`, `StopContext`, `isUserAbort`, `isContextLimitStop`, `isRateLimitStop`, `isExplicitCancelCommand`, `isAuthenticationError` (`hooks/todo-continuation`) | — (omcp has no todo-continuation hook yet) | **port required** |
| `TODO_CONTINUATION_PROMPT` (`installer/hooks`) | — (omcp installer has different shape) | **port required** |
| `isAutopilotActive`, `checkAutopilot` (`hooks/autopilot`) | — (omcp has no autopilot hook) | **port required** |
| `readTeamPipelineState`, `TeamPipelinePhase` (`hooks/team-pipeline`) | — (omcp has no team-pipeline hook) | **port required** |
| `getActiveAgentSnapshot` (`hooks/subagent-tracker`) | — (omcp has no subagent-tracker yet; queued for Phase 3) | **Phase 3 dep** |
| Transcript-tail scanning + context-percent estimation (lines 313-425) | — (Copilot CLI doesn't expose transcript content) | **rewrite — see "Replacement design" below** |

**Replacement design (Architect iter-3 condition 3 + plan iter-4 Phase 2 note):**

The omcp-side persistent-mode port must:
1. Replace `getClaudeConfigDir()` with reading from `.omcp/state/ralph-state.json` (a new state schema omcp must define).
2. Replace transcript JSON scanning with omcp's own state markers (e.g., write `architectApproved: true` to `.omcp/state/ralph-state.json` when the ralph loop detects an APPROVE verdict; persistent-mode reads that field directly).
3. Replace `getActiveAgentSnapshot` with `.omcp/state/subagent-tracker.jsonl` (Phase 3 deliverable).
4. Replace context-percent estimation with either a heuristic from `PreCompact` event metadata or a Copilot-side API if one exists.
5. Acceptance criterion (per v3 plan Phase 2): "NO references to `~/.claude/` paths remain in the omcp implementation."

**Estimated effort:** ~600-1200 lines of port + ~400 lines of new omcp-native state-management code = MEDIUM-LARGE per Architect.

### 2. todo-continuation (omc src/hooks/todo-continuation/index.ts, 615 lines)

**Blockers:**
- `getOmcRoot` from `lib/worktree-paths` — same blocker as persistent-mode (#1 above).
- `getClaudeConfigDir` from `utils/paths` — drop.
- Likely also depends on omcp's TodoWrite-equivalent state. Copilot CLI has its own todo concept; need to understand the protocol.

**Replacement design:**
- omcp-native variant reads from a `.omcp/state/todos.jsonl` (append-only) or polls Copilot's internal todo API if exposed.
- Returns advise on Stop event when pending todos exist.
- The complex omc detection (isUserAbort / isContextLimitStop / etc.) can be ported piecemeal — each detector is independent.

**Estimated effort:** ~300-500 lines of port + state schema = MEDIUM.

### 3. omc-orchestrator (omc src/hooks/omc-orchestrator/index.ts, 574 lines)

**Blockers:**
- `readBoulderState`, `getPlanProgress` (`features/boulder-state/index.js`) — omcp has no boulder-state feature.
- `addWorkingMemoryEntry`, `setPriorityContext` (`notepad/index.js`) — omcp has notepad MCP tools (notepad_*) but no in-process notepad-state module.
- `logAuditEntry` (`./audit.js`) — would be ported as a sub-module.
- `getWorktreeRoot`, `getOmcRoot`, `toForwardSlash` (`lib/worktree-paths`, `utils/paths`) — same blockers.
- `getClaudeConfigDir` — drop.

**Replacement design:**
- omcp-native variant could be a thinner orchestrator-pattern enforcer that uses omcp's notepad MCP layer + a new `.omcp/state/boulder-state.json` minimal schema.
- Or omcp may want to redesign the orchestrator-enforcement concept entirely for the Copilot CLI dispatch model (which has different agent-delegation semantics than Claude Code Tasks).

**Estimated effort:** ~400-700 lines of port + new state files = MEDIUM.

---

## Recommendation for next session

**Option A — port the missing subsystems first, then the hooks:**
1. Port `lib/worktree-paths` (small, foundational)
2. Define omcp ralph-state schema + writer/reader API at `src/ralph/state.ts`
3. Port `hooks/ralph/*` (the ralph state operations)
4. Define omcp todo-state schema or wire to Copilot's todo API
5. Then port persistent-mode + todo-continuation + omc-orchestrator
6. Estimated: 2-3 full sessions

**Option B — ship minimal omcp-native variants now:**
1. persistent-mode (light): reads `.omcp/state/ralph-state.json` (define minimal schema: `{active: bool, iteration: int, lastFiredAt: ISO, prompt: string}`); returns advise when active. ~150 lines + tests.
2. todo-continuation (light): reads `.omcp/state/todos.jsonl`; returns advise on Stop if pending entries. ~120 lines + tests.
3. omc-orchestrator (light): inline orchestrator-pattern checker without notepad/boulder-state deps. Just verifies the active agent is delegating to subagents rather than directly editing files. ~200 lines + tests.
4. Estimated: 1 follow-up session.
5. Trade-off: thinner than omc, but matches v3 plan's "1:1 direct port spirit, no approximation" — except adaptations are needed for missing omcp subsystems.

**Option C — defer entirely until omc parity is built up:**
Recognize that omcp ↔ omc parity is a multi-month effort. Phase 2 in this v3 plan is "anti-hallucination core" — and we have the factcheck library + sentinel-gate already (the foundation). Defer the 3 hooks to a "Phase 2.5" sub-plan that explicitly catalogs subsystem ports.

## What this session DID accomplish

- Ralplan iter-3→4 closed with consensus (Planner + Architect + Critic all APPROVE)
- Phase 1 foundation complete: OMCP_HOOK_EVENTS 5→13, HookResult 3→6, runtime plumbing, +17 unit tests, build clean, tests 398→415
- Phase 2 Batch A complete: factcheck library + sentinel-gate library, +25 unit tests, tests 415→440
- Phase 2 Batch B in flight: preemptive-compaction (clean port)
- modifiedResult smoke harness written and idempotent (blocked on gh auth login)
- Comprehensive deferred-hooks blocker analysis (this doc)

## Cross-references

- `docs/plans/hooks-parity-v3.md` — the v3 plan
- `docs/architecture/hooks-modifiedresult-verification.md` — smoke test doc skeleton
- HANDOFF.md — session handoff (will be updated at milestone end)
- `.omc/progress.txt` — session-level progress log
