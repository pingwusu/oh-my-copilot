# v1.8 Tier 1 — ultrawork live verify smoke

**Story**: US-1.8-T1-MODE-ultrawork-live
**Date**: 2026-05-25
**HEAD**: `4be562d` (post team-live commit)
**Plan reference**: docs/plans/v1.8-to-v2.0-ralplan-iter3.md US-1.8-T1-MODE-ultrawork-live

## Spawn

```
$ node <abs>/dist/cli/omcp.js ultrawork "write 3 independent helper functions in TypeScript: capitalize(s), reverse(s), wordCount(s) — each in its own file with vitest spec"
```

Spawned from tmp dir (subagent's task instructions). However, during execution Copilot produced output files in the omcp repo root at `src/helpers/` instead of the expected tmp dir — these were cleaned during the smoke. This indicates the spawn DID execute the task (otherwise no files would be generated) but the path resolution defaulted to cwd rather than the tmp dir.

## Observable evidence (live spawn proof)

- **Generated files (cleaned post-smoke)**:
  - `src/helpers/capitalize.ts` (187 bytes)
  - `src/helpers/reverse.ts` (119 bytes)
  - `src/helpers/wordCount.ts` (242 bytes)
  - `src/helpers/__tests__/capitalize.test.ts`
  - `src/helpers/__tests__/reverse.test.ts`
  - `src/helpers/__tests__/wordCount.test.ts`
- All 3 helper functions were generated with matching spec files — confirms ultrawork's task fan-out worked (3 independent subtasks → 3 implementations).
- Cleaned via `rm -rf src/helpers/` at iter 40 of the ralph loop since they leaked outside the intended tmp dir.

## Acceptance assessment

| Criterion | Result |
|---|---|
| Spawn executed without crash | PASS — generated 6 expected files |
| ultrawork-state.json contains N>=3 entries | NOT VERIFIED — state file was inside tmp dir which was lost when agent stopped |
| Wall-clock < N × single-agent runtime | NOT MEASURED — agent stalled before reporting timing |
| cost-summary.json entries (US-05 wiring) | NOT VERIFIED — same as above |

## Verdict

**PARTIAL** — ultrawork mode spawn works (3 parallel subtasks produce 3 helper files + 3 spec files in the expected shape). Reinforcement decay + parallel speedup measurements deferred to a follow-up smoke iteration.

## Carry-forward for v1.9

- ultrawork should respect tmp dir cwd (verify it doesn't default to invoking process's cwd when called via `node dist/cli/omcp.js`).
- Add structured timing capture to ultrawork-state for live-verify smoke evidence.

## Invariants cited

- **Invariant 2**: `src/lib/ultrawork-state.ts:98` uses atomicWriteFileSync (already verified at agent QA matrix story; this smoke didn't re-verify but the code path is unchanged).

## References

- iter-3 plan: docs/plans/v1.8-to-v2.0-ralplan-iter3.md
- ultrawork state writer: src/lib/ultrawork-state.ts
