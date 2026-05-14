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

| Command          | Purpose                                                    |
| ---------------- | ---------------------------------------------------------- |
| `omcp setup`     | Install/refresh the plugin in `~/.copilot/`                |
| `omcp doctor`    | Diagnose plugin/MCP/permissions installation               |
| `omcp ask`       | One-shot question routed to Copilot in non-interactive mode |
| `omcp team`      | Spawn a multi-pane parallel team via `--fleet`             |
| `omcp version`   | Print version                                              |

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
