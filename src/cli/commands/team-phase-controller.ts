// team-phase-controller.ts — Phase L2.5b / v1.3 extension / v2.1 P1 extension
//
// runTeamCollect(sessionId): inspect shard files + pidfile health, then
// transition the team session to 'completed', 'failed', or 'fixing'.
//
// v1.3 (L2.5b ext): when all shards are present, perform a dry-run merge via
// mergeShards(). If MergeReport.conflicts is non-empty, transition to 'fixing'
// instead of 'completed' and write conflicts.json for human/future-bot
// resolution. Automatic conflict resolution is OUT OF SCOPE for v1.3 (v1.4+).
//
// v2.1 (US-omcp-parity-P1-COLLECT-needsfix-shortcircuit): when ANY worker has
// a worker-K-verify-fail.json signal (written by `omcp team-verify` per Story
// 2 of v2.1 N+1), short-circuit into 'fixing' instead of 'completed'. The
// merge-conflict path is preserved; when BOTH verify-fail AND merge-conflict
// are present the team STAYS in 'fixing' and writes BOTH conflicts.json AND
// verify-fail-summary.json so downstream fix-worker spawn (Story 4) has full
// context.
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

/**
 * One entry from a worker-K-verify-fail.json signal file written by
 * `omcp team-verify` (Story 2). Schema is the source of truth for what Story
 * 3 reads — keep aligned with src/cli/commands/team-verify.ts.
 */
export interface VerifyFailSignal {
  workerIndex: number;
  iteration: number;
  ts: string;
  failedTools: string[];
  reportPath: string;
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
  /**
   * Verify-fail signals harvested from worker-K-verify-fail.json files (v2.1
   * P1 extension). Populated when team-verify wrote signals; consumed by
   * Story 4 fix-worker spawn.
   */
  verifyFailSignals?: VerifyFailSignal[];
  /** Log lines for --verbose / test inspection. */
  logLines: string[];
}

/**
 * Scan pidDir for `worker-K-verify-fail.json` signal files and parse them.
 *
 * Malformed JSON or missing required fields are skipped with a log line —
 * the caller decides whether that's enough to transition; one bad signal
 * doesn't poison the entire batch. Exported for direct unit-testing.
 */
/**
 * Default max-fix-loops bound when no env / report value is available.
 * Mirrors team-verify's DEFAULT_MAX_LOOPS — kept in sync via the
 * resolveMaxFixLoops helper here and resolveMaxLoops there.
 */
const COLLECT_DEFAULT_MAX_LOOPS = 3;

/**
 * Resolve the max-fix-loops bound for the team-collect Story 5 gate.
 * Precedence: env OMCP_TEAM_MAX_FIX_LOOPS > the latest verify-report-N.json's
 * max_fix_loops value > COLLECT_DEFAULT_MAX_LOOPS (3). Exported for tests.
 */
export function resolveMaxFixLoops(
  reportMaxLoops?: number,
  env: NodeJS.ProcessEnv = process.env,
): number {
  const fromEnv = env.OMCP_TEAM_MAX_FIX_LOOPS;
  if (fromEnv !== undefined && fromEnv !== "") {
    const n = Number(fromEnv);
    if (Number.isFinite(n) && n > 0) return n;
  }
  if (
    reportMaxLoops !== undefined &&
    Number.isFinite(reportMaxLoops) &&
    reportMaxLoops > 0
  ) {
    return reportMaxLoops;
  }
  return COLLECT_DEFAULT_MAX_LOOPS;
}

/**
 * Read the `max_fix_loops` field from the highest-numbered verify-report-N.json
 * in `pidDir`. Returns undefined when no report exists or the file is
 * unparseable. Defensive — corrupt reports do not poison the bound.
 */
export function readLatestReportMaxLoops(pidDir: string): number | undefined {
  if (!existsSync(pidDir)) return undefined;
  let latestN = 0;
  let latestPath: string | undefined;
  for (const f of readdirSync(pidDir)) {
    const m = /^verify-report-(\d+)\.json$/.exec(f);
    if (!m) continue;
    const n = Number(m[1]);
    if (Number.isFinite(n) && n > latestN) {
      latestN = n;
      latestPath = join(pidDir, f);
    }
  }
  if (!latestPath) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(latestPath, "utf8")) as {
      max_fix_loops?: number;
    };
    if (
      typeof parsed.max_fix_loops === "number" &&
      Number.isFinite(parsed.max_fix_loops) &&
      parsed.max_fix_loops > 0
    ) {
      return parsed.max_fix_loops;
    }
  } catch {
    // ignore — corrupt report falls back to default
  }
  return undefined;
}

/**
 * Build the `transitionPhase` reason annotation for a `fixing` transition.
 * Reports BOTH merge-conflict and verify-fail counts so the stage_history
 * record (and any postmortem inspection) accurately reflects all triggers.
 * Returns "0 verify-fail signal(s) detected" or similar only when both
 * counts are zero — which should be unreachable since we only reach this
 * branch when the controller picked `fixing`.
 *
 * Exported for direct unit-testing.
 */
export function buildFixingReason(conflictCount: number, signalCount: number): string {
  const parts: string[] = [];
  if (conflictCount > 0) parts.push(`${conflictCount} merge conflict(s)`);
  if (signalCount > 0) parts.push(`${signalCount} verify-fail signal(s)`);
  if (parts.length === 0) {
    // Defensive: should never happen (fixing implies at least one trigger).
    return "fixing trigger (unspecified)";
  }
  return `${parts.join(" + ")} detected`;
}

export function readVerifyFailSignals(
  pidDir: string,
  onWarn?: (msg: string) => void,
): VerifyFailSignal[] {
  if (!existsSync(pidDir)) return [];
  const out: VerifyFailSignal[] = [];
  for (const f of readdirSync(pidDir)) {
    const m = /^worker-(\d+)-verify-fail\.json$/.exec(f);
    if (!m) continue;
    const idx = Number(m[1]);
    try {
      const raw = readFileSync(join(pidDir, f), "utf8");
      const parsed = JSON.parse(raw) as Partial<VerifyFailSignal>;
      if (
        typeof parsed.workerIndex !== "number" ||
        typeof parsed.iteration !== "number" ||
        typeof parsed.ts !== "string" ||
        !Array.isArray(parsed.failedTools) ||
        typeof parsed.reportPath !== "string"
      ) {
        onWarn?.(`[team-collect] malformed verify-fail signal at ${f} — skipping`);
        continue;
      }
      out.push({
        workerIndex: parsed.workerIndex,
        iteration: parsed.iteration,
        ts: parsed.ts,
        failedTools: parsed.failedTools.filter(
          (s): s is string => typeof s === "string",
        ),
        reportPath: parsed.reportPath,
      });
    } catch (err) {
      onWarn?.(
        `[team-collect] failed to read verify-fail signal at ${f}: ${(err as Error).message} — skipping (idx=${idx})`,
      );
    }
  }
  return out.sort((a, b) => a.workerIndex - b.workerIndex);
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

  // Story 3 (v2.1 P1): harvest worker-K-verify-fail.json signals written by
  // `omcp team-verify`. The signal set's lifecycle is owned by team-verify:
  // signals exist iff the latest verify pass failed (team-verify clears stale
  // signals at the start of every run). Story 3 only READS — never mutates.
  const verifyFailSignals = readVerifyFailSignals(pidDir, (m) => logLines.push(m));
  const hasVerifyFail = verifyFailSignals.length > 0;
  // Tracks whether the signals actually drove a transition (vs being observed
  // but suppressed by the allShardsPresent gate). Only the "triggered" case
  // gets reported on TeamCollectReport — see GATE NOTE below.
  let verifyFailTriggered = false;
  // Story 5: tracks whether the fix-loop bound was hit and the transition
  // went directly to 'failed' (reason: verify_loop_exhausted) without writing
  // a fresh verify-fail-summary.json — the summary is moot when no further
  // fix-spawn will run.
  let verifyFailExhausted = false;

  // Determine target phase.
  let targetPhase: TeamPhase;
  let mergeConflicts: MergeConflict[] | undefined;

  if (allShardsPresent) {
    // All shards present — run merge to detect conflicts (v1.3 ext).
    // When teamName is not provided, skip conflict detection (v1.2.0 compat).
    if (teamName !== undefined) {
      // v1.3 review MINOR (Critic): catch mergeShards crashes so a merge
      // failure doesn't propagate as an uncaught throw through runTeamCollect.
      // Treat merge failure as "no conflicts detected, but logged" — caller
      // can re-run after investigation. Phase advances to 'completed' so the
      // session isn't stuck.
      let mergeReport: ReturnType<typeof mergeShards>;
      try {
        mergeReport = mergeShards(teamName, cwd);
      } catch (err) {
        logLines.push(
          `[team-collect] warning: mergeShards threw for team='${teamName}': ${(err as Error).message} — treating as zero conflicts; investigate manually`,
        );
        // Synthesize an empty MergeReport so downstream logic can treat the
        // crash as "no conflicts" and progress to 'completed' rather than
        // leaving the session stuck in 'executing'.
        mergeReport = {
          mergedAt: new Date().toISOString(),
          teamName,
          shardsProcessed: 0,
          storiesUpdated: 0,
          workers: [],
          conflicts: [],
        };
      }
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

    // Story 3 short-circuit: if any verify-fail signal is present, override
    // 'completed' → 'fixing'. If we're already in 'fixing' from a merge
    // conflict, stay 'fixing' and write BOTH artifacts so the fix-worker
    // (Story 4) has full context for both problem classes.
    //
    // GATE NOTE (critic MAJOR-2 mitigation): this block lives INSIDE
    // `if (allShardsPresent)` by design. team-verify (Story 2) writes signal
    // files only AFTER all workers' shards have landed and the verify pass
    // executed; signals therefore cannot legitimately exist while workers
    // are still running. If a stale signal file did appear pre-shard-completion
    // (manual write, broken external tooling), the safer interpretation is to
    // leave the team in `executing` and let workers finish — at which point
    // team-verify's clear-on-start removes the stale signal before the next
    // verify pass. Promoting verify-fail to a pre-shard transition would let
    // a single corrupt file derail an otherwise-healthy in-flight team.
    if (hasVerifyFail) {
      verifyFailTriggered = true;
      // Story 5 primary gate: if fix_loop_count has reached max_fix_loops,
      // transition directly to 'failed' with reason 'verify_loop_exhausted'
      // instead of advancing into 'fixing'. spawnFixWorker carries its own
      // defense-in-depth check, but this gate prevents the team from even
      // appearing as fix-needed when the loop is exhausted.
      const currentFixLoops = state.fix_loop_count ?? 0;
      const reportMaxLoops = readLatestReportMaxLoops(pidDir);
      const effectiveMaxLoops = resolveMaxFixLoops(reportMaxLoops);
      const loopExhausted = currentFixLoops >= effectiveMaxLoops;
      if (loopExhausted) {
        targetPhase = "failed";
        verifyFailExhausted = true;
        logLines.push(
          `[team-collect] verify-fail signals present BUT fix_loop_count (${currentFixLoops}) >= max_fix_loops (${effectiveMaxLoops}) — transitioning to 'failed' (reason: verify_loop_exhausted)`,
        );
      } else if (targetPhase === "completed") {
        targetPhase = "fixing";
        logLines.push(
          `[team-collect] ${verifyFailSignals.length} worker(s) have verify-fail signal(s) (loop ${currentFixLoops}/${effectiveMaxLoops}) — overriding 'completed' → 'fixing'`,
        );
      } else if (targetPhase === "fixing") {
        logLines.push(
          `[team-collect] verify-fail signals present alongside merge conflicts (loop ${currentFixLoops}/${effectiveMaxLoops}) — staying in 'fixing' with both artifacts`,
        );
      }
      // Write verify-fail-summary.json regardless of whether we got here via
      // a fresh `completed → fixing` flip or a pre-existing conflicts path.
      // Story 5 exception: skip the summary write when the bound was
      // exhausted — no fix-spawn will read it, and a fresh summary at this
      // point would be misleading postmortem evidence.
      if (!verifyFailExhausted) {
        const summaryPath = join(pidDir, "verify-fail-summary.json");
        try {
          mkdirSync(pidDir, { recursive: true });
          atomicWriteFileSync(
            summaryPath,
            JSON.stringify(
              {
                detectedAt: new Date().toISOString(),
                sessionId,
                signalCount: verifyFailSignals.length,
                signals: verifyFailSignals,
              },
              null,
              2,
            ),
          );
          logLines.push(
            `[team-collect] verify-fail summary written to ${summaryPath} — fix-worker will read from here`,
          );
        } catch {
          logLines.push(
            `[team-collect] warning: failed to write verify-fail-summary.json to ${summaryPath}`,
          );
        }
      }
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
          ? buildFixingReason(
              mergeConflicts?.length ?? 0,
              hasVerifyFail ? verifyFailSignals.length : 0,
            )
          : verifyFailExhausted
            ? "verify_loop_exhausted"
            : "dead worker(s) without shard";
    // Story 21 — team-loop idempotence: skip the phase transition when
    // already at the target phase (e.g., a re-run while already in 'fixing'
    // with fresh verify-fail signals). VALID_TEAM_TRANSITIONS rejects
    // self-transitions like 'fixing' → 'fixing'; the team-loop auto-
    // orchestrator legitimately revisits the same phase across iterations,
    // so re-emit the same finalPhase without churning the state machine.
    if (currentPhase === targetPhase) {
      logLines.push(
        `[team-collect] already in target phase '${targetPhase}' — skipping idempotent transition (${reason})`,
      );
      finalPhase = targetPhase;
    } else {
      const updated = transitionPhase(sessionId, targetPhase, reason);
      finalPhase = updated.current_phase ?? targetPhase;
    }
  }

  return {
    sessionId,
    finalPhase,
    workers,
    allShardsPresent,
    hasDeadWithoutShard,
    mergeConflicts,
    verifyFailSignals: verifyFailTriggered ? verifyFailSignals : undefined,
    logLines,
  };
}
