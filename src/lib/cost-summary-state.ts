// Cost-summary state — per-iteration outer-loop cost tracking for omcp.
//
// ADR-C1 Option C: mode.ts post-spawn callback writes one CostSummaryEntry per
// outer-loop iteration so HUD column 6 (v1.9) can surface AI Credits consumed.
//
// Invariant 1: assertSafeSlug on sessionId at every sink that builds a path.
// Invariant 2: atomicWriteFileSync for all cost-summary state writes.
//
// State file: .omcp/state/<sessionId>/cost-summary.json

import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { atomicWriteFileSync } from "../runtime/atomic-write.js";
import { assertSafeSlug } from "../runtime/safe-slug.js";
import { getOmcpRoot } from "./worktree-paths.js";

// ──────────────────────────────────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────────────────────────────────

/** One outer-loop iteration's cost record. */
export interface CostSummaryEntry {
  /** 1-based iteration counter. */
  iterationNumber: number;
  /** Wall-clock duration of the spawn (milliseconds). */
  durationMs: number;
  /** Copilot process exit code (0 = clean). */
  exitCode: number;
  /**
   * Estimated AI Credits consumed during this iteration.
   *
   * Schema-first placeholder: always 0 in v1.8. Real tracking lands in v1.9
   * when the HUD column-6 work reads actual token counters from Copilot output.
   */
  estimatedCost: number;
  /** The omcp mode name (e.g. "ralph"). */
  modeName: string;
  /**
   * PRD progress at the time of this entry, or null when no PRD is present.
   */
  prdProgress: { completed: number; total: number } | null;
  /** ISO timestamp when this entry was written. */
  timestamp: string;
}

/** Full cost-summary state for one omcp session. */
export interface CostSummaryState {
  /** UUID of the omcp session that produced these entries. */
  sessionId: string;
  /** Ordered list of per-iteration cost entries (appended on each spawn). */
  entries: CostSummaryEntry[];
}

// ──────────────────────────────────────────────────────────────────────────
// File path
// ──────────────────────────────────────────────────────────────────────────

const COST_SUMMARY_FILENAME = "cost-summary.json";

function costSummaryPath(sessionId: string, worktreeRoot?: string): string {
  // Invariant 1: assertSafeSlug on sessionId.
  assertSafeSlug(sessionId, "sessionId");
  return join(getOmcpRoot(worktreeRoot), "state", sessionId, COST_SUMMARY_FILENAME);
}

// ──────────────────────────────────────────────────────────────────────────
// State CRUD
// ──────────────────────────────────────────────────────────────────────────

/**
 * Append a cost entry for one outer-loop iteration.
 *
 * Creates the session state directory if absent. Reads existing state before
 * writing so entries accumulate across iterations. Invariant 2: uses
 * atomicWriteFileSync.
 *
 * Does NOT throw on write failure — callers must handle the returned boolean
 * or catch errors in a non-blocking wrapper.
 */
export function writeCostSummary(
  sessionId: string,
  entry: CostSummaryEntry,
  worktreeRoot?: string,
): boolean {
  // Invariant 1: assertSafeSlug is called inside costSummaryPath. Call it
  // BEFORE the try/catch so UnsafeSlugError propagates to the caller rather
  // than being silently swallowed as a write failure.
  const path = costSummaryPath(sessionId, worktreeRoot);
  const dir = join(getOmcpRoot(worktreeRoot), "state", sessionId);
  try {
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    let state: CostSummaryState;
    if (existsSync(path)) {
      try {
        const parsed = JSON.parse(readFileSync(path, "utf-8")) as Partial<CostSummaryState>;
        if (
          typeof parsed.sessionId === "string" &&
          Array.isArray(parsed.entries)
        ) {
          state = { sessionId: parsed.sessionId, entries: parsed.entries };
        } else {
          state = { sessionId, entries: [] };
        }
      } catch {
        state = { sessionId, entries: [] };
      }
    } else {
      state = { sessionId, entries: [] };
    }

    state.entries.push(entry);
    // Invariant 2: atomicWriteFileSync.
    atomicWriteFileSync(path, JSON.stringify(state, null, 2));
    return true;
  } catch {
    return false;
  }
}

/**
 * Read the cost-summary state for a session.
 *
 * Returns null when the file is absent or cannot be parsed.
 */
export function readCostSummary(
  sessionId: string,
  worktreeRoot?: string,
): CostSummaryState | null {
  // Invariant 1: call before try/catch so UnsafeSlugError propagates.
  const path = costSummaryPath(sessionId, worktreeRoot);
  try {
    if (!existsSync(path)) return null;
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as Partial<CostSummaryState>;
    if (
      typeof parsed.sessionId !== "string" ||
      !Array.isArray(parsed.entries)
    ) {
      return null;
    }
    return { sessionId: parsed.sessionId, entries: parsed.entries };
  } catch {
    return null;
  }
}

/**
 * Sum the estimatedCost field across all entries in a cost-summary state.
 *
 * Returns 0 when the entries array is empty. In v1.8 all costs are 0
 * (schema-first); this function is the correct aggregation point for v1.9.
 */
export function getEstimatedCostTotal(state: CostSummaryState): number {
  return state.entries.reduce((sum, e) => sum + e.estimatedCost, 0);
}
