/**
 * Tests for progress.txt rolling-tail size cap (Phase L3.1).
 *
 * Covers:
 *   1. Cap honored: repeated appends keep file <= cap bytes
 *   2. Rolling tail: oldest entries dropped, newest preserved
 *   3. Single entry larger than cap: bounded to cap bytes
 *   4. Entry boundary respect: truncation lands on a ## header line
 *   5. Cap configurable via OMCP_PROGRESS_MAX_BYTES env var
 *   6. getRalphContext returns post-truncation content (not stale)
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  appendProgressNote,
  truncateProgressContent,
  getRalphContext,
} from "../lib/ralph-state.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), "omcp-progress-cap-"));
}

function progressFilePath(dir: string): string {
  return join(dir, ".omcp", "progress.txt");
}

function readProgress(dir: string): string {
  const p = progressFilePath(dir);
  return existsSync(p) ? readFileSync(p, "utf-8") : "";
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

let cwd: string;
const originalEnv = process.env["OMCP_PROGRESS_MAX_BYTES"];

beforeEach(() => {
  cwd = makeTmpDir();
  delete process.env["OMCP_PROGRESS_MAX_BYTES"];
});

afterEach(() => {
  rmSync(cwd, { recursive: true, force: true });
  if (originalEnv === undefined) {
    delete process.env["OMCP_PROGRESS_MAX_BYTES"];
  } else {
    process.env["OMCP_PROGRESS_MAX_BYTES"] = originalEnv;
  }
});

// ---------------------------------------------------------------------------
// Unit: truncateProgressContent
// ---------------------------------------------------------------------------

describe("truncateProgressContent", () => {
  it("returns content unchanged when within cap", () => {
    const content = "## 2026-01-01T00:00:00.000Z\nsome note\n\n";
    expect(truncateProgressContent(content, 1024)).toBe(content);
  });

  it("truncates to the last ## boundary that fits within cap", () => {
    const entry1 = "## 2026-01-01T00:00:00.000Z\nfirst entry body\n\n";
    const entry2 = "## 2026-01-02T00:00:00.000Z\nsecond entry body\n\n";
    const entry3 = "## 2026-01-03T00:00:00.000Z\nthird entry body\n\n";
    const content = entry1 + entry2 + entry3;

    // Cap sized to fit entry2 + entry3 but not all three
    const cap = Buffer.byteLength(entry2 + entry3, "utf-8") + 5;
    const result = truncateProgressContent(content, cap);

    expect(result).not.toContain("first entry body");
    expect(result).toContain("second entry body");
    expect(result).toContain("third entry body");
    expect(result.startsWith("##")).toBe(true);
  });

  it("falls back to raw tail bytes when no ## boundary fits", () => {
    // A single large entry with no sub-boundaries
    const bigEntry = "## 2026-01-01T00:00:00.000Z\n" + "x".repeat(200) + "\n\n";
    const cap = 50;
    const result = truncateProgressContent(bigEntry, cap);

    expect(Buffer.byteLength(result, "utf-8")).toBeLessThanOrEqual(cap);
  });
});

// ---------------------------------------------------------------------------
// Integration: appendProgressNote with cap
// ---------------------------------------------------------------------------

describe("appendProgressNote — cap honored", () => {
  it("1. file stays <= 64 KiB after 200 KB of appends (default cap)", () => {
    // Each note is ~1 KB; append 200 of them
    const note = "x".repeat(1000);
    for (let i = 0; i < 200; i++) {
      appendProgressNote(note, cwd, `iter-${i}`);
    }

    const content = readProgress(cwd);
    const bytes = Buffer.byteLength(content, "utf-8");
    expect(bytes).toBeLessThanOrEqual(65536);
  });

  it("2. rolling tail: first entries dropped, latest entries preserved", () => {
    // Write entries that together exceed the cap; only the newest should remain
    const note = "a".repeat(15000); // ~15 KB per entry
    const ids = ["A", "B", "C", "D", "E", "F"];
    for (const id of ids) {
      appendProgressNote(note, cwd, id);
    }

    const content = readProgress(cwd);
    // "A" and "B" entries should have been evicted; "E" and "F" should remain
    expect(content).not.toContain("— A");
    expect(content).not.toContain("— B");
    expect(content).toContain("— E");
    expect(content).toContain("— F");
  });

  it("3. single entry larger than cap is still bounded", () => {
    process.env["OMCP_PROGRESS_MAX_BYTES"] = "100";
    const bigNote = "z".repeat(500);
    const result = appendProgressNote(bigNote, cwd);
    expect(result).toBe(true);

    const content = readProgress(cwd);
    const bytes = Buffer.byteLength(content, "utf-8");
    expect(bytes).toBeLessThanOrEqual(100);
  });

  it("4. truncation lands on a ## header (entry boundary respected)", () => {
    // Write several entries so truncation is triggered
    const note = "b".repeat(20000);
    for (let i = 0; i < 5; i++) {
      appendProgressNote(note, cwd, `story-${i}`);
    }

    const content = readProgress(cwd);
    // After truncation the file must start with a ## header (never mid-entry)
    expect(content.trimStart().startsWith("##")).toBe(true);
  });

  it("5. cap is configurable via OMCP_PROGRESS_MAX_BYTES", () => {
    process.env["OMCP_PROGRESS_MAX_BYTES"] = "500";
    const note = "c".repeat(200);
    for (let i = 0; i < 10; i++) {
      appendProgressNote(note, cwd, `iter-${i}`);
    }

    const content = readProgress(cwd);
    const bytes = Buffer.byteLength(content, "utf-8");
    expect(bytes).toBeLessThanOrEqual(500);
  });

  it("6. getRalphContext returns post-truncation content (not stale)", () => {
    process.env["OMCP_PROGRESS_MAX_BYTES"] = "500";
    // Write entries that exceed the cap
    const note = "d".repeat(200);
    for (let i = 0; i < 5; i++) {
      appendProgressNote(note, cwd, `note-${i}`);
    }

    const ctx = getRalphContext(cwd);
    // Context must include progress-notes tag
    expect(ctx).toContain("<progress-notes>");

    // Extract what is between the tags
    const match = ctx.match(/<progress-notes>([\s\S]*?)<\/progress-notes>/);
    expect(match).not.toBeNull();
    const progressSection = match![1]!;

    // The section should be within 500 bytes (+ small whitespace tolerance)
    const bytes = Buffer.byteLength(progressSection.trim(), "utf-8");
    expect(bytes).toBeLessThanOrEqual(600); // slight tolerance for trim/newlines
  });
});
