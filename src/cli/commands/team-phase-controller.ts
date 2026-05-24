// team-phase-controller.ts — Phase L2.5b / v1.3 extension
//
// runTeamCollect(sessionId): inspect shard files + pidfile health, then
// transition the team session to 'completed', 'failed', or 'fixing'.
//
// v1.3 (L2.5b ext): when all shards are present, perform a dry-run merge via
// mergeShards(). If MergeReport.conflicts is non-empty, transition to 'fixing'
// instead of 'completed' and write conflicts.json for human/future-bot
// resolution. Automatic conflict resolution is OUT OF SCOPE for v1.3 (v1.4+).
//
// Crash-restart resume: if a TeamState is found with current_phase='executing'
// but no associated copilot process alive AND no shard written, detect + log.
// Re-spawning missing workers is OUT OF SCOPE for v1.2.0.
// TODO: re-spawn missing workers in crash-restart path (post-L2.6)

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
} from "node:fs";
import { join } from "node:path";

import { atomicWriteFileSync } from "../../runtime/atomic-write.js";
import { mergeShards, type MergeConflict } from "../../lib/team-shard-state.js";

import {
  readModeState,
  transitionPhase,
  type TeamPhase,
  type TeamState,
} from "../../runtime/mode-state.js";

export interface CollectWorkerResult {
  index: number;
  pid: number | null;
  alive: boolean;
  hasShard: boolean;
}

export interface TeamCollectReport {
  sessionId: string;
  /** Final phase after collect (or the existing phase if already terminal). */
  finalPhase: TeamPhase;
  workers: CollectWorkerResult[];
  /** True when all workers produced a shard (completed). */
  allShardsPresent: boolean;
  /** True when at least one worker pid is dead AND has no shard. */
  hasDeadWithoutShard: boolean;
  /**
   * Merge conflicts detected during shard merge, populated when finalPhase is
   * 'fixing'. Written to conflicts.json for human or future-bot resolution.
   */
  mergeConflicts?: MergeConflict[];
  /** Log lines for --verbose / test inspection. */
  logLines: string[];
}

/**
 * Inspect pidfiles and shard files for a team session and transition to
 * 'completed' (all shards present, no conflicts), 'fixing' (all shards present
 * but merge conflicts detected), or 'failed' (dead worker without shard).
 *
 * Idempotent: if the session is already in a terminal phase ('completed' or
 * 'failed'), returns immediately without attempting a second transition.
 *
 * teamName vs sessionId: `sessionId` is the team session UUID stored in
 * TeamState. `teamName` is the user-facing slug passed to `mergeShards()`.
 * They are different identifiers. When `teamName` is not provided, the merge
 * step is skipped and the session transitions directly to 'completed' (v1.2.0
 * behavior). Pass `teamName` to enable conflict detection (v1.3+).
 *
 * @param sessionId  The team session UUID.
 * @param opts       Test hooks for cwd and process-liveness check.
 */
export function runTeamCollect(
  sessionId: string,
  opts: {
    /** Override cwd for resolving .omcp paths (test hook). */
    cwd?: string;
    /** Test hook: override process-liveness check. */
    isProcessAlive?: (pid: number) => boolean;
    /**
     * User-facing team name slug passed to mergeShards() for conflict
     * detection. When omitted, conflict detection is skipped and the session
     * transitions to 'completed' directly (v1.2.0 behavior).
     */
    teamName?: string;
  } = {},
): TeamCollectReport {
  const cwd = opts.cwd ?? process.cwd();
  const teamName = opts.teamName;
  const isAlive =
    opts.isProcessAlive ??
    ((pid: number) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    });

  const logLines: string[] = [];

  // Read TeamState — may not exist (no session launched yet).
  const state = readModeState<TeamState>("team", sessionId);
  if (state === null) {
    logLines.push(`[team-collect] no TeamState found for session '${sessionId}'`);
    return {
      sessionId,
      finalPhase: "failed",
      workers: [],
      allShardsPresent: false,
      hasDeadWithoutShard: false,
      logLines,
    };
  }

  // Idempotent: if already terminal, return as-is.
  const currentPhase = state.current_phase ?? "executing";
  if (currentPhase === "completed" || currentPhase === "failed") {
    logLines.push(
      `[team-collect] session '${sessionId}' already in terminal phase '${currentPhase}' — no-op`,
    );
    return {
      sessionId,
      finalPhase: currentPhase,
      workers: [],
      allShardsPresent: currentPhase === "completed",
      hasDeadWithoutShard: currentPhase === "failed",
      logLines,
    };
  }

  const pidDir = join(cwd, ".omcp", "state", "team", sessionId);

  // Collect worker results from pidfiles.
  const workers: CollectWorkerResult[] = [];

  if (existsSync(pidDir)) {
    for (const f of readdirSync(pidDir)) {
      const m = /^worker-(\d+)\.pid$/.exec(f);
      if (!m) continue;
      const index = Number(m[1]);
      const pidPath = join(pidDir, f);

      let pid: number | null = null;
      try {
        const raw = readFileSync(pidPath, "utf8").trim();
        const parsed = Number(raw);
        if (Number.isFinite(parsed) && parsed > 0) pid = parsed;
      } catch {
        // Unreadable pidfile — treat as dead.
      }

      const alive = pid !== null ? isAlive(pid) : false;

      // Shard file: worker-K-shard.json under pidDir (consistent with watchdog).
      const shardFile = join(pidDir, `worker-${index}-shard.json`);
      const hasShard = existsSync(shardFile);

      workers.push({ index, pid, alive, hasShard });
    }
  }

  // Sort by index for deterministic ordering in reports / tests.
  workers.sort((a, b) => a.index - b.index);

  const allShardsPresent =
    workers.length > 0 && workers.every((w) => w.hasShard);
  const hasDeadWithoutShard = workers.some((w) => !w.alive && !w.hasShard);

  // Determine target phase.
  let targetPhase: TeamPhase;
  let mergeConflicts: MergeConflict[] | undefined;

  if (allShardsPresent) {
    // All shards present — run merge to detect conflicts (v1.3 ext).
    // When teamName is not provided, skip conflict detection (v1.2.0 compat).
    if (teamName !== undefined) {
      const mergeReport = mergeShards(teamName, cwd);
      if (mergeReport.conflicts.length > 0) {
        targetPhase = "fixing";
        mergeConflicts = mergeReport.conflicts;
        logLines.push(
          `[team-collect] all ${workers.length} worker(s) wrote shards — ${mergeReport.conflicts.length} merge conflict(s) detected — transitioning to 'fixing'`,
        );
        // Write conflicts.json for human or future-bot resolution (v1.4+).
        const conflictsPath = join(pidDir, "conflicts.json");
        try {
          mkdirSync(pidDir, { recursive: true });
          atomicWriteFileSync(
            conflictsPath,
            JSON.stringify(
              {
                detectedAt: new Date().toISOString(),
                sessionId,
                teamName,
                conflictCount: mergeReport.conflicts.length,
                conflicts: mergeReport.conflicts,
              },
              null,
              2,
            ),
          );
          logLines.push(
            `[team-collect] conflicts written to ${conflictsPath} — resolve manually or via v1.4 auto-resolution`,
          );
        } catch {
          logLines.push(
            `[team-collect] warning: failed to write conflicts.json to ${conflictsPath}`,
          );
        }
      } else {
        targetPhase = "completed";
        logLines.push(
          `[team-collect] all ${workers.length} worker(s) wrote shards, no merge conflicts — transitioning to 'completed'`,
        );
      }
    } else {
      targetPhase = "completed";
      logLines.push(
        `[team-collect] all ${workers.length} worker(s) wrote shards — transitioning to 'completed'`,
      );
    }
  } else if (hasDeadWithoutShard) {
    targetPhase = "failed";
    const deadWorkers = workers.filter((w) => !w.alive && !w.hasShard);
    for (const w of deadWorkers) {
      logLines.push(
        `[team-collect] worker-${w.index} (pid=${w.pid ?? "unknown"}) is dead without shard — crash detected`,
      );
    }
    logLines.push(
      `[team-collect] ${deadWorkers.length} dead worker(s) without shards — transitioning to 'failed'`,
    );
    // TODO: offer resume by re-spawning missing workers (post-L2.6)
    logLines.push(
      `[team-collect] crash-restart resume (re-spawn missing workers) is out of scope for v1.2.0`,
    );
  } else {
    // Workers still alive or no pidfiles found (tmux mode — no pidfiles).
    // Treat absence of piddir/pidfiles as not-yet-failed; leave as executing.
    targetPhase = "executing";
    logLines.push(
      `[team-collect] session still executing — ${workers.filter((w) => w.alive).length} alive, no failed workers detected`,
    );
  }

  // Transition when moving to a terminal phase or 'fixing'.
  let finalPhase: TeamPhase = currentPhase;
  if (
    targetPhase === "completed" ||
    targetPhase === "failed" ||
    targetPhase === "fixing"
  ) {
    const reason =
      targetPhase === "completed"
        ? "all shards present"
        : targetPhase === "fixing"
          ? `${mergeConflicts?.length ?? 0} merge conflict(s) detected`
          : "dead worker(s) without shard";
    const updated = transitionPhase(sessionId, targetPhase, reason);
    finalPhase = updated.current_phase ?? targetPhase;
  }

  return {
    sessionId,
    finalPhase,
    workers,
    allShardsPresent,
    hasDeadWithoutShard,
    mergeConflicts,
    logLines,
  };
}
