# Next-Session Plan (ralplan, 2026-05-23)

**Status:** Consensus APPROVED — Planner iter-2 → Architect iter-1 ITERATE (3 required edits folded in) → Critic iter-1 APPROVE. Ready for executor handoff.
**Context root:** `C:\Users\runjiashi\oh-my-copilot-r2`, HEAD `e014e35`, working tree clean.
**Baseline:** v0.11.0, tests 699 passing / 0 failed / 2 skipped / 1 Windows worker-fork EPERM pre-existing.

---

## RALPLAN-DR Summary

### Principles (5)

1. **Verify reality before trusting HANDOFF** — `git log` + grep before acting on documented claims (main agent has lied in HANDOFFs before; user explicitly warned).
2. **Cheap probe before expensive commit** — answer the gating question ("hook bug fixed?") in <15 min before allocating the rest of the session.
3. **Diversify when one path is blocked-upstream** — every session must ship value regardless of upstream verdict.
4. **Respect invariants at every step** — `assertSafeSlug`, `atomicWriteFileSync`, manifest sync (4 files), `COPILOT_VALID_EVENTS`, no tokens in tracked files, regex escape, pidfile+stop verb for detached children.
5. **One unit of work = one commit + its own tests** — no batched commits, no skipped tests to make a number green.

### Decision Drivers (top 3)

1. **Is Copilot CLI 1.0.51 hook executor still broken on the user's machine?** (binary; determines whether N+2 is unblocked).
2. **What ships measurable user-facing value this session?** (vs. dead code that crashes on every fire).
3. **What's the minimum scope that does not put the 699-passing baseline at risk?**

### Viable Options (≥2, with rejection rationale for the rest)

| ID | Option | Pros | Cons |
|----|--------|------|------|
| A | **N+2 hook ports first (assume unblocked)** — port `persistent-mode`, `todo-continuation`, `omc-orchestrator` directly, bump v0.12.0. | Highest plan-priority work; consumes N+1 subsystems exactly as intended. | Single-bet on upstream fix; if probe fails, 3 hooks ship as dead code (compile fine, crash on every fire). |
| B | **CLI verbs first (assume still blocked)** — build `omcp ralph / ultrawork / todo / boulder` verbs on top of N+1 libs, bump v0.12.0. | Ships value regardless of hook state; reuses every N+1 subsystem; user-callable surface. | Doesn't resolve N+2 question; postpones the upstream re-verdict another session. |
| **C** | **Probe-then-fork (RECOMMENDED)** — 15-min probe answers the gating question, then branch: A if fixed, B if not. | Resolves the open question definitively; either branch ships v0.12.0; bounded probe cost. | Slight session-time variance based on which branch fires. |
| D | Docs cleanup only (omx parity, HANDOFF tidy) — *rejected*. | Low risk, easy commits. | Too little value for a full session; doesn't move open questions. |
| E | MCP tool wrappers instead of CLI verbs in Branch B — *rejected*. | Programmatic surface for agents. | CLI verbs strictly more useful for shell workflows AND can layer MCP later on the same lib code; choosing CLI does not foreclose MCP. |

### Recommendation: **Option C (probe-then-fork)**

Probe is so cheap relative to the session budget that not running it is the irrational move. Both fork branches consume the N+1 lib work fully; neither is "wasted." Critically: regardless of probe outcome, v0.12.0 ships and the open question gets a new datapoint.

---

## Execution Plan

### Step 0 — Ground in reality (≤5 min)

- `cd /c/Users/runjiashi/oh-my-copilot-r2`
- `git log -5 --oneline` — verify HEAD is `e014e35`
- `git status` — verify clean
- `npm test --silent` in background — confirm 699-passing baseline before any change

**Gate:** if HEAD ≠ e014e35 or tree dirty → STOP and reconcile with user before proceeding.

### Step 1 — Version check first, probe only if Copilot was upgraded (≤2 min if 1.0.51, ≤15 min if newer)

**1a. Cheap version check (always run first):**

```
copilot --version
```

- If output is **`copilot 1.0.51`** (the known-broken version per `HANDOFF.md:85`) → **skip the probe entirely**, declare Verdict B, proceed to Branch B. The upstream `SyntaxError: Unexpected token ':'` bug at `HANDOFF.md:92-98` is *in Copilot's hook executor code path* and cannot self-heal between sessions without a user-driven upgrade. Running the probe against the known-broken binary is ritual, not information.
- If output is **a version newer than 1.0.51** (Copilot CLI 1.0.52+) → the upstream might be fixed; proceed to step 1b.

**1b. Probe (only if version > 1.0.51):**

```
node scripts/smoke/wire-probe-for-tui.mjs wire
# USER ACTION: open Copilot TUI, send a prompt that triggers any tool use, /quit
node scripts/smoke/wire-probe-for-tui.mjs check
node scripts/smoke/wire-probe-for-tui.mjs unwire   # MUST run — otherwise settings.json keeps stale hooks (18 errors/session)
```

Read `~/.copilot/omcp-debug-probe.log`:

- **Contains `"phase":"start"` entries written in the last 10 min → Verdict A (hooks fire on user's current Copilot CLI).** Proceed to Branch A.
- **No new entries, or only stale entries → Verdict B (still broken).** Proceed to Branch B.

**Invariant:** the `unwire` step is mandatory. Skipping it leaves the user's TUI emitting 18 stale `HookExitCodeError` lines per session (incident at `HANDOFF.md:158-165`).

### Branch A — N+2 hook ports (3 commits + release + handoff)

| # | Commit | Scope | Tests |
|---|--------|-------|-------|
| A1 | `feat(hooks): port persistent-mode from omc` | `src/hooks/persistent-mode.ts`. Stop event. Reads `ralph-state` / `ultrawork-state` / `todo-state` / `boulder-state` from N+1 libs. Uses `assertSafeSlug` for path input, `atomicWriteFileSync` for any state write. | Mirror omc's `persistent-mode.test.ts` cases; expect ≥15 new tests. |
| A2 | `feat(hooks): port todo-continuation from omc` | `src/hooks/todo-continuation.ts`. Stop event. Reads `todo-state`, returns advise when pending tasks remain. | ≥10 tests covering empty/pending/completed paths. |
| A3 | `feat(hooks): port omc-orchestrator from omc` | `src/hooks/omc-orchestrator.ts`. PreToolUse + PostToolUse. Reads `notepad-state` + `boulder-state`. Enforces delegation patterns. | ≥15 tests. |
| A4 | `chore(release): v0.12.0` | Bump **all 4 manifests** (`package.json` + `.agents/plugins/marketplace.json` + `.claude-plugin/plugin.json` + `plugins/oh-my-copilot/.claude-plugin/plugin.json`) + prepend `CHANGELOG.md`. | None — release commit. |
| A5 | `docs(handoff): post-N+2 status` | Update HANDOFF with: hook bug resolved on Copilot CLI version X, N+2 landed, Phase 3 / Phase 4 next decision points. | None. |

**Acceptance criteria for Branch A:**

- `npm test` → 699 → ~739+ passing, 0 failed.
- `npm run build` → tsc clean.
- `grep -r "~/.claude" src/hooks/persistent-mode.ts src/hooks/todo-continuation.ts src/hooks/omc-orchestrator.ts` returns 0 matches (HANDOFF acceptance criterion).
- All 3 hook event names registered in `COPILOT_VALID_EVENTS`.
- `subagentStart` references use camelCase only.
- Architect verification of each hook port (separately or batched at end — orchestrator's call).

### Branch B — CLI verbs (5 commits + release + handoff)

**Naming decision (resolves Commander routing collision):** the four state-inspection verbs nest under the **existing** `omcp state` command rather than as new top-level verbs. Top-level `omcp ralph` and `omcp ultrawork` are already registered as mode-launchers via `MODE_COMMANDS` at `src/cli/omcp.ts:64-85` and dispatched through `src/cli/omcp.ts:251-281`; adding new top-level `ralph` / `ultrawork` commands would crash Commander at parse time. Nesting under `omcp state` also matches the generic-CRUD pattern at `src/cli/commands/state.ts` and avoids polluting the top-level command surface.

**Implementation note (existing `state` command shape):** `omcp state` is currently registered as a single Commander command with positional `<action> [args...]` and a switch-cased `.action()` (`src/cli/omcp.ts:410-413`). Branch B extends that switch with four new action cases — `"ralph"`, `"ultrawork"`, `"todo"`, `"boulder"` — each dispatching to its own handler in a new `src/cli/commands/state-<name>.ts` file. The handler treats `args[0]` as the sub-subcommand (`status` / `start` / `iterate` / `clear` / etc.) and `args.slice(1)` as its arguments. This avoids a larger refactor of the `state` command to true Commander subcommands while still delivering all four typed surfaces. If a future session wants proper `--help` output for the nested verbs, a separate refactor step can convert `state` to use `.command(...)` chaining.

| # | Commit | Scope | Tests |
|---|--------|-------|-------|
| B0 | `feat(runtime): add escapeRegExp utility` | New file `src/runtime/escape-regexp.ts` exporting `escapeRegExp(input: string): string` that escapes `.*+?^${}()|[]\` per MDN spec. Standalone runtime helper, parallel to `safe-slug.ts` / `atomic-write.ts`. | ≥4 unit tests at `src/runtime/__tests__/escape-regexp.test.ts` covering: plain strings (no-op), each metachar class, mixed input, empty string. |
| B1 | `feat(cli): omcp state ralph action` | New file `src/cli/commands/state-ralph.ts` exporting `runStateRalph(args: string[]): number`. Add a new `case "ralph":` to the switch in `src/cli/omcp.ts:413` that calls `runStateRalph(args)`. Sub-subcommands parsed from `args[0]`: `status / start <task> / iterate / clear`. Calls `readRalphState` / `writeRalphState` / `incrementRalphIteration` / `clearRalphState` from `src/lib/ralph-state.ts`. Path inputs through `assertSafeSlug`. | ≥8 tests covering each sub-subcommand + error paths (missing state, malformed JSON). |
| B2 | `feat(cli): omcp state ultrawork action` | `src/cli/commands/state-ultrawork.ts` with `runStateUltrawork(args: string[]): number`. New `case "ultrawork":` in the switch. Sub-subcommands: `status / start / clear`. Calls `src/lib/ultrawork-state.ts`. | ≥6 tests. |
| B3 | `feat(cli): omcp state todo action` | `src/cli/commands/state-todo.ts` with `runStateTodo(args: string[]): number`. New `case "todo":` in the switch. Sub-subcommands: `add <title> / update <id> <status> / list [--filter <pattern>] / clear`. Calls `src/lib/todo-state.ts`. The `--filter <pattern>` value passes through `escapeRegExp` from B0 before any `new RegExp(...)` call. | ≥10 tests covering add/update/list/clear + a regex-escape test that proves a `.` in a `--filter` value is matched literally not as a wildcard. |
| B4 | `feat(cli): omcp state boulder action` | `src/cli/commands/state-boulder.ts` with `runStateBoulder(args: string[]): number`. New `case "boulder":` in the switch. Sub-subcommands: `status / list-plans / clear` (mirrors `readBoulderState` + `findPlans` + `getPlanSummaries` + `clearBoulderState` from `src/lib/boulder-state.ts`). | ≥6 tests. |
| B5 | `chore(release): v0.12.0` | Bump all 4 manifests (`package.json` + `.agents/plugins/marketplace.json` + `.claude-plugin/plugin.json` + `plugins/oh-my-copilot/.claude-plugin/plugin.json`) + prepend `CHANGELOG.md` describing the new sub-subcommands. | None. |
| B6 | `docs(handoff): post-CLI-verbs status` | Restate N+2 BLOCKED-UPSTREAM with the new probe datapoint (date + Copilot version checked). Re-test trigger condition: user upgrades Copilot CLI past 1.0.51. | None. |

**Acceptance criteria for Branch B:**

- `npm test` → 699 → ~739+ passing, 0 failed.
- `npm run build` → tsc clean with no new diagnostics.
- `omcp state ralph status`, `omcp state ultrawork status`, `omcp state todo list`, `omcp state boulder status` all runnable from a fresh shell after build, returning non-error exit codes (exit 0 on success or 1 on missing state).
- The `omcp state` description string at `src/cli/omcp.ts:411` is updated from `"State CLI: list | read <mode> | write <mode> <json> | clear <mode> | clear-all"` to include the new actions: `"State CLI: list | read <mode> | write <mode> <json> | clear <mode> | clear-all | ralph <sub> | ultrawork <sub> | todo <sub> | boulder <sub>"`.
- No bare `writeFileSync` in any new file (must go through `atomicWriteFileSync` via the lib modules, which already enforce this).
- All path inputs go through `assertSafeSlug` (verify by grepping each new CLI file for `assertSafeSlug` if it constructs any path).
- `escapeRegExp` from B0 is imported and used at every `new RegExp(userInput)` site in the new CLI code (verify by grep: every `new RegExp(` in `src/cli/commands/state-*.ts` is preceded by an `escapeRegExp(` on the same line).
- No top-level `omcp ralph` / `omcp ultrawork` command behaviour changed — existing `MODE_COMMANDS` mode-launcher path remains untouched. Verify by running `omcp ralph "noop"` after the change and confirming it still dispatches via `runMode` (not the new state-ralph code path).
- Session isolation respected: when `COPILOT_SESSION_ID` is set, the new state-handler reads/writes scope to `.omcp/state/sessions/<id>/` (matching the existing pattern at `src/cli/commands/state.ts:22-30`). At least one test per new state-handler verifies this.

### Step Z — Common close-out (both branches)

1. `npm test` and `npm run build` — both must pass.
2. Deslop pass via `oh-my-claudecode:ai-slop-cleaner` on **only** the files touched this session.
3. Re-run `npm test` after deslop — must still pass.
4. Architect verification against the branch-specific acceptance criteria.
5. On APPROVE: `/oh-my-claudecode:cancel`.

---

## Pre-mortem (3 scenarios)

1. **Probe gives false "fixed" verdict, then real hooks crash silently.** Mitigation: after each Branch-A hook commit, run a manual TUI smoke that actually exercises that specific event (e.g., for `persistent-mode`, trigger a real Stop event in TUI and verify the hook produced its expected continuation prompt). Don't trust probe-positive blindly.
2. **Branch B: `omcp state <new-action>` switch case mis-dispatches because action arg collides with the `clear` / `list` / `read` / `write` cases.** Mitigation: the new cases `"ralph"` / `"ultrawork"` / `"todo"` / `"boulder"` use distinct strings, but B1 must include a regression test that `omcp state list` and `omcp state clear-all` still work (no behavioural change to the existing surface).
3. **v0.12.0 release commit forgets one of the 4 manifests.** Mitigation: explicit checklist line in A4/B5 step; after the bump, `grep -r "0.11.0" package.json .agents/plugins/marketplace.json .claude-plugin/plugin.json plugins/oh-my-copilot/.claude-plugin/plugin.json` must return zero matches.

---

## ADR

**Decision:** Next session executes Option C (probe-then-fork) with Branch A or Branch B as defined above.

**Drivers:**

- Copilot hook bug status is binary and probe cost is bounded (<15 min).
- Both fork branches consume the N+1 lib work and ship a v0.12.0 release.
- User's stated emphasis ("ralph / ralplan / team — 多 agent 互相 critic 抗幻觉") is unaffected by branch choice — both branches go through architect verification.

**Alternatives considered:** see options A / B / D / E above with rejection rationale.

**Why chosen:** Probe resolves the gating question. Branch A unblocks the highest-priority work IF the upstream bug is fixed. Branch B is value-positive even when upstream is still broken, AND uses every N+1 subsystem exactly as it was designed to be used.

**Consequences:**

- v0.12.0 ships either way.
- If Branch B fires, N+2 stays BLOCKED-UPSTREAM and a new HANDOFF section pins the re-test trigger to "user upgrades Copilot CLI past 1.0.51."
- Phase 3 / Phase 4 re-evaluation deferred to a later session that closes the hook question.
- omx parity gap remains untouched — separate `/goal`.

**Follow-ups:**

- If Branch B chosen, future session re-probes when Copilot CLI 1.0.52+ ships.
- After N+2 lands (whenever), re-evaluate Phase 4 hallucination-shield "advise-only" downgrade — old verdict was driven by the now-superseded Phase 1 smoke.
- Eventual MCP tool wrappers on top of the same lib subsystems can layer on top of either branch.
- **(Critic iter-1 minor finding #1)** Pre-existing test gap: `src/__tests__/cli-wiring-invariants.test.ts:155` checks only 3 of 4 manifests (missing `plugins/oh-my-copilot/.claude-plugin/plugin.json`). The pre-mortem scenario 3 grep covers this manually but the automated test should be extended in a follow-up.
- **(Critic iter-1 minor finding #2)** Pre-existing unescaped `new RegExp(query)` at `src/cli/commands/session.ts:32` — user-supplied `omcp session [query]` argument bypasses regex escaping. Opportunistic fix when `escapeRegExp` from B0 lands: retrofit this single call site. Out of scope for the main plan but cheap.
- **(Critic iter-1 minor finding #3)** Add a one-liner to Step Z that confirms the post-test count matches the branch-specific projection (~739+ for Branch A, ~739+ for Branch B), not just "tests pass."
- **(Critic iter-1 unscored question)** If `copilot --version` fails or returns an unexpected format in Step 1a, fall through to running the probe (treat unknown version as "possibly newer" rather than asserting 1.0.51). Document this in the executor's session log.
