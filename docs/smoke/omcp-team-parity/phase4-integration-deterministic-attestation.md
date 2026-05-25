# Phase 4 Full-Stack Integration — Deterministic Attestation (US-omcp-parity-P4)

**Date**: 2026-05-25
**Mode**: deterministic (mock-spawn fallback per iter-2 H4)

## Environment

omcp v2.1.x N+3, Phase 4 full-stack integration.
Harness: `src/scripts/smoke-phase4.ts` (version 1.0.0).
Renderer: `src/lib/smoke-template.ts` (shared with P1 + P3 smoke artifacts per iter-2 H4).
Trigger env: `OMCP_COPILOT_AUTH=missing` (CI mode; no real Copilot CLI invoked).
Exercised surfaces (every v2.1 N+1 + N+2 story): runTeamVerify, runTeamCollect, spawnFixWorker (with bound check), runTeamAck --status, prepareTransition, readChainHandoff + getTeamHandoffPhase1Metadata, runTeamWait, chain-state.json markers.

## Pre-condition

- No pre-existing chain-state.json, ralph-state.json, ralplan-state.json on disk.
- A fresh tmp cwd for full filesystem isolation.
- The harness simulates a 4-worker team that hits a verify-fail on first pass, fixes it via spawnFixWorker, and completes on re-verify; then chain hands off to ralph-verify.

## Trigger

Sequence executed by `runPhase4DeterministicSmoke()`:
Phase A. Seed 4-worker TeamState + 4 pidfiles + 4 shards (simulates user-visible state post-spawn).
Phase B. `runTeamVerify` with mock-spawn returning vitest exit-1 → writes 4 worker-K-verify-fail.json signals.
Phase C. `runTeamCollect` reads signals → transitions team to `fixing` + writes verify-fail-summary.json.
Phase D. `spawnFixWorker` with mock-spawn returning fake pid → fix_loop_count=1, fix-worker idx=5; writes fix-worker shard.
Phase E. `runTeamVerify` re-run with all-pass mock → clears stale signals via Story 2 invariant; workerSignals=0.
Phase F. `runTeamCollect` reads zero signals → transitions team to `completed`. TeamState carries fix_loop_count=1.
Phase G. All 4 workers call `omcp team-ack --status completed` — Story 7's --status flag updates TeamState.workers[K].status atomically.
Phase H. `prepareTransition` runs the 5-step handoff team→ralph: snapshot includes the team's Phase 1 metadata; clearedFromMode=true (exclusive to-mode). `readChainHandoff` + `getTeamHandoffPhase1Metadata` surface fix_loop_count=1 + team_completed=true to the simulated ralph step.
Phase I. Ralph step writes its own ralph-state.json; `runTeamWait` (poll-based, no IPC dependency) observes the team's terminal completed phase and exits 0.
Phase J. Chain marker written at status=completed completedSteps=[1,2].

## Output

```
harness cwd=C:\Users\RUNJIA~1\AppData\Local\Temp\omcp-smoke-p4-QCTKLA
phaseA: 4-worker team seeded (smoke-p4-int)
phaseB: verify1 ok=false workerSignals=4 (4 worker-K-verify-fail.json written)
phaseC: collect finalPhase=fixing verifyFailSignals=4
phaseD: spawnFixWorker idx=5 fixLoopCount=1 exhausted=false
phaseE: verify2 ok=true workerSignals=0
phaseF: collect finalPhase=completed
phaseF: TeamState fix_loop_count=1 current_phase=completed
phaseG: 4/4 workers ack'd with --status completed
phaseH: handoff team→ralph clearedFromMode=true (exclusive to-mode)
phaseH: P1 metadata preserved — fix_loop_count=1, team_completed=true
phaseI: ralph-verify approved (mock); team-wait observed terminal phase exit=0
phaseJ: chain status=completed completedSteps=[1,2]
```

Key invariants verified by this trace:
- Phase 1 verify/fix loop converges in 1 fix attempt (max-loops=3 not exhausted).
- Story 2 clear-at-start invariant: passing iteration cleared the 4 stale signals from failed iteration.
- Story 4 fix_loop_count semantic: incremented at spawn time, persisted through completion.
- Story 7 atomic --status: 4 sequential ack-with-status calls all land without torn JSON.
- Story 10 + 11 contract: snapshot.fromState preserves all TeamState fields (fix_loop_count, current_phase=completed, stage_history, workers).
- Story 12 idempotence on terminal chain (not probed here — covered by Story 12 unit tests).

## Verdict

PASS — deterministic. Every v2.1 N+1 + N+2 surface participates in this trace end-to-end with consistent state contracts at every producer→consumer boundary. Live-mode equivalent requires `copilot login` + real spawns; the section structure here matches P1 + P3 attestations via the shared smoke-template renderer. Tag-gate per iter-2 §RELEASE-cut: ≥1 live-smoke artifact across P1/P3/P4 is required before v2.1.0 LOCAL tag — `src/scripts/check-live-smoke.ts` (Story 20) will enforce that before allowing the tag.

## References

- docs/plans/omcp-team-omc-parity-iter2.md (US-omcp-parity-P4-INTEGRATION-smoke)
- src/cli/commands/team-verify.ts (runTeamVerify + spawnFixWorker)
- src/cli/commands/team-phase-controller.ts (runTeamCollect)
- src/cli/commands/team-ack.ts (Story 7 --status)
- src/cli/commands/chain.ts (Story 9 + 10 + 12)
- src/cli/commands/team-wait.ts (Story 13)
- src/lib/chain-handoff-reader.ts (Story 11)
- src/lib/smoke-template.ts (shared renderer)
- docs/smoke/omcp-team-parity/phase1-verify-fix-loop-deterministic-attestation.md
- docs/smoke/omcp-team-parity/phase3-chain-deterministic-attestation.md
