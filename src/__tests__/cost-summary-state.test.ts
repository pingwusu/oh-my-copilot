// Deterministic tests for src/lib/cost-summary-state.ts (ADR-C1 Option C).
//
// Invariant 1: assertSafeSlug on sessionId.
// Invariant 2: atomicWriteFileSync for all writes (verified via no .tmp residue).

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  type CostSummaryEntry,
  type CostSummaryState,
  getEstimatedCostTotal,
  readCostSummary,
  writeCostSummary,
} from "../lib/cost-summary-state.js";
import { UnsafeSlugError } from "../runtime/safe-slug.js";

// ── helpers ──────────────────────────────────────────────────────────────────

function makeEntry(overrides: Partial<CostSummaryEntry> = {}): CostSummaryEntry {
  return {
    iterationNumber: 1,
    durationMs: 1234,
    exitCode: 0,
    estimatedCost: 0,
    modeName: "ralph",
    prdProgress: null,
    timestamp: new Date().toISOString(),
    ...overrides,
  };
}

// ── setup / teardown ─────────────────────────────────────────────────────────

let tmp: string;
let cwdSnapshot: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "omcp-cost-summary-"));
  mkdirSync(join(tmp, ".omcp", "state"), { recursive: true });
  cwdSnapshot = process.cwd();
  process.chdir(tmp);
});

afterEach(() => {
  process.chdir(cwdSnapshot);
  rmSync(tmp, { recursive: true, force: true });
});

// ── tests ────────────────────────────────────────────────────────────────────

describe("cost-summary-state", () => {
  it("test 1: writeCostSummary creates file at correct path", () => {
    const sessionId = "session-abc123";
    const entry = makeEntry();
    const ok = writeCostSummary(sessionId, entry);

    expect(ok).toBe(true);
    const expectedPath = join(tmp, ".omcp", "state", sessionId, "cost-summary.json");
    expect(existsSync(expectedPath)).toBe(true);

    const parsed = JSON.parse(readFileSync(expectedPath, "utf-8")) as CostSummaryState;
    expect(parsed.sessionId).toBe(sessionId);
    expect(parsed.entries).toHaveLength(1);
    expect(parsed.entries[0]!.iterationNumber).toBe(1);
    expect(parsed.entries[0]!.modeName).toBe("ralph");
  });

  it("test 2: writeCostSummary appends across multiple calls (multi-iteration)", () => {
    const sessionId = "session-multi";

    writeCostSummary(sessionId, makeEntry({ iterationNumber: 1 }));
    writeCostSummary(sessionId, makeEntry({ iterationNumber: 2, exitCode: 0, durationMs: 5000 }));
    writeCostSummary(sessionId, makeEntry({ iterationNumber: 3, exitCode: 1, durationMs: 100 }));

    const state = readCostSummary(sessionId);
    expect(state).not.toBeNull();
    expect(state!.entries).toHaveLength(3);
    expect(state!.entries[0]!.iterationNumber).toBe(1);
    expect(state!.entries[1]!.iterationNumber).toBe(2);
    expect(state!.entries[2]!.iterationNumber).toBe(3);
    expect(state!.entries[2]!.exitCode).toBe(1);
  });

  it("test 3: readCostSummary returns null when file absent", () => {
    const result = readCostSummary("session-nonexistent");
    expect(result).toBeNull();
  });

  it("test 4: readCostSummary parses valid file correctly", () => {
    const sessionId = "session-parse-test";
    const prdProgress = { completed: 2, total: 5 };
    const entry = makeEntry({
      iterationNumber: 7,
      durationMs: 9999,
      exitCode: 0,
      estimatedCost: 0,
      modeName: "ralph",
      prdProgress,
    });

    writeCostSummary(sessionId, entry);
    const state = readCostSummary(sessionId);

    expect(state).not.toBeNull();
    expect(state!.sessionId).toBe(sessionId);
    expect(state!.entries).toHaveLength(1);
    const e = state!.entries[0]!;
    expect(e.iterationNumber).toBe(7);
    expect(e.durationMs).toBe(9999);
    expect(e.prdProgress).toEqual(prdProgress);
    expect(e.modeName).toBe("ralph");
  });

  it("test 5: getEstimatedCostTotal sums estimatedCost across entries", () => {
    const state: CostSummaryState = {
      sessionId: "sum-test",
      entries: [
        makeEntry({ estimatedCost: 0 }),
        makeEntry({ estimatedCost: 0 }),
        makeEntry({ estimatedCost: 0 }),
      ],
    };
    // v1.8 schema-first: all zeros → total is 0.
    expect(getEstimatedCostTotal(state)).toBe(0);

    // Verify logic works with non-zero values (future v1.9 real tracking).
    const withCosts: CostSummaryState = {
      sessionId: "sum-test-2",
      entries: [
        makeEntry({ estimatedCost: 1.5 }),
        makeEntry({ estimatedCost: 2.75 }),
        makeEntry({ estimatedCost: 0.25 }),
      ],
    };
    expect(getEstimatedCostTotal(withCosts)).toBeCloseTo(4.5);
  });

  it("test 6: getEstimatedCostTotal returns 0 for empty entries", () => {
    const state: CostSummaryState = { sessionId: "empty", entries: [] };
    expect(getEstimatedCostTotal(state)).toBe(0);
  });

  it("test 7: assertSafeSlug rejects unsafe sessionId (Invariant 1)", () => {
    // Path traversal via sessionId must throw UnsafeSlugError.
    expect(() => writeCostSummary("../escape", makeEntry())).toThrow(UnsafeSlugError);
    expect(() => writeCostSummary("ab/cd", makeEntry())).toThrow(UnsafeSlugError);
    expect(() => readCostSummary("../../pwned")).toThrow(UnsafeSlugError);
  });

  it("test 8: atomicWriteFileSync leaves no .tmp residue on success (Invariant 2)", () => {
    const sessionId = "session-atomic";
    writeCostSummary(sessionId, makeEntry());

    const sessionDir = join(tmp, ".omcp", "state", sessionId);
    const files = readdirSync(sessionDir);
    // Atomic rename: no .tmp. fragment files should remain.
    expect(files.some((f) => f.includes(".tmp."))).toBe(false);
    // The real file must be present.
    expect(files).toContain("cost-summary.json");
  });
});
