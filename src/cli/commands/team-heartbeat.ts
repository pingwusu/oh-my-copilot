// `omcp team-heartbeat <session-id> <worker-index>` (EB-06 Story 7)
//
// Per-worker liveness signal. Writes a JSON file with {ts, workerIndex, pid}
// at .omcp/state/team/<sid>/worker-<idx>-heartbeat.json via atomicWriteFileSync.
//
// Consumed by runTeamWatchdog (extended in this story): heartbeat.json's
// `ts` field is the primary freshness signal; shard-mtime is the fallback
// for v2.1 workers that don't yet write heartbeat. Both contracts pinned
// in docs/adr/ADR-omcp-eb-05-heartbeat-freshness.md.
//
// Invariants honored:
//   I1 — assertSafeSlug on sessionId
//   I2 — atomicWriteFileSync for heartbeat.json (rewrite, not append)
//   I8 — registered as `omcp team-heartbeat` in src/cli/omcp.ts

import { mkdirSync } from "node:fs";
import { join } from "node:path";

import { atomicWriteFileSync } from "../../runtime/atomic-write.js";
import {
  assertSafeSlug,
  UnsafeSlugError,
} from "../../runtime/safe-slug.js";
import { appendEventBestEffort } from "./team-event.js";

// ─── constants pinned by ADR-EB-05 ───────────────────────────────────────────

/** Default heartbeat interval in seconds (env OMCP_HEARTBEAT_INTERVAL_S override). */
export const HEARTBEAT_INTERVAL_S_DEFAULT = 30;

/** Default freshness multiplier (env OMCP_HEARTBEAT_FRESHNESS_MULTIPLIER override). */
export const HEARTBEAT_FRESHNESS_MULTIPLIER_DEFAULT = 3;

/** Heartbeat-absent observability multiplier: warn after this many intervals. */
export const HEARTBEAT_ABSENT_WARNING_MULTIPLIER = 2;

// ─── types ───────────────────────────────────────────────────────────────────

export interface HeartbeatPayload {
  ts: string;
  workerIndex: number;
  pid: number;
}

export interface RunTeamHeartbeatOpts {
  sessionId: string;
  workerIndex: number;
  cwd?: string;
  /** Test hook: timestamp source. */
  now?: () => string;
  /** Test hook: pid source. */
  pid?: number;
}

export interface RunTeamHeartbeatResult {
  /** 0 ok, 2 invalid argv, 1 other error. */
  exitCode: number;
  heartbeatPath?: string;
  ts?: string;
}

// ─── core ────────────────────────────────────────────────────────────────────

/**
 * Compute the freshness threshold in MILLISECONDS per ADR-EB-05.
 * Precedence: env > opts > default.
 * Defaults: interval 30s × multiplier 3 = 90s.
 *
 * Exported for unit-testing the precedence chain + for runTeamWatchdog
 * integration so both share the same resolution.
 */
export function resolveHeartbeatFreshnessMs(
  opts: {
    intervalS?: number;
    multiplier?: number;
  } = {},
  env: NodeJS.ProcessEnv = process.env,
): number {
  const intervalS = resolvePositive(
    env.OMCP_HEARTBEAT_INTERVAL_S,
    opts.intervalS,
    HEARTBEAT_INTERVAL_S_DEFAULT,
  );
  const multiplier = resolvePositive(
    env.OMCP_HEARTBEAT_FRESHNESS_MULTIPLIER,
    opts.multiplier,
    HEARTBEAT_FRESHNESS_MULTIPLIER_DEFAULT,
  );
  return intervalS * 1000 * multiplier;
}

/** Compute the heartbeat interval in MS per env > opts > default. */
export function resolveHeartbeatIntervalMs(
  opts: { intervalS?: number } = {},
  env: NodeJS.ProcessEnv = process.env,
): number {
  return (
    resolvePositive(
      env.OMCP_HEARTBEAT_INTERVAL_S,
      opts.intervalS,
      HEARTBEAT_INTERVAL_S_DEFAULT,
    ) * 1000
  );
}

function resolvePositive(
  envValue: string | undefined,
  argValue: number | undefined,
  defaultValue: number,
): number {
  if (envValue !== undefined && envValue !== "") {
    const n = Number(envValue);
    if (Number.isFinite(n) && n > 0) return n;
  }
  if (argValue !== undefined && Number.isFinite(argValue) && argValue > 0) {
    return argValue;
  }
  return defaultValue;
}

/**
 * Heartbeat file path for a given session + worker.
 *
 * Exported for runTeamWatchdog integration so the watchdog reads the same
 * path the writer produces.
 */
export function heartbeatFilePath(
  pidDir: string,
  workerIndex: number,
): string {
  return join(pidDir, `worker-${workerIndex}-heartbeat.json`);
}

/**
 * Write the heartbeat JSON. Uses atomicWriteFileSync (Invariant 2) so a
 * concurrent watchdog read sees either the old complete content or the
 * new complete content — never an empty / partial rename window.
 */
export function runTeamHeartbeat(
  opts: RunTeamHeartbeatOpts,
): RunTeamHeartbeatResult {
  // Invariant 1.
  try {
    assertSafeSlug(opts.sessionId, "session-id");
  } catch {
    return { exitCode: 2 };
  }
  if (!Number.isInteger(opts.workerIndex) || opts.workerIndex < 0) {
    return { exitCode: 2 };
  }

  // RG-04b instrumentation: defensive entry event.
  appendEventBestEffort({
    sessionId: opts.sessionId,
    verb: "team-heartbeat",
    kind: "entry",
    actor: `worker-${opts.workerIndex}`,
    cwd: opts.cwd,
  });

  const cwd = opts.cwd ?? process.cwd();
  const pidDir = join(cwd, ".omcp", "state", "team", opts.sessionId);
  mkdirSync(pidDir, { recursive: true });

  const ts = opts.now?.() ?? new Date().toISOString();
  const pid = opts.pid ?? process.pid;
  const payload: HeartbeatPayload = {
    ts,
    workerIndex: opts.workerIndex,
    pid,
  };
  const heartbeatPath = heartbeatFilePath(pidDir, opts.workerIndex);
  try {
    atomicWriteFileSync(heartbeatPath, JSON.stringify(payload, null, 2));
  } catch {
    return { exitCode: 1, heartbeatPath, ts };
  }

  // RG-04b instrumentation: defensive exit event.
  appendEventBestEffort({
    sessionId: opts.sessionId,
    verb: "team-heartbeat",
    kind: "exit",
    actor: `worker-${opts.workerIndex}`,
    cwd: opts.cwd,
    detail: { exitCode: 0, ts },
  });

  return { exitCode: 0, heartbeatPath, ts };
}

// ─── CLI wrapper ─────────────────────────────────────────────────────────────

export interface RunTeamHeartbeatCliOpts {
  cwd?: string;
  log?: (line: string) => void;
  errLog?: (line: string) => void;
}

export function runTeamHeartbeatCli(
  sessionId: string,
  workerIndexStr: string,
  opts: RunTeamHeartbeatCliOpts = {},
): number {
  const log = opts.log ?? ((l: string) => console.log(l));
  const errLog = opts.errLog ?? ((l: string) => console.error(l));

  try {
    assertSafeSlug(sessionId, "session-id");
  } catch (err) {
    if (err instanceof UnsafeSlugError) {
      errLog(`omcp team-heartbeat: ${err.message}`);
    } else {
      errLog(`omcp team-heartbeat: invalid session-id`);
    }
    return 2;
  }

  const workerIndex = Number.parseInt(workerIndexStr, 10);
  if (
    !Number.isFinite(workerIndex) ||
    workerIndex < 0 ||
    String(workerIndex) !== workerIndexStr.trim()
  ) {
    errLog(
      `omcp team-heartbeat: worker-index must be a non-negative integer (got: ${JSON.stringify(workerIndexStr)})`,
    );
    return 2;
  }

  const result = runTeamHeartbeat({
    sessionId,
    workerIndex,
    cwd: opts.cwd,
  });

  if (result.exitCode === 0) {
    log(`omcp team-heartbeat: wrote ${result.heartbeatPath}`);
    log(`  ts: ${result.ts}`);
  } else if (result.exitCode === 2) {
    // assertSafeSlug already printed the error
  } else {
    errLog(`omcp team-heartbeat: unexpected error writing heartbeat`);
  }
  return result.exitCode;
}
