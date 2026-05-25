# omcp team → omc team feature parity + ralph/team mixed orchestration

**Author**: Planner (ralplan iter-1, deliberate mode)
**Date**: 2026-05-25
**Baseline**: HEAD = `f66e7bc` (post v2.0.0-rc.1, CI green, Windows-first)
**Status**: INITIAL plan, awaiting Architect + Critic review
**Mode**: `--deliberate` (high-risk multi-system work: verify/fix loop + IPC + ralph/team cross-mode)
**Scope**: close Gap 1-4 (CRITICAL + MAJOR + MED + MINOR) against omc team behavioral parity AND deliver Phase 3 orchestration (`--chain` + `team-wait` + ralph dispatch guide)

---

## Provenance — which inputs drive which sections

| Section | Primary input | Rationale |
|---|---|---|
| Principles + Decision Drivers | RALPLAN-DR consensus protocol + omc/omcp gap analysis from session context | Step-2 alignment surface for Architect/Critic |
| Viable Options A/B/C | omc team phase machine (PhaseController in omc src/team/phase-controller.ts) + omcp existing `team-collect` extension surface | Need ≥2 viable; A=minimal, B=full IPC, C=incremental |
| Phase 1 (Gap 1 verify/fix) stories | omc 5-stage state machine; existing `runTeamCollect` already handles `fixing` for merge conflicts (src/cli/commands/team-phase-controller.ts:178-249) | Reuse the `fixing` phase that already exists; extend with verify checks |
| Phase 2 (Gap 2 IPC) stories | omc inbox/outbox/heartbeat protocol mesh | Stronger primitive set; bounded by what Copilot CLI workers can actually write |
| Phase 2.5 (Gap 3 worker status) stories | omc Task() auto-tracking via `~/.claude/tasks/<team>/K.json`; omcp existing `team-ack` CLI command (src/cli/commands/team-ack.ts) | Extend existing CLI verb, no new primitive |
| Phase 3 (orchestration) stories | session-context Phase 3 requirements + ralplan skill's chain semantics | Bridge ralplan → team → ralph for omc-style flows |
| Session map | iter-3 style (docs/plans/v1.8-to-v2.0-ralplan-iter3.md §A) | Per-session ≤8-18 commits + stop-and-replan rule |
| Pre-mortem 3 scenarios | deliberate mode requirement | High-risk multi-system: file-locking races + Copilot CLI flag drift + cross-mode state contamination |
| Expanded test plan | deliberate mode requirement | unit/integration/e2e/observability per Phase |
| ADR (Decision/Drivers/Alternatives/Why/Consequences/Follow-ups) | RALPLAN-DR final consensus output | post-Architect/Critic approval |

---

## RALPLAN-DR consensus alignment surface (Architect/Critic step-2)

### Principles (3-5)

1. **Reuse-first, no greenfield re-implementation.** `runTeamCollect` already
   transitions to `fixing` when shards conflict. Extend that surface to also
   transition into `fixing` when verify checks fail, rather than introducing
   a separate phase machine. Likewise: `team-ack` already writes ack JSON —
   extend it to optionally write worker-status (Gap 3) rather than introduce
   a new CLI verb.

2. **Copilot-portable primitives only.** Any worker-side write must be
   reachable from a Copilot CLI skill (`omcp <verb>` shell invocation). No
   reliance on Claude-only Task() auto-tracking, no JSON-RPC IPC. File-based
   mesh only. The 9 invariants apply (atomicWriteFileSync, assertSafeSlug,
   etc.).

3. **One story = one commit.** No codebase-wide audits. Use the v1.9
   `ERRORS-actionable` lesson: split big stories into 4 sub-stories rather
   than land a mega-commit. Each story has a single `Commit shape:` line.

4. **Tag-gate = live evidence.** Each Phase ends with a smoke artifact
   under `docs/smoke/omcp-team-parity/<phase>-<topic>.md` capturing real
   vitest output AND real-Copilot spawn output. "用事实说话" — no claim
   without artifact.

5. **No re-introduction of removed primitives.** ultraqa/sciomc remain
   removed per ADR-C-ultraqa-sciomc-removed.md. Verify/fix uses architect
   + critic + verifier agents through the existing `verify-phase` surface
   (src/cli/commands/verify-phase.ts) rather than reviving ultraqa.

### Decision Drivers (top 3)

1. **Behavioral parity ROI vs implementation cost.** Gap 1 (verify/fix loop)
   is the highest-ROI gap — without it omcp team is fire-and-forget while
   omc team self-corrects. Gap 2 (IPC) is medium ROI — useful but workers
   can already coordinate via shard JSON. Gap 3 (status auto-tracking) is
   low ROI — `team-ack` already supports the writeback pattern.

2. **Copilot CLI primitive constraints.** Copilot workers cannot run Task()
   API; they only have shell + omcp CLI. This forecloses 100% mesh parity
   and forces a file-based protocol. Decisions about retry semantics,
   cancellation propagation, and heartbeat must respect this.

3. **Cross-mode contamination risk.** Ralph and Team both write
   mode-state.json. When `--chain` orchestrates ralplan → team → ralph,
   state pivot races (ralph stomping team-state mid-run) are a real failure
   mode. Mutual-exclusion in MODE_CONFIGS already allows `team: false` and
   `ralph: true` — the chain must honor lifecycle separation.

### Viable Options (≥2)

#### Option A — Minimal verify/fix bolt-on, no IPC, ack-extend only

- **Scope**: Phase 1 (Gap 1) + Phase 2.5 (Gap 3 via team-ack extension) +
  Phase 4 (Gap 4 polish). Skip Phase 2 (Gap 2 IPC) entirely.
- **Pros**:
  - Smallest blast radius — extends `team-collect` and `team-ack` only.
  - Lowest cross-mode risk — no new file primitives.
  - Ships in 2-3 sessions.
- **Cons**:
  - Workers stay isolated (no inbox/outbox). Hard to coordinate parallel
    refactors that touch shared files.
  - Heartbeat-based dead-worker detection still depends on shard mtime
    rather than dedicated heartbeat file (existing watchdog already does
    this — acceptable trade-off).
  - omc parity gap remains visible: users mixing omc + omcp workflows
    will notice the messaging asymmetry.

#### Option B — Full omc parity (verify + IPC + status + shutdown + chain)

- **Scope**: All 4 gaps + Phase 3 orchestration. Build inbox/outbox/
  heartbeat primitives end-to-end. Implement `--chain` flag, `team-wait`
  command, ralph SKILL.md dispatch guide.
- **Pros**:
  - Closes all visible behavioral gaps. Users can pivot between omc and
    omcp without learning a new mental model.
  - IPC primitives unlock ralph dispatching team mid-loop (the "ralph
    parallelizes" pattern users want).
- **Cons**:
  - 5-7 sessions of work. High commit count.
  - File-based IPC has known race windows (atomic append vs concurrent
    read). Each primitive ships with concurrency tests.
  - Risk of architect/critic ITERATE on IPC story granularity (pidfile +
    heartbeat + outbox are 3 distinct write paths).

#### Option C — Incremental, gated by external user feedback

- **Scope**: Phase 1 (verify/fix) only in this iter. Phase 2 + 3 deferred
  to next plan iter, gated by ≥1 external user reporting the IPC gap as a
  blocker.
- **Pros**:
  - Smallest possible commit. Real-user-validated next step.
  - Avoids the "build the IPC nobody uses" anti-pattern.
- **Cons**:
  - omc parity messaging stays misleading ("omcp team is feature-parity"
    becomes false).
  - User-feedback gate is itself a USER_REQUIRED blocker (see v2.0
    `>=3 external users` precedent in ADR-v2.0-public-release-deferred).
  - Phase 3 chain orchestration is the user-requested deliverable —
    blocking it on feedback negates the request.

**Decision (this plan recommends)**: **Option B**, with Phase 3 as the
explicit ralph/team mixed-mode deliverable. Phase 2 IPC builds primitives
that Phase 3 depends on (heartbeat for `team-wait`; outbox for ralph
dispatch sub-team status). Skipping Phase 2 would force Phase 3 to fall
back to polling shard JSON, which is the same fire-and-forget pattern
we are explicitly trying to leave behind. Option A is the fallback if
Phase 2 architect-iter1 produces ITERATE with >3 hard issues.

**Why Option C is NOT selected**: The user request is the feedback signal.
Asking for "≥1 external user" feedback to gate IPC build is gold-plating
the gate. The session-context task explicitly lists Phase 3 as a target
deliverable, not a deferred follow-up. Marking C as invalidated, not just
unselected.

---

## External-blocker register

| ID | Marker | Description | Resolution path |
|---|---|---|---|
| EB-omcp-parity-01 | `[USER_REQUIRED]` | Copilot CLI authenticated on test machine (for live-mode e2e per session N+2 of this plan) | User: `copilot login`; record in session attestation |
| EB-omcp-parity-02 | `[ADR_DEFERRED]` | Worker-side outbox writer message schema (JSON-line `{ts, worker, type, payload}`): canonical schema needs ADR if Phase 2 architect ITERATEs on shape | Architect verdict gates ADR-omcp-team-outbox-schema |
| EB-omcp-parity-03 | `[ADR_DEFERRED]` | Cancellation propagation semantics (does `omcp cancel` kill in-flight verify? what about chain mid-run?) | Final story in Phase 3 writes ADR-omcp-cancel-semantics |
| EB-omcp-parity-04 | `[USER_REQUIRED]` | Live-mode `--chain` smoke run requires real Copilot CLI auth + ≥4 minutes of clock time (one ralplan + one team-4 + one ralph completion cycle) | User: schedule clock-time window; record N+3 attestation |
| EB-omcp-parity-05 | `[ADR_DEFERRED]` | Heartbeat freshness threshold (default 5 min) vs Copilot CLI typical turn latency — needs measurement before locking the default | N+2 verify story records empirical p95; lock or revise |

---

## Pre-mortem (3 scenarios) — deliberate mode

### Scenario 1: File-locking race in inbox/outbox under high parallelism

**Hypothesis**: 8+ workers appending to `.omcp/state/team/<sessionId>/
worker-K-outbox.jsonl` concurrently. atomicWriteFileSync only protects
whole-file rewrites; outbox is append-only by design. Torn writes on
process kill would corrupt the JSONL stream.

**Probability/Impact**: medium / high — corrupted outbox cascades to
monitor false-positives on `task_failed`.

**Mitigation**: US-P2-OUTBOX-write-helper acceptance criterion mandates
Windows-NTFS concurrency test (vitest pool=threads, 8 writers × 100
lines, read-back asserts no torn lines). Use `openSync(path, "a")` +
single `writeSync(line + "\n")`. Per-worker outbox files eliminate
inter-worker contention.

### Scenario 2: Copilot CLI flag/env-var drift between versions

**Hypothesis**: Future Copilot CLI may rename `--allow-all-tools` or
change `-p` stdin semantics. Verify-worker spawns (`copilot -p "..."`)
inherit any such drift, silently no-opping the verify-fix loop.

**Probability/Impact**: medium-low / high.

**Mitigation**: US-P1-DOCTOR-verify-spawn-shape asserts `copilot -p
"echo"` returns a recognizable model-id token (same shape as
US-1.8-T0-AUTH-precheck from iter-3). US-P1-VERIFY-smoke-artifact
captures real Copilot version banner + actual stdout per session.
Re-use existing cost-governor exit-handling pattern (mode.ts:386-410).

### Scenario 3: Ralph/team cross-mode state contamination under `--chain`

**Hypothesis**: `--chain` sequentially transitions ralplan → team → ralph.
Crash mid-transition (e.g., team-collect succeeds but ralph-spawn OOMs)
leaves orphaned `team-state.json` + half-written `ralph-state.json`
(`outerLoopOwned=true`). Subsequent `omcp status` shows two active
modes — violates MODE_CONFIGS expectations.

**Probability/Impact**: medium / medium.

**Mitigation**: US-P3-CHAIN-state-handoff requires atomic snapshot-and-
pivot: write `chain-state.json` BEFORE clearing prior mode-state. Crash
leaves discoverable marker for `omcp status`. US-P3-CHAIN-cancel-
propagation guarantees `omcp cancel` clears chain-state.json + prior
mode-state, leaving no orphans.

---

## Expanded test plan (per Phase) — deliberate mode

| Phase | Unit | Integration | E2E (live) | Observability |
|---|---|---|---|---|
| **P1 verify/fix** | `runTeamVerify` returns `{ok,signals}` over mock spawn; covers all-pass/vitest-fail/tsc-fail/biome-fail/combined-fail. `runTeamCollect` `needsFix` short-circuit: 0/1/all fail cases. | `team-launch → workers exit → team-verify → team-collect → fix-spawn → re-verify → completed` with mock-spawn for copilot+omcp. Loop bounded by `--max-fix-loops`. | Real 4-worker team writes failing tests → verify catches → fix spawn flips passing; smoke captures vitest before+after. | `verify-report-N.json` per iteration; `omcp status` surfaces `fix_loop_count`. |
| **P2 IPC** | `writeOutbox` round-trips 1000-line jsonl; `readNewOutboxMessages` cursor advance; `writeHeartbeat` mtime; `readInbox` parses markdown blocks. Concurrency vitest pool=threads, 8 writers no torn lines. | 4-worker team → 5 outbox events + 1 heartbeat per worker per turn → `team-collect --watch` ingests 20 events + 4 heartbeats in order. | Real Copilot worker calls `omcp team-outbox-write` from spawn → orchestrator observes event (verifies Windows shell escape). | `omcp status --json` exposes `lastHeartbeat`/`outboxCursor`/`inboxPending` per worker. |
| **P2.5 ack-status** | `runTeamAck --status <s>` updates TeamState atomically; idempotency on repeat; invalid status → exit 2. | 4-worker spawn → each calls `omcp team-ack --status completed` → `omcp status` shows 4/4 completed; logged-warning on backwards transitions but call succeeds. | Piggybacks on P1 E2E — asserts 4/4 worker-status=completed. | `omcp status` Worker table status column. |
| **P3 chain** | `parseChainArgs` returns ordered step list; `runChain(steps)` halts on first non-zero with chain-state.json marker. `team-wait` polls TeamState terminal phase. | Mock-spawn 3-step chain executes in order; step 2 fails → step 3 not spawned, chain-state persists. team-wait timeout path covered. | Real `omcp ralplan --chain "fix typo in README" --then team 2 --then ralph-verify` end-to-end; smoke captures all 3 handoffs. | `omcp status` shows `current_chain_step`; chain-state.json discoverable post-crash. |
| **P4 shutdown polish** | Existing `shutdownTeam` tests pass; ack-write timing within 30s. | 4-worker team receives shutdown → all 4 ack within timeout → no SIGTERM fallback. | Piggybacks on P1/P2 E2E; absence of SIGTERM message in logs. | (none new — relies on existing shutdown-report semantics.) |

---

## Per-session commit budget + stop-and-replan rule

Each session below carries an explicit commit-budget ceiling. If a
session ends with >8 stories incomplete vs the session nominal target,
the NEXT session leads with a `replan-iter1-remaining` planning commit
that consumes a vitest +0 slot but writes a one-page "what carries
forward, why" doc under `.omcp/plans/`. Modeled on iter-3 §A from the
v1.8→v2.0 ralplan.

**Effective story-vs-commit accounting**:
- Phase 1 verify-spawn + verify-signals + collect-extension are 3
  closely-related stories → matrix-merge candidate ONLY if `it.each`
  scaffold fits (otherwise individual commits per story).
- Phase 2 outbox + inbox + heartbeat are 3 distinct primitives → one
  commit per primitive, no matrix-merge.
- Phase 3 chain + team-wait + ralph-dispatch-guide are 3 distinct
  surfaces → one commit per story.

## Session execution map (N+1 ... N+4, 4 sessions, risk-ordered)

Session N is this planning pass. Sessions N+1 .. N+4 execute the plan.
**Total: 4 sessions** (matches the 4-Phase breakdown).

| Session | Theme | Stories landed (nominal IDs) | Commit budget | Tag at end | External prereq | Vitest delta |
|---|---|---|---|---|---|---|
| **N+1** | Gap 1 verify/fix loop kickoff: doctor verify-spawn → verify-runner → collect-extension → fix-spawn → loop-bounding → smoke | US-omcp-parity-P1-DOCTOR-verify-spawn-shape, US-omcp-parity-P1-VERIFY-runner, US-omcp-parity-P1-COLLECT-needsfix-shortcircuit, US-omcp-parity-P1-FIX-worker-spawn, US-omcp-parity-P1-FIX-loop-bounding, US-omcp-parity-P1-VERIFY-smoke-artifact | ≤14 commits | none | Copilot CLI authed | +18 to +28 |
| **N+2** | Gap 2 IPC primitives + Gap 3 ack-extend: outbox → inbox → heartbeat → worker-skill-update → ack-status-extend → live smoke | US-omcp-parity-P2-OUTBOX-write-helper, US-omcp-parity-P2-OUTBOX-read-cursor, US-omcp-parity-P2-INBOX-write-helper, US-omcp-parity-P2-HEARTBEAT-write-poll, US-omcp-parity-P2-WORKER-SKILL-update, US-omcp-parity-P2.5-ACK-status-flag, US-omcp-parity-P2-IPC-smoke-artifact | ≤13 commits | none | Copilot CLI authed | +20 to +30 |
| **N+3** | Phase 3 orchestration: chain parser → chain runner → team-wait → ralph dispatch guide → chain smoke | US-omcp-parity-P3-CHAIN-parser, US-omcp-parity-P3-CHAIN-runner, US-omcp-parity-P3-CHAIN-state-handoff, US-omcp-parity-P3-CHAIN-cancel-propagation, US-omcp-parity-P3-TEAM-WAIT-cli, US-omcp-parity-P3-RALPH-SKILL-dispatch-guide, US-omcp-parity-P3-CHAIN-smoke-artifact | ≤12 commits | none | Copilot CLI authed (chain smoke) | +14 to +22 |
| **N+4** | Phase 4 shutdown polish + Phase 1-3 integration + ADR + release tag | US-omcp-parity-P4-SHUTDOWN-worker-ack-skill-update, US-omcp-parity-P4-INTEGRATION-smoke, US-omcp-parity-ADR-write, US-omcp-parity-CHANGELOG-entry, US-omcp-parity-RELEASE-cut | ≤7 commits | **v2.1.0** local | none | +4 to +8 |

**Why this 4-session split**: Phase 1 in N+1 unblocks meaningful
verify/fix value alone (Option A floor). Phase 2 + 2.5 batched in N+2
because outbox/inbox/heartbeat share atomic-append helper code; ack-status
extension is a 1-commit add that piggybacks on the same session. Phase 3
gets its own session because chain orchestration is conceptually distinct
and shouldn't compete with primitive-build work. N+4 is integration +
release.

**Session-stop rule** (formalized, lifted from iter-3): if at session-end
>8 stories from the session nominal list are incomplete, the next
session leads with `replan-iter1-remaining` planning commit.

**Ceiling-vs-body honesty disclosure**: N+1 nominal body = 6 stories vs
ceiling 14. Budget held intentionally because Phase 1 has high
inter-story coupling (verify-runner ↔ collect-shortcircuit ↔ fix-spawn);
expect some stories to need iteration. N+2 nominal body = 7 stories vs
ceiling 13. N+3 nominal body = 7 vs 12. N+4 = 5 vs 7. All sessions have
budget cushion for unexpected fix-up commits.

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
    spawns `copilot -p "echo verify-spawn-check"` and asserts exit-0
    + stdout contains a recognizable Copilot model id (`gpt-` or
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
    (`npx biome check src/`) in sequence. Captures each tool's exit code
    + truncated stdout (last 200 lines).
  - Writes `.omcp/state/team/<sessionId>/verify-report-N.json` where N
    is the loop iteration. Schema:
    `{iteration, ts, vitest:{exitCode,tail}, tsc:{exitCode,tail}, biome:{exitCode,tail}, ok:boolean}`.
  - When any tool fails: writes a sibling
    `worker-K-verify-fail.json` per worker (signaling Gap 1 fix-needed).
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
  - `runTeamCollect` extended: when ANY worker has `verify-fail.json` in
    pidDir, transition to `fixing` instead of `completed` (currently:
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
  - `docs/smoke/omcp-team-parity/phase1-verify-fix-loop.md` captures:
    real Copilot version banner, real `omcp team 2:executor "fail one
    test"`, real `omcp team-verify` output showing 1 fail → fixing
    transition, real fix-worker spawn output, re-verify showing pass,
    final `omcp team-collect` showing `completed`.
  - Artifact attests baseline + post-fix vitest output unchanged
    against project test count (no test deletion).
- **Dependencies**: All Phase 1 stories above
- **Confidence**: med (depends on live Copilot auth + ≥4 min clock time)
- **Commit shape**: `docs(smoke): phase1 verify-fix loop live attestation`

---

## Phase 2 stories — Gap 2: IPC primitives (MAJOR impact, MED ROI)

### Phase 2 entry/exit

- **Entry**: Phase 1 complete (verify/fix loop working).
- **Exit**: 4-worker team can read/write outbox + inbox + heartbeat with
  the orchestrator's `team-collect --watch` monitoring loop ingesting
  events in real-time.

### US-omcp-parity-P2-OUTBOX-write-helper

- **Risk class**: CATASTROPHIC (concurrent append on Windows NTFS)
- **Invariants**: I1 (sessionId), I8 (CLI shape)
- **Acceptance criteria**:
  - New CLI verb: `omcp team-outbox-write <sessionId> <workerIndex>
    <type> <payload-json>`. Appends 1 JSONL line to
    `.omcp/state/team/<sessionId>/worker-K-outbox.jsonl`.
  - Append uses `openSync(path, "a")` + single `writeSync(line + "\n")`.
    NOT atomicWriteFileSync (which would truncate; append is the
    contract).
  - vitest concurrency: 8 parallel processes writing 100 lines each;
    read-back shows 800 well-formed JSON lines with no truncated
    fragments (no `}{` adjacency).
  - vitest: bad sessionId via assertSafeSlug throws exit-2 (defense-in-depth).
- **Files**: `src/cli/commands/team-outbox.ts` (new),
  `src/cli/omcp.ts` (registration), `src/__tests__/team-outbox.test.ts` (new).
- **Dependencies**: none (independent primitive)
- **Confidence**: med (Windows-NTFS append guarantees need verification)
- **Commit shape**: `feat(team-outbox): add omcp team-outbox-write with concurrent-safe append`

### US-omcp-parity-P2-OUTBOX-read-cursor

- **Risk class**: MAJOR
- **Invariants**: I1 (sessionId), I2 (atomicWriteFileSync for cursor file)
- **Acceptance criteria**:
  - New helper `readNewOutboxMessages(sessionId, workerIndex)` in
    `src/lib/team-outbox.ts`. Tracks byte-offset cursor in
    `.omcp/state/team/<sessionId>/worker-K-outbox.cursor.json`.
  - Returns array of `{ts, type, payload}` objects. Cursor advances
    only after caller commits read (idempotent re-read possible).
  - vitest: write 5 lines + read = 5 entries; write 3 more + read = 3
    new entries (cursor advanced); reset-cursor returns all 8.
- **Files**: `src/lib/team-outbox.ts` (new), tests under `src/__tests__/`.
- **Dependencies**: US-omcp-parity-P2-OUTBOX-write-helper
- **Confidence**: high
- **Commit shape**: `feat(team-outbox): byte-cursor readNewOutboxMessages helper`

### US-omcp-parity-P2-INBOX-write-helper

- **Risk class**: MAJOR
- **Invariants**: I1, I2
- **Acceptance criteria**:
  - New CLI verb: `omcp team-inbox-write <sessionId> <toWorkerIndex>
    <messageBody>`. Appends a markdown block to
    `.omcp/state/team/<sessionId>/worker-K-inbox.md` with format:
    `## <ts>\n<messageBody>\n\n`.
  - Use `openSync(path, "a")` semantics (same as outbox).
  - vitest: 10 sequential writes produce 10 markdown blocks readable
    in order. Special-char (backtick, dollar) payload escapes safely.
- **Files**: `src/cli/commands/team-inbox.ts` (new),
  `src/cli/omcp.ts` (registration), tests.
- **Dependencies**: none (independent of outbox)
- **Confidence**: high
- **Commit shape**: `feat(team-inbox): add omcp team-inbox-write markdown append`

### US-omcp-parity-P2-HEARTBEAT-write-poll

- **Risk class**: MAJOR (dead-worker detection accuracy)
- **Invariants**: I1, I2
- **Acceptance criteria**:
  - New CLI verb: `omcp team-heartbeat <sessionId> <workerIndex>`.
    Writes `.omcp/state/team/<sessionId>/worker-K-heartbeat.json`
    with `{ts, pid}`.
  - New helper `isWorkerAlive(sessionId, workerIndex, maxAgeMs)` reads
    the heartbeat file + checks mtime + pidfile alive-check (combines
    fresh signal with the existing `process.kill(pid, 0)` probe).
    Default maxAgeMs = 300000 (5 min); env override
    `OMCP_TEAM_HEARTBEAT_MAX_AGE_MS`.
  - Existing `runTeamWatchdog` (src/cli/commands/team.ts:383) extended
    to consult heartbeat first, then shard mtime, then pidfile mtime
    (fallback chain).
  - vitest: 0 heartbeats → fallback to shard/pidfile mtime (existing
    behavior preserved); 1 fresh heartbeat → alive; 1 heartbeat older
    than maxAgeMs → stuck.
- **Files**: `src/cli/commands/team-heartbeat.ts` (new),
  `src/lib/team-heartbeat.ts` (new), `src/cli/commands/team.ts`
  (watchdog extension), tests.
- **Dependencies**: none
- **Confidence**: med (interaction with existing watchdog needs careful test coverage)
- **Commit shape**: `feat(team-heartbeat): add heartbeat write + alive-check + watchdog integration`

### US-omcp-parity-P2-WORKER-SKILL-update

- **Risk class**: MAJOR (worker behavior change)
- **Invariants**: I9 (no banned tokens in shipped prompts)
- **Acceptance criteria**:
  - `skills/team-worker/SKILL.md` updated with new "IPC" section:
    instructions for workers to (a) call `omcp team-heartbeat` at each
    work-loop iteration; (b) call `omcp team-outbox-write` to signal
    `task_complete`/`task_failed`/`idle`/`error`; (c) poll
    `.omcp/state/team/<sessionId>/worker-K-inbox.md` after each task.
  - Plugin mirror at `plugins/oh-my-copilot/skills/team-worker/SKILL.md`
    regenerated via `scripts/sync-plugin-mirror.ts`. Verify
    `cli-wiring-invariants.test.ts` mirror-sync test still passes.
  - Skill front-matter unchanged. No Claude-only tool names introduced.
- **Files**: `skills/team-worker/SKILL.md` (edit), regenerated mirror.
- **Dependencies**: US-omcp-parity-P2-OUTBOX-write-helper,
  US-omcp-parity-P2-HEARTBEAT-write-poll, US-omcp-parity-P2-INBOX-write-helper.
- **Confidence**: high
- **Commit shape**: `docs(team-worker): document heartbeat + outbox + inbox protocol`

### US-omcp-parity-P2.5-ACK-status-flag (Gap 3, batched into N+2)

- **Risk class**: MED (extends existing surface)
- **Invariants**: I1, I2, I8
- **Acceptance criteria**:
  - `omcp team-ack <sessionId> <workerIndex> [--status <state>]`
    optional flag. When passed, updates TeamState workers[K].status to
    `<state>` atomically before writing ack JSON. Default behavior
    unchanged when --status omitted.
  - Valid states: `pending`, `in_progress`, `completed`, `failed`.
    Invalid state → exit 2 with explanation.
  - `runTeamAck` returns `{ackFile, ackedAt, statusUpdated}`. CLI
    prints status update when applied.
  - vitest covers: omit --status → no state change; --status completed
    → TeamState updated + ack file written; --status invalid → exit 2;
    concurrent ack calls from 4 workers → all 4 status updates land
    without race (use the existing atomicWriteFileSync on TeamState).
- **Files**: `src/cli/commands/team-ack.ts` (extend),
  `src/cli/omcp.ts` (option declaration), tests.
- **Dependencies**: none (extends existing CLI)
- **Confidence**: high
- **Commit shape**: `feat(team-ack): --status flag to update worker status atomically`

### US-omcp-parity-P2-IPC-smoke-artifact

- **Risk class**: gate
- **Invariants**: I3
- **Acceptance criteria**:
  - `docs/smoke/omcp-team-parity/phase2-ipc.md` captures: real 4-worker
    team spawn, each worker writing 5 outbox events + 1 heartbeat,
    orchestrator `omcp team-collect --watch` (new flag added below)
    ingesting 20 events in correct order, inbox-write from
    orchestrator → worker reads next turn.
  - Add `omcp team-collect --watch` minor extension (poll outbox cursor
    every 2s until current_phase terminal) if not already implemented
    by US-P2-OUTBOX-read-cursor — verify the watch loop is wired
    end-to-end via this smoke.
- **Dependencies**: All Phase 2 stories above
- **Confidence**: med (live time + auth)
- **Commit shape**: `docs(smoke): phase2 IPC primitives live attestation`

---

## Phase 3 stories — orchestration (ralph/team mixed mode)

### Phase 3 entry/exit

- **Entry**: Phase 1 + Phase 2 complete; verify/fix loop and IPC work.
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
    `{currentStep, completedSteps, failedStep, ts}`. `omcp status`
    surfaces this.
  - `runChain` returns aggregated exit code (max of all steps).
  - vitest: 3-step chain mock-spawn happy-path → all-completed; step 2
    fails → step 3 not spawned, chain-state.json persists failedStep=2.
- **Files**: `src/cli/commands/chain.ts` (extend), tests.
- **Dependencies**: US-omcp-parity-P3-CHAIN-parser, Phase 1 + Phase 2 stories.
- **Confidence**: med (cross-mode call surface needs careful test)
- **Commit shape**: `feat(chain): sequential runChain with crash-resume marker`

### US-omcp-parity-P3-CHAIN-state-handoff

- **Risk class**: MAJOR (pre-mortem scenario 3)
- **Invariants**: I1, I2 (chain-state.json), I8
- **Acceptance criteria**:
  - Before each transition between steps, `runChain` calls
    `prepareTransition(fromMode, toMode)`:
      - Reads from-mode's state (e.g., team-state.json).
      - Writes a snapshot to `.omcp/state/chain-handoffs/<step-N>.json`.
      - Clears from-mode's state (so to-mode's MODE_CONFIGS check passes).
      - ONLY THEN spawns to-mode.
  - On crash mid-handoff: chain-state.json reflects last completed
    step; `omcp cancel` cleans up safely.
  - vitest: simulated crash between team-completion and ralph-spawn
    leaves chain-state.json with `failedStep=ralph` + handoff snapshot
    preserved for postmortem.
- **Files**: `src/cli/commands/chain.ts` (extend), tests.
- **Dependencies**: US-omcp-parity-P3-CHAIN-runner
- **Confidence**: med
- **Commit shape**: `feat(chain): atomic state handoff between chain steps`

### US-omcp-parity-P3-CHAIN-cancel-propagation

- **Risk class**: MAJOR (pre-mortem scenario 3 b)
- **Invariants**: I1, I2, I8
- **Acceptance criteria**:
  - When `omcp cancel` runs while chain is active (chain-state.json
    exists + has non-terminal step): writes cancel marker AND clears
    chain-state.json AND signals current step's mode-state.json to halt
    on next checkpoint (mode-state cancelled=true).
  - vitest: ralph step running + omcp cancel → chain-state.json
    cleared + cancel marker present.
  - Architecturally writes ADR-omcp-cancel-semantics covering: which
    modes honor mid-step cancel? (ralph yes via existing
    `outerLoopOwned` check; team-verify yes via cancel-marker check
    at each iteration; team-launch no — spawned workers must finish
    or be SIGTERMed).
- **Files**: `src/cli/commands/chain.ts` (extend),
  `src/cli/commands/cancel.ts` or equivalent path (extend),
  `docs/adr/ADR-omcp-cancel-semantics.md` (new).
- **Dependencies**: US-omcp-parity-P3-CHAIN-state-handoff
- **Confidence**: med
- **Commit shape**: `feat(chain): omcp cancel propagates across chain steps + ADR`

### US-omcp-parity-P3-TEAM-WAIT-cli

- **Risk class**: MED (small surface addition; useful for ralph→team mixing)
- **Invariants**: I1, I8
- **Acceptance criteria**:
  - New CLI verb: `omcp team-wait <sessionId> [--timeout <secs>]`.
    Polls TeamState.current_phase every 2s. Exits 0 when phase ∈
    {completed}, exit 1 when {failed}, exit 2 when timeout, exit 3
    when session not found.
  - Default timeout: 1800s (30 min); env override
    `OMCP_TEAM_WAIT_TIMEOUT_S`.
  - vitest: mock 3 polls returning `executing` then `completed` → exit
    0; mock timeout → exit 2.
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
  - Plugin mirror regenerated.
- **Files**: `skills/ralph/SKILL.md` (edit), plugin mirror.
- **Dependencies**: US-omcp-parity-P3-TEAM-WAIT-cli
- **Confidence**: high
- **Commit shape**: `docs(ralph): dispatch sub-team for parallel-safe story batches`

### US-omcp-parity-P3-CHAIN-smoke-artifact

- **Risk class**: gate
- **Invariants**: I3
- **Acceptance criteria**:
  - `docs/smoke/omcp-team-parity/phase3-chain.md` captures: real
    `omcp ralplan --chain "fix README typo" --then team 2 --then
    ralph-verify`, full output of all 3 phases, chain-state.json
    transitions, final `omcp status` showing chain=completed.
- **Dependencies**: All Phase 3 stories above
- **Confidence**: med
- **Commit shape**: `docs(smoke): phase3 chain orchestration live attestation`

---

## Phase 4 stories — graceful shutdown polish + integration + release

### US-omcp-parity-P4-SHUTDOWN-worker-ack-skill-update

- **Risk class**: MED
- **Invariants**: I9
- **Acceptance criteria**:
  - `skills/team-worker/SKILL.md` shutdown section (already covers
    `omcp team-ack`) extended to remind workers to also call
    `omcp team-heartbeat` immediately before ack (so dead-detection
    knows the worker was alive at exit).
  - vitest: shutdownTeam integration test from
    `src/team/__tests__/sentinel-gate.test.ts` (or equivalent) still
    passes with new heartbeat-before-ack pattern.
- **Files**: `skills/team-worker/SKILL.md` (edit).
- **Dependencies**: US-omcp-parity-P2-HEARTBEAT-write-poll
- **Confidence**: high
- **Commit shape**: `docs(team-worker): heartbeat-before-ack in shutdown protocol`

### US-omcp-parity-P4-INTEGRATION-smoke

- **Risk class**: gate (full-stack regression)
- **Invariants**: I3
- **Acceptance criteria**:
  - `docs/smoke/omcp-team-parity/phase4-integration.md` captures: full
    chain pipeline with intentional 1 verify-fail injection, fix-worker
    spawned, re-verify passes, all 4 workers ack gracefully (no SIGTERM
    fallback fires), chain completes, ralph-verify approves.
- **Dependencies**: All prior stories
- **Confidence**: med
- **Commit shape**: `docs(smoke): phase4 full-stack integration attestation`

### US-omcp-parity-ADR-write

- **Risk class**: MED
- **Invariants**: I3 (CHANGELOG entry)
- **Acceptance criteria**:
  - `docs/adr/ADR-omcp-team-omc-parity.md` written per RALPLAN-DR
    final consensus output: Decision, Drivers, Alternatives considered
    (A/B/C), Why Option B chosen, Consequences (cost, support burden,
    deferred follow-ups), Follow-ups (Phase 5+ ideas).
- **Dependencies**: All prior stories
- **Confidence**: high
- **Commit shape**: `docs(adr): omcp team omc parity decision record`

### US-omcp-parity-CHANGELOG-entry

- **Risk class**: low
- **Invariants**: I3
- **Acceptance criteria**:
  - `CHANGELOG.md` `## [Unreleased]` -> `## [2.1.0] - 2026-MM-DD`
    section enumerates: Gap 1 verify/fix, Gap 2 IPC, Gap 3 worker
    status, Gap 4 polish, Phase 3 chain orchestration. References
    smoke artifact paths.
- **Dependencies**: US-omcp-parity-ADR-write
- **Confidence**: high
- **Commit shape**: `docs(changelog): v2.1.0 omc-parity entry`

### US-omcp-parity-RELEASE-cut

- **Risk class**: MED (4-manifest sync per I3)
- **Invariants**: I3 (4-manifest sync), I8
- **Acceptance criteria**:
  - `src/scripts/release.ts` invocation bumps all 4 manifests to 2.1.0.
  - `cli-wiring-invariants.test.ts` passes (4-manifest version match).
  - Local git tag v2.1.0 created. **npm publish is `[USER_REQUIRED]`**
    per ADR-v2.0-public-release-deferred and is NOT in this plan.
- **Dependencies**: All prior stories
- **Confidence**: high
- **Commit shape**: `chore(release): v2.1.0 — omc-parity (verify/fix + IPC + chain)`

---

## Appendix A — Story ID master list (per critic-iter3 §J precedent)

### Phase 1 (6 stories)
1. US-omcp-parity-P1-DOCTOR-verify-spawn-shape
2. US-omcp-parity-P1-VERIFY-runner
3. US-omcp-parity-P1-COLLECT-needsfix-shortcircuit
4. US-omcp-parity-P1-FIX-worker-spawn
5. US-omcp-parity-P1-FIX-loop-bounding
6. US-omcp-parity-P1-VERIFY-smoke-artifact

### Phase 2 + 2.5 (7 stories)
7. US-omcp-parity-P2-OUTBOX-write-helper
8. US-omcp-parity-P2-OUTBOX-read-cursor
9. US-omcp-parity-P2-INBOX-write-helper
10. US-omcp-parity-P2-HEARTBEAT-write-poll
11. US-omcp-parity-P2-WORKER-SKILL-update
12. US-omcp-parity-P2.5-ACK-status-flag
13. US-omcp-parity-P2-IPC-smoke-artifact

### Phase 3 (7 stories)
14. US-omcp-parity-P3-CHAIN-parser
15. US-omcp-parity-P3-CHAIN-runner
16. US-omcp-parity-P3-CHAIN-state-handoff
17. US-omcp-parity-P3-CHAIN-cancel-propagation
18. US-omcp-parity-P3-TEAM-WAIT-cli
19. US-omcp-parity-P3-RALPH-SKILL-dispatch-guide
20. US-omcp-parity-P3-CHAIN-smoke-artifact

### Phase 4 (5 stories)
21. US-omcp-parity-P4-SHUTDOWN-worker-ack-skill-update
22. US-omcp-parity-P4-INTEGRATION-smoke
23. US-omcp-parity-ADR-write
24. US-omcp-parity-CHANGELOG-entry
25. US-omcp-parity-RELEASE-cut

**Total: 25 stories across 4 sessions.**

---

## Executive summary (250 words)

This plan closes the 4 behavioral gaps between omcp team and omc team
while delivering the requested Phase 3 ralph/team mixed orchestration.
After reviewing the codebase, we found `runTeamCollect` already
implements a `fixing` transition for merge conflicts (`team-phase-
controller.ts:178-249`) and `runTeamAck` already supports session-scoped
worker writes (`team-ack.ts:34`). Phase 1 extends those surfaces to
detect verify-fail signals (new `omcp team-verify <session>` CLI) and
spawn bounded fix-workers via a debugger agent. Phase 2 builds the
file-based IPC mesh — outbox (concurrent-safe append), inbox (markdown
append), heartbeat (mtime-based liveness) — keeping Copilot-portability
as principle 2 (no Task() reliance, only `omcp <verb>` shell calls).
Phase 2.5 extends `team-ack` with `--status` flag (Gap 3 worker
auto-tracking). Phase 3 introduces `omcp ralplan --chain --then ...`
for ralplan → team → ralph pipelines, `omcp team-wait <session>` for
synchronous ralph→team coordination, and ralph SKILL.md updates for
agent-driven sub-team dispatch. Phase 4 ships smoke artifacts, ADR,
CHANGELOG, and a v2.1.0 release tag. Deliberate mode pre-mortem covers
Windows-NTFS append concurrency, Copilot CLI flag drift, and cross-mode
state contamination — each mitigated by specific acceptance criteria.
25 stories across 4 sessions; per-session budgets ≤14 commits with
stop-and-replan rule. Option B (full parity) recommended over A
(minimal) or C (incremental — explicitly invalidated). All 9 invariants
apply per story; tag-gate = live evidence per "用事实说话".

---

## Return-to-orchestrator note for Architect (100 words)

Architect: this plan recommends **Option B (full omc parity)** over
Option A (minimal verify-only) and Option C (incremental-gated, explicitly
invalidated). Phase 2 IPC is the gating decision — if you ITERATE with
>3 hard issues on IPC stories (P2-OUTBOX-write-helper, P2-HEARTBEAT-
write-poll, P2-INBOX-write-helper), please flag fallback to Option A as
the next iter direction. Otherwise focus your steelman antithesis on:
(a) is Phase 3 `--chain` adequately decoupled from Phase 2 primitives,
or does chain leak IPC assumptions? (b) is the pre-mortem scenario 3
(state contamination) sufficiently mitigated by chain-state.json? (c)
acceptance-criteria testability — are vitest assertions concrete enough
for executor handoff? Tradeoff tensions welcome: build-cost vs parity
ROI vs Copilot-portability rigidity.
