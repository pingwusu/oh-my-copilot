# omcp team → omc team feature parity + ralph/team mixed orchestration — iter-2

**Author**: Planner (ralplan iter-2, deliberate mode)
**Date**: 2026-05-25
**Baseline**: HEAD = `f66e7bc` (post v2.0.0-rc.1, CI green, Windows-first)
**Status**: ITER-2 revision applying Architect + Critic consolidated feedback (both ITERATE on iter-1)
**Mode**: `--deliberate` (high-risk multi-system work: verify/fix loop + chain orchestration; Phase 2 IPC primitives now DEFERRED)
**Scope**: close Gap 1 (CRITICAL verify/fix) + Gap 3 (worker status via team-ack extend) + Gap 4 (shutdown polish) AND deliver Phase 3 chain orchestration. Gap 2 (IPC mesh) deferred per EB-omcp-parity-06 user-signal gate.
**Predecessor**: `.omcp/plans/omcp-team-omc-parity.md` (iter-1; 25 stories; both reviewers ITERATE)

---

## Iter-2 changelog (delta from iter-1)

The 8 consolidated edit blocks below were applied. Each lists provenance
back to the Architect/Critic verdict that motivated it.

1. **H1 — Adopted Option B-minus**: Phase 2 IPC primitives (outbox/inbox/
   heartbeat/worker-skill IPC update/IPC smoke = 6 stories) DROPPED.
   Phase 2.5 ack-status-flag (Gap 3) PRESERVED and promoted to its own
   Phase 2 slot. Decision Drivers + Viable Options sections rewritten;
   iter-1 Option B documented as "historically considered + rejected"
   alongside fresh Option B-minus. Resolves the iter-1 contradiction
   where Phase 3 stories claimed to depend on heartbeat/outbox but their
   acceptance criteria never referenced those primitives.

2. **H2 — `team-collect --watch` deferred**: Story dropped with the rest
   of Phase 2 IPC. The `--watch` flag was undelivered in iter-1 (only
   `hud` exposes `--watch`; grep on src/cli/omcp.ts confirmed). Iter-2
   Phase 3 stories poll TeamState.current_phase directly per the
   pre-existing P3-TEAM-WAIT-cli design — no `--watch` dependency.

3. **H3 — Reconciled chain handoff write-order to single path**:
   Adopted option (a) — `US-omcp-parity-P3-CHAIN-state-handoff` now
   prescribes a deterministic 5-step write sequence: `read from-mode
   state → write snapshot to chain-handoffs/<step-N>.json → write
   chain-state.json atomically → clear from-mode state → spawn to-mode`.
   Pre-mortem scenario 3 rewritten to match this sequence. Added
   explicit vitest case: "crash between snapshot+chain-state write and
   from-mode clear → both files coexist, postmortem-recoverable".

4. **H4 — Deterministic CI fallback for all 3 remaining smoke stories**:
   `P1-VERIFY-smoke`, `P3-CHAIN-smoke`, `P4-INTEGRATION-smoke` each
   gained a `Deterministic fallback` sub-criterion: when env var
   `OMCP_COPILOT_AUTH=missing` is set (CI uses this), the smoke harness
   runs against a mock-spawn fixture and writes a sibling
   `<phase>-deterministic-attestation.md` artifact matching the live
   shape. Live smoke (real Copilot) remains the tag-gate requirement;
   deterministic attestation unblocks the session for downstream stories.

5. **H5 — Option C invalidation rationale narrowed**: iter-1's blanket
   Option C rejection was non-responsive to the user's actual request
   (verify/fix + chain — NOT IPC primitives). Replaced with narrow-scope
   deferral: Option B-minus ships now; Phase 2 IPC re-builds are gated
   by **new EB-omcp-parity-06**: "≥1 external user reports IPC mesh as
   blocker for their workflow." Until then, the workflow gap is
   acknowledged and documented in the v2.1.0 CHANGELOG.

6. **Architect #2 — Write-order pinned in US-P3-CHAIN-state-handoff**:
   Acceptance criterion expanded to specify atomic write order +
   crash-survivor vitest case (see point 3). Single source of truth: no
   competing definitions in pre-mortem vs acceptance criteria.

7. **Architect #3 — New story US-P3-PRESERVE-Phase1-TeamState fields**:
   added to Phase 3 (between state-handoff and team-wait) to guard
   cross-mode contamination of Phase 1 verify/fix loop counters. Test
   shape spelled out: 4-worker team → verify fails once → fix-worker
   increments fix_loop_count=1 → chain handoff runs → ralph state
   snapshot includes fix_loop_count=1 for postmortem.

8. **Architect #5 (revised) + S2 + S4**:
   - Architect #5 Windows NTFS append-race: VERIFIED moot for iter-2
     because Phase 2 append-only stories are dropped and team-ack.ts
     uses `atomicWriteFileSync` (rewrite, not append). Acceptance
     criterion on US-P2.5-ACK-status-flag now includes 8-process
     `child_process.spawn` concurrent test (NOT vitest pool=threads
     which shares NTFS handles) to catch atomic-rewrite races on
     parallel TeamState updates.
   - S2: US-P3-CHAIN-state-handoff now documents the from-mode
     clearing asymmetry — required only when to-mode is `mutuallyExclusive:
     true` (currently: ralph, autopilot, ultrawork, ultraqa, ultragoal
     per `src/runtime/mode-state.ts:77-86`).
   - S4: v2.1.0 LOCAL tag in US-P4-RELEASE-cut gated on ≥1 live-smoke
     captured (P1 OR P3 OR P4 smoke — any one real-Copilot attestation
     satisfies the tag gate). Mirrors ADR-v2.0-public-release-deferred
     precedent (LOCAL tag with deferred npm publish).

---

## Provenance — which inputs drive which sections

| Section | Primary input | Rationale |
|---|---|---|
| Iter-2 changelog | Consolidated Architect+Critic verdicts on iter-1 | Top-of-file delta surface for re-reviewers |
| Principles + Decision Drivers | RALPLAN-DR consensus protocol + iter-1 retained where unaffected by Option B-minus pivot | Step-2 re-alignment surface |
| Viable Options A / B-minus, + historical-B | Architect+Critic convergent recommendation | Need ≥2 viable; iter-1 Option B (full IPC) demoted to "historically considered + rejected" with EB-06 gate |
| Phase 1 stories | omc 5-stage state machine; existing `runTeamCollect` fixing-on-conflict (src/cli/commands/team-phase-controller.ts:178-249) | Reuse-first; unchanged from iter-1 |
| Phase 2 (ACK extend only) | omcp existing `team-ack` CLI (src/cli/commands/team-ack.ts uses atomicWriteFileSync) | Only Gap 3 extension survives iter-2 |
| Phase 3 stories | iter-1 Phase 3 minus IPC-leak assumptions; H3 + Architect #2 + Architect #3 applied | Bridge ralplan → team → ralph for omc-style flows, IPC-free |
| Session map | Compressed from 4 to 3 sessions (Phase 2 IPC removed) | Per-session ≤8-18 commits + stop-and-replan rule preserved |
| Pre-mortem 3 scenarios | Re-derived for B-minus shape | Drop IPC concurrency scenario; add deterministic-fallback fragility scenario |
| Expanded test plan | Per-Phase unit/integration/e2e/observability matrix | Deliberate mode requirement; Phase 2 row removed; Phase 1/3/4 rows updated |
| ADR | RALPLAN-DR final consensus output | post-iter-2 Architect/Critic approval |

---

## RALPLAN-DR consensus alignment surface (Architect/Critic step-2)

### Principles (3-5)

1. **Reuse-first, no greenfield re-implementation.** `runTeamCollect`
   already transitions to `fixing` when shards conflict. Extend that
   surface to also transition into `fixing` when verify checks fail.
   `team-ack` already writes ack JSON — extend it with `--status` flag
   rather than introducing a new CLI verb.

2. **Copilot-portable primitives only.** Any worker-side write must be
   reachable from a Copilot CLI skill (`omcp <verb>` shell invocation).
   No reliance on Claude-only Task() auto-tracking. The 9 invariants
   apply (atomicWriteFileSync, assertSafeSlug, etc.).

3. **One story = one commit.** No codebase-wide audits. Use the v1.9
   `ERRORS-actionable` lesson: split big stories into 4 sub-stories
   rather than land a mega-commit. Each story has a single
   `Commit shape:` line.

4. **Tag-gate = live evidence + deterministic fallback for CI.** Each
   Phase ends with a smoke artifact under
   `docs/smoke/omcp-team-parity/<phase>-<topic>.md` capturing real
   Copilot output. CI can run a deterministic mock-spawn fallback
   producing a sibling `*-deterministic-attestation.md` to unblock
   downstream stories, but the v2.1.0 LOCAL tag requires ≥1 live-smoke
   capture (any of P1/P3/P4).

5. **Defer-don't-cancel for Phase 2 IPC.** Option B-minus ships the
   user-requested deliverable (verify/fix + chain) without IPC mesh.
   Phase 2 IPC primitives are NOT cancelled — they're gated by
   EB-omcp-parity-06 (≥1 external user signal). When that signal
   arrives, a new ralplan iter rebuilds those 6 stories with proper
   smoke + concurrency tests. iter-1's Option B kept on file as
   "historically considered" for that future revival.

### Decision Drivers (top 3)

1. **Behavioral parity ROI vs implementation cost.** Gap 1 (verify/fix
   loop) is the highest-ROI gap — without it omcp team is fire-and-
   forget while omc team self-corrects. Gap 3 (status auto-tracking)
   piggybacks on existing `team-ack` for ~1 story of incremental work.
   Gap 2 (IPC) is medium ROI — useful but workers can already coordinate
   via shard JSON, and shipping verify/fix + chain delivers most of the
   omc-parity user-visible behavior. Gap 4 (shutdown polish) is low cost
   doc-only updates.

2. **Copilot CLI primitive constraints.** Copilot workers cannot run
   Task() API; they only have shell + omcp CLI. This forecloses 100%
   mesh parity and forces a file-based protocol. For iter-2, this means
   the chain orchestrator polls TeamState directly (not heartbeat
   freshness) — sufficient for the chain use case at the cost of
   slower dead-worker detection (the existing `runTeamWatchdog` mtime
   probe remains the floor).

3. **Cross-mode contamination risk.** Ralph and Team both write
   mode-state.json. When `--chain` orchestrates ralplan → team → ralph,
   state pivot races (ralph stomping team-state mid-run) are a real
   failure mode. Iter-2's US-P3-CHAIN-state-handoff prescribes a 5-step
   atomic sequence (read → snapshot → chain-state-write → clear → spawn)
   with explicit crash-survivor vitest. Mutual-exclusion in MODE_CONFIGS
   (`src/runtime/mode-state.ts:77-86` — `ralph: true`, `team: false`,
   `ralplan: false`) is honored asymmetrically: from-mode clearing is
   required only when to-mode is `mutuallyExclusive: true`.

### Viable Options (≥2)

#### Option A — Minimal verify/fix bolt-on, no chain

- **Scope**: Phase 1 (Gap 1 verify/fix) + Phase 2 ack-status-flag
  (Gap 3 via team-ack extension) + Phase 4 (Gap 4 polish, ADR, release).
  Skip Phase 3 chain orchestration entirely.
- **Pros**:
  - Smallest blast radius — extends `team-collect` and `team-ack` only.
  - Lowest cross-mode risk — no chain, no MODE_CONFIGS interactions.
  - Ships in 2 sessions.
- **Cons**:
  - Does NOT deliver the user-requested Phase 3 ralph/team mixed
    orchestration. Effectively rejects half the brief.
  - Closing Gap 1+3 without chain still leaves omcp+omc users mixing
    workflows manually.

#### Option B-minus — Verify/fix + chain orchestration (no IPC mesh) — RECOMMENDED

- **Scope**: Phase 1 (Gap 1) + Phase 2 ack-status-flag (Gap 3) + Phase 3
  chain orchestration (without IPC primitives) + Phase 4 polish/ADR/
  release. Phase 2 IPC mesh DEFERRED behind EB-06 user-signal gate.
- **Pros**:
  - Closes the user-requested gaps: verify/fix self-correction +
    ralplan→team→ralph chain orchestration + worker status visibility.
  - Avoids the IPC build-cost / race-risk that iter-1 Option B carried.
  - Chain orchestrator polls TeamState directly — sufficient
    primitive for the chain handoff use case. No "build IPC that
    nobody uses" anti-pattern.
  - 3 sessions vs iter-1's 4.
- **Cons**:
  - Workers stay isolated (no inbox/outbox). Hard to coordinate
    parallel refactors that touch shared files — but `--chain` partly
    mitigates by enforcing sequential phase order.
  - Heartbeat-based dead-worker detection still depends on shard mtime
    rather than dedicated heartbeat file (existing watchdog already
    does this — acceptable trade-off until EB-06 signal arrives).
  - omc parity gap remains partially visible: users mixing omc + omcp
    workflows will notice the IPC asymmetry. CHANGELOG documents this
    as "deferred" rather than "missing".

#### Option B (historically considered, iter-1) — DEMOTED, EB-06-gated

- **Original scope**: All 4 gaps + Phase 3 orchestration including full
  inbox/outbox/heartbeat IPC mesh.
- **Why rejected at iter-2**: Both Architect and Critic ITERATE'd on
  iter-1 with convergent recommendation toward Option B-minus. Phase 2
  IPC primitives introduced 6 stories (and the IPC smoke story that
  punted to undelivered `--watch`) with high implementation cost (NTFS
  append concurrency, multi-process race coverage) for unclear
  short-term ROI. Phase 3 acceptance criteria in iter-1 already polled
  TeamState directly without referencing the IPC primitives — a
  self-contradiction the reviewers flagged.
- **Revival path**: EB-omcp-parity-06 fires when ≥1 external user
  reports IPC mesh as a workflow blocker. Iter-1 Option B story IDs
  (US-omcp-parity-P2-OUTBOX-write-helper, ...-OUTBOX-read-cursor,
  ...-INBOX-write-helper, ...-HEARTBEAT-write-poll, ...-WORKER-SKILL-
  update, ...-IPC-smoke-artifact) are preserved verbatim in this
  document's Appendix B for direct lift-into a future ralplan iter.

**Decision (iter-2 recommends)**: **Option B-minus**, with Phase 3 as
the explicit ralph/team mixed-mode deliverable polling TeamState
directly (no IPC primitive dependency). Option A is the fallback if
Phase 3 architect-iter1 produces ITERATE with >3 hard issues. Option B
(full IPC) deferred to EB-06.

**Why Option A is NOT selected for iter-2**: It would drop the
user-requested Phase 3 chain orchestration, which both reviewers agreed
should remain in scope. Option A is the fallback after Phase 3 ITERATE,
not the iter-2 ship target.

---

## External-blocker register

| ID | Marker | Description | Resolution path |
|---|---|---|---|
| EB-omcp-parity-01 | `[USER_REQUIRED]` | Copilot CLI authenticated on test machine (for live-mode e2e per session N+1 P1 smoke, N+2 P3 smoke, N+3 P4 smoke) | User: `copilot login`; record in session attestation. Deterministic-fallback unblocks downstream stories per H4 |
| EB-omcp-parity-03 | `[ADR_DEFERRED]` | Cancellation propagation semantics (does `omcp cancel` kill in-flight verify? what about chain mid-run?) | Final story in Phase 3 writes ADR-omcp-cancel-semantics |
| EB-omcp-parity-04 | `[USER_REQUIRED]` | Live-mode `--chain` smoke run requires real Copilot CLI auth + ≥4 minutes of clock time (one ralplan + one team-2 + one ralph completion cycle) | User: schedule clock-time window; record N+2 attestation. Deterministic-fallback unblocks downstream stories |
| EB-omcp-parity-06 | `[USER_REQUIRED]` | **NEW (iter-2 H5)**: ≥1 external user reports IPC mesh (outbox/inbox/heartbeat) as a workflow blocker. Until this signal arrives, Phase 2 IPC primitives remain deferred and the v2.1.0 CHANGELOG documents the IPC gap as "deferred-not-missing" | User feedback channel (issues, support); when received, spawn `ralplan` iter to rebuild Phase 2 IPC from Appendix B story list |

(iter-1's EB-omcp-parity-02 [outbox schema ADR] and EB-omcp-parity-05
[heartbeat freshness threshold] are RETIRED with the IPC drop. They
become re-active when EB-06 fires.)

---

## Pre-mortem (3 scenarios) — deliberate mode (re-derived for B-minus)

### Scenario 1: Copilot CLI flag/env-var drift between versions

**Hypothesis**: Future Copilot CLI may rename `--allow-all-tools` or
change `-p` stdin semantics. Verify-worker spawns (`copilot -p "..."`)
inherit any such drift, silently no-opping the verify-fix loop. Fix-
worker spawn (debugger agent) suffers the same risk.

**Probability/Impact**: medium-low / high.

**Mitigation**: US-P1-DOCTOR-verify-spawn-shape asserts `copilot -p
"echo"` returns a recognizable model-id token (same shape as
US-1.8-T0-AUTH-precheck from iter-3 of v1.8→v2.0 ralplan).
US-P1-VERIFY-smoke-artifact captures real Copilot version banner +
actual stdout per session. Re-use existing cost-governor exit-handling
pattern (`src/cli/commands/mode.ts:386-410`).

### Scenario 2: Ralph/team cross-mode state contamination under `--chain`

**Hypothesis**: `--chain` sequentially transitions ralplan → team →
ralph. Crash mid-transition (e.g., team-collect succeeds but ralph-
spawn OOMs) leaves orphaned `team-state.json` + half-written
`ralph-state.json` (`outerLoopOwned=true`). Subsequent `omcp status`
shows two active modes — violates MODE_CONFIGS expectations because
ralph is `mutuallyExclusive: true`.

**Probability/Impact**: medium / medium-high (post-crash debug pain).

**Mitigation**: US-P3-CHAIN-state-handoff prescribes a single-source-
of-truth 5-step atomic sequence (per H3 / Architect #2):
1. Read from-mode state (e.g., team-state.json).
2. Write snapshot to `.omcp/state/chain-handoffs/<step-N>.json`
   (atomicWriteFileSync).
3. Write `chain-state.json` marker (atomicWriteFileSync) with
   `{currentStep, completedSteps, ts, status:"handing-off"}`.
4. Clear from-mode state via `rmSync` — but ONLY when to-mode is
   `mutuallyExclusive: true` (currently: ralph, autopilot, ultrawork,
   ultraqa, ultragoal). team/ralplan/sciomc to-mode skip the clear
   step (asymmetry documented per S2).
5. Spawn to-mode.

Crash after step 2 or 3: both files coexist; postmortem-recoverable.
Crash after step 4 but before step 5: chain-state.json + handoff
snapshot still present; the next `omcp status` reads chain-state.json
first and surfaces `currentStep=ralph, status=handing-off, partial=true`.
Explicit vitest: "kill -9 between snapshot+chain-state write and
from-mode-clear → assert chain-handoffs/2.json AND chain-state.json
AND from-mode-state.json all coexist".

US-P3-CHAIN-cancel-propagation guarantees `omcp cancel` clears
chain-state.json + prior mode-state, leaving no orphans.

### Scenario 3: Deterministic-fallback drift from live-shape

**Hypothesis (NEW iter-2)**: The H4 deterministic-fallback smoke
attestations (`<phase>-deterministic-attestation.md`) drift in shape
from real-Copilot live smoke artifacts. Downstream stories pass
deterministic-fallback CI but break in live-smoke at the tag gate.

**Probability/Impact**: medium / medium (delays v2.1.0 tag cut).

**Mitigation**: Each deterministic-fallback smoke vitest re-uses the
**same Markdown template renderer** that the live smoke uses
(centralized at `src/lib/smoke-template.ts` — new helper added by
US-P1-VERIFY-smoke-artifact). The vitest case asserts the rendered
header structure (sections: Environment, Pre-condition, Trigger,
Output, Verdict) matches a golden snapshot. Mock-spawn fixtures
return identical-shape stdout to what live Copilot produces (model-id
line, exit code, vitest tail). When live smoke captures real
artifacts in N+1/N+2/N+3, the smoke harness `diff`s against the prior
deterministic-attestation; >20% section-level drift fails the live
smoke step. Forces the deterministic fixture to stay close to real
shape.

---

## Expanded test plan (per Phase) — deliberate mode

| Phase | Unit | Integration | E2E (live) | Observability |
|---|---|---|---|---|
| **P1 verify/fix** | `runTeamVerify` returns `{ok,signals}` over mock spawn; covers all-pass/vitest-fail/tsc-fail/biome-fail/combined-fail. `runTeamCollect` `needsFix` short-circuit: 0/1/all fail cases. | `team-launch → workers exit → team-verify → team-collect → fix-spawn → re-verify → completed` with mock-spawn for copilot+omcp. Loop bounded by `--max-fix-loops`. | Real 4-worker team writes failing tests → verify catches → fix spawn flips passing; smoke captures vitest before+after. **Deterministic fallback** when `OMCP_COPILOT_AUTH=missing`. | `verify-report-N.json` per iteration; `omcp status` surfaces `fix_loop_count`. |
| **P2 ack-status (extend only)** | `runTeamAck --status <s>` updates TeamState atomically; idempotency on repeat; invalid status → exit 2. 8-process `child_process.spawn` concurrent test against TeamState atomic-rewrite. | 4-worker spawn → each calls `omcp team-ack --status completed` → `omcp status` shows 4/4 completed; logged-warning on backwards transitions but call succeeds. | Piggybacks on P1 E2E — asserts 4/4 worker-status=completed in the P1 smoke artifact. | `omcp status` Worker table status column. |
| **P3 chain** | `parseChainArgs` returns ordered step list; `runChain(steps)` halts on first non-zero with chain-state.json marker. `team-wait` polls TeamState terminal phase. State-handoff atomic 5-step sequence covered with crash-survivor case (kill -9 between step 3 and step 4). | Mock-spawn 3-step chain executes in order; step 2 fails → step 3 not spawned, chain-state persists. team-wait timeout path covered. Phase 1 TeamState field preservation: 4-worker → 1 verify fail → fix_loop_count=1 → handoff → ralph state snapshot contains fix_loop_count=1. | Real `omcp ralplan --chain "fix typo in README" --then team 2 --then ralph-verify` end-to-end; smoke captures all 3 handoffs. **Deterministic fallback** when `OMCP_COPILOT_AUTH=missing`. | `omcp status` shows `current_chain_step`; chain-state.json discoverable post-crash. |
| **P4 shutdown polish + release** | Existing `shutdownTeam` tests pass; ack-write timing within 30s. Smoke-template-renderer golden snapshot test. | 4-worker team receives shutdown → all 4 ack within timeout → no SIGTERM fallback. | Piggybacks on P1/P3 E2E; absence of SIGTERM message in logs. **Deterministic fallback** for the integration smoke. | (none new — relies on existing shutdown-report semantics.) |

---

## Per-session commit budget + stop-and-replan rule

Each session below carries an explicit commit-budget ceiling. If a
session ends with >5 stories incomplete vs the session nominal target,
the NEXT session leads with a `replan-iter2-remaining` planning commit
that consumes a vitest +0 slot but writes a one-page "what carries
forward, why" doc under `.omcp/plans/`. Modeled on iter-3 §A from the
v1.8→v2.0 ralplan.

**Effective story-vs-commit accounting**:
- Phase 1 verify-spawn + verify-signals + collect-extension are 3
  closely-related stories → matrix-merge candidate ONLY if `it.each`
  scaffold fits (otherwise individual commits per story).
- Phase 2 ack-status-extend is a 1-commit add.
- Phase 3 chain parser/runner/state-handoff/preserve/cancel/team-wait/
  ralph-dispatch-guide are 7 distinct surfaces → one commit per story,
  no matrix-merge.

## Session execution map (N+1 ... N+3, 3 sessions, risk-ordered)

Session N is this planning pass. Sessions N+1 .. N+3 execute the plan.
**Total: 3 sessions** (compressed from iter-1's 4 by dropping Phase 2
IPC primitives).

| Session | Theme | Stories landed (nominal IDs) | Commit budget | Tag at end | External prereq | Vitest delta |
|---|---|---|---|---|---|---|
| **N+1** | Gap 1 verify/fix loop kickoff: doctor verify-spawn → verify-runner → collect-extension → fix-spawn → loop-bounding → smoke (with deterministic fallback) | US-omcp-parity-P1-DOCTOR-verify-spawn-shape, US-omcp-parity-P1-VERIFY-runner, US-omcp-parity-P1-COLLECT-needsfix-shortcircuit, US-omcp-parity-P1-FIX-worker-spawn, US-omcp-parity-P1-FIX-loop-bounding, US-omcp-parity-P1-VERIFY-smoke-artifact | ≤14 commits | none | Copilot CLI authed (live smoke); else deterministic-fallback runs | +18 to +28 |
| **N+2** | Phase 2.5 ack-extend + Phase 3 orchestration: ack-status → chain parser → chain runner → state-handoff → preserve-P1-fields → cancel-propagation → team-wait → ralph-dispatch-guide → chain smoke | US-omcp-parity-P2.5-ACK-status-flag, US-omcp-parity-P3-CHAIN-parser, US-omcp-parity-P3-CHAIN-runner, US-omcp-parity-P3-CHAIN-state-handoff, US-omcp-parity-P3-CHAIN-preserve-P1-teamstate, US-omcp-parity-P3-CHAIN-cancel-propagation, US-omcp-parity-P3-TEAM-WAIT-cli, US-omcp-parity-P3-RALPH-SKILL-dispatch-guide, US-omcp-parity-P3-CHAIN-smoke-artifact | ≤14 commits | none | Copilot CLI authed (chain smoke); else deterministic-fallback | +24 to +34 |
| **N+3** | Phase 4 shutdown polish + integration + ADR + release tag | US-omcp-parity-P4-SHUTDOWN-worker-ack-skill-update, US-omcp-parity-P4-INTEGRATION-smoke, US-omcp-parity-ADR-write, US-omcp-parity-CHANGELOG-entry, US-omcp-parity-RELEASE-cut | ≤8 commits | **v2.1.0** local (gated on ≥1 live smoke from N+1/N+2/N+3) | Copilot CLI authed (≥1 live smoke required for v2.1.0 tag); else attestation deferred | +4 to +10 |

**Why this 3-session split**: Phase 1 in N+1 unblocks meaningful
verify/fix value alone (Option A floor). Phase 2.5 ack-extend (1 story)
batches into N+2 with Phase 3 because ack-extend touches an unrelated
file (`team-ack.ts`) and provides quick win at session start before
the cognitively-heavier chain work. Phase 3 fits in N+2 because chain
parser/runner/state-handoff/preserve-P1/cancel/team-wait/ralph-guide
share the new `src/cli/commands/chain.ts` module surface; 8 stories
plus 1 ack-extend = 9 stories vs ceiling 14 leaves cushion. N+3 is
integration + release with tighter budget.

**Session-stop rule** (formalized, lifted from iter-3): if at session-
end >5 stories from the session nominal list are incomplete, the next
session leads with `replan-iter2-remaining` planning commit. (Threshold
relaxed from iter-1's 8 because iter-2 has fewer total stories and
3-session budget is tighter.)

**Ceiling-vs-body honesty disclosure**: N+1 nominal body = 6 stories
vs ceiling 14. Budget held intentionally because Phase 1 has high
inter-story coupling (verify-runner ↔ collect-shortcircuit ↔
fix-spawn); expect some stories to need iteration. N+2 nominal body =
9 stories vs ceiling 14. N+3 = 5 vs 8. All sessions have budget
cushion for unexpected fix-up commits.

---

## Phase 1 stories — Gap 1: verify/fix loop (HIGH IMPACT, CRITICAL gap)

### Phase 1 entry/exit

- **Entry**: `omcp team-collect` finds all shards present but no quality
  signal AND no merge conflicts. Today: transitions to `completed` —
  premature.
- **Exit (success)**: verify passes → `completed`.
- **Exit (loop)**: verify fails → `fixing` → spawn fix worker → loop
  back to verify. Bounded by `max_fix_loops` (default 3).
- **Exit (max loops)**: `failed` with reason `verify_loop_exhausted`.

### US-omcp-parity-P1-DOCTOR-verify-spawn-shape

- **Risk class**: gate (verify-spawn fails silently if Copilot CLI flags drift)
- **Invariants**: I8 (CLI registration), I4 (no banned tokens)
- **Acceptance criteria**:
  - `omcp doctor --json` includes a `verify-spawn-shape` check that
    spawns `copilot -p "echo verify-spawn-check"` and asserts exit-0 +
    stdout contains a recognizable Copilot model id (`gpt-` or
    `claude-` substring).
  - vitest covers: mock-spawn returns model line → ok=true; mock-spawn
    exits 1 → ok=false with stderr captured; mock-spawn times out at
    30s → ok=false with timeout reason.
- **Dependencies**: none
- **Confidence**: high
- **Commit shape**: `feat(doctor): verify-spawn-shape check for team-verify readiness`

### US-omcp-parity-P1-VERIFY-runner

- **Risk class**: CATASTROPHIC (the core new primitive)
- **Invariants**: I1 (sessionId via assertSafeSlug), I2 (atomicWriteFileSync for verify-report-N.json), I8 (CLI registration)
- **Acceptance criteria**:
  - New CLI verb: `omcp team-verify <sessionId> [--max-loops N]`.
    Default max-loops 3, env override `OMCP_TEAM_MAX_FIX_LOOPS`.
  - Runs vitest (`npx vitest run`), tsc (`npx tsc --noEmit`), biome lint
    (`npx biome check src/`) in sequence. Captures each tool's exit
    code + truncated stdout (last 200 lines).
  - Writes `.omcp/state/team/<sessionId>/verify-report-N.json` where N
    is the loop iteration. Schema: `{iteration, ts, vitest:{exitCode,
    tail}, tsc:{exitCode, tail}, biome:{exitCode, tail}, ok:boolean}`.
  - When any tool fails: writes a sibling `worker-K-verify-fail.json`
    per worker (signaling Gap 1 fix-needed).
  - Returns exit-0 when ok=true, exit-1 when any check failed (signals
    needs-fix), exit-2 on session-id validation failure.
- **Files**: `src/cli/commands/team-verify.ts` (new),
  `src/cli/omcp.ts` (registration), `src/__tests__/team-verify.test.ts` (new).
- **Dependencies**: US-omcp-parity-P1-DOCTOR-verify-spawn-shape
- **Confidence**: high
- **Commit shape**: `feat(team-verify): add omcp team-verify <session> with vitest+tsc+biome runner`

### US-omcp-parity-P1-COLLECT-needsfix-shortcircuit

- **Risk class**: MAJOR (changes existing terminal-phase semantics)
- **Invariants**: I2 (atomicWriteFileSync), I8 (CLI shape stable)
- **Acceptance criteria**:
  - `runTeamCollect` extended: when ANY worker has `verify-fail.json`
    in pidDir, transition to `fixing` instead of `completed` (currently:
    only transitions to `fixing` on merge conflicts).
  - Existing merge-conflict → fixing logic preserved (back-compat).
  - When BOTH verify-fail AND merge-conflict present: stays `fixing`,
    writes both `conflicts.json` and `verify-fail-summary.json`.
  - `--team-name` flag continues to be optional (back-compat per current
    src/cli/commands/team-phase-controller.ts comment).
  - vitest covers: 0 verify-fail → completed; 1 verify-fail → fixing;
    all verify-fail → fixing; verify-fail + merge-conflict → fixing
    with both artifacts.
- **Files**: `src/cli/commands/team-phase-controller.ts` (edit),
  `src/cli/commands/__tests__/team-phase-controller.test.ts` (extend).
- **Dependencies**: US-omcp-parity-P1-VERIFY-runner
- **Confidence**: high
- **Commit shape**: `feat(team-collect): transition to fixing when verify-fail signal present`

### US-omcp-parity-P1-FIX-worker-spawn

- **Risk class**: MAJOR
- **Invariants**: I1 (sessionId), I2 (atomicWriteFileSync), I8 (CLI shape)
- **Acceptance criteria**:
  - New helper `spawnFixWorker(sessionId, verifyReport)` in
    `src/cli/commands/team-verify.ts`. Spawns a single Copilot worker
    with agent=`debugger` and prompt containing the verify-report tail
    + instruction to fix the failing checks.
  - Worker spawn uses same pattern as `runTeam` (detached, pidfile
    written, env vars OMCP_TEAM_SESSION_ID + OMCP_TEAM_WORKER_INDEX with
    fix-worker index = next free index in pidDir).
  - On fix-worker exit: increments `fix_loop_count` in TeamState
    (extends TeamState interface; back-compat optional field).
  - When fix worker writes its own shard, `team-collect` re-runs verify
    automatically (extension to collect logic).
- **Files**: `src/cli/commands/team-verify.ts` (extend),
  `src/runtime/mode-state.ts` (add optional `fix_loop_count` to TeamState).
- **Dependencies**: US-omcp-parity-P1-COLLECT-needsfix-shortcircuit
- **Confidence**: med (Copilot agent=`debugger` invocation needs live verification)
- **Commit shape**: `feat(team-verify): spawn debugger fix worker when verify-fail detected`

### US-omcp-parity-P1-FIX-loop-bounding

- **Risk class**: MAJOR (prevents infinite-loop runaway cost)
- **Invariants**: I8 (CLI shape stable)
- **Acceptance criteria**:
  - `team-verify --max-loops N` default 3. After N loops without
    verify=ok, transitions team to `failed` with reason `verify_loop_exhausted`.
  - `fix_loop_count` in TeamState reflects current loop. `omcp status`
    surfaces it.
  - vitest covers: max-loops=1 + 1 fail → `failed`; max-loops=3 + 3
    fails → `failed`; max-loops=3 + 2 fails + 1 pass → `completed`.
  - env var OMCP_TEAM_MAX_FIX_LOOPS overrides flag default.
- **Files**: `src/cli/commands/team-verify.ts` (extend).
- **Dependencies**: US-omcp-parity-P1-FIX-worker-spawn
- **Confidence**: high
- **Commit shape**: `feat(team-verify): bound fix-loop at --max-loops (default 3)`

### US-omcp-parity-P1-VERIFY-smoke-artifact

- **Risk class**: gate (tag-gate per principle 4)
- **Invariants**: I3 (smoke artifact present)
- **Acceptance criteria**:
  - **Live mode** (default when `OMCP_COPILOT_AUTH` is unset / set to
    `present`): `docs/smoke/omcp-team-parity/phase1-verify-fix-loop.md`
    captures: real Copilot version banner, real `omcp team 2:executor
    "fail one test"`, real `omcp team-verify` output showing 1 fail →
    fixing transition, real fix-worker spawn output, re-verify showing
    pass, final `omcp team-collect` showing `completed`.
  - Artifact attests baseline + post-fix vitest output unchanged
    against project test count (no test deletion).
  - **Deterministic fallback** (H4): when `OMCP_COPILOT_AUTH=missing`
    is set in env (CI uses this), the smoke harness runs against a
    mock-spawn fixture under `src/__tests__/fixtures/smoke-mocks/` and
    writes a sibling
    `docs/smoke/omcp-team-parity/phase1-verify-fix-loop-deterministic-attestation.md`
    with same Markdown section structure (Environment, Pre-condition,
    Trigger, Output, Verdict) rendered via shared
    `src/lib/smoke-template.ts` helper. Live attestation remains
    required for v2.1.0 tag gate (US-P4-RELEASE-cut); deterministic
    attestation unblocks downstream stories in this session.
  - vitest: golden snapshot of deterministic-attestation rendered output;
    smoke-template helper unit-tested for header structure.
- **Dependencies**: All Phase 1 stories above
- **Confidence**: med (depends on live Copilot auth + ≥4 min clock time
  for live mode; deterministic mode is high-confidence)
- **Commit shape**: `docs(smoke): phase1 verify-fix loop live + deterministic attestation`

---

## Phase 2 — Gap 3 worker status (ack-status extend only; iter-2 scope)

### Phase 2 entry/exit (iter-2)

- **Entry**: Phase 1 complete (verify/fix loop working).
- **Exit**: 4-worker team can self-report `--status <state>` via
  existing `team-ack` CLI; `omcp status` shows accurate worker
  state per-worker.

**Iter-2 note**: Iter-1's Phase 2 IPC primitives (outbox/inbox/
heartbeat/worker-skill-IPC-update/IPC-smoke) are DEFERRED behind
EB-omcp-parity-06. Their story IDs are preserved in Appendix B for
direct lift-into a future ralplan iter. The iter-2 Phase 2 contains
only Gap 3 ack-status-flag.

### US-omcp-parity-P2.5-ACK-status-flag (Gap 3)

- **Risk class**: MED (extends existing surface)
- **Invariants**: I1, I2, I8
- **Acceptance criteria**:
  - `omcp team-ack <sessionId> <workerIndex> [--status <state>]`
    optional flag. When passed, updates TeamState workers[K].status to
    `<state>` atomically before writing ack JSON. Default behavior
    unchanged when --status omitted (idempotent overwrite path
    preserved).
  - Valid states: `pending`, `in_progress`, `completed`, `failed`.
    Invalid state → exit 2 with explanation.
  - `runTeamAck` returns `{ackFile, ackedAt, statusUpdated}`. CLI
    prints status update when applied.
  - **Concurrency test (Architect #5 revised)**: 8-process
    `child_process.spawn` concurrent test (NOT vitest pool=threads,
    which shares NTFS handles within a single Node process) spawns 8
    separate `node` processes each calling `runTeamAck --status <s>`
    against the same sessionId+workerIndex range (workerIndex 0-7).
    All 8 TeamState updates land via atomicWriteFileSync rewrite path;
    read-back asserts no torn JSON + final status values match
    expectation. Test path: `src/__tests__/team-ack-status-concurrency.test.ts`.
  - vitest covers: omit --status → no state change; --status completed
    → TeamState updated + ack file written; --status invalid → exit 2;
    concurrent calls land without race per the concurrency test above.
- **Files**: `src/cli/commands/team-ack.ts` (extend),
  `src/cli/omcp.ts` (option declaration), tests.
- **Dependencies**: none (extends existing CLI; can run before Phase 3)
- **Confidence**: high
- **Commit shape**: `feat(team-ack): --status flag with atomic worker status update`

---

## Phase 3 stories — orchestration (ralph/team mixed mode)

### Phase 3 entry/exit

- **Entry**: Phase 1 complete (verify/fix loop working); Phase 2.5
  complete (ack-status surface stable).
- **Exit**: User can run `omcp ralplan --chain "task" --then team 4
  --then ralph-verify` and see ralplan → team-4 → ralph cycle complete.
  Ralph SKILL.md guides agent to dispatch sub-teams for parallel
  subtasks.

### US-omcp-parity-P3-CHAIN-parser

- **Risk class**: MAJOR (new flag surface)
- **Invariants**: I8 (CLI shape stable)
- **Acceptance criteria**:
  - `omcp ralplan --chain` flag added. Parses `--then <verb> [args...]`
    repeated arguments into ordered pipeline steps. Each step is
    `{verb: string, args: string[]}`. Empty chain = legacy ralplan
    behavior (back-compat).
  - vitest covers: `ralplan --chain --then team 4 fix-typo
    --then ralph-verify` parses to 3-step chain with `team` taking
    args `["4", "fix-typo"]` and `ralph-verify` taking `[]`.
  - Malformed chain (--then without verb) → exit 2 with error.
- **Files**: `src/cli/commands/chain.ts` (new for parser only),
  `src/cli/omcp.ts` (option add to ralplan command), tests.
- **Dependencies**: none
- **Confidence**: high
- **Commit shape**: `feat(chain): add --chain --then <verb> parser to ralplan`

### US-omcp-parity-P3-CHAIN-runner

- **Risk class**: CATASTROPHIC (orchestrates multiple modes)
- **Invariants**: I1, I2, I8
- **Acceptance criteria**:
  - `runChain(steps, opts)` executes pipeline. Each step calls into the
    existing CLI surface (`runMode("ralplan", ...)`, `runTeam(...)`,
    `runMode("ralph", ...)`) and awaits exit-0 before next step.
  - Failure mid-chain: persists `.omcp/state/chain-state.json` with
    `{currentStep, completedSteps, failedStep, ts, status}`. `omcp
    status` surfaces this.
  - `runChain` returns aggregated exit code (max of all steps).
  - Between-step transitions delegate to US-P3-CHAIN-state-handoff
    (next story).
  - vitest: 3-step chain mock-spawn happy-path → all-completed; step 2
    fails → step 3 not spawned, chain-state.json persists failedStep=2.
- **Files**: `src/cli/commands/chain.ts` (extend), tests.
- **Dependencies**: US-omcp-parity-P3-CHAIN-parser, Phase 1 stories
  (chain reads team-state.json field shape).
- **Confidence**: med (cross-mode call surface needs careful test)
- **Commit shape**: `feat(chain): sequential runChain with crash-resume marker`

### US-omcp-parity-P3-CHAIN-state-handoff

- **Risk class**: MAJOR (pre-mortem scenario 2 mitigation)
- **Invariants**: I1, I2 (chain-state.json + handoff snapshots), I8
- **Acceptance criteria**:
  - Before each transition between steps, `runChain` calls
    `prepareTransition(fromMode, toMode, stepN)` which executes a
    deterministic 5-step atomic sequence (per H3 + Architect #2):
    1. **Read** from-mode's state file (e.g., `team-state.json`).
    2. **Write snapshot** to
       `.omcp/state/chain-handoffs/<step-N>.json` via
       `atomicWriteFileSync`. Includes the full from-mode state +
       chain-step metadata + ts.
    3. **Write `chain-state.json`** via `atomicWriteFileSync` with
       `{currentStep:stepN, completedSteps:[...prior], ts, status:
       "handing-off-to-<toMode>"}`. This is the canonical resume
       marker for `omcp status` and HUD col 1+2+6.
    4. **Clear from-mode state** via `rmSync`. Asymmetric (S2): the
       clear runs ONLY when to-mode is `mutuallyExclusive: true`
       (currently per `src/runtime/mode-state.ts:77-86`: ralph,
       autopilot, ultrawork, ultraqa, ultragoal). When to-mode is
       team / ralplan / sciomc (non-exclusive), the clear is skipped
       and the from-mode state coexists with to-mode state (existing
       behavior). The asymmetry rationale is documented inline in
       `chain.ts` and in the ADR (US-P4-ADR-write).
    5. **Spawn to-mode** via the existing CLI surface (`runMode` etc).
  - **Single source of truth** (H3 fix): chain-state.json is the ONLY
    file written between steps 2 and 5 to carry resume signal.
    Pre-mortem scenario 2 references this exact sequence (no
    contradiction with acceptance criteria).
  - **Crash-survivor vitest** (Architect #2): simulated `kill -9`
    (SIGKILL via vitest mock) between step 3 (chain-state.json write)
    and step 4 (from-mode clear) → assert all three files coexist:
    `chain-handoffs/<step-N>.json`, `chain-state.json`,
    `<from-mode>-state.json`. Asserts the system is postmortem-
    recoverable. Reverse case (kill between step 4 and step 5):
    `<from-mode>-state.json` cleared, chain-state.json + handoff
    snapshot present; `omcp status` reads chain-state.json and
    surfaces `status=handing-off-to-<toMode>, partial=true`.
  - vitest: simulated crash between team-completion and ralph-spawn
    leaves chain-state.json with appropriate status + handoff
    snapshot preserved for postmortem.
- **Files**: `src/cli/commands/chain.ts` (extend with
  `prepareTransition`), tests.
- **Dependencies**: US-omcp-parity-P3-CHAIN-runner
- **Confidence**: med
- **Commit shape**: `feat(chain): atomic 5-step state handoff with crash-survivor postmortem`

### US-omcp-parity-P3-CHAIN-preserve-P1-teamstate (NEW iter-2; Architect #3)

- **Risk class**: MAJOR (cross-mode contamination of Phase 1 verify/fix loop counters)
- **Invariants**: I1, I2
- **Acceptance criteria**:
  - `prepareTransition` snapshot at step 2 (chain-handoffs/<step-N>.json)
    MUST preserve all Phase 1 TeamState fields when from-mode=team. Fields
    explicitly listed: `fix_loop_count`, `current_phase`,
    `workers[].status` (Gap 3 ack-status field), `workers[].pid`,
    `started_at`, plus any future extensible fields under a
    `phase1_metadata` namespace.
  - When to-mode=ralph and ralph state-snapshot reader runs (existing
    `src/runtime/mode-state.ts` ralph reader), the snapshot from
    chain-handoffs/<step-N>.json must be accessible via a new helper
    `readChainHandoff(stepN)` exposed in
    `src/lib/chain-handoff-reader.ts`.
  - **Cross-mode integration vitest**: spawn 4-worker team via mock,
    fail 1 verify check, fix-worker increments `fix_loop_count=1`,
    `team-collect` reaches `completed`, then `runChain` triggers
    handoff to ralph step. Assert `chain-handoffs/2.json` contains
    `team_state.fix_loop_count=1`. Then ralph step starts (mock), and
    `readChainHandoff(2)` returns the snapshot with `fix_loop_count=1`
    accessible. Postmortem-recoverable for ralph crash debugging.
  - vitest covers all 4 Phase 1 TeamState fields explicitly named
    above; future fields rely on JSON-roundtrip (no field-specific
    code).
- **Files**: `src/cli/commands/chain.ts` (extend
  `prepareTransition`), `src/lib/chain-handoff-reader.ts` (new),
  tests.
- **Dependencies**: US-omcp-parity-P3-CHAIN-state-handoff, all Phase 1 stories
- **Confidence**: high (mechanism is JSON snapshot; field list explicit)
- **Commit shape**: `feat(chain): preserve Phase 1 TeamState fields in handoff snapshot`

### US-omcp-parity-P3-CHAIN-cancel-propagation

- **Risk class**: MAJOR (pre-mortem scenario 2 part b)
- **Invariants**: I1, I2, I8
- **Acceptance criteria**:
  - When `omcp cancel` runs while chain is active (chain-state.json
    exists + has non-terminal step): writes cancel marker AND clears
    chain-state.json AND signals current step's mode-state.json to
    halt on next checkpoint (mode-state cancelled=true).
  - vitest: ralph step running + omcp cancel → chain-state.json
    cleared + cancel marker present + ralph-state.cancelled=true.
  - Architecturally writes ADR-omcp-cancel-semantics covering: which
    modes honor mid-step cancel? (ralph yes via existing
    `outerLoopOwned` check; team-verify yes via cancel-marker check
    at each iteration; team-launch no — spawned workers must finish
    or be SIGTERMed). ADR commit lands as a separate story
    (US-P4-ADR-write or as part of this story per critic preference;
    chosen: keep ADR file write in P4 for batched ADR-writing
    consistency).
- **Files**: `src/cli/commands/chain.ts` (extend),
  `src/cli/commands/cancel.ts` or equivalent path (extend), tests.
- **Dependencies**: US-omcp-parity-P3-CHAIN-state-handoff
- **Confidence**: med
- **Commit shape**: `feat(chain): omcp cancel propagates across chain steps`

### US-omcp-parity-P3-TEAM-WAIT-cli

- **Risk class**: MED (small surface addition; useful for ralph→team mixing)
- **Invariants**: I1, I8
- **Acceptance criteria**:
  - New CLI verb: `omcp team-wait <sessionId> [--timeout <secs>]`.
    Polls `TeamState.current_phase` every 2s. Exits 0 when phase ∈
    {completed}, exit 1 when {failed}, exit 2 when timeout, exit 3
    when session not found.
  - Default timeout: 1800s (30 min); env override
    `OMCP_TEAM_WAIT_TIMEOUT_S`.
  - **Polling, not heartbeat**: This story explicitly polls TeamState
    fields written by `runTeamCollect` (existing surface) — NO
    dependency on Phase 2 IPC primitives (heartbeat-poll deferred per
    EB-06). Acceptance criterion text exists to reinforce this
    decoupling.
  - vitest: mock 3 polls returning `executing` then `completed` →
    exit 0; mock timeout → exit 2; mock session not found → exit 3;
    mock phase=failed → exit 1.
- **Files**: `src/cli/commands/team-wait.ts` (new), tests.
- **Dependencies**: none (reads existing TeamState)
- **Confidence**: high
- **Commit shape**: `feat(team-wait): blocking poll for team session terminal phase`

### US-omcp-parity-P3-RALPH-SKILL-dispatch-guide

- **Risk class**: MED (documentation; agent behavior change via prompt update)
- **Invariants**: I9 (no banned tokens)
- **Acceptance criteria**:
  - `skills/ralph/SKILL.md` <Tool_Usage> section gains a "Parallel
    subtask dispatch via team" subsection: when ralph identifies ≥3
    independent stories in the current PRD iteration, the ralph agent
    SHOULD dispatch a sub-team via `omcp team N:executor "story
    N+1...N+M"` and `omcp team-wait <sessionId>` before continuing
    iteration.
  - Examples include both "use team" (parallel-safe) and "use ralph
    alone" (when stories share files) decision criteria.
  - Plugin mirror at `plugins/oh-my-copilot/skills/ralph/SKILL.md`
    regenerated via `scripts/sync-plugin-mirror.ts`. Verify
    `cli-wiring-invariants.test.ts` mirror-sync test still passes.
  - Skill front-matter unchanged. No Claude-only tool names introduced.
- **Files**: `skills/ralph/SKILL.md` (edit), plugin mirror.
- **Dependencies**: US-omcp-parity-P3-TEAM-WAIT-cli
- **Confidence**: high
- **Commit shape**: `docs(ralph): dispatch sub-team for parallel-safe story batches`

### US-omcp-parity-P3-CHAIN-smoke-artifact

- **Risk class**: gate
- **Invariants**: I3
- **Acceptance criteria**:
  - **Live mode**: `docs/smoke/omcp-team-parity/phase3-chain.md`
    captures: real `omcp ralplan --chain "fix README typo" --then
    team 2 --then ralph-verify`, full output of all 3 phases,
    chain-state.json transitions, final `omcp status` showing
    chain=completed.
  - **Deterministic fallback** (H4): when `OMCP_COPILOT_AUTH=missing`,
    smoke harness runs the same 3-step chain against mock-spawn
    fixtures and writes
    `docs/smoke/omcp-team-parity/phase3-chain-deterministic-attestation.md`
    with same section structure via `src/lib/smoke-template.ts`.
  - vitest: deterministic-fallback golden snapshot test of rendered
    output; assert section headers match P1 live-shape (drift
    detection per pre-mortem scenario 3).
- **Dependencies**: All Phase 3 stories above
- **Confidence**: med
- **Commit shape**: `docs(smoke): phase3 chain orchestration live + deterministic attestation`

---

## Phase 4 stories — graceful shutdown polish + integration + release

### US-omcp-parity-P4-SHUTDOWN-worker-ack-skill-update

- **Risk class**: MED
- **Invariants**: I9
- **Acceptance criteria**:
  - `skills/team-worker/SKILL.md` shutdown section (already covers
    `omcp team-ack`) extended to remind workers to also call
    `omcp team-ack --status completed` (Gap 3 surface) on graceful
    exit so dead-detection knows the worker's final status.
  - Iter-2 NOTE: This story does NOT mention `omcp team-heartbeat`
    (that command does not exist in iter-2 scope per EB-06 deferral).
    If/when Phase 2 IPC revives, the heartbeat-before-ack pattern is
    added at that time.
  - vitest: shutdownTeam integration test from
    `src/team/__tests__/sentinel-gate.test.ts` (or equivalent) still
    passes with the new ack-with-status pattern.
- **Files**: `skills/team-worker/SKILL.md` (edit), plugin mirror.
- **Dependencies**: US-omcp-parity-P2.5-ACK-status-flag
- **Confidence**: high
- **Commit shape**: `docs(team-worker): ack-with-status in shutdown protocol`

### US-omcp-parity-P4-INTEGRATION-smoke

- **Risk class**: gate (full-stack regression)
- **Invariants**: I3
- **Acceptance criteria**:
  - **Live mode**:
    `docs/smoke/omcp-team-parity/phase4-integration.md` captures: full
    chain pipeline with intentional 1 verify-fail injection, fix-worker
    spawned, re-verify passes, all 4 workers ack gracefully (no SIGTERM
    fallback fires), chain completes, ralph-verify approves.
  - **Deterministic fallback** (H4): when `OMCP_COPILOT_AUTH=missing`,
    writes `phase4-integration-deterministic-attestation.md` via shared
    smoke-template renderer.
  - Both live + deterministic artifacts share same section structure;
    drift-detection vitest applies.
- **Dependencies**: All prior stories
- **Confidence**: med
- **Commit shape**: `docs(smoke): phase4 full-stack integration live + deterministic attestation`

### US-omcp-parity-ADR-write

- **Risk class**: MED
- **Invariants**: I3 (CHANGELOG entry)
- **Acceptance criteria**:
  - `docs/adr/ADR-omcp-team-omc-parity-iter2.md` written per RALPLAN-DR
    final consensus output: **Decision** (Option B-minus),
    **Drivers** (top 3 from §RALPLAN-DR), **Alternatives considered**
    (A, B-minus, historical-B EB-06-gated), **Why Option B-minus
    chosen** (reviewer convergence + IPC ROI vs cost), **Consequences**
    (deferred IPC visible to users, partial-parity messaging,
    deterministic-fallback test surface added), **Follow-ups** (Phase 2
    IPC revival ralplan when EB-06 fires; outbox schema ADR
    re-activates).
  - Also write `docs/adr/ADR-omcp-cancel-semantics.md` (deferred from
    Phase 3 cancel story) covering ralph/team/team-launch cancel
    honoring matrix.
- **Dependencies**: All prior stories
- **Confidence**: high
- **Commit shape**: `docs(adr): omcp team omc parity iter-2 decision record + cancel semantics`

### US-omcp-parity-CHANGELOG-entry

- **Risk class**: low
- **Invariants**: I3
- **Acceptance criteria**:
  - `CHANGELOG.md` `## [Unreleased]` → `## [2.1.0] - 2026-MM-DD`
    section enumerates: Gap 1 verify/fix, Gap 3 worker status (via
    ack-status), Gap 4 shutdown-protocol polish, Phase 3 chain
    orchestration. **Explicitly notes Gap 2 IPC mesh deferred per
    EB-omcp-parity-06**. References smoke artifact paths (live +
    deterministic).
- **Dependencies**: US-omcp-parity-ADR-write
- **Confidence**: high
- **Commit shape**: `docs(changelog): v2.1.0 omc-parity-minus-IPC entry`

### US-omcp-parity-RELEASE-cut

- **Risk class**: MED (4-manifest sync per I3)
- **Invariants**: I3 (4-manifest sync), I8
- **Acceptance criteria**:
  - `src/scripts/release.ts` invocation bumps all 4 manifests to 2.1.0.
  - `cli-wiring-invariants.test.ts` passes (4-manifest version match).
  - **Tag gate** (S4): Local git tag v2.1.0 created ONLY when ≥1
    live-smoke artifact captured (any of phase1-verify-fix-loop.md,
    phase3-chain.md, phase4-integration.md — at least ONE must show
    real-Copilot output, NOT deterministic-fallback). Verification:
    a release-time script `src/scripts/check-live-smoke.ts` reads the
    3 smoke artifacts and asserts at least 1 contains the canonical
    live-Copilot model-id signature (e.g., `gpt-` or `claude-`
    substring in version banner section). If all 3 are deterministic-
    only, the release script exits 1 with message "v2.1.0 LOCAL tag
    blocked: ≥1 live-smoke required — capture P1, P3, or P4 with
    real Copilot CLI auth".
  - **npm publish remains `[USER_REQUIRED]`** per
    ADR-v2.0-public-release-deferred and is NOT in this plan.
- **Files**: `src/scripts/release.ts` (extend with live-smoke check),
  `src/scripts/check-live-smoke.ts` (new), tests.
- **Dependencies**: All prior stories
- **Confidence**: high
- **Commit shape**: `chore(release): v2.1.0 — omc-parity-minus-IPC (live-smoke-gated)`

---

## Appendix A — Story ID master list (iter-2)

### Phase 1 (6 stories)
1. US-omcp-parity-P1-DOCTOR-verify-spawn-shape
2. US-omcp-parity-P1-VERIFY-runner
3. US-omcp-parity-P1-COLLECT-needsfix-shortcircuit
4. US-omcp-parity-P1-FIX-worker-spawn
5. US-omcp-parity-P1-FIX-loop-bounding
6. US-omcp-parity-P1-VERIFY-smoke-artifact

### Phase 2 (1 story — ack-status extend only)
7. US-omcp-parity-P2.5-ACK-status-flag

### Phase 3 (7 stories)
8. US-omcp-parity-P3-CHAIN-parser
9. US-omcp-parity-P3-CHAIN-runner
10. US-omcp-parity-P3-CHAIN-state-handoff
11. US-omcp-parity-P3-CHAIN-preserve-P1-teamstate (NEW iter-2; Architect #3)
12. US-omcp-parity-P3-CHAIN-cancel-propagation
13. US-omcp-parity-P3-TEAM-WAIT-cli
14. US-omcp-parity-P3-RALPH-SKILL-dispatch-guide
15. US-omcp-parity-P3-CHAIN-smoke-artifact

### Phase 4 (5 stories)
16. US-omcp-parity-P4-SHUTDOWN-worker-ack-skill-update
17. US-omcp-parity-P4-INTEGRATION-smoke
18. US-omcp-parity-ADR-write
19. US-omcp-parity-CHANGELOG-entry
20. US-omcp-parity-RELEASE-cut

**Total: 20 stories across 3 sessions** (compressed from iter-1's
25 stories across 4 sessions by dropping 6 Phase 2 IPC stories and
adding 1 new preserve-P1-teamstate story).

---

## Appendix B — Deferred Phase 2 IPC stories (preserved for future revival)

The following 6 story IDs were defined in iter-1 and are DEFERRED behind
**EB-omcp-parity-06** (≥1 external user reports IPC mesh as workflow
blocker). When EB-06 fires, a new ralplan iter rebuilds these with
proper smoke + concurrency tests. Story names are preserved verbatim
to enable direct lift-into the future plan.

1. US-omcp-parity-P2-OUTBOX-write-helper — concurrent-safe NTFS
   append, 8-process write test, JSONL stream integrity. Iter-1
   acceptance criterion preserved at iter-1 §Phase 2 / OUTBOX-write-
   helper section (lines 411-430 of `.omcp/plans/omcp-team-omc-parity.md`).
2. US-omcp-parity-P2-OUTBOX-read-cursor — byte-offset cursor.
3. US-omcp-parity-P2-INBOX-write-helper — markdown append.
4. US-omcp-parity-P2-HEARTBEAT-write-poll — mtime liveness + watchdog
   integration.
5. US-omcp-parity-P2-WORKER-SKILL-update — workers call team-heartbeat
   + team-outbox-write + poll inbox.
6. US-omcp-parity-P2-IPC-smoke-artifact — depends on `team-collect
   --watch`, which itself is deferred until EB-06.

**EB-omcp-parity-02** (outbox schema ADR) and **EB-omcp-parity-05**
(heartbeat freshness threshold ADR) re-activate when EB-06 fires.

---

## Executive summary (250 words)

This iter-2 plan applies 8 consolidated edit blocks from both reviewers
(Architect ITERATE + Critic ITERATE on iter-1) and pivots to
**Option B-minus**: ship Phase 1 verify/fix loop + Phase 2.5 ack-status
+ Phase 3 chain orchestration + Phase 4 polish/ADR/release, while
DEFERRING Phase 2 IPC primitives behind new EB-omcp-parity-06 (≥1
external user signal gate). Total stories drop from 25 to 20; sessions
compress from 4 to 3. The H1+H2 self-contradictions (Phase 3 claiming
IPC dependencies it never used + `team-collect --watch` punt) are
resolved by dropping the IPC stories outright. H3 reconciles the chain
handoff write-order to a single deterministic 5-step sequence (read →
snapshot → chain-state-write → clear → spawn), pinned in both pre-
mortem scenario 2 and US-P3-CHAIN-state-handoff acceptance criteria
with a crash-survivor vitest. H4 adds deterministic-fallback smoke
artifacts to P1/P3/P4 (mock-spawn when `OMCP_COPILOT_AUTH=missing`),
unblocking CI while keeping ≥1 live-smoke as the v2.1.0 LOCAL tag gate
(S4). H5 replaces iter-1's blanket Option C rejection with the narrow
EB-06 deferral. Architect #3 added a new Phase 3 story
(US-P3-CHAIN-preserve-P1-teamstate) explicitly testing cross-mode
contamination of fix_loop_count. Architect #5 verified moot for atomic-
rewrite team-ack but the ack-status story gained an 8-process
`child_process.spawn` concurrency test. Appendix B preserves the 6
deferred IPC story IDs verbatim for direct lift-into a future ralplan
when EB-06 fires. All 9 invariants apply per story; one story = one
commit; omc-style commit trailers throughout.
