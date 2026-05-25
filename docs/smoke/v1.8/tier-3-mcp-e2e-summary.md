# v1.8 Tier-3 MCP Live e2e — Summary

**Overall verdict**: PASS
**Timestamp**: 2026-05-25T05:24:12.372Z
**Servers tested**: 10 MCP servers + 1 runtime shim = 11 total
**Passed**: 11 / 11
**Failed**: 0

## Results

| Server | Verdict | Tool count | Sample tools |
|--------|---------|------------|--------------|
| state | PASS | 10 | state_read, state_write, state_clear, state_list_active, state_get_status |
| notepad | PASS | 6 | notepad_read, notepad_write_priority, notepad_write_working, notepad_write_manual, notepad_prune |
| trace | PASS | 4 | trace_append, trace_summary, trace_timeline, session_search |
| project-memory | PASS | 4 | project_memory_read, project_memory_write, project_memory_add_note, project_memory_add_directive |
| loop | PASS | 6 | loop_schedule, loop_list_pending, loop_check_due, loop_cancel, loop_cancel_all |
| code-intel | PASS | 18 | lsp_diagnostics, lsp_diagnostics_directory, lsp_document_symbols, lsp_workspace_symbols, lsp_hover |
| hermes | PASS | 7 | hermes_start_session, hermes_send_prompt, hermes_read_status, hermes_read_tail, hermes_list_artifacts |
| wiki | PASS | 7 | wiki_ingest, wiki_query, wiki_lint, wiki_add, wiki_list |
| python-repl | PASS | 1 | python_repl |
| shared-memory | PASS | 5 | shared_memory_write, shared_memory_read, shared_memory_list, shared_memory_delete, shared_memory_cleanup |
| runtime-shim | PASS | 10 | state_read, state_write, state_clear, state_list_active, state_get_status |

## Protocol events (Invariant 4 — valid events)

All servers received these valid MCP JSON-RPC events:
- `initialize` (protocolVersion: 2024-11-05)
- `tools/list`
- `notifications/cancelled`
- `tools/call` (workspace_symbols) for code-intel only

## Artifacts

- [`tier-3-mcp-state-e2e.md`](tier-3-mcp-state-e2e.md)
- [`tier-3-mcp-notepad-e2e.md`](tier-3-mcp-notepad-e2e.md)
- [`tier-3-mcp-trace-e2e.md`](tier-3-mcp-trace-e2e.md)
- [`tier-3-mcp-project-memory-e2e.md`](tier-3-mcp-project-memory-e2e.md)
- [`tier-3-mcp-loop-e2e.md`](tier-3-mcp-loop-e2e.md)
- [`tier-3-mcp-code-intel-e2e.md`](tier-3-mcp-code-intel-e2e.md)
- [`tier-3-mcp-hermes-e2e.md`](tier-3-mcp-hermes-e2e.md)
- [`tier-3-mcp-wiki-e2e.md`](tier-3-mcp-wiki-e2e.md)
- [`tier-3-mcp-python-repl-e2e.md`](tier-3-mcp-python-repl-e2e.md)
- [`tier-3-mcp-shared-memory-e2e.md`](tier-3-mcp-shared-memory-e2e.md)
- [`tier-3-mcp-runtime-shim-e2e.md`](tier-3-mcp-runtime-shim-e2e.md)
- [`tier-3-mcp-runtime-shim-e2e.md`](tier-3-mcp-runtime-shim-e2e.md)

## References

- iter-3 plan: `docs/plans/v1.8-to-v2.0-ralplan-iter3.md`
- mcp-serve CLI: `src/cli/commands/mcp-serve.ts`
- runtime-shim: `src/mcp/server-runtime.ts` → `dist/mcp/server-runtime.js`
- invariants: `docs/architecture/invariants.md` (I4: valid events)
