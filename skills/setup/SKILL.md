---
name: setup
description: Use first for install/update routing — sends setup, doctor, or MCP requests to the correct OMCP setup flow
level: 2
---

# Setup

Use `/oh-my-copilot:setup` as the unified setup/configuration entrypoint. The Copilot CLI is reached via the `copilot` binary; the user-config dir is `~/.copilot/`. The installed plugin lives at `~/.copilot/installed-plugins/oh-my-copilot/oh-my-copilot/`.

## Usage

```bash
/oh-my-copilot:setup                # full setup wizard (runs `omcp setup`)
/oh-my-copilot:setup doctor         # installation diagnostics (runs `omcp doctor`)
/oh-my-copilot:setup mcp            # MCP server configuration
/oh-my-copilot:setup wizard --local # explicit wizard path
```

## Routing

Process the request by the **first argument only** so install/setup questions land on the right flow immediately:

- No argument, `wizard`, `local`, `global`, or `--force` -> route to `/oh-my-copilot:omcp-setup` with the same remaining args (invokes `omcp setup`)
- `doctor` -> route to `/oh-my-copilot:omcp-doctor` with everything after the `doctor` token (invokes `omcp doctor`)
- `mcp` -> route to `/oh-my-copilot:mcp-setup` with everything after the `mcp` token

Examples:

```bash
/oh-my-copilot:setup --local          # => /oh-my-copilot:omcp-setup --local
/oh-my-copilot:setup doctor --json    # => /oh-my-copilot:omcp-doctor --json
/oh-my-copilot:setup mcp github       # => /oh-my-copilot:mcp-setup github
```

## Notes

- `/oh-my-copilot:omcp-setup`, `/oh-my-copilot:omcp-doctor`, and `/oh-my-copilot:mcp-setup` remain valid compatibility entrypoints.
- Prefer `/oh-my-copilot:setup` in new documentation and user guidance.

Task: {{ARGUMENTS}}
