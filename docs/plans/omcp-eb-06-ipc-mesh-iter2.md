# EB-omcp-parity-06 IPC Mesh — iter-2 (Planner pass, post-Architect+Critic ITERATE)

**Author**: Planner (ralplan, deliberate mode)
**Date**: 2026-05-25
**Baseline**: HEAD = `087c61d` (post v2.1 + Story 21 team-loop)
**Status**: ITER-2 revision applying consolidated Architect + Critic
ITERATE feedback from iter-1 (`docs/plans/omcp-eb-06-ipc-mesh-iter1.md`)
**Predecessor**: `omcp-eb-06-ipc-mesh-iter1.md`

---

## Iter-2 changelog (delta from iter-1)

7 consolidated edits applied. Each lists provenance back to the
Architect (A#) and Critic (C#) findings that motivated it.

1. **(A#1 + C-CRITICAL#1) Heartbeat freshness**:
   - Multiplier changed from 5× → **3×** (threshold 90s on a 30s
     interval). EB-omcp-parity-05 ADR documents why 3× was chosen
     over omc's 10× (different poll cadence: omcp's 30s vs omc's 3s).
   - **Primary freshness signal is the `ts` field INSIDE `heartbeat.json`** (mirrors
     omc's `lastPollAt`), NOT `statSync().mtimeMs`. NTFS mtime is a fallback
     only when the file is missing — covered by the new pre-mortem scenario
     4 below.

2. **(A#3 + C-CRITICAL#2) CI lane promotion**: the `test:concurrent`
   job + `OMCP_RUN_HEAVY_CONCURRENCY=1` env-var lane is now a
   **first-class story** (US-omcp-parity-P2-CI-CONCURRENT-LANE) in the
   session map, NOT a footnote. Lands BEFORE the first 8-process test
   commit so the test runs in CI from day one.

3. **(A#4) Review protocol revert**: dropped "2-of-3 APPROVE." Reverted
   to the v2.1 pattern — architect + critic in independent contexts;
   **0 REJECT verdicts required** + ITERATE feedback addressed before
   re-review. The phantom third reviewer is gone.

4. **(A#5 + C-MAJOR#3) EB-02 ADR scope expansion**: ADR must now
   document the **separate-file-per-message alternative** as
   considered-and-rejected (reasons: glob ordering complexity, inode
   cost, cursor incompatibility), AND pin the **64KB JSONL line cap**
   as a decided constraint (not an open question). Oversized payloads
   are truncated with a `{truncated: true}` marker.

5. **(C-MAJOR#1) TDD principle honesty**: downgraded from "TDD-first per
   story (failing test FIRST)" to **"tests ship WITH each story"**.
   The original phrasing was pattern-theater — v2.1 had no mechanical
   enforcement either. This iter follows v2.1's precedent (tests + impl
   in the same commit; story passes only when tests are green) and
   stops claiming a stricter discipline than the tooling supports.

6. **(C-MAJOR#2) Heartbeat-absent observability**: when no
   `heartbeat.json` exists for a worker after **2× heartbeat-interval
   post-spawn**, runTeamWatchdog emits a `[watchdog] worker-N not
   heartbeating` warning to logLines (NOT a hard failure). This
   surfaces silent-failure mode (workers writing shards but never
   heartbeating) without breaking back-compat with v2.1 workers.

7. **(C-NEW#7) Stale-lockfile cleanup**: outbox-write-helper checks
   `<outbox.jsonl.lock>` age before retry. Lockfiles older than **30s**
   are force-removed (prior writer crashed mid-lock). EB-02 ADR
   documents this contract.

Plus 2 minor revisions:
- **(C-MINOR)** Inbox cursor design clarified: `{fileIndex, byteOffset}`
  per consumer, NOT just byte-offset. The cursor story (US-P2-OUTBOX-
  read-cursor) generalizes to inbox via a 2-field cursor shape.
- **(C-MINOR)** Lockfile retry: **exponential backoff** (50ms →
  100ms → 200ms → 400ms → 1s → 2.5s, then fail). Linear retry causes
  thundering-herd on contention.

Open question decisions (no longer open):
- **OQ#1 lockfile**: hand-roll `openSync(path, 'wx')` + exponential
  backoff. NO `proper-lockfile` dep. (matches Architect + Critic
  consensus)
- **OQ#2 line cap**: **64KB**. Enforced at write time.
- **OQ#3 inbox rotation**: rotate **AT 1MB** (check inside each
  append). The alternative (recover next-write) allows a single 2MB
  payload to blow past the cap.
- **OQ#4 heartbeat-interval ownership**: env-var only
  (`OMCP_HEARTBEAT_INTERVAL_S`). No leader-published config file
  (would add another race surface for zero gain).

Plus 2 critic open-question follow-ups documented:
- **Watchdog vs heartbeat precedence rule**: when both
  `heartbeat.json` and shard file exist, **heartbeat wins**.
  runTeamWatchdog reads heartbeat.json's `ts` field as primary
  freshness signal; falls back to shard-mtime ONLY when
  `heartbeat.json` is absent (back-compat with v2.1 workers).
- **8-process test negative case**: the existing positive test
  (8 processes WITH lockfile → 800 valid lines) is augmented with
  a **negative case** (2 processes WITHOUT lockfile → assert torn
  writes exist on Windows NTFS) to prove the lockfile is genuinely
  necessary, not just sufficient. The negative case is in a
  dedicated test marked `.runIf(process.platform === "win32")`.

---

## Scope — unchanged from iter-1

Still 6 deferred Phase 2 IPC stories from iter-2-OMC plan Appendix B
+ 2 sub-ADRs (EB-02 outbox schema, EB-05 heartbeat freshness). Iter-2
adds **1 new story** for the CI lane wiring → **7 stories total**.

## Gate-trigger interpretation — unchanged from iter-1

Maintainer-override path; gate text says "≥1 external user" but
maintainer has authority. Documented in the resulting master ADR's
Consequences §6 with the "pattern should NOT be reused" caveat. Critic
explicitly accepted this; Architect did not flag.

---

## Principles (RALPLAN-DR — 4, revised per C-MAJOR#1)

1. **Tests ship with every story.** Honest restatement of the v2.1
   precedent: tests + implementation land in the same commit; story
   passes only when tests are green. No claim to stricter TDD
   discipline than the tooling enforces.

2. **Concurrency-safety is non-negotiable.** Phase 2 IPC is the
   surface where NTFS handle-sharing, multi-process append races, and
   mtime precision matter. Every helper ships BOTH (a) deterministic
   in-process tests for fast feedback AND (b) an 8-process
   `child_process.spawn` concurrent test on the CI `test:concurrent`
   lane.

3. **Reuse v2.1 primitives where they fit.** Heartbeat layer extends
   (not replaces) `runTeamWatchdog`. Watchdog reads heartbeat.json's
   `ts` field as primary signal; falls back to shard-mtime when
   heartbeat absent. Back-compat preserved.

4. **Independent-context review per story.** Architect + critic
   subagents review in independent contexts per story commit.
   **0 REJECT verdicts required.** ITERATE feedback addressed before
   re-review.

## Decision Drivers (top 3, revised)

1. **NTFS atomic-append vs rename trade-off**: hand-roll
   `openSync(path, 'wx')` + 30s stale-lockfile timeout + exponential
   backoff. Documented in EB-02 ADR alongside the rejected
   alternatives (per-line rewrite, separate-file-per-message).

2. **Live-CLI test feasibility on CI**: dedicated
   `OMCP_RUN_HEAVY_CONCURRENCY=1 npm run test:concurrent` lane added
   as a first-class story. Fast-feedback CI (default `npm test`)
   stays under 5 min; concurrency lane runs +180s in a separate
   matrix job.

3. **Heartbeat freshness vs runtime cost**: 30s interval (subprocess
   spawn is genuinely heavier than omc's in-process write); 3×
   freshness multiplier = 90s threshold. Both tunable via
   `OMCP_HEARTBEAT_INTERVAL_S` + `OMCP_HEARTBEAT_FRESHNESS_MULTIPLIER`.
   Primary freshness signal is heartbeat.json's `ts` field (matches
   omc); fs mtime is fallback only.

## Viable Options — unchanged from iter-1

Option A (deterministic-only) rejected as before. Option C (defer-
again) rejected as before. **Option B** chosen + already validated by
both reviewers.

---

## Deliberate-mode — pre-mortem (now 4 scenarios)

### Scenario 1: NTFS append race torn JSONL

(Unchanged from iter-1, mitigation now refined per C-NEW#7.)

**Mitigation**: hand-rolled `openSync(file, 'wx')` lockfile.
Acquire-or-fail with exponential backoff (50→100→200→400→1000→2500ms).
Stale lockfile (>30s age) force-removed before retry. 8-process test
+ negative case (2-process without-lockfile) prove the lockfile is
both necessary and sufficient.

### Scenario 2: Heartbeat false-positive worker-dead

**Mitigation refined**: freshness signal is heartbeat.json's `ts`
field, NOT statSync mtime. EB-05 ADR pins threshold = 3× heartbeat
interval (default 30s × 3 = 90s). Vitest covers: writer delayed up
to 2.5× → no false-positive; writer delayed past 3× → flagged.
Heartbeat-absent path emits warning per C-MAJOR#2.

### Scenario 3: Inbox.md unbounded growth

(Unchanged from iter-1.)

**Mitigation**: rotation AT 1MB inside each append (per OQ#3
decision). Cursor is `{fileIndex, byteOffset}` per consumer (per
C-MINOR clarification). Vitest writes 1.5MB → asserts rotation to
inbox-2.md + cursor advances across files.

### Scenario 4: NTFS mtime 15.625ms quantum race (NEW)

**Hypothesis**: Heartbeat writer + watchdog reader land in the same
NTFS mtime quantum (Windows reports mtime at 1/64s = 15.625ms
resolution). Watchdog `statSync` reads mtime BEFORE writer's update
landed → declares worker dead despite a write in-flight.

**Probability/Impact**: high on busy Windows machines (AV scans, COW
filesystems) / medium-high (false-positive triggers spurious
fix-worker spawn, wastes fix_loop_count budget).

**Mitigation**: Primary freshness signal is heartbeat.json's `ts`
field (ISO timestamp embedded in the file), NOT fs mtime. This
matches omc's `lastPollAt` design (omc heartbeat.ts:90-91 reads JSON
field, not mtime). NTFS quantum is irrelevant for inside-file
timestamps. fs mtime is a fallback only when heartbeat.json is
missing — and in that case the watchdog falls through to the
existing shard-mtime v2.1 logic (no regression).

### Expanded test plan — unchanged from iter-1

Same matrix (6 stories × 4 columns: unit / integration / e2e /
observability). Plus the new CI lane story's tests for the lane
itself.

---

## Session execution map (revised, 3 sessions, 7 stories)

| Session | Stories | Commit budget | Tag |
|---|---|---|---|
| **EB-06-N+1** | **US-omcp-parity-P2-CI-CONCURRENT-LANE** (NEW; wires CI matrix + npm script BEFORE any 8-process test commits) + **EB-02 ADR** + OUTBOX-write-helper + OUTBOX-read-cursor | ≤8 commits | none |
| **EB-06-N+2** | **EB-05 ADR** + INBOX-write-helper + HEARTBEAT-write-poll | ≤6 commits | none |
| **EB-06-N+3** | WORKER-SKILL-update + IPC-smoke-artifact + master ADR + CHANGELOG entry + 2.2.0 manifest bump + LOCAL tag (gated on live-smoke per same S4 contract) | ≤8 commits | v2.2.0 LOCAL |

Total: ~22 commits over 3 sessions (was ~20; +2 for the CI lane
story).

### Story-level review protocol (final, per A#4 + C ADOPT)

- Architect + Critic independent-context subagents review each story
  commit.
- **0 REJECT verdicts required.** ITERATE feedback must be addressed
  in a supplement commit (v2.1 precedent) before the next story
  starts.
- No "third reviewer" — phantom independence removed.
- Reviews dispatched as background subagents during the next story's
  implementation work (parallelism honored, blocking dependency
  preserved).

---

## Per-story acceptance criteria — revised

### US-omcp-parity-P2-CI-CONCURRENT-LANE (NEW, lands first)

- **Risk class**: gate (without this, the whole iter's concurrency
  evidence is local-only)
- **Invariants**: none directly; enables future stories' I2/I8 evidence
- **Tests ship with story**: 1 vitest case that asserts the
  `OMCP_RUN_HEAVY_CONCURRENCY` env var is read correctly + a
  placeholder `it.runIf` test that runs only when the env is set.
- **AC**:
  - `package.json` `scripts` adds `"test:concurrent": "vitest run --reporter=verbose"` (separate from `test`)
  - `.github/workflows/ci.yml` gains a new job `test-concurrent` that runs `OMCP_RUN_HEAVY_CONCURRENCY=1 npm run test:concurrent`
  - The new job runs on `windows-latest + Node 20` (matching the Windows-first stability commitment)
  - The job does NOT block the existing `test` job (separate matrix entry)
  - A placeholder concurrency test exists at
    `src/__tests__/__concurrent-lane-smoke__.test.ts` that's gated on the env
    var so the lane has at least one test to run from day one.
- **Files**: `package.json`, `.github/workflows/ci.yml`, the placeholder test
- **Dependencies**: none
- **Commit shape**: `ci(test-concurrent): add OMCP_RUN_HEAVY_CONCURRENCY lane`

### US-omcp-parity-P2-OUTBOX-write-helper (revised)

- **Risk class**: CATASTROPHIC (unchanged)
- **Tests ship with story**:
  - Deterministic vitest: append shape, lockfile acquire+release,
    timeout error path, stale-lockfile force-remove (lockfile >30s
    old).
  - 8-process concurrency test on the CI test:concurrent lane:
    POSITIVE case — 8 writers × 100 lines each → assert 800 valid
    JSONL lines.
  - 2-process **negative** case `.runIf(platform==='win32')`:
    write without lockfile → assert torn lines exist (proves
    necessity).
- **AC**:
  - New CLI `omcp team-outbox-write <sessionId> <consumerName> <jsonPayload>`
  - Hand-rolled lockfile: `openSync(<file>.lock, 'wx')` + exponential
    backoff retry (50→100→200→400→1000→2500ms, then fail with exit 4
    `lock-contention`).
  - Stale-lockfile (>30s old, statSync mtime) → force-remove + retry.
  - Lockfile sidecar at `<pidDir>/outbox.jsonl.lock`. Released via
    `closeSync` + `rmSync` on success path AND on error path
    (try/finally).
  - Line shape per EB-02 ADR: `{ts, consumer, payload}`.
  - **64KB line cap**: payloads exceeding 65536 bytes (Buffer.byteLength)
    are truncated with `{truncated: true, original_bytes: N}` marker
    field added to the JSONL entry.
- **Files**: `src/cli/commands/team-outbox.ts`, `src/cli/omcp.ts`,
  `src/__tests__/team-outbox-write.test.ts`,
  `src/__tests__/team-outbox-write-8process.concurrency.test.ts` (CI
  test:concurrent lane)
- **Dependencies**: P2-CI-CONCURRENT-LANE + EB-02 ADR (both land first)
- **Commit shape**: `feat(team-outbox): outbox-write-helper with lockfile + JSONL schema`

### US-omcp-parity-P2-OUTBOX-read-cursor (revised)

- **Risk class**: MAJOR (unchanged)
- **Tests ship with story**:
  - Cursor-advance / cursor-resume / corrupt-cursor resilience.
  - 2-process reader/writer parallel run on test:concurrent lane.
- **AC** (unchanged from iter-1 + clarified):
  - Cursor file shape: `{fileIndex: number, byteOffset: number}` — the
    new 2-field shape per C-MINOR; covers both outbox (single-file,
    fileIndex always 0) and inbox (rotates) use cases.
- **Commit shape**: `feat(team-outbox): byte-offset cursor reader`

### US-omcp-parity-P2-INBOX-write-helper (revised)

- **Risk class**: MAJOR (unchanged)
- **Tests ship with story**:
  - Rotation at 1MB (positive: 1.5MB write → inbox-1.md + inbox-2.md).
  - Rotation race: 4-process simultaneous writes near the 1MB
    boundary → assert no message lost or duplicated.
  - Back-compat with non-rotated v2.1 inbox.md (graceful fallback).
- **AC** (unchanged):
  - Rotation AT 1MB inside each append (per OQ#3 decision)
  - `OMCP_INBOX_ROTATE_BYTES` env override
- **Commit shape**: `feat(team-inbox): inbox-write-helper with 1MB rotation`

### US-omcp-parity-P2-HEARTBEAT-write-poll (revised)

- **Risk class**: MAJOR (unchanged)
- **Tests ship with story**:
  - heartbeat.json schema: `{ts: ISO-string, workerIndex, pid}`
  - Freshness check reads `ts` field (NOT mtime) — vitest covers
    delayed-writer scenarios at 1× / 2.5× / 3× / 6× interval.
  - 4-worker concurrent heartbeat write race (test:concurrent lane).
  - 15ms NTFS quantum simulation: two writes 10ms apart → both
    observable via `ts` field even when mtime collapses them.
  - **Heartbeat-absent observability** (per C-MAJOR#2): when no
    heartbeat.json exists 2× after spawn, watchdog emits warning to
    logLines; vitest asserts the message text.
- **AC**:
  - New CLI `omcp team-heartbeat <sessionId> <workerIndex>`
  - heartbeat.json schema: `{ts: ISO-string, workerIndex, pid}`
  - `runTeamWatchdog` extended: reads heartbeat.json's `ts` field as
    primary; falls back to shard-mtime when heartbeat absent.
  - **Watchdog vs heartbeat precedence rule**: when both
    heartbeat.json and shard exist, **heartbeat wins**. shard-mtime is
    consulted ONLY when heartbeat.json is absent. Documented in
    EB-05 ADR.
  - EB-05 ADR pins freshness threshold = **3× heartbeat interval**;
    default heartbeat = 30s → threshold = 90s.
  - env `OMCP_HEARTBEAT_INTERVAL_S` + `OMCP_HEARTBEAT_FRESHNESS_MULTIPLIER`.
- **Commit shape**: `feat(team-heartbeat): heartbeat-write + watchdog freshness (JSON ts primary, mtime fallback)`

### US-omcp-parity-P2-WORKER-SKILL-update (revised per executor concern)

- **Risk class**: MED (unchanged)
- **Tests ship with story**: verify-catalog clean; plugin mirror
  sync; cli-wiring-invariants. These are existing tests, not new ones
  — Story 5 is docs-only by design. The "tests ship with story"
  principle (revised P1) accommodates docs-only stories where the
  test infrastructure already exists.
- **AC** (unchanged from iter-1):
  - Workers call `omcp team-heartbeat` at start of each task,
    `omcp team-outbox-write` on completion, poll `omcp team-inbox-read`
    at each checkpoint.
  - Anti-pattern callouts: no heartbeat in hot loop; no outbox-write
    inside verify-fix loop without rate-limit.
  - Plugin mirror regenerated.
- **Commit shape**: `docs(team-worker): wire heartbeat + outbox + inbox into worker protocol`

### US-omcp-parity-P2-IPC-smoke-artifact (revised)

- **Risk class**: gate (unchanged)
- **Tests ship with story**: golden snapshot via shared
  `src/lib/smoke-template.ts` (extends drift-detection to 4 consumers
  P1+P3+P4+IPC).
- **AC** (unchanged from iter-1).
- **Commit shape**: `docs(smoke): ipc-mesh live + deterministic attestation`

---

## ADR draft — revised

**Decision**: build the 6 Phase 2 stories + 1 CI lane story (7 total)
per Appendix B, with Option B (real 8-process concurrent tests on a
dedicated CI lane). 2 sub-ADRs land first: EB-02 (outbox schema +
64KB line cap + considered-rejected alternatives), EB-05 (heartbeat
freshness 3× over 30s + watchdog precedence rule + omc calibration
reference). v2.2.0 LOCAL tag at end (same S4 live-smoke gate as v2.1.0).

**Drivers** (unchanged top-level; refined per iter-2 edits):
1. NTFS atomic-append trade-off → hand-rolled lockfile (Option B)
2. Live-CLI test feasibility → dedicated `test:concurrent` CI lane
3. Heartbeat freq vs cost → 30s interval × 3× multiplier (90s threshold),
   JSON-ts primary signal

**Alternatives considered**:
- Option A (deterministic-only) — rejected; defeats deferral rationale
- Option B (chosen) — full mesh + real spawn tests + CI lane
- Option C (defer-again) — rejected; maintainer override authority
- For outbox storage specifically: separate-file-per-message
  alternative documented as considered-and-rejected in EB-02 ADR

**Why Option B chosen**: matches iter-2 critic's explicit Phase 2 AC
("8-process child_process.spawn"); CI cost (+180s on separate lane)
is acceptable per project's existing CI-exclude precedent; reviewer
convergence on the trade-off.

**Consequences** (refined):
1. CI gains `test-concurrent` job on windows-latest + Node 20
2. Plugin mirror grows by 3 new CLI verbs + worker SKILL.md changes
3. Worker SKILL authors update protocols (back-compat preserved)
4. v2.2.0 release adds 4 manifest bumps + IPC live-smoke artifact
5. **No** new npm deps (hand-rolled lockfile + handcrafted JSON
   timestamps replace `proper-lockfile`)
6. **Gate-trigger trade-off**: maintainer override of EB-06 self-
   imposed gate. Documented for posterity. Pattern NOT to be reused
   for other EB gates without similar explicit reasoning.

**Follow-ups**:
1. EB-02 ADR first → outbox schema + 64KB cap + alternatives
2. EB-05 ADR second → heartbeat freshness + watchdog precedence +
   omc calibration reference
3. CI lane story first per session map (BEFORE any 8-process test)
4. Master ADR (this) finalized in N+3 alongside CHANGELOG + release
5. v2.2.0 LOCAL tag at session end (live-smoke S4 gate); npm publish
   remains [USER_REQUIRED] per ADR-v2.0
6. EB-omcp-parity-02 (was re-activated) → consumed by EB-02 sub-ADR
7. EB-omcp-parity-05 (was re-activated) → consumed by EB-05 sub-ADR

---

## Open questions (NEW — for iter-2 Architect+Critic re-review)

All iter-1 open questions are now decided (see iter-2 changelog above).
New questions surfaced by reviewers:

1. **8-process negative case OS scope**: the new negative case
   (no-lockfile → torn writes) is gated `.runIf(platform==='win32')`.
   Should we also try to demonstrate the same race on macOS (where
   `fs.appendFileSync` IS documented as atomic for writes under
   PIPE_BUF=512 bytes but our payloads can exceed that)? Or accept
   Windows-only as the load-bearing case (omcp is Windows-first per
   v2.0 stability commitment)?

2. **EB-02 ADR location of the 64KB cap rationale**: the cap is in
   the AC for OUTBOX-write-helper, AND mentioned in EB-02 ADR.
   Which is the source-of-truth + which is the cross-reference?
   Recommendation: EB-02 ADR is source-of-truth (it pins the schema);
   AC cross-references the ADR.

---

## Executive summary (250 words)

Iter-2 applies 7 consolidated edits from architect+critic ITERATE
verdicts on iter-1: (1) heartbeat multiplier 5× → 3× + JSON-ts
primary signal (was mtime); (2) CI lane promoted from footnote to
first-class story landing BEFORE any 8-process test; (3) review
protocol dropped phantom third reviewer back to v2.1 architect+critic
pattern; (4) EB-02 ADR expanded to include separate-file-per-message
considered-rejected + 64KB line cap; (5) TDD principle honestly
restated as "tests ship with story" (no mechanical enforcement claim);
(6) heartbeat-absent watchdog warning added (logs but doesn't fail);
(7) stale-lockfile cleanup (>30s force-remove). All 4 iter-1 open
questions decided. New pre-mortem scenario 4 (NTFS 15.625ms mtime
quantum race) added with JSON-ts-primary mitigation.

Total: 7 stories (was 6 in iter-1 + 1 CI lane added) across 3 sessions
~22 commits ending in v2.2.0 LOCAL tag (same S4 live-smoke gate as
v2.1.0). 2 sub-ADRs (EB-02 outbox schema, EB-05 heartbeat freshness)
land first per session map.

Maintainer-override of EB-06 self-imposed gate stays. Documented in
master ADR's Consequences §6 with the "do NOT reuse this pattern for
other EB gates" caveat (critic explicitly accepted; architect did not
flag).

Open for iter-2 Architect+Critic re-review: (1) negative-case
OS scope (Windows-only vs macOS too); (2) 64KB cap source-of-truth
location (EB-02 ADR vs OUTBOX-write-helper AC).
