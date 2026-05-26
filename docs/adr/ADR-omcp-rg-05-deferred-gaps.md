# ADR: RG-05 — Deferred Gaps (Multi-Transport Routing + Wait Daemon)

**Date**: 2026-05-26
**Status**: Accepted (EB-RG Story 5 — defer-with-rationale ADR; no code ships)
**Author**: pingwusu
**Related**:
- `.omc/plans/ralplan-robin-gap-closing.md` (gitignored; §3 Option A
  invalidation, §3 Option C invalidation, §5 RG-05 deferred-with-
  rationale text, §7 ADR-RG-05, change-log rows S1 + S2 together
  specify the two deferred gaps and the rationale captured in this
  ADR — content reproduced inline below for durability)
- `docs/adr/ADR-omcp-eb-06-ipc-mesh-revival.md` (the master ADR whose
  maintainer-override caveat — "do NOT reuse this pattern without
  explicit user signal" — applies symmetrically to the deferrals
  in this ADR)
- `docs/adr/ADR-omcp-rg-01-dispatch-receipt.md`,
  `docs/adr/ADR-omcp-rg-02-priority-mailbox-push.md`,
  `docs/adr/ADR-omcp-rg-03-conflict-mailbox.md`,
  `docs/adr/ADR-omcp-rg-04-event-log.md` (the four ADRs whose
  shipped scope this ADR explicitly bounds — RG-05 says "no more
  than these four")
- No implementation commit (this is a deferral ADR; no code lands)

---

## Context

Robin Norberg's `oh-my-copilot` v4.13.89 fork carries six material
capability gaps vs our v2.2.0 baseline. The RALPLAN-DR plan §3 Option
B (recommended) closes four of those six gaps as new stateless verbs:

- Gap 1: leader→worker active push → RG-02 (priority-mailbox push)
- Gap 2: message delivery guarantees → RG-01 (dispatch receipt)
- Gap 3: multi-worker file collision detection → RG-03 (conflict
  mailbox)
- Gap 4: audit trail / observability → RG-04 (event log)

The remaining two gaps are **deferred with rationale** in this ADR.
Each is technically achievable but is rejected for the v2.x release
line on architectural grounds documented below. The deferral is
honest about what we will not ship and explicit about the re-
evaluation triggers that would reopen the decision in v3.x.

This ADR has no implementation commit. Its purpose is to bound the
EB-RG arc's shipped scope: the four ADRs above describe what shipped,
this ADR describes what deliberately did NOT ship. The discipline
this ADR establishes is symmetric to the one
`ADR-omcp-eb-06-ipc-mesh-revival.md` established for the maintainer-
override gate: do not casually expand the scope by claiming "we
should also do gap 5/6 because we did 1-4."

## Decision

**Defer gap 5 (multi-transport routing) and gap 6 (wait / rate-limit
auto-resume daemon) to v3.x with explicit re-evaluation triggers.**
Concretely:

1. **Gap 5: multi-transport routing** — Robin's
   `hook` / `prompt_stdin` / `tmux_send_keys` / `mailbox` fallback
   chain is NOT ported to v2.x. RG-02 ships a single-transport
   active push (priority-mailbox only).
2. **Gap 6: wait / rate-limit auto-resume daemon** — Robin's
   long-running auto-resume process that watches for rate-limit
   responses and reschedules dispatches is NOT ported to v2.x. No
   `omcp team-wait-daemon` verb ships; rate-limit handling remains
   the caller's responsibility (autopilot/ralph scripts polling
   `team-wait-receipt` with backoff).

Both deferrals carry **re-evaluation triggers** that would reopen
the decision in v3.x — see Follow-ups section below.

## Gap 5 — Multi-Transport Routing (Deferred)

### What Robin's fork provides

Robin's `mcp-team-bridge.ts` exposes four transports for leader-to-
worker prompt delivery, attempted in fallback order:

- **`hook`** — JavaScript callback registered in-process by the MCP
  bridge. Direct in-memory dispatch.
- **`prompt_stdin`** — write to the worker's Copilot CLI stdin via
  named pipe (the transport ADR-RG-02 rejected on three independent
  architectural grounds).
- **`tmux_send_keys`** — invoke `tmux send-keys` against the
  worker's pane. Sub-second latency; well-tested on Linux/macOS.
- **`mailbox`** — file-based fallback (analogous to our RG-02
  priority-mailbox shard).

The bridge tries each in order; failures cascade to the next
transport. A worker registered with all four transports gets the
fastest available delivery; a worker registered with mailbox-only
gets the slowest but most-reliable path.

### Why we defer

Three of the four Robin transports are architecturally unavailable
on our v2.x platform:

- **`hook`** requires the long-running MCP bridge supervisor that
  inverts our stateless-verb DNA. Same blocker as Option A in
  ADR-RG-01/02 — would require a v3.0 architectural ADR, not an
  EB-RG story.
- **`prompt_stdin`** is unimplementable per the three-failure
  analysis in `docs/adr/ADR-omcp-rg-02-priority-mailbox-push.md`
  "CRITICAL: Documentation of the Named-Pipe Rejection." Detached +
  unref'd spawn has no parent handle to retain; Windows stdin is a
  kernel HANDLE not a filesystem path; heartbeat schema bump has
  its own cascade.
- **`tmux_send_keys`** has no Windows equivalent. tmux does not run
  on Windows v2.x; Windows Terminal does not expose a `send-keys`
  equivalent surviving detached spawn; WSL is excluded from our
  target audience (Copilot CLI runs natively on Windows).

Only `mailbox` (the v2.x RG-02 transport) is implementable on our
platform. A "multi-transport router" with one available transport
is not a router — it is a single-transport path with extra
ceremony. Shipping the router scaffolding without any of the
upstream transports it would select between is parity-theater
work (steelman S2 from the plan §3) with no measurable benefit.

### Rationale

- **Platform constraint is hard.** v2.x targets Windows exclusively
  (per CLAUDE.md repo conventions). Three of four transports are
  Windows-unavailable. The router itself adds LoC without
  capability.
- **Stateless-verb DNA preservation (Principle 1).** The `hook`
  transport specifically requires a long-running supervisor. Same
  rejection rationale as Option A in ADR-RG-01: stateless DNA
  reversal requires v3.0 ADR.
- **Mailbox transport already shipped.** RG-02's
  priority-mailbox push delivers active push on v2.x. The 500ms
  p95 latency is acceptable for v2.x; the router scaffolding would
  not change that latency floor.

### Re-evaluation triggers (v3.x)

- **tmux on Windows becomes real OR cross-platform expansion lands.**
  If Linux/macOS support is added, the tmux_send_keys transport
  becomes valuable. At that point, the router scaffolding becomes
  worth implementing.
- **User signal requesting multi-transport.** The maintainer-
  override caveat from ADR-omcp-eb-06 applies: defer-not-cancel.
  If a user signal arrives demanding multi-transport, the deferral
  reopens with an explicit override (and the override pattern
  applies once, not as precedent).

### Cross-reference invalidation

This deferral is consistent with `.omc/plans/ralplan-robin-gap-
closing.md §3` Option A invalidation:

> "Inverts our architecture (stateless verbs become RPC stubs).
> Adds ~2.5k LoC. Forces us to ship a long-running daemon on
> Windows with all the lifecycle problems (orphaned processes,
> port allocation, supervisor crashes) we deliberately ducked.
> Burns 4+ weeks. ADR-EB-06 (stateless-verb decision) would need
> to be reversed."

The S1 gravity-argument steelman was acknowledged in the plan
§3 Option A:

> "Every Option-B story we ship is a new local primitive we
> maintain forever, with no upstream rebase path. Robin's module
> gets free maintenance — our bespoke verbs don't."

Rebuttal (reproduced for durability): rebase value is asymmetric —
roughly 40% of Robin's churn is on code we'd revert anyway (tmux
transport, multi-transport router, rate-limit daemon). The rebase
cost is not 100% of Robin's LoC; it's the maintainable subset,
which is closer to what Option B already absorbs as targeted verbs.

## Gap 6 — Wait / Rate-Limit Auto-Resume Daemon (Deferred)

### What Robin's fork provides

Robin's MCP bridge includes a wait daemon that:

- Watches worker outputs for Copilot CLI rate-limit responses
  (HTTP 429, "you have been rate limited", etc.).
- Computes the backoff window from the rate-limit response.
- Reschedules pending dispatches after the backoff window expires.
- Pauses outbox-to-worker delivery during the backoff to avoid
  burning quota on requests that will be rejected.

The daemon is a long-running process that exists for the lifetime
of the session. It maintains in-memory state: pending dispatches,
current rate-limit posture, and scheduled wake-up times.

### Why we defer

The wait daemon is a long-running supervisor by design. Its in-
memory state (pending dispatch queue, rate-limit posture, wake-up
schedule) does not naturally serialize to JSONL — checkpointing it
to disk on every state change would create the same throughput
problem the database-vs-file-IPC decision in ADR-omcp-eb-02
already rejected.

Our v2.x architecture explicitly chose stateless verbs over a
long-running supervisor at `ADR-omcp-eb-06-ipc-mesh-revival.md`.
The wait daemon is the textbook case the stateless-verb DNA was
designed to forbid:

- Daemon has in-memory state that survives across operations.
- Daemon has its own lifecycle (start, supervise, restart on
  crash).
- Daemon has its own observability surface (is it running? what
  is it waiting on?).
- Daemon has its own Windows port-allocation / orphaned-process
  / crash-recovery problems.

Shipping the wait daemon would require:

- A new long-running process type (violates Principle 1).
- A supervisor pattern for the long-running process (Windows
  service? Scheduled task? Detached subprocess with a watchdog?
  Each has problems).
- State checkpointing for crash recovery (or the wait state is
  lost on every restart, which defeats the daemon's purpose).
- An observability surface (how does an operator inspect the
  current backoff posture? Files? gRPC? Stdout from a dedicated
  status verb?).

Each of these requires a v3.0 architectural revisit. The wait
daemon is not a feature; it is an architectural posture.

### Rationale

- **Stateless-verb DNA preservation (Principle 1) is non-
  negotiable for v2.x.** ADR-omcp-eb-06 established the posture;
  this ADR enforces it.
- **Caller-side rate-limit handling is workable in stateless
  verbs.** Autopilot/ralph scripts that poll `team-wait-receipt`
  with exponential backoff handle the common case. The script
  catches the non-zero exit, sleeps, retries. The script itself
  is the "daemon" — and it is short-lived, callable, and
  composable with other stateless verbs.
- **Adoption signal is not present.** No user has reported the
  caller-side approach as inadequate. The parity-theater steelman
  S2 cuts hard against shipping a daemon before there is evidence
  of need.

### Re-evaluation triggers (v3.x)

- **v3.0 architectural revisit when daemon adoption is on the
  roadmap.** Once stateless-verb DNA is up for renegotiation
  (per v3.0 planning), the wait daemon becomes a candidate
  feature. Until then, it is deferred.
- **User signal requesting auto-resume.** Same defer-not-cancel
  pattern as Gap 5. The maintainer-override caveat applies once,
  not as precedent.

### Cross-reference invalidation

This deferral is consistent with `.omc/plans/ralplan-robin-gap-
closing.md §3` Option C invalidation framing:

> "Acknowledge the gaps, write one master ADR that explains why
> we choose not to close them in v2.x, point users at Robin's
> fork if they need those features, ship nothing else."

Option C as a whole was invalidated (RG-03 has demonstrable
correctness value that Option C would surrender), but the
"deferred-with-rationale" subset of Option C was preserved for
gaps 5 and 6 specifically. This ADR codifies that subset.

The S2 parity-theater steelman from the plan §3 Option C was
acknowledged:

> "Gap 1 (push delivery) and gap 2 (ack guarantees) are framed
> as correctness issues but no user bug report is cited. EB-RG
> is maintainer-override speculative build — exactly the anti-
> pattern EB-06's own ADR cautioned against."

Rebuttal (reproduced for durability): the parity-theater
critique correctly disciplines RG-01 and RG-02 (no live bug
report; cheap insurance). It does NOT discipline RG-03 —
conflict clobber is observable today in the live-multi-worker
harness and `team-verify` will not detect it. RG-03 is
demonstrable correctness work, not speculative. RG-01 and
RG-02 are cheap insurance built ON TOP of that demonstrable
need, and ship together with RG-03 for a coherent EB cycle.
**Gap 5 and gap 6 do not have the RG-03 anchor, and so they
defer.**

## Consequences

### Visible to users

- Active push remains a single-transport path. No transport-
  selection logic; no fallback chain. Users wanting multi-
  transport stay on Robin's fork or use external orchestration.
- Rate-limit handling remains the caller's responsibility.
  Autopilot/ralph scripts must catch rate-limit signals and
  back off themselves; no automatic resume daemon exists.
- The CLI surface is bounded by what RG-01/02/03/04 shipped.
  No `omcp team-route-prompt` or `omcp team-wait-daemon` verb
  appears.

### Visible to operators

- No long-running team daemon to monitor. The only persistent
  state is in JSONL files; the only "process" running between
  verb invocations is the workers themselves (Copilot CLI
  instances).
- Rate-limit observability is whatever the autopilot/ralph
  script implements. The events.jsonl stream (RG-04a) does
  not surface rate-limit events automatically; instrumenting
  rate-limit detection is a caller-script responsibility.

### Visible to maintainers

- **The deferral is durable but reversible.** Each deferred
  gap has explicit re-evaluation triggers documented above.
  Reopening the decision requires either platform expansion
  (Gap 5) or a v3.0 architectural revisit (Gap 6) — both
  out of scope for v2.x.
- **The maintainer-override caveat applies.** Same discipline
  as `ADR-omcp-eb-06-ipc-mesh-revival.md:199-202`: the
  override pattern can be invoked once per gap, not as
  precedent. Do not reuse this deferral as cover for
  shipping arbitrary deferred features without explicit
  re-evaluation against the triggers above.
- **The four shipped ADRs (RG-01..04) are the bound on EB-RG
  scope.** Any future contribution claiming "we should also
  ship gap 5/6 because we did 1-4" must explicitly re-engage
  with the triggers in this ADR; it cannot assert scope
  expansion by inertia.

### Visible in the test pyramid

- No new tests ship with this ADR (deferral has no code).
- The cross-fork fixture in RG-05 (`tests/cross-fork/robin-
  reader-on-our-records.test.ts`, per §5 RG-05 of the plan)
  will surface any compatibility regression that would
  reopen the deferral decision. Specifically: if Robin's
  reader cannot parse our records (P4 schema-additive
  violation), the fixture fails and forces a coordination
  ADR.

## Follow-ups

### Re-evaluation triggers (formal restatement)

1. **Gap 5 re-evaluation trigger A:** tmux on Windows becomes
   real (no signal as of 2026-05-26).
2. **Gap 5 re-evaluation trigger B:** cross-platform expansion
   to Linux/macOS lands in a v3.x release.
3. **Gap 5 re-evaluation trigger C:** user signal requesting
   multi-transport routing arrives (defer-not-cancel pattern).
4. **Gap 6 re-evaluation trigger A:** v3.0 architectural
   revisit puts stateless-verb DNA up for renegotiation; wait
   daemon becomes candidate feature.
5. **Gap 6 re-evaluation trigger B:** user signal requesting
   auto-resume daemon arrives (defer-not-cancel pattern).

### Discipline carryforward

6. The maintainer-override gate-trigger pattern from
   `ADR-omcp-eb-06-ipc-mesh-revival.md:199-202` is NOT
   precedent. Future deferrals require explicit re-evaluation
   against documented triggers — not reuse of the EB-RG arc as
   blanket cover.
7. Cross-fork compatibility (X1 fixture from §5 RG-05) is the
   load-bearing signal for "would the deferral need to reopen
   on a compatibility breakage?" Monitor X1 results across CI
   runs.

### Pattern caveat (matches the discipline ADR-omcp-eb-06 enforces)

This ADR enforces the same discipline that
`ADR-omcp-eb-06-ipc-mesh-revival.md` did for the EB-06 maintainer-
override: **do not reuse the maintainer-override pattern without
explicit user signal.** RG-05 inherits that caveat and applies it
symmetrically to the gap-5 and gap-6 deferrals. The EB-RG arc is
its own override of the EB-06 gate (at the prd.json level); this
ADR is the override of the override — i.e., the explicit boundary
on what EB-RG ships.

## Tracking

- Plan: `.omc/plans/ralplan-robin-gap-closing.md` §1 Principles, §3
  Option A invalidation (gap 5 platform constraints) + §3 Option C
  invalidation (gap 6 stateless-DNA constraint), §5 RG-05 deferred-
  with-rationale framing, §7 ADR-RG-05, change-log rows S1
  (gravity-argument steelman acknowledgment) + S2 (parity-theater
  steelman acknowledgment). The plan file is gitignored; its
  content is reproduced inline in this ADR for durability.
- Architect review iter-1: `.omc/plans/architect-review-rg.md` §3
  "Synthesis: Hybrid B-prime" (the Hybrid B-prime rewrite of RG-02
  is the proof point that mailbox-only suffices for v2.x active
  push, which collapses the multi-transport router's value
  proposition).
- Architect review iter-2: `.omc/plans/architect-review-rg-iter2.md`
  (APPROVE; S1 + S2 acknowledgment verified verbatim).
- Critic review iter-1: `.omc/plans/critic-review-rg.md` §"Steelman
  Acknowledgments (architect raised; plan should fold in)" — both
  steelmen folded into plan §3 with substantive rebuttals.
- Critic review iter-2: `.omc/plans/critic-review-rg-iter2.md`
  (APPROVE; both steelmen verified as applied).
- Implementation: no commit (deferral ADR).
- Cross-reference: ADR-RG-01 through ADR-RG-04 collectively bound
  the EB-RG arc's shipped scope; this ADR bounds what did NOT
  ship.
