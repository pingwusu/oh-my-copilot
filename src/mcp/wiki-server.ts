#!/usr/bin/env node
// omcp wiki MCP server — exposes wiki_ingest/wiki_query/wiki_lint/wiki_add/
// wiki_list/wiki_read/wiki_delete. Backed by `<root>/.omcp/wiki/*.md` files.
//
// Working directory is taken from the `workingDirectory` argument when
// provided, otherwise from `process.cwd()`. The `OMCP_WIKI_ROOT` env var
// overrides the `.omcp/` parent (used by tests).

import { isAbsolute, resolve } from "node:path";
import { runMcpServer } from "./server-runtime.js";
import {
  appendLog,
  deletePage,
  listPages,
  readIndex,
  readPage,
  titleToSlug,
} from "../hooks/wiki/storage.js";
import { ingestKnowledge } from "../hooks/wiki/ingest.js";
import { queryWiki } from "../hooks/wiki/query.js";
import { lintWiki } from "../hooks/wiki/lint.js";
import type { WikiCategory } from "../hooks/wiki/types.js";

const WIKI_CATEGORIES: WikiCategory[] = [
  "architecture",
  "decision",
  "pattern",
  "debugging",
  "environment",
  "session-log",
  "reference",
  "convention",
];

const CONFIDENCE_LEVELS = ["high", "medium", "low"] as const;
type Confidence = (typeof CONFIDENCE_LEVELS)[number];

/** Resolve the effective workingDirectory for an MCP call. */
function resolveRoot(arg: unknown): string {
  if (typeof arg === "string" && arg.length > 0) {
    return isAbsolute(arg) ? arg : resolve(process.cwd(), arg);
  }
  return process.cwd();
}

function asString(v: unknown, field: string): string {
  if (typeof v !== "string") throw new Error(`${field} must be a string`);
  return v;
}

function asStringArray(v: unknown, field: string): string[] {
  if (v === undefined) return [];
  if (!Array.isArray(v)) throw new Error(`${field} must be an array of strings`);
  return v.map((x, i) => {
    if (typeof x !== "string") {
      throw new Error(`${field}[${i}] must be a string`);
    }
    return x;
  });
}

function asCategory(v: unknown, field: string): WikiCategory {
  const s = asString(v, field);
  if (!WIKI_CATEGORIES.includes(s as WikiCategory)) {
    throw new Error(`${field} must be one of: ${WIKI_CATEGORIES.join(", ")}`);
  }
  return s as WikiCategory;
}

function asOptionalCategory(v: unknown, field: string): WikiCategory | undefined {
  if (v === undefined || v === null) return undefined;
  return asCategory(v, field);
}

function asOptionalConfidence(
  v: unknown,
  field: string,
): Confidence | undefined {
  if (v === undefined || v === null) return undefined;
  const s = asString(v, field);
  if (!(CONFIDENCE_LEVELS as readonly string[]).includes(s)) {
    throw new Error(`${field} must be one of: ${CONFIDENCE_LEVELS.join(", ")}`);
  }
  return s as Confidence;
}

runMcpServer({
  name: "omcp-wiki",
  version: "0.1.0",
  tools: [
    {
      name: "wiki_ingest",
      description:
        "Process knowledge into wiki pages. Creates new pages or merges into " +
        "existing ones (append strategy — never replaces). A single ingest can " +
        "update multiple pages via cross-references.",
      inputSchema: {
        type: "object",
        properties: {
          title: { type: "string", description: "Page title (max 200 chars)." },
          content: {
            type: "string",
            description: "Markdown content to ingest (max 50KB).",
          },
          tags: {
            type: "array",
            items: { type: "string" },
            description: "Searchable tags.",
          },
          category: {
            type: "string",
            enum: WIKI_CATEGORIES,
            description: "Page category.",
          },
          sources: {
            type: "array",
            items: { type: "string" },
            description: "Source identifiers (e.g. session IDs).",
          },
          confidence: {
            type: "string",
            enum: CONFIDENCE_LEVELS,
            description: "Confidence level (default: medium).",
          },
          workingDirectory: {
            type: "string",
            description: "Project root (defaults to cwd).",
          },
        },
        required: ["title", "content", "tags", "category"],
      },
      handler: (args) => {
        const root = resolveRoot(args.workingDirectory);
        const result = ingestKnowledge(root, {
          title: asString(args.title, "title"),
          content: asString(args.content, "content"),
          tags: asStringArray(args.tags, "tags"),
          category: asCategory(args.category, "category"),
          sources: args.sources === undefined
            ? undefined
            : asStringArray(args.sources, "sources"),
          confidence: asOptionalConfidence(args.confidence, "confidence"),
        });
        return result;
      },
    },
    {
      name: "wiki_query",
      description:
        "Search across all wiki pages by keywords and tags. Returns matching " +
        "pages with relevance snippets. The caller synthesizes answers with " +
        "citations from the results. NO vector embeddings.",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string" },
          tags: { type: "array", items: { type: "string" } },
          category: { type: "string", enum: WIKI_CATEGORIES },
          limit: { type: "integer", minimum: 1, maximum: 50 },
          workingDirectory: { type: "string" },
        },
        required: ["query"],
      },
      handler: (args) => {
        const root = resolveRoot(args.workingDirectory);
        const matches = queryWiki(root, asString(args.query, "query"), {
          tags: args.tags === undefined
            ? undefined
            : asStringArray(args.tags, "tags"),
          category: asOptionalCategory(args.category, "category"),
          limit: typeof args.limit === "number" ? args.limit : undefined,
        });
        return matches.map((m) => ({
          filename: m.page.filename,
          title: m.page.frontmatter.title,
          category: m.page.frontmatter.category,
          tags: m.page.frontmatter.tags,
          score: m.score,
          snippet: m.snippet,
        }));
      },
    },
    {
      name: "wiki_lint",
      description:
        "Run health checks on the wiki. Detects orphan pages, stale content, " +
        "broken cross-references, oversized pages, and structural contradictions.",
      inputSchema: {
        type: "object",
        properties: {
          workingDirectory: { type: "string" },
        },
      },
      handler: (args) => {
        const root = resolveRoot(args.workingDirectory);
        const report = lintWiki(root);
        return report;
      },
    },
    {
      name: "wiki_add",
      description:
        "Quick-add a wiki page. Simpler than wiki_ingest — creates a single " +
        "page directly and fails if the slug already exists.",
      inputSchema: {
        type: "object",
        properties: {
          title: { type: "string" },
          content: { type: "string" },
          tags: { type: "array", items: { type: "string" } },
          category: { type: "string", enum: WIKI_CATEGORIES },
          workingDirectory: { type: "string" },
        },
        required: ["title", "content"],
      },
      handler: (args) => {
        const root = resolveRoot(args.workingDirectory);
        const title = asString(args.title, "title");
        const slug = titleToSlug(title);
        if (readPage(root, slug)) {
          return {
            ok: false,
            error: `Page "${slug}" already exists. Use wiki_ingest to merge or wiki_delete first.`,
          };
        }
        const result = ingestKnowledge(root, {
          title,
          content: asString(args.content, "content"),
          tags: args.tags === undefined
            ? []
            : asStringArray(args.tags, "tags"),
          category: asOptionalCategory(args.category, "category") ?? "reference",
        });
        return { ok: true, filename: result.created[0] };
      },
    },
    {
      name: "wiki_list",
      description:
        "List all wiki pages with summaries. Reads the auto-maintained index.",
      inputSchema: {
        type: "object",
        properties: {
          workingDirectory: { type: "string" },
        },
      },
      handler: (args) => {
        const root = resolveRoot(args.workingDirectory);
        const index = readIndex(root);
        const pages = listPages(root);
        return { count: pages.length, pages, index };
      },
    },
    {
      name: "wiki_read",
      description:
        "Read a specific wiki page by filename (without the .md extension is OK).",
      inputSchema: {
        type: "object",
        properties: {
          page: { type: "string" },
          workingDirectory: { type: "string" },
        },
        required: ["page"],
      },
      handler: (args) => {
        const root = resolveRoot(args.workingDirectory);
        const raw = asString(args.page, "page");
        const filename = raw.endsWith(".md") ? raw : `${raw}.md`;
        const page = readPage(root, filename);
        if (!page) return { ok: false, error: `Wiki page not found: ${filename}` };
        return {
          ok: true,
          filename,
          frontmatter: page.frontmatter,
          content: page.content,
        };
      },
    },
    {
      name: "wiki_delete",
      description: "Delete a wiki page by filename.",
      inputSchema: {
        type: "object",
        properties: {
          page: { type: "string" },
          workingDirectory: { type: "string" },
        },
        required: ["page"],
      },
      handler: (args) => {
        const root = resolveRoot(args.workingDirectory);
        const raw = asString(args.page, "page");
        const filename = raw.endsWith(".md") ? raw : `${raw}.md`;
        const deleted = deletePage(root, filename);
        if (!deleted) {
          return { ok: false, error: `Wiki page not found: ${filename}` };
        }
        appendLog(root, {
          timestamp: new Date().toISOString(),
          operation: "delete",
          pagesAffected: [filename],
          summary: `Deleted page "${filename}"`,
        });
        return { ok: true, filename };
      },
    },
  ],
}).catch((err) => {
  console.error(err);
  process.exit(1);
});
