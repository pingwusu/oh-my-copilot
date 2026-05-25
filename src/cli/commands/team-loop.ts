// `omcp team-loop <session-id> [--max-loops N]` — post-v2.1 auto-orchestrator
// for the verify/fix loop.
//
// Why this exists (per ADR-omcp-team-loop-orchestrator.md): v2.1 ships
// the verify/fix PRIMITIVES (team-verify / team-collect / team-fix /
// team-ack --status) + the BOUND CHECK + the STATE CONTRACTS, but NOT
// the auto-iterating orchestrator that wires them into a self-driving
// loop. omc handles this via in-session Stop hooks; omcp can't (Copilot
// CLI has no equivalent hook surface). team-loop provides a single-
// process loop runner so an operator (or `omcp ralplan --chain`) can
// fire one command and walk away.
//
// Loop body:
//   1. runTeamVerify — fresh vitest/tsc/biome pass
//   2. runTeamCollect — observe finalPhase
//   3. dispatch:
//        completed → exit 0 (verify ok, no work needed)
//        failed    → exit 1 (loop-exhausted at the collect-side gate)
//        fixing    → spawnFixWorker → wait for fix-worker shard → loop
//        executing → unexpected (workers not done) → exit 1 with reason
//
// Bound: respects `resolveMaxLoops` (env OMCP_TEAM_MAX_FIX_LOOPS > opts >
// report.max_fix_loops > default 3). spawnFixWorker's defense-in-depth
// gate is consulted; if the gate fires the loop short-circuits to failed.
//
// Defensive: hard iteration bound = `maxLoops * 2 + 5` prevents an
// infinite loop if state contracts go sideways. Shard-wait deadline =
// 10 minutes by default (sufficient for any reasonable Copilot fix
// pass; tunable via opts.shardTimeoutMs).

import { existsSync } from "node:fs";
import { join } from "node:path";

import {
  readModeState,
  type TeamPhase,
  type TeamState,
} from "../../runtime/mode-state.js";
import {
  assertSafeSlug,
  UnsafeSlugError,
} from "../../runtime/safe-slug.js";
import {
  resolveMaxLoops,
  runTeamVerify,
  spawnFixWorker,
  type FixWorkerSpawnFn,
  type VerifySpawnFn,
} from "./team-verify.js";
import { runTeamCollect } from "./team-phase-controller.js";

export type TeamLoopExitCode = 0 | 1 | 2 | 3;

const DEFAULT_SHARD_TIMEOUT_MS = 600_000; // 10 min — Copilot fix-pass envelope
const SHARD_POLL_INTERVAL_MS = 2_000;

export interface RunTeamLoopOpts {
  sessionId: string;
  /** Override --max-loops; env > report > opts > default still applies. */
  maxLoops?: number;
  /** Override the wait-for-shard timeout (default 600_000ms = 10 min). */
  shardTimeoutMs?: number;
  /** Override working directory (test hook). */
  cwd?: string;
  /** Test hook: replaces spawn for verify tools (npx vitest/tsc/biome). */
  verifySpawnFn?: VerifySpawnFn;
  /** Test hook: replaces spawn for fix-worker (copilot --agent debugger). */
  fixSpawnFn?: FixWorkerSpawnFn;
  /**
   * Test hook: replaces the disk poll for fix-worker shard appearance.
   * Returns true when shard observed, false when deadline exceeded.
   */
  awaitShardFn?: (
    pidDir: string,
    workerIndex: number,
    deadline: number,
    now: () => number,
    sleep: (ms: number) => void,
  ) => boolean;
  /** Test hook: time source for the wait-deadline (defaults to Date.now). */
  now?: () => number;
  /** Test hook: sleep function for the wait-poll (defaults to busy-wait). */
  sleep?: (ms: number) => void;
  log?: (line: string) => void;
  errLog?: (line: string) => void;
}

export interface RunTeamLoopResult {
  exitCode: TeamLoopExitCode;
  /** Number of verify passes the loop completed. */
  iterations: number;
  /** Number of fix-worker spawns that fired. */
  fixAttempts: number;
  /** TeamState.current_phase observed on the final collect. */
  finalPhase: TeamPhase | undefined;
  /** True iff the loop exited because the bound was exhausted. */
  loopExhausted: boolean;
}

/**
 * Auto-orchestrator for the verify/fix loop. Returns one of 4 exit codes:
 *   0 — verify pass; team in `completed` phase
 *   1 — loop exhausted / failed / unexpected phase / shard-wait timed out
 *   2 — sessionId failed assertSafeSlug
 *   3 — session has no pidDir OR no TeamState on disk
 *
 * The function is pure-Sync from the parent process's POV: spawnFixWorker
 * spawns detached + unref's, then this loop polls the worker's shard file
 * to detect completion. No long-lived child handles retained.
 */
export function runTeamLoop(opts: RunTeamLoopOpts): RunTeamLoopResult {
  const log = opts.log ?? ((l: string) => console.log(l));
  const errLog = opts.errLog ?? ((l: string) => console.error(l));

  try {
    assertSafeSlug(opts.sessionId, "session-id");
  } catch (err) {
    if (err instanceof UnsafeSlugError) {
      errLog(`omcp team-loop: ${err.message}`);
    } else {
      errLog(`omcp team-loop: invalid session-id`);
    }
    return {
      exitCode: 2,
      iterations: 0,
      fixAttempts: 0,
      finalPhase: undefined,
      loopExhausted: false,
    };
  }

  const cwd = opts.cwd ?? process.cwd();
  const pidDir = join(cwd, ".omcp", "state", "team", opts.sessionId);
  if (!existsSync(pidDir)) {
    errLog(
      `omcp team-loop: session '${opts.sessionId}' has no pidDir at ${pidDir}`,
    );
    return {
      exitCode: 3,
      iterations: 0,
      fixAttempts: 0,
      finalPhase: undefined,
      loopExhausted: false,
    };
  }

  const initialState = readModeState<TeamState>("team", opts.sessionId);
  if (initialState === null) {
    errLog(`omcp team-loop: session '${opts.sessionId}' has no TeamState`);
    return {
      exitCode: 3,
      iterations: 0,
      fixAttempts: 0,
      finalPhase: undefined,
      loopExhausted: false,
    };
  }

  const maxLoops = resolveMaxLoops(opts.maxLoops);
  const shardTimeoutMs = opts.shardTimeoutMs ?? DEFAULT_SHARD_TIMEOUT_MS;
  const now = opts.now ?? (() => Date.now());
  const sleep = opts.sleep ?? defaultSleep;
  const awaitShard = opts.awaitShardFn ?? defaultAwaitShard;

  log(`omcp team-loop: session=${opts.sessionId}`);
  log(`  max_fix_loops:    ${maxLoops}`);
  log(`  shard_timeout_ms: ${shardTimeoutMs}`);

  // Hard iteration cap as a safety net beyond max_fix_loops — prevents an
  // infinite loop in the (impossible-in-spec) case where collect transitions
  // through unexpected phases or fix_loop_count fails to advance.
  const HARD_ITER_BOUND = maxLoops * 2 + 5;

  let iterations = 0;
  let fixAttempts = 0;
  let lastPhase: TeamPhase | undefined;

  for (let i = 0; i < HARD_ITER_BOUND; i++) {
    // Step 1 — verify (writes verify-report-N.json + worker signals if fail).
    const verify = runTeamVerify({
      sessionId: opts.sessionId,
      maxLoops,
      cwd,
      spawnFn: opts.verifySpawnFn,
    });
    iterations++;
    log(
      `  iter ${iterations}: verify ok=${verify.ok} exitCode=${verify.exitCode} workerSignals=${verify.workerSignals}`,
    );

    // Step 2 — collect (transitions team to completed / failed / fixing).
    const collect = runTeamCollect(opts.sessionId, {
      cwd,
      isProcessAlive: () => true,
    });
    lastPhase = collect.finalPhase;
    log(`  iter ${iterations}: collect finalPhase=${lastPhase}`);

    // Step 3 — dispatch.
    if (lastPhase === "completed") {
      log(
        `omcp team-loop: outcome=completed (verify iterations=${iterations}, fix attempts=${fixAttempts})`,
      );
      return {
        exitCode: 0,
        iterations,
        fixAttempts,
        finalPhase: lastPhase,
        loopExhausted: false,
      };
    }
    if (lastPhase === "failed") {
      log(
        `omcp team-loop: outcome=failed (verify_loop_exhausted; iterations=${iterations}, fix attempts=${fixAttempts})`,
      );
      return {
        exitCode: 1,
        iterations,
        fixAttempts,
        finalPhase: lastPhase,
        loopExhausted: true,
      };
    }
    if (lastPhase === "fixing") {
      const fix = spawnFixWorker({
        sessionId: opts.sessionId,
        maxLoops,
        cwd,
        spawnFn: opts.fixSpawnFn,
      });
      if (fix.exhausted) {
        log(
          `  iter ${iterations}: fix-worker spawn refused (exhausted at fix_loop_count=${fix.fixLoopCount}/${fix.maxFixLoops})`,
        );
        // The spawnFixWorker exhaust path already transitioned TeamState to
        // failed; surface the same outcome shape as the explicit failed
        // branch above.
        return {
          exitCode: 1,
          iterations,
          fixAttempts,
          finalPhase: "failed",
          loopExhausted: true,
        };
      }
      fixAttempts++;
      log(
        `  iter ${iterations}: spawned fix-worker idx=${fix.fixWorkerIndex} (fix_loop_count=${fix.fixLoopCount}/${fix.maxFixLoops})`,
      );

      const deadline = now() + shardTimeoutMs;
      const shardSeen = awaitShard(
        pidDir,
        fix.fixWorkerIndex,
        deadline,
        now,
        sleep,
      );
      if (!shardSeen) {
        errLog(
          `  iter ${iterations}: fix-worker shard worker-${fix.fixWorkerIndex}-shard.json didn't appear within ${shardTimeoutMs}ms — aborting loop`,
        );
        return {
          exitCode: 1,
          iterations,
          fixAttempts,
          finalPhase: lastPhase,
          loopExhausted: false,
        };
      }
      log(
        `  iter ${iterations}: fix-worker shard observed — re-verifying`,
      );
      continue;
    }

    // executing / initializing / planning — unexpected for an auto-loop
    // since the user is expected to have run team-launch already.
    errLog(
      `  iter ${iterations}: unexpected phase '${lastPhase}' — team-loop expects executing → fixing | completed | failed; aborting`,
    );
    return {
      exitCode: 1,
      iterations,
      fixAttempts,
      finalPhase: lastPhase,
      loopExhausted: false,
    };
  }

  errLog(
    `omcp team-loop: hit hard iteration bound ${HARD_ITER_BOUND} (max_fix_loops=${maxLoops}) — aborting as defensive fallback`,
  );
  return {
    exitCode: 1,
    iterations,
    fixAttempts,
    finalPhase: lastPhase,
    loopExhausted: false,
  };
}

/**
 * Default disk-poll for fix-worker shard appearance. Tight 2s poll until
 * the deadline fires. Synchronous busy-wait matches the existing
 * shutdownTeam / team-wait pattern.
 */
function defaultAwaitShard(
  pidDir: string,
  workerIndex: number,
  deadline: number,
  now: () => number,
  sleep: (ms: number) => void,
): boolean {
  const shardPath = join(pidDir, `worker-${workerIndex}-shard.json`);
  while (now() < deadline) {
    if (existsSync(shardPath)) return true;
    sleep(SHARD_POLL_INTERVAL_MS);
  }
  return existsSync(shardPath);
}

function defaultSleep(ms: number): void {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    // intentional busy-wait — see team-wait.ts for rationale.
  }
}

// ─── CLI wrapper ──────────────────────────────────────────────────────────────

export interface RunTeamLoopCliOpts {
  maxLoops?: number;
  shardTimeoutMs?: number;
  cwd?: string;
  verifySpawnFn?: VerifySpawnFn;
  fixSpawnFn?: FixWorkerSpawnFn;
  awaitShardFn?: RunTeamLoopOpts["awaitShardFn"];
  now?: () => number;
  sleep?: (ms: number) => void;
  log?: (line: string) => void;
  errLog?: (line: string) => void;
}

/**
 * CLI wrapper — validates argv and dispatches to runTeamLoop. Same exit-code
 * contract: 0 / 1 / 2 / 3.
 */
export function runTeamLoopCli(
  sessionId: string,
  opts: RunTeamLoopCliOpts = {},
): TeamLoopExitCode {
  const result = runTeamLoop({
    sessionId,
    maxLoops: opts.maxLoops,
    shardTimeoutMs: opts.shardTimeoutMs,
    cwd: opts.cwd,
    verifySpawnFn: opts.verifySpawnFn,
    fixSpawnFn: opts.fixSpawnFn,
    awaitShardFn: opts.awaitShardFn,
    now: opts.now,
    sleep: opts.sleep,
    log: opts.log,
    errLog: opts.errLog,
  });
  return result.exitCode;
}
