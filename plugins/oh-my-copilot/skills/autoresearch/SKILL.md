---
name: autoresearch
description: Long-horizon autonomous research that improves the project against a measurable evaluator until the goal is met or budget exhausted
argument-hint: "--mission \"<mission>\" --eval \"<evaluator>\" [--keep-policy <policy>] [--slug <slug>]"
triggers:
  - "autoresearch"
  - "research goal"
  - "long horizon"
  - "evaluator"
pipeline: [autoresearch]
handoff: .omcp/state/autoresearch/<slug>/
model:
  claude: claude-opus-4.7
  gpt: gpt-5.4
level: 4
---

<Purpose>
Autoresearch is the long-horizon companion to `ralph`. Where ralph drives a
PRD to passing acceptance criteria within a single working session,
autoresearch sets a **mission** (what to improve) and an **evaluator** (how to
measure improvement), then iterates indefinitely — re-launching the team
loop, recording each generation's evaluator score, keeping the best
artifacts, and stopping when the score plateaus or budget is exhausted.

omcp's autoresearch mirrors omx's `omx autoresearch` runtime: a detached
tmux session executes the loop while the host shell returns; user later
runs `omcp autoresearch status <slug>` or attaches to the tmux session.
</Purpose>

<Use_When>
- "Improve test pass rate from 75% to 95% over the next 6 hours"
- "Reduce p99 latency from 220ms to under 100ms"
- "Beat the current ELO of the strategy on the eval suite"
- "Make the linter pass on the whole repo, however many iterations it takes"
- Any goal that has a **numeric evaluator** the agent can re-run to score itself
</Use_When>

<Do_Not_Use_When>
- The goal is binary "done / not done" — use `ralph` instead
- The user wants a one-shot answer — use `ask` / `exec`
- No automated evaluator exists — the loop has nothing to climb against; ask the user to define one first
</Do_Not_Use_When>

<Required_Arguments>
- `--mission "<text>"` — natural-language description of what to improve
- `--eval "<command>"` — shell command that prints a numeric score on stdout (higher is better unless `--minimize`)
- `--slug <name>` — short kebab-case identifier (defaults to first 3 words of mission)
- `--keep-policy <policy>` — `best` (default, keep best artifact only) | `pareto` (keep frontier across multiple metrics) | `all`
- `--budget <iterations>` — hard iteration cap (default 30)
- `--minimize` — flip score direction (lower is better)
</Required_Arguments>

<Steps>

## Phase 1: Setup

1. Parse arguments. Reject if `--mission` or `--eval` missing.
2. Establish working dir: `.omcp/state/autoresearch/<slug>/`
3. Validate the evaluator by running it once on the current tree; record `baseline_score`.
4. Initialize state via the `omcp-state` MCP server:
   - mode: `autoresearch`
   - state.mission, state.eval, state.slug, state.baseline_score, state.best_score, state.iteration=0, state.budget, state.best_artifact_path

## Phase 2: Detach into tmux session

Spawn `tmux new-session -d -s omcp-autoresearch-<slug>` running the loop body. Return the session name to the user so they can `tmux attach -t omcp-autoresearch-<slug>` to observe.

If tmux unavailable, fall back to a detached background process logged to `.omcp/state/autoresearch/<slug>/output.log`.

## Phase 3: Loop body (inside tmux session)

Each iteration:

1. Read current best artifact from `.omcp/state/autoresearch/<slug>/best/`
2. Dispatch a `/oh-my-copilot:team` run targeting the mission, seeded with the prior best as context
3. After the team completes, run the evaluator command. Capture stdout as `current_score`.
4. Score comparison:
   - If `current_score` improves over `best_score` (per `--minimize`): copy the diff'd files to `.omcp/state/autoresearch/<slug>/best/`, update state, append to `.omcp/state/autoresearch/<slug>/history.jsonl`
   - Else: discard the candidate
5. Append iteration record (timestamp, score, files-changed) to history.jsonl
6. Check stop conditions:
   - `iteration >= budget` → stop
   - `best_score` unchanged for `--plateau-window` iterations (default 5) → stop
   - `omcp cancel` marker present → stop
7. Otherwise loop.

## Phase 4: Status / attach / cancel

External commands (not part of the skill itself; documented for the user):

- `omcp autoresearch status <slug>` — read state + last N history entries
- `omcp autoresearch attach <slug>` — tmux attach
- `omcp autoresearch cancel <slug>` — write cancel marker, watcher exits

## Phase 5: Wrap-up

When loop exits:
- Final report written to `.omcp/state/autoresearch/<slug>/report.md` with: baseline / final / improvement %, iteration count, time spent, top 3 winning iterations + their diffs
- Best artifact at `.omcp/state/autoresearch/<slug>/best/` is the deliverable
- User decides whether to merge / cherry-pick into mainline

</Steps>

<Tool_Usage>
- `omcp-state` MCP tools for run state persistence
- `omcp-trace` MCP tools for per-iteration evidence/score logging
- `/oh-my-copilot:team` for parallel team execution each iteration
- `omcp cancel` writes the cancel marker
- Bash for evaluator command execution
- Use `tmux` when available; document the detached fallback explicitly when not
</Tool_Usage>

<Examples>
<Good>
User: `/oh-my-copilot:autoresearch --mission "raise test pass rate to 95%" --eval "npm test 2>&1 | grep -oE '[0-9]+ passed' | awk '{print \$1}'" --slug raise-coverage --budget 20`

→ Validates evaluator (current: 187 passed, score = 187).
→ Detaches into tmux session `omcp-autoresearch-raise-coverage`.
→ Each iteration dispatches `/oh-my-copilot:team 4:executor "improve failing tests"` and re-runs the evaluator.
→ Best score climbs: 187 → 198 → 211 → 224 …
→ Final report at iteration 17 (plateau): 187 → 234 (+25%). Best diff at `.omcp/state/autoresearch/raise-coverage/best/`.
</Good>

<Bad>
User: "make the code better"
→ No evaluator. Skill should refuse and tell the user to provide `--eval` first.
</Bad>
</Examples>

<Final_Checklist>
- [ ] `--mission` and `--eval` provided
- [ ] Evaluator validated against current tree (returns a numeric score)
- [ ] Detached into tmux (or documented fallback) — main shell did not block
- [ ] State persisted via the `omcp-state` MCP server with mode=autoresearch
- [ ] Each iteration appends to history.jsonl with timestamp + score
- [ ] Score-direction respected (`--minimize` flips comparison)
- [ ] Stop conditions wired: budget, plateau, cancel marker
- [ ] Wrap-up report written
</Final_Checklist>
