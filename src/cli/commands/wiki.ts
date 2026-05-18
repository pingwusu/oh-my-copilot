// `omcp wiki <subcommand>` — CLI surface for the wiki MCP tools.
// Mirrors omx's `omx wiki` verb (mcpParityCommand / loadWikiDescriptor).
//
// Subcommands (with friendly aliases matching omx's aliases):
//   ingest <title> <content> <tags-csv> <category> [--confidence=high|medium|low]
//   query  <text> [--tags=<csv>] [--category=<cat>] [--limit=N]
//   lint
//   add    <title> <content> [--tags=<csv>] [--category=<cat>]
//   list
//   read   <page>
//   delete <page>
//
// wiki_ingest / wiki_query / wiki_lint / wiki_add / wiki_list / wiki_read /
// wiki_delete are accepted as exact MCP tool-name aliases.
//
// Working directory defaults to process.cwd(); set OMCP_WIKI_ROOT to override.

import {
  appendLog,
  deletePage,
  listPages,
  readIndex,
  readPage,
  titleToSlug,
} from "../../hooks/wiki/storage.js";
import { ingestKnowledge } from "../../hooks/wiki/ingest.js";
import { queryWiki } from "../../hooks/wiki/query.js";
import { lintWiki } from "../../hooks/wiki/lint.js";
import type { WikiCategory } from "../../hooks/wiki/types.js";
import { isAbsolute, resolve } from "node:path";

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

function resolveRoot(): string {
  const env = process.env["OMCP_WIKI_ROOT"];
  if (env) return isAbsolute(env) ? env : resolve(process.cwd(), env);
  return process.cwd();
}

function parseTagsCsv(raw: string): string[] {
  return raw.split(",").map((t) => t.trim()).filter(Boolean);
}

function flagValue(args: string[], flag: string): string | undefined {
  const entry = args.find((a) => a.startsWith(`--${flag}=`));
  return entry ? entry.slice(`--${flag}=`.length) : undefined;
}

// ── Subcommand implementations ───────────────────────────────────────────────

function cmdIngest(args: string[]): void {
  const positional = args.filter((a) => !a.startsWith("--"));
  const [title, content, tagsCsv, category] = positional;
  if (!title || !content || !tagsCsv || !category) {
    console.error(
      "omcp wiki ingest: <title> <content> <tags-csv> <category> are required\n" +
      `  categories: ${WIKI_CATEGORIES.join(", ")}`,
    );
    process.exitCode = 2;
    return;
  }
  if (!WIKI_CATEGORIES.includes(category as WikiCategory)) {
    console.error(`omcp wiki ingest: category must be one of: ${WIKI_CATEGORIES.join(", ")}`);
    process.exitCode = 2;
    return;
  }
  const confidenceRaw = flagValue(args, "confidence");
  if (confidenceRaw && !(CONFIDENCE_LEVELS as readonly string[]).includes(confidenceRaw)) {
    console.error(`omcp wiki ingest: --confidence must be one of: ${CONFIDENCE_LEVELS.join(", ")}`);
    process.exitCode = 2;
    return;
  }
  const root = resolveRoot();
  const result = ingestKnowledge(root, {
    title,
    content,
    tags: parseTagsCsv(tagsCsv),
    category: category as WikiCategory,
    confidence: confidenceRaw as Confidence | undefined,
  });
  console.log(JSON.stringify(result, null, 2));
}

function cmdQuery(args: string[]): void {
  const query = args.find((a) => !a.startsWith("--"));
  if (!query) {
    console.error("omcp wiki query: <text> is required");
    process.exitCode = 2;
    return;
  }
  const tagsRaw = flagValue(args, "tags");
  const category = flagValue(args, "category") as WikiCategory | undefined;
  const limitRaw = flagValue(args, "limit");
  if (category && !WIKI_CATEGORIES.includes(category)) {
    console.error(`omcp wiki query: --category must be one of: ${WIKI_CATEGORIES.join(", ")}`);
    process.exitCode = 2;
    return;
  }
  const root = resolveRoot();
  const matches = queryWiki(root, query, {
    tags: tagsRaw ? parseTagsCsv(tagsRaw) : undefined,
    category,
    limit: limitRaw ? parseInt(limitRaw, 10) : undefined,
  });
  console.log(JSON.stringify(
    matches.map((m) => ({
      filename: m.page.filename,
      title: m.page.frontmatter.title,
      category: m.page.frontmatter.category,
      tags: m.page.frontmatter.tags,
      score: m.score,
      snippet: m.snippet,
    })),
    null,
    2,
  ));
}

function cmdLint(): void {
  const root = resolveRoot();
  const report = lintWiki(root);
  console.log(JSON.stringify(report, null, 2));
}

function cmdAdd(args: string[]): void {
  const positional = args.filter((a) => !a.startsWith("--"));
  const [title, content] = positional;
  if (!title || !content) {
    console.error("omcp wiki add: <title> <content> are required");
    process.exitCode = 2;
    return;
  }
  const tagsRaw = flagValue(args, "tags");
  const categoryRaw = flagValue(args, "category") as WikiCategory | undefined;
  if (categoryRaw && !WIKI_CATEGORIES.includes(categoryRaw)) {
    console.error(`omcp wiki add: --category must be one of: ${WIKI_CATEGORIES.join(", ")}`);
    process.exitCode = 2;
    return;
  }
  const root = resolveRoot();
  const slug = titleToSlug(title);
  if (readPage(root, slug)) {
    console.log(JSON.stringify({
      ok: false,
      error: `Page "${slug}" already exists. Use wiki ingest to merge or wiki delete first.`,
    }));
    process.exitCode = 1;
    return;
  }
  const result = ingestKnowledge(root, {
    title,
    content,
    tags: tagsRaw ? parseTagsCsv(tagsRaw) : [],
    category: categoryRaw ?? "reference",
  });
  console.log(JSON.stringify({ ok: true, filename: result.created[0] }));
}

function cmdList(): void {
  const root = resolveRoot();
  const index = readIndex(root);
  const pages = listPages(root);
  console.log(JSON.stringify({ count: pages.length, pages, index }, null, 2));
}

function cmdRead(args: string[]): void {
  const page = args.find((a) => !a.startsWith("--"));
  if (!page) {
    console.error("omcp wiki read: <page> is required");
    process.exitCode = 2;
    return;
  }
  const root = resolveRoot();
  const filename = page.endsWith(".md") ? page : `${page}.md`;
  const result = readPage(root, filename);
  if (!result) {
    console.log(JSON.stringify({ ok: false, error: `Wiki page not found: ${filename}` }));
    process.exitCode = 1;
    return;
  }
  console.log(JSON.stringify({ ok: true, filename, frontmatter: result.frontmatter, content: result.content }, null, 2));
}

function cmdDelete(args: string[]): void {
  const page = args.find((a) => !a.startsWith("--"));
  if (!page) {
    console.error("omcp wiki delete: <page> is required");
    process.exitCode = 2;
    return;
  }
  const root = resolveRoot();
  const filename = page.endsWith(".md") ? page : `${page}.md`;
  const deleted = deletePage(root, filename);
  if (!deleted) {
    console.log(JSON.stringify({ ok: false, error: `Wiki page not found: ${filename}` }));
    process.exitCode = 1;
    return;
  }
  appendLog(root, {
    timestamp: new Date().toISOString(),
    operation: "delete",
    pagesAffected: [filename],
    summary: `Deleted page "${filename}"`,
  });
  console.log(JSON.stringify({ ok: true, filename }));
}

// ── Dispatch ─────────────────────────────────────────────────────────────────

const HELP = [
  "Usage: omcp wiki <subcommand> [args]",
  "",
  "Subcommands:",
  "  ingest <title> <content> <tags-csv> <category>  Ingest knowledge into the wiki",
  "  query  <text> [--tags=<csv>] [--category=<cat>] [--limit=N]  Search wiki pages",
  "  lint                                             Health-check the wiki",
  "  add    <title> <content> [--tags=<csv>] [--category=<cat>]   Quick-add a page",
  "  list                                             List all pages",
  "  read   <page>                                    Read a page by slug/filename",
  "  delete <page>                                    Delete a page",
  "",
  `Categories: ${WIKI_CATEGORIES.join(", ")}`,
].join("\n");

export function runWikiCommand(args: string[]): void {
  const [sub, ...rest] = args;

  switch (sub) {
    case "ingest":
    case "wiki_ingest":
      cmdIngest(rest);
      return;
    case "query":
    case "wiki_query":
      cmdQuery(rest);
      return;
    case "lint":
    case "wiki_lint":
      cmdLint();
      return;
    case "add":
    case "wiki_add":
      cmdAdd(rest);
      return;
    case "list":
    case "wiki_list":
      cmdList();
      return;
    case "read":
    case "wiki_read":
      cmdRead(rest);
      return;
    case "delete":
    case "wiki_delete":
      cmdDelete(rest);
      return;
    default: {
      console.log(HELP);
      if (sub && sub !== "--help" && sub !== "-h" && sub !== "help") {
        console.error(`\nomcp wiki: unknown subcommand '${sub}'`);
        process.exitCode = 2;
      }
    }
  }
}
