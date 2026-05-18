---
name: ultragoal
description: Create and execute durable repo-native multi-goal plans tracked in .omcp/ultragoal/.
level: senior
model:
  claude: claude-sonnet-4.6
  gpt:    gpt-5.2
triggers:
  - "ultragoal"
  - "create goals"
  - "complete goals"
  - "durable multi-goal planning"
  - "multi-step plan with checkpoints"
---

# Ultragoal Workflow

Use when the user asks for `ultragoal`, `create-goals`, `complete-goals`, durable multi-goal
planning, or sequential execution over checkpointed goals.

## Purpose

`ultragoal` turns a brief into repo-native artifacts and then drives stories to completion
with mandatory final quality gates. omcp tracks G001/G002 story progress in a durable ledger.

Artifacts written under the repo root:

- `.omcp/ultragoal/brief.md`
- `.omcp/ultragoal/goals.json`
- `.omcp/ultragoal/ledger.jsonl`

## Create goals

1. Run one of:
   - `omcp ultragoal create-goals --brief "<brief>"`
   - `omcp ultragoal create-goals --brief-file <path>`
   - `cat <brief> | omcp ultragoal create-goals --from-stdin`
   - `omcp ultragoal create-goals --codex-goal-mode per-story --brief "<brief>"` only when one story per goal is explicitly preferred
2. Inspect `.omcp/ultragoal/goals.json` and refine if needed.

## Complete goals

Loop until `omcp ultragoal status` reports all goals complete:

1. Run `omcp ultragoal complete-goals`.
2. Read the printed handoff — it names the active goal and its objective.
3. Work only the named story until its completion audit passes.
4. Checkpoint the durable ledger:
   `omcp ultragoal checkpoint --goal-id <id> --status complete --evidence "<evidence>"`
5. If blocked or failed, checkpoint failure:
   `omcp ultragoal checkpoint --goal-id <id> --status failed --evidence "<blocker/evidence>"`
6. Resume failed goals with `omcp ultragoal complete-goals --retry-failed`.

## Use Ultragoal and /fleet together

Use ultragoal and `/fleet` together for a durable story that benefits from parallel execution.
Ultragoal remains leader-owned: `.omcp/ultragoal/goals.json` stores the plan and
`.omcp/ultragoal/ledger.jsonl` stores checkpoints. `/fleet` is the parallel execution engine
and returns task/evidence status to the leader.

Workers do not own ultragoal goal state and do not checkpoint Ultragoal directly.
The leader checkpoints from fleet evidence:

```sh
omcp ultragoal checkpoint --goal-id <id> --status complete --evidence "<fleet evidence mentioning <id>>"
```

## Mandatory final cleanup and review gate

The final ultragoal story is not complete until the active agent has run the final quality gate:

1. Run targeted verification for the story.
2. Run `/oh-my-copilot:ai-slop-cleaner` on changed files only; if there are no relevant edits,
   the cleaner still runs and records a passed/no-op report.
3. Rerun verification after the cleaner pass.
4. Run `/oh-my-copilot:requesting-code-review`. Clean means `recommendation: "APPROVE"` and
   `architectStatus: "CLEAR"`; `COMMENT`, `WATCH`, `REQUEST CHANGES`, and `BLOCK` are non-clean.
5. If review is non-clean, do **not** checkpoint complete. Record durable blocker work instead:

   ```sh
   omcp ultragoal record-review-blockers --goal-id <id> --title "Resolve final code-review blockers" --objective "<blocker-resolution objective>" --evidence "<review findings>"
   ```

   This marks the current story `review_blocked`, appends a pending blocker-resolution story,
   and lets `omcp ultragoal complete-goals` start the blocker next.

6. If review is clean, checkpoint with a structured final gate:

   ```sh
   omcp ultragoal checkpoint --goal-id <id> --status complete --evidence "<tests/files/review evidence>" --quality-gate-json <quality-gate-json-or-path>
   ```

`--quality-gate-json` must include:

```json
{
  "aiSlopCleaner": { "status": "passed", "evidence": "cleaner report" },
  "verification": { "status": "passed", "commands": ["npm test"], "evidence": "post-cleaner verification" },
  "codeReview": { "recommendation": "APPROVE", "architectStatus": "CLEAR", "evidence": "final review synthesis" }
}
```

## Constraints

- Never call `omcp ultragoal checkpoint --status complete` on the final story without
  passing `--quality-gate-json` with APPROVE + CLEAR evidence.
- Treat `ledger.jsonl` as the durable audit trail; checkpoint after every success or failure.
- State is persisted to `.omcp/ultragoal/` — survives context compaction and session restarts.
- `omcp ultragoal` is a mutually-exclusive mode; starting it while ralph/autopilot/ultrawork/ultraqa
  is active will be rejected by the mode-state guard.
