# Phase 3 Chain Orchestration — Deterministic Attestation (US-omcp-parity-P3)

**Date**: 2026-05-25
**Mode**: deterministic (mock-spawn fallback per iter-2 H4)

## Environment

omcp v2.1.x N+2, Phase 3 chain orchestration.
Harness: `src/scripts/smoke-phase3.ts` (version 1.0.0).
Renderer: `src/lib/smoke-template.ts` (shared with P1 + future P4 smoke artifacts per iter-2 H4).
Trigger env: `OMCP_COPILOT_AUTH=missing` (CI mode; no real Copilot CLI invoked).
Pipeline simulated: `omcp ralplan --chain "fix README typo" --then team 2 --then ralph-verify`.

## Pre-condition

- No active chain-state.json on disk before the harness runs.
- No ralplan / team / ralph mode-state files present.
- Step list is parsed from the iter-2 plan example: 3-step chain (ralplan + team 2 + ralph-verify) per US-omcp-parity-P3-CHAIN-parser.

## Trigger

Sequence executed by `runPhase3DeterministicSmoke()`:
1. Build a 3-step ChainStep[] from the iter-2 plan canonical example.
2. Invoke `runChain` (Story 9) with a mock stepRunner that simulates each mode's mode-state.json write + exit-0 return.
3. Between consecutive steps, invoke `prepareTransition` (Story 10) to capture the 5-step atomic handoff sequence:
   - Handoff 1: ralplan → team (non-exclusive to-mode → step 4 clear is SKIPPED per Architect S2)
   - Handoff 2: team → ralph (exclusive to-mode → step 4 clears team-state per S2)
4. Read the final `chain-state.json` marker (status=completed, completedSteps=[1,2,3]).
5. Probe `propagateCancelToChain` (Story 12) on the now-terminal chain — must report chainWasActive=false (Story 12 idempotence on terminal status).

## Output

```
harness cwd=C:\Users\RUNJIA~1\AppData\Local\Temp\omcp-smoke-p3-jtjISi
step1: starting verb=ralplan args=["fix-readme-typo"]
step1: ralplan completed → ralplan-state.json written
step2: starting verb=team args=["2","executor"]
step2: team completed (workers=2 done=2 fix_loop_count=0); team-wait exit=0
step3: starting verb=ralph args=["ralph-verify"]
step3: ralph completed → ralph-state.json written
chain runner exit=0 status=completed
handoff1 (ralplan→team): clearedFromMode=false (non-exclusive to-mode)
handoff2 (team→ralph): clearedFromMode=true (exclusive to-mode)
final chain-state.json status=completed completedSteps=[1,2,3]
cancel probe on terminal chain: chainWasActive=false (must be false)
```

Key invariants verified by this trace:
- runChain writes status='running' markers before each step + final status='completed' after all 3 steps pass.
- prepareTransition writes per-step chain-handoffs/step-N.json snapshots (Story 10 + Story 11's Phase 1 field preservation contract).
- Asymmetric clear: non-exclusive to-mode (team) leaves ralplan state in place; exclusive to-mode (ralph) clears the prior team state (Architect S2).
- Story 12 cancel propagation correctly treats a terminal chain as inactive (idempotent no-op).

## Verdict

PASS — deterministic. All Phase 3 stories participate: CHAIN-parser (steps were spec-shaped), CHAIN-runner (sequential exec + crash-resume marker), CHAIN-state-handoff (5-step atomic handoff with asymmetric clear), CHAIN-preserve-P1-teamstate (snapshots include the team's TeamState fields verbatim — verified separately at the integration test in src/__tests__/chain-preserve-p1-teamstate.test.ts), CHAIN-cancel-propagation (Story 12 idempotent on terminal chain), TEAM-WAIT-cli (poll-to-completed exits 0 in this trace). Live-mode equivalent is gated on `copilot login`; the section structure here matches the Phase 1 deterministic attestation via src/lib/smoke-template.ts. Tag-gate per iter-2 §RELEASE-cut still requires ≥1 live-smoke artifact across P1/P3/P4.

## References

- docs/plans/omcp-team-omc-parity-iter2.md (US-omcp-parity-P3-CHAIN-smoke-artifact)
- src/cli/commands/chain.ts (runChain + prepareTransition + propagateCancelToChain)
- src/cli/commands/team-wait.ts (Story 13)
- src/lib/smoke-template.ts (shared renderer)
- docs/smoke/omcp-team-parity/phase1-verify-fix-loop-deterministic-attestation.md (P1 companion)
