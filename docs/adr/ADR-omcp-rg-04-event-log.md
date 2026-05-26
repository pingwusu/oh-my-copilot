# ADR: RG-04 — Event Log Shape + Per-Stream Lockfile + Ts Validation

**Date**: 2026-05-26
**Status**: Accepted (EB-RG Story 4 — RG-04a verbs shipped; RG-04b instrumentation deferred to per-target-verb mini-commits)
**Author**: pingwusu
**Related**:
- `.omc/plans/ralplan-robin-gap-closing.md` (gitignored; §5 RG-04a + §5
  RG-04b, §7 ADR-RG-04, §8 Scenarios B + G, change-log rows A2 + A3
  specify the event-log infrastructure captured in this ADR — content
  reproduced inline below for durability)
- `docs/adr/ADR-omcp-eb-06-ipc-mesh-revival.md` (Phase 2 IPC mesh that
  established the lockfile + JSONL append-only patterns RG-04a extends)
- `docs/adr/ADR-omcp-eb-02-outbox-schema.md` (the hand-rolled lockfile
  pattern in `team-outbox.ts:140-220` that RG-04a extracts into a
  reusable helper)
- `docs/adr/ADR-omcp-rg-01-dispatch-receipt.md` (establishes the
  `producer_fork: "omcp-r2"` cross-fork attribution discipline that
  event records consume)
- `docs/adr/ADR-omcp-rg-03-conflict-mailbox.md` (shares the per-stream
  lockfile primitive extracted by RG-04a)
- Implementation commit: `deaf0e3` (`feat(team): RG-04a event log
  verbs + ts validation + per-stream-lock helper`)

---

## Context

A chronological event stream is the missing observability surface in
our team-mode IPC mesh. The Phase 2 primitives (outbox, inbox,
heartbeat, conflict) each have their own JSONL streams, but there is
no single sequence-ordered audit trail across them. Debugging a failed
multi-worker session means correlating across N JSONL files by
timestamp — workable but error-prone. Robin Norberg's fork ships a
unified `events.jsonl` audit log; we lack it.

The RALPLAN-DR plan §3 frames this as **gap 4 of 6** in Robin's fork
comparison: audit trail / observability. The v1 plan attempted to
ship the event-log verbs AND the per-verb instrumentation patches in
a single RG-04 story. Architect iter-1 review (A3) split the story
into RG-04a (verbs alone) + RG-04b (instrumentation patches landed
with each target verb) to preserve Principle 3 (one verb per gap,
one commit per verb) and improve rollback discipline. This ADR
documents both halves; only RG-04a has shipped at commit `deaf0e3`,
RG-04b is deferred to per-target-verb mini-commits.

Two design tensions surfaced in iter-1 review:

(1) **Lockfile contention vs lockfile-per-stream isolation** (architect
A2). The v1 plan §5 RG-04 said "Same lockfile primitive as outbox"
(implying a single shared lockfile across all JSONL streams). The v1
plan §8 Scenario B contradicted that by proposing "separate lockfile
per JSONL stream." Architect A2 picked **per-stream lockfile**
explicitly: each JSONL stream owns its own lockfile derived as
`<stream>.lock` colocated with the stream file. Events ingest must not
block outbox ingest under load. The rotation race that a per-stream
choice introduces (two writers both seeing >1MB → both renaming →
clobber) is eliminated by a **rotation-lock contract**: rotation
happens INSIDE the per-stream lock, so only one process can rename at
a time.

(2) **Future-timestamp audit-log poisoning** (critic PM-G / C5). A
worker or local-FS attacker writes an event with `ts =
"9999-12-31T23:59:59Z"`. `team-event-tail --since <ts>` using
lexicographic compare never excludes the poison record. The mitigation
chosen validates `ts ∈ (now - 24h, now + 5min)` on both write AND read
paths. Write-rejection prevents poisoning from inside our verbs;
read-skip handles direct file tampering. The read-skip path itself
needs to emit a `poison-record-detected` event — but that emission
goes through write-side validation and would fail with a future ts.
The recursion guard uses a sentinel `ts = now` (by construction inside
the validation window) to break the loop.

## Decision

**Ship two new stateless verbs (`team-event-append`,
`team-event-tail`) operating on a single per-session events JSONL
stream at `.omcp/state/team/<sid>/events.jsonl`. Extract the
per-stream lockfile pattern (previously inline in `team-outbox.ts`)
into a reusable helper at `src/runtime/per-stream-lock.ts`. Rotation
inside per-stream lock at 1MB. Ts validation on both read and write
paths with sentinel-ts recursion break.**

Concrete shape:

1. **Event record shape** —
   `{ts, verb, actor, shard?, request_id?, producer_fork, kind,
   detail?}`. All records carry `producer_fork: "omcp-r2"` per the
   ADR-RG-01 contract. `shard` and `request_id` are optional context
   fields populated when the emitting verb has them.

2. **`team-event-append <sid> <verb> <actor> <kind> [--shard X]
   [--request-id X] [--detail "..."]`** — appends one event record.
   Exit codes: `0` ok / `2` invalid argv / `5` rejected ts (out of
   `(now - 24h, now + 5min)` window) / `1` other I/O.

3. **`team-event-tail <sid> [--since ts] [--type kind]
   [--limit N] [--json]`** — reads events.jsonl + rotated `.1`
   files; emits matching records to stdout. Filters compose
   conjunctively. Default emits all events; `--limit` defaults to 100.

4. **Per-stream lockfile (A2 explicit pick)** — `events.jsonl.lock`
   is independent from `outbox.jsonl.lock`, `inbox.jsonl.lock`,
   each conflict-shard lockfile, and each push-shard lockfile. Five
   or more independent lockfiles in an active 5-worker session is
   the expected operating point. The lockfile churn cost is bounded
   by the `lock_acquire_ms p95 < 500ms` contract verified in the
   RG-04a test suite under 5-worker × 10-msg/s load.

5. **Rotation inside per-stream lock (A2 rotation-lock contract)** —
   when any writer detects `events.jsonl > 1MB`, it acquires the
   per-stream lock, re-checks the size inside the lock, then renames
   `events.jsonl` → `events.jsonl.1` (overwriting any existing
   `.1`). Only one process can hold the lock at a time. The race
   where two writers both see >1MB and both rename is eliminated.

6. **Ts validation (PM-G / C5)** — on both write AND read paths,
   validate `ts ∈ (now - 24h, now + 5min)`. Write-rejection exits 5.
   Read-skip emits a sentinel event `kind = "poison-record-detected"`
   with `ts = now` (by construction inside the validation window).
   Sentinel `kind` bypasses ts validation on write to break infinite
   recursion. The 5-minute future tolerance accounts for NTP
   drift on domain-joined Windows machines and CI runners.

7. **`src/runtime/per-stream-lock.ts` helper** — extracts the
   lockfile primitive from `team-outbox.ts` (inline pattern) into a
   shared module. RG-03's conflict streams + RG-04a's events stream
   both consume `acquirePerStreamLock`. Future stories should use
   this helper rather than re-implementing the pattern.
   `team-outbox.ts` refactor to consume the helper is OUT OF SCOPE
   for RG-04a — call-site swap is a v2.4 follow-up.

## CRITICAL: Per-Stream Lockfile Contract (A2 Resolution)

The v1 plan body had a §5-vs-§8B contradiction: §5 RG-04 claimed
"Same lockfile primitive as outbox" (single shared lockfile across
all JSONL streams) while §8 Scenario B proposed "separate lockfile
per JSONL stream." Architect iter-1 review forced a pick. The chosen
contract — per-stream lockfile with rotation-inside-lock — has three
load-bearing properties that future contributors should preserve:

**Property 1: Per-stream isolation.** Each JSONL stream owns its
own lockfile colocated with the stream file. `events.jsonl` →
`events.jsonl.lock`. `outbox.jsonl` → `outbox.jsonl.lock`. Each
conflict shard → its own per-shard lockfile. Each push shard → its
own per-shard lockfile. The motivation is contention isolation:
events ingest under load must not block outbox ingest. Under 5
workers × 10 msg/s, a shared lockfile would serialize all stream
writes through a single mutex; per-stream lockfiles let independent
streams write in parallel.

**Property 2: Rotation inside the lock.** Rotation must happen INSIDE
the per-stream lock, not before acquiring it. The rotation code
path is: (a) acquire lock; (b) stat the stream file; (c) if size >
1MB, rename `stream.jsonl` → `stream.jsonl.1` (overwriting any
existing `.1`); (d) write the new record to `stream.jsonl`;
(e) release lock. Without the in-lock check, two concurrent writers
that both stat-and-see-1MB before either acquires the lock would
both rename, and the second rename clobbers the first writer's data.

**Property 3: Sentinel-based recursion break.** Read-time ts
validation cannot cleanly recurse through the same write path. If a
poison record's ts is out of window, the read skips it AND emits a
sentinel event documenting the skip. That sentinel event goes
through write-side validation; if its own ts were also out of
window, the write would reject and emit ANOTHER sentinel, ad
infinitum. The recursion break is to construct the sentinel with
`ts = now` (which is always in window by definition) and to mark the
sentinel `kind = "poison-record-detected"` as a write-side validation
bypass token. Write-side checks for that exact kind first; if
matched, skips ts validation.

These three properties together resolve the §5-vs-§8B contradiction
that blocked iter-1 architect approval. They are tested by the 42
vitest cases in `src/__tests__/team-event.test.ts` (under 5-process
concurrent contention) and the rotation-race test specifically.

## Drivers (top 3)

1. **Chronological audit trail (gap 4).** Robin's fork has it; we
   lack it. Driver pinned a single per-session events stream rather
   than per-verb log files (which would require post-hoc merge by
   ts) or a structured-logger dep (which would violate Driver 3
   zero-new-deps).

2. **§5-vs-§8B contradiction resolution (A2).** The v1 plan body
   said one thing in §5 and another in §8B. Iter-1 architect review
   forced a pick. Driver pinned per-stream lockfile because events
   ingest must not block outbox ingest under load — and because
   the existing `team-outbox.ts:140-220` lockfile pattern is
   already per-stream, RG-04a extracts what the code does in
   practice.

3. **Future-timestamp audit-log poisoning (PM-G / C5).** A worker
   or local-FS attacker can write a record with arbitrary ts. The
   `--since` lexicographic compare in `team-event-tail` would
   never exclude `ts = "9999-..."`. Driver pinned write-AND-read
   path ts validation with the (now - 24h, now + 5min) window.

## Alternatives Considered

### Option A — SQLite events database (rejected)

- **Scope**: ship events in a SQLite database. Use SQLite's
  ACID guarantees for the rotation/contention story. Queries
  via SQL.
- **Pros**: well-tested concurrency model; native query
  language; no hand-rolled lockfile primitive needed.
- **Cons**: new npm dep (`better-sqlite3` or similar). Violates
  Driver 3 (zero-new-deps). Database file becomes another
  coordination point with its own lockfile semantics on Windows.
  Stateless-verb model breaks if the database connection lifetime
  doesn't match the verb invocation.
- **Rejection rationale**: zero-new-deps line. The hand-rolled
  lockfile primitive from `team-outbox.ts` is already battle-
  tested; reusing it through the extracted helper is cheaper than
  swapping to a database.

### Option B — Per-verb log files (rejected)

- **Scope**: each verb writes its own log file (`outbox-events.jsonl`,
  `inbox-events.jsonl`, etc.). No central events stream.
- **Pros**: no cross-verb contention; each verb's events are
  isolated.
- **Cons**: no chronological ordering across verbs. Debugging a
  multi-verb failure requires merging N files by ts — the same
  problem we currently have without an event log. Tail/filter UX
  is fragmented across files.
- **Rejection rationale**: defeats the purpose. A central event
  log is the whole point.

### Option C — Structured-logger dependency (rejected)

- **Scope**: import `pino`, `winston`, or similar. Configure
  multiple sinks. Let the library handle rotation + concurrency.
- **Pros**: production-grade logging out of the box; well-tested
  rotation strategies; multi-sink (file + stdout + remote).
- **Cons**: new npm dep. Violates Driver 3. Loggers tend to
  assume long-running processes; the stateless-verb model would
  pay a startup cost per invocation for sink configuration.
- **Rejection rationale**: zero-new-deps + stateless-verb
  startup-cost concerns.

### Option D — Shared-with-outbox lockfile (rejected)

- **Scope**: single shared lockfile across all JSONL streams. The
  v1 plan §5 implicit choice.
- **Pros**: only one lockfile per session; simpler bookkeeping.
- **Cons**: events ingest blocks outbox ingest. Under load (5
  workers × 10 msg/s × 5 streams + events), the lock becomes a
  serialization point. The `bdbe176` outbox backoff ladder was
  already extended to 19.25s for CI runner contention — a shared
  lockfile would push that even higher.
- **Rejection rationale**: architect A2 verdict. Per-stream
  isolation is the right contention story.

### Option E — No rotation (rejected)

- **Scope**: events.jsonl grows unbounded. Operators rotate
  manually or accept the linear-scan cost.
- **Pros**: simpler code; no rotation race to worry about.
- **Cons**: long-running sessions accumulate events without
  bound. `team-event-tail --since <ts>` linear-scan latency
  degrades. The C3 / PM-E argument that applied to conflict
  records applies equally here.
- **Rejection rationale**: consistency with RG-03 rotation
  semantics. 1MB ≈ thousands of events; rotation overhead is
  microseconds.

### Option F — Read-only ts validation (rejected for the poison case)

- **Scope**: validate ts only on the read path. Accept whatever
  the write side wrote.
- **Pros**: simpler write path; no recursion-break sentinel
  needed.
- **Cons**: leaves the write path open to local-FS attackers AND
  to buggy verbs (clock-skewed CI runners, manual file edits).
  The defense-in-depth argument cuts: validating on both sides
  detects attacks earlier (at write time, when the user can be
  notified) and survives direct file tampering (at read time).
- **Rejection rationale**: PM-G mitigation requires both paths.
  The recursion-break sentinel is a known cost of the both-paths
  choice and is documented above.

## Why Per-Stream Lockfile + Rotation-Inside-Lock + Sentinel-Break Chosen

- **Resolves the §5-vs-§8B contradiction with architect A2 verdict.**
  Per-stream lockfile is what `team-outbox.ts:140-220` already does
  in practice; RG-04a extracts the pattern and applies it to
  events.jsonl.
- **Contention isolation under load.** Events writes do not block
  outbox writes. `lock_acquire_ms p95 < 500ms` verified by test
  under 5-worker × 10-msg/s synthetic load.
- **Rotation race eliminated.** The rename happens inside the lock;
  no two processes can both see-and-rename.
- **PM-G poisoning mitigated on both sides.** Write rejection
  prevents in-our-verbs poisoning; read skip handles direct file
  tampering. Sentinel-ts recursion guard prevents the read-skip
  emission from triggering an infinite loop.
- **Helper extraction pays forward.** `src/runtime/per-stream-lock.ts`
  is consumed by both RG-03 (conflict streams) and RG-04a (events).
  Future stories writing JSONL streams should consume this helper
  rather than re-implementing the pattern.

## Consequences

### Visible to users

- Two new verbs at the CLI:
  - `omcp team-event-append <sid> <verb> <actor> <kind>
    [--shard X] [--request-id X] [--detail "..."]`
  - `omcp team-event-tail <sid> [--since ts] [--type kind]
    [--limit N] [--json]`
- Events.jsonl appears in every active team session under
  `.omcp/state/team/<sid>/events.jsonl`. Empty until verbs are
  instrumented (RG-04b not shipped yet); manual `team-event-append`
  invocations populate it in the interim.
- `team-event-tail --since <ts> --type ack` filters by ISO 8601
  ts (lexicographic compare) and exact kind match.

### Visible to operators

- Five-or-more stream lockfiles in active 5-worker sessions:
  `outbox.jsonl.lock`, `inbox.jsonl.lock`, per-shard conflict
  locks, per-worker push locks, `events.jsonl.lock`. Lockfile
  count grows with worker count + shard count. Operators should
  not expect a single "session lock."
- Rotation events are silent by default (no log line); the
  rotated file appears at `events.jsonl.1` and the new fresh
  file replaces it.
- Ts validation rejects write attempts outside the window with
  exit code 5. CI runners with clock skew >5 minutes will see
  these rejections; the fix is to sync the CI clock, not to
  widen the window.

### Visible to maintainers

- `src/runtime/per-stream-lock.ts` is the canonical home of the
  lockfile primitive. RG-03 and RG-04a both consume it. Future
  JSONL stream stories should reuse rather than fork.
- `team-outbox.ts` still has the inline lockfile pattern at
  commit `deaf0e3`. Refactoring outbox to consume the helper is
  out of scope for RG-04a; track as v2.4 follow-up.
- The sentinel `kind = "poison-record-detected"` is a write-side
  validation bypass token. Adding new bypass kinds is a deliberate
  schema decision — do not casually add bypass tokens.
- RG-04b will land per-target-verb instrumentation patches in
  separate commits (one per target). Each commit adds ~10 LoC to
  its target verb. Rolling back a target verb also rolls back its
  instrument-patch commit, leaving events.jsonl pipeline (RG-04a)
  healthy with the remaining instruments.

### Visible in the test pyramid

- 42 new vitest cases in `src/__tests__/team-event.test.ts`
  covering: happy path, ts validation (read + write), PM-G
  recursion guard, 1MB rotation, 5-process concurrent write
  contention, tail filters (since/type/limit), poison-record
  handling.
- Smoke row `event-log-tail` is DEFERRED to RG-05 per architect
  A5 distributed-smoke contract (consistent with RG-01/02/03).

## Follow-ups

1. RG-04b instrumentation mini-commits — one per target verb
   (`team-outbox`, `team-inbox`, `team-heartbeat`, `team-conflict`,
   `team-push-prompt`). ~10 LoC per target = ~50 LoC distributed.
   Each commit is atomic; rolling back a target verb also rolls
   back its instrument.
2. `team-outbox.ts` refactor to consume
   `src/runtime/per-stream-lock.ts` helper rather than inline
   lockfile pattern. v2.4 follow-up; out of scope for RG-04a.
3. Multi-level rotation policy in v3.x if audit-trail retention
   demands grow. Currently `.1` is the only rotated file;
   long-term audit needs would want `.1`, `.2`, ... with a
   retention budget.
4. `team-event-tail --follow` (tail -f style) — deferred to v3.x
   per Open Question 2 in the plan. Adding `--follow` means a
   long-running process which is a small dent in stateless-verb
   principle.
5. RG-05's `team-event-health-check` consumes the events.jsonl
   integrity contract. Health-check looks for: PM-G poison
   records (should be 0 after RG-04a's write-time rejection),
   rotation anomalies (`events.jsonl.1` exists AND
   `events.jsonl` >1MB simultaneously), orphaned lockfiles.
6. NTP drift assumption document in this ADR — the 5-minute
   future tolerance assumes NTP drift ≤ 5min on domain-joined
   Windows + CI runners. Beyond that, sentinel-ts constructed
   inside validation window would itself fail validation.
   Acceptable bound per iter-2 critic §3.1 review.

## Tracking

- Plan: `.omc/plans/ralplan-robin-gap-closing.md` §5 RG-04a + §5
  RG-04b, §7 ADR-RG-04, §8 Pre-mortem Scenarios B + G, change-log
  rows A2 (per-stream lockfile pick) + A3 (RG-04 split). The plan
  file is gitignored; its content is reproduced inline in this
  ADR for durability.
- Architect review iter-1: `.omc/plans/architect-review-rg.md` A2
  (per-stream lockfile pick + rotation-lock contract) + A3 (RG-04
  split).
- Architect review iter-2: `.omc/plans/architect-review-rg-iter2.md`
  (APPROVE).
- Critic review iter-1: `.omc/plans/critic-review-rg.md` C5 / PM-G
  (ts validation + sentinel recursion break).
- Critic review iter-2: `.omc/plans/critic-review-rg-iter2.md`
  (APPROVE).
- Implementation: `deaf0e3` (RG-04a event log + ts validation +
  per-stream-lock helper). Test count: 42/42 green.
- RG-04b status: pending per-target-verb instrumentation mini-
  commits; not blocked on this ADR.
