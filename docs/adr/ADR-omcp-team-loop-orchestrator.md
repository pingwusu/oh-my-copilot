# ADR: `omcp team-loop` Auto-Orchestrator for the Verify/Fix Loop

**Date**: 2026-05-25
**Status**: Accepted (v2.1 post-release follow-up — Story 21)
**Author**: pingwusu
**Related**:
- `docs/plans/omcp-team-omc-parity-iter2.md` (US-omcp-parity-P1-FIX-worker-spawn AC #4)
- `docs/adr/ADR-omcp-team-omc-parity-iter2.md` (master decision record)
- `src/cli/commands/team-loop.ts` (implementation)

---

## Context

The iter-2 plan's US-omcp-parity-P1-FIX-worker-spawn acceptance criteria
included this 4th bullet:

> When fix worker writes its own shard, `team-collect` re-runs verify
> automatically (extension to collect logic).

This bullet was deferred at Story 4 commit time (`46f226f`); the iter-2
architect review explicitly scoped it to Story 5, but Story 5 only
landed the bound-check (collect-side + spawnFixWorker defense), not the
auto-iterator that wires verify → collect → spawn-fix → wait → re-verify
into a single self-driving loop.

The user + QA tester's review at the v2.1 N+3 boundary surfaced this
gap: v2.1 ships the verify/fix **primitives** but not the **orchestrator**.
An operator running `omcp team N:executor "..."` then expected to walk
away currently has to drive each step manually:

```bash
omcp team 4:executor "task"
# wait for workers to write shards
omcp team-verify <sid>
omcp team-collect <sid>   # → fixing
omcp team-fix <sid>       # spawns fix-worker
# wait for fix-worker shard
omcp team-verify <sid>
omcp team-collect <sid>   # → completed | fixing | failed
# ... loop until converged
```

omc handles the loop via in-session Stop hooks that re-fire on each
verify pass. omcp can't directly mirror this — Copilot CLI's hook
surface doesn't expose an equivalent re-entry point (per CLAUDE.md:
"Claude `Task` agent dispatch / `EnterPlanMode` → not available in
Copilot CLI").

## Decision

Ship `omcp team-loop <session-id> [--max-loops N] [--shard-timeout <ms>]`
as a **new dedicated CLI verb** in a v2.1 post-release follow-up commit
(Story 21). The verb's body is a synchronous single-process loop that
composes the existing primitives:

```
for iter in 1..HARD_BOUND:
  verify  = runTeamVerify(sessionId, ...)   # writes signals on fail
  collect = runTeamCollect(sessionId, ...)  # transitions phase

  if collect.finalPhase == "completed":  return exit 0
  if collect.finalPhase == "failed":     return exit 1 (loopExhausted=true)
  if collect.finalPhase == "fixing":
    fix = spawnFixWorker(sessionId, ...)
    if fix.exhausted:                    return exit 1 (loopExhausted=true)
    awaitShard(fixWorkerIndex, deadline)
    continue
  # unexpected → exit 1
```

Exit codes: 0 / 1 / 2 (invalid slug) / 3 (no session). Defensive
`HARD_ITER_BOUND = maxLoops * 2 + 5` prevents infinite loops if the
state contracts go sideways. Shard wait timeout = 10 minutes default
(`--shard-timeout` overrides; env not introduced — `--max-loops` env
gate via `OMCP_TEAM_MAX_FIX_LOOPS` is sufficient).

## Drivers

1. **Backfills a deferred AC without changing existing semantics.** The
   primitives (verify, collect, fix, ack) all keep their current
   signatures + tests. team-loop is purely additive.
2. **Single-process loop matches omc's behavior contract.** An operator
   running `omcp team-loop <sid>` gets the same "walk-away" UX as omc's
   in-session loop — without omcp needing a hook framework Copilot CLI
   doesn't expose.
3. **Keeps team-collect inspection-only.** The alternative
   (`team-collect --auto-fix`) would mutate team-collect's role from
   "observe state + transition phase" into "actuate the next stage."
   That conflates inspection with execution and makes the surface
   harder to compose (chain runners, status surfaces, etc. expect
   collect to be a stateful read of TeamState, not a stateful write
   of a fix-worker spawn).

## Alternatives Considered

### Option A — `team-collect --auto-fix` flag

- **Scope**: extend the existing `omcp team-collect` CLI with an
  `--auto-fix` boolean that, when set, also calls `spawnFixWorker`
  + polls for the shard before returning.
- **Rejected because**: conflates inspection and actuation in one verb;
  makes the state-transition surface inconsistent (with/without
  --auto-fix produce different on-disk side effects beyond the
  transition); breaks the chain orchestrator's assumption that
  per-step actuation is the step's responsibility, not collect's.

### Option B (CHOSEN) — `omcp team-loop` dedicated verb

See Decision section.

### Option C — Skill-level orchestration via `skills/ralph/SKILL.md`

- **Scope**: add a "verify/fix loop driver" subsection to the ralph
  dispatch guide; ralph agent invokes verify → collect → fix → repeat
  manually per iteration.
- **Rejected because**: works only when an operator-driving agent (ralph)
  is in the picture. An operator running `omcp team` directly + wanting
  walk-away semantics gets no help. Also distributes the bound check
  across two layers (ralph SKILL.md text + spawnFixWorker defense),
  making the contract harder to reason about.

### Option D — Mark the bullet permanently deferred via ADR

- **Scope**: write an ADR documenting why the auto-loop is fundamentally
  incompatible with Copilot CLI's hook surface; instruct operators to
  use `omcp ralplan --chain` or `omcp ralph` as the orchestrator.
- **Rejected because**: the loop body IS expressible without hooks —
  it's just a synchronous Node loop. Option B costs ~250 LOC + ~13
  vitest cases; Option D ships no functionality. Per "用事实说话" + the
  user's explicit "做B吧" directive: Option D's ADR-without-implementation
  is the wrong path.

## Consequences

### Visible to users

- **New CLI**: `omcp team-loop <sid> [--max-loops N] [--shard-timeout <ms>]`.
- **New exit-code semantics**: 0 / 1 / 2 / 3 (same shape as team-wait).
- **Closes the operator walk-away gap** that v2.1 left open.

### Visible to maintainers

- **State-machine idempotence fix**: `runTeamCollect` no longer calls
  `transitionPhase(currentPhase, currentPhase)` — guarded by an explicit
  equality check + log line. This was necessary because team-loop's
  second iteration legitimately revisits the `fixing` phase, and
  `VALID_TEAM_TRANSITIONS` (in `src/runtime/mode-state.ts:217-227`) does
  not list `fixing → fixing` as valid. The guard skips the transition
  while preserving the rest of collect's side-effects (summary write,
  log lines, verifyFailSignals report field).
- **Shared spawn surfaces**: team-loop reuses `runTeamVerify`,
  `runTeamCollect`, `spawnFixWorker` verbatim — all injection seams
  for tests are preserved.

### NOT changed

- No new state files. No new on-disk schemas. No new env vars beyond the
  existing `OMCP_TEAM_MAX_FIX_LOOPS` already wired by Story 5.
- The chain orchestrator (`omcp ralplan --chain`) does NOT auto-call
  team-loop. Operators who want the auto-loop inside a chain step add
  `--then team-loop <sid>` to their spec explicitly.

## Follow-ups

1. **CHANGELOG entry** under `[Unreleased]` → flag `team-loop` as the
   v2.1.x post-release additive verb.
2. **ralph SKILL.md** could mention `omcp team-loop` in the dispatch
   guide as the "single-shot fire-and-forget" option vs the per-step
   driving option already documented. Optional.
3. **Phase 4 integration smoke** could be retargeted to invoke
   team-loop directly instead of orchestrating each step inline. Out
   of scope for Story 21; revisit if a future smoke harness lands.

## Tracking

- Source: user prompt "做B吧" at the v2.1 N+3 boundary review.
- Test coverage: 11 deterministic vitest cases at
  `src/__tests__/team-loop.test.ts` covering happy path / single-fix-
  converges / bound-exhaustion / max-loops=1 / shard-wait-timeout /
  argv guards (invalid sessionId / missing pidDir / missing TeamState)
  / already-terminal session / CLI wrapper / summary output.
- Phase-controller idempotence regression covered by existing 51-case
  suite (all green after the fix).
