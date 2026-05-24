# Team Shutdown Protocol (L2.7)

This document describes the two-phase graceful shutdown protocol used by
`omcp team` to stop worker processes cleanly.

## Overview

When the orchestrator wants to stop a team session it:

1. Writes `.omcp/state/team/<sessionId>/shutdown-request.json`
2. Waits up to `OMCP_TEAM_SHUTDOWN_WAIT_MS` (default 30 s) for each worker
   to write its own `worker-K-ack.json`
3. Falls back to `SIGTERM` (via `stopTeam`) for any worker that did not ack
   within the timeout

## Worker responsibility

A worker running as part of a team session MUST poll for the shutdown-request
marker on each turn or task boundary and, when found, perform any cleanup
before calling the ack verb:

```
omcp team-ack <sessionId> <workerIndex>
```

After the command exits 0 the worker should stop accepting new work and exit.

## `omcp team-ack` reference

```
omcp team-ack <session-id> <worker-index>
```

| Argument        | Description                                                   |
| --------------- | ------------------------------------------------------------- |
| `session-id`    | The UUID or slug that identifies the team session. Must pass  |
|                 | `assertSafeSlug` (alphanumeric + `_-.`, 1-80 chars, no `/`). |
| `worker-index`  | Non-negative integer identifying this worker (0-based or      |
|                 | 1-based, matching the index used during spawn).               |

Exit codes:

| Code | Meaning                                         |
| ---- | ----------------------------------------------- |
| 0    | Ack file written successfully                   |
| 1    | Unexpected I/O error                            |
| 2    | Invalid input (`session-id` or `worker-index`)  |

The ack file written is:

```
.omcp/state/team/<sessionId>/worker-<workerIndex>-ack.json
```

Content:

```json
{
  "workerIndex": 2,
  "ackedAt": "2026-05-24T10:00:00.000Z"
}
```

The command is **idempotent** — calling it a second time merely overwrites
the ack file with a fresh timestamp. This is safe in retry scenarios.

## Skill integration

Skills that run as team workers should include instructions similar to:

> At the start of each turn check whether
> `.omcp/state/team/<SESSION_ID>/shutdown-request.json` exists. If it does,
> complete the current atomic unit of work, then run:
>
> ```
> omcp team-ack <SESSION_ID> <WORKER_INDEX>
> ```
>
> and stop processing new tasks.

`SESSION_ID` and `WORKER_INDEX` are provided via the prompt injected by
`omcp team` when it spawns each worker.

Note: the `skills/ralph/SKILL.md` skill was intentionally not modified
because ralph is a general-purpose skill used outside team contexts. Teams
that need the shutdown protocol should use a dedicated team-worker skill or
inject these instructions via the `omcp team` task prompt.

## Files

| File                                                          | Role                        |
| ------------------------------------------------------------- | --------------------------- |
| `src/cli/commands/team-ack.ts`                                | CLI verb implementation     |
| `src/cli/commands/__tests__/team-ack.test.ts`                 | Unit tests                  |
| `src/cli/omcp.ts`                                             | CLI registration            |
| `src/cli/commands/team.ts` (`shutdownTeam`)                   | Orchestrator side (reads ack)|
