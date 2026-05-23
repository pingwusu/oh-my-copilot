// Team shard state — per-worker PRD shard writes + end-of-session merge.
//
// Each worker writes its story results to:
//   .omcp/state/team-shards/<sanitized-worker-name>-prd-shard.json
//
// The merge step reads all shards, reconciles story updates into the canonical
// PRD (via writePrd), and writes a conflict audit at:
//   .omcp/state/team-shards/merge-report.json
//
// Conflict semantics: when two shards disagree on `passes` for the same story
// id, the shard that flips passes from false→true wins (optimistic). When both
// are true the first shard (alphabetical by worker name) wins and the conflict
// is recorded. The original PRD story fields (title, description, etc.) are
// preserved; only `passes` and `notes` are updated from shards.
//
// All file I/O uses atomicWriteFileSync (invariant 2).
// All worker-name inputs are validated via assertSafeSlug (invariant 3).

import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { atomicWriteFileSync } from "../runtime/atomic-write.js";
import { assertSafeSlug } from "../runtime/safe-slug.js";
import { getOmcpRoot } from "./worktree-paths.js";
import { readPrd, writePrd } from "./ralph-state.js";
import type { PRD, UserStory } from "./ralph-state.js";

// ──────────────────────────────────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────────────────────────────────

/** A single worker's shard: subset of story results. */
export interface PrdShard {
  /** Worker name (used as the shard file slug). */
  workerName: string;
  /** ISO timestamp when the shard was written. */
  writtenAt: string;
  /** Story results reported by this worker. */
  stories: ShardStory[];
}

/** Worker-reported result for a single story. */
export interface ShardStory {
  id: string;
  passes: boolean;
  notes?: string;
}

/** Conflict record written into merge-report.json. */
export interface MergeConflict {
  storyId: string;
  /** Worker name that won the conflict resolution. */
  winner: string;
  /** Other workers that disagreed. */
  losers: string[];
  winnerPasses: boolean;
  loserPasses: boolean[];
}

/** Full merge report written to .omcp/state/team-shards/merge-report.json. */
export interface MergeReport {
  mergedAt: string;
  teamName: string;
  shardsProcessed: number;
  storiesUpdated: number;
  conflicts: MergeConflict[];
  /** Worker names whose shards were merged. */
  workers: string[];
}

// ──────────────────────────────────────────────────────────────────────────
// Paths
// ──────────────────────────────────────────────────────────────────────────

const SHARDS_DIR_NAME = "team-shards";
const MERGE_REPORT_FILENAME = "merge-report.json";

export function getShardsDir(worktreeRoot?: string): string {
  return join(getOmcpRoot(worktreeRoot), "state", SHARDS_DIR_NAME);
}

export function getShardFilePath(workerName: string, worktreeRoot?: string): string {
  assertSafeSlug(workerName, "workerName");
  return join(getShardsDir(worktreeRoot), `${workerName}-prd-shard.json`);
}

export function getMergeReportPath(worktreeRoot?: string): string {
  return join(getShardsDir(worktreeRoot), MERGE_REPORT_FILENAME);
}

// ──────────────────────────────────────────────────────────────────────────
// Shard write
// ──────────────────────────────────────────────────────────────────────────

/**
 * Write a worker's PRD shard atomically.
 *
 * `workerName` is validated via assertSafeSlug — throws UnsafeSlugError on
 * invalid input. Returns true on success, false if the write fails.
 */
export function writeShardState(
  workerName: string,
  stories: ShardStory[],
  worktreeRoot?: string,
): boolean {
  assertSafeSlug(workerName, "workerName");
  const dir = getShardsDir(worktreeRoot);
  try {
    mkdirSync(dir, { recursive: true });
    const shard: PrdShard = {
      workerName,
      writtenAt: new Date().toISOString(),
      stories,
    };
    atomicWriteFileSync(getShardFilePath(workerName, worktreeRoot), JSON.stringify(shard, null, 2));
    return true;
  } catch {
    return false;
  }
}

/** Read a single shard file, returning null on missing/malformed. */
export function readShardState(workerName: string, worktreeRoot?: string): PrdShard | null {
  assertSafeSlug(workerName, "workerName");
  const file = getShardFilePath(workerName, worktreeRoot);
  if (!existsSync(file)) return null;
  try {
    const parsed = JSON.parse(readFileSync(file, "utf-8")) as Partial<PrdShard>;
    if (
      typeof parsed.workerName !== "string" ||
      typeof parsed.writtenAt !== "string" ||
      !Array.isArray(parsed.stories)
    ) return null;
    return parsed as PrdShard;
  } catch {
    return null;
  }
}

// ──────────────────────────────────────────────────────────────────────────
// Shard discovery
// ──────────────────────────────────────────────────────────────────────────

/**
 * List all `*-prd-shard.json` files in the shards directory.
 * Returns worker names (without the `-prd-shard.json` suffix), sorted
 * alphabetically for deterministic conflict resolution.
 */
export function listShardWorkers(worktreeRoot?: string): string[] {
  const dir = getShardsDir(worktreeRoot);
  if (!existsSync(dir)) return [];
  try {
    return readdirSync(dir)
      .filter((f) => f.endsWith("-prd-shard.json") && f !== MERGE_REPORT_FILENAME)
      .map((f) => f.replace(/-prd-shard\.json$/, ""))
      .sort();
  } catch {
    return [];
  }
}

// ──────────────────────────────────────────────────────────────────────────
// Merge
// ──────────────────────────────────────────────────────────────────────────

/**
 * Merge all shards for `teamName` into the canonical PRD.
 *
 * Conflict resolution: among workers that disagree on a story, the one that
 * sets passes=true wins (optimistic merge). When all agree on true or all
 * agree on false, no conflict is recorded. When multiple workers set
 * passes=true the alphabetically first worker name wins and others are logged
 * as losers with the same winnerPasses/loserPasses=true.
 *
 * Returns the MergeReport. If no canonical PRD exists, returns a report with
 * storiesUpdated=0 and a note in conflicts describing the missing PRD.
 */
export function mergeShards(teamName: string, worktreeRoot?: string): MergeReport {
  assertSafeSlug(teamName, "teamName");

  const workers = listShardWorkers(worktreeRoot);
  const shards: PrdShard[] = [];
  for (const w of workers) {
    const s = readShardState(w, worktreeRoot);
    if (s) shards.push(s);
  }

  const report: MergeReport = {
    mergedAt: new Date().toISOString(),
    teamName,
    shardsProcessed: shards.length,
    storiesUpdated: 0,
    conflicts: [],
    workers,
  };

  const prd = readPrd(worktreeRoot);
  if (!prd) {
    writeMergeReport(report, worktreeRoot);
    return report;
  }

  // Build a map: storyId → list of (workerName, ShardStory)
  const storyMap = new Map<string, Array<{ worker: string; entry: ShardStory }>>();
  for (const shard of shards) {
    for (const entry of shard.stories) {
      if (!storyMap.has(entry.id)) storyMap.set(entry.id, []);
      storyMap.get(entry.id)!.push({ worker: shard.workerName, entry });
    }
  }

  const updatedStories = prd.userStories.map((story) => {
    const reports = storyMap.get(story.id);
    if (!reports || reports.length === 0) return story;

    const trueWorkers = reports.filter((r) => r.entry.passes);
    const falseWorkers = reports.filter((r) => !r.entry.passes);

    let winner: { worker: string; entry: ShardStory };

    if (trueWorkers.length > 0 && falseWorkers.length > 0) {
      // Conflict: some say pass, some say fail → optimistic: true wins
      winner = trueWorkers[0]; // already sorted alphabetically
      report.conflicts.push({
        storyId: story.id,
        winner: winner.worker,
        losers: falseWorkers.map((r) => r.worker),
        winnerPasses: true,
        loserPasses: falseWorkers.map(() => false),
      });
    } else if (trueWorkers.length > 1) {
      // Multiple workers agree on true — first alphabetically wins, record rest
      winner = trueWorkers[0];
      report.conflicts.push({
        storyId: story.id,
        winner: winner.worker,
        losers: trueWorkers.slice(1).map((r) => r.worker),
        winnerPasses: true,
        loserPasses: trueWorkers.slice(1).map(() => true),
      });
    } else {
      // All agree (or only one report) — no conflict
      winner = reports[0];
    }

    const updated: UserStory = {
      ...story,
      passes: winner.entry.passes,
    };
    if (winner.entry.notes !== undefined) updated.notes = winner.entry.notes;
    report.storiesUpdated += 1;
    return updated;
  });

  const mergedPrd: PRD = { ...prd, userStories: updatedStories };
  writePrd(mergedPrd, worktreeRoot);
  writeMergeReport(report, worktreeRoot);
  return report;
}

function writeMergeReport(report: MergeReport, worktreeRoot?: string): void {
  try {
    const dir = getShardsDir(worktreeRoot);
    mkdirSync(dir, { recursive: true });
    atomicWriteFileSync(getMergeReportPath(worktreeRoot), JSON.stringify(report, null, 2));
  } catch {
    // Best-effort; merge report is audit-only
  }
}
