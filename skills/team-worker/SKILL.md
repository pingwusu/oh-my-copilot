---
name: team-worker
description: Protocol for agents spawned as team workers — task claiming, shutdown ack, and work rules
aliases: []
level: 3
model:
  claude: claude-sonnet-4.6
  gpt: gpt-5.2-codex
---

# Team Worker Protocol

You have been spawned as a worker in an omcp team. Your session carries two
environment variables that identify your role:

- `OMCP_TEAM_SESSION_ID` — the team session UUID
- `OMCP_TEAM_WORKER_INDEX` — your worker number (1-based integer)

If these variables are not set, you were not spawned as a team worker. Skip
this document entirely.

## Work loop

1. **Claim**: Check the `/tasks` board for tasks assigned to your worker name
   (`worker-$OMCP_TEAM_WORKER_INDEX`). Pick the first `pending` task assigned
   to you and mark it `in_progress`. You SHOULD also signal the corresponding
   TeamState status AND write a heartbeat:
   ```
   omcp team-ack $OMCP_TEAM_SESSION_ID $OMCP_TEAM_WORKER_INDEX --status in_progress
   omcp team-heartbeat $OMCP_TEAM_SESSION_ID $OMCP_TEAM_WORKER_INDEX
   ```
   The ack is non-load-bearing for the verify/fix loop. The heartbeat IS the
   primary liveness signal (v2.2 EB-06 Phase 2 IPC mesh per ADR-EB-05).
   `runTeamWatchdog` reads `worker-<idx>-heartbeat.json`'s `ts` field as the
   freshness signal; default threshold = 30s interval × 3 = 90s. If you skip
   the heartbeat, the watchdog falls back to shard-mtime (back-compat) but
   surfaces a `[watchdog] worker-N not heartbeating` warning after 2× interval.

   **Heartbeat cadence**: call `omcp team-heartbeat` once at task start +
   between major checkpoints. Do NOT heartbeat in a hot loop (each call is
   a subprocess spawn).

   **Inbox check**: poll for leader messages via:
   ```
   omcp team-outbox-read $OMCP_TEAM_SESSION_ID worker-$OMCP_TEAM_WORKER_INDEX --json
   ```
   The cursor advances per-consumer so each worker has its own independent
   read pointer. Use `--json` for machine-readable parsing inside scripts.

2. **Work**: Execute the task using available file and shell tools.
   Do not spawn sub-agents or delegate. Work directly.

3. **Complete**: When done, mark the task `completed`.

4. **Report**: Send a message to `team-lead` summarising what was done.

5. **Next**: Check for more tasks. If none remain, notify the lead that you
   are standing by.

6. **Shutdown**: Follow the shutdown protocol below.

## Team worker shutdown protocol

The orchestrator signals shutdown by writing
`.omcp/state/team/$OMCP_TEAM_SESSION_ID/shutdown-request.json`.

Poll for this file at each major checkpoint (after completing a task, before
picking up the next one, and on each Stop event).

When the file exists:

1. Finish any work that is safe to stop at — do not leave a task half-written
   or a file in an inconsistent state.
2. Write a completion message to the outbox so consumers (chain runner,
   verify-collect loop, ralph monitor) see your final result:
   ```
   omcp team-outbox-write $OMCP_TEAM_SESSION_ID worker-$OMCP_TEAM_WORKER_INDEX \
     "$(cat <<'JSON'
   {"event":"task_completed","tasks_completed":N,"final_status":"completed"}
   JSON
   )"
   ```
   Outbox writes share a hand-rolled lockfile so concurrent worker writes
   serialize safely (per ADR-omcp-eb-02). Lines are capped at 64KB; the
   helper truncates oversized payloads with a `truncated:true` marker.
3. Run the ack-with-status command appropriate to your final state:
   - **Work completed successfully** before shutdown was requested:
     ```
     omcp team-ack $OMCP_TEAM_SESSION_ID $OMCP_TEAM_WORKER_INDEX --status completed
     ```
   - **Work failed or was abandoned** (e.g., a task threw an unrecoverable error):
     ```
     omcp team-ack $OMCP_TEAM_SESSION_ID $OMCP_TEAM_WORKER_INDEX --status failed
     ```
   - **No tasks were yet assigned** but shutdown arrived:
     ```
     omcp team-ack $OMCP_TEAM_SESSION_ID $OMCP_TEAM_WORKER_INDEX --status pending
     ```

   The `--status` flag (v2.1 N+2 Story 7) updates `TeamState.workers[K].status`
   atomically before writing the ack JSON. Omitting `--status` falls back to
   the legacy ack-only path (back-compat with v2.0 workers).
3. Exit gracefully.

The orchestrator waits up to 30 seconds for your ack before falling back to
SIGTERM. Acking promptly lets the team transition to `completed` instead of
`failed`, and the explicit status surface lets `omcp status` and the chain
handoff snapshot (`omcp ralplan --chain`) record your final disposition for
postmortem inspection.

> **Note (v2.1 N+2)**: No `omcp team-heartbeat` reference appears in this
> protocol. The Phase 2 IPC primitives (heartbeat / outbox / inbox) are
> deferred behind EB-omcp-parity-06 (gated on ≥1 external user reporting
> IPC mesh as a workflow blocker). Until that signal fires, the
> ack-with-status + watchdog mtime probe pair is the canonical
> liveness contract. See `docs/plans/omcp-team-omc-parity-iter2.md`
> Appendix B for the deferred IPC stories.

## Rules

- Never dispatch sub-agents or use team-spawning commands
- Never run tmux orchestration commands
- Always use absolute file paths
- Always report progress to `team-lead` via messages
- Never fabricate `request_id` values in shutdown responses

## v2.2 IPC anti-patterns (EB-06)

- **Do NOT heartbeat in a hot loop.** Each `omcp team-heartbeat` call spawns
  a Node subprocess (~50ms). Calling it more than once per ~10s per worker
  is wasteful — the default 30s interval × 3 freshness threshold (90s)
  gives plenty of headroom.
- **Do NOT outbox-write inside the verify-fix inner loop without
  rate-limiting.** A worker that emits an outbox entry per fix attempt
  during a runaway loop can saturate the per-session lockfile with
  4+ second backoff exhaustion windows. Cap outbox-write frequency at
  ~1 per task completion / ~1 per major checkpoint.
- **Do NOT consume the outbox cursor as `worker-K-foo` then ALSO as
  `worker-K-bar` from a different process.** Cursors are per-consumer;
  use one consumer name per logical reader so the cursor advances
  consistently.
- **Do NOT exceed 64KB per outbox line.** The helper truncates oversized
  payloads, but consumers parsing the truncated string get a `payload`
  field that won't round-trip as the original JSON. If you need to ship
  a large object, write a sentinel pointer to a file under
  `.omcp/state/team/<sid>/` instead and reference its path in the
  outbox entry.
