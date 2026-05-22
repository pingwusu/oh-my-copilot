# omcp 续接 handoff (post-v0.10.0)

**Updated**: 2026-05-22 late-afternoon
**Repo**: `C:\Users\runjiashi\oh-my-copilot-r2` (the **r2**, not the parallel `oh-my-copilot/`)
**Latest commit**: `(commit hash filled at milestone commit)` v0.10.0 release

---

## TL;DR for the next agent

This session executed the **ralplan iter-3 → iter-4 consensus loop** to APPROVE/APPROVE/APPROVE,
then shipped Phase 1 + Phase 2 (partial) of the v3 hooks-parity plan as **v0.10.0**.

| Phase | Status | Deliverable | Commit |
|---|---|---|---|
| v3 plan iter-4 | ✓ committed | Architect 3 conditions + Critic 5 edits + 3 cosmetic polish items folded into `docs/plans/hooks-parity-v3.md` | dae5016 |
| Phase 1 foundation | ✓ committed | OMCP_HOOK_EVENTS 5→13, HookResult 3→6, runtime plumbing, +17 tests | 4fb8cd1 |
| Phase 2 Batch A | ✓ committed | factcheck library + sentinel-gate library + tests (+25) | 7b00ada |
| Phase 2 Batch B | ✓ committed | preemptive-compaction hook + tests (+20) | b7a423b |
| Phase 1 smoke verdict | ✓ committed | FAIL (with caveat — hooks don't fire in `-p` mode); harness + verdict doc | 6a2606e |
| v0.10.0 release | ✓ committed | version bump 4 manifests + CHANGELOG | (this commit) |
| Phase 2 Batch C | **DEFERRED** | persistent-mode + todo-continuation + omc-orchestrator — depend on unported omcp subsystems | — |
| Phase 3 | **PENDING** | subagent lifecycle + session hooks (20 shell hooks) | — |
| Phase 4 | **DOWNGRADED** | hallucination-shield → advise-only per Architect condition 1 (smoke FAIL) | — |
| Phase 5 | **PENDING** | interrupt-only cost governor + loop detector + audit logger | — |
| Phase 6 | **PENDING** | error-aggregator + auto-recovery-advisor + Notification dispatch | — |
| Phase 7 | **GATED** | modifiedArgs surgeon mode — needs own empirical gate in interactive mode | — |

---

## Critical empirical finding (Phase 1 smoke verdict)

**Copilot CLI 1.0.48 in `copilot -p` non-interactive mode does NOT fire ANY hooks** — verified across
6 event-name variants (`postToolUse` + `PostToolUse` + `preToolUse` + `PreToolUse` + `userPromptSubmitted` +
`UserPromptSubmit`) × 2 probe shapes (Node `.mjs` and stripped-down `.cmd`) × valid matcher `"*"`. The probe
log file (`~/.copilot/omcp-smoke-probe.log`) never appeared on any run.

The bundle (`@github/copilot/app.js`) does contain hook-execution machinery (`HookCommandWarningError`,
`HookExitCodeError`, `postToolUseFailure` integration). So hooks ARE implemented — they just don't fire in
`-p` mode, at least not as-configured via the matcher-style hooks section.

**Implications for the next session:**

1. omcp's hook infrastructure may be **interactive-mode-only**. If the user runs `copilot -p "..."` for
   scripting workflows, omcp's hook-based features (skill injection, persistent-mode, etc.) won't fire.
2. The omcp regression test `copilot-hook-events-validation.test.ts` verifies event NAMES are valid but
   never verifies hooks actually FIRE end-to-end. A real integration test would need to run a Copilot TUI
   session which is difficult to script.
3. **Recommended next step:** manually launch `copilot` (TUI), pre-wire the probe at `~/.copilot/config.json`
   `hooks.postToolUse`, send a prompt that uses a real tool, then check `~/.copilot/omcp-smoke-probe.log`.
   If it has entries → hooks DO fire in interactive mode, and the next test is whether `modifiedResult`
   replaces or appends.
4. Per Architect iter-3 condition 1 (FAIL branch): **Phase 4 hallucination-shield ships as advise-only fallback**.
   This is forward-compatible — a future PASS verdict in interactive mode could upgrade Phase 4 to true
   replacement semantics.

Full verdict + reproduction steps at `docs/architecture/hooks-modifiedresult-verification.md`.

---

## Phase 2 deferred-hooks scope (next session decision point)

The 3 Phase 2 hooks (`persistent-mode`, `todo-continuation`, `omc-orchestrator`) depend on **6+ omc-internal
subsystems** that omcp does not have:

- `lib/worktree-paths` — needed by all 3
- `lib/mode-state-io` — needed by persistent-mode
- `hooks/ralph/*` — 15+ exported functions (persistent-mode imports the entire ralph state API)
- `hooks/ultrawork/*` — needed by persistent-mode
- `hooks/autopilot/*` — needed by persistent-mode
- `hooks/team-pipeline/*` — needed by persistent-mode
- `hooks/subagent-tracker/*` — needed by persistent-mode + Phase 3
- `features/boulder-state/*` — needed by omc-orchestrator
- `notepad in-process state` — needed by omc-orchestrator (omcp has notepad MCP tools but no in-process module)

**Three port-strategy options for next session** (full analysis in `docs/plans/phase-2-deferred-hooks.md`):

**Option A:** port the missing subsystems first (worktree-paths → ralph state schema → ultrawork → …),
then port the 3 hooks. ~2-3 sessions.

**Option B:** ship thin omcp-native variants now (persistent-mode reads a minimal ralph-state.json;
todo-continuation reads a minimal todos.jsonl; omc-orchestrator inline-enforces delegation patterns).
~1 follow-up session. Thinner than omc but matches v3 plan "no approximation" spirit modulo missing
subsystems.

**Option C:** defer the 3 hooks entirely until omcp ↔ omc subsystem parity is built up.

User should pick the direction before next session starts coding.

---

## What this session DID accomplish (full audit trail)

### Ralplan iter-3 → iter-4 closure (consensus loop)

1. Critic iter-3 review of v3 plan → **ITERATE** verdict (5 edits required: 3 Architect conditions not folded into plan text + 2 minor)
2. Planner iter-4 applied 5 surgical edits to docs/plans/hooks-parity-v3.md
3. Architect iter-4 review → **APPROVE** (clean) with 3 cosmetic notes
4. Planner applied 3 cosmetic polish items (ADR Follow-ups, Pre-mortem Scenario 1, ADR Consequences)
5. Critic iter-4 → **APPROVE**
6. Plan iter-4 committed as `dae5016`

### Phase 1 — foundation work

- `OMCP_HOOK_EVENTS` expanded from 5 to all 13 valid Copilot events (`src/runtime/copilot-config.ts`)
- `HookResult` union expanded from 3 to 6 variants (`src/hooks/hook-types.ts`)
- `runFireCli` synthesizes Copilot stdout protocol fields (`additionalContext`, `modifiedArgs`,
  `modifiedResult`, `interrupt`, `reason`) with last-wins semantics (`src/hooks/runtime.ts`)
- Tests +22 cases (17 + 5)
- Commit: `4fb8cd1`

### Phase 1 — smoke verdict (HARD GATE)

- Smoke harness written (`scripts/smoke/{probe-modifiedresult.mjs, probe-simple.cmd, canary-original.txt, run-modifiedresult-smoke.mjs}`)
- 3 diagnostic re-runs (Node probe, .cmd probe, 6 event-name variants)
- Verdict: **FAIL** (with caveat — hooks didn't fire at all in `-p` mode)
- Doc: `docs/architecture/hooks-modifiedresult-verification.md`
- Commit: `6a2606e`

### Phase 2 — Batches A + B

**Batch A — library modules** (commit `7b00ada`):
- `src/lib/factcheck/{index,types,checks,config,sentinel}.ts` (~855 lines source + 299 tests)
- `src/team/sentinel-gate.ts` (~191 lines + 235 tests)

**Batch B — preemptive-compaction hook** (commit `b7a423b`):
- `src/hooks/preemptive-compaction/{index,constants,types}.ts` (~390 lines + 468 tests)
- Subscribes to PostToolUse + PreCompact dual trigger
- State persisted under `.omcp/state/preemptive-compaction/{sessionId}.json` via `atomicWriteFileSync`
- Session-id slug guarded by `assertSafeSlug`

**Batch C — deferred** (`docs/plans/phase-2-deferred-hooks.md`):
- persistent-mode, todo-continuation, omc-orchestrator all blocked on unported omcp subsystems

### v0.10.0 release

- All 4 manifests bumped to v0.10.0 (per invariant 6):
  - `package.json`
  - `.agents/plugins/marketplace.json`
  - `.claude-plugin/plugin.json`
  - `plugins/oh-my-copilot/.claude-plugin/plugin.json`
- `CHANGELOG.md` v0.10.0 entry added (Keep-a-Changelog format)
- Tests: 398 (session start) → 460 passing (+62 net), 2 skipped, 0 failed

---

## Critical invariants (don't violate these)

(Unchanged from prior handoff — repeated here for next-agent convenience.)

1. **Any new file-name sink** uses `assertSafeSlug` from `src/runtime/safe-slug.ts`.
2. **Any state JSON write** uses `atomicWriteFileSync` (no bare `writeFileSync`).
3. **Any new `src/cli/commands/*.ts`** is registered in `src/cli/omcp.ts` (`cli-wiring-invariants` test enforces).
4. **Any new detached subprocess** writes a pidfile to `.omcp/state/<scope>/<name>.pid` + has a stop verb.
5. **Commit message factual claims** are verified by `git diff` — main agent has been caught lying ≥2 times.
6. **Version bump synchronizes 4 manifests**: `package.json`, `.agents/plugins/marketplace.json`,
   `.claude-plugin/plugin.json`, `plugins/oh-my-copilot/.claude-plugin/plugin.json`.
7. **User-supplied strings entering `new RegExp(...)`** are escaped via
   `value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")`.
8. **Hook event names** MUST be in `COPILOT_VALID_EVENTS`. Claude-Code-style names
   (`PreSubmit`/`PostSubmit`/`PreEnd`) are silently dropped by Copilot CLI (this is the
   v0.9.1 P0 root cause).
9. **`subagentStart` is camelCase-ONLY** — no `SubagentStart` alias in Copilot's `s2t` map.

---

## Critical user emphasis (carry forward)

- "着重要点 ralph ralplan 以及 team 这些可以长时间运行并且多角色 agent，
  用于防止 llm 自视甚高以及幻觉，还有可以 long running"
- "针对核心功能的缺乏，补齐，采用 team 和 critic 模式"
- "注意把 PreToolUse 这几个 Copilot 比 Claude 有优势的地方融入 plan 中去，
  看看有没有额外更多的应用"

= Long-running multi-role anti-hallucination is THE goal. Hooks subsystem is the load-bearing component.
The Phase 1 smoke verdict surfaced an unexpected blocker (no hooks in `-p` mode); the next session should
either confirm interactive-mode hooks work, or design alternative anti-hallucination mechanisms that don't
depend on `-p`-mode hook firing.

---

## What the next session should do — ordered

1. **Read** this HANDOFF.md + `docs/plans/hooks-parity-v3.md` (the iter-4 final plan) +
   `docs/plans/phase-2-deferred-hooks.md` + `docs/architecture/hooks-modifiedresult-verification.md`.

2. **`git status` + `git log -5`** to verify state matches this handoff. **Do NOT trust the handoff blindly.**

3. **Critical empirical question:** Manually launch `copilot` in interactive TUI mode and run the smoke probe.
   If hooks fire there but not in `-p`, that's a major scope clarification — omcp's hook subsystem is
   interactive-only. If hooks ALSO don't fire in TUI mode, that's a deeper bug — omcp needs to either fix the
   wiring or redesign the anti-hallucination architecture entirely.

4. **Phase 2 Batch C decision** — pick option A (port subsystems first), B (thin omcp-native variants), or
   C (defer entirely) from `docs/plans/phase-2-deferred-hooks.md`. The user's emphasis on anti-hallucination
   suggests Option A or B, not C.

5. **Phase 3 — 20 shell hooks** (subagent lifecycle + session hooks). Largely 1:1 ports from omc; some
   (subagent-tracker) need omcp's own state schema first.

6. **Phase 5 — interrupt-only cost governor + loop detector + audit logger.** Does not depend on
   `modifiedArgs`/`modifiedResult`; should ship cleanly regardless of smoke verdict.

7. **Phase 6 — error-aggregator + Notification dispatch.** Wire to existing `src/hooks/background-notifications.ts`.

8. **Phase 4 — hallucination shield (advise-only fallback per smoke FAIL).** Lower priority — ships only annotations,
   no replacement.

9. **Phase 7 — modifiedArgs surgeon mode.** Needs its own empirical gate (in interactive mode) before any
   work begins.

---

## Working environment quick-ref

- **Build**: `npm run build` (clean before this session; tsc only)
- **Tests**: `npm test`. Currently 460 passing, 2 skipped, 0 failed. 1 pre-existing Win vitest worker-fork
  EPERM baseline since v0.4.0 — unchanged.
- **CHANGELOG**: prepend to `CHANGELOG.md` (Keep-a-Changelog format).
- **Commit trailers**: project uses omc-style trailers (Constraint/Rejected/Confidence/Scope-risk/Directive/Not-tested).
- **omc reference**: `C:\Users\runjiashi\.claude\plugins\cache\omc\oh-my-claudecode\4.9.3\` (read-only)
- **omx reference**: `C:\Users\runjiashi\_refs\oh-my-codex\` (read-only)
- **Copilot CLI binary**: `/c/.tools/.npm-global/copilot.cmd` (v1.0.48)
- **Copilot CLI bundle (for grep)**: `/c/.tools/.npm-global/node_modules/@github/copilot/app.js`
- **GH auth**: user provided `<REDACTED-TOKEN>` mid-session (OAuth token).
  Do NOT commit it. For follow-up smoke tests use `export GH_TOKEN="..." && export COPILOT_GITHUB_TOKEN="$GH_TOKEN"`.

---

## Open omx work (NOT scope of this session's `/goal`)

User's session `/goal` was "omcp 复刻 omc" — explicitly omc, not omx. omx parity still has many missing
skills and CLI verbs. Future work when user reprioritizes.
