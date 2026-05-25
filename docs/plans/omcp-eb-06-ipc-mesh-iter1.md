# EB-omcp-parity-06 IPC Mesh — iter-1 (Planner pass)

**Author**: Planner (ralplan, deliberate mode — high-risk concurrency + multi-process)
**Date**: 2026-05-25
**Baseline**: HEAD = `087c61d` (post v2.1 + Story 21 team-loop backfill)
**Status**: ITER-1 planner draft, pending Architect + Critic review
**Triggering gate**: EB-omcp-parity-06 from `docs/plans/omcp-team-omc-parity-iter2.md`. The
gate documents: "≥1 external user reports IPC mesh as a workflow blocker for
their workflow." The current request comes from the maintainer themself,
NOT an external user — see §"Gate-trigger interpretation" below. This iter
proceeds on the maintainer's explicit override authority over their own
gate, with the trade-off documented in the ADR (Consequences §6).

---

## Scope — what this iter ships

The 6 deferred Phase 2 IPC stories from iter-2 plan Appendix B (preserved
verbatim there for lift-into):

1. **US-omcp-parity-P2-OUTBOX-write-helper** — concurrent-safe NTFS append,
   8-process write test, JSONL stream integrity.
2. **US-omcp-parity-P2-OUTBOX-read-cursor** — byte-offset cursor reader so
   consumers don't re-read already-processed entries.
3. **US-omcp-parity-P2-INBOX-write-helper** — Markdown append for
   leader→worker messages.
4. **US-omcp-parity-P2-HEARTBEAT-write-poll** — mtime liveness + watchdog
   integration; replaces the existing `runTeamWatchdog` shard-mtime probe
   with a dedicated heartbeat file.
5. **US-omcp-parity-P2-WORKER-SKILL-update** — workers call
   `omcp team-heartbeat` + `omcp team-outbox-write` + poll inbox.md at
   each checkpoint.
6. **US-omcp-parity-P2-IPC-smoke-artifact** — deterministic + live smoke
   for the IPC mesh end-to-end.

Plus the 2 sub-ADRs that re-activate when EB-06 fires:
- **EB-omcp-parity-02** — outbox schema ADR (JSONL line shape, version field,
  field allowlist).
- **EB-omcp-parity-05** — heartbeat freshness threshold ADR (default Nms,
  env override, watchdog interaction).

## Gate-trigger interpretation

The EB-06 gate text says "≥1 external user." This iter is triggered by
**maintainer override**, not an external user signal. Two options were
considered:

- **A.** Stop and refuse — wait for genuine external user. Honest to
  "用事实说话" but the maintainer has authority over their own gate.
- **B.** Proceed as maintainer override + document explicitly in the
  ADR's Consequences section. Chose this.

Rationale: the gate is a self-imposed discipline rule to avoid "build IPC
that nobody uses." The maintainer choosing to override it is a conscious
acceptance of that anti-pattern risk + a willingness to maintain the IPC
surface even if no other user surfaces. Documented in the resulting
ADR-omcp-eb-06-ipc-mesh-revival.md so future readers can re-evaluate.

---

## Principles (RALPLAN-DR — 4 of them)

1. **TDD-first per story.** Every story lands with a failing test FIRST,
   then implementation that makes it pass. No exception. Per user prompt:
   "基于 TTD 测试通过才能放行 / multiple agents must verify via TDD before release."

2. **Concurrency-safety is non-negotiable.** Phase 2 IPC is the surface
   where NTFS handle-sharing, multi-process append races, and mtime
   precision matter. Every helper ships with an 8-process
   `child_process.spawn` concurrent test as the verification floor.

3. **Reuse v2.1 primitives where they fit.** Heartbeat layer should
   extend (not replace) the existing `runTeamWatchdog` shard-mtime
   probe — the watchdog stays as a fallback for workers that don't yet
   call `omcp team-heartbeat`.

4. **Independent-context review per story.** Per user prompt, every
   story gets dispatched to (architect-subagent + critic-subagent) in
   independent contexts for review. The team+critic loop runs PER STORY,
   not just at the plan level.

## Decision Drivers (top 3)

1. **NTFS atomic-append vs rename-over-target trade-off.** Windows NTFS
   does NOT guarantee atomic append for multi-process writers; the
   POSIX `O_APPEND` semantic is unreliable across processes on Windows.
   The outbox-write-helper must choose between (a) per-line rewrite via
   `atomicWriteFileSync` (slow, but safe), (b) `fs.appendFileSync` with
   explicit file locking via `proper-lockfile` or equivalent, or
   (c) write each message to a separate file then `cat` them at read
   time. Driver: this choice cascades to every other Phase 2 story.

2. **Live-CLI test feasibility.** v2.1 N+1/N+2/N+3 used deterministic
   harnesses + injected spawn for fast vitest runs. Phase 2's 8-process
   concurrent test inherently requires REAL `child_process.spawn` — the
   prior iter-2 critic flagged this as "heavy and flaky on Windows."
   Driver: how do we keep CI runtime budget bounded?

3. **Heartbeat frequency vs runtime cost.** Each worker calling
   `omcp team-heartbeat` every Ns spawns a new Copilot CLI subprocess
   (heavy). Picking a too-frequent interval makes workers spend more
   time heartbeating than working; too infrequent makes dead-worker
   detection slow. Driver: EB-omcp-parity-05 ADR must pin this value
   with explicit measurement evidence.

## Viable Options (≥2)

### Option A — Full omc-style IPC mesh, all 6 stories, deterministic-only

- **Scope**: ship all 6 Appendix B stories with vitest deterministic
  tests (mock-spawn for the 8-process test). NO live smoke until a
  follow-up iter.
- **Pros**: Fastest path; CI runtime stays under 5 min; matches the
  v2.1 N+1/N+3 cadence.
- **Cons**: No real Windows multi-process NTFS evidence. The whole
  point of Phase 2 deferral was concerns about NTFS append races —
  shipping without real-process verification defeats the deferral
  rationale.

### Option B — Full mesh + REAL 8-process concurrent test (CHOSEN by Planner)

- **Scope**: 6 stories + each ships a `child_process.spawn`-based 8-
  process integration test. Test runtime budget: ≤30s per story.
  Deterministic in-process tests STILL ship as the fast-feedback layer.
- **Pros**: Matches the iter-2 critic's explicit Phase 2 acceptance
  criterion ("8-process child_process.spawn concurrent test (NOT
  vitest pool=threads)"). Closes the deferral rationale.
- **Cons**: ~2× the test-writing effort per story. CI runtime grows by
  ~3 min total (6 stories × ~30s). Acceptable.

### Option C — Defer-again (status quo)

- **Scope**: Reject this iter; keep Phase 2 deferred behind EB-06.
- **Pros**: Honest to the original EB-06 gate (no external user signal).
- **Cons**: Maintainer has explicit override authority; the deferral
  was always "defer-not-cancel"; refusing the maintainer's request
  conflicts with their stated intent.

**Decision (Planner recommends)**: Option B. Architect + Critic to
re-evaluate.

---

## Deliberate-mode (this iter is high-risk)

### Pre-mortem — 3 scenarios

#### Scenario 1: NTFS append race torn JSONL

**Hypothesis**: Two worker processes call `omcp team-outbox-write`
simultaneously. Both `fs.appendFileSync` calls land mid-write; the
resulting outbox.jsonl has interleaved bytes that aren't valid JSON
on any line.

**Probability/Impact**: high / high — this IS the race the iter-2
critic was worried about.

**Mitigation**: Adopt `proper-lockfile` (or hand-rolled fs.openSync
exclusive-create) for the outbox file. Every write acquires + releases
a lockfile sidecar. 8-process test asserts every line in the resulting
JSONL parses as valid JSON + total line count matches sum of writers'
intents.

#### Scenario 2: Heartbeat false-positive worker-dead

**Hypothesis**: Worker is alive but heartbeat-writer subprocess is
delayed (Windows AV scan, npm cache cold-fetch). Watchdog reads
stale mtime + declares worker dead. spawnFixWorker fires
unnecessarily; fix_loop_count++; budget eats faster than designed.

**Probability/Impact**: medium / medium.

**Mitigation**: EB-omcp-parity-05 ADR pins the freshness threshold
at 5× the configured heartbeat interval (default heartbeat 30s →
freshness threshold 150s). vitest covers: writer delayed up to 4× →
no false-positive; writer delayed past 5× → flagged correctly.

#### Scenario 3: Inbox.md unbounded growth

**Hypothesis**: Leader writes 1000s of messages to inbox.md over a
long session; worker reads + processes each. inbox.md grows
unbounded. Eventually `readFileSync` on the inbox hits memory limits.

**Probability/Impact**: low / medium.

**Mitigation**: inbox-write-helper appends to a rotating set:
`inbox-N.md` files capped at 1MB each; worker reads them in order.
Cursor (from US-P2-OUTBOX-read-cursor) generalizes to inbox too.
vitest writes 1.5MB of messages → asserts rotation to inbox-2.md.

### Expanded test plan

| Story | Unit (in-process mock) | Integration (vitest with real fs) | E2E (live Copilot) | Observability |
|---|---|---|---|---|
| P2-OUTBOX-write-helper | append shape; lockfile acquired/released; lock-timeout error path | 8-process child_process.spawn writing 100 lines each → assert 800 valid JSONL lines | Real Copilot worker writes via `omcp team-outbox-write` | outbox.jsonl byte size on disk |
| P2-OUTBOX-read-cursor | cursor advance from 0 → N; resume from cursor file; corruption resilience | 2-process reader/writer parallel run | n/a (covered by Story 6 smoke) | cursor file `outbox-cursor-<consumer>.json` |
| P2-INBOX-write-helper | append shape; rotation at 1MB; back-compat with non-rotated files | 4-process leader/worker with 500 messages each | Real Copilot worker reads inbox via `omcp team-inbox-read` | inbox-N.md file count + sizes |
| P2-HEARTBEAT-write-poll | atomic write of heartbeat.json; mtime precision; poll-freshness logic | 4-worker concurrent heartbeat write race | Real worker calling `omcp team-heartbeat` in a loop | heartbeat.json mtime + age via doctor check |
| P2-WORKER-SKILL-update | (docs-only) verify-catalog clean | (docs-only) mirror sync | Real worker actually calls all 3 new verbs in the right places | (none new) |
| P2-IPC-smoke-artifact | shared smoke-template renderer (already exists from v2.1 Story 6) | mock-spawn end-to-end fixture | Real 4-worker team uses inbox + outbox + heartbeat | smoke-template drift detection golden snapshot |

### CI runtime budget

- Existing baseline: ~90s for full vitest run (1663 cases)
- Added (6 stories × ~5 cases × ~50ms in-process) = +1.5s
- Added (6 stories × 1 child_process.spawn 8-process test × ~30s) = +180s ⚠️
- **Mitigation**: tag the 8-process tests with `it.runIf(process.env.OMCP_RUN_HEAVY_CONCURRENCY)` so CI runs them on a separate matrix lane that doesn't block fast feedback. Default `npm run test` skips them; `npm run test:concurrent` runs them. Same pattern as the existing 5 CI excludes for copilot-CLI-dependent tests.

---

## Session execution map (3 sessions)

| Session | Stories | Commit budget | Tag/gate |
|---|---|---|---|
| **EB-06-N+1** | OUTBOX-write-helper + OUTBOX-read-cursor + EB-02 ADR | ≤6 commits | none |
| **EB-06-N+2** | INBOX-write-helper + HEARTBEAT-write-poll + EB-05 ADR | ≤6 commits | none |
| **EB-06-N+3** | WORKER-SKILL-update + IPC-smoke-artifact + master ADR + CHANGELOG entry + 2.2.0 manifest bump + LOCAL tag (gated on live-smoke per the same S4 contract) | ≤8 commits | v2.2.0 LOCAL |

Total: ~20 commits over 3 sessions.

### Story-level review protocol (per user prompt)

Per "采用 team 和 critic 模式，独立上下文 agent，多个 agent 独立上下文基于 TTD 测试通过才能放行":

Every story commit MUST pass the gate:
1. Planner writes the TDD failing tests + minimal scaffold
2. Implementer makes tests green
3. Architect subagent (independent context) reviews
4. Critic subagent (independent context) reviews
5. **At least 2 of the 3 verdicts (architect / critic / a third independent
   review-agent if scope warrants) must be APPROVE** for the story to commit
6. ITERATE feedback gets addressed in supplement commits (like v2.1's
   pattern); REJECT verdict blocks the merge

---

## Per-story acceptance criteria (verbatim from Appendix B, augmented for Option B + TDD)

### US-omcp-parity-P2-OUTBOX-write-helper

- **Risk class**: CATASTROPHIC (NTFS append race + JSONL integrity is the
  pre-mortem scenario 1)
- **Invariants**: I1 (assertSafeSlug on sessionId), I2 (no atomic re-write
  for append-only path — explicit carve-out documented in invariants.md),
  I8 (CLI registration)
- **TDD failing test (lands first)**:
  - vitest case: 8 child_process.spawn writers each write 100 JSONL lines
    to `<sid>/outbox.jsonl` concurrently → assert `readFileSync().split("\n")`
    has exactly 800 lines + every line parses as JSON.
- **AC**:
  - New CLI `omcp team-outbox-write <sessionId> <consumerName> <jsonPayload>` registered in src/cli/omcp.ts
  - `runTeamOutboxWrite(opts)` acquires lockfile on `<pidDir>/outbox.jsonl.lock`, appends one JSONL line, releases lock
  - Line shape: `{ts, consumer, payload}` — outbox schema ADR (EB-02) pins this
  - Lock timeout: 5s; on timeout exit 4 (new code: lock-contention)
- **Files**: `src/cli/commands/team-outbox.ts` (new), `src/cli/omcp.ts` (register), `src/__tests__/team-outbox-write.test.ts` (new), `src/__tests__/team-outbox-write-8process.concurrency.test.ts` (new, behind OMCP_RUN_HEAVY_CONCURRENCY)
- **Dependencies**: EB-02 ADR landed first
- **Commit shape**: `feat(team-outbox): outbox-write-helper with lockfile + JSONL schema`

### US-omcp-parity-P2-OUTBOX-read-cursor

- **Risk class**: MAJOR
- **Invariants**: I1, I2 (cursor file rewrite via atomicWriteFileSync), I8
- **TDD failing test**: write 50 lines, read 30 via cursor → cursor file shows offset N, second reader from cursor reads remaining 20 + zero overlap.
- **AC**:
  - New CLI `omcp team-outbox-read <sessionId> <consumerName> [--reset]`
  - `runTeamOutboxRead(opts)` reads cursor file `outbox-cursor-<consumer>.json`, opens outbox at offset, returns new lines + advances cursor
  - `--reset` flag re-reads from 0; documented in --help
  - Cursor file written via atomicWriteFileSync
- **Files**: `src/cli/commands/team-outbox.ts` (extend), tests
- **Dependencies**: P2-OUTBOX-write-helper
- **Commit shape**: `feat(team-outbox): byte-offset cursor reader`

### US-omcp-parity-P2-INBOX-write-helper

- **Risk class**: MAJOR (rotation race + size cap)
- **Invariants**: I1, I2, I8
- **TDD failing test**: write 1.5MB worth of messages → assert rotation triggered + inbox-1.md + inbox-2.md both present.
- **AC**:
  - New CLI `omcp team-inbox-write <sessionId> <markdown-body>`
  - Rotation at 1MB; configurable via `OMCP_INBOX_ROTATE_BYTES` env
  - Lockfile pattern matches outbox-write
- **Files**: `src/cli/commands/team-inbox.ts` (new), tests
- **Commit shape**: `feat(team-inbox): inbox-write-helper with 1MB rotation`

### US-omcp-parity-P2-HEARTBEAT-write-poll

- **Risk class**: MAJOR (false-positive worker-dead is pre-mortem scenario 2)
- **Invariants**: I1, I2 (atomicWriteFileSync for heartbeat.json), I8, I9
- **TDD failing test**: 4 workers race-write heartbeat.json → assert every read post-race is valid JSON; freshness check via mocked time advance → true at 4× interval, false at 6× interval.
- **AC**:
  - New CLI `omcp team-heartbeat <sessionId> <workerIndex>` — writes heartbeat.json with ts
  - `runTeamWatchdog` extended: prefers heartbeat.json freshness over shard-mtime when heartbeat exists; falls back to shard-mtime when absent (back-compat with v2.1 workers)
  - EB-05 ADR pins freshness threshold = 5× heartbeat interval; default heartbeat = 30s → threshold = 150s
  - env `OMCP_HEARTBEAT_INTERVAL_S` + `OMCP_HEARTBEAT_FRESHNESS_MULTIPLIER` overrides
- **Files**: `src/cli/commands/team-heartbeat.ts` (new), `src/cli/commands/team.ts` (extend runTeamWatchdog), tests
- **Commit shape**: `feat(team-heartbeat): heartbeat-write + watchdog freshness integration`

### US-omcp-parity-P2-WORKER-SKILL-update

- **Risk class**: MED (docs + plugin mirror)
- **Invariants**: I7 (no banned tokens), I8
- **TDD failing test**: verify-catalog gate; plugin mirror sync; cli-wiring-invariants.
- **AC**:
  - `skills/team-worker/SKILL.md` extended: workers call `omcp team-heartbeat` at start of each task, `omcp team-outbox-write` on completion, poll `omcp team-inbox-read` at each checkpoint
  - Anti-pattern callouts: do NOT heartbeat in a hot loop; do NOT outbox-write inside a verify-fix loop without rate-limit
  - Plugin mirror regenerated
- **Commit shape**: `docs(team-worker): wire heartbeat + outbox + inbox into worker protocol`

### US-omcp-parity-P2-IPC-smoke-artifact

- **Risk class**: gate (tag-gate per S4 contract)
- **Invariants**: I3
- **AC**:
  - Live mode: `docs/smoke/omcp-team-parity/ipc-mesh.md` — real 4-worker team uses inbox + outbox + heartbeat end-to-end
  - Deterministic fallback: `docs/smoke/omcp-team-parity/ipc-mesh-deterministic-attestation.md` via the shared smoke-template
  - Both go through `src/lib/smoke-template.ts` — drift-detection vitest extends to a 4th consumer
- **Commit shape**: `docs(smoke): ipc-mesh live + deterministic attestation`

---

## ADR draft (Decision / Drivers / Alternatives / Why / Consequences / Follow-ups)

**Decision**: Build the 6 Phase 2 IPC stories per Appendix B (lift verbatim) under Option B (real 8-process concurrent test per story). Land 2 sub-ADRs (EB-02 outbox schema; EB-05 heartbeat freshness) before the dependent stories. v2.2.0 LOCAL tag at the end (gated by the same S4 live-smoke contract as v2.1.0).

**Drivers**:
1. NTFS atomic-append vs rename trade-off → lockfile pattern (per Option B)
2. Live-CLI test feasibility on CI → `OMCP_RUN_HEAVY_CONCURRENCY` gate
3. Heartbeat freq vs runtime cost → 30s default, 150s threshold (EB-05)

**Alternatives considered**:
- Option A (deterministic-only, no real spawn) — rejected; defeats the deferral rationale
- Option B (chosen) — full mesh + real spawn tests
- Option C (defer-again) — rejected; maintainer has explicit override authority

**Why Option B chosen**: matches iter-2 critic's explicit Phase 2 AC verbatim ("8-process child_process.spawn"). CI cost ($180s on heavy lane) is acceptable per project's existing CI exclude-list pattern.

**Consequences**:
1. CI gains a new `npm run test:concurrent` lane (similar to v1.8 pattern)
2. Plugin mirror grows by 3 new CLI verbs + 3 new skill protocol lines
3. Worker SKILL.md authors must update their protocols (back-compat preserved: old workers without heartbeat still work via fallback)
4. v2.2.0 release adds 4 manifest bumps + new live-smoke artifact (in addition to v2.1.0's 3)
5. Lockfile dependency introduced (`proper-lockfile` or hand-roll) — adds 1 npm dep OR 1 internal helper
6. **Gate-trigger trade-off**: this iter is triggered by maintainer override, not external user signal. Future readers should know this — the gate's discipline rule (avoid speculative IPC build-out) was consciously overridden once. Pattern should NOT be reused to bypass other EB gates without similar explicit reasoning.

**Follow-ups**:
1. EB-02 ADR landed first → outbox schema
2. EB-05 ADR landed second → heartbeat freshness threshold
3. Master ADR (this one, finalized) landed last as part of the IPC-smoke story
4. v2.2.0 LOCAL tag at session end (same live-smoke S4 gate)
5. v2.2.0 → v2.x GA path inherits the same channel-availability blocker as v2.0/v2.1 per ADR-v2.0-public-release-deferred.md

---

## Open questions (Planner needs Architect + Critic answer)

1. **proper-lockfile vs hand-rolled `fs.openSync` exclusive-create**: the
   project doesn't currently have a lockfile dep. Adding `proper-lockfile`
   buys battle-tested cross-platform behavior at the cost of 1 npm dep
   + ~500 KB. Hand-rolling via `openSync(file, 'wx')` + retry is
   ~30 LOC but trades dep cost for "we own a critical race correctness
   path." Recommendation: hand-roll; the lock semantics are simple
   (single-writer outbox.jsonl + heartbeat.json) and the bus-factor
   risk of an external lockfile dep on Windows is non-trivial.

2. **JSONL line cap**: should we cap individual lines at say 64KB to
   prevent a runaway worker from writing a 1GB log line? Or trust
   workers to behave?

3. **Inbox rotation timing**: rotate AT 1MB (check-and-rotate inside
   each append) or RECOVER (rotate next-write-after-1MB)? The latter
   is simpler; the former gives sharper size bounds.

4. **Worker-SKILL protocol — heartbeat interval ownership**: should
   the worker decide its own heartbeat interval, or read it from a
   leader-published `heartbeat-config.json`? If leader-published,
   that's another file in the IPC mesh + another race surface.
   Recommendation: env-var only (`OMCP_HEARTBEAT_INTERVAL_S`) — keeps
   the mesh minimal.

---

## Executive summary (250 words)

This iter triggers EB-omcp-parity-06 to build the 6 deferred Phase 2 IPC
stories from iter-2 plan Appendix B. The gate's official trigger
("≥1 external user reports IPC mesh as workflow blocker") is NOT met —
the current request comes from the maintainer themselves. This iter
proceeds on explicit maintainer override authority, with the trade-off
documented in the resulting ADR's Consequences section so future readers
know the discipline rule was overridden once.

Scope: outbox-write-helper (with 8-process NTFS concurrency test),
outbox-read-cursor (byte-offset), inbox-write-helper (1MB rotation),
heartbeat-write-poll (5× freshness threshold), worker-SKILL update,
IPC smoke artifact (live + deterministic). Plus 2 sub-ADRs that
re-activate per the iter-2 plan: EB-omcp-parity-02 (outbox schema)
and EB-omcp-parity-05 (heartbeat freshness threshold).

Option B chosen: ship all 6 stories with REAL 8-process
`child_process.spawn` concurrency tests (gated behind
`OMCP_RUN_HEAVY_CONCURRENCY` to keep fast-feedback CI under 5 min).
Option A (deterministic-only) rejected because it defeats the
deferral's whole rationale. Option C (defer-again) rejected because
the maintainer has explicit override authority.

Per-story review protocol: TDD failing test lands first; architect +
critic in independent contexts review each story; 2-of-3 APPROVE
verdicts required before commit. 3 sessions; ~20 commits; ends with
v2.2.0 LOCAL tag (same S4 live-smoke gate as v2.1.0).

Open questions for Architect + Critic: (1) lockfile dep vs hand-roll,
(2) JSONL line cap, (3) inbox rotation timing, (4) heartbeat-interval
ownership leader vs worker.
