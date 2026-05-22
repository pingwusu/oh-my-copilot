# omcp 续接 handoff (post-v0.9.1 / ralplan-iter-3-in-progress)

**Updated**: 2026-05-22 mid-afternoon
**Repo**: `C:\Users\runjiashi\oh-my-copilot-r2` (the **r2**, not the parallel
`oh-my-copilot/`)
**Latest commit**: `6934357` (v0.9.1 P0 fix). Working tree had 2 uncommitted
files at handoff time (the v3 plan promotion below); see "What to commit
first" below.

---

## TL;DR for the next agent

This session executed 3 milestones across one continuous flow:

1. **DD9 → v0.8.0** (commit `86fb9de`): 4 parallel critics + 4 fixers on
   v0.7.0. Added 15 MCP tools (8 code-intel + python_repl + 5
   shared_memory + session_search), 5 P1 robustness fixes. omc MCP
   tool-surface parity closed.

2. **DD10 → v0.9.0** (commit `67c4073`): 2 critics + 1 fixer
   round on v0.8.0. Added `load_omcp_skills_global` (closes the last
   skills tool family member). Fixed 2 P1 regressions
   (lsp_goto_definition regex injection, searchSessions unreadable-file
   crash). User's original "omcp 复刻 omc + ≥10 iterations" criterion
   **declared satisfied for omc parity**.

3. **Hook-system rabbit hole → v0.9.1 P0 fix** (commit `6934357`):
   User asked to fill the orchestrator/hooks gap and explicitly noted
   "copilot 也有很多 hook ... agentstop 的 hook ... 应该也支持
   orchestrate". A 3-agent research wave (official Copilot docs +
   Claude-side cross-ref + empirical `app.js` `aWr`-Set extraction)
   proved **Copilot CLI has 13 hook events, not 6** — and v0.4.0
   through v0.9.0 had been writing Claude-Code event names
   (`PreSubmit`/`PostSubmit`/`PreEnd`) into `~/.copilot/settings.json`
   that Copilot silently dropped. 3 of 6 omcp-managed hooks had been
   dead in production this whole time. v0.9.1 corrects the
   `OMCP_HOOK_EVENTS` constant, expands `HookEvent` to all 13 valid
   names, ships `COPILOT_VALID_EVENTS` enum + regression test.

A v3 hooks-parity plan was written (ralplan iter-3) and Architect
returned APPROVE-with-3-conditions. **Critic iter-3 was not run before
this handoff** — see "What's mid-flight" below.

---

## What to commit FIRST (next session, before anything else)

The session ended with the v3 plan promoted into `docs/plans/` (tracked
path) but NOT committed:

```
docs/plans/hooks-parity-v3.md            (NEW)
docs/plans/hooks-parity-open-questions.md (NEW)
```

These exist because `.omc/` is in `.gitignore`, so the Planner's v3
plan output would otherwise have died with the session. Commit them as
a docs-only commit before doing any code work:

```bash
git add docs/plans/
git commit -m "docs: promote v3 hooks-parity plan + open questions to tracked path"
```

---

## What's mid-flight (ralplan iter-3 status)

The ralplan consensus loop on the hooks-parity plan is at iteration 3
of max 5:

| Iter | Planner | Architect | Critic |
|---|---|---|---|
| 1 | DRAFT (Option C+ approximation layer) | objected (dead `Task` mapping, missing hooks, timeout) | **ITERATE** (advise unverified, inventory incomplete, library-vs-hook conflation) |
| 2 | REVISED (Step 0 gate, all-31-hooks, library section, pre-mortem) | **APPROVE-with-notes** | **APPROVE** (3 notes folded as polish) |
| (mid-iter)| (user pushed back: "copilot 也有 hook") | — | — |
| (research wave) | 3 parallel agents confirmed user right: 13 events not 6 | — | — |
| 3 | REWRITTEN as Option D (1:1 direct port + Copilot-advantage exploitation, HookResult 3→6 variants, 6 phases) | **APPROVE-with-3-conditions** | **NOT YET RUN** |

**To finish ralplan**: next session should dispatch Critic iter-3 with
the Architect's iter-3 report as input. If Critic APPROVE → start
Phase 1. If ITERATE → Planner iter-4.

### Architect iter-3 conditions (must fold into v3 plan or address before execution)

1. **Phase 1 must include a `modifiedResult` smoke test as a hard gate.**
   v3 assumes Copilot's `modifiedResult` field REPLACES tool output in
   the model's context (distinct from `additionalContext` which APPENDS).
   This replacement semantics is undocumented and not yet verified.
   If smoke test fails, Phases 4-5 must revert to v2-style advise-only
   fallback.

2. **Surgeon mode (`modifiedArgs` + `modifiedResult` middleware) → Phase 7+ future work**, not v1. Both behaviors need empirical
   validation. Hallucination-shield (`modifiedResult` alone) and
   interrupt-only cost governor are realistic v1; arg-rewriting cost
   optimizer is speculative.

3. **`persistent-mode` reclassify from SIMPLE → MEDIUM.** omc's
   `persistent-mode/index.ts` has Claude-specific dependencies:
   `getClaudeConfigDir()` (lines 16/378/404) reads `~/.claude/`; lines
   313-425 scan Claude transcript JSON for context-percent estimation
   and architect approval detection. Copilot does not expose
   transcript content in the same format — this code path needs
   rewriting against omcp's own state files.

---

## v3 plan summary (read `docs/plans/hooks-parity-v3.md` for full)

**Recommended option**: **D — direct 1:1 native port + Copilot-advantage
exploitation**. Supersedes v2's "Option C+ approximation layer", which was
predicated on the false 6-event assumption.

**13 valid Copilot events** (both camelCase + PascalCase aliases work,
except `subagentStart` is camelCase-only):

| Internal key | PascalCase alias | Maps to Claude event |
|---|---|---|
| sessionStart | SessionStart | SessionStart |
| sessionEnd | SessionEnd | SessionEnd |
| userPromptSubmitted | UserPromptSubmit | UserPromptSubmit |
| preToolUse | PreToolUse | PreToolUse |
| postToolUse | PostToolUse | PostToolUse |
| postToolUseFailure | PostToolUseFailure | PostToolUseFailure |
| errorOccurred | ErrorOccurred | **(Copilot-only)** |
| agentStop | **Stop** (no "AgentStop") | Stop |
| subagentStop | SubagentStop | SubagentStop |
| subagentStart | **(no PascalCase alias!)** | SubagentStart |
| preCompact | PreCompact | PreCompact |
| permissionRequest | PermissionRequest | PermissionRequest |
| notification | Notification | **(Copilot-only)** |

**Copilot has 3 capabilities Claude lacks (USER-PRIORITIZED)**:

- `preToolUse.modifiedArgs` — rewrite tool arguments before execution
- `postToolUse.modifiedResult` — **rewrite tool output BEFORE the model sees it** (★ most powerful — enables proactive hallucination shield)
- `permissionRequest.interrupt: true` — hard-stop the agent

**6-phase execution plan**:

| Phase | Scope | Status |
|---|---|---|
| 1 | P0 cleanup + foundation + modifiedResult smoke test | P0 part DONE (v0.9.1). Smoke test PENDING. |
| 2 | Anti-hallucination core ports (persistent-mode, factcheck, sentinel-gate, todo-continuation, omc-orchestrator) — 1:1 direct mapping | PENDING |
| 3 | Subagent lifecycle (subagentStart/Stop direct port — NO LONGER DEFERRED) + verify-deliverables | PENDING |
| 4 | Hallucination shield (modifiedResult-based pre-rewrite of suspicious tool outputs) | GATED on Phase 1 smoke test |
| 5 | Cost governor (interrupt-only v1; modifiedArgs-downgrade speculatively Phase 7+) + audit middleware | PENDING |
| 6 | Telemetry / status integration (errorOccurred / notification ports + HUD wiring) | PENDING |

**HookResult union expansion** (`src/hooks/hook-types.ts:39-42`): 3
variants → 6:
```typescript
type HookResult =
  | { kind: "noop" }
  | { kind: "advise"; text: string }
  | { kind: "block"; reason: string }
  | { kind: "modifiedArgs"; args: unknown }       // NEW
  | { kind: "modifiedResult"; result: unknown }   // NEW
  | { kind: "interrupt"; reason: string };        // NEW
```

Architect verified this is a safe TypeScript-discriminated-union
expansion (no exhaustive matching anywhere in the codebase that would
break). `src/hooks/runtime.ts:444-449` result-handling needs to add
the 3 new branches (currently it would silently drop them).

---

## What this session did (full audit trail)

**v0.7.0 → v0.8.0 (DD9, commit `86fb9de`)**:
- Added 15 MCP tools: 8 code-intel additions (`lsp_goto_definition`,
  `lsp_prepare_rename`, `lsp_rename`, `lsp_code_actions`,
  `lsp_code_action_resolve`, `deepinit_manifest`,
  `load_omcp_skills_local`, `list_omcp_skills`); python_repl;
  5 shared_memory_*; session_search.
- Fixed 5 P1: loadTrace JSON.parse, loadProjectMemory JSON.parse,
  loop-server atomic-write canonicalization, server-runtime schema
  validation, loop-watcher execSync→spawnSync.
- Tests: 349 → 389 (+40). 57/58 files green.

**v0.8.0 → v0.9.0 (DD10, commit `67c4073`)**:
- Added `load_omcp_skills_global` (closes omc skills tool family).
- Fixed 2 P1: lsp_goto_definition regex escape (Critic-B finding);
  searchSessions unreadable-file resilience.
- Fixed 1 P1: 3rd + 4th version manifests missed in v0.8.0 bump.
- Tests: 389 → 393 (+4). 58/59 files green.

**v0.9.0 → v0.9.1 (P0 hook event names, commit `6934357`)**:
- `OMCP_HOOK_EVENTS` corrected: `PreSubmit`→`UserPromptSubmit`,
  `PreEnd`→`SessionEnd`, `PostSubmit` dropped (no Copilot equivalent).
- `HookEvent` union expanded from 6 (3 invalid) to 13 valid Copilot
  events.
- `COPILOT_VALID_EVENTS` const + 5-test regression suite.
- `src/hooks/runtime.ts` 3 internal event lists synchronized.
- `docs/architecture/hooks-wiring.md` inline event list corrected.
- Tests: 393 → 398 (+5). 59/60 files green.
- Existing installations: `mergeCopilotHooks` strips stale
  `__omcp:true` entries on next `omcp setup` re-run — auto-migrate.

---

## Critical invariants (don't violate these)

1. **Any new file-name sink** uses `assertSafeSlug` from `src/runtime/safe-slug.ts`.
2. **Any state JSON write** uses `atomicWriteFileSync` (no bare `writeFileSync`).
3. **Any new `src/cli/commands/*.ts`** is registered in `src/cli/omcp.ts` (`cli-wiring-invariants` test enforces).
4. **Any new detached subprocess** writes a pidfile to `.omcp/state/<scope>/<name>.pid` + has a stop verb.
5. **Commit message factual claims** are verified by `git diff` — main agent has been caught lying ≥2 times.
6. **Version bump synchronizes 4 manifests**: `package.json`,
   `.agents/plugins/marketplace.json`, `.claude-plugin/plugin.json`,
   `plugins/oh-my-copilot/.claude-plugin/plugin.json`. The
   `cli-wiring-invariants` test enforces (catches drift, learned this
   v0.7→v0.8 cycle).
7. **User-supplied strings entering `new RegExp(...)`** are escaped via
   `value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")`. Pattern used in
   `handleLspRename` + `handleLspGotoDefinition`.
8. **Hook event names** MUST be in `COPILOT_VALID_EVENTS` (`src/runtime/copilot-config.ts`). Claude-Code-style names
   (`PreSubmit`/`PostSubmit`/`PreEnd`) are silently dropped by Copilot
   CLI — see v0.9.1 P0 root cause. Regression test:
   `src/__tests__/copilot-hook-events-validation.test.ts`.
9. **`subagentStart` is camelCase-ONLY** — no `SubagentStart` alias
   in Copilot's `s2t` map. Any subscriber must use camelCase. This
   trips the same silent-drop failure mode as #8.

---

## Critical user emphasis (carry forward)

User has stated these priorities multiple times across the session —
v3 plan and execution must serve them:

- "着重要点 ralph ralplan 以及 team 这些可以长时间运行并且多角色 agent，
  用于防止 llm 自视甚高以及幻觉，还有可以 long running"
- "针对核心功能的缺乏，补齐，采用 team 和 critic 模式"
- "注意把 PreToolUse 这几个 Copilot 比 Claude 有优势的地方融入 plan 中去，
  看看有没有额外更多的应用"

= Long-running multi-role anti-hallucination is THE goal. Hooks
subsystem is the load-bearing component. Exploit Copilot-only
capabilities (modifiedArgs/modifiedResult/interrupt) for novel
applications, not just parity.

---

## What the next session should do — ordered

1. **Read** this HANDOFF.md + `docs/plans/hooks-parity-v3.md` +
   `docs/plans/hooks-parity-open-questions.md`.

2. **`git status` + `git log -3`** to verify state matches this
   handoff. **Do NOT trust the handoff blindly** — main agent has been
   caught lying in past sessions.

3. **Commit** `docs/plans/hooks-parity-v3.md` +
   `docs/plans/hooks-parity-open-questions.md` (if still uncommitted).

4. **Dispatch Critic iter-3** on the v3 plan. Use the Architect's
   iter-3 APPROVE-with-3-conditions report as input (it's not saved
   to disk — the next session may need to re-derive or accept the
   conditions as-is). If Critic verdict is APPROVE → proceed to step 5.
   If ITERATE → Planner iter-4 with Critic feedback.

5. **Start Phase 1** of v3 plan: `modifiedResult` smoke test. Wire a
   probe hook that emits a known-format `{kind: "modifiedResult"}`
   stdout for a benign tool call (e.g., Read of a tiny file), invoke
   Copilot CLI 1.0.48 (already installed at
   `/c/.tools/.npm-global/copilot`), check whether the model sees the
   rewritten output or the original. Document PASS/FAIL determination
   in `docs/architecture/hooks-modifiedresult-verification.md`. This
   is the HARD GATE for Phases 4-5.

6. **Phase 2 onward** depends on Phase 1 outcome.

---

## Working environment quick-ref

- **Build**: `npm run build` (clean before this session; tsc only)
- **Tests**: `npm test`. Currently 59/60 files green, 398 passing, 2
  skipped, 0 failed. 1 pre-existing Win vitest worker-fork EPERM
  baseline since v0.4.0 — unchanged.
- **CHANGELOG**: append to top of `CHANGELOG.md` (Keep-a-Changelog
  format).
- **Commit trailers**: project uses omc-style trailers
  (Constraint/Rejected/Confidence/Scope-risk/Directive/Not-tested). See
  v0.8.0/v0.9.0/v0.9.1 commits for examples.

- **omc reference**: `C:\Users\runjiashi\.claude\plugins\cache\omc\oh-my-claudecode\4.9.3\` (read-only)
- **omx reference**: `C:\Users\runjiashi\_refs\oh-my-codex\` (read-only)
- **Copilot CLI binary**: `/c/.tools/.npm-global/copilot` (v1.0.48)
- **Copilot CLI bundle (for grep)**: `/c/.tools/.npm-global/node_modules/@github/copilot/app.js`

---

## Open omx work (NOT scope of this session's `/goal`)

User's session `/goal` was "omcp 复刻 omc" — explicitly omc, not omx.
omx parity still has ~22 missing skills (analyze, code-review,
security-review, tdd, deepsearch, design, frontend-ui-ux, git-master,
pipeline, swarm, web-clone, etc.) and 5 missing CLI verbs (sidecar,
agents, deepinit, performance-goal, autoresearch-goal). Future work
when user reprioritizes.
