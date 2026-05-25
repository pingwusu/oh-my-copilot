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
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";

import { atomicWriteFileSync } from "../../runtime/atomic-write.js";
import {
  assertSafeSlug,
  UnsafeSlugError,
} from "../../runtime/safe-slug.js";
import { spawnCrossPlatform } from "../../runtime/resolve-executable.js";
import {
  InvalidPhaseTransitionError,
  readModeState,
  transitionPhase,
  writeModeState,
  type TeamState,
} from "../../runtime/mode-state.js";

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
 * Delete every `worker-*-verify-fail.json` from the pidDir. Called at the
 * start of `runTeamVerify` so that the signal file set always reflects the
 * CURRENT verify pass — stale signals from a prior failed iteration never
 * leak forward into a subsequent passing iteration where Story 3's
 * `runTeamCollect` would mis-interpret them as a fresh fix-needed condition.
 *
 * Exported for direct unit-testing.
 */
export function clearWorkerVerifyFailSignals(pidDir: string): number {
  if (!existsSync(pidDir)) return 0;
  let cleared = 0;
  for (const f of readdirSync(pidDir)) {
    if (/^worker-\d+-verify-fail\.json$/.test(f)) {
      try {
        rmSync(join(pidDir, f), { force: true });
        cleared++;
      } catch {
        // best-effort cleanup; a stale signal still gets overwritten on
        // the next fail and is harmless if the run passes here.
      }
    }
  }
  return cleared;
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

  // Clear stale worker-K-verify-fail.json signals BEFORE running tools so the
  // signal file set always reflects the current pass. Without this, a prior
  // failed iteration's signals would persist through a passing re-verify and
  // Story 3's `runTeamCollect` would mis-route the team back into `fixing`.
  clearWorkerVerifyFailSignals(pidDir);

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

// ─── Story 4: spawnFixWorker ──────────────────────────────────────────────────

export interface VerifyFailSummary {
  detectedAt: string;
  sessionId: string;
  signalCount: number;
  signals: Array<{
    workerIndex: number;
    iteration: number;
    ts: string;
    failedTools: string[];
    reportPath: string;
  }>;
}

export interface FixWorkerSpawnHandle {
  pid?: number;
  unref(): void;
}

export type FixWorkerSpawnFn = (
  cmd: string,
  args: string[],
  opts: { detached: boolean; env: NodeJS.ProcessEnv },
) => FixWorkerSpawnHandle;

export interface SpawnFixWorkerOpts {
  sessionId: string;
  /** Override cwd (test hook). */
  cwd?: string;
  /** Inject the spawn function for deterministic tests. */
  spawnFn?: FixWorkerSpawnFn;
  /**
   * Override the latest verify report; default reads the
   * highest-numbered verify-report-N.json from pidDir.
   */
  verifyReport?: VerifyReport;
  /**
   * Override the fail summary; default reads verify-fail-summary.json
   * from pidDir (written by runTeamCollect in Story 3).
   */
  verifyFailSummary?: VerifyFailSummary;
  /**
   * Override the resolved max-fix-loops bound (Story 5). When passed,
   * resolveMaxLoops() ranks: env OMCP_TEAM_MAX_FIX_LOOPS > this value >
   * latest verify-report-N.json.max_fix_loops > DEFAULT_MAX_LOOPS.
   */
  maxLoops?: number;
}

export interface SpawnFixWorkerResult {
  fixWorkerIndex: number;
  pidPath: string;
  pid?: number;
  fixLoopCount: number;
  promptPreview: string;
  /**
   * Resolved max-fix-loops bound applied to this decision (Story 5).
   * Stored on every result so callers can render bound vs current count.
   */
  maxFixLoops: number;
  /**
   * True when the bound was exhausted BEFORE this spawn — in which case
   * no copilot worker was launched, fix_loop_count was NOT incremented,
   * and TeamState was transitioned to `failed` with reason
   * `verify_loop_exhausted`. Story 5 gate.
   */
  exhausted: boolean;
}

/** Maximum body length (chars) included in the worker prompt. */
const FIX_PROMPT_MAX_CHARS = 4000;

function nextWorkerIndex(pidDir: string): number {
  if (!existsSync(pidDir)) return 1;
  let max = 0;
  for (const f of readdirSync(pidDir)) {
    const m = /^worker-(\d+)\.pid$/.exec(f);
    if (m) {
      const n = Number(m[1]);
      if (Number.isFinite(n) && n > max) max = n;
    }
  }
  return max + 1;
}

function readLatestVerifyReport(pidDir: string): VerifyReport | undefined {
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
    return JSON.parse(readFileSync(latestPath, "utf8")) as VerifyReport;
  } catch {
    return undefined;
  }
}

function readVerifyFailSummary(pidDir: string): VerifyFailSummary | undefined {
  const p = join(pidDir, "verify-fail-summary.json");
  if (!existsSync(p)) return undefined;
  try {
    return JSON.parse(readFileSync(p, "utf8")) as VerifyFailSummary;
  } catch {
    return undefined;
  }
}

/**
 * Increment TeamState.fix_loop_count atomically and return the new value.
 * Treats a missing TeamState (or unparseable file) as a no-op that returns
 * 0 — Story 5 will check this value before allowing further spawns, so a
 * missing-state condition correctly degenerates to "max loops not yet
 * exhausted, but no session to attribute the count to."
 */
export function incrementFixLoopCount(sessionId: string, cwd: string): number {
  const state = readModeState<TeamState>("team", sessionId);
  if (state === null) return 0;
  const previous = state.fix_loop_count ?? 0;
  const next = previous + 1;
  // writeModeState calls atomicWriteFileSync internally (Invariant 2).
  writeModeState<TeamState>(
    "team",
    {
      ...state,
      fix_loop_count: next,
    },
    sessionId,
  );
  // cwd parameter currently unused — writeModeState resolves state path via
  // process.cwd(). Kept in the signature for future test injection so the
  // caller can pass an explicit cwd without monkey-patching process.cwd().
  void cwd;
  return next;
}

/**
 * Build the prompt body that the fix-worker receives via `copilot -p`.
 * Short and structured: points the worker at the on-disk artifacts where
 * the full verify output lives, lists which tools failed, and explicitly
 * tells the worker to re-run `omcp team-verify` after applying fixes so
 * the collect/verify loop can converge.
 *
 * Capped at FIX_PROMPT_MAX_CHARS to stay well under Windows argv limits.
 * Exported for direct unit testing.
 */
export function buildFixWorkerPrompt(opts: {
  sessionId: string;
  fixLoopCount: number;
  verifyReport?: VerifyReport;
  verifyFailSummary?: VerifyFailSummary;
  pidDir: string;
}): string {
  const lines: string[] = [];
  lines.push(
    `Fix the failing verify checks for omcp team session ${opts.sessionId} (fix attempt #${opts.fixLoopCount}).`,
  );
  lines.push("");

  if (opts.verifyReport) {
    const failed: string[] = [];
    if (opts.verifyReport.vitest.exitCode !== 0) failed.push("vitest");
    if (opts.verifyReport.tsc.exitCode !== 0) failed.push("tsc");
    if (opts.verifyReport.biome.exitCode !== 0) failed.push("biome");
    lines.push(
      `Iteration ${opts.verifyReport.iteration} verify report — failed tool(s): ${failed.join(", ") || "(none reported)"}`,
    );
    lines.push("");
    lines.push("Tool tails:");
    for (const [name, r] of [
      ["vitest", opts.verifyReport.vitest],
      ["tsc", opts.verifyReport.tsc],
      ["biome", opts.verifyReport.biome],
    ] as const) {
      if (r.exitCode === 0) continue;
      lines.push(`--- ${name} (exit ${r.exitCode}) ---`);
      lines.push(r.tail);
      lines.push("");
    }
  }

  if (opts.verifyFailSummary) {
    lines.push(
      `Verify-fail summary lists ${opts.verifyFailSummary.signalCount} worker signal(s): ${opts.verifyFailSummary.signals
        .map((s) => `worker-${s.workerIndex}[${s.failedTools.join("/")}]`)
        .join(", ")}`,
    );
    lines.push("");
  }

  lines.push(
    `Full artifacts available on disk under ${opts.pidDir}:`,
  );
  lines.push("  - verify-fail-summary.json (worker signal aggregate)");
  lines.push("  - verify-report-N.json (latest iteration's full tool output)");
  lines.push("");
  lines.push(
    "Apply minimal-diff fixes that address the failing checks without rewriting passing tests or unrelated code.",
  );
  lines.push(
    `After applying fixes, re-run \`omcp team-verify ${opts.sessionId}\` so the verify/fix loop can converge.`,
  );

  const body = lines.join("\n");
  if (body.length > FIX_PROMPT_MAX_CHARS) {
    return `${body.slice(0, FIX_PROMPT_MAX_CHARS - 32)}\n... (truncated for argv limit)`;
  }
  return body;
}

/**
 * Spawn a single Copilot fix-worker (agent=debugger) for a team session that
 * has verify-fail signals. The worker runs DETACHED — runTeam's pattern — so
 * fix_loop_count is incremented at spawn-time (semantics: "fix attempts
 * initiated", not "completed"). Story 5 will gate further spawns when this
 * count hits max_fix_loops.
 *
 * No-ops with a thrown error when:
 *   - sessionId fails assertSafeSlug
 *   - No TeamState exists for the session
 *   - No verify-fail-summary.json exists (Story 3 didn't write one;
 *     calling fix-spawn without a fix-needed signal is a programming error)
 *
 * Returns the spawn record. The injected spawn function (default
 * spawnCrossPlatform) determines the actual child-process semantics; tests
 * pass a mock that records the call without spawning anything.
 */
export function spawnFixWorker(opts: SpawnFixWorkerOpts): SpawnFixWorkerResult {
  assertSafeSlug(opts.sessionId, "session-id");
  const cwd = opts.cwd ?? process.cwd();
  const pidDir = join(cwd, ".omcp", "state", "team", opts.sessionId);
  if (!existsSync(pidDir)) {
    throw new Error(
      `spawnFixWorker: no pidDir for session '${opts.sessionId}' at ${pidDir}`,
    );
  }

  const state = readModeState<TeamState>("team", opts.sessionId);
  if (state === null) {
    throw new Error(
      `spawnFixWorker: no TeamState for session '${opts.sessionId}'`,
    );
  }

  const verifyReport = opts.verifyReport ?? readLatestVerifyReport(pidDir);
  const verifyFailSummary =
    opts.verifyFailSummary ?? readVerifyFailSummary(pidDir);
  if (!verifyFailSummary) {
    throw new Error(
      `spawnFixWorker: missing verify-fail-summary.json — run team-collect first`,
    );
  }

  // Story 5 bound check. Precedence (single source of truth — matches
  // runTeamCollect's resolveMaxFixLoops):
  //   env OMCP_TEAM_MAX_FIX_LOOPS > verifyReport.max_fix_loops > opts.maxLoops
  //   > DEFAULT_MAX_LOOPS.
  // The report is authoritative because team-verify already baked the
  // operator's --max-loops choice into it; an `opts.maxLoops` here exists
  // only as a test-injection seam and never overrides a report value.
  // This eliminates the resolver-drift bug surfaced by critic review where
  // `omcp team-fix --max-loops N` could disagree with the collect gate.
  const previousCount = state.fix_loop_count ?? 0;
  const maxFixLoops = resolveMaxLoops(
    verifyReport?.max_fix_loops ?? opts.maxLoops,
  );
  if (previousCount >= maxFixLoops) {
    // Loop exhausted — transition to failed and skip the spawn. Defense-in-
    // depth: runTeamCollect also performs this check at the upstream gate
    // (Story 5 extension), but downstream callers that invoke spawnFixWorker
    // directly should not bypass the bound.
    try {
      transitionPhase(
        opts.sessionId,
        "failed",
        `verify_loop_exhausted (${previousCount}/${maxFixLoops})`,
      );
    } catch (err) {
      // Already terminal (failed → failed is an invalid transition) — bound
      // semantic still holds (no spawn). Anything else (e.g., disk I/O) we
      // re-throw so the caller knows the state-write failed.
      if (!(err instanceof InvalidPhaseTransitionError)) throw err;
    }
    return {
      fixWorkerIndex: -1,
      pidPath: "",
      fixLoopCount: previousCount,
      promptPreview: "",
      maxFixLoops,
      exhausted: true,
    };
  }

  const fixLoopCount = incrementFixLoopCount(opts.sessionId, cwd);
  const fixWorkerIndex = nextWorkerIndex(pidDir);

  const prompt = buildFixWorkerPrompt({
    sessionId: opts.sessionId,
    fixLoopCount,
    verifyReport,
    verifyFailSummary,
    pidDir,
  });

  const args = ["-p", prompt, "--allow-all-tools", "--agent", "debugger"];
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    OMCP_TEAM_SESSION_ID: opts.sessionId,
    OMCP_TEAM_WORKER_INDEX: String(fixWorkerIndex),
    OMCP_TEAM_FIX_LOOP_COUNT: String(fixLoopCount),
  };

  const doSpawn: FixWorkerSpawnFn =
    opts.spawnFn ??
    ((cmd, spawnArgs, spawnOpts) => {
      const child = spawnCrossPlatform(cmd, spawnArgs, {
        detached: spawnOpts.detached,
        stdio: "ignore",
        env: spawnOpts.env,
      });
      return {
        pid: child.pid,
        unref: () => child.unref(),
      };
    });

  const handle = doSpawn("copilot", args, { detached: true, env });
  handle.unref();

  const pidPath = join(pidDir, `worker-${fixWorkerIndex}.pid`);
  if (handle.pid !== undefined) {
    // Invariant 9 — pidfile written so cancel/cleanup can SIGTERM later.
    // Invariant 2 — atomicWriteFileSync.
    atomicWriteFileSync(pidPath, String(handle.pid));
  }

  return {
    fixWorkerIndex,
    pidPath,
    pid: handle.pid,
    fixLoopCount,
    promptPreview: prompt.slice(0, 200),
    maxFixLoops,
    exhausted: false,
  };
}

// ─── Story 5: team-fix CLI wrapper ────────────────────────────────────────────

export interface RunTeamFixCliOpts {
  maxLoops?: number;
  cwd?: string;
  spawnFn?: FixWorkerSpawnFn;
  log?: (line: string) => void;
  errLog?: (line: string) => void;
}

/**
 * `omcp team-fix <session-id>` — wraps spawnFixWorker with CLI argv
 * validation + a one-shot summary print. Returns the process exit code:
 *   0 → fix-worker spawned (loop continues)
 *   3 → bound exhausted → TeamState transitioned to `failed`
 *   2 → invalid sessionId
 *   1 → spawn-side error (no pidDir / missing TeamState / no summary)
 */
export function runTeamFixCli(
  sessionId: string,
  opts: RunTeamFixCliOpts = {},
): number {
  const log = opts.log ?? ((line: string) => console.log(line));
  const errLog = opts.errLog ?? ((line: string) => console.error(line));

  try {
    assertSafeSlug(sessionId, "session-id");
  } catch (err) {
    if (err instanceof UnsafeSlugError) {
      errLog(`omcp team-fix: ${err.message}`);
    } else {
      errLog(`omcp team-fix: invalid session-id`);
    }
    return 2;
  }

  let result: SpawnFixWorkerResult;
  try {
    result = spawnFixWorker({
      sessionId,
      maxLoops: opts.maxLoops,
      cwd: opts.cwd,
      spawnFn: opts.spawnFn,
    });
  } catch (err) {
    errLog(`omcp team-fix: ${(err as Error).message}`);
    return 1;
  }

  log(`omcp team-fix: session=${sessionId}`);
  log(`  max_fix_loops:   ${result.maxFixLoops}`);
  log(`  fix_loop_count:  ${result.fixLoopCount}`);
  log(`  exhausted:       ${result.exhausted}`);
  if (result.exhausted) {
    log(`  outcome:         verify_loop_exhausted → TeamState=failed`);
    return 3;
  }
  log(`  fix_worker_idx:  ${result.fixWorkerIndex}`);
  if (result.pid !== undefined) {
    log(`  pid:             ${result.pid}`);
    log(`  pidfile:         ${result.pidPath}`);
  }
  return 0;
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
