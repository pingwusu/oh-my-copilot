# ADR: RG-02 — Priority-Mailbox Push (Hybrid B-prime) + Heartbeat-Freshness Gate

**Date**: 2026-05-26
**Status**: Accepted (EB-RG Story 2 — Hybrid B-prime transport after iter-1 architectural rewrite)
**Author**: pingwusu
**Related**:
- `.omc/plans/ralplan-robin-gap-closing.md` (gitignored; §5 RG-02, §7
  ADR-RG-02, §8 Scenarios A + D, and change-log row A1 together specify
  the Hybrid B-prime transport captured in this ADR — content reproduced
  inline below for durability)
- `docs/adr/ADR-omcp-eb-06-ipc-mesh-revival.md` (Phase 2 IPC mesh
  including the heartbeat freshness contract this ADR's PM-D gate
  consumes)
- `docs/adr/ADR-omcp-eb-05-heartbeat-freshness.md` (defines the
  `HEARTBEAT_FRESHNESS_MULTIPLIER_DEFAULT × HEARTBEAT_INTERVAL_S_DEFAULT
  = 90s` staleness threshold that RG-02's gate reuses)
- `docs/adr/ADR-omcp-rg-01-dispatch-receipt.md` (establishes the
  `producer_fork: "omcp-r2"` cross-fork attribution discipline that
  RG-02's push records consume)
- `docs/adr/ADR-omcp-rg-04-event-log.md` (records push-related event
  kinds when RG-04b instruments this verb)
- Implementation commit: `e291bf3` (`feat(team): RG-02 priority-mailbox
  push (Hybrid B-prime) + heartbeat-freshness gate`)

---

## Context

`EB-omcp-parity-06` shipped a leader→worker IPC mesh built on the
outbox JSONL stream and a 2-second poll cadence in the worker SKILL.
That cadence is sufficient for normal queued work, but a leader cannot
**interrupt** an idle worker faster than the next outbox-read tick.
Robin Norberg's fork addresses this with what he calls "active push"
— a transport-routing layer that tries (in order) a hook callback, an
stdin write to the worker's Copilot CLI process, `tmux send-keys`,
and finally a mailbox-file fallback.

The RALPLAN-DR plan §3 frames the missing capability as **gap 1 of 6**
in Robin's fork comparison: leader-to-worker active push. The v1 plan
attempted to port the second transport (Windows named-pipe stdin write)
because tmux is unavailable on Windows v2.x. Architect iter-1 review
(A1) rejected this approach on two independent architectural grounds.
The C1 critic review (independently) reached the same conclusion. This
rewrite to **Hybrid B-prime** — per-worker priority-mailbox shard with
a 500ms worker poll cadence — is the consensus mitigation, and is the
shape that shipped at commit `e291bf3`.

The Hybrid B-prime transport requires one additional safety gate
introduced by iter-1 critic finding C2 (PM-D): writing a priority
record to a worker whose heartbeat is stale by >90s produces silent
message loss. The gate consults heartbeat freshness before append and
routes to a dead-letter file on staleness failure.

## Decision

**Ship a new `team-push-prompt` verb that writes a priority record to
a per-worker JSONL mailbox shard at
`.omcp/state/team/<sid>/worker-<idx>-push.jsonl`. The team-worker SKILL
polls this shard at a 500ms cadence (between major work checkpoints).
The verb consults the target worker's heartbeat freshness before
append; stale-worker writes route to `dead-letter-push.jsonl` and exit
non-zero. No named-pipe stdin transport. No tmux transport. No
heartbeat schema change.**

Concrete shape:

1. **New verb `team-push-prompt <sid> <worker-idx> <prompt>`** —
   positional argument shape matching the prevailing `team-*`
   convention (`team-heartbeat`, `team-inbox-write`, etc.). The spec
   originally proposed `--worker N --prompt "..."` flag style;
   positional was chosen for consistency. Trivial to flip if the team
   later normalizes on flag style.

2. **Priority-mailbox shard** at
   `.omcp/state/team/<sid>/worker-<idx>-push.jsonl` — one JSONL file
   per worker (sharded by worker index). The file path is
   deterministic (no registry needed) and exists regardless of
   worker liveness. Append-only with the established per-stream
   lockfile primitive (`<shard>.jsonl.lock`, shared with the helper
   extracted in RG-04a).

3. **Worker SKILL poll cadence: 500ms** — between major work
   checkpoints (not as a busy-loop). The SKILL.md gains a
   "Priority-mailbox push poll (v2.3 RG-02)" section and an
   anti-pattern note against polling more than 2 times per second
   (>2/sec wastes CPU on idle workers).

4. **Heartbeat-freshness gate (PM-D mitigation)** — before append,
   the verb reads `.omcp/state/team/<sid>/worker-<idx>-heartbeat.json`,
   computes `now - heartbeat.ts`, and compares against
   `HEARTBEAT_INTERVAL_S_DEFAULT × HEARTBEAT_FRESHNESS_MULTIPLIER_DEFAULT
   = 30s × 3 = 90s` (constants reused from `team-heartbeat.ts:28,31`
   without modification). On staleness:
   - The record routes to
     `.omcp/state/team/<sid>/dead-letter-push.jsonl` (sibling file
     for later inspection).
   - The verb exits with code 5 (matches RG-04a poison-rejection
     convention).
   - No record lands in the live `worker-<idx>-push.jsonl`.

5. **Cross-fork attribution** — every push record carries the
   `producer_fork: "omcp-r2"` field per the ADR-RG-01 contract. Push
   records can also carry an optional `request_id` field for callers
   composing RG-01's `team-wait-receipt` with RG-02's push.

## CRITICAL: Documentation of the Named-Pipe Rejection

The iter-1 v1 plan attempted to deliver active push through a Windows
named-pipe stdin transport — the worker would create a named pipe at
spawn time, register the path in its heartbeat, and the leader's push
verb would `fs.openSync(pipe-path)` and write the prompt directly to
the worker's stdin. Architect iter-1 review (A1) and critic iter-1
review (C1) both flagged this as **unimplementable** on the spawn
model our code already shipped. The rejection is load-bearing for the
rest of this ADR, so it deserves its own treatment here.

The rejection ran along three independent failure paths:

**(a) Detached + unref'd spawn breaks the parent handle.**
`src/cli/commands/team-loop.ts:107-110` declares — and
`team-loop.ts:225-260` implements — a worker spawn pattern of
`detached: true, stdio: 'ignore'` followed by `child.unref()`. The
explicit comment in the source reads: "No long-lived child handles
retained." After the spawn returns, the leader process exits (or
proceeds to spawn the next worker); no parent process holds the
parent end of any pipe across the worker's lifetime. The named-pipe
stdin transport assumes the existence of a long-running parent that
owns the pipe handle — that parent simply does not exist in our
architecture. Restoring it (a "supervisor" that lives as long as the
session) would re-introduce the long-running daemon Robin's bridge
ships and our `ADR-omcp-eb-06-ipc-mesh-revival.md` deliberately
rejected.

**(b) Process stdin is a kernel HANDLE inherited at CreateProcess,
not a filesystem object.** Even if a parent did exist, there is no
Windows API where one process can write to another process's already-
open stdin by path. The `STARTUPINFO::hStdInput` field is set once at
process creation and refers to an `HANDLE` in the kernel object table;
it has no filesystem name. A separate named pipe at a filesystem path
is a separate kernel object — writing to that pipe does not magically
appear at the Copilot CLI's stdin. To redirect Copilot CLI's stdin to
a named pipe, the parent process would have to set up the pipe BEFORE
the spawn, pass the pipe handle through `STARTUPINFO`, and ensure the
Copilot CLI binary actually reads its prompts from stdin (it does
not — it reads from its own internal user-input pipeline). None of
these preconditions hold in our setup.

**(c) Heartbeat schema change is the third hidden dependency.** The
v1 plan implicitly required the worker to register its named-pipe
path somewhere the leader could discover it. The natural place is the
heartbeat file (`worker-<idx>-heartbeat.json`), but that schema is
fixed at `{ts, workerIndex, pid}` per
`src/cli/commands/team-heartbeat.ts:38-42`. Adding a `pipePath` field
would require coordinating the schema bump across the heartbeat
writer, the heartbeat reader (the watchdog), the EB-05 freshness
contract, and Robin's reader (which would need to ignore the field
under P4). Worker restart adds another wrinkle: heartbeat is rewritten
every 30s, so the pipe path could be stale by up to 30s post-restart.
Two concurrent leaders writing to the same pipe interleave bytes when
writes exceed the pipe buffer — a documented Windows failure mode.

Each of these three failures is **independent**: even fixing one
leaves the other two unsolved. The named-pipe transport as designed
in the v1 plan is therefore not a near-miss requiring more engineering
effort; it is incompatible with our spawn model at three orthogonal
layers. Hybrid B-prime resolves all three simultaneously by routing
through a filesystem path the leader can address without any handle
inheritance and without any registry coordination — the price is the
500ms p95 / ~1s p99 latency floor that comes from poll-cadence
delivery rather than direct stdin landing.

This rejection sets a hard precedent for v2.x: **no transport that
requires the leader to hold a kernel handle into a worker process
will ship in this release line.** Future revisits in v3.x are scoped
in the Follow-ups section below.

## Drivers (top 3)

1. **Stateless-verb DNA must survive (Principle 1).** Hybrid B-prime
   delivers active push through filesystem IPC alone — no kernel
   handles, no long-running parent. Each invocation of
   `team-push-prompt` reads heartbeat, checks freshness, appends one
   record, exits. The worker's SKILL poll is the symmetric short-task
   on the other side. Driver pinned the priority-mailbox shape over
   any handle-passing scheme.

2. **Windows-only constraint (Driver 3 from plan §2).** v2.x targets
   Windows exclusively. Robin's multi-transport router has three
   transports unavailable on our platform: tmux send-keys (no tmux),
   prompt_stdin write (per the named-pipe rejection above), and
   hook callback (requires Robin's MCP bridge supervisor). The only
   transport that works on bare Windows + Copilot CLI is the mailbox
   file. Driver pinned mailbox-only as the v2.x active push transport.

3. **Silent message loss to crashed workers (PM-D / C2).** Without a
   liveness gate, a leader pushing to a dead worker silently succeeds
   at the file-write level but never gets the message consumed. The
   leader has no way to distinguish "worker received but slow to
   ack" from "worker crashed; message lost forever." Driver pinned
   the heartbeat-freshness gate as a pre-write check that converts
   silent loss into a visible non-zero exit + dead-letter file
   inspection point.

## Alternatives Considered

### Option A — Windows named-pipe stdin transport (REJECTED — see CRITICAL section above)

- **Scope**: worker creates a named pipe at spawn; pipe path
  registered in heartbeat; leader writes prompt to the pipe; pipe
  writes appear at the worker's stdin.
- **Pros**: theoretical "immediate landing" with sub-poll latency;
  matches Robin's `prompt_stdin` transport conceptually.
- **Cons**: not implementable on our spawn model (three independent
  failures: detached+unref'd parent has no handle to register;
  stdin is a kernel HANDLE not a filesystem path; heartbeat schema
  change has its own cascade of dependencies). See full treatment
  above.
- **Rejection rationale**: architect A1 and critic C1 verdicts
  (consensus). Restoring the parent process to retain a stdin
  handle would re-introduce the long-running daemon stateless-verb
  DNA forbids.

### Option B — tmux `send-keys` (rejected at design time)

- **Scope**: spawn workers inside tmux panes; leader pushes prompts
  via `tmux send-keys <pane> <text>`.
- **Pros**: Robin's fork uses this on Linux/macOS; gives sub-poll
  latency; well-tested transport.
- **Cons**: no tmux on Windows v2.x. Windows Terminal does not
  expose a `send-keys` equivalent that survives across detached
  processes. WSL is excluded from our target audience (Copilot CLI
  runs natively on Windows).
- **Rejection rationale**: platform unavailability is hard, not
  soft. v3.x with Linux/macOS support may revisit (Follow-ups #2).

### Option C — Long-running stdin holder process (rejected)

- **Scope**: keep the leader (or a per-session supervisor) alive as
  long as the worker, with the parent end of a pipe held open. Same
  end goal as Option A but with the parent process retained.
- **Pros**: stdin transport becomes architecturally viable;
  unambiguously delivers the "immediate landing" UX.
- **Cons**: violates Principle 1 (stateless-verb DNA reversal). Adds
  Windows supervisor lifecycle problems (orphan cleanup, crash
  recovery) — the same blockers `ADR-omcp-eb-06-ipc-mesh-revival.md`
  documented at v2.0. Same scope as Option A from the RG-01 ADR's
  alternative ladder.
- **Rejection rationale**: stateless DNA reversal requires v3.0
  ADR, not an EB-RG story.

### Option D — Polling-only (no priority shard) (rejected)

- **Scope**: accept the existing outbox 2-second poll cadence as the
  best we can deliver. Document the gap as out-of-scope.
- **Pros**: zero new code; zero new verbs.
- **Cons**: 2-second p50 latency for active push is noticeably worse
  than Robin's sub-second offerings. Driver 1 (user-visible delivery
  gap) remains unaddressed. Parity-theater steelman (S2) cuts both
  ways — RG-02 is cheap insurance, but the insurance is concretely
  measurable as a latency improvement.
- **Rejection rationale**: §3 Option C invalidation in the plan.
  Cheap insurance is still insurance.

### Option E — Heartbeat schema change for transport metadata (rejected)

- **Scope**: extend `worker-<idx>-heartbeat.json` schema with
  `transport: { kind, address }` so the leader can choose between
  transports based on what the worker registered.
- **Pros**: enables the multi-transport routing Robin's fork
  provides as a v3.x growth path.
- **Cons**: forces a schema bump in v2.x that the v2.x transport
  choices (mailbox only) do not require. Iter-1 architect A1
  explicitly called this out as a "third implicit dependency RG-02
  takes on, unmentioned in §5" of the v1 plan.
- **Rejection rationale**: P4 (schema-additive) holds for fields we
  actually need; we should not add fields for transports we cannot
  ship. Heartbeat schema stays at `{ts, workerIndex, pid}` for v2.x.

## Why Hybrid B-prime Chosen

- **Architecturally viable on our spawn model.** Filesystem IPC alone;
  no kernel handles; no parent retention; no registry. Each
  invocation of `team-push-prompt` is a short-lived verb that exits
  after one append.
- **Cuts LoC by ~55% vs v1 plan.** Iter-1 plan estimated ~370 LoC for
  the named-pipe transport. Hybrid B-prime ships at ~165 LoC for the
  verb + ~120 LoC of tests at commit `e291bf3`. Single-file delta
  well under the 1,200-LoC cap.
- **Eliminates Pre-mortem Scenario A entirely.** Scenario A (worker
  crash before first heartbeat leaves pipe unregistered) is moot —
  there is no pipe and no registration. The mailbox path is
  deterministic and exists regardless of worker liveness.
- **Latency trade is acceptable.** 500ms p95 / ~1s p99 vs Robin's
  hypothetical "immediate stdin landing." For interactive
  multi-worker workflows, 500ms is well below human perception
  thresholds and well above the variance in Copilot CLI's own
  response times.
- **PM-D mitigation composes cleanly.** Heartbeat-freshness gate is
  a pre-write check; no in-process state; no daemon. The dead-letter
  file is observable by `team-event-health-check` (RG-05).

## Consequences

### Visible to users

- New verb `omcp team-push-prompt <sid> <worker-idx> <prompt>` at
  the CLI. Returns exit 0 on success, exit 5 on stale worker
  (writes to dead-letter), exit 2 on bad argv.
- 500ms latency floor on push delivery — observable as a noticeable
  pause between `team-push-prompt` returning and the worker acting
  on the prompt. This is a deliberate trade vs the unimplementable
  "immediate landing" alternative.
- Workers gain a new SKILL section instructing them to poll
  `worker-<idx>-push.jsonl` between major work checkpoints.

### Visible to operators

- Per-worker push shard at
  `.omcp/state/team/<sid>/worker-<idx>-push.jsonl`. Subject to the
  same per-stream-lock + 1MB rotation discipline as RG-03 / RG-04a
  (rotation policy is a v3.x follow-up; see #1).
- Dead-letter file at
  `.omcp/state/team/<sid>/dead-letter-push.jsonl` whose non-empty
  state indicates at least one stale-worker push attempt. RG-05's
  `team-event-health-check` verb surfaces non-empty dead-letter as
  a health flag (iter-2 architect §3.3).
- Per-worker push shard adds file-system pressure proportional to
  worker count. 5 workers × push shard = 5 additional JSONL streams
  per session beyond the existing outbox + inbox + heartbeat +
  events + conflicts streams. Total ~10 streams in active 5-worker
  sessions; lockfile churn is bounded by the per-stream-lock
  acquire-ms-p95 contract from RG-04a.

### Visible to maintainers

- Worker SKILL.md gains a "Priority-mailbox push poll (v2.3 RG-02)"
  section. SKILL evolution discipline applies — workers shipping
  with pre-v2.3 SKILL.md do not poll the push shard and silently
  miss priority records. This is acceptable for the v2.3 release
  cadence (SKILL is bundled with the binary) but worth documenting.
- The `team-push-prompt` verb does NOT accept a `--via stdin` flag.
  Grep + 5 regex assertions in the test suite verify the named-pipe
  transport is absent from the codebase. Future contributors
  attempting to revive the rejected transport will trip the test.
- The `e291bf3` commit also synced the plugin mirror
  (`plugins/oh-my-copilot/`) per the canonical mirror invariant.

### Visible in the test pyramid

- 21 new vitest cases in `src/__tests__/team-push-prompt.test.ts`
  covering: happy path, stale-worker dead-letter, NO stdin flag
  exists (grep + 5 regex assertions), no heartbeat schema change,
  producer_fork stamping, CLI wrapper validation.
- 8 existing CLI-wiring-invariants tests continue to pass.
- Smoke row `push-prompt-priority` is DEFERRED to RG-05 per architect
  A5 distributed-smoke contract (consistent with RG-01).

## Follow-ups

1. Push-shard rotation policy at 1MB analogous to RG-03/RG-04a.
   Iter-2 critic implicitly accepted the deferral; rotation is
   load-bearing only for long-running sessions.
2. Revisit named-pipe transport in v3.x **only if** (a) the spawn
   model evolves to retain a parent handle (would require a v3.0
   stateless-verb DNA revisit) OR (b) Windows IPC primitives evolve
   (no signal of this as of 2026-05-26). Default assumption: never.
3. Revisit tmux transport in v3.x **only if** tmux on Windows becomes
   real OR cross-platform expansion lands. Until then, mailbox-only.
4. Multi-transport routing (Robin's hook/prompt_stdin/tmux_send_keys/
   mailbox fallback) is deferred to v3.x per
   `ADR-omcp-rg-05-deferred-gaps.md`. No transport-selection logic
   ships in v2.x — the verb has exactly one path.
5. RG-04b instrument-push-prompt commit will wire `team-event-append`
   into this verb. The instrumentation lands as a separate commit so
   reverting RG-02 also reverts its instrument patch.
6. Verb argument shape (positional vs flag) — current `<sid>
   <worker-idx> <prompt>` matches the prevailing convention; flip
   to `--worker N --prompt "..."` is trivial if the team
   re-normalizes.

## Tracking

- Plan: `.omc/plans/ralplan-robin-gap-closing.md` §1 Principles, §3
  Option B + Option A invalidation, §5 RG-02, §7 ADR-RG-02, §8
  Pre-mortem Scenarios A (obsolete-but-documented) + D, change-log
  row A1 (the iter-1 architectural rewrite). The plan file is
  gitignored; its content is reproduced inline in this ADR for
  durability.
- Architect review iter-1: `.omc/plans/architect-review-rg.md` §2
  "Unresolved tradeoff tension: RG-02's stdin pipe registry vs
  stateless-verb DNA" (the load-bearing rejection).
- Architect review iter-2: `.omc/plans/architect-review-rg-iter2.md`
  (APPROVE; A1 applied verbatim).
- Critic review iter-1: `.omc/plans/critic-review-rg.md` C1 (CRITICAL
  finding aligning with architect A1) + PM-D (heartbeat-freshness
  gate addition).
- Critic review iter-2: `.omc/plans/critic-review-rg-iter2.md`
  (APPROVE).
- Implementation: `e291bf3` (RG-02 priority-mailbox push). Test
  count: 21 new + 8 CLI-wiring tests preserved = 29/29 green.
