# v1.8 Tier-3 MCP Live e2e — hermes

**Verdict**: PASS
**Timestamp**: 2026-05-25T05:24:12.372Z
**Server**: hermes
**serverInfo.name**: omcp-hermes
**Tool count**: 7
**Sample tools**: hermes_start_session, hermes_send_prompt, hermes_read_status, hermes_read_tail, hermes_list_artifacts
**Diagnostic**: none

## Protocol events sent (Invariant 4 — valid events)

1. `initialize` — MCP 2024-11-05 handshake
2. `tools/list` — enumerate registered tools
3. `notifications/cancelled` — clean shutdown signal

## Evidence

- Server path: `dist/mcp/hermes-server.js`
- Spawned via: Node.js child_process.spawn (real stdio)
- initialize response: received
- tools/list response: 7 tool(s) registered
- Verdict: **PASS**
