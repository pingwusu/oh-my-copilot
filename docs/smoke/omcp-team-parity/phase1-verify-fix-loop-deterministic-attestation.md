# Phase 1 Verify/Fix Loop — Deterministic Attestation (US-omcp-parity-P1)

**Date**: 2026-05-25
**Mode**: deterministic (mock-spawn fallback per iter-2 H4)

## Environment

omcp v2.1.x N+1, Phase 1 verify/fix loop.
Harness: `src/scripts/smoke-phase1.ts` (version 1.0.0).
Renderer: `src/lib/smoke-template.ts` (shared with live + P3 + P4 smoke artifacts per iter-2 H4).
Trigger env: `OMCP_COPILOT_AUTH=missing` (CI mode; no real Copilot CLI invoked).
Spawn surface: every `npx vitest run`, `npx tsc --noEmit`, `npx biome check src/`, and `copilot -p ... --agent debugger` is replaced by an in-process mock returning deterministic fixture output.

## Pre-condition

- A 2-worker omcp team session with `current_phase: executing` is on disk under `.omcp/state/sessions/<sid>/team-state.json`.
- Both workers' pidfiles + shards exist under `.omcp/state/team/<sid>/` (simulates the user-visible state after `omcp team 2:executor "<task>"` has finished spawning + writing shards).
- No verify-report-N.json or worker-K-verify-fail.json files exist yet (first verify pass has not run).

## Trigger

Sequence executed by `runPhase1DeterministicSmoke()`:
1. Seed TeamState + 2 worker pidfiles + 2 shard files.
2. Call `runTeamVerify` with a mock spawn that returns vitest exit-1, tsc/biome exit-0.
3. Call `runTeamCollect` (no `--team-name`) — must transition to `fixing` because Story 3 reads the worker-K-verify-fail.json signals.
4. Call `spawnFixWorker` with a mock spawn returning a fake pid; assert fix_loop_count → 1 and pidfile written.
5. Write a fix-worker shard (simulates the worker writing its own shard before exit).
6. Call `runTeamVerify` again with an all-pass mock; this clears the stale signals via Story 2's clear-at-start invariant.
7. Call `runTeamCollect` — must transition to `completed`.

## Output

```
harness cwd=C:\Users\RUNJIA~1\AppData\Local\Temp\omcp-smoke-p1-o8YlMZ
sessionId=smoke-p1-det
step1: TeamState seeded (executing, 2 workers)
step2: 2 worker pidfiles + shards written
step3: verify iteration=1 ok=false exitCode=1 workerSignals=2
step4: collect finalPhase=fixing verifyFailSignals=2 summaryWritten=true
step5: fix-worker spawned idx=3 fixLoopCount=1 exhausted=false
step6: fix-worker shard written (worker-3-shard.json)
step7: re-verify iteration=2 ok=true exitCode=0
step8: collect finalPhase=completed verifyFailSignals=0
```

Key invariants verified by this trace:
- The first verify pass writes signals → collect picks them up → fixing transition.
- spawnFixWorker increments fix_loop_count from undefined → 1; pidfile recorded for cancel/cleanup.
- Story 2's clear-at-start invariant removes stale signals on the passing iteration.
- The final collect sees no signals and no merge conflicts → completed.

## Verdict

PASS — deterministic. All 6 Phase 1 stories (DOCTOR / VERIFY-runner / COLLECT shortcircuit / FIX-worker / loop-bounding / smoke) participate in this run end-to-end. Live-mode equivalent is gated on the operator running with `copilot login` completed; the section structure here matches the live-mode artifact via `src/lib/smoke-template.ts`. Tag-gate per iter-2 §RELEASE-cut still requires ≥1 live-smoke artifact from P1/P3/P4 before v2.1.0 LOCAL tag.

## References

- docs/plans/omcp-team-omc-parity-iter2.md (US-omcp-parity-P1-VERIFY-smoke-artifact)
- src/cli/commands/team-verify.ts (runTeamVerify + spawnFixWorker)
- src/cli/commands/team-phase-controller.ts (runTeamCollect)
- src/lib/smoke-template.ts (shared renderer + drift detection)
