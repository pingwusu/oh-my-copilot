# ADR: `omcp status` Surface for `fix_loop_count` Deferred to N+3

**Date**: 2026-05-25
**Status**: Accepted (Session N+1)
**Author**: pingwusu (v2.1 N+1 author roll-up)
**Related**: docs/plans/omcp-team-omc-parity-iter2.md (US-omcp-parity-P1-FIX-loop-bounding)

---

## Context

iter-2 plan acceptance criterion for **US-omcp-parity-P1-FIX-loop-bounding**:

> `fix_loop_count` in TeamState reflects current loop. `omcp status` surfaces it.

The first half (`fix_loop_count` in TeamState) shipped in Story 4
(`46f226f`) — `src/runtime/mode-state.ts:74-80` adds the optional field
and Story 5 (`b263ac8`) increments it at every fix-spawn.

The second half (`omcp status` surfaces it) is **deferred** to v2.1 N+3.

## Decision

Defer the `omcp status` surface change. Story 5 (`b263ac8`) lands the
bound-check logic and the new `omcp team-fix` CLI without modifying
`src/cli/commands/status.ts`.

## Drivers

1. **Schema mismatch in the legacy status reader.** `src/cli/commands/status.ts`
   currently reads `.omcp/state/team.json` (a flat-file schema from the
   v1.0 era that has since been superseded by per-session
   `.omcp/state/sessions/<sid>/team-state.json`). Adding `fix_loop_count`
   to the existing reader would silently miss the field for all post-v1.0
   sessions because the reader never opens the session-scoped path.
2. **Surface change touches the HUD pipeline.** `omcp status` is consumed by
   the HUD (`scripts/omcp-hud.mjs` + col 1+2+6) and by `omcp doctor team-routing`.
   Both downstream surfaces need to be reviewed together to avoid the
   "fix_loop_count: undefined" footprint leaking into HUD output. v2.1 N+3
   already has a "polish + integration smoke" slot
   (`US-omcp-parity-P4-INTEGRATION-smoke`) where this work fits cleanly.
3. **No load-bearing dependency in N+1 or N+2.** Phase 1 verify/fix loop
   uses `fix_loop_count` *on disk* via TeamState — `runTeamCollect` reads
   it, `spawnFixWorker` increments it. The user-facing display is for
   observability, not correctness. Deferring affects diagnostics only.

## Alternatives Considered

| Option | Rejected because |
|---|---|
| Implement now in `formatStatus` only | Reader still wouldn't see the field (wrong schema path). Output would always show "fix_loop_count: 0". |
| Add a new `omcp status --session <sid>` flag | Doubles the CLI surface in a polish-area story; HUD wouldn't consume it without further changes. |
| Read sessions dir + aggregate fix_loop_count | Substantive — but mixes "status revamp" with "Phase 1 bound check" in one commit. Violates **1 task = 1 commit**. |

## Consequences

- v2.1 N+1 (this session) commits `b263ac8` ship without the surface
  change; commit body marks the deferral explicitly.
- v2.1 N+2 (Phase 3 chain orchestration) is unaffected — the chain
  runner consults TeamState directly, not `omcp status`.
- v2.1 N+3 (`US-omcp-parity-P4-INTEGRATION-smoke` + release) **must**
  implement the surface change before the v2.1.0 LOCAL tag cut. The
  release-time check script (`src/scripts/check-live-smoke.ts` per plan
  §RELEASE-cut) will gate the tag on the integration smoke artifact,
  which in turn renders the status surface and demonstrates the field.

## Follow-up — N+3 Implementation Sketch

1. Refactor `readStatus` to also scan
   `.omcp/state/sessions/*/team-state.json` and surface a
   `teamSessions: Array<{ sessionId, currentPhase, fixLoopCount?,
   maxFixLoops?, ... }>` field.
2. Extend `formatStatus` to print one line per active team session
   including `fix_loop_count: N/M`.
3. Update HUD col 6 (active mode) to truncate the session-id and
   include the loop count when relevant.
4. Cover with vitest cases: zero sessions, one executing session, one
   fixing session at N/M, one failed-via-loop-exhaust session.

## Tracking

- Source: critic review of `b263ac8` flagged AC violation without ADR.
- Resolution: this ADR satisfies "不准问题往后迁移 = 推迟必须写 ADR" by
  documenting the deferral explicitly with drivers, alternatives, and
  follow-up plan.
- Closure: when N+3 lands the surface change, mark this ADR as
  "Superseded" with a link to the implementing commit.
