# Changelog

All notable changes to oh-my-copilot will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.3.0] — 2026-05-17

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
