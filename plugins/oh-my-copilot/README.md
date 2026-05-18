# oh-my-copilot (omcp)

Multi-agent orchestration layer for **GitHub Copilot CLI** — a sibling project to
[oh-my-claudecode (omc)](https://github.com/Yeachan-Heo/oh-my-claudecode) and
oh-my-codex (omx), tailored to Copilot's plugin runtime and its Claude + GPT
dual-model surface.

> Status: M0 scaffold (2026-05-15). See `docs/superpowers/specs/2026-05-15-omcp-design.md`.

## Why

Copilot CLI 1.0.32+ ships a real plugin system (`copilot plugin`,
`~/.copilot/installed-plugins/`), an MCP runtime, custom agents
(`--agent`), `/fleet` parallel subagents, and dual-vendor models
(`gpt-5.x` and `claude-{haiku,sonnet,opus}-4.x`). omcp brings the omc/omx
orchestration culture — ralph, autopilot, team, ultraqa, ccg, plan, hud — to
that surface, with prompts that don't assume Claude-only tools.

## Quick start

```bash
# install
npm install -g oh-my-copilot   # publishes `omcp` CLI

# bootstrap
omcp setup                     # registers plugin + marketplace into ~/.copilot
omcp doctor                    # verifies install
copilot                        # start Copilot CLI — omcp skills/agents are now active
```

Inside Copilot, invoke skills via:

```
/oh-my-copilot:autopilot ...
/oh-my-copilot:ralph ...
/oh-my-copilot:team ...
```

## CLI commands

### Install & maintenance

| Command           | Purpose                                                         |
| ----------------- | --------------------------------------------------------------- |
| `omcp setup`      | Install/refresh plugin in `~/.copilot/`, auto-wire hooks + status line |
| `omcp doctor`     | Diagnose plugin / MCP / permissions / hooks-wiring              |
| `omcp uninstall`  | Remove the plugin (preserves third-party MCP entries)           |
| `omcp update`     | `npm install -g oh-my-copilot@latest` then refresh install      |
| `omcp cleanup`    | Remove orphan MCP processes, stale tmp dirs, stale session dirs |
| `omcp info`       | Diagnostic dump of catalog, MCP servers, env vars, paths        |
| `omcp --version`  | Print version (commander standard, `-V` also accepted)          |

### Mode launchers (all wrap `copilot -p "/oh-my-copilot:<mode> <task>"`)

| Command                   | What it runs                                          |
| ------------------------- | ----------------------------------------------------- |
| `omcp ralph "task"`       | Persistence loop until verifier passes                |
| `omcp autopilot "task"`   | Full autonomous pipeline (expand → plan → exec → QA)  |
| `omcp ultrawork "task"`   | Parallel throughput engine                            |
| `omcp ultraqa "task"`     | QA cycling until tests pass                           |
| `omcp sciomc "task"`      | Multi-scientist parallel analysis                     |
| `omcp plan "task"`        | Strategic planning skill                              |
| `omcp ralplan "task"`     | Plan with consensus (Planner/Architect/Critic)        |
| `omcp ccg "task"`         | Claude-Codex-Gemini tri-model orchestration           |
| `omcp learner "topic"`    | Extract learnings from current conversation           |
| `omcp deep-interview "x"` | Socratic interview with ambiguity gating              |
| `omcp deep-dive "x"`      | Trace + interview pipeline                            |
| `omcp external-context`   | Parallel external documentation lookup                |
| `omcp ai-slop-cleaner`    | Regression-safe AI-slop cleanup                       |
| `omcp visual-verdict`     | Visual QA verdict from screenshot comparison          |
| `omcp autoresearch …`     | Long-horizon mission/evaluator loop (detached tmux)   |
| `omcp self-improve "x"`   | Critique-then-refine the working artifact in place    |
| `omcp verify "task"`      | Run the verifier skill against the current changeset  |
| `omcp debug "symptom"`    | Hypothesis-driven debugger skill (rep + bisect)       |
| `omcp remember "fact"`    | Memory write — pin a fact for future omcp sessions    |
| `omcp skillify "topic"`   | Promote ad-hoc patterns into a reusable SKILL.md      |
| `omcp ask <family> "q"`   | One-shot non-interactive question (family=claude\|gpt\|auto) |
| `omcp exec "prompt"`      | Non-interactive run with omcp logging (history.jsonl) |
| `omcp exec inject <sid>`  | Inject prompt into existing Copilot session           |
| `omcp team N[:agent] "q"` | Parallel team (tmux N panes, detached fallback)       |
| `omcp launch`             | Bare `copilot` with omcp defaults                     |

### Daemons + helpers

| Command                          | Purpose                                          |
| -------------------------------- | ------------------------------------------------ |
| `omcp loop <interval> <cmd…>`    | External re-run loop until cancel marker present |
| `omcp loop-watcher start\|stop\|status` | Manage the loop scheduling watcher daemon |
| `omcp teleport <issue>`          | Create git worktree under `~/Workspace/omcp-worktrees/` |
| `omcp cancel`                    | Write `.omcp/state/cancel.json` marker           |
| `omcp note "text"`               | Append a priority note to `.omcp/notepad.md`     |
| `omcp notepad <sub> [args…]`     | read \| write-priority \| write-working \| write-manual \| prune \| stats |
| `omcp trace <sub> [args…]`       | timeline `<sid>` [--limit=N] \| summary `<sid>` |
| `omcp project-memory <sub>`      | read \| write `<k>` `<json>` \| add-note \| add-directive |
| `omcp status`                    | Snapshot: active modes, ralph iter, team workers, cancel |
| `omcp session [grep]`            | List sessions under `.omcp/state/sessions/`      |
| `omcp state <action>`            | list \| read \| write \| clear \| clear-all      |
| `omcp mission-board`             | Render `.omcp/missions/*.md` board view          |
| `omcp reasoning <level>`         | Get/set default reasoning effort (low\|med\|high\|xhigh) |
| `omcp list [agents\|skills]`     | Print agent/skill catalog                        |
| `omcp mcp-serve <name>`          | Stdio entrypoint for any omcp MCP server         |
| `omcp hud [--watch]`             | Render status-line element once (or every 2 s)   |
| `omcp hook fire <event>`         | Manually trigger the hook dispatcher             |

### MCP servers (registered automatically by `omcp setup`)

| Server               | Tools                                                       |
| -------------------- | ----------------------------------------------------------- |
| `omcp-state`         | state_read/write/clear/list_active/get_status + mode_read/write/clear/list_active/get_status (typed mode-state) |
| `omcp-notepad`       | notepad_read/write_priority/write_working/write_manual/prune/stats |
| `omcp-trace`         | trace_append/summary/timeline                               |
| `omcp-project-memory`| project_memory_read/write/add_note/add_directive (validated) |
| `omcp-loop`          | loop_schedule/list_pending/check_due/cancel/cancel_all/mark_fired |
| `omcp-code-intel`    | lsp_diagnostics(_directory), lsp_*, ast_grep_search/replace |
| `omcp-hermes`        | hermes_start_session/send_prompt/read_status/read_tail/list_artifacts/kill_session/list_sessions |
| `omcp-wiki`          | wiki_ingest/query/lint/add/list/read/delete — LLM Wiki KB backed by `.omcp/wiki/*.md` |

## Layout

```
oh-my-copilot/
├─ src/                          TypeScript source (CLI, runtime, MCP, hooks)
├─ crates/omcp-explore-harness/  Rust hot-path harness (mirrors omx)
├─ agents/                       Agent definitions (markdown)
├─ skills/                       Skill definitions (markdown)
├─ prompts/                      Reusable prompt fragments
├─ templates/                    Scaffold templates
├─ plugins/oh-my-copilot/        Plugin-bundle mirror (built artifact)
├─ .claude-plugin/plugin.json    Plugin manifest (Copilot-compatible)
├─ .agents/plugins/marketplace.json   Plugin marketplace listing
├─ .mcp.json                     MCP server registry
└─ docs/                         Specs and architecture notes
```

## Relationship to omc and omx

| Project | Target CLI               | Language        | Notes                          |
| ------- | ------------------------ | --------------- | ------------------------------ |
| omc     | Anthropic Claude Code    | TypeScript      | Original reference             |
| omx     | OpenAI Codex CLI         | TS + Rust       | Adds sparkshell, explore-harness |
| omcp    | GitHub Copilot CLI       | TS + Rust       | Claude + GPT dual-model        |

omcp **does not depend on** omc or omx at runtime. It mirrors their patterns
and adopts their orchestration vocabulary (autopilot, ralph, team, etc.) so
users moving between the three projects feel at home.

## License

MIT. See [LICENSE](./LICENSE).
