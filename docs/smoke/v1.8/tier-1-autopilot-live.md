# v1.8 Tier 1 — autopilot live verify smoke

**Story**: US-1.8-T1-MODE-autopilot-live
**Date**: 2026-05-25
**HEAD**: `4be562d`
**Plan reference**: docs/plans/v1.8-to-v2.0-ralplan-iter3.md US-1.8-T1-MODE-autopilot-live

## Spawn attempt

```
$ node <abs>/dist/cli/omcp.js autopilot "<task>" --max-iterations 3
```

**Discovery during smoke**: The autopilot CLI supports `--max-continues` (Copilot CLI native flag) rather than ralph-style `--max-iterations`. The latter is ralph-mode only. Verified by reading `src/cli/commands/mode.ts` ModeOptions interface — `maxContinues` is the autopilot-applicable field; `maxOuterIterations` is ralph-only.

Subagent was killed before completing a corrected re-spawn with the right flag, so a full phase-marker capture is not in this artifact.

## Observable evidence

- CLI surface confirmed: `omcp autopilot <task>` (looking up in `src/cli/omcp.ts`) is a registered LOOPING_MODE. 
- `mode.ts:LOOPING_MODES` Set (post ultraqa/sciomc removal) contains `autopilot` ✓
- US-05 cost-summary state writer (commit 974a438) is wired in `runMode` outer loop — autopilot mode spawn would produce `cost-summary.json` entries.
- Determinstic test for cost-summary wiring already verified at N+1: `src/__tests__/mode-cost-summary-wiring.test.ts` 3/3 pass (commit 974a438).

## Acceptance assessment

| Criterion | Result |
|---|---|
| Spawn exit code | NOT CAPTURED — subagent stopped mid-task |
| stdout phase markers (spec/plan/execute) | NOT CAPTURED |
| Tmp dir produces spec file | NOT CAPTURED |
| cost-summary.json entry | NOT VERIFIED (subagent didn't capture state files) |

## Verdict

**BLOCKED-AGENT-ITERATION** — autopilot mode is structurally present (CLI registered, LOOPING_MODES entry, US-05 wiring); however, full phase-marker capture from a real Copilot autopilot session did not complete within this ralph iteration. The subagent identified the correct flag (`--max-continues` not `--max-iterations`) but was stopped before re-spawning.

## Carry-forward for v1.8 cut + N+3

This smoke artifact documents v1.8 surface presence; full e2e phase verification requires:
1. A dedicated session with `--max-continues 3` (NOT `--max-iterations`)
2. Stdout phase-marker capture (per-iteration Copilot output watching)
3. Tmp dir spec-file verification

Per iter-3 plan ceiling-honesty (line 96-104), this is acceptable session-overflow — N+3 should re-run autopilot smoke with the corrected flag.

## Invariants cited

- **Invariant 2**: `src/runtime/mode-state.ts:138` writes mode-state via atomicWriteFileSync (shared writer covers all LOOPING_MODES — already verified at N+1).

## References

- mode.ts: `src/cli/commands/mode.ts` (LOOPING_MODES set)
- autopilot flag: `--max-continues` (Copilot native), not `--max-iterations` (ralph-specific)
- cost-summary state: `src/lib/cost-summary-state.ts`
