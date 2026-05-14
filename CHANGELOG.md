# Changelog

All notable changes to oh-my-copilot will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

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

### Notes

- M3 will land remaining skills (~13), wire the Rust explore harness, and complete model-routing edge cases
- M4 will land hooks runtime + HUD + state MCP server stdio wrapper
- M5 will land release automation + marketplace registration + screenshots
