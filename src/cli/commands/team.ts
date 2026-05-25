// `omcp team <spec> <task>` — spawn a parallel team of Copilot workers.
//
// Spec syntax:
//   N:agent          e.g. "4:executor"  -> 4 workers, each running --agent executor
//   N                e.g. "4"           -> 4 workers, no agent specified
//
// Implementation: when tmux is available on PATH, create a session with N panes.
// Otherwise spawn N detached `copilot -p` processes and write per-worker logs
// under .omcp/state/sessions/<uuid>/worker-K.log.
// Per-worker pidfiles are written to .omcp/state/team/<sessionId>/worker-K.pid
// so that stopTeam can SIGTERM them on Ctrl+C.

import { spawnSync } from "node:child_process";
import { spawnCrossPlatform } from "../../runtime/resolve-executable.js";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";

import { mergeShards } from "../../lib/team-shard-state.js";
import type { MergeReport } from "../../lib/team-shard-state.js";
import { writeModeState, transitionPhase } from "../../runtime/mode-state.js";
import type { TeamState } from "../../runtime/mode-state.js";
import { atomicWriteFileSync } from "../../runtime/atomic-write.js";
import {
  HEARTBEAT_ABSENT_WARNING_MULTIPLIER,
  resolveHeartbeatFreshnessMs,
  resolveHeartbeatIntervalMs,
} from "./team-heartbeat.js";

export interface TeamSpec {
  count: number;
  agent?: string;
}

export function parseTeamSpec(input: string): TeamSpec {
  const [left, right] = input.split(":");
  const count = Number.parseInt(left ?? "0", 10);
  if (!Number.isFinite(count) || count < 1) {
    throw new Error(`team spec must start with a positive integer (got: ${input})`);
  }
  if (right && !/^[a-z0-9_-]+$/i.test(right)) {
    throw new Error(`team spec agent must be a slug (got: ${right})`);
  }
  return { count, agent: right };
}

function tmuxAvailable(): boolean {
  const r = spawnSync(process.platform === "win32" ? "where" : "which", ["tmux"], {
    encoding: "utf8",
  });
  return r.status === 0 && r.stdout.trim().length > 0;
}

export interface TeamLaunchReport {
  sessionId: string;
  count: number;
  agent?: string;
  mode: "tmux" | "detached";
  logDir: string;
  /** Only present in detached mode. Directory containing per-worker .pid files. */
  pidDir?: string;
}

export function runTeam(spec: TeamSpec, task: string): TeamLaunchReport {
  const sessionId = randomUUID();
  const logDir = join(process.cwd(), ".omcp", "state", "sessions", sessionId);
  mkdirSync(logDir, { recursive: true });

  // Write TeamState with current_phase='initializing' BEFORE spawning workers.
  // Once all workers are spawned, transitionPhase moves to 'executing'.
  // This corrects the L2.5a schema (which wrote 'executing' prematurely) so
  // the phase accurately reflects: spawn is not yet complete at this point.
  writeModeState<TeamState>("team", {
    active: true,
    session_id: sessionId,
    started_at: new Date().toISOString(),
    spawned: spec.count,
    done: 0,
    workers: Array.from({ length: spec.count }, (_, i) => ({
      id: `worker-${i + 1}`,
      agent: spec.agent,
      status: "pending",
    })),
    current_phase: "initializing",
    stage_history: ["initializing"],
  }, sessionId);

  if (tmuxAvailable()) {
    const sessionName = `omcp-team-${sessionId.slice(0, 8)}`;
    const cmds = Array.from({ length: spec.count }, (_, i) => {
      const workerIndex = i + 1;
      const args = ["-p", `${task} (worker ${workerIndex}/${spec.count})`, "--allow-all-tools"];
      if (spec.agent) args.push("--agent", spec.agent);
      const log = join(logDir, `worker-${workerIndex}.log`);
      // Prefix env vars so the spawned copilot process inherits them.
      const envPrefix = `OMCP_TEAM_SESSION_ID=${JSON.stringify(sessionId)} OMCP_TEAM_WORKER_INDEX=${workerIndex}`;
      return `${envPrefix} copilot ${args.map((a) => JSON.stringify(a)).join(" ")} 2>&1 | tee ${JSON.stringify(log)}`;
    });
    spawnSync("tmux", ["new-session", "-d", "-s", sessionName, cmds[0]], {
      stdio: "inherit",
    });
    for (let i = 1; i < cmds.length; i++) {
      spawnSync("tmux", ["split-window", "-t", sessionName, cmds[i]], {
        stdio: "inherit",
      });
    }
    spawnSync("tmux", ["select-layout", "-t", sessionName, "tiled"], {
      stdio: "inherit",
    });
    // Spawn complete — transition from 'initializing' to 'executing'.
    transitionPhase(sessionId, "executing");
    return { sessionId, count: spec.count, agent: spec.agent, mode: "tmux", logDir };
  }

  const pidDir = join(process.cwd(), ".omcp", "state", "team", sessionId);
  mkdirSync(pidDir, { recursive: true });

  for (let i = 0; i < spec.count; i++) {
    const workerIndex = i + 1;
    const args = ["-p", `${task} (worker ${workerIndex}/${spec.count})`, "--allow-all-tools"];
    if (spec.agent) args.push("--agent", spec.agent);
    const child = spawnCrossPlatform("copilot", args, {
      detached: true,
      stdio: "ignore",
      env: {
        ...process.env,
        OMCP_TEAM_SESSION_ID: sessionId,
        OMCP_TEAM_WORKER_INDEX: String(workerIndex),
      },
    });
    child.unref();
    if (child.pid !== undefined) {
      // Record the worker pid so stopTeam can SIGTERM it later.
      // Invariant 2: use atomicWriteFileSync (carve-out lifted in Phase L2.6).
      atomicWriteFileSync(join(pidDir, `worker-${i + 1}.pid`), String(child.pid));
    }
  }
  // All workers spawned — transition from 'initializing' to 'executing'.
  transitionPhase(sessionId, "executing");
  return {
    sessionId,
    count: spec.count,
    agent: spec.agent,
    mode: "detached",
    logDir,
    pidDir,
  };
}

export interface TeamStopReport {
  sessionId: string;
  killed: number[];
  errors: string[];
}

/**
 * Stop all detached workers for a session by reading their pidfiles,
 * SIGTERMing them, and removing the pidfiles.
 */
export function stopTeam(
  sessionId: string,
  opts: {
    /** Test hook: override process killer. Defaults to platform SIGTERM/taskkill. */
    killProcess?: (pid: number) => void;
  } = {},
): TeamStopReport {
  const killProcess =
    opts.killProcess ??
    ((pid: number) => {
      if (process.platform === "win32") {
        spawnSync("taskkill", ["/PID", String(pid), "/F"], { stdio: "ignore" });
      } else {
        process.kill(pid, "SIGTERM");
      }
    });

  const pidDir = join(process.cwd(), ".omcp", "state", "team", sessionId);
  const killed: number[] = [];
  const errors: string[] = [];

  if (!existsSync(pidDir)) {
    return { sessionId, killed, errors };
  }

  for (const f of readdirSync(pidDir)) {
    if (!f.endsWith(".pid")) continue;
    const pidPath = join(pidDir, f);
    try {
      const pid = Number(readFileSync(pidPath, "utf8").trim());
      if (Number.isFinite(pid) && pid > 0) {
        try {
          killProcess(pid);
        } catch (err) {
          errors.push(`kill ${pid}: ${(err as Error).message}`);
          // pidfile left intact so user can retry after fixing the underlying
          // issue (access denied, zombie process, etc.).
          continue;
        }
        // DD8 Critic-A P1 fix: verify the process actually died before
        // claiming success and deleting the pidfile. Without this, a failed
        // taskkill (Win) or SIGTERM (POSIX) silently orphans the worker
        // AND removes the only mechanism to stop it later.
        if (isProcessAlive(pid, 600)) {
          errors.push(`kill ${pid}: process still alive after kill signal`);
          // Leave pidfile intact.
          continue;
        }
        killed.push(pid);
      }
      unlinkSync(pidPath);
    } catch (err) {
      errors.push(`read ${pidPath}: ${(err as Error).message}`);
    }
  }

  return { sessionId, killed, errors };
}

// ─── shutdown ack protocol ───────────────────────────────────────────────────

export interface ShutdownReport extends TeamStopReport {
  /** Workers that acknowledged shutdown gracefully (wrote ack file). */
  acked: number[];
  /** Workers that timed out and were SIGTERM'd via stopTeam fallback. */
  timedOut: number[];
}

/**
 * Graceful shutdown with ack protocol.
 *
 * 1. Writes `.omcp/state/team/<sessionId>/shutdown-request.json` with timestamp.
 * 2. Waits up to `timeoutMs` (default: OMCP_TEAM_SHUTDOWN_WAIT_MS env or 30000)
 *    for each worker to write `worker-K-ack.json` indicating shutdown_response.
 * 3. Workers that do not ack within the timeout fall through to SIGTERM via
 *    the existing pidfile-based stopTeam path.
 *
 * Worker-side ack-write is OUT OF SCOPE for this commit (lives in Copilot skill
 * prompts, future work).
 * TODO: worker-side ack writer — Copilot skill responsibility, post-L2.7
 *
 * @param sessionId  The team session to shut down.
 * @param opts       Test hooks: override killProcess, timeoutMs, now(), sleep().
 */
export function shutdownTeam(
  sessionId: string,
  opts: {
    /** Test hook: override process killer. Defaults to platform SIGTERM/taskkill. */
    killProcess?: (pid: number) => void;
    /** Override shutdown wait timeout in ms. Falls back to OMCP_TEAM_SHUTDOWN_WAIT_MS or 30000. */
    timeoutMs?: number;
    /** Test hook: override Date.now() for deterministic time checks. */
    now?: () => number;
    /** Test hook: synchronous sleep function (ms). Defaults to a tight busy-poll. */
    sleep?: (ms: number) => void;
  } = {},
): ShutdownReport {
  const timeoutMs =
    opts.timeoutMs ??
    (Number(process.env.OMCP_TEAM_SHUTDOWN_WAIT_MS ?? "30000") || 30000);
  const now = opts.now ?? (() => Date.now());
  const sleep =
    opts.sleep ??
    ((ms: number) => {
      const until = Date.now() + ms;
      while (Date.now() < until) {
        // intentional busy-wait — shutdownTeam is called interactively, not in
        // a tight loop. Acceptable for up to a few hundred ms per tick.
      }
    });

  const pidDir = join(process.cwd(), ".omcp", "state", "team", sessionId);

  // Write shutdown request marker (create pidDir if needed — e.g. tmux sessions
  // don't create it, but we still want the request marker on disk).
  mkdirSync(pidDir, { recursive: true });
  atomicWriteFileSync(
    join(pidDir, "shutdown-request.json"),
    JSON.stringify({ requested_at: new Date().toISOString(), sessionId }, null, 2),
  );

  // Collect the worker indices from pidfiles so we know which ack files to wait for.
  const workerIndices: number[] = [];
  if (existsSync(pidDir)) {
    for (const f of readdirSync(pidDir)) {
      const m = /^worker-(\d+)\.pid$/.exec(f);
      if (m) workerIndices.push(Number(m[1]));
    }
  }

  // Wait for each worker to write their ack file.
  const acked: number[] = [];
  const timedOut: number[] = [];
  const deadline = now() + timeoutMs;

  for (const idx of workerIndices) {
    const ackFile = join(pidDir, `worker-${idx}-ack.json`);
    while (!existsSync(ackFile) && now() < deadline) {
      sleep(100);
    }
    if (existsSync(ackFile)) {
      acked.push(idx);
    } else {
      timedOut.push(idx);
    }
  }

  // Fall through to SIGTERM for any workers that did not ack.
  const stopReport = stopTeam(sessionId, { killProcess: opts.killProcess });

  return {
    ...stopReport,
    acked,
    timedOut,
  };
}

// ─── merge-shards subcommand ──────────────────────────────────────────────────

export interface TeamMergeResult {
  ok: boolean;
  report?: MergeReport;
  error?: string;
}

/**
 * Merge all per-worker PRD shards for `teamName` into the canonical PRD.
 *
 * Called by `omcp team merge-shards <team-name>` and optionally auto-triggered
 * by the persistent-mode hook when ralph PRD allComplete is detected.
 */
export function runTeamMergeShards(
  teamName: string,
  opts: { cwd?: string } = {},
): TeamMergeResult {
  const cwd = opts.cwd ?? process.cwd();
  try {
    const report = mergeShards(teamName, cwd);
    return { ok: true, report };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

// ─── stuck-worker watchdog ────────────────────────────────────────────────────

export interface WatchdogWorkerResult {
  index: number;
  pid: number;
  stuck: boolean;
  /** true when pid is no longer alive — skipped, no warning emitted */
  dead: boolean;
  /** mtime of the shard-write file, or undefined when no shard file present */
  shardMtimeMs?: number;
  markerWritten: boolean;
}

export interface WatchdogReport {
  sessionId: string;
  workers: WatchdogWorkerResult[];
  /** Log lines emitted (for test inspection). */
  logLines: string[];
}

/**
 * Scan workers for the given session and flag any whose last shard-write mtime
 * exceeds `timeoutMs` (default: OMCP_TEAM_WATCHDOG_TIMEOUT_MS or 600000 ms).
 *
 * For each stuck + alive worker:
 *  - Logs a warning to `logLines` (and to `console.warn`).
 *  - Writes `.omcp/state/team/<sessionId>/worker-K-reassign-needed.json`.
 *
 * Dead workers (pid no longer alive) are skipped silently.
 * Actual reassignment orchestration is OUT OF SCOPE — this phase implements
 * detection, logging, and marker write only.
 *
 * @param opts.sessionId   The team session to watch.
 * @param opts.timeoutMs   Stuck threshold in ms (overrides env var).
 * @param opts.now         Test hook: override Date.now().
 * @param opts.silent      When true, suppress console.warn output.
 */
export function runTeamWatchdog(opts: {
  sessionId: string;
  timeoutMs?: number;
  now?: () => number;
  silent?: boolean;
  /** Test hook: override the working directory used to resolve the pidDir. */
  cwd?: string;
}): WatchdogReport {
  const timeoutMs =
    opts.timeoutMs ??
    (Number(process.env.OMCP_TEAM_WATCHDOG_TIMEOUT_MS ?? "600000") || 600000);
  const now = opts.now ?? (() => Date.now());

  const pidDir = join(opts.cwd ?? process.cwd(), ".omcp", "state", "team", opts.sessionId);
  const workers: WatchdogWorkerResult[] = [];
  const logLines: string[] = [];

  if (!existsSync(pidDir)) {
    return { sessionId: opts.sessionId, workers, logLines };
  }

  for (const f of readdirSync(pidDir)) {
    const m = /^worker-(\d+)\.pid$/.exec(f);
    if (!m) continue;
    const idx = Number(m[1]);
    const pidPath = join(pidDir, f);

    let pid: number;
    try {
      pid = Number(readFileSync(pidPath, "utf8").trim());
      if (!Number.isFinite(pid) || pid <= 0) continue;
    } catch {
      continue;
    }

    // Check if the process is alive.
    let alive = false;
    try {
      process.kill(pid, 0);
      alive = true;
    } catch {
      alive = false;
    }

    if (!alive) {
      workers.push({ index: idx, pid, stuck: false, dead: true, markerWritten: false });
      continue;
    }

    // EB-06 Story 7 — heartbeat freshness check (primary signal per
    // ADR-omcp-eb-05). Read heartbeat.json's `ts` field FIRST; if present
    // and parseable, it's the primary liveness signal (avoids the NTFS
    // 15.625ms mtime quantum race documented in pre-mortem scenario 4).
    // Falls back to shard-mtime when heartbeat is absent — back-compat
    // with v2.1 workers that don't yet call `omcp team-heartbeat`.
    const heartbeatPath = join(pidDir, `worker-${idx}-heartbeat.json`);
    let heartbeatTsMs: number | undefined;
    let heartbeatPresent = false;
    if (existsSync(heartbeatPath)) {
      try {
        const raw = readFileSync(heartbeatPath, "utf8");
        const parsed = JSON.parse(raw) as { ts?: unknown };
        if (typeof parsed.ts === "string") {
          const parsedTs = Date.parse(parsed.ts);
          if (Number.isFinite(parsedTs)) {
            heartbeatTsMs = parsedTs;
            heartbeatPresent = true;
          }
        }
      } catch {
        // Corrupt heartbeat — treat as absent + fall back to mtime path
        // below. Emit a warning so the operator can investigate.
        logLines.push(
          `[omcp watchdog] worker-${idx} (pid=${pid}) heartbeat.json present but unparseable — falling back to shard-mtime`,
        );
      }
    }

    // Check shard-write mtime for staleness.
    // Shard file is worker-K-shard.json under the pidDir (written by the worker
    // to report incremental task completion).
    const shardFile = join(pidDir, `worker-${idx}-shard.json`);
    let shardMtimeMs: number | undefined;
    let stuck = false;

    if (heartbeatPresent && heartbeatTsMs !== undefined) {
      // Heartbeat-primary path: ADR-EB-05 §3 precedence rule.
      const freshnessThresholdMs = resolveHeartbeatFreshnessMs();
      stuck = now() - heartbeatTsMs > freshnessThresholdMs;
      // Still record shardMtimeMs for postmortem reading (when shard exists).
      if (existsSync(shardFile)) {
        try {
          shardMtimeMs = statSync(shardFile).mtimeMs;
        } catch {
          // ignore — heartbeat is the load-bearing signal here
        }
      }
    } else if (existsSync(shardFile)) {
      try {
        shardMtimeMs = statSync(shardFile).mtimeMs;
        stuck = now() - shardMtimeMs > timeoutMs;
      } catch {
        // Can't stat — treat as not stuck.
      }
      // ADR-EB-05 §4 heartbeat-absent observability: when worker has been
      // alive for >2× heartbeat interval but never wrote heartbeat.json,
      // surface a warning. Pidfile mtime is the spawn-time proxy.
      try {
        const spawnAgeMs = now() - statSync(pidPath).mtimeMs;
        const warnThresholdMs =
          resolveHeartbeatIntervalMs() * HEARTBEAT_ABSENT_WARNING_MULTIPLIER;
        if (spawnAgeMs > warnThresholdMs) {
          logLines.push(
            `[omcp watchdog] worker-${idx} (pid=${pid}) not heartbeating — spawn-age ${spawnAgeMs}ms > ${warnThresholdMs}ms`,
          );
        }
      } catch {
        // stat-failure: skip observability check
      }
    } else {
      // No shard file yet: use pidfile mtime as proxy for "last activity".
      try {
        const pidMtime = statSync(pidPath).mtimeMs;
        stuck = now() - pidMtime > timeoutMs;
        shardMtimeMs = pidMtime;
      } catch {
        // Can't stat pidfile — skip.
        workers.push({ index: idx, pid, stuck: false, dead: false, markerWritten: false });
        continue;
      }
    }

    let markerWritten = false;
    if (stuck) {
      const msg = `[omcp watchdog] worker-${idx} (pid=${pid}) stuck for >${timeoutMs}ms — reassign needed`;
      logLines.push(msg);
      if (!opts.silent) {
        console.warn(msg);
      }
      const markerFile = join(pidDir, `worker-${idx}-reassign-needed.json`);
      try {
        atomicWriteFileSync(
          markerFile,
          JSON.stringify(
            {
              worker: idx,
              pid,
              detected_at: new Date().toISOString(),
              shard_mtime_ms: shardMtimeMs,
              timeout_ms: timeoutMs,
            },
            null,
            2,
          ),
        );
        markerWritten = true;
      } catch {
        // Non-fatal: watchdog marker write failure should not crash the caller.
      }
    }

    workers.push({ index: idx, pid, stuck, dead: false, shardMtimeMs, markerWritten });
  }

  return { sessionId: opts.sessionId, workers, logLines };
}

// DD8: short busy-poll for process termination. Bounded by deadlineMs.
// Returns true if the pid is still alive after the deadline, false if it died.
function isProcessAlive(pid: number, deadlineMs: number): boolean {
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    try {
      // `process.kill(pid, 0)` throws ESRCH if the process is gone.
      // On Windows this is implemented via libuv and is reliable enough.
      process.kill(pid, 0);
    } catch {
      return false;
    }
    // ~30ms spin between checks. Acceptable: stopTeam is rare and synchronous.
    const spinUntil = Date.now() + 30;
    while (Date.now() < spinUntil) {
      // intentional busy wait — keeps the loop synchronous.
    }
  }
  // Final attempt.
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
