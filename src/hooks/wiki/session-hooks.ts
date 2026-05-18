/**
 * Wiki Session Hooks
 *
 * Hook entry points that omcp's hook runtime can call:
 *
 *   - onSessionStart: load wiki context, lazy index rebuild,
 *                     feed omcp project-memory into wiki environment.md
 *   - onSessionEnd:   bounded append-only capture of session metadata
 *   - onPreCompact:   inject wiki summary for compaction survival
 *
 * Config is loaded from `.omcp-config.json` (under cwd) or from
 * `$OMCP_CONFIG_DIR/.omcp-config.json` (defaults to `~/.copilot/`).
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  getWikiDir,
  readIndex,
  readPage,
  readAllPages,
  listPages,
  withWikiLock,
  writePageUnsafe,
  updateIndexUnsafe,
  appendLogUnsafe,
} from "./storage.js";
import { WIKI_SCHEMA_VERSION, DEFAULT_WIKI_CONFIG } from "./types.js";
import type { WikiConfig } from "./types.js";

/** Resolve the omcp user config dir (env override -> `~/.copilot/`). */
function getOmcpConfigDir(): string {
  return process.env.OMCP_CONFIG_DIR ?? join(homedir(), ".copilot");
}

/**
 * Load wiki config from `.omcp-config.json`.
 * Returns defaults if config doesn't exist or wiki section is missing.
 */
function loadWikiConfig(root: string): WikiConfig {
  try {
    const localConfig = join(root, ".omcp-config.json");
    const userConfig = join(getOmcpConfigDir(), ".omcp-config.json");
    for (const path of [localConfig, userConfig]) {
      if (existsSync(path)) {
        const raw = JSON.parse(readFileSync(path, "utf-8")) as {
          wiki?: Partial<WikiConfig>;
        };
        if (raw?.wiki) {
          return { ...DEFAULT_WIKI_CONFIG, ...raw.wiki };
        }
      }
    }
  } catch {
    // Ignore config errors, use defaults
  }
  return DEFAULT_WIKI_CONFIG;
}

/**
 * SessionStart hook: inject wiki context into session.
 */
export function onSessionStart(data: { cwd?: string }): {
  additionalContext?: string;
} {
  try {
    const root = data.cwd || process.cwd();
    const wikiDir = getWikiDir(root);

    if (!existsSync(wikiDir)) {
      return {};
    }

    const pages = listPages(root);
    if (pages.length > 0) {
      const indexContent = readIndex(root);
      if (!indexContent) {
        withWikiLock(root, () => {
          updateIndexUnsafe(root);
        });
      }
    }

    feedProjectMemory(root);

    const index = readIndex(root);
    if (!index || pages.length === 0) return {};

    const summary = [
      `[LLM Wiki: ${pages.length} pages at .omcp/wiki/]`,
      "",
      "Use wiki_query to search, wiki_list to browse, wiki_read to view pages.",
      "",
      index.split("\n").slice(0, 30).join("\n"),
    ].join("\n");

    return { additionalContext: summary };
  } catch {
    return {};
  }
}

/**
 * SessionEnd hook: bounded append-only capture of session metadata.
 */
export function onSessionEnd(data: {
  cwd?: string;
  session_id?: string;
}): { continue: boolean } {
  const startTime = Date.now();
  const TIMEOUT_MS = 3_000;

  try {
    const root = data.cwd || process.cwd();
    const config = loadWikiConfig(root);

    if (!config.autoCapture) {
      return { continue: true };
    }

    const wikiDir = getWikiDir(root);
    if (!existsSync(wikiDir)) {
      return { continue: true };
    }

    const sessionId = data.session_id || `session-${Date.now()}`;
    const now = new Date().toISOString();
    const dateSlug = now.split("T")[0];
    const filename = `session-log-${dateSlug}-${sessionId.slice(-8)}.md`;

    withWikiLock(root, () => {
      if (Date.now() - startTime > TIMEOUT_MS) return;

      writePageUnsafe(root, {
        filename,
        frontmatter: {
          title: `Session Log ${dateSlug}`,
          tags: ["session-log", "auto-captured"],
          created: now,
          updated: now,
          sources: [sessionId],
          links: [],
          category: "session-log",
          confidence: "medium",
          schemaVersion: WIKI_SCHEMA_VERSION,
        },
        content:
          `\n# Session Log ${dateSlug}\n\nAuto-captured session metadata.\n` +
          `Session ID: ${sessionId}\n\nReview and promote significant findings ` +
          `to curated wiki pages via \`wiki_ingest\`.\n`,
      });

      appendLogUnsafe(root, {
        timestamp: now,
        operation: "ingest",
        pagesAffected: [filename],
        summary: `Auto-captured session log for ${sessionId}`,
      });
    });
  } catch {
    // Silently fail — session end should never block
  }

  return { continue: true };
}

/** PreCompact hook: inject wiki summary for compaction survival. */
export function onPreCompact(data: { cwd?: string }): {
  additionalContext?: string;
} {
  try {
    const root = data.cwd || process.cwd();
    const pages = listPages(root);

    if (pages.length === 0) return {};

    const allPages = readAllPages(root);
    const categories = [
      ...new Set(allPages.map((p) => p.frontmatter.category)),
    ];
    const latestUpdate =
      allPages
        .map((p) => p.frontmatter.updated)
        .sort()
        .reverse()[0] || "unknown";

    return {
      additionalContext: `[Wiki: ${pages.length} pages | categories: ${categories.join(
        ", ",
      )} | last updated: ${latestUpdate}]`,
    };
  } catch {
    return {};
  }
}

/**
 * Feed omcp project-memory auto-detected facts into wiki environment.md.
 *
 * omcp's project-memory file (`.omcp/project-memory.json`) is shaped as
 * `{ notes: [], directives: [], data: {} }`. We project the most recent
 * notes/directives plus the `data` map into a human-readable environment page.
 *
 * Best-effort; failures are swallowed.
 */
function feedProjectMemory(root: string): void {
  try {
    const pmPath = join(root, ".omcp", "project-memory.json");
    if (!existsSync(pmPath)) return;

    const pm = JSON.parse(readFileSync(pmPath, "utf-8")) as {
      notes?: Array<{ t: string; text: string }>;
      directives?: Array<{ t: string; text: string }>;
      data?: Record<string, unknown>;
    };

    const lastTimestamp =
      [...(pm.notes ?? []), ...(pm.directives ?? [])]
        .map((entry) => entry.t)
        .sort()
        .reverse()[0] || null;
    if (!lastTimestamp) return;

    const envSlug = "environment.md";
    const existing = readPage(root, envSlug);
    if (existing) {
      const existingTime = new Date(existing.frontmatter.updated).getTime();
      const pmTime = new Date(lastTimestamp).getTime();
      if (existingTime >= pmTime) return;
    }

    const lines: string[] = ["\n# Project Environment\n"];
    if (pm.directives && pm.directives.length > 0) {
      lines.push("## Directives", "");
      for (const d of pm.directives.slice(-10)) {
        lines.push(`- ${d.text}`);
      }
      lines.push("");
    }
    if (pm.notes && pm.notes.length > 0) {
      lines.push("## Notes", "");
      for (const n of pm.notes.slice(-10)) {
        lines.push(`- ${n.text}`);
      }
      lines.push("");
    }
    if (pm.data && Object.keys(pm.data).length > 0) {
      lines.push("## Data", "");
      for (const [k, v] of Object.entries(pm.data)) {
        lines.push(`- **${k}:** \`${JSON.stringify(v)}\``);
      }
      lines.push("");
    }

    const now = new Date().toISOString();

    withWikiLock(root, () => {
      writePageUnsafe(root, {
        filename: envSlug,
        frontmatter: {
          title: "Project Environment",
          tags: ["environment", "auto-detected"],
          created: existing?.frontmatter.created || now,
          updated: now,
          sources: ["omcp-project-memory"],
          links: [],
          category: "environment",
          confidence: "high",
          schemaVersion: WIKI_SCHEMA_VERSION,
        },
        content: lines.join("\n"),
      });
      updateIndexUnsafe(root);
    });
  } catch {
    // Silently fail — project-memory feeding is best-effort
  }
}
