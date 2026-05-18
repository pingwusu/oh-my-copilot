// Unit tests for the wiki engine (storage / ingest / query / lint).
// Self-contained: each test gets its own tmpdir with OMCP_WIKI_ROOT pointed
// at a fresh `.omcp/` so no two suites share state.

import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  appendLog,
  deletePage,
  ensureWikiDir,
  getWikiDir,
  listPages,
  parseFrontmatter,
  readIndex,
  readLog,
  readPage,
  serializePage,
  titleToSlug,
  updateIndexUnsafe,
  withWikiLock,
  writePage,
  writePageUnsafe,
} from "../hooks/wiki/storage.js";
import { ingestKnowledge } from "../hooks/wiki/ingest.js";
import { queryWiki, tokenize } from "../hooks/wiki/query.js";
import { lintWiki } from "../hooks/wiki/lint.js";
import { WIKI_SCHEMA_VERSION } from "../hooks/wiki/types.js";
import type { WikiPage } from "../hooks/wiki/types.js";

function makePage(overrides: Partial<WikiPage> = {}): WikiPage {
  return {
    filename: "test-page.md",
    frontmatter: {
      title: "Test Page",
      tags: ["test"],
      created: "2025-01-01T00:00:00.000Z",
      updated: "2025-01-01T00:00:00.000Z",
      sources: [],
      links: [],
      category: "reference",
      confidence: "medium",
      schemaVersion: WIKI_SCHEMA_VERSION,
    },
    content: "\n# Test Page\n\nSome content here.\n",
    ...overrides,
  };
}

describe("wiki engine", () => {
  let tempDir: string;
  let savedEnv: string | undefined;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "omcp-wiki-engine-"));
    savedEnv = process.env.OMCP_WIKI_ROOT;
    delete process.env.OMCP_WIKI_ROOT;
  });

  afterEach(() => {
    if (savedEnv === undefined) delete process.env.OMCP_WIKI_ROOT;
    else process.env.OMCP_WIKI_ROOT = savedEnv;
    rmSync(tempDir, { recursive: true, force: true });
  });

  // -------- storage --------

  it("getWikiDir returns <root>/.omcp/wiki", () => {
    expect(getWikiDir(tempDir)).toBe(join(tempDir, ".omcp", "wiki"));
  });

  it("ensureWikiDir creates the dir and seeds .gitignore", () => {
    const dir = ensureWikiDir(tempDir);
    expect(existsSync(dir)).toBe(true);
    const gi = readFileSync(join(tempDir, ".omcp", ".gitignore"), "utf-8");
    expect(gi).toContain("wiki/");
  });

  it("titleToSlug normalises punctuation, length and CJK-only titles", () => {
    expect(titleToSlug("Auth Architecture")).toBe("auth-architecture.md");
    expect(titleToSlug("Hello, World!")).toBe("hello-world.md");
    expect(titleToSlug("---test---")).toBe("test.md");
    // 100 chars → 64 + .md = 67
    expect(titleToSlug("a".repeat(100)).length).toBeLessThanOrEqual(67);
    // CJK-only should hash, not collapse to empty .md
    const slug = titleToSlug("인증 아키텍처");
    expect(slug.startsWith("page-")).toBe(true);
    expect(slug.endsWith(".md")).toBe(true);
  });

  it("serialize + parse roundtrip preserves the page", () => {
    const page = makePage({
      frontmatter: { ...makePage().frontmatter, title: 'My "Special" Page' },
    });
    const parsed = parseFrontmatter(serializePage(page));
    expect(parsed).not.toBeNull();
    expect(parsed!.frontmatter.title).toBe('My "Special" Page');
    expect(parsed!.content).toBe(page.content);
  });

  it("writePage + readPage roundtrip and rejects path traversal", () => {
    writePage(tempDir, makePage());
    const read = readPage(tempDir, "test-page.md");
    expect(read).not.toBeNull();
    expect(read!.frontmatter.title).toBe("Test Page");
    expect(readPage(tempDir, "../../etc/passwd")).toBeNull();
    expect(deletePage(tempDir, "../important.txt")).toBe(false);
    expect(() =>
      writePage(tempDir, makePage({ filename: "../../evil.md" })),
    ).toThrow(/Invalid wiki page filename/);
  });

  it("writePageUnsafe refuses reserved filenames", () => {
    expect(() =>
      withWikiLock(tempDir, () =>
        writePageUnsafe(tempDir, makePage({ filename: "index.md" })),
      ),
    ).toThrow(/reserved wiki file/);
    expect(() =>
      withWikiLock(tempDir, () =>
        writePageUnsafe(tempDir, makePage({ filename: "log.md" })),
      ),
    ).toThrow(/reserved wiki file/);
  });

  it("listPages excludes reserved files; deletePage removes pages", () => {
    writePage(tempDir, makePage({ filename: "a.md" }));
    writePage(tempDir, makePage({ filename: "b.md" }));
    expect(listPages(tempDir)).toEqual(["a.md", "b.md"]);
    expect(deletePage(tempDir, "a.md")).toBe(true);
    expect(deletePage(tempDir, "a.md")).toBe(false);
    expect(listPages(tempDir)).toEqual(["b.md"]);
  });

  it("appendLog creates and appends log.md", () => {
    ensureWikiDir(tempDir);
    appendLog(tempDir, {
      timestamp: "2025-01-01T00:00:00.000Z",
      operation: "add",
      pagesAffected: ["a.md"],
      summary: "first",
    });
    appendLog(tempDir, {
      timestamp: "2025-01-02T00:00:00.000Z",
      operation: "delete",
      pagesAffected: ["b.md"],
      summary: "second",
    });
    const log = readLog(tempDir);
    expect(log).toContain("first");
    expect(log).toContain("second");
  });

  it("updateIndexUnsafe groups pages by category", () => {
    writePage(
      tempDir,
      makePage({
        filename: "arch.md",
        frontmatter: {
          ...makePage().frontmatter,
          title: "Arch",
          category: "architecture",
        },
      }),
    );
    writePage(
      tempDir,
      makePage({
        filename: "ref.md",
        frontmatter: {
          ...makePage().frontmatter,
          title: "Ref",
          category: "reference",
        },
      }),
    );
    withWikiLock(tempDir, () => updateIndexUnsafe(tempDir));
    const index = readIndex(tempDir);
    expect(index).toContain("## architecture");
    expect(index).toContain("## reference");
    expect(index).toContain("[Arch](arch.md)");
    expect(index).toContain("[Ref](ref.md)");
  });

  it("withWikiLock returns the callback value and propagates errors", () => {
    expect(withWikiLock(tempDir, () => 42)).toBe(42);
    expect(() =>
      withWikiLock(tempDir, () => {
        throw new Error("nope");
      }),
    ).toThrow("nope");
  });

  // -------- ingest --------

  it("ingestKnowledge creates a new page", () => {
    const result = ingestKnowledge(tempDir, {
      title: "Auth Architecture",
      content: "JWT-based.",
      tags: ["auth", "architecture"],
      category: "architecture",
    });
    expect(result.created).toEqual(["auth-architecture.md"]);
    expect(result.updated).toEqual([]);
    const page = readPage(tempDir, "auth-architecture.md");
    expect(page!.frontmatter.tags).toEqual(["auth", "architecture"]);
  });

  it("ingestKnowledge merges on slug collision (tags union, content append)", () => {
    ingestKnowledge(tempDir, {
      title: "Merge Target",
      content: "Original.",
      tags: ["a"],
      category: "architecture",
    });
    const r = ingestKnowledge(tempDir, {
      title: "Merge Target",
      content: "Updated.",
      tags: ["b"],
      category: "architecture",
    });
    expect(r.created).toEqual([]);
    expect(r.updated).toEqual(["merge-target.md"]);
    const page = readPage(tempDir, "merge-target.md");
    expect(page!.content).toContain("Original.");
    expect(page!.content).toContain("Updated.");
    expect(page!.content).toContain("## Update");
    expect(page!.frontmatter.tags).toEqual(expect.arrayContaining(["a", "b"]));
  });

  it("ingestKnowledge keeps the higher confidence on merge", () => {
    ingestKnowledge(tempDir, {
      title: "C",
      content: "x",
      tags: [],
      category: "reference",
      confidence: "high",
    });
    ingestKnowledge(tempDir, {
      title: "C",
      content: "y",
      tags: [],
      category: "reference",
      confidence: "low",
    });
    expect(readPage(tempDir, "c.md")!.frontmatter.confidence).toBe("high");
  });

  it("ingestKnowledge extracts [[wiki-links]] into frontmatter", () => {
    ingestKnowledge(tempDir, {
      title: "Linker",
      content: "See [[Auth Architecture]] and [[Database Schema]].",
      tags: [],
      category: "reference",
    });
    const links = readPage(tempDir, "linker.md")!.frontmatter.links;
    expect(links).toEqual(
      expect.arrayContaining(["auth-architecture.md", "database-schema.md"]),
    );
  });

  // -------- query --------

  it("queryWiki matches by title, content, tag, sorts by score and respects limit", () => {
    for (let i = 0; i < 5; i++) {
      writePage(
        tempDir,
        makePage({
          filename: `p-${i}.md`,
          frontmatter: {
            ...makePage().frontmatter,
            title: `Test Page ${i}`,
            tags: ["common"],
          },
          content: `\n# x\n\ncommon keyword here.\n`,
        }),
      );
    }
    writePage(
      tempDir,
      makePage({
        filename: "auth.md",
        frontmatter: {
          ...makePage().frontmatter,
          title: "Auth Architecture",
          tags: ["auth", "common"],
        },
        content: "\n# Auth\n\nFull auth documentation.\n",
      }),
    );

    const byCommon = queryWiki(tempDir, "common", { limit: 3 });
    expect(byCommon.length).toBeLessThanOrEqual(3);
    expect(byCommon[0].score).toBeGreaterThanOrEqual(
      byCommon[byCommon.length - 1].score,
    );

    const byTitle = queryWiki(tempDir, "auth architecture");
    expect(byTitle[0].page.filename).toBe("auth.md");

    const filtered = queryWiki(tempDir, "anything", { tags: ["auth"] });
    expect(filtered.length).toBe(1);
    expect(filtered[0].page.filename).toBe("auth.md");
  });

  it("tokenize handles latin, CJK bi-grams, cyrillic and rejects punctuation", () => {
    const latin = tokenize("Hello World");
    expect(latin).toContain("hello");
    expect(latin).toContain("world");

    const ko = tokenize("인증");
    expect(ko).toContain("인");
    expect(ko).toContain("증");
    expect(ko).toContain("인증");

    const ru = tokenize("привет мир");
    expect(ru).toContain("привет");
    expect(ru).toContain("мир");

    const punct = tokenize("jwt-based foo.bar C++");
    expect(punct).toContain("jwt");
    expect(punct).toContain("based");
    expect(punct).not.toContain("-");
    expect(punct).not.toContain(".");
    expect(punct).not.toContain("++");
  });

  it("queryWiki finds CJK content via bi-gram tokenization", () => {
    writePage(
      tempDir,
      makePage({
        filename: "ko.md",
        frontmatter: {
          ...makePage().frontmatter,
          title: "인증 아키텍처",
          tags: ["인증"],
        },
        content: "\n# 인증 아키텍처\n\nJWT 기반 인증 흐름 설명.\n",
      }),
    );
    const results = queryWiki(tempDir, "인증");
    expect(results.length).toBe(1);
    expect(results[0].page.filename).toBe("ko.md");
  });

  // -------- lint --------

  it("lintWiki flags orphans, broken refs, low confidence, oversized pages", () => {
    writePage(tempDir, makePage({ filename: "orphan.md" }));
    writePage(
      tempDir,
      makePage({
        filename: "linker.md",
        frontmatter: {
          ...makePage().frontmatter,
          links: ["non-existent.md"],
        },
      }),
    );
    writePage(
      tempDir,
      makePage({
        filename: "low.md",
        frontmatter: { ...makePage().frontmatter, confidence: "low" },
      }),
    );
    writePage(
      tempDir,
      makePage({
        filename: "big.md",
        content: "x".repeat(15_000),
      }),
    );

    const report = lintWiki(tempDir);
    expect(report.stats.orphanCount).toBeGreaterThanOrEqual(1);
    expect(report.stats.brokenRefCount).toBeGreaterThanOrEqual(1);
    expect(report.stats.lowConfidenceCount).toBeGreaterThanOrEqual(1);
    expect(report.stats.oversizedCount).toBeGreaterThanOrEqual(1);
  });

  it("lintWiki detects structural contradictions on shared slug prefix", () => {
    writePage(
      tempDir,
      makePage({
        filename: "auth-impl-flow.md",
        frontmatter: {
          ...makePage().frontmatter,
          title: "Flow",
          tags: ["auth"],
          category: "architecture",
          confidence: "high",
        },
      }),
    );
    writePage(
      tempDir,
      makePage({
        filename: "auth-impl-tokens.md",
        frontmatter: {
          ...makePage().frontmatter,
          title: "Tokens",
          tags: ["auth"],
          category: "architecture",
          confidence: "low",
        },
      }),
    );
    const report = lintWiki(tempDir);
    expect(report.stats.contradictionCount).toBeGreaterThanOrEqual(1);
  });
});
