# v1.8 Tier-3 MCP Live e2e — python-repl

**Verdict**: PASS
**Timestamp**: 2026-05-25T05:24:12.372Z
**Server**: python-repl
**serverInfo.name**: omcp-python-repl
**Tool count**: 1
**Sample tools**: python_repl
**Diagnostic**: none

## Protocol events sent (Invariant 4 — valid events)

1. `initialize` — MCP 2024-11-05 handshake
2. `tools/list` — enumerate registered tools
3. `notifications/cancelled` — clean shutdown signal

## Evidence

- Server path: `dist/mcp/python-repl-server.js`
- Spawned via: Node.js child_process.spawn (real stdio)
- initialize response: received
- tools/list response: 1 tool(s) registered
- Verdict: **PASS**
