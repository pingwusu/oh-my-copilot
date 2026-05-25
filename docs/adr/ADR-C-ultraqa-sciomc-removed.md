# ADR — v1.8 ultraqa + sciomc mode removal

**Status**: Decided (executed in v1.8)
**Date**: 2026-05-25
**Plan reference**: docs/plans/v1.8-to-v2.0-ralplan-iter3.md Section L#2

## Context

During critic-iter2 review, CRITICAL-NEW-1 flagged that `ultraqa` and `sciomc`
appeared as string literals in `LOOPING_MODES` (mode.ts) but had no backing
state-module implementations — `src/lib/ultraqa-*.ts` and `src/lib/sciomc-*.ts`
never existed in the repository. Iter-3 verification confirmed this. The modes
were hollow: they received `--autopilot --yolo` flags from the CLI dispatch
path, but the skills themselves had no state, no completion criterion, and no
e2e verification. The "no kicking can" principle in the v1.8 plan required an
in-version solution rather than a v1.9 deferral.

## Decision

Remove `ultraqa` and `sciomc` from LOOPING_MODES per option C (lightweight
CHANGELOG-tagged removal).

## Drivers

- critic-iter2 CRITICAL-NEW-1 verified no state-module backing exists
- "no kicking can" principle requires an in-version solution
- Option A (shared-mode-state only) delivers no user-visible value — the modes
  would still dispatch to non-existent skill content
- Option B (build minimal state modules) is substantial work (~4h) for two
  modes that have no skill content yet and no user-facing stories in scope
- Option C is the smallest correct change: removes the hollow entries, updates
  tests to assert the new contract, and documents the decision and re-introduction
  path here

## Consequences

- Default LOOPING_MODES = 4 (ralph, autopilot, ultrawork, team) instead of 6
- Users who set OMCP_MODE=ultraqa or sciomc will reach the one-shot dispatch
  path (no --autopilot, no --yolo) rather than an autonomous loop
- Re-introduction path: when state modules + skill content land for either
  mode, add the name back to LOOPING_MODES with a corresponding state module,
  skill implementation, and e2e smoke test
