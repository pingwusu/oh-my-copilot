# Plan: omcp → orchestrator (v1) — ralplan consensus

**Status:** **CONSENSUS APPROVED** — Planner iter-1 → Architect iter-1 ITERATE → Planner iter-2 → Critic iter-1 ACCEPT-WITH-RESERVATIONS → Planner iter-3 → Architect iter-2 APPROVE-with-2-edits → Planner iter-4 → **Critic iter-2 APPROVE**. Ready for team handoff.
**Context root:** `C:\Users\runjiashi\oh-my-copilot-r2`, HEAD `3e3058a` (v0.12.0 + retraction).
**Driver:** user directive 2026-05-23 mid-day — make omcp the orchestrator; focus ralph/ralplan/team as long-running first-class features; verify with team+critic in independent context, loop until done.

---

## RALPLAN-DR Summary

### Principles (5)

1. **Reality-grounded** — every claim about a missing/working part of omcp must be checkable against the current tree (`git status`, `grep`, `npm test`). The HANDOFF correction (commit `3e3058a`) is the reset point.
2. **Hook fix is the gateway** — N+2 hook ports, persistent-mode loop, and any background continuation logic all require the hook command template to fire correctly on Windows/PowerShell. Fix the gateway first; everything else is downstream.
3. **Single source of truth per state schema** — every state type (ralph, ultrawork, todo, boulder, notepad) has exactly one writer module in `src/lib/*-state.ts`. CLI verbs (US-B1..B4) and hooks (Phase 2 Batch C N+2) both delegate to those modules — never duplicate read/write logic.
4. **Verification is a loop, not a step** — the team+critic protocol runs after each phase completes, in independent context, with the option to re-execute on REJECT. Phases are not "done" until the critic returns APPROVE.
5. **Backward compatibility on existing CLI surface** — `omcp ralph "<task>"`, `omcp ralplan "<task>"`, `omcp team "<task>"` mode-launcher behaviour at `src/cli/omcp.ts:255-285` is preserved. Orchestrator features are additive.

### Decision Drivers (top 3)

1. **What is the SMALLEST change that unblocks N+2 hook ports on Windows + PowerShell?** (The hook command template is the answer; the gateway must land before anything else.)
2. **What does "omcp is the orchestrator" mean concretely?** — three plausible definitions, see options below; need consensus on one.
3. **Can the team+critic verification protocol fit inside omcp's existing skill+agent surface, or does it require a new run loop?** (If yes, it's a workflow doc. If no, it's a new feature.)

### Viable Options for "make omcp the orchestrator"

| ID | Definition | Pros | Cons |
|----|------------|------|------|
| **O-A** | **Hook-fire orchestrator (RECOMMENDED)** — fix the omcp hook-config target file (settings.json, not config.json), port N+2 (persistent-mode + todo-continuation + omc-orchestrator), let Copilot's Stop/PreToolUse/PostToolUse hooks drive the ralph/ralplan/team continuation loop end-to-end inside the Copilot TUI/`-p` process. | Most omc-faithful; uses Copilot's own dispatcher; no extra daemon to manage; omcp's own hook command (`omcp hook fire`) is already shell-safe so no command-template work is needed in omcp. | Hook latency is opaque; failure modes are hard to debug; depends on Copilot's hook contract staying stable. Doctor / migration logic likely needed to detect users who had hooks in config.json from prior omcp versions. |
| O-B | Daemon orchestrator — `omcp daemon` long-running process that spawns Copilot `-p` sessions, watches their output, writes state files, fires the next iteration when state says so. | Failures are visible (daemon logs); not coupled to Copilot's hook contract. | New surface to maintain; pid-file + stop verb required (invariant 9); orphan-process risk per pre-mortem 3; speculative — no demonstrated user need given Copilot supports hooks. **DEFERRED to v1.1+** per Architect iter-1 feedback. |
| O-C | Hybrid (Phase 1 hooks + Phase 2 daemon). | Both paths usable. | Two state-sync pathways must stay consistent; mode-selection burden on users; permanent maintenance cost for speculative use case. **REJECTED** in iter-2 per Architect — daemon is speculative until users actually request it. |
| O-D | Cron-job orchestrator. | Trivial. | Wrong semantics for "long-running". **REJECTED.** |
| O-E | Pure-skill orchestrator. | Zero new infrastructure. | Loses persistence guarantee. **REJECTED.** |

**Recommendation:** Option A (Hook-fire). Daemon is a follow-up if users demand it; do not build speculatively.

---

## Execution Plan

### Phase 1 — Fix hook-config target file (the actual omcp gateway bug)

**Architectural correction from Architect iter-1:** omcp's `omcpHookCommand()` at `src/runtime/copilot-config.ts:221-224` already emits a clean shell-safe command (`omcp hook fire <event> --json`) — there is NO `$CLAUDE_PLUGIN_ROOT` template in omcp's wiring. The `$CLAUDE_PLUGIN_ROOT` bug lives in OMC's `omc/hooks/hooks.json:8` and is outside this plan's scope.

omcp's actual gateway bug is at `src/runtime/paths.ts:21`: `copilotConfig = join(copilotHome, "config.json")` — but Copilot CLI reads hooks from `~/.copilot/settings.json`, not `config.json`. The probe script at `scripts/smoke/wire-probe-for-tui.mjs:31-35` documents this explicitly. The plan's evidence chain for the regression is: (a) current `paths.ts:21` proves the current target is `config.json`; (b) the `CHANGELOG.md` v0.4-v0.5 entries record the historical `settings.json` writes; the regression introduction is inferred from those two facts (not a single direct citation).

**Scope:**

1. Add `copilotSettings: join(copilotHome, "settings.json")` to the `OmcpPaths` interface and the resolver in `src/runtime/paths.ts`. Add a companion assertion to `src/__tests__/paths.test.ts:15` confirming `copilotSettings` ends with `settings.json`.
2. Update **all** call sites that use `paths.copilotConfig` for hook wiring (explicit enumeration per Architect iter-2):
   - `src/cli/commands/setup.ts:108-109` — switch hook write target to `paths.copilotSettings`.
   - `src/cli/commands/doctor.ts:99-117` — switch the hook-presence check to read from `paths.copilotSettings` (currently reads `config.json`; would false-negative after Phase 1 without this update).
   - `src/cli/commands/setup.ts:9` comment ("upsert the omcp entry in ~/.copilot/config.json") needs the comment updated to reflect the dual-target reality.
   - `src/cli/commands/uninstall.ts:82-101` — uninstall strips plugin entries only (no hooks) so it does NOT need to change file targets, but verify by reading it during Phase 1.
2a. **`applyOmcpRuntimeWiring` split** (per Architect iter-2 tradeoff tension): the current function at `src/runtime/copilot-config.ts:308-321` bundles hooks + statusLine into a single config object. Phase 1 MUST resolve this either by:
   - **Option A (recommended):** split `applyOmcpRuntimeWiring` into `applyOmcpHookWiring()` (writes to `settings.json`) and `applyOmcpConfigWiring()` (writes to `config.json`). All call sites updated.
   - **Option B:** keep `applyOmcpRuntimeWiring` intact but have callers destructure the result and write `hooks` vs `statusLine` to different files.
   The plan recommends Option A as the cleaner separation. This MUST be acknowledged in Phase 1 scope so the executor doesn't rediscover it mid-implementation.
3. Update the stale comment block at `src/runtime/copilot-config.ts:92-119` which currently claims Copilot reads `hooks` from `config.json`. The replacement text MUST cite the probe's `wire-probe-for-tui.mjs:31-35` evidence and the Copilot version(s) under which `settings.json` is the authoritative target (currently 1.0.48 → 1.0.52-4 minimum). Without this update, the comment becomes a documentation trap that contradicts the new code.
4. Decide hooks vs non-hooks split: **MANDATED choice** — keep `model` / `statusLine` / other non-hook config in `config.json` (Copilot's read surface for these is documented elsewhere and changing it is out of scope); move hooks ONLY to `settings.json`. The plan does NOT consolidate.
5. `omcp doctor` detects users with hooks in the old `config.json` and:
   - For OMCP-OWNED hooks (identified by the `omcp hook fire` command signature): auto-migrate to `settings.json` and remove from `config.json`. Migration writes via `atomicWriteFileSync` and produces a backup at `~/.copilot/config.json.pre-omcp-migration-backup` for one cycle.
   - For USER-AUTHORED hooks (any other command): leave in place at `config.json` and emit a warning advising the user to manually move them to `settings.json` if they want Copilot to fire them. The doctor MUST NOT silently delete or move user-authored entries.

**Acceptance criteria:**

- `OmcpPaths` interface in `src/runtime/paths.ts` exports `copilotSettings: string`.
- `applyOmcpRuntimeWiring` (or equivalent) in `src/cli/commands/setup.ts` writes hook entries to `paths.copilotSettings`, not `paths.copilotConfig`.
- Probe (`scripts/smoke/wire-probe-for-tui.mjs`) re-wires the corrected target and exercises `copilot -p` against a tool-triggering prompt — the probe log `~/.copilot/omcp-debug-probe.log` MUST contain `phase: "start"` entries after this Phase. (Last session's NO_FIRE verdict re-tested with corrected target.)
- `omcp --version` and `copilot --version` recorded alongside the probe pass.
- Unit tests: `src/__tests__/copilot-config.hook-target.test.ts` ≥5 tests covering: paths.copilotSettings resolution, setup writes to settings.json, setup leaves config.json untouched for hooks, doctor detects misplaced hooks in config.json, migration helper moves hooks atomically.
- No top-level command-template work needed in omcp (the `omcp hook fire` command was already shell-safe).

### Phase 2 — N+2 hook ports (now genuinely unblocked)

Same content as the "Branch A" section of `docs/plans/next-session-ralplan.md` (specifically the table starting `A1 | feat(hooks): port persistent-mode...`):

- `src/hooks/persistent-mode.ts` — Stop event
- `src/hooks/todo-continuation.ts` — Stop event
- `src/hooks/omc-orchestrator.ts` — PreToolUse + PostToolUse

**Line-count basis:** the omc reference at `C:\Users\runjiashi\.claude\plugins\cache\omc\oh-my-claudecode\4.9.3\src\hooks\persistent-mode\` is ~1255 lines (per the original v3 plan's audit table). The omcp ports are expected to be ~600-800 lines for `persistent-mode.ts` after replacing `~/.claude/` paths with N+1 lib calls (a 35-50% reduction), ~400 lines for `todo-continuation.ts` (omc reference ~615 lines), and ~400 lines for `omc-orchestrator.ts` (omc reference ~574 lines). These are estimates from the omc source under the assumption that N+1 lib subsystems handle paths/state/atomic writes — actuals will be measured at commit time.

All three port directly from omc, replace `~/.claude/` references with `.omcp/` paths, reuse N+1 lib modules. ≥40 new tests across the three hooks.

**Acceptance criteria:**

- All 3 hooks registered in `OMCP_HOOK_EVENTS` and `COPILOT_VALID_EVENTS`.
- `subagentStart` references are camelCase only.
- `assertSafeSlug` on every path input.
- `atomicWriteFileSync` on every state write.
- A TUI smoke test (manual, scripted via the corrected probe form) shows each hook actually fire in `copilot -p` mode with the corrected command template.
- Test count: 742 → ~782+ passing.

### Phase 3 — First-class orchestrator surface (skills + agents + CLI)

This phase is what makes omcp "the orchestrator" rather than just a skill collection.

**Surface inventory (each requires its own commit):**

1. **Ralph as a first-class long-running mode:** `omcp ralph "<task>"` already exists as mode launcher (`"ralph"` entry in `MODE_COMMANDS` at `src/cli/omcp.ts:69`). Wire it to (a) write `ralph-state` via `src/lib/ralph-state.ts`, (b) inject persistent-mode hook context on Stop, (c) loop until PRD passes via the now-firing hook system.
2. **Ralplan as the consensus-planning frontend:** `omcp ralplan "<task>"` already exists. Ensure it produces a plan in `.omcp/plans/`, registers it via `boulder-state`, and hands off to ralph for execution.
3. **Team as the parallel-execution mode (with concurrent-write strategy):** `src/cli/commands/team.ts` exists as a simple spec parser + tmux/detached spawner. Phase 3.3 must (a) make it PRD-aware (read stories via `readPrd()` from `src/lib/ralph-state.ts`, partition across N workers), (b) decide concurrent-write strategy for PRD updates. Strategy options:
   - **3a. Shared-PRD with file locking** (port `withFileLockSync` from omc per the `boulder-state.ts:15` deferred comment). Most accurate; requires platform-portable advisory locking.
   - **3b. Per-worker shard files merged at end** (each worker writes `.omcp/state/team-shards/<worker>-prd.json`, a merge step at session-end reconciles into the canonical PRD). Avoids runtime locking; eventual consistency.
   - **3c. Single-writer coordinator** (one worker writes; others submit deltas via IPC or a queue file). Simplest correctness but bottlenecks throughput.
   - **Recommendation:** 3b (per-worker shards + end-of-session merge) for v1, with optional escalation to 3a if users hit shard-merge conflicts. The boulder-state lock infrastructure can land later without breaking 3b.

   **Merge-coordinator design (per Critic iter-1 question):** the current `team.ts:96` spawns detached children, so the parent process is NOT a long-lived coordinator. Two viable triggers:
   - **3b-i. End-of-stop-hook merge** — when ralph state shows `allComplete: true`, the persistent-mode hook (Phase 2) calls a `omcp team merge-shards <team-name>` verb that reads `.omcp/state/team-shards/<team-name>/*.json`, reconciles, writes the canonical PRD, and clears shards. This couples team-mode merging to ralph's PRD-completion check — naturally serialized.
   - **3b-ii. Explicit user-driven merge** — `omcp team merge-shards <team-name>` is an opt-in verb the user runs when they decide the team session is done. Suitable for non-ralph team runs.
   - **Both** are wired: the `omcp team` parent process registers a `team-stop` lifecycle hook that calls the merge verb, AND the verb is also user-invokable. The merge verb itself uses `withFileLockSync` (when ported in Phase 3a) or `atomicWriteFileSync` (in 3b) on the canonical PRD to prevent race with a concurrent re-run.

**Acceptance criteria:**

- `omcp ralph "<task>"` invocation produces a measurable state-machine cycle: state-write → Stop event → persistent-mode hook continuation prompt → next iteration → repeat until PRD allComplete.
- `omcp team "<task>"` distributes PRD stories across N workers, writes per-worker shards atomically, and merges into the canonical PRD at session end. Concurrent-shard-write test: spawn 4 workers writing different stories; assert merged PRD reflects all 4 with no data loss.
- Per-worker shard path: `.omcp/state/team-shards/<sanitized-worker-name>-prd-shard.json` — sanitized via `assertSafeSlug`.
- Tests cover the state-machine transitions explicitly (not just lib state-mutation), and at least one end-to-end test runs `omcp ralph` against a tiny PRD and confirms iteration count increments.
- The existing bare `writeFileSync` at `src/cli/commands/team.ts:96` (pidfile) and `src/mcp/hermes-bridge.ts:223` (log init) MUST be either switched to `atomicWriteFileSync` OR documented as an explicit invariant-2 carve-out. Create the file `docs/architecture/invariants.md` as part of this Phase 3 deliverable (no existing invariants doc exists per Critic iter-1 finding); the new doc lists all 9 project invariants with their enforcement points and explicit carve-outs (e.g., "pidfile writes via `writeFileSync` are NOT state-JSON writes and are exempt from atomic-write requirement").

### Phase 4 — `critic-verify-loop` skill (formerly part of Phase 3.4)

Split out per Architect iter-1 feedback — this is a substantial subprocess-orchestration deliverable, not a single-commit item.

**Scope:**

- New skill `skills/critic-verify-loop/SKILL.md`.
- Subprocess spawner: launches `copilot -p` with architect prompts in a sandboxed shell (fresh context, no prior memory).
- Result parser: extracts `APPROVE` / `ITERATE` / `REJECT` verdicts from free-form architect output using the existing `detectArchitectApproval` / `detectArchitectRejection` helpers in `src/lib/ralph-state.ts:416-458`.
- Loop controller: re-dispatches on ITERATE up to 5 iterations.
- State persistence: verification results land in `.omcp/state/verification/<phase-id>-<run-id>.json` (via `atomicWriteFileSync`, paths via `assertSafeSlug`).
- New CLI verb: **`omcp verify <phase-id>`** (chosen). Registered in `src/cli/omcp.ts` per invariant 8 — a new `program.command("verify <phase-id>")` block added to the existing command set, with the handler dispatched to `src/cli/commands/critic-verify-loop.ts`.

**Acceptance criteria:**

- `omcp critic-verify-loop` (or equivalent CLI verb) invokable from a fresh shell.
- Returns exit 0 on architect APPROVE + critic APPROVE, exit 1 on REJECT after 5 iterations, exit 2 on invocation error.
- Tests: ≥10 covering verdict parsing (3 verdicts × multiple phrasings), loop termination, state persistence, exit-code mapping, fresh-context isolation (subprocess does not inherit parent's env).
- Pilot run against Phase 1's hook target fix produces a real APPROVE/ITERATE/REJECT verdict file in `.omcp/state/verification/`.

### Phase 5 — Verification protocol (recurring, applied after every phase)

**Protocol (codified as a documented workflow):**

For each phase landing:

1. The phase's executor produces a diff + a list of acceptance criteria from the PRD.
2. A fresh architect agent (independent context, no prior memory of this session) reviews the diff against the criteria and returns APPROVE / ITERATE / REJECT.
3. A fresh critic agent (also independent context, also no prior memory) cross-checks the architect's review for principle-option consistency, fair alternatives, risk mitigation, and concrete verification steps.
4. If both APPROVE: phase passes.
5. If either ITERATE: executor revises, re-submit, up to 5 iterations.
6. If either REJECT after 5 iterations: stop and escalate to user.

This is identical to the ralplan workflow already in `skills/ralplan/SKILL.md`, but applied to **execution** verification instead of plan verification. The `critic-verify-loop` skill from Phase 3 is the codified form of this protocol.

**Acceptance criteria for the protocol itself:**

- Workflow documented at `docs/workflows/team-critic-verification.md`.
- A pilot run of the protocol against Phase 1's hook target-file fix produces real APPROVE/ITERATE/REJECT verdicts in `.omcp/state/verification/` (path-consistent with Phase 4's state-persistence path).

---

## Pre-mortem (3 scenarios)

1. **Phase 1 target-file fix lands but probe still fails — `omcp` is not on PATH, so the hook command `omcp hook fire <event> --json` exits 127.** Mitigation: Phase 1's acceptance criteria require the probe to ACTUALLY pass post-fix. If it doesn't, doctor must emit an explicit "omcp not on PATH" diagnostic AND the hook command should fall back to the absolute path of `dist/cli/omcp.js` resolved at setup time. This is a known surface (per `package.json:bin`) and the absolute-path fallback is a 5-line change in `setup.ts`.
2. **Critic in independent context produces inconsistent verdicts** — architect APPROVE but critic REJECT, or vice versa. Mitigation: the Phase 5 protocol requires both to APPROVE; disagreement is itself the signal. The executor reads both reviews and revises against the merged objections list, not just one.
3. **Phase 3.3 team-mode shard merge silently drops a story** — two workers update the SAME story (e.g., both mark it passes:true with different evidence text), and the merge picks one arbitrarily. Mitigation: the shard schema includes a `workerId` field and a `mergedFrom` audit trail per story; the merge step writes a `.omcp/state/team-shards/merge-report.json` listing every conflict and which shard won. If conflicts cross a threshold, the run halts and escalates to user. Detection beats prevention — the audit trail makes silent data loss impossible.

---

## ADR

**Decision:** Adopt Option A (Hook-fire orchestrator). Execute Phase 1 (target-file fix) first as the gateway, Phase 2 (N+2 hook ports) next, Phase 3 (first-class CLI surface) third, Phase 4 (`critic-verify-loop` skill) fourth, Phase 5 (verification protocol applied recurring) running after every phase.

**Drivers:**

- N+2 hooks are blocked behind a target-file path fix (NOT a command-template fix as iter-1 incorrectly framed). The fix is small but high-leverage.
- The user explicitly asked for "long-running" features — that's the hook-driven persistent-mode loop, not a one-shot launcher.
- Team+critic verification is recurring, not one-time — making it a codified protocol (Phase 5) and a callable skill (Phase 4) gives it first-class status.
- The daemon (Option B) is speculative until users actually request it; deferred to v1.1+.

**Alternatives considered:**

- Option B (Daemon only): deferred — speculative; permanent maintenance burden for unclear benefit when Copilot's hook contract is supported.
- Option C (Hybrid Hook + Daemon): rejected in iter-2 per Architect — two state-sync pathways add complexity without proportional benefit.
- Option D (Cron): rejected — wrong semantics for "long-running".
- Option E (Pure-skill): rejected — loses persistence guarantee.

**Why chosen:**

The Hook-fire orchestrator matches the user's "ralph ralplan让agent长时间运行" framing using Copilot's own dispatcher. omcp's hook command is already shell-safe; the only gateway barrier is the target-file path. Each phase is independently shippable; the verification protocol applies uniformly.

**Consequences:**

- Phase 1 (target-file fix + probe verification + doctor/migration): 1 session (was understated in iter-1; now correctly scoped including migration logic).
- Phase 2 (N+2 hook ports): 1-2 sessions.
- Phase 3 (first-class CLI surface with shard-merge for team mode): 3-4 sessions.
- Phase 4 (`critic-verify-loop` skill): 1-2 sessions (split out per Architect).
- Phase 5 (verification protocol applied recurring): ongoing overhead — not a one-time cost.
- Total session estimate: **6-9 sessions** (was understated as 5-8 in iter-1; iter-2 revision reflects the Phase 4 split and Phase 3.3 concurrent-write strategy work).

**Follow-ups:**

- After Phase 1 lands, replace the interim correction in `3e3058a` with a HANDOFF section that records the actual probe pass on the corrected target file.
- After Phase 2 lands, evaluate whether the Phase 4 hallucination-shield (the OMC kind, separate from this plan's Phase 4) can be upgraded from advise-only — the original Phase 1 verdict that drove the downgrade is now superseded by both the morning re-verdict AND this mid-day root-cause correction.
- After Phase 3 lands, omcp can ship a v1.0.0 representing the "orchestrator" milestone.
- **Concurrent-write follow-up:** if shard-merge (3b) hits real conflict rates in production team-mode runs, port `withFileLockSync` from omc per the `boulder-state.ts:15` deferred comment and switch to strategy 3a.
- **OMC contribution:** the `$CLAUDE_PLUGIN_ROOT` bug in `omc/hooks/hooks.json:8` is OMC's, not omcp's. omcp can file an upstream patch (Bash → PowerShell-compatible) but is not blocked on it.
- **Daemon (Option B):** revisit only if users with non-hook-firing Copilot versions request it.
- **(Critic iter-2 minor 1)** Phase 2 acceptance criteria should add a one-line callout: "No `new RegExp(untrusted)` without `escapeRegExp` (invariant 6) — applies to any user-input regex in the ported hooks (e.g., todo content filtering, project-memory pattern matching)."
- **(Critic iter-2 minor 2)** `omcp team merge-shards <team-name>` should be implemented as a subcommand of the existing `team` Commander command at `src/cli/commands/team.ts` (not a top-level verb), keeping invariant 8 satisfied without adding to the top-level CLI surface.
- **(Critic iter-2 minor 3)** For Phase 3's `hermes-bridge.ts:223` bare `writeFileSync`: this is a log-file-init (empty-string write to truncate/create). Recommended resolution is the carve-out path (document in `invariants.md` as "log-init writes that intentionally overwrite are not state-JSON writes") rather than the atomic-write switch (which would unnecessarily complicate the log lifecycle).
- **(Critic iter-2 open question)** Verify `applyOmcpRuntimeWiring` regression test coverage before Phase 1 splits the function. If existing tests only cover `paths.test.ts` path resolution (not setup write behavior), add a setup-flow integration test BEFORE the split lands so regressions are caught.

---

## Plan revision history

- 2026-05-23 mid-day — Planner iter-1 draft. Misidentified omcp gateway bug as `$CLAUDE_PLUGIN_ROOT` template (that's OMC's bug). Proposed daemon mode in Hybrid Option C.
- 2026-05-23 mid-day — Planner iter-2. Architect iter-1 ITERATE caught 5 required edits:
  1. Phase 1 reframed: omcp's bug is target-file path (`config.json` → `settings.json` at `paths.ts:21`), NOT command template.
  2. Daemon dropped (Option C → Option A); deferred to v1.1+ as speculative.
  3. Phase 3.3 adds explicit concurrent-write strategy (recommendation: per-worker shards + end-of-session merge).
  4. Phase 3.4 split out as its own Phase 4 (`critic-verify-loop` skill); existing Phase 4 renumbered to Phase 5.
  5. Session estimate revised: 6-9 sessions (was 5-8 in iter-1).
  Also re-anchored pre-mortem to actual risks (PATH resolution, shard-merge data loss).
- 2026-05-23 mid-day — Planner iter-3 (this revision). Critic iter-1 ACCEPT-WITH-RESERVATIONS produced 2 MAJOR + 3 minor + 4 missing findings; all folded in:
  - MAJOR 1: Phase 1 now mandates updating the stale `copilot-config.ts:92-119` comment block as part of the target-file change (documentation trap prevention).
  - MAJOR 2: Corrected `src/cli/omcp.ts:65` → `:69` and `:251-281` → `:255-285` everywhere in the plan.
  - Minor 1: CHANGELOG citation clarified — the regression is *inferred* from two facts (current `paths.ts:21` + historical CHANGELOG entries), not a single direct citation.
  - Minor 2: `docs/architecture/invariants.md` creation explicitly scoped into Phase 3 (it doesn't exist yet).
  - Minor 3: `.omcp/verification/` → `.omcp/state/verification/` across Phase 4 and Phase 5 for consistency.
  - Missing 1: Phase 4 `omcp verify <phase-id>` registered in `src/cli/omcp.ts` per invariant 8.
  - Missing 2: Phase 1 doctor rollback explicitly distinguishes OMCP-owned hooks (auto-migrate) from user-authored hooks (warn-only, never silently delete).
  - Missing 3: Phase 2 line-count estimates now cite their omc-reference basis (with line-count delta rationale).
  - Missing 4: Phase 3.3 shard-merge coordinator design specified — wired via persistent-mode-hook on ralph completion AND via user-invokable `omcp team merge-shards` verb.
- 2026-05-23 mid-day — Planner iter-4 (this revision). Architect iter-2 returned APPROVE with 2 required enumeration edits:
  - REQUIRED 1: `src/cli/commands/doctor.ts:99-117` explicitly added to Phase 1 call-site list (else doctor would false-negative after the target-file switch).
  - REQUIRED 2: `applyOmcpRuntimeWiring` split tension at `copilot-config.ts:308-321` acknowledged in Phase 1 — function bundles hooks + statusLine; Phase 1 must split it (Option A recommended) or destructure-after-call (Option B).
  Awaiting Critic iter-2 final pass.
