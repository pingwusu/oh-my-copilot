# ADR: RG-01 — Dispatch Receipt Protocol + Idempotent Consumption

**Date**: 2026-05-26
**Status**: Accepted (EB-RG Story 1 — first commit of the Robin gap-closing arc)
**Author**: pingwusu
**Related**:
- `.omc/plans/ralplan-robin-gap-closing.md` (gitignored; the master RALPLAN-DR
  plan whose §5 RG-01, §7 ADR-RG-01, and §8 Scenarios C/F together specify
  the protocol captured in this ADR — content is reproduced inline below
  for durability)
- `docs/adr/ADR-omcp-eb-06-ipc-mesh-revival.md` (Phase 2 IPC mesh that
  established the outbox + ack JSONL primitives RG-01 extends)
- `docs/adr/ADR-omcp-eb-02-outbox-schema.md` (outbox JSONL schema this ADR
  extends with two optional fields)
- `docs/adr/ADR-omcp-rg-02-priority-mailbox-push.md` (consumer of the
  `request_id` field in worker-push records)
- `docs/adr/ADR-omcp-rg-04-event-log.md` (records ack-related event kinds
  including ambiguous-attribution and stale-ack-ignored)
- Implementation commit: `de850f4` (`feat(team): RG-01 dispatch_request_id
  + ack receipt + idempotent consumption`)

---

## Context

`EB-omcp-parity-06` shipped the four Phase 2 IPC primitives at v2.2.0
(outbox-write, outbox-read-cursor, inbox-write, heartbeat). That mesh
delivers fire-and-forget messaging between leader and workers, but the
leader has no programmatic way to learn that a specific message was
actually consumed. Robin Norberg's `oh-my-copilot` v4.13.89 fork addresses
the same need at a different layer — his MCP bridge tracks dispatch
ids in-process — but our stateless-verb DNA forbids importing his
long-running bridge wholesale (see Option A invalidation below).

The RALPLAN-DR plan §3 frames the missing capability as **gap 2 of 6**
in Robin's fork comparison: message delivery guarantees. Concretely,
this gap is the failure mode where an autopilot script writes an outbox
record to drive a worker, then has to fall back to "sleep N seconds and
hope" because there is no acknowledgement channel keyed to the specific
dispatch. RG-01 closes that gap with the smallest possible schema delta
on the existing outbox + ack primitives.

A second tension surfaced in iter-1 critic review (C1). Both our fork
(`omcp-r2`) and Robin's fork (`omcp`) emit `randomUUID()` for any
dispatch id by default. UUIDv4 is format-identical across implementations,
so a reader pointed at a `.omcp/state/team/` directory shared by two
fork binaries cannot tell whose record is whose by inspecting the id
alone. The plan's v1 mitigation (regex-validate UUIDv4 on read) defends
against a threat that does not exist while leaving the real threat
(ambiguous cross-fork attribution) unmitigated. That mis-framing
escalated the review to ADVERSARIAL mode and forced a rewrite of
Pre-mortem Scenario C with three concrete mitigation options.

A third tension surfaced in iter-1 (C4 / PM-F): a leader receipt-waiter
killed by SIGTERM mid-poll loses the in-process record that a receipt
arrived. The naïve retry loop in autopilot or ralph re-runs
`team-wait-receipt` and either double-sends the original dispatch
(violating delivery semantics) or false-flags the message as lost. A
durable observation cache is required to preserve idempotency across
forced shutdowns.

## Decision

**Ship a schema-additive receipt protocol over the existing outbox + ack
JSONL streams, plus a new dedicated `team-wait-receipt` verb that polls
the ack stream with explicit timeout / poll-interval / stale-ack TTL,
backed by a per-session `consumed-receipts.jsonl` observation cache for
SIGTERM-safe idempotent consumption.**

Concrete shape:

1. **Outbox JSONL schema extension** (`team-outbox-write`)
   - Add optional `dispatch_request_id` field (UUIDv4 via Node's
     `crypto.randomUUID()`) — present only when the caller passes
     `--request-id <uuidv4>` on the command line.
   - Add optional `producer_fork` field — set to the literal string
     `"omcp-r2"` whenever `dispatch_request_id` is present, omitted
     otherwise.
   - Both fields are OPTIONAL. Existing readers that ignore unknown
     keys (including Robin's reader, per the iter-2 X1 cross-fork
     fixture target) continue to parse our records.

2. **Ack JSON schema extension** (`team-ack`)
   - Add optional `request_id` field — when present, must be a UUIDv4
     that lexically matches an outbox `dispatch_request_id` from the
     same session.
   - Add optional `producer_fork` field — set to `"omcp-r2"` whenever
     `request_id` is set.

3. **New verb `team-wait-receipt <sid> <request-id>`** — leader-side
   blocking poll over the worker-N-ack.json files of the session,
   keyed by `request_id`. Defaults align with the existing `team-wait`
   verb constants:
   - `TEAM_WAIT_RECEIPT_DEFAULT_TIMEOUT_MS = 1_800_000` (30 minutes,
     mirrors `team-wait.ts:28`).
   - `TEAM_WAIT_RECEIPT_DEFAULT_POLL_MS = 2_000` (mirrors
     `team-wait.ts:27`).
   - `TEAM_WAIT_RECEIPT_STALE_TTL_MULTIPLIER = 2` — acks whose `ts`
     is older than `timeout × 2` are ignored (architect A4 stale-ack
     contract).
   - Exit codes: `0` ok / `2` invalid argv / `3` timeout / `1` other I/O.

4. **Cross-fork attribution guard (C1, option (b))** — receipt match
   requires BOTH `request_id` equality AND `producer_fork === "omcp-r2"`.
   Acks missing `producer_fork` OR carrying a foreign value (e.g.
   `"omcp"`, `"omcp-r1"`) are logged as `ambiguous-attribution` events
   via the RG-04a event-append pipeline and ignored for match purposes.

5. **Idempotent SIGTERM-then-retry (PM-F)** — once `team-wait-receipt`
   observes a matching ack, it appends a single JSONL record
   `{ts, request_id, producer_fork}` to
   `.omcp/state/team/<sid>/consumed-receipts.jsonl`. On entry, the verb
   reads this file first; any matching `request_id` causes immediate
   exit 0 from cache without re-polling. Concurrent waiters on the same
   request-id both exit 0 (cache is observe-only, not lock-style);
   duplicate cache lines are accepted as benign.

## Drivers (top 3)

1. **Stateless-verb DNA must survive (Principle 1).** Robin's fork
   delivers delivery guarantees through a long-running MCP bridge
   (`mcp-team-bridge.ts`, ~1,131 LoC) that holds in-process dispatch
   tables. Adopting that pattern would invert our architecture and
   force a Windows daemon supervisor we deliberately rejected at
   v2.0. Driver pinned the choice of "extra optional JSONL fields +
   short-lived poller verb" over "long-running tracker process."

2. **Cross-fork UUID attribution (C1).** Verified at
   `/tmp/robin-omcp/bridge/cli.cjs:36809, 36862` — Robin uses
   `randomUUID()` for his dispatch ids. A receipt match on UUID alone
   would false-positive against Robin's acks if a user ever pointed
   both binaries at the same `.omcp/state/team/` directory. Driver
   pinned the additional `producer_fork` field on outbox + ack records
   as the smallest schema-additive disambiguator that survives the
   iter-2 X1 cross-fork fixture.

3. **SIGTERM-then-retry survival (PM-F).** Both `autopilot` and `ralph`
   loop callers may SIGTERM the receipt-waiter to bound the outer
   cycle. Without idempotency, the retry either double-sends the
   original dispatch (correctness violation) or false-flags lost
   (operational noise). Driver pinned the durable
   `consumed-receipts.jsonl` observation cache as the file-level
   equivalent of the in-process tracker Robin gets from his bridge.

## Alternatives Considered

### Option A — Long-running supervisor / dispatch daemon (rejected)

- **Scope**: import Robin's `mcp-team-bridge.ts` pattern wholesale.
  Each session spawns a long-lived process that holds an in-memory
  dispatch-table keyed by request_id, accepts ack callbacks, and
  exposes a query verb.
- **Pros**: identical UX to Robin's fork; no JSONL polling latency
  floor; in-process bookkeeping avoids file-IO entirely; future Robin
  changes become straightforward rebases.
- **Cons**: violates Principle 1 (stateless-verb DNA reversal);
  requires Windows supervisor lifecycle (orphaned-process cleanup,
  port allocation, supervisor crash recovery) that v2.0 deliberately
  ducked; adds ~1,131 LoC at a single site that blows past our
  1,200-LoC/file cap; reverses `ADR-omcp-eb-06-ipc-mesh-revival.md`'s
  stateless-verb decision.
- **Rejection rationale**: iter-1 critic review explicitly invalidated
  this option in §3 Option A. Maintainer-override authority exists
  but is scoped per `ADR-omcp-eb-06-ipc-mesh-revival.md:199-202` — the
  override pattern was applied once for EB-06 and is explicitly NOT
  precedent. Reversing stateless DNA would require a v3.0 architectural
  ADR, not an EB story.

### Option C — Fire-and-forget only, no receipt protocol (rejected)

- **Scope**: accept that the leader cannot programmatically learn
  whether a specific message was consumed. Recommend `team-wait`
  (general session activity poll) as the closest existing primitive
  and document the gap as out-of-scope for v2.x.
- **Pros**: zero LoC delta; zero new verbs; zero schema change; honest
  about what stateless verbs can and cannot deliver.
- **Cons**: leaves the actual correctness gap in place. Pre-mortem F
  describes a real failure mode (double-delivery from naïve retry)
  that fire-and-forget cannot mitigate. Recommending Robin's fork to
  users with delivery-semantics needs is a strategic loss.
- **Rejection rationale**: §3 Option C invalidation in the plan.
  Parity-theater steelman (S2) was acknowledged — RG-01 IS cheap
  insurance and no live bug report cited it. But the insurance cost
  (~260 LoC code + ~456 LoC tests) is small relative to the
  bug-class it eliminates, and RG-01 ships alongside RG-03 which
  carries demonstrable (not speculative) correctness value.

### Option D — `request_id` without `producer_fork` (rejected, C1 option (a))

- **Scope**: ship `dispatch_request_id` and `request_id` fields as
  designed but skip the `producer_fork` companion field. Trust the
  UUIDv4 namespace to be unique across forks (which it is statistically
  — collision probability is negligible).
- **Pros**: smaller schema delta; one fewer field to maintain across
  three call sites (outbox-write, ack, conflict / event verbs that
  follow the same pattern).
- **Cons**: UUID uniqueness is not the threat. The C1 threat is
  **format-identical attribution** — when a reader sees a UUIDv4 it
  cannot tell which fork wrote it without inspecting context. In the
  rare cross-fork-shared-directory scenario, our `team-wait-receipt`
  would false-positive against a Robin ack carrying a UUID we never
  emitted. A test fixture (X1, scheduled for RG-05) would surface this
  as a CI failure once both forks share a directory.
- **Rejection rationale**: false safety claim worse than no claim
  (iter-1 critic verdict on the v1 mitigation). `producer_fork` adds
  ~30 bytes per record (`"producer_fork":"omcp-r2"` + JSON overhead);
  on a 1MB rotation budget across a 5-worker × 30-message session that
  is ~4.5KB total — below noise floor. Schema-additive cost is
  acceptable; attribution discipline is not.

### Option E — Namespaced UUID `omcp-r2:<uuid>` in a single field (rejected, C1 option (a) variant)

- **Scope**: instead of a separate `producer_fork` field, prefix the
  UUID itself with the fork identifier: `dispatch_request_id =
  "omcp-r2:550e8400-e29b-41d4-a716-446655440000"`.
- **Pros**: one field instead of two; namespace embedded in the id
  itself; trivially unique across forks.
- **Cons**: breaks plain UUID parsers in Robin's reader. The X1
  cross-fork fixture target requires non-crash + correct iteration on
  Robin's binary; a namespaced id with a `:` separator would fail
  Robin's `randomUUID`-shaped regex (verified at
  `/tmp/robin-omcp/bridge/cli.cjs:36809`).
- **Rejection rationale**: P4 (schema-additive) holds for unknown-key
  additions but not for malformed-shape value mutations. Pushing the
  namespace into the value field weaponizes schema evolution against
  the cross-fork compatibility we are trying to preserve.

### Option F — Explicit ADR carve-out "both-forks-same-dir out of scope" (rejected, C1 option (c))

- **Scope**: skip the cross-fork attribution mitigation entirely.
  Write an ADR carve-out saying "we don't support running both
  `omcp` and `omcp-r2` against the same `.omcp/state/team/` directory.
  Users who do so are on their own."
- **Pros**: zero schema change; zero verb logic; just a paragraph in
  this ADR.
- **Cons**: pushes the problem onto users with no programmatic safety
  net. A user who imports a Robin session-state directory into our
  fork (or vice versa) for inspection would silently get false-positive
  receipt matches. The cost of detection (an `ambiguous-attribution`
  event kind) is a single conditional at read time.
- **Rejection rationale**: acceptable as fallback if X1 surfaces
  strict-mode parse failures on Robin's side (i.e. if option (b)
  breaks Robin's reader), but not preferred default. iter-2 critic
  review confirmed option (b) is the consensus pick.

## Why Option B-revised Chosen

- **Smallest schema delta that closes the gap.** Two optional fields
  per record (`dispatch_request_id` + `producer_fork`) on outbox;
  same two on ack. One new verb (`team-wait-receipt`). One new
  per-session file (`consumed-receipts.jsonl`). Total: ~1,020 LoC
  including 456 LoC of tests at commit `de850f4`. Single largest new
  file (414 LoC) is well under the 1,200-LoC/file cap.
- **Preserves stateless-verb DNA.** No long-running process; the verb
  exits when the receipt arrives, when the timeout expires, or when
  the cache hit short-circuits. Each invocation reads the JSONL
  streams, does its work, and exits.
- **Cross-fork attribution discipline scales.** The same
  `producer_fork: "omcp-r2"` pattern appears in RG-02 (push records),
  RG-03 (conflict records), and RG-04a (event records). RG-01
  establishes the discipline; the later stories consume it.
- **SIGTERM survival is testable.** The `consumed-receipts.jsonl`
  cache is the file-level equivalent of an idempotent operation
  marker. A test that runs `team-wait-receipt`, kills it, then re-runs
  the same verb can observe `exit 0 from cache hit` deterministically.

## Consequences

### Visible to users

- New verb `omcp team-wait-receipt <sid> <request-id>` available at
  the CLI. Default timeout 30 minutes; default poll 2 seconds; exit
  codes documented above.
- Existing `omcp team-outbox-write` gains optional `--request-id`
  flag. When set, the outbox record carries the two new fields;
  unchanged when unset (backwards compat).
- Existing `omcp team-ack` gains optional `--request-id` flag with
  the symmetric behavior on the ack JSON.

### Visible to operators

- New per-session file at `.omcp/state/team/<sid>/consumed-receipts.jsonl`.
  Grows by one ~60-byte record per resolved receipt. Iter-2 critic
  flagged the unbounded-growth risk as MINOR; rotation policy is a
  v3.x follow-up (see Follow-ups #1).
- Concurrent receipt-waiters on the same request-id both exit 0 and
  both append a cache record. This is intentional observe-only
  semantics — `consumed-receipts.jsonl` is a cache, not a lock.
- Stale acks (older than `timeout × 2`) are ignored AND emit a logged
  `stale-ack-ignored` event via the RG-04a pipeline. Operators can
  filter `events.jsonl` on that kind to detect crashed-worker
  resurrection scenarios.

### Visible to maintainers

- New constant `PRODUCER_FORK_ID = "omcp-r2"` introduced in
  `src/cli/commands/team-outbox.ts`. Both `team-ack.ts` and
  `team-wait-receipt.ts` import it (or duplicate the literal for now —
  see Follow-up #2). Any future code path that emits a cross-fork
  attributable record must use this constant.
- The `UUID_V4_RE` regex is duplicated between `team-outbox.ts` and
  `team-ack.ts` at commit `de850f4`. Iter-1 critic flagged as MINOR;
  extract to `src/runtime/uuid.ts` in a follow-up commit.
- `appendConsumedReceipt` uses `appendFileSync` rather than
  `atomicWriteFileSync`. Deliberate (the JSONL append-only contract
  tolerates partial last-line on crash) but worth noting as an
  Invariant 2 carve-out alongside the existing hermes-bridge
  precedent.

### Visible in the test pyramid

- 25 new vitest cases in `src/__tests__/team-wait-receipt.test.ts`
  covering: defaults sanity, UUIDv4 guard, argv validation, happy
  path, PM-F idempotency (cache hit + foreign-fork filter +
  malformed-line tolerance), timeout path, cross-fork attribution
  (missing + foreign producer_fork), stale-ack TTL, CLI wrapper, and
  directory lifecycle.
- 24/24 existing `team-outbox` tests continue to pass — backwards-
  compat invariant holds.
- Smoke row `dispatch-receipt` is DEFERRED to RG-05 per architect
  A5 distributed-smoke contract. The structural `check-live-smoke`
  row and the operator-captured live attestation will land together
  in RG-05, not piecemeal with this story.

## Follow-ups

1. `consumed-receipts.jsonl` rotation policy at 1MB analogous to
   RG-03/RG-04a. Iter-2 critic §3.4 flagged the gap as MINOR; one
   record is ~60 bytes so 1MB ≈ 17,000 receipts (sufficient for a
   long-running autopilot session but worth flagging).
2. Extract duplicated `UUID_V4_RE` from `team-outbox.ts` +
   `team-ack.ts` into `src/runtime/uuid.ts` (or refactor to single
   import). Trivial polish; iter-1 critic MINOR finding.
3. `PRODUCER_FORK_ID` location — consider `src/runtime/fork-identity.ts`
   as the canonical home once RG-02/03/04a all consume it. Currently
   lives in `team-outbox.ts` per iter-1 critic Open Question 2.
4. Reverse cross-fork fixture (our reader on Robin's records) per
   iter-2 architect §3.4 — defer to v3.x or RG-05 stretch.
5. Document the maintainer-override caveat in line with
   `ADR-omcp-eb-06-ipc-mesh-revival.md:199-202`. The RG arc reuses
   the maintainer-override gate; this is acknowledged at the EB-RG
   prd.json level. **Do NOT reuse this pattern without explicit
   user signal.**

## Tracking

- Plan: `.omc/plans/ralplan-robin-gap-closing.md` §1 Principles, §3
  Option B recommendation, §5 RG-01, §7 ADR-RG-01, §8 Pre-mortem
  Scenarios C + F. The plan file is gitignored; its content is
  reproduced inline in this ADR for durability.
- Architect review: `.omc/plans/architect-review-rg-iter2.md` (APPROVE).
- Critic review: `.omc/plans/critic-review-rg-iter2.md` (APPROVE);
  iter-1 critic findings C1 + PM-F applied verbatim at iter-2.
- Per-story RG-01 review: `.omc/plans/critic-review-rg-01.md`
  (ACCEPT-WITH-RESERVATIONS; 8/8 acceptance criteria pass).
- Implementation: `de850f4` (1020 insertions, 6 deletions, 5 files).
- Test count: 25 new vitest cases + 24 existing tests preserved =
  49/49 green at commit time.
