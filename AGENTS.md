# oh-my-copilot — Instructions for GitHub Copilot CLI

You are running inside the **oh-my-copilot (omcp)** development repository. This
file is loaded by Copilot CLI as project-level instructions.

## Project purpose

omcp is a Copilot CLI plugin and companion `omcp` npm CLI that brings the
oh-my-claudecode / oh-my-codex orchestration culture to GitHub Copilot CLI.

## What you can assume

- Copilot CLI 1.0.32+ — `/agent`, `/skills`, `/mcp`, `/plugin`, `/fleet`, `/delegate`, `/tasks`, `/review`, `/init`, `/plan` are available
- Models available: `claude-{haiku,sonnet,opus}-4.x` and `gpt-5.{1,2,3,4}{,-codex,-mini}`
- `~/.copilot/installed-plugins/` is the plugin cache; `~/.copilot/mcp-config.json` is the user MCP registry
- Bash and PowerShell are both reachable via the Bash tool (`--bash-env` controls profile loading)

## Working agreements

1. **Never assume Claude-only tools.** Skills/agents shipped here must not reference `Task`, `TaskCreate`, `ExitPlanMode`, `EnterPlanMode`, `ToolSearch`, `NotebookEdit`, etc. Use Copilot equivalents.
2. **Dual-model awareness.** When writing agent prompts, do not assume `<thinking>` tags (Claude-only) or OpenAI reasoning summaries — both exist; gate on `OMCP_MODEL_FAMILY` if behavior must diverge.
3. **Read omc/omx before porting.** Their counterpart files live at the paths in `CLAUDE.md`. Rewrite, do not transclude.
4. **Plugin-mirror discipline.** Source files live at repo root (`agents/`, `skills/`, …). `plugins/oh-my-copilot/` is a generated mirror — never hand-edit it.
5. **Commit hygiene.** Conventional-commits subject + omc-style trailers (Constraint/Rejected/Confidence/Scope-risk/Directive/Not-tested).

## Slash command surface (target)

Invoke omcp skills as `/oh-my-copilot:<name>`. v0.1 target catalog:

- Workflow: `autopilot`, `ralph`, `ultrawork`, `team`, `ccg`, `ultraqa`, `plan`, `ralplan`, `sciomc`, `external-context`, `deepinit`, `deep-interview`, `ai-slop-cleaner`, `deep-dive`
- Utility: `ask`, `cancel`, `note`, `learner`, `omcp-setup`, `mcp-setup`, `hud`, `omcp-doctor`, `omcp-help`, `trace`, `release`, `project-session-manager`, `skill`, `writer-memory`, `configure-notifications`, `learn-about-omcp`, `visual-verdict`, `omcp-teams`

## Agent catalog (target)

Prefix `oh-my-copilot:`. All 19 omc agents are ported with dual-model recommendations:

- analyst, architect, code-reviewer, code-simplifier, critic, debugger, designer, document-specialist, executor, explore, git-master, planner, qa-tester, scientist, security-reviewer, test-engineer, tracer, verifier, writer

## Build & test

- `npm run build` — TypeScript compile + dist/ chmod
- `npm run build:rust` — cargo build --release
- `npm test` — vitest
- `npm run verify:plugin-bundle` — ensures `plugins/oh-my-copilot/` mirror is in sync with source-of-truth

## Out of scope for v0.1

- Web UI / dashboard
- Cross-tool MCP shims for Claude-Code-only tools (we don't ship them; skills don't reference them)
- Codex-specific sparkshell features (those stay in omx)
