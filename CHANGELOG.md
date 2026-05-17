# Changelog

All notable changes to oh-my-copilot will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.3.0] — 2026-05-17

### Added — DD2 (deep-dive cycle 2) — full omc/omx parity push

**3 new MCP servers** (7 total):

- `omcp-loop` — recurring task scheduler (loop_schedule/list_pending/check_due/cancel/cancel_all/mark_fired). Companion: `scripts/omcp-loop-watcher.mjs` daemon process. Closes the user-flagged "/loop MCP" gap.
- `omcp-code-intel` — code intelligence (lsp_diagnostics + directory, lsp_document/workspace_symbols, lsp_hover, lsp_find_references, lsp_servers, ast_grep_search, ast_grep_replace). Wraps tsc/ast-grep/grep CLIs.
- `omcp-hermes` — session-coordination dispatcher (hermes_start_session/send_prompt/read_status/read_tail/list_artifacts/kill_session/list_sessions). tmux-first with detached fallback.

**16 new `omcp` CLI verbs** (wired and tested):

`info`, `list`, `mission-board`, `reasoning`, `state`, `mcp-serve`, `teleport` (+ `--list`/`--remove`), `loop-watcher` (start/stop/status), `exec`, `exec inject`, `uninstall` (`--purge`/`--dry-run`), `cleanup` (`--dry-run`/`--max-age-days`), plus the prior DD1 set (ralph/autopilot/ultrawork/ultraqa/sciomc/plan/ralplan/ccg/learner/deep-interview/deep-dive/external-context/ai-slop-cleaner/visual-verdict/autoresearch/cancel/note/loop/status/session/launch/update).

**Hook + statusLine auto-wiring** into `~/.copilot/config.json`:

- `omcp setup` writes hook entries for PreToolUse/PostToolUse/PreSubmit/PostSubmit/SessionStart/PreEnd that pipe Copilot's tool context into `omcp hook fire <event> --json`.
- `omcp setup` writes the statusLine entry to invoke `omcp hud`.
- Idempotent via `__omcp: true` markers; preserves user-authored entries.
- `omcp doctor` adds two new checks (hook-wiring, statusLine-wiring).

**Runtime depth**:

- `src/runtime/phase-machine.ts` — typed autopilot phase transitions (expansion → planning → execution ↔ qa → validation → cleanup) with bounded loopbacks + ralph→ultraqa carry-over.
- `src/runtime/mode-state.ts` — session-isolated state: `resolveSessionRoot()` reads `COPILOT_SESSION_ID` / `OMCP_SESSION_ID`; falls back to legacy single-dir layout when no session id present.
- `src/mcp/memory-validation.ts` — gates `project_memory_write` (reject newline/null-byte keys, exotic types, depth >5, size >64KB).

**HUD rendering engine** (`src/hud/`):

8-element pipeline (model/context/git/token-usage/autopilot/ralph/todos/notepad-priority) replacing the prior 120-line inline mjs. `scripts/omcp-hud.mjs` now thin-wraps the compiled output; back-compat 6-column line preserved.

**Skill catalog +2** (33 total):

- `loop` — wraps the omcp-loop MCP server + watcher daemon
- `autoresearch` — long-horizon mission/evaluator loop (port of omx)

**Tooling**:

- `verify-catalog` now scans skill subfiles for banned tokens (was top-level only)
- Banned tokens list expanded: `Skill("oh-my-copilot:` and `"subagent_type":`
- `scripts/postinstall.ts` — auto-runs `omcp setup --force` after `npm install -g`
- `package.json` `files:` array now ships `scripts/`, `hooks/`, and `CHANGELOG.md` (was missing — npm tarballs were incomplete)
- `OMCP_MCP_SERVER_KEYS` extended to all 7 MCP servers (was 6 — `omcp-hermes` was orphaned by `omcp uninstall`)
- `mcp-serve.ts` SERVER_FILES extended to include code-intel + hermes
- `omcp uninstall --dry-run` / `--purge` flags

### Fixed — DD2 critic findings (P0 bugs from adversarial review)

- 11 orphan CLI command modules were unreachable — wired into the commander dispatcher
- `autoresearch` mode was registered but had no SKILL.md — added
- `package.json` `files:` was missing `scripts/` — fresh npm installs would have crashed `omcp hud` and the loop watcher
- `OMCP_MCP_SERVER_KEYS` did not include `omcp-hermes` — `omcp uninstall` would have orphaned that key
- `mcp-serve` SERVER_FILES did not include code-intel/hermes — `omcp mcp-serve <name>` returned "unknown"
- Subfile banned tokens in skills/omcp-setup/phases/*.md (4× AskUserQuestion + 1× &lt;remember&gt;) — scrubbed; verify-catalog now scans subfiles too
- `subagent_type` Claude-only dispatch envelope in skills/team/SKILL.md:326 — rewritten to use `/fleet` slash syntax

### Test totals

- 38 vitest files, 242 passing / 2 skipped / 0 failed
- 23 smoke-e2e assertions pass
- verify-catalog clean (19 agents, 33 skills)
- verify-plugin-bundle in sync
- `copilot plugin list` shows oh-my-copilot v0.3.0
- `copilot mcp list` shows all 7 omcp MCP servers as workspace-scoped



## [0.2.0] — 2026-05-15

### Added — M0 (2026-05-15)

- Repository scaffold (single-package monorepo, omx-style)
- TypeScript baseline + Cargo workspace stub for `omcp-explore-harness`
- Copilot-compatible plugin manifest at `.claude-plugin/plugin.json`
- Plugin marketplace listing at `.agents/plugins/marketplace.json`
- Design spec at `docs/superpowers/specs/2026-05-15-omcp-design.md`
- Three reference agents (executor, explore, planner) with dual Claude+GPT model declarations
- `omcp` CLI skeleton with `setup`/`doctor`/`ask`/`team` subcommands

### Added — M1 (2026-05-15)

- `omcp setup` real install flow: mirrors source-of-truth into `~/.copilot/installed-plugins/oh-my-copilot/oh-my-copilot/`, writes marketplace file, upserts `~/.copilot/config.json`, merges MCP servers into `~/.copilot/mcp-config.json` with `${PLUGIN_ROOT}` substitution
- `omcp doctor` six-check probe (copilot CLI on PATH, ~/.copilot dir, plugin cache, manifest parse, mcp-config presence, agent catalog) with `ok`/`warn`/`fail` levels + structured exit codes
- `omcp ask <claude|gpt|auto> "<prompt>"` wrapper around `copilot -p --model ...` with dual-model routing
- `omcp team N[:agent] "<task>"` parallel team launcher (tmux mode + detached fallback)
- Per-session log dir at `.omcp/state/sessions/<uuid>/`
- vitest coverage: `setup-flow`, `team-spec`, `copilot-config`, `model-routing`

### Added — M2 (2026-05-15)

- 16 agents ported from omc 4.9.3 with dual-model frontmatter and Copilot-only tool surface (no `TodoWrite`/`AskUserQuestion`/`Task(subagent_type=...)`/`/oh-my-claudecode:`/`EnterPlanMode`/`ToolSearch`/`<remember>`)
- 18+ skills (and counting) ported with Copilot-CLI-native invocation paths
- `verify-catalog` SSOT linter for agent/skill frontmatter + banned-token scan
- `sync-plugin-mirror` + `verify-plugin-bundle` to keep `plugins/oh-my-copilot/` byte-identical with source-of-truth
- Hook framework (`src/hooks/`) with HookEvent enum, registry, and reference `suggest-fleet` hook
- File + in-memory `StateStore` for `.omcp/state/sessions/<id>.json`
- CI matrix (linux+macos+windows × node 20+22) plus a separate cargo job

### Verification (2026-05-15)

Live install on the dev host:

```
$ omcp setup
omcp setup complete
  plugin     -> C:\Users\runjiashi\.copilot\installed-plugins\oh-my-copilot\oh-my-copilot
  marketplace -> C:\Users\runjiashi\.copilot\marketplaces\oh-my-copilot.json
  config.json updated: true
  mcp-config.json updated: true

$ omcp doctor
[OK ] copilot CLI                  GitHub Copilot CLI 1.0.32.
[OK ] ~/.copilot directory         C:\Users\runjiashi\.copilot
[OK ] oh-my-copilot plugin cache   ...installed-plugins\oh-my-copilot\oh-my-copilot
[OK ] plugin manifest              version 0.1.0
[OK ] mcp-config.json              C:\Users\runjiashi\.copilot\mcp-config.json
[OK ] agent catalog                ...\oh-my-copilot\oh-my-copilot/agents

$ copilot plugin list
Installed plugins:
  • ralph-wiggum@claude-code-plugins (v1.0.0)
  • oh-my-claudecode@omc (v4.13.0)
  • oh-my-copilot@oh-my-copilot (v0.1.0)
```

Copilot CLI 1.0.32 recognizes oh-my-copilot as a first-class plugin
alongside oh-my-claudecode. Plugin cache layout (agents/ + skills/ +
.claude-plugin/plugin.json + .mcp.json + AGENTS.md + CLAUDE.md) mirrors
the omc install structure exactly.

### Final v0.1 catalog

- Agents (19/19): analyst, architect, code-reviewer, code-simplifier, critic, debugger, designer, document-specialist, executor, explore, git-master, planner, qa-tester, scientist, security-reviewer, test-engineer, tracer, verifier, writer
- Skills (31/31): ai-slop-cleaner, ask, autopilot, cancel, ccg, configure-notifications, deep-dive, deep-interview, deepinit, external-context, hud, learner, mcp-setup, omcp-doctor, omcp-reference, omcp-setup, omcp-teams, plan, project-session-manager, ralph, ralplan, release, sciomc, setup, skill, team, trace, ultraqa, ultrawork, visual-verdict, writer-memory

### Notes

- M3 follow-up: wire the Rust explore harness, polish model-routing edge cases, port remaining sub-files (writer-memory/lib/, omcp-setup/phases/)
- M4 follow-up: hooks runtime + HUD + state MCP server stdio wrapper
- M5 follow-up: release automation + marketplace registration + screenshots
