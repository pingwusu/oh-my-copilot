# v1.8 Tier-3 MCP Live e2e — code-intel

**Verdict**: PASS
**Timestamp**: 2026-05-25T05:24:12.372Z
**Server**: code-intel
**serverInfo.name**: omcp-code-intel
**Tool count**: 18
**Sample tools**: lsp_diagnostics, lsp_diagnostics_directory, lsp_document_symbols, lsp_workspace_symbols, lsp_hover
**Diagnostic**: workspace_symbols: 1 result(s)

## Protocol events sent (Invariant 4 — valid events)

1. `initialize` — MCP 2024-11-05 handshake
2. `tools/list` — enumerate registered tools
3. `tools/call` (workspace_symbols) — real tool invocation against fixture
4. `notifications/cancelled` — clean shutdown signal

## Evidence

- Server path: `dist/mcp/code-intel-server.js`
- Spawned via: Node.js child_process.spawn (real stdio)
- initialize response: received
- tools/list response: 18 tool(s) registered
- Verdict: **PASS**
