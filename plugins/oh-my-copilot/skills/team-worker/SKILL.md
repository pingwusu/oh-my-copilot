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
   to you and mark it `in_progress`.

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
2. Run:
   ```
   omcp team-ack $OMCP_TEAM_SESSION_ID $OMCP_TEAM_WORKER_INDEX
   ```
3. Exit gracefully.

The orchestrator waits up to 30 seconds for your ack before falling back to
SIGTERM. Acking promptly lets the team transition to `completed` instead of
`failed`.

## Rules

- Never dispatch sub-agents or use team-spawning commands
- Never run tmux orchestration commands
- Always use absolute file paths
- Always report progress to `team-lead` via messages
- Never fabricate `request_id` values in shutdown responses
