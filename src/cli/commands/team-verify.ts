// `omcp team-verify <session-id>` — Phase 1 verify runner (US-omcp-parity-P1-VERIFY-runner).
//
// Runs vitest → tsc → biome sequentially against the current repo and writes
// .omcp/state/team/<sessionId>/verify-report-N.json (N = next free iteration).
// When any check fails, writes worker-K-verify-fail.json per worker pidfile so
// runTeamCollect (Story 3) can short-circuit into the `fixing` phase.
//
// Loop bounding (--max-loops + OMCP_TEAM_MAX_FIX_LOOPS env override) is
// stored as report metadata in this story; the actual fail-on-exhaust
// transition lands in Story 5 (US-omcp-parity-P1-FIX-loop-bounding).
//
// Invariants honored:
//   I1 — assertSafeSlug on sessionId (path interpolation gate).
//   I2 — atomicWriteFileSync for verify-report-N.json + worker-K-verify-fail.json.
//   I8 — registered as `omcp team-verify` in src/cli/omcp.ts.

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { atomicWriteFileSync } from "../../runtime/atomic-write.js";
import {
  assertSafeSlug,
  UnsafeSlugError,
} from "../../runtime/safe-slug.js";

// ─── types ────────────────────────────────────────────────────────────────────

export interface VerifyToolResult {
  exitCode: number;
  /** Last 200 lines of merged stdout/stderr from the tool. */
  tail: string;
}

export interface VerifyReport {
  iteration: number;
  ts: string;
  /** Resolved max-fix-loops at the time this verify pass ran. */
  max_fix_loops: number;
  vitest: VerifyToolResult;
  tsc: VerifyToolResult;
  biome: VerifyToolResult;
  ok: boolean;
}

export interface VerifySpawnResult {
  exitCode: number;
  /** Merged stdout/stderr; runTeamVerify will tail-clip to TAIL_LINES. */
  output: string;
}

export type VerifySpawnFn = (cmd: string, args: string[]) => VerifySpawnResult;

export interface RunTeamVerifyOpts {
  sessionId: string;
  /**
   * Override the resolved max-fix-loops value stored in the verify report.
   * Story 5 will enforce the bound; Story 2 only persists it as metadata.
   */
  maxLoops?: number;
  /** Override working directory (test hook). */
  cwd?: string;
  /** Test hook: replace child_process.spawnSync for deterministic CI. */
  spawnFn?: VerifySpawnFn;
}

export interface RunTeamVerifyResult {
  ok: boolean;
  /** 0 when all 3 checks pass; 1 when any failed; 2 when sessionId invalid. */
  exitCode: number;
  reportPath?: string;
  iteration?: number;
  /** Count of `worker-K-verify-fail.json` signal files written. */
  workerSignals: number;
  report?: VerifyReport;
}

// ─── constants ────────────────────────────────────────────────────────────────

const TAIL_LINES = 200;
const DEFAULT_MAX_LOOPS = 3;
const VERIFY_TOOL_TIMEOUT_MS = 600_000;

// ─── helpers ──────────────────────────────────────────────────────────────────

function tailLines(text: string, n: number): string {
  const lines = text.split(/\r?\n/);
  if (lines.length <= n) return text;
  return lines.slice(-n).join("\n");
}

function nextIteration(pidDir: string): number {
  if (!existsSync(pidDir)) return 1;
  let max = 0;
  for (const f of readdirSync(pidDir)) {
    const m = /^verify-report-(\d+)\.json$/.exec(f);
    if (m) {
      const n = Number(m[1]);
      if (Number.isFinite(n) && n > max) max = n;
    }
  }
  return max + 1;
}

function listWorkerIndices(pidDir: string): number[] {
  if (!existsSync(pidDir)) return [];
  const idx: number[] = [];
  for (const f of readdirSync(pidDir)) {
    const m = /^worker-(\d+)\.pid$/.exec(f);
    if (m) idx.push(Number(m[1]));
  }
  return idx.sort((a, b) => a - b);
}

/**
 * Resolve the max-fix-loops value. Precedence:
 *   1. OMCP_TEAM_MAX_FIX_LOOPS env var (positive integer)
 *   2. `arg` parameter (positive integer)
 *   3. DEFAULT_MAX_LOOPS (3)
 *
 * Exported for unit-testing the precedence chain independent of runTeamVerify.
 */
export function resolveMaxLoops(
  arg?: number,
  env: NodeJS.ProcessEnv = process.env,
): number {
  const fromEnv = env.OMCP_TEAM_MAX_FIX_LOOPS;
  if (fromEnv !== undefined && fromEnv !== "") {
    const n = Number(fromEnv);
    if (Number.isFinite(n) && n > 0) return n;
  }
  if (arg !== undefined && Number.isFinite(arg) && arg > 0) return arg;
  return DEFAULT_MAX_LOOPS;
}

// ─── core runner ──────────────────────────────────────────────────────────────

/**
 * Run vitest → tsc → biome against the current repo and persist a verify report.
 *
 * Returns exit-code semantics:
 *   0 → all three tools exited 0 (verify=ok).
 *   1 → at least one tool exited non-zero (verify-fail signals written per worker).
 *   2 → sessionId failed assertSafeSlug (no spawn attempted, no file writes).
 *
 * The actual loop-bounding (fail-on-exhaust transition to `failed`) is owned
 * by Story 5; Story 2 only stores `max_fix_loops` in the report as metadata.
 */
export function runTeamVerify(
  opts: RunTeamVerifyOpts,
): RunTeamVerifyResult {
  // Invariant 1 — validate sessionId BEFORE any path interpolation.
  try {
    assertSafeSlug(opts.sessionId, "session-id");
  } catch {
    return { ok: false, exitCode: 2, workerSignals: 0 };
  }

  const cwd = opts.cwd ?? process.cwd();
  const pidDir = join(cwd, ".omcp", "state", "team", opts.sessionId);
  mkdirSync(pidDir, { recursive: true });

  const doSpawn: VerifySpawnFn =
    opts.spawnFn ??
    ((cmd: string, args: string[]) => {
      const r = spawnSync(cmd, args, {
        encoding: "utf8",
        cwd,
        timeout: VERIFY_TOOL_TIMEOUT_MS,
        stdio: ["ignore", "pipe", "pipe"],
      });
      const stdout = (r.stdout as string | null) ?? "";
      const stderr = (r.stderr as string | null) ?? "";
      // r.status === null when killed by timeout / signal — treat as fail (1).
      return {
        exitCode: r.status ?? 1,
        output: stdout + (stderr ? `\n${stderr}` : ""),
      };
    });

  const runTool = (cmd: string, args: string[]): VerifyToolResult => {
    const result = doSpawn(cmd, args);
    return {
      exitCode: result.exitCode,
      tail: tailLines(result.output, TAIL_LINES),
    };
  };

  const vitest = runTool("npx", ["vitest", "run"]);
  const tsc = runTool("npx", ["tsc", "--noEmit"]);
  const biome = runTool("npx", ["biome", "check", "src/"]);

  const ok =
    vitest.exitCode === 0 && tsc.exitCode === 0 && biome.exitCode === 0;
  const iteration = nextIteration(pidDir);
  const maxLoops = resolveMaxLoops(opts.maxLoops);
  const ts = new Date().toISOString();
  const report: VerifyReport = {
    iteration,
    ts,
    max_fix_loops: maxLoops,
    vitest,
    tsc,
    biome,
    ok,
  };

  // Invariant 2 — atomic write to verify-report-N.json.
  const reportPath = join(pidDir, `verify-report-${iteration}.json`);
  atomicWriteFileSync(reportPath, JSON.stringify(report, null, 2));

  let workerSignals = 0;
  if (!ok) {
    const failedTools = [
      vitest.exitCode !== 0 ? "vitest" : null,
      tsc.exitCode !== 0 ? "tsc" : null,
      biome.exitCode !== 0 ? "biome" : null,
    ].filter((s): s is string => s !== null);

    for (const idx of listWorkerIndices(pidDir)) {
      const signalPath = join(pidDir, `worker-${idx}-verify-fail.json`);
      atomicWriteFileSync(
        signalPath,
        JSON.stringify(
          {
            workerIndex: idx,
            iteration,
            ts,
            failedTools,
            reportPath: `verify-report-${iteration}.json`,
          },
          null,
          2,
        ),
      );
      workerSignals++;
    }
  }

  return {
    ok,
    exitCode: ok ? 0 : 1,
    reportPath,
    iteration,
    workerSignals,
    report,
  };
}

// ─── CLI wrapper ──────────────────────────────────────────────────────────────

export interface RunTeamVerifyCliOpts {
  maxLoops?: number;
  cwd?: string;
  spawnFn?: VerifySpawnFn;
  /** Test hook: capture stdout/stderr lines instead of writing to console. */
  log?: (line: string) => void;
  errLog?: (line: string) => void;
}

/**
 * Validate argv-shape and dispatch to runTeamVerify. Prints a one-shot
 * summary to stdout and returns the process exit code.
 */
export function runTeamVerifyCli(
  sessionId: string,
  opts: RunTeamVerifyCliOpts = {},
): number {
  const log = opts.log ?? ((line: string) => console.log(line));
  const errLog = opts.errLog ?? ((line: string) => console.error(line));

  try {
    assertSafeSlug(sessionId, "session-id");
  } catch (err) {
    if (err instanceof UnsafeSlugError) {
      errLog(`omcp team-verify: ${err.message}`);
    } else {
      errLog(`omcp team-verify: invalid session-id`);
    }
    return 2;
  }

  const maxLoops = resolveMaxLoops(opts.maxLoops);
  const result = runTeamVerify({
    sessionId,
    maxLoops,
    cwd: opts.cwd,
    spawnFn: opts.spawnFn,
  });

  log(`omcp team-verify: session=${sessionId}`);
  log(`  iteration:      ${result.iteration ?? "n/a"}`);
  log(`  ok:             ${result.ok}`);
  log(`  max_fix_loops:  ${maxLoops}`);
  log(`  worker signals: ${result.workerSignals}`);
  if (result.reportPath) {
    log(`  report:         ${result.reportPath}`);
  }
  if (!result.ok && result.report) {
    const failed = [
      result.report.vitest.exitCode !== 0 ? "vitest" : null,
      result.report.tsc.exitCode !== 0 ? "tsc" : null,
      result.report.biome.exitCode !== 0 ? "biome" : null,
    ].filter((s): s is string => s !== null);
    log(`  failed:         ${failed.join(", ")}`);
  }

  return result.exitCode;
}
