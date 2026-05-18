---
name: wiki
description: LLM Wiki — persistent markdown knowledge base that compounds across sessions (Karpathy model)
level: 4
model:
  claude: claude-sonnet-4.6
  gpt: gpt-5.2
---

# Wiki

Persistent, self-maintained markdown knowledge base for project and session knowledge. Inspired by Karpathy's LLM Wiki concept.

## Operations

The wiki is exposed as an MCP server (`omcp-wiki`) with seven tools.

### Ingest
Process knowledge into wiki pages. A single ingest can touch multiple pages.

```
wiki_ingest({ title: "Auth Architecture", content: "...", tags: ["auth", "architecture"], category: "architecture" })
```

### Query
Search across all wiki pages by keywords and tags. Returns matching pages with snippets — you synthesize answers with citations from the results.

```
wiki_query({ query: "authentication", tags: ["auth"], category: "architecture" })
```

### Lint
Run health checks on the wiki. Detects orphan pages, stale content, broken cross-references, oversized pages, and structural contradictions.

```
wiki_lint()
```

### Quick Add
Add a single page quickly (simpler than ingest).

```
wiki_add({ title: "Page Title", content: "...", tags: ["tag1"], category: "decision" })
```

### List / Read / Delete
```
wiki_list()           # Show all pages (reads index.md)
wiki_read({ page: "auth-architecture" })  # Read specific page
wiki_delete({ page: "outdated-page" })    # Delete a page
```

### Log
View wiki operation history by reading the project-local log at `<root>/.omcp/wiki/log.md`.

## Categories
Pages are organized by category: `architecture`, `decision`, `pattern`, `debugging`, `environment`, `session-log`, `reference`, `convention`.

## Storage
- Pages: project-local under `<root>/.omcp/wiki/*.md` (markdown with YAML frontmatter)
- Index: `<root>/.omcp/wiki/index.md` (auto-maintained catalog)
- Log: `<root>/.omcp/wiki/log.md` (append-only operation chronicle)

The directory is git-ignored by default (the engine appends `wiki/` to `<root>/.omcp/.gitignore` on first use).

## Cross-References
Use `[[page-name]]` wiki-link syntax to create cross-references between pages.

## Auto-Capture
At session end, significant discoveries can be captured as `session-log` pages by wiring the `onSessionEnd` hook from `src/hooks/wiki/session-hooks.ts`. Configure via `wiki.autoCapture` in a project-local `.omcp-config.json` or user-level `~/.copilot/.omcp-config.json` (default: enabled). When `wiki_lint` flags low-confidence or contradictory pages, ask the user directly (one question at a time) before promoting or deleting them; persist any standing rules via project memory tools.

## Hard Constraints
- NO vector embeddings — query uses keyword + tag matching only
- Wiki pages are git-ignored by default (`<root>/.omcp/wiki/` is project-local)
