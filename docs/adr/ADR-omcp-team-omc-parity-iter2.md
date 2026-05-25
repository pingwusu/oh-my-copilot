# ADR: omcp team → omc team Feature Parity (iter-2)

**Date**: 2026-05-25
**Status**: Accepted (v2.1 N+3 Session)
**Author**: pingwusu (v2.1 N+3 Story 18)
**Related**:
- `docs/plans/omcp-team-omc-parity-iter2.md` (the canonical 20-story plan + iter-2 RALPLAN-DR consensus)
- `docs/adr/ADR-omcp-cancel-semantics.md` (Story 12 mid-step cancel semantics)
- `docs/adr/ADR-omcp-status-fix-loop-count-deferred.md` (status surface deferred to N+3 follow-up)
- `docs/adr/ADR-v2.0-public-release-deferred.md` (v2.0 LOCAL-tag precedent that v2.1 follows)

---

## Context

omcp's team-mode primitive ships fire-and-forget worker spawns with no
verify/fix loop, no inter-step state preservation, and no chain orchestration
across modes. The omc analogue (oh-my-claudecode) ships a 5-stage
`plan → prd → exec → verify → fix → loop` machine plus
inbox/outbox/heartbeat IPC. The gap analysis (committed in the v2.0
ralplan trace) identifies four user-visible gaps:

- **Gap 1** — verify/fix self-correction loop missing (CRITICAL).
- **Gap 2** — IPC mesh (inbox / outbox / heartbeat) missing (medium ROI).
- **Gap 3** — worker status auto-tracking absent (low cost via ack extend).
- **Gap 4** — shutdown protocol polish (low cost).

The iter-2 plan ran two ralplan iterations with architect + critic reviews;
both reviewers ITERATE'd on iter-1 with convergent recommendations toward
the `Option B-minus` scope. This ADR records the decision so future ralplan
iters can re-evaluate without re-deriving the trade-off matrix.

## Decision

**Option B-minus: ship Gap 1 + Gap 3 + Gap 4 + chain orchestration; defer
Gap 2 IPC mesh behind a user-signal gate (EB-omcp-parity-06).**

Concrete delivery:
- **Phase 1 (N+1, 6 stories)** — verify/fix loop: doctor-verify-spawn-shape,
  team-verify CLI runner, collect-needsfix-shortcircuit, fix-worker-spawn,
  loop-bounding (max-fix-loops env override), Phase 1 deterministic smoke.
- **Phase 2.5 (1 story, N+2 lead-in)** — team-ack `--status` flag (Gap 3).
- **Phase 3 (8 stories, N+2)** — chain parser, chain runner with
  chain-state.json marker, 5-step atomic state-handoff, preserve-P1-teamstate
  through handoff, cancel-propagation, team-wait CLI, ralph SKILL dispatch
  guide, Phase 3 deterministic smoke.
- **Phase 4 (5 stories, N+3)** — worker-ack-skill update, full-stack
  integration smoke, **this ADR**, CHANGELOG entry, release cut with
  live-smoke tag-gate.

**Deferred** (NOT cancelled): Phase 2 IPC primitives — outbox-write-helper,
outbox-read-cursor, inbox-write-helper, heartbeat-write-poll,
worker-skill update for IPC, IPC smoke. Preserved verbatim in iter-2 plan
Appendix B for direct lift into a future ralplan iter when EB-06 fires.

## Drivers (top 3)

1. **Behavioral-parity ROI vs implementation cost.** Gap 1 is the highest-ROI
   gap — without it omcp team is fire-and-forget while omc team self-corrects.
   Gap 3 piggybacks on the existing `team-ack` for ~1 story of incremental
   work. Gap 2 (IPC) is medium ROI — useful but workers can already coordinate
   via shard JSON, and shipping verify/fix + chain delivers most of the
   omc-parity user-visible behavior. Gap 4 is low cost doc-only updates.

2. **Copilot CLI primitive constraints.** Copilot workers cannot run
   Task() API; they only have shell + omcp CLI. This forecloses 100%
   mesh parity and forces a file-based protocol. For iter-2 this means
   the chain orchestrator polls TeamState directly (not heartbeat freshness)
   — sufficient for the chain use case at the cost of slower dead-worker
   detection. The existing `runTeamWatchdog` mtime probe remains the
   floor.

3. **Cross-mode contamination risk.** Ralph and Team both write
   mode-state.json. When `--chain` orchestrates ralplan → team → ralph,
   state pivot races (ralph stomping team-state mid-run) are a real
   failure mode. The 5-step atomic state-handoff sequence — read →
   snapshot → chain-state-write → clear → spawn — closes this with an
   explicit crash-survivor vitest. MODE_CONFIGS exclusivity
   (`src/runtime/mode-state.ts:77-86`) drives the asymmetric clear:
   from-mode state is cleared only when to-mode is mutually-exclusive
   (ralph, autopilot, ultrawork, ultraqa, ultragoal). Non-exclusive
   to-modes (team, ralplan, sciomc) coexist with the prior mode's state.

## Alternatives Considered

### Option A — Minimal verify/fix bolt-on, no chain

- **Scope**: Phase 1 (Gap 1) + Phase 2.5 (Gap 3) + Phase 4 polish. Skip
  Phase 3 chain orchestration entirely.
- **Pros**: Smallest blast radius. Ships in 2 sessions.
- **Cons**: Drops the user-requested Phase 3 ralph/team mixed-orchestration.
- **Rejection rationale**: Both reviewers agreed Phase 3 should remain in
  scope; Option A was kept as the fallback only if Phase 3 architect-iter
  produced ITERATE with >3 hard issues. Phase 3 reviews ultimately
  produced APPROVE; the fallback did not fire.

### Option B (historically considered) — Verify/fix + chain + FULL IPC mesh

- **Scope**: All 4 gaps including 6-story Phase 2 IPC mesh
  (outbox/inbox/heartbeat/worker-skill-IPC/IPC-smoke).
- **Pros**: Full omc-mesh parity.
- **Cons**: Iter-1 Option B carried 6 extra stories with high implementation
  cost (NTFS append concurrency, multi-process race coverage) for unclear
  short-term ROI. Phase 3 iter-1 acceptance criteria polled TeamState
  directly WITHOUT referencing the IPC primitives Phase 2 was building —
  a self-contradiction the architect flagged at the iter-1 review (H1
  smoking gun in iter-2 changelog).
- **Rejection rationale**: Demoted to "historically considered, EB-06-gated."
  Iter-1 Option B story IDs (verbatim) preserved in iter-2 plan
  Appendix B for direct lift-into a future ralplan iter when EB-06 fires.

### Option B-minus — Verify/fix + chain orchestration (no IPC mesh) — ACCEPTED

See Decision section above.

## Why Option B-minus Chosen

- **Reviewer convergence.** Both architect + critic ITERATE'd on iter-1
  with convergent recommendations to drop the Phase 2 IPC stories.
  Iter-2 RALPLAN-DR converged on Option B-minus at the second iteration
  (architect APPROVE, critic APPROVE).
- **Single-source-of-truth contract.** Phase 3 acceptance criteria pull
  state directly from TeamState (via runTeamCollect, runTeamWait, and
  the chain-handoff snapshot). No primitive Phase 2 was building was
  load-bearing for Phase 3 — the iter-1 dependency claim was
  self-contradictory.
- **EB-06 user-signal gate.** Phase 2 IPC is not cancelled, just deferred
  until ≥1 external user reports IPC mesh as a workflow blocker.
  Building 6 stories of IPC primitives speculatively conflicts with
  "用事实说话" (let evidence drive the build).

## Consequences

### Visible to users in v2.1.0

- **`omcp team-verify <sid>`** runs vitest + tsc + biome and writes a
  verify report + per-worker failure signals.
- **`omcp team-collect <sid>`** transitions to `fixing` when verify-fail
  signals are present + writes the aggregated summary.
- **`omcp team-fix <sid>`** spawns a debugger fix-worker (bound by
  `--max-loops`, default 3, env `OMCP_TEAM_MAX_FIX_LOOPS`).
- **`omcp team-ack --status <state>`** records worker disposition
  atomically in TeamState.workers[K].status.
- **`omcp team-wait <sid>`** blocks on terminal phase (poll, no IPC).
- **`omcp ralplan --chain "..."`** orchestrates ralplan → team → ralph
  pipelines with crash-resumable chain-state.json marker.
- **`omcp cancel`** auto-detects active chains and propagates the cancel
  signal into the current step's mode-state (per
  `ADR-omcp-cancel-semantics.md`).

### Visible to users as a "deferred" item

The v2.1.0 CHANGELOG documents the IPC mesh gap as deferred-not-missing
with explicit pointer to EB-omcp-parity-06 and iter-2 plan Appendix B.
Users mixing omc + omcp workflows will notice the asymmetry — the
documented expectation is "manual ralplan→team→ralph orchestration via
the new `--chain` flag; no inbox/outbox/heartbeat coordination between
workers."

### Visible to maintainers

- The chain orchestrator polls TeamState directly. Dead-worker detection
  still depends on shard mtime via the existing `runTeamWatchdog`. This
  is acceptable until EB-06 fires.
- The 5-step atomic state-handoff is the canonical cross-mode contract.
  Adding new modes that participate in chains requires honoring the
  MODE_CONFIGS exclusivity asymmetry (and adding the verb to
  `CHAIN_STEP_VERB_TO_MODE` in `src/cli/commands/chain.ts` if cancel
  propagation should hit the mode-state).
- The deterministic-fallback smoke contract requires every new smoke
  artifact to go through `src/lib/smoke-template.ts`. The shared
  template's canonical 5-section order (Environment, Pre-condition,
  Trigger, Output, Verdict) is locked by drift-detection vitest across
  P1 + P3 + P4 — any new consumer (e.g., P5 if introduced) must comply.

## Follow-ups

1. **EB-omcp-parity-06 revival path** — When ≥1 external user reports
   IPC mesh as a workflow blocker, spawn a new ralplan iter to
   rebuild the 6 deferred stories from Appendix B. The iter-1
   Option B story IDs are preserved verbatim for direct lift:
   `US-omcp-parity-P2-OUTBOX-write-helper`,
   `US-omcp-parity-P2-OUTBOX-read-cursor`,
   `US-omcp-parity-P2-INBOX-write-helper`,
   `US-omcp-parity-P2-HEARTBEAT-write-poll`,
   `US-omcp-parity-P2-WORKER-SKILL-update`,
   `US-omcp-parity-P2-IPC-smoke-artifact`.
   EB-omcp-parity-02 (outbox schema ADR) and EB-omcp-parity-05
   (heartbeat freshness threshold ADR) re-activate when EB-06 fires.

2. **`omcp status` fix_loop_count surface** — Deferred during N+1 via
   `ADR-omcp-status-fix-loop-count-deferred.md`. N+3 (this session) was
   the documented landing target, but the status revamp is coupled to
   the HUD pipeline rewrite which exceeds the v2.1.0 budget. Re-targeted
   to v2.1.x post-release polish (no new ADR needed; the existing
   deferral ADR captures the rationale + implementation sketch).

3. **Live-smoke captures** — At least one of P1/P3/P4 must capture a
   real-Copilot smoke artifact before the v2.1.0 LOCAL tag cuts. The
   release-time script `src/scripts/check-live-smoke.ts` (Story 20)
   scans the 3 smoke artifacts for the canonical model-id signature
   (`gpt-`, `claude-`) and exits 1 if all 3 are deterministic-only.

4. **npm publish remains [USER_REQUIRED]** per
   `ADR-v2.0-public-release-deferred.md`. The v2.1.0 LOCAL tag is
   internal; the marketplace listing waits for the same channel
   availability gate that v2.0 still pends on.

## Tracking

- Plan source: `docs/plans/omcp-team-omc-parity-iter2.md` (committed
  in iter-2 RALPLAN-DR consensus pass at HEAD 08d8263).
- Decision-record landing: this ADR (Story 18, N+3 session).
- Cancel-semantics sub-ADR: `docs/adr/ADR-omcp-cancel-semantics.md`
  (Story 12, N+2 session).
- Status-deferral sub-ADR: `docs/adr/ADR-omcp-status-fix-loop-count-deferred.md`
  (Story 5 supplement, N+1 session).
- 20 commits implement the plan across N+1 (10 commits including
  follow-ups), N+2 (9 commits), N+3 (this commit + 2 more).
