---
name: loop
description: Run a prompt or slash command on a recurring interval (e.g. /oh-my-copilot:loop 5m /oh-my-copilot:status). Backed by the omcp-loop MCP server + watcher daemon.
triggers:
  - "loop"
  - "every"
  - "recurring"
  - "schedule"
  - "poll"
model:
  claude: claude-sonnet-4.6
  gpt: gpt-5.2-codex
level: 2
---

<Purpose>
The `loop` skill registers a recurring task with the `omcp-loop` MCP server. A
companion watcher process (`scripts/omcp-loop-watcher.mjs`) polls the queue
and spawns `copilot -p "<prompt>" --allow-all-tools` for any due entry.

This mirrors omc's `/loop` skill (which uses Claude Code's scheduled-wakeup primitive
tool). Copilot CLI has no equivalent built-in tool, so omcp implements it
with: an MCP scheduling server (in-session API) + an external watcher
daemon (out-of-session executor).
</Purpose>

<Use_When>
- The user wants to **set up a recurring task** ("check the deploy every 5 minutes")
- The user wants to **poll for status** ("keep refreshing until X passes")
- The user wants to **run a slash command on an interval** ("/loop 30m /oh-my-copilot:ralph 'reduce flakiness'")

Do NOT use for **one-off** tasks. Do NOT use for **immediate** loops where
`omcp ralph` or `omcp autopilot` is sufficient (those run continuously in a
single session; `/loop` is for cross-session recurrence).
</Use_When>

<Steps>

## 1. Parse the user's input

Expected forms:
- `5m <prompt>` — every 5 minutes
- `30s <prompt>` — every 30 seconds
- `1h <slash-command>` — every hour
- `<prompt>` (no interval) — model self-paces via a default 10-minute interval

Convert interval to milliseconds: ms / s / m / h → number.

## 2. Schedule via the omcp-loop MCP server

Call the `loop_schedule` tool on the `omcp-loop` MCP server:

```json
{
  "taskId": "<short-slug-from-prompt>",
  "intervalMs": 300000,
  "prompt": "<the user's prompt or slash command>",
  "sessionId": "<current session id, if available>"
}
```

If the MCP server returns `ok: true`, confirm to the user with the scheduled
`nextFireAt` time.

## 3. Ensure the watcher daemon is running

The watcher (`scripts/omcp-loop-watcher.mjs`) must be running for entries to
actually fire. Check via `omcp loop-watcher --status`. If not running, advise
the user to start it:

```bash
nohup node $(omcp __plugin_root)/scripts/omcp-loop-watcher.mjs > /tmp/omcp-loop-watcher.log 2>&1 &
```

(or platform-equivalent). The watcher polls every 5 seconds by default
(`OMCP_LOOP_POLL_MS` overrides).

## 4. Cancellation

To cancel a single loop entry: invoke `loop_cancel` with the `taskId`. To
cancel all: invoke `loop_cancel_all`. The watcher also exits on
`DISABLE_OMCP=1` or SIGINT/SIGTERM.

## 5. Output

Report to the user:
- `taskId`
- `intervalMs`
- `prompt`
- `nextFireAt`
- watcher status
- cancellation instructions (`/oh-my-copilot:loop cancel <taskId>`)

</Steps>

<Tool_Usage>
- Call MCP tools on the `omcp-loop` server: `loop_schedule`, `loop_list_pending`, `loop_check_due`, `loop_cancel`, `loop_cancel_all`, `loop_mark_fired`
- Use Bash to start/stop the watcher daemon
- Use the `omcp loop-watcher` CLI subcommand for friendly start/status/stop
</Tool_Usage>

<Examples>
<Good>
User: `/oh-my-copilot:loop 5m /oh-my-copilot:status`

→ omcp calls `loop_schedule(taskId="status-check", intervalMs=300000, prompt="/oh-my-copilot:status")`.
→ Confirms watcher is running.
→ Replies: "Scheduled. Next fire at 14:35:00 UTC. Cancel with `/oh-my-copilot:loop cancel status-check`."
</Good>

<Good>
User: `loop poll the CI build until it finishes`

→ Asks user one question: what interval? (30s vs 2m vs 5m)
→ Schedules with the chosen interval and prompt "/oh-my-copilot:ask claude 'is the CI build done?'"
</Good>

<Bad>
Looping a destructive command:
```
loop 1m /destroy-prod
```
Why bad: never schedule destructive recurring commands. Warn the user, decline.
</Bad>
</Examples>

<Final_Checklist>
- [ ] Interval parsed and converted to ms
- [ ] loop_schedule call made with valid taskId/intervalMs/prompt
- [ ] Watcher running confirmed (or instructions given)
- [ ] User informed of nextFireAt + cancel instructions
- [ ] State entry persists across context compactions (verify via loop_list_pending)
</Final_Checklist>
