# code-intel fixture

Static TypeScript files used by the MCP code-intel deterministic test harness.

## Files

- `sample-module.ts` — exports `add(a,b)`, `multiply(a,b)`, `class Calculator`
- `another.ts` — exports `greet(name)`, `farewell(name)`, `interface Greeter`

## Purpose

The `lsp_workspace_symbols` tool in `code-intel-server` walks a directory tree
and regex-matches symbol definitions. These fixtures provide a stable, small
target directory so the harness test can assert a non-empty match list without
depending on the full project source tree.

The files are intentionally minimal: no external imports, no side effects.
