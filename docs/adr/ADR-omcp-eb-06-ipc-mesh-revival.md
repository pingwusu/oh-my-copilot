# ADR: EB-omcp-parity-06 Revival — Phase 2 IPC Mesh

**Date**: 2026-05-25
**Status**: Accepted (EB-06 Story 10 — master decision record for the entire EB-06 arc)
**Author**: pingwusu
**Related**:
- `docs/plans/omcp-eb-06-ipc-mesh-iter2.md` (the canonical 11-story plan + iter-1/iter-2 RALPLAN-DR consensus)
- `docs/adr/ADR-omcp-team-omc-parity-iter2.md` (the v2.1 master ADR that documented the EB-06 deferral rationale)
- `docs/adr/ADR-omcp-eb-02-outbox-schema.md` (outbox JSONL schema sub-ADR)
- `docs/adr/ADR-omcp-eb-05-heartbeat-freshness.md` (heartbeat freshness sub-ADR)
- `docs/adr/ADR-v2.0-public-release-deferred.md` (the channel-availability gate v2.2.0 inherits)

---

## Context

EB-omcp-parity-06 was the user-signal gate defined in iter-2-OMC plan
(`docs/plans/omcp-team-omc-parity-iter2.md` Appendix B) and the v2.1
master ADR (`docs/adr/ADR-omcp-team-omc-parity-iter2.md:252`): "≥1
external user reports IPC mesh as a workflow blocker for their
workflow." The gate guarded 6 deferred Phase 2 IPC primitive stories
(outbox-write / outbox-read-cursor / inbox-write / heartbeat /
worker-skill / IPC-smoke) plus 2 sub-ADRs (EB-02 outbox schema, EB-05
heartbeat freshness threshold).

The gate's discipline rule existed to avoid "build IPC that nobody
uses" anti-pattern — without an actual user signal, the IPC primitives
were potentially speculative work. The trade-off was "defer-not-cancel":
the stories were preserved verbatim in Appendix B for direct lift-into
a future ralplan iter.

This iter triggers EB-06 via **maintainer override** rather than an
external user signal. The maintainer has authority over their own
gate; the override is documented + scoped to this single iter (the
"do NOT reuse this pattern" caveat applies — future EB gates require
their own explicit rationale before similar overrides).

The trade-off is honest: this iter accepts that the IPC primitives
may or may not see real-world use; the discipline rule was overridden
on the maintainer's authority. The mitigating factor: every primitive
ships with both deterministic vitest AND real-process concurrency
tests on the new `test:concurrent` CI lane, so the build cost is
amortized into a load-bearing test artifact even if zero external
users adopt the mesh.

## Decision

**Ship 6 Phase 2 IPC stories + 1 CI lane wiring story (7 total) per
iter-2 plan §"Per-story acceptance criteria"** under Option B-revised
(real 8-process concurrent test on dedicated CI lane). The 2 sub-ADRs
(EB-02 outbox schema, EB-05 heartbeat freshness) land first per
session map so the dependent stories consume stable contracts.

Concrete delivery (8 sub-deliverables + 3 release commits = 11 total
per prd.json):

1. **US-EB06-CI-CONCURRENT-LANE** — `npm run test:concurrent` script
   + `.github/workflows/ci.yml` matrix job + placeholder concurrency
   test. Lands FIRST so 8-process tests are never dead code in CI.
2. **EB-omcp-parity-02 sub-ADR** — outbox JSONL schema, 64KB cap,
   lockfile contract, alternatives considered.
3. **US-EB06-OUTBOX-WRITE** — hand-rolled lockfile + exponential
   backoff + 30s stale-cleanup + 64KB cap via binary-search-on-
   truncation. Plus 8-process positive concurrency test + Windows-
   only negative case proving lockfile necessity.
4. **US-EB06-OUTBOX-READ-CURSOR** — byte-offset cursor reader with
   `{fileIndex, byteOffset}` shape (cursor compat with inbox);
   per-consumer cursor independence; partial-line tolerance.
5. **EB-omcp-parity-05 sub-ADR** — heartbeat freshness 30s × 3 = 90s
   threshold; JSON-ts primary + mtime fallback (NTFS quantum
   side-step); heartbeat-absent observability; watchdog precedence
   rule.
6. **US-EB06-INBOX-WRITE** — 1MB rotation inside each append;
   session-level lockfile (not per-file, to prevent two writers from
   racing on inbox-N.md numbering).
7. **US-EB06-HEARTBEAT** — runTeamWatchdog extended with the heartbeat-
   primary path + heartbeat-absent observability warning at 2× post-
   spawn interval.
8. **US-EB06-WORKER-SKILL** — skills/team-worker/SKILL.md updated with
   heartbeat + outbox-write + inbox-read protocol + anti-patterns
   section (no hot-loop heartbeat; no inner-loop outbox-write; no
   shared cursor across consumers; no >64KB lines).
9. **US-EB06-IPC-SMOKE** — deterministic harness exercising all 4 EB-06
   primitives in a single trace + extending the shared smoke-template
   drift detection to a 4th consumer (P1 + P3 + P4 + IPC).
10. **This ADR** — master decision record finalizing the EB-06 arc.
11. **US-EB06-RELEASE** — v2.2.0 LOCAL tag (gated on ≥1 live-smoke
    across P1/P3/P4/IPC per the same S4 contract as v2.1.0); 4-manifest
    bump; CHANGELOG entry.

## Drivers (top 3)

1. **NTFS atomic-append unreliability** — Windows NTFS does NOT
   provide atomic append semantics across processes (POSIX O_APPEND
   semantics are unreliable). Driver pinned the hand-rolled lockfile
   design in EB-02 + the 8-process concurrent test that proves both
   necessity (negative case without lockfile → torn writes) and
   sufficiency (positive case → 800 valid JSONL lines).

2. **NTFS mtime quantum race** — Windows reports `statSync.mtimeMs`
   at 1/64s = 15.625ms resolution. A heartbeat writer and watchdog
   reader landing in the same quantum can see stale mtime despite a
   concurrent write. Driver pinned the JSON-ts-primary design in
   EB-05 (read the `ts` field inside the file, not the file's mtime)
   + the watchdog precedence rule (heartbeat wins when both signals
   present).

3. **CI runtime budget vs concurrency evidence** — the 8-process
   real-spawn tests add ~180s per concurrency story. Driver pinned
   the dedicated `test-concurrent` CI lane as a SEPARATE matrix job
   so default `test` lane stays under 5 min. Without the lane, the
   concurrency tests would be skipped silently in CI and the whole
   "real-process evidence" value proposition would be theatrical.

## Alternatives Considered

### Option A — Deterministic-only Phase 2 (rejected)

- **Scope**: ship all 6 IPC stories with vitest deterministic tests
  only (mock-spawn for the 8-process test).
- **Pros**: Fastest path; CI runtime under 5 min; matches v2.1
  N+1/N+2/N+3 cadence.
- **Cons**: No real Windows multi-process NTFS evidence. The whole
  point of Phase 2 deferral was concerns about NTFS append races —
  shipping without real-process verification defeats the deferral
  rationale.
- **Rejection rationale**: iter-1 critic explicitly flagged this as
  insufficient — Option B (real spawn tests) was the convergent
  reviewer recommendation.

### Option B-revised — Real 8-process tests + dedicated CI lane (CHOSEN)

- See "Decision" section.

### Option C — Defer-again indefinitely (rejected)

- **Scope**: keep EB-06 deferred; do not revive Phase 2 IPC stories.
- **Pros**: Honors the original EB-06 gate (no external user signal).
- **Cons**: Maintainer has explicit override authority + the
  deferral was always "defer-not-cancel"; refusing the maintainer's
  request conflicts with the spirit of the gate.
- **Rejection rationale**: Maintainer override authority is
  documented in v2.1 master ADR. The override is scoped to this
  single iter (not a precedent).

## Why Option B-revised Chosen

- **Reviewer convergence at iter-2** — both architect and critic
  APPROVE'd iter-2 after 2 rounds of revision; concrete edits applied
  (heartbeat multiplier 5×→3×, JSON-ts primary, CI lane promotion,
  TDD honesty downgrade, EB-02 ADR scope expansion).
- **CI cost amortized** — the 8-process tests don't run on every PR;
  they run on a dedicated `test-concurrent` lane that operators can
  monitor independently. Default fast-feedback CI under 5 min is
  preserved.
- **Real evidence beats speculation** — the negative case
  (`.runIf(platform==='win32')` 2-process no-lockfile test) is the
  load-bearing artifact that proves the lockfile is NECESSARY on
  Windows NTFS. Without this evidence, Phase 2 would be perpetually
  theoretical.

## Consequences

### Visible to users in v2.2.0

- 4 new CLI verbs:
  - `omcp team-outbox-write <session-id> <consumer> <json-payload>`
  - `omcp team-outbox-read <session-id> <consumer> [--reset] [--json]`
  - `omcp team-inbox-write <session-id> <markdown-body>`
  - `omcp team-heartbeat <session-id> <worker-index>`
- `omcp doctor team-routing` future enhancement could surface per-
  worker heartbeat freshness (deferred — not load-bearing for
  v2.2.0).
- Worker SKILL protocol upgraded — workers calling the new verbs at
  task-start + completion + checkpoint poll.
- `omcp status` does NOT change in this release — fix_loop_count
  + heartbeat surfaces remain deferred per
  `ADR-omcp-status-fix-loop-count-deferred.md`.

### Visible to operators

- **CI gains a new `test-concurrent` job** on windows-latest + Node
  20 with `OMCP_RUN_HEAVY_CONCURRENCY=1`. Operators tracking
  build-health should monitor BOTH `test` AND `test-concurrent`
  lanes. The default `test` lane stays under 5 min; `test-concurrent`
  adds ~3 min.
- **Watchdog behavior changes for v2.2 workers** — they now write
  heartbeat.json + the watchdog reads `ts` field as primary signal.
  v2.1 workers (no heartbeat) continue to be detected via shard-mtime
  fallback. No silent breakage at the v2.1→v2.2 transition.

### Visible to maintainers

- **Hand-rolled lockfile pattern** at 2 sites (outbox + inbox).
  Future stories adopting this pattern should reference EB-02 §2
  + the 8-process test fixture for the contract.
- **Zero new npm deps** — no `proper-lockfile`, no `cross-env`. The
  zero-dep policy holds.
- **The maintainer-override gate-trigger pattern is NOT a precedent.**
  Future EB gates (if any are added) require their own explicit
  override reasoning. This ADR's §"Context" §3 documents the
  scope-of-acceptance.

### Visible in the test pyramid

- Pre-EB-06 baseline: 1663 vitest cases (per Story 21 baseline run).
- EB-06 N+1 (Stories 1-4 + EB-02 ADR): adds 4 + 24 + 20 + 21 = 69
  cases (concurrent-lane smoke + outbox-write + outbox-read + inbox-
  write).
- EB-06 N+2 (Stories 5-7 + EB-05 ADR): adds 27 (heartbeat) cases.
- EB-06 N+3 (Stories 8-11): adds 12 (IPC smoke) + 2 updates to
  check-live-smoke = 12 cases net.
- Actual total post-EB-06: 1800 deterministic vitest cases on the
  default lane (5 skipped, 155/156 files green; +137 net over the 1663
  baseline; exceeds the original ~1771 projection by ~29 cases — drift
  attributable to incidental test additions during 11-story implementation)
  + ~5s of 8-process tests on the `test-concurrent` lane.

## Follow-ups

1. EB-omcp-parity-02 (outbox schema) — landed
2. EB-omcp-parity-05 (heartbeat freshness) — landed
3. CHANGELOG + 4-manifest bump to 2.2.0 — pending (US-EB06-RELEASE)
4. Live-smoke captures (P1 / P3 / P4 / IPC) — operator-driven; gates
   the v2.2.0 LOCAL tag cut via `check-live-smoke.ts`
5. Future: outbox rotation policy if long sessions surface disk-
   space concerns (gated on user signal — same defer-not-cancel
   pattern as the original EB-06)
6. Future: `omcp doctor team-routing` per-worker heartbeat freshness
   surface (low priority polish)
7. Future: macOS negative-case for the 8-process concurrency test
   (currently Windows-only per `.runIf(platform==='win32')`; macOS
   would need its own PIPE_BUF investigation)
8. npm publish remains [USER_REQUIRED] per
   `ADR-v2.0-public-release-deferred.md`. v2.2.0 LOCAL tag is
   internal; marketplace listing waits on the same channel-
   availability gate that v2.0/v2.1 still pend on.

## Tracking

- Source: iter-2 plan `docs/plans/omcp-eb-06-ipc-mesh-iter2.md` (committed
  at HEAD 1a153f6).
- Sub-ADRs: ADR-EB-02 (outbox schema), ADR-EB-05 (heartbeat freshness).
- Implementation: 11 commits across the EB-06-N+1/N+2/N+3 sessions
  (one Ralph execution session for all 11).
- Reviewer pattern: per-story architect + critic in independent
  contexts; 0 REJECT verdicts required + ITERATE feedback addressed
  before next story.
- 1 LOCAL tag at the end (gated on live-smoke per S4 contract).
