# v1.8 Tier 3 MCP canary live-e2e template

**Status**: template (placeholder for canary 1/2/3 + remaining 7 smoke artifacts)
**Date created**: 2026-05-25
**Purpose**: Capture live-e2e evidence for tag-gate v1.8 #2 (10/10 MCP e2e + 1 runtime shim pass per critic H5).

Each MCP server gets one live-e2e smoke entry below when CP-1 runs.

---

## Canary 1/3: state (v1.8-T3-MCP-state-e2e)

**Status**: pending
**Acceptance**: `omcp mcp-serve state` started; stdio JSON-RPC ping returned valid initialize+tools/list; one tool call (e.g. state_get) returned expected shape.

(Filled in by execution session.)

---

## Canary 2/3: notepad (v1.8-T3-MCP-notepad-e2e)

**Status**: pending
**Acceptance**: `omcp mcp-serve notepad` started; one tool call writes a tmp file via atomicWriteFileSync (Invariant 2 carve-out for notepad); state file confirmed under .omcp/state/notepad/.

(Filled in by execution session.)

---

## Canary 3/3: code-intel (v1.8-T3-MCP-code-intel-e2e)

**Status**: pending
**Acceptance**: `omcp mcp-serve code-intel` started; `code-intel.workspace_symbols` query against `src/__tests__/__fixtures__/code-intel/` returned non-empty match; regex carve-out at `code-intel-server.ts:589` (Invariant 6 known-exception site) preserved.

(Filled in by execution session.)

---

## CP-1 checkpoint

If 2/3+ canaries fail with shared symptom → STOP remaining 7 MCP work, 3-direction team the shared cause per iter-3 plan SPOF #1. Mid-session diagnostic appended to `docs/architecture/v1.7-to-v2.0-roadmap.md` `## v1.8 working section` `### CP-1 trigger (if fires)` subsection.

If 3/3 canaries pass → proceed to remaining 7 servers (matrix).

---

## Remaining 7 MCP servers (post-CP-1)

- trace
- project-memory
- loop
- hermes
- wiki
- python-repl
- shared-memory

(Each gets a heading + status + acceptance line when executed.)

---

## Runtime shim (separate from MCP servers)

- US-1.8-T3-RUNTIME-shared-shim-e2e: live e2e against the shim itself (via any one server through it).

---

## References

- iter-3 plan: `docs/plans/v1.8-to-v2.0-ralplan-iter3.md`
- handoff: `docs/handoff-archive/2026-05-25-v1.8-to-v2.0-handoff.md`
- runtime-shim source: `src/mcp/server-runtime.ts`
- mcp-serve CLI: `src/cli/commands/mcp-serve.ts`
- invariants: `docs/architecture/invariants.md` (I2 carve-out for notepad; I6 carve-out for code-intel)
