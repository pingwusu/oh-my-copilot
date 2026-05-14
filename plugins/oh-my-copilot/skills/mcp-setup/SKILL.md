---
name: mcp-setup
description: Configure popular MCP servers for enhanced agent capabilities
level: 2
---

# MCP Setup

Configure Model Context Protocol (MCP) servers to extend Copilot CLI's capabilities with external tools like web search, file system access, and GitHub integration.

## Overview

MCP servers provide additional tools that Copilot CLI agents can use. This skill helps you configure popular MCP servers by writing to `~/.copilot/mcp-config.json` (the canonical Copilot MCP configuration file).

## Step 1: Show Available MCP Servers

Present the user with available MCP server options by asking them directly (one question at a time):

**Question:** "Which MCP server would you like to configure?"

**Options:**
1. **Context7** - Documentation and code context from popular libraries
2. **Exa Web Search** - Enhanced web search (Copilot CLI has no built-in WebSearch — this is the recommended way to add it)
3. **Filesystem** - Extended file system access with additional capabilities
4. **GitHub** - GitHub API integration for issues, PRs, and repository management
5. **All of the above** - Configure all recommended MCP servers
6. **Custom** - Add a custom MCP server

## Step 2: Gather Required Information

### For Context7:
No API key required. Ready to use immediately.

### For Exa Web Search:
Ask for API key:
```
Do you have an Exa API key?
- Get one at: https://exa.ai
- Enter your API key, or type 'skip' to configure later
```

### For Filesystem:
Ask for allowed directories:
```
Which directories should the filesystem MCP have access to?
Default: Current working directory
Enter comma-separated paths, or press Enter for default
```

### For GitHub:
Ask for token:
```
Do you have a GitHub Personal Access Token?
- Create one at: https://github.com/settings/tokens
- Recommended scopes: repo, read:org
- Enter your token, or type 'skip' to configure later
```

## Step 3: Add MCP Servers to ~/.copilot/mcp-config.json

Merge each configured server into the user's MCP config file. The Copilot CLI reads from `~/.copilot/mcp-config.json` at startup.

### Context7 Configuration:
Add to `~/.copilot/mcp-config.json`:
```json
{
  "mcpServers": {
    "context7": {
      "command": "npx",
      "args": ["-y", "@upstash/context7-mcp"]
    }
  }
}
```

### Exa Web Search Configuration:
```json
{
  "mcpServers": {
    "exa": {
      "command": "npx",
      "args": ["-y", "exa-mcp-server"],
      "env": { "EXA_API_KEY": "<user-provided-key>" }
    }
  }
}
```

### Filesystem Configuration:
```json
{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "<allowed-directories>"]
    }
  }
}
```

### GitHub Configuration:

**Option 1: Docker (local)**
```json
{
  "mcpServers": {
    "github": {
      "command": "docker",
      "args": ["run", "-i", "--rm", "-e", "GITHUB_PERSONAL_ACCESS_TOKEN", "ghcr.io/github/github-mcp-server"],
      "env": { "GITHUB_PERSONAL_ACCESS_TOKEN": "<user-provided-token>" }
    }
  }
}
```

**Option 2: HTTP (remote)**
```json
{
  "mcpServers": {
    "github": {
      "transport": "http",
      "url": "https://api.githubcopilot.com/mcp/"
    }
  }
}
```

> Note: Docker option requires Docker installed. HTTP option is simpler but may have different capabilities.

When writing, read the existing `~/.copilot/mcp-config.json` first (if it exists) and merge new servers into the existing `mcpServers` object — do not overwrite the entire file.

## Step 4: Verify Installation

After configuration, verify the MCP servers are properly set up. The Copilot CLI will load the new servers on next startup. Inspect the merged config to confirm:

```bash
jq '.mcpServers | keys' ~/.copilot/mcp-config.json
```

This will display all configured MCP server names. After restart, Copilot CLI will surface the new server tools.

## Step 5: Show Completion Message

```
MCP Server Configuration Complete!

CONFIGURED SERVERS:
[List the servers that were configured]

NEXT STEPS:
1. Restart Copilot CLI for changes to take effect
2. The configured MCP tools will be available to all agents
3. Run `jq '.mcpServers | keys' ~/.copilot/mcp-config.json` to verify configuration

USAGE TIPS:
- Context7: Ask about library documentation (e.g., "How do I use React hooks?")
- Exa: Use for web searches (e.g., "Search the web for latest TypeScript features")
- Filesystem: Extended file operations beyond the working directory
- GitHub: Interact with GitHub repos, issues, and PRs

TROUBLESHOOTING:
- If MCP servers don't appear, check `~/.copilot/mcp-config.json` syntax with `jq . ~/.copilot/mcp-config.json`
- Ensure you have Node.js 18+ installed for npx-based servers
- For GitHub Docker option, ensure Docker is installed and running
- Run /oh-my-copilot:omcp-doctor to diagnose issues

MANAGING MCP SERVERS:
- Add more servers: /oh-my-copilot:mcp-setup or edit `~/.copilot/mcp-config.json`
- List servers: `jq '.mcpServers | keys' ~/.copilot/mcp-config.json`
- Remove a server: edit `~/.copilot/mcp-config.json` and delete the entry under `mcpServers.<name>`
```

## Custom MCP Server

If user selects "Custom":

Ask for:
1. Server name (identifier)
2. Transport type: `stdio` (default) or `http`
3. For stdio: Command and arguments (e.g., `npx my-mcp-server`)
4. For http: URL (e.g., `https://example.com/mcp`)
5. Environment variables (optional, key=value pairs)
6. HTTP headers (optional, for http transport only)

Then construct and merge the appropriate config block into `~/.copilot/mcp-config.json`:

**For stdio servers:**
```json
{
  "mcpServers": {
    "<server-name>": {
      "command": "<command>",
      "args": ["<arg1>", "<arg2>"],
      "env": { "KEY1": "value1", "KEY2": "value2" }
    }
  }
}
```

**For HTTP servers:**
```json
{
  "mcpServers": {
    "<server-name>": {
      "transport": "http",
      "url": "<url>",
      "headers": { "Authorization": "Bearer <token>" }
    }
  }
}
```

## Common Issues

### MCP Server Not Loading
- Ensure Node.js 18+ is installed
- Check that npx is available in PATH
- Validate JSON syntax with `jq . ~/.copilot/mcp-config.json`
- Check server logs for errors

### API Key Issues
- Exa: Verify key at https://dashboard.exa.ai
- GitHub: Ensure token has required scopes (repo, read:org)
- Edit `~/.copilot/mcp-config.json` with the correct credentials if needed

### Agents Still Using Built-in Tools
- Restart Copilot CLI after configuration
- Copilot CLI has no built-in WebSearch, so Exa fills that gap entirely
- Inspect `~/.copilot/mcp-config.json` to confirm servers are configured

### Removing or Updating a Server
- Remove: edit `~/.copilot/mcp-config.json` and delete the server entry
- Update: edit the server entry in `~/.copilot/mcp-config.json` directly
