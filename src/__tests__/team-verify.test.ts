/**
 * Unit tests for US-omcp-parity-P1-VERIFY-runner.
 *
 * Coverage (per acceptance criteria in docs/plans/omcp-team-omc-parity-iter2.md):
 *   - runTeamVerify all-pass → ok=true, exit 0, report written, no worker signals
 *   - runTeamVerify vitest-fail / tsc-fail / biome-fail / combined-fail → exit 1
 *   - runTeamVerify writes worker-K-verify-fail.json per worker pidfile on fail
 *   - runTeamVerify writes verify-report-N.json schema {iteration, ts, vitest, tsc, biome, ok, max_fix_loops}
 *   - runTeamVerify tails output to 200 lines max
 *   - runTeamVerify iteration counter increments across consecutive calls
 *   - runTeamVerify exit 2 on invalid session-id (assertSafeSlug failure)
 *   - resolveMaxLoops precedence: env > flag > default
 *   - runTeamVerifyCli prints summary + returns exit code
 *
 * All spawn calls are injected via spawnFn for deterministic CI without a real
 * Copilot session.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  buildFixWorkerPrompt,
  clearWorkerVerifyFailSignals,
  incrementFixLoopCount,
  resolveMaxLoops,
  runTeamVerify,
  runTeamVerifyCli,
  spawnFixWorker,
  type FixWorkerSpawnHandle,
  type VerifyFailSummary,
  type VerifyReport,
  type VerifySpawnResult,
} from "../cli/commands/team-verify.js";
import {
  readModeState,
  writeModeState,
  type TeamState,
} from "../runtime/mode-state.js";

// ─── helpers ──────────────────────────────────────────────────────────────────

let tmp: string;
let cwdSnapshot: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "omcp-team-verify-test-"));
  cwdSnapshot = process.cwd();
  process.chdir(tmp);
});

afterEach(() => {
  process.chdir(cwdSnapshot);
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** Build a spawnFn whose return values are keyed by `<cmd> <arg0>` (e.g. "npx vitest"). */
function makeSpawnFn(
  table: Record<string, VerifySpawnResult>,
  capture?: Array<{ cmd: string; args: string[] }>,
): (cmd: string, args: string[]) => VerifySpawnResult {
  return (cmd: string, args: string[]) => {
    capture?.push({ cmd, args });
    const key = `${cmd} ${args[0] ?? ""}`;
    const entry = table[key];
    if (!entry) {
      throw new Error(`makeSpawnFn: no mock for key '${key}' (cmd=${cmd} args=${JSON.stringify(args)})`);
    }
    return entry;
  };
}

const ALL_PASS: Record<string, VerifySpawnResult> = {
  "npx vitest": { exitCode: 0, output: "Test Files  10 passed (10)\nTests  100 passed (100)" },
  "npx tsc": { exitCode: 0, output: "" },
  "npx biome": { exitCode: 0, output: "Checked 50 files in 200ms. No fixes applied." },
};

function writePidFile(pidDir: string, workerIndex: number, pid: number): void {
  fs.mkdirSync(pidDir, { recursive: true });
  fs.writeFileSync(
    path.join(pidDir, `worker-${workerIndex}.pid`),
    String(pid),
    "utf8",
  );
}

function readReport(reportPath: string): VerifyReport {
  return JSON.parse(fs.readFileSync(reportPath, "utf8")) as VerifyReport;
}

// ─── all-pass → ok=true, exit 0 ───────────────────────────────────────────────

describe("runTeamVerify — all-pass path", () => {
  it("returns ok=true exit 0 and writes verify-report-1.json with all checks", () => {
    const sessionId = "sess-all-pass";
    const result = runTeamVerify({
      sessionId,
      cwd: tmp,
      spawnFn: makeSpawnFn(ALL_PASS),
    });

    expect(result.ok).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(result.iteration).toBe(1);
    expect(result.workerSignals).toBe(0);
    expect(result.reportPath).toBeDefined();

    const report = readReport(result.reportPath!);
    expect(report.iteration).toBe(1);
    expect(report.ok).toBe(true);
    expect(report.vitest.exitCode).toBe(0);
    expect(report.tsc.exitCode).toBe(0);
    expect(report.biome.exitCode).toBe(0);
    expect(report.max_fix_loops).toBe(3); // default
    expect(typeof report.ts).toBe("string");
    expect(report.ts).toMatch(/\d{4}-\d{2}-\d{2}T/);
  });

  it("writes no worker-K-verify-fail.json signals when all checks pass", () => {
    const sessionId = "sess-no-signals-on-pass";
    const pidDir = path.join(tmp, ".omcp", "state", "team", sessionId);
    writePidFile(pidDir, 1, 12001);
    writePidFile(pidDir, 2, 12002);

    runTeamVerify({
      sessionId,
      cwd: tmp,
      spawnFn: makeSpawnFn(ALL_PASS),
    });

    expect(fs.existsSync(path.join(pidDir, "worker-1-verify-fail.json"))).toBe(false);
    expect(fs.existsSync(path.join(pidDir, "worker-2-verify-fail.json"))).toBe(false);
  });
});

// ─── per-tool fail paths → ok=false, exit 1 ───────────────────────────────────

describe("runTeamVerify — vitest-fail path", () => {
  it("transitions to ok=false exit 1 when vitest exits 1", () => {
    const sessionId = "sess-vitest-fail";
    const table: Record<string, VerifySpawnResult> = {
      ...ALL_PASS,
      "npx vitest": { exitCode: 1, output: "FAIL  src/foo.test.ts > expected 1 to be 2" },
    };
    const result = runTeamVerify({
      sessionId,
      cwd: tmp,
      spawnFn: makeSpawnFn(table),
    });

    expect(result.ok).toBe(false);
    expect(result.exitCode).toBe(1);

    const report = readReport(result.reportPath!);
    expect(report.vitest.exitCode).toBe(1);
    expect(report.vitest.tail).toContain("FAIL");
    expect(report.tsc.exitCode).toBe(0);
    expect(report.biome.exitCode).toBe(0);
    expect(report.ok).toBe(false);
  });
});

describe("runTeamVerify — tsc-fail path", () => {
  it("transitions to ok=false exit 1 when tsc exits 2 (type error)", () => {
    const sessionId = "sess-tsc-fail";
    const table: Record<string, VerifySpawnResult> = {
      ...ALL_PASS,
      "npx tsc": { exitCode: 2, output: "src/foo.ts:10:5 - error TS2304: Cannot find name 'bar'." },
    };
    const result = runTeamVerify({
      sessionId,
      cwd: tmp,
      spawnFn: makeSpawnFn(table),
    });

    expect(result.ok).toBe(false);
    expect(result.exitCode).toBe(1);

    const report = readReport(result.reportPath!);
    expect(report.tsc.exitCode).toBe(2);
    expect(report.tsc.tail).toContain("TS2304");
    expect(report.vitest.exitCode).toBe(0);
  });
});

describe("runTeamVerify — biome-fail path", () => {
  it("transitions to ok=false exit 1 when biome exits 1 (lint error)", () => {
    const sessionId = "sess-biome-fail";
    const table: Record<string, VerifySpawnResult> = {
      ...ALL_PASS,
      "npx biome": { exitCode: 1, output: "src/foo.ts:5:1 lint/style/noUnusedVariables" },
    };
    const result = runTeamVerify({
      sessionId,
      cwd: tmp,
      spawnFn: makeSpawnFn(table),
    });

    expect(result.ok).toBe(false);
    expect(result.exitCode).toBe(1);

    const report = readReport(result.reportPath!);
    expect(report.biome.exitCode).toBe(1);
    expect(report.biome.tail).toContain("noUnusedVariables");
  });
});

describe("runTeamVerify — combined-fail path", () => {
  it("reports all 3 failures and writes worker-K signals for each worker", () => {
    const sessionId = "sess-combined-fail";
    const pidDir = path.join(tmp, ".omcp", "state", "team", sessionId);
    writePidFile(pidDir, 1, 13001);
    writePidFile(pidDir, 2, 13002);
    writePidFile(pidDir, 3, 13003);

    const table: Record<string, VerifySpawnResult> = {
      "npx vitest": { exitCode: 1, output: "vitest failure" },
      "npx tsc": { exitCode: 2, output: "tsc failure" },
      "npx biome": { exitCode: 1, output: "biome failure" },
    };
    const result = runTeamVerify({
      sessionId,
      cwd: tmp,
      spawnFn: makeSpawnFn(table),
    });

    expect(result.ok).toBe(false);
    expect(result.exitCode).toBe(1);
    expect(result.workerSignals).toBe(3);

    for (const idx of [1, 2, 3]) {
      const signalPath = path.join(pidDir, `worker-${idx}-verify-fail.json`);
      expect(fs.existsSync(signalPath)).toBe(true);
      const sig = JSON.parse(fs.readFileSync(signalPath, "utf8")) as {
        workerIndex: number;
        iteration: number;
        failedTools: string[];
        reportPath: string;
      };
      expect(sig.workerIndex).toBe(idx);
      expect(sig.iteration).toBe(1);
      expect(sig.failedTools).toEqual(["vitest", "tsc", "biome"]);
      expect(sig.reportPath).toBe("verify-report-1.json");
    }
  });
});

// ─── worker signal omits passing tools ────────────────────────────────────────

describe("runTeamVerify — worker signal failedTools array", () => {
  it("only lists the tools that actually failed", () => {
    const sessionId = "sess-signal-subset";
    const pidDir = path.join(tmp, ".omcp", "state", "team", sessionId);
    writePidFile(pidDir, 1, 14001);

    const table: Record<string, VerifySpawnResult> = {
      ...ALL_PASS,
      "npx vitest": { exitCode: 1, output: "vitest only" },
    };
    runTeamVerify({ sessionId, cwd: tmp, spawnFn: makeSpawnFn(table) });

    const sig = JSON.parse(
      fs.readFileSync(path.join(pidDir, "worker-1-verify-fail.json"), "utf8"),
    ) as { failedTools: string[] };
    expect(sig.failedTools).toEqual(["vitest"]);
  });
});

// ─── tail clipping (200 lines) ────────────────────────────────────────────────

describe("runTeamVerify — output tail clipping", () => {
  it("clips tool output to last 200 lines", () => {
    const sessionId = "sess-tail";
    const longOutput = Array.from({ length: 500 }, (_, i) => `line ${i + 1}`).join("\n");
    const table: Record<string, VerifySpawnResult> = {
      ...ALL_PASS,
      "npx vitest": { exitCode: 0, output: longOutput },
    };
    const result = runTeamVerify({
      sessionId,
      cwd: tmp,
      spawnFn: makeSpawnFn(table),
    });

    const report = readReport(result.reportPath!);
    const lines = report.vitest.tail.split("\n");
    expect(lines.length).toBe(200);
    expect(lines[lines.length - 1]).toBe("line 500");
    expect(lines[0]).toBe("line 301");
  });
});

// ─── iteration counter increments ─────────────────────────────────────────────

describe("runTeamVerify — iteration counter", () => {
  it("increments verify-report-N filename across consecutive calls", () => {
    const sessionId = "sess-iter";
    const result1 = runTeamVerify({
      sessionId,
      cwd: tmp,
      spawnFn: makeSpawnFn(ALL_PASS),
    });
    const result2 = runTeamVerify({
      sessionId,
      cwd: tmp,
      spawnFn: makeSpawnFn(ALL_PASS),
    });
    const result3 = runTeamVerify({
      sessionId,
      cwd: tmp,
      spawnFn: makeSpawnFn(ALL_PASS),
    });

    expect(result1.iteration).toBe(1);
    expect(result2.iteration).toBe(2);
    expect(result3.iteration).toBe(3);

    const pidDir = path.join(tmp, ".omcp", "state", "team", sessionId);
    expect(fs.existsSync(path.join(pidDir, "verify-report-1.json"))).toBe(true);
    expect(fs.existsSync(path.join(pidDir, "verify-report-2.json"))).toBe(true);
    expect(fs.existsSync(path.join(pidDir, "verify-report-3.json"))).toBe(true);
  });
});

// ─── invalid sessionId → exit 2 ───────────────────────────────────────────────

describe("runTeamVerify — invalid session-id (Invariant 1)", () => {
  it("returns exit 2 + no writes when sessionId fails assertSafeSlug", () => {
    const result = runTeamVerify({
      sessionId: "../escape",
      cwd: tmp,
      spawnFn: makeSpawnFn(ALL_PASS),
    });
    expect(result.exitCode).toBe(2);
    expect(result.ok).toBe(false);
    expect(result.workerSignals).toBe(0);
    expect(result.reportPath).toBeUndefined();
    // Ensure no file leaked outside the tmp dir.
    expect(fs.existsSync(path.join(tmp, ".omcp"))).toBe(false);
  });

  it("returns exit 2 for slugs with path separators", () => {
    const result = runTeamVerify({
      sessionId: "ab/cd",
      cwd: tmp,
      spawnFn: makeSpawnFn(ALL_PASS),
    });
    expect(result.exitCode).toBe(2);
  });
});

// ─── argv shape captured (spawn called with correct cmd+args) ─────────────────

describe("runTeamVerify — argv shape", () => {
  it("invokes spawnFn with vitest run, tsc --noEmit, biome check src/ in sequence", () => {
    const sessionId = "sess-argv";
    const captured: Array<{ cmd: string; args: string[] }> = [];
    runTeamVerify({
      sessionId,
      cwd: tmp,
      spawnFn: makeSpawnFn(ALL_PASS, captured),
    });
    expect(captured.length).toBe(3);
    expect(captured[0]).toEqual({ cmd: "npx", args: ["vitest", "run"] });
    expect(captured[1]).toEqual({ cmd: "npx", args: ["tsc", "--noEmit"] });
    expect(captured[2]).toEqual({ cmd: "npx", args: ["biome", "check", "src/"] });
  });
});

// ─── resolveMaxLoops precedence: env > flag > default ─────────────────────────

describe("resolveMaxLoops — precedence chain", () => {
  it("returns default (3) when neither env nor flag set", () => {
    expect(resolveMaxLoops(undefined, {})).toBe(3);
  });

  it("returns flag value when set without env", () => {
    expect(resolveMaxLoops(5, {})).toBe(5);
  });

  it("env overrides flag", () => {
    expect(resolveMaxLoops(5, { OMCP_TEAM_MAX_FIX_LOOPS: "7" })).toBe(7);
  });

  it("ignores non-positive env values and falls back to flag", () => {
    expect(resolveMaxLoops(4, { OMCP_TEAM_MAX_FIX_LOOPS: "0" })).toBe(4);
    expect(resolveMaxLoops(4, { OMCP_TEAM_MAX_FIX_LOOPS: "-2" })).toBe(4);
    expect(resolveMaxLoops(4, { OMCP_TEAM_MAX_FIX_LOOPS: "not-a-number" })).toBe(4);
  });

  it("ignores non-positive flag values and falls back to default", () => {
    expect(resolveMaxLoops(0, {})).toBe(3);
    expect(resolveMaxLoops(-1, {})).toBe(3);
  });

  it("empty-string env behaves like unset", () => {
    expect(resolveMaxLoops(undefined, { OMCP_TEAM_MAX_FIX_LOOPS: "" })).toBe(3);
  });

  it("flag value persisted into verify-report-N.json max_fix_loops field", () => {
    const sessionId = "sess-max-loops-report";
    const result = runTeamVerify({
      sessionId,
      maxLoops: 7,
      cwd: tmp,
      spawnFn: makeSpawnFn(ALL_PASS),
    });
    const report = readReport(result.reportPath!);
    // resolveMaxLoops is called inside runTeamVerify with the current env.
    // In this test no env is set, so flag=7 should win.
    delete process.env.OMCP_TEAM_MAX_FIX_LOOPS;
    expect(report.max_fix_loops).toBe(7);
  });
});

// ─── stale signal cleanup ─────────────────────────────────────────────────────

describe("clearWorkerVerifyFailSignals", () => {
  it("deletes only worker-K-verify-fail.json files (preserves pidfiles, shards, reports)", () => {
    const sessionId = "sess-clear-scope";
    const pidDir = path.join(tmp, ".omcp", "state", "team", sessionId);
    fs.mkdirSync(pidDir, { recursive: true });
    fs.writeFileSync(path.join(pidDir, "worker-1.pid"), "111", "utf8");
    fs.writeFileSync(path.join(pidDir, "worker-1-shard.json"), "{}", "utf8");
    fs.writeFileSync(path.join(pidDir, "worker-1-verify-fail.json"), "{}", "utf8");
    fs.writeFileSync(path.join(pidDir, "worker-2-verify-fail.json"), "{}", "utf8");
    fs.writeFileSync(path.join(pidDir, "verify-report-1.json"), "{}", "utf8");
    fs.writeFileSync(path.join(pidDir, "conflicts.json"), "{}", "utf8");

    const cleared = clearWorkerVerifyFailSignals(pidDir);
    expect(cleared).toBe(2);
    expect(fs.existsSync(path.join(pidDir, "worker-1.pid"))).toBe(true);
    expect(fs.existsSync(path.join(pidDir, "worker-1-shard.json"))).toBe(true);
    expect(fs.existsSync(path.join(pidDir, "verify-report-1.json"))).toBe(true);
    expect(fs.existsSync(path.join(pidDir, "conflicts.json"))).toBe(true);
    expect(fs.existsSync(path.join(pidDir, "worker-1-verify-fail.json"))).toBe(false);
    expect(fs.existsSync(path.join(pidDir, "worker-2-verify-fail.json"))).toBe(false);
  });

  it("returns 0 when pidDir does not exist", () => {
    expect(clearWorkerVerifyFailSignals(path.join(tmp, "nope"))).toBe(0);
  });
});

describe("runTeamVerify — stale signal cleanup invariant", () => {
  it("clears prior-fail signals when subsequent run passes (no stale signals leak)", () => {
    const sessionId = "sess-stale-clear";
    const pidDir = path.join(tmp, ".omcp", "state", "team", sessionId);
    writePidFile(pidDir, 1, 16001);
    writePidFile(pidDir, 2, 16002);

    // Iteration 1: vitest fails → 2 signal files written.
    const tableFail: Record<string, VerifySpawnResult> = {
      ...ALL_PASS,
      "npx vitest": { exitCode: 1, output: "fail" },
    };
    const r1 = runTeamVerify({
      sessionId,
      cwd: tmp,
      spawnFn: makeSpawnFn(tableFail),
    });
    expect(r1.workerSignals).toBe(2);
    expect(fs.existsSync(path.join(pidDir, "worker-1-verify-fail.json"))).toBe(true);
    expect(fs.existsSync(path.join(pidDir, "worker-2-verify-fail.json"))).toBe(true);

    // Iteration 2: all pass → stale signals from iteration 1 must be cleared.
    const r2 = runTeamVerify({
      sessionId,
      cwd: tmp,
      spawnFn: makeSpawnFn(ALL_PASS),
    });
    expect(r2.ok).toBe(true);
    expect(r2.workerSignals).toBe(0);
    expect(fs.existsSync(path.join(pidDir, "worker-1-verify-fail.json"))).toBe(false);
    expect(fs.existsSync(path.join(pidDir, "worker-2-verify-fail.json"))).toBe(false);
    // verify-report-2.json must be present + ok=true.
    const report = readReport(path.join(pidDir, "verify-report-2.json"));
    expect(report.ok).toBe(true);
  });

  it("rewrites signal files with current iteration metadata when re-running a failure", () => {
    const sessionId = "sess-rewrite-signal";
    const pidDir = path.join(tmp, ".omcp", "state", "team", sessionId);
    writePidFile(pidDir, 1, 17001);

    const tableFail: Record<string, VerifySpawnResult> = {
      ...ALL_PASS,
      "npx vitest": { exitCode: 1, output: "fail" },
    };
    runTeamVerify({ sessionId, cwd: tmp, spawnFn: makeSpawnFn(tableFail) });
    runTeamVerify({ sessionId, cwd: tmp, spawnFn: makeSpawnFn(tableFail) });

    const sig = JSON.parse(
      fs.readFileSync(path.join(pidDir, "worker-1-verify-fail.json"), "utf8"),
    ) as { iteration: number; reportPath: string };
    expect(sig.iteration).toBe(2);
    expect(sig.reportPath).toBe("verify-report-2.json");
  });
});

// ─── CLI wrapper ──────────────────────────────────────────────────────────────

describe("runTeamVerifyCli — argv validation + summary", () => {
  it("returns 2 + prints error on invalid sessionId", () => {
    const out: string[] = [];
    const err: string[] = [];
    const code = runTeamVerifyCli("../escape", {
      cwd: tmp,
      log: (l) => out.push(l),
      errLog: (l) => err.push(l),
      spawnFn: makeSpawnFn(ALL_PASS),
    });
    expect(code).toBe(2);
    expect(err.join("\n")).toMatch(/team-verify.*unsafe/);
    expect(out.length).toBe(0);
  });

  it("returns 0 + prints summary on all-pass", () => {
    const out: string[] = [];
    const code = runTeamVerifyCli("sess-cli-pass", {
      cwd: tmp,
      log: (l) => out.push(l),
      spawnFn: makeSpawnFn(ALL_PASS),
    });
    expect(code).toBe(0);
    const summary = out.join("\n");
    expect(summary).toMatch(/session=sess-cli-pass/);
    expect(summary).toMatch(/iteration:\s+1/);
    expect(summary).toMatch(/ok:\s+true/);
    expect(summary).toMatch(/max_fix_loops:\s+3/);
    expect(summary).toMatch(/worker signals:\s+0/);
    expect(summary).toMatch(/verify-report-1\.json/);
  });

  it("returns 1 + lists failed tools on failure", () => {
    const out: string[] = [];
    const table: Record<string, VerifySpawnResult> = {
      ...ALL_PASS,
      "npx vitest": { exitCode: 1, output: "fail" },
      "npx biome": { exitCode: 1, output: "fail" },
    };
    const code = runTeamVerifyCli("sess-cli-fail", {
      cwd: tmp,
      log: (l) => out.push(l),
      spawnFn: makeSpawnFn(table),
    });
    expect(code).toBe(1);
    const summary = out.join("\n");
    expect(summary).toMatch(/ok:\s+false/);
    expect(summary).toMatch(/failed:\s+vitest, biome/);
  });
});

// ─── Story 4: spawnFixWorker ──────────────────────────────────────────────────

/**
 * Seed a minimal TeamState for fix-worker spawn tests. Includes the v2.1
 * fix_loop_count field (Story 4) as undefined so incrementFixLoopCount has
 * to start from 0.
 */
function seedFixTeamState(
  sessionId: string,
  options?: { fixLoopCount?: number; workerCount?: number },
): void {
  const workerCount = options?.workerCount ?? 2;
  writeModeState<TeamState>(
    "team",
    {
      active: true,
      session_id: sessionId,
      started_at: new Date().toISOString(),
      spawned: workerCount,
      done: 0,
      workers: Array.from({ length: workerCount }, (_, i) => ({
        id: `worker-${i + 1}`,
        status: "pending",
      })),
      current_phase: "fixing",
      stage_history: ["initializing", "executing", "fixing"],
      fix_loop_count: options?.fixLoopCount,
    },
    sessionId,
  );
}

function seedVerifyFailSummary(
  pidDir: string,
  sessionId: string,
  workers: Array<{ index: number; failedTools: string[] }>,
): void {
  fs.mkdirSync(pidDir, { recursive: true });
  const ts = new Date().toISOString();
  const summary: VerifyFailSummary = {
    detectedAt: ts,
    sessionId,
    signalCount: workers.length,
    signals: workers.map((w) => ({
      workerIndex: w.index,
      iteration: 1,
      ts,
      failedTools: w.failedTools,
      reportPath: "verify-report-1.json",
    })),
  };
  fs.writeFileSync(
    path.join(pidDir, "verify-fail-summary.json"),
    JSON.stringify(summary, null, 2),
    "utf8",
  );
}

function seedVerifyReport(
  pidDir: string,
  iteration: number,
  failed: { vitest?: boolean; tsc?: boolean; biome?: boolean },
): void {
  fs.mkdirSync(pidDir, { recursive: true });
  const tool = (failedFlag?: boolean) => ({
    exitCode: failedFlag ? 1 : 0,
    tail: failedFlag ? "FAIL example output line" : "",
  });
  const report: VerifyReport = {
    iteration,
    ts: new Date().toISOString(),
    max_fix_loops: 3,
    vitest: tool(failed.vitest),
    tsc: tool(failed.tsc),
    biome: tool(failed.biome),
    ok: !(failed.vitest ?? failed.tsc ?? failed.biome),
  };
  fs.writeFileSync(
    path.join(pidDir, `verify-report-${iteration}.json`),
    JSON.stringify(report, null, 2),
    "utf8",
  );
}

/** Build a mock spawnFn that captures the spawn invocation + returns a configurable pid. */
function makeFixSpawn(
  pidToReturn: number | undefined,
  captured: Array<{
    cmd: string;
    args: string[];
    env: NodeJS.ProcessEnv;
    detached: boolean;
  }>,
): (
  cmd: string,
  args: string[],
  opts: { detached: boolean; env: NodeJS.ProcessEnv },
) => FixWorkerSpawnHandle {
  return (cmd, args, opts) => {
    captured.push({ cmd, args, env: opts.env, detached: opts.detached });
    return { pid: pidToReturn, unref: () => {} };
  };
}

describe("incrementFixLoopCount", () => {
  it("treats missing TeamState as no-op returning 0", () => {
    expect(incrementFixLoopCount("sess-no-state", tmp)).toBe(0);
  });

  it("increments from undefined → 1", () => {
    const sessionId = "sess-inc-from-undef";
    seedFixTeamState(sessionId);
    expect(incrementFixLoopCount(sessionId, tmp)).toBe(1);
    expect(readModeState<TeamState>("team", sessionId)!.fix_loop_count).toBe(1);
  });

  it("increments from N → N+1 across consecutive calls", () => {
    const sessionId = "sess-inc-monotonic";
    seedFixTeamState(sessionId);
    expect(incrementFixLoopCount(sessionId, tmp)).toBe(1);
    expect(incrementFixLoopCount(sessionId, tmp)).toBe(2);
    expect(incrementFixLoopCount(sessionId, tmp)).toBe(3);
    expect(readModeState<TeamState>("team", sessionId)!.fix_loop_count).toBe(3);
  });
});

describe("buildFixWorkerPrompt", () => {
  it("includes session id, fix-loop number, failed-tool list, and re-run instruction", () => {
    const pidDir = "/fake/pid/dir";
    const prompt = buildFixWorkerPrompt({
      sessionId: "sess-prompt",
      fixLoopCount: 2,
      pidDir,
      verifyReport: {
        iteration: 1,
        ts: "2026-05-25T00:00:00Z",
        max_fix_loops: 3,
        vitest: { exitCode: 1, tail: "VITEST FAIL" },
        tsc: { exitCode: 0, tail: "" },
        biome: { exitCode: 1, tail: "BIOME FAIL" },
        ok: false,
      },
      verifyFailSummary: {
        detectedAt: "2026-05-25T00:00:01Z",
        sessionId: "sess-prompt",
        signalCount: 2,
        signals: [
          {
            workerIndex: 1,
            iteration: 1,
            ts: "2026-05-25T00:00:00Z",
            failedTools: ["vitest"],
            reportPath: "verify-report-1.json",
          },
          {
            workerIndex: 2,
            iteration: 1,
            ts: "2026-05-25T00:00:00Z",
            failedTools: ["biome"],
            reportPath: "verify-report-1.json",
          },
        ],
      },
    });

    expect(prompt).toContain("sess-prompt");
    expect(prompt).toContain("fix attempt #2");
    expect(prompt).toContain("vitest, biome"); // failed tools list
    expect(prompt).toContain("VITEST FAIL");
    expect(prompt).toContain("BIOME FAIL");
    expect(prompt).not.toContain("--- tsc"); // tsc passed → not included
    expect(prompt).toContain("worker-1[vitest]");
    expect(prompt).toContain("worker-2[biome]");
    expect(prompt).toContain("omcp team-verify sess-prompt");
    expect(prompt).toContain(pidDir);
  });

  it("truncates a prompt longer than FIX_PROMPT_MAX_CHARS (4000)", () => {
    const longTail = "x".repeat(20000);
    const prompt = buildFixWorkerPrompt({
      sessionId: "sess-long",
      fixLoopCount: 1,
      pidDir: "/p",
      verifyReport: {
        iteration: 1,
        ts: "2026-05-25T00:00:00Z",
        max_fix_loops: 3,
        vitest: { exitCode: 1, tail: longTail },
        tsc: { exitCode: 0, tail: "" },
        biome: { exitCode: 0, tail: "" },
        ok: false,
      },
    });
    expect(prompt.length).toBeLessThanOrEqual(4000);
    expect(prompt).toContain("truncated");
  });
});

describe("spawnFixWorker — happy path", () => {
  it("increments fix_loop_count, picks next free worker index, writes pidfile, spawns copilot with agent=debugger", () => {
    const sessionId = "sess-fix-happy";
    seedFixTeamState(sessionId);
    const pidDir = path.join(tmp, ".omcp", "state", "team", sessionId);
    writePidFile(pidDir, 1, 60001);
    writePidFile(pidDir, 2, 60002);
    seedVerifyReport(pidDir, 1, { vitest: true });
    seedVerifyFailSummary(pidDir, sessionId, [
      { index: 1, failedTools: ["vitest"] },
      { index: 2, failedTools: ["vitest"] },
    ]);

    const captured: Array<{
      cmd: string;
      args: string[];
      env: NodeJS.ProcessEnv;
      detached: boolean;
    }> = [];
    const result = spawnFixWorker({
      sessionId,
      cwd: tmp,
      spawnFn: makeFixSpawn(99999, captured),
    });

    expect(result.fixWorkerIndex).toBe(3); // 1, 2 taken → next = 3
    expect(result.fixLoopCount).toBe(1);
    expect(result.pid).toBe(99999);
    expect(result.pidPath).toBe(path.join(pidDir, "worker-3.pid"));

    // Pidfile must be written.
    expect(fs.existsSync(result.pidPath)).toBe(true);
    expect(fs.readFileSync(result.pidPath, "utf8")).toBe("99999");

    // TeamState.fix_loop_count updated.
    expect(readModeState<TeamState>("team", sessionId)!.fix_loop_count).toBe(1);

    // Spawn invocation captured with correct shape.
    expect(captured).toHaveLength(1);
    expect(captured[0].cmd).toBe("copilot");
    expect(captured[0].detached).toBe(true);
    expect(captured[0].args).toContain("-p");
    expect(captured[0].args).toContain("--allow-all-tools");
    expect(captured[0].args).toContain("--agent");
    expect(captured[0].args[captured[0].args.indexOf("--agent") + 1]).toBe(
      "debugger",
    );
    // Env vars per runTeam pattern.
    expect(captured[0].env.OMCP_TEAM_SESSION_ID).toBe(sessionId);
    expect(captured[0].env.OMCP_TEAM_WORKER_INDEX).toBe("3");
    expect(captured[0].env.OMCP_TEAM_FIX_LOOP_COUNT).toBe("1");
  });

  it("prompt body references verify-fail-summary contents", () => {
    const sessionId = "sess-fix-prompt";
    seedFixTeamState(sessionId);
    const pidDir = path.join(tmp, ".omcp", "state", "team", sessionId);
    writePidFile(pidDir, 1, 60101);
    seedVerifyReport(pidDir, 2, { tsc: true });
    seedVerifyFailSummary(pidDir, sessionId, [
      { index: 1, failedTools: ["tsc"] },
    ]);

    const captured: Array<{
      cmd: string;
      args: string[];
      env: NodeJS.ProcessEnv;
      detached: boolean;
    }> = [];
    spawnFixWorker({
      sessionId,
      cwd: tmp,
      spawnFn: makeFixSpawn(60500, captured),
    });

    const promptArgIndex = captured[0].args.indexOf("-p") + 1;
    const prompt = captured[0].args[promptArgIndex];
    expect(prompt).toContain(sessionId);
    expect(prompt).toContain("tsc"); // failed tool
    expect(prompt).toContain("FAIL example output line"); // tail from seeded report
  });
});

describe("spawnFixWorker — guard rails", () => {
  it("throws on invalid sessionId (assertSafeSlug)", () => {
    expect(() =>
      spawnFixWorker({
        sessionId: "../escape",
        cwd: tmp,
        spawnFn: makeFixSpawn(1, []),
      }),
    ).toThrow();
  });

  it("throws when pidDir is absent (no team session started)", () => {
    expect(() =>
      spawnFixWorker({
        sessionId: "sess-no-piddir",
        cwd: tmp,
        spawnFn: makeFixSpawn(1, []),
      }),
    ).toThrow(/no pidDir/);
  });

  it("throws when TeamState is missing", () => {
    const sessionId = "sess-no-state";
    const pidDir = path.join(tmp, ".omcp", "state", "team", sessionId);
    fs.mkdirSync(pidDir, { recursive: true });
    seedVerifyFailSummary(pidDir, sessionId, [{ index: 1, failedTools: ["vitest"] }]);
    expect(() =>
      spawnFixWorker({
        sessionId,
        cwd: tmp,
        spawnFn: makeFixSpawn(1, []),
      }),
    ).toThrow(/no TeamState/);
  });

  it("throws when verify-fail-summary.json is absent (programming error to fix-spawn without collect)", () => {
    const sessionId = "sess-no-summary";
    seedFixTeamState(sessionId);
    const pidDir = path.join(tmp, ".omcp", "state", "team", sessionId);
    writePidFile(pidDir, 1, 60201);
    expect(() =>
      spawnFixWorker({
        sessionId,
        cwd: tmp,
        spawnFn: makeFixSpawn(1, []),
      }),
    ).toThrow(/verify-fail-summary/);
  });
});

describe("spawnFixWorker — successive spawns chain fix_loop_count + worker index", () => {
  it("two spawns increment fix_loop_count 0→1→2 and worker index next→next+1", () => {
    const sessionId = "sess-fix-chain";
    seedFixTeamState(sessionId);
    const pidDir = path.join(tmp, ".omcp", "state", "team", sessionId);
    writePidFile(pidDir, 1, 60301);
    seedVerifyReport(pidDir, 1, { vitest: true });
    seedVerifyFailSummary(pidDir, sessionId, [{ index: 1, failedTools: ["vitest"] }]);

    const captured: Array<{
      cmd: string;
      args: string[];
      env: NodeJS.ProcessEnv;
      detached: boolean;
    }> = [];
    const r1 = spawnFixWorker({
      sessionId,
      cwd: tmp,
      spawnFn: makeFixSpawn(60401, captured),
    });
    const r2 = spawnFixWorker({
      sessionId,
      cwd: tmp,
      spawnFn: makeFixSpawn(60402, captured),
    });

    expect(r1.fixLoopCount).toBe(1);
    expect(r2.fixLoopCount).toBe(2);
    expect(r1.fixWorkerIndex).toBe(2); // worker-1.pid exists → next=2
    expect(r2.fixWorkerIndex).toBe(3); // worker-1 + worker-2 now → next=3
    expect(captured).toHaveLength(2);
    expect(captured[0].env.OMCP_TEAM_FIX_LOOP_COUNT).toBe("1");
    expect(captured[1].env.OMCP_TEAM_FIX_LOOP_COUNT).toBe("2");
    expect(readModeState<TeamState>("team", sessionId)!.fix_loop_count).toBe(2);
  });
});

// ─── Story 5: loop-bounding ───────────────────────────────────────────────────

describe("spawnFixWorker — bound check (Story 5)", () => {
  it("allows spawn when previousCount=0 + maxLoops=3 (counter→1)", () => {
    const sessionId = "sess-bound-allow-0-of-3";
    seedFixTeamState(sessionId, { fixLoopCount: 0 });
    const pidDir = path.join(tmp, ".omcp", "state", "team", sessionId);
    writePidFile(pidDir, 1, 70001);
    seedVerifyReport(pidDir, 1, { vitest: true });
    seedVerifyFailSummary(pidDir, sessionId, [{ index: 1, failedTools: ["vitest"] }]);

    const result = spawnFixWorker({
      sessionId,
      cwd: tmp,
      maxLoops: 3,
      spawnFn: makeFixSpawn(70901, []),
    });

    expect(result.exhausted).toBe(false);
    expect(result.fixLoopCount).toBe(1);
    expect(result.maxFixLoops).toBe(3);
    expect(readModeState<TeamState>("team", sessionId)!.current_phase).toBe(
      "fixing",
    );
  });

  it("refuses spawn when previousCount=maxLoops (1/1) → exhausted + failed transition", () => {
    const sessionId = "sess-bound-exhaust-1-of-1";
    seedFixTeamState(sessionId, { fixLoopCount: 1 });
    const pidDir = path.join(tmp, ".omcp", "state", "team", sessionId);
    writePidFile(pidDir, 1, 70002);
    seedVerifyReport(pidDir, 1, { vitest: true });
    seedVerifyFailSummary(pidDir, sessionId, [{ index: 1, failedTools: ["vitest"] }]);

    const captured: Array<{
      cmd: string;
      args: string[];
      env: NodeJS.ProcessEnv;
      detached: boolean;
    }> = [];
    const result = spawnFixWorker({
      sessionId,
      cwd: tmp,
      maxLoops: 1,
      spawnFn: makeFixSpawn(70902, captured),
    });

    expect(result.exhausted).toBe(true);
    expect(result.fixLoopCount).toBe(1); // not incremented
    expect(result.maxFixLoops).toBe(1);
    expect(captured).toHaveLength(0); // no spawn occurred
    // TeamState transitions to failed.
    const state = readModeState<TeamState>("team", sessionId)!;
    expect(state.current_phase).toBe("failed");
    expect(state.fix_loop_count).toBe(1); // unchanged
  });

  it("refuses spawn when previousCount=maxLoops (3/3) → failed", () => {
    const sessionId = "sess-bound-exhaust-3-of-3";
    seedFixTeamState(sessionId, { fixLoopCount: 3 });
    const pidDir = path.join(tmp, ".omcp", "state", "team", sessionId);
    writePidFile(pidDir, 1, 70003);
    seedVerifyReport(pidDir, 1, { vitest: true });
    seedVerifyFailSummary(pidDir, sessionId, [{ index: 1, failedTools: ["vitest"] }]);

    const result = spawnFixWorker({
      sessionId,
      cwd: tmp,
      maxLoops: 3,
      spawnFn: makeFixSpawn(70903, []),
    });

    expect(result.exhausted).toBe(true);
    expect(readModeState<TeamState>("team", sessionId)!.current_phase).toBe(
      "failed",
    );
  });

  it("allows spawn at the boundary previousCount=maxLoops-1 (2/3 → 3)", () => {
    const sessionId = "sess-bound-boundary-2-of-3";
    seedFixTeamState(sessionId, { fixLoopCount: 2 });
    const pidDir = path.join(tmp, ".omcp", "state", "team", sessionId);
    writePidFile(pidDir, 1, 70004);
    seedVerifyReport(pidDir, 1, { vitest: true });
    seedVerifyFailSummary(pidDir, sessionId, [{ index: 1, failedTools: ["vitest"] }]);

    const result = spawnFixWorker({
      sessionId,
      cwd: tmp,
      maxLoops: 3,
      spawnFn: makeFixSpawn(70904, []),
    });

    expect(result.exhausted).toBe(false);
    expect(result.fixLoopCount).toBe(3);
  });

  it("env OMCP_TEAM_MAX_FIX_LOOPS overrides opts.maxLoops at the bound check", () => {
    const sessionId = "sess-bound-env-override";
    seedFixTeamState(sessionId, { fixLoopCount: 2 });
    const pidDir = path.join(tmp, ".omcp", "state", "team", sessionId);
    writePidFile(pidDir, 1, 70005);
    seedVerifyReport(pidDir, 1, { vitest: true });
    seedVerifyFailSummary(pidDir, sessionId, [{ index: 1, failedTools: ["vitest"] }]);

    const prevEnv = process.env.OMCP_TEAM_MAX_FIX_LOOPS;
    process.env.OMCP_TEAM_MAX_FIX_LOOPS = "2"; // tighter than opts.maxLoops=5
    try {
      const result = spawnFixWorker({
        sessionId,
        cwd: tmp,
        maxLoops: 5,
        spawnFn: makeFixSpawn(70905, []),
      });
      // 2 >= 2 → exhausted under the env-imposed bound.
      expect(result.exhausted).toBe(true);
      expect(result.maxFixLoops).toBe(2);
    } finally {
      if (prevEnv === undefined) delete process.env.OMCP_TEAM_MAX_FIX_LOOPS;
      else process.env.OMCP_TEAM_MAX_FIX_LOOPS = prevEnv;
    }
  });

  it("integration: max-loops=3 + 3 successive fail-spawns → 4th refused as exhausted", () => {
    const sessionId = "sess-bound-integration-3-fails";
    seedFixTeamState(sessionId, { fixLoopCount: 0 });
    const pidDir = path.join(tmp, ".omcp", "state", "team", sessionId);
    writePidFile(pidDir, 1, 70006);
    seedVerifyReport(pidDir, 1, { vitest: true });
    seedVerifyFailSummary(pidDir, sessionId, [{ index: 1, failedTools: ["vitest"] }]);

    const r1 = spawnFixWorker({
      sessionId,
      cwd: tmp,
      maxLoops: 3,
      spawnFn: makeFixSpawn(80001, []),
    });
    const r2 = spawnFixWorker({
      sessionId,
      cwd: tmp,
      maxLoops: 3,
      spawnFn: makeFixSpawn(80002, []),
    });
    const r3 = spawnFixWorker({
      sessionId,
      cwd: tmp,
      maxLoops: 3,
      spawnFn: makeFixSpawn(80003, []),
    });
    const r4 = spawnFixWorker({
      sessionId,
      cwd: tmp,
      maxLoops: 3,
      spawnFn: makeFixSpawn(80004, []),
    });

    expect(r1.exhausted).toBe(false);
    expect(r1.fixLoopCount).toBe(1);
    expect(r2.exhausted).toBe(false);
    expect(r2.fixLoopCount).toBe(2);
    expect(r3.exhausted).toBe(false);
    expect(r3.fixLoopCount).toBe(3);
    expect(r4.exhausted).toBe(true);
    expect(r4.fixLoopCount).toBe(3);
    expect(readModeState<TeamState>("team", sessionId)!.current_phase).toBe(
      "failed",
    );
  });

  it("verifyReport.max_fix_loops carries forward into the bound when opts.maxLoops omitted", () => {
    const sessionId = "sess-bound-report-carry";
    seedFixTeamState(sessionId, { fixLoopCount: 1 });
    const pidDir = path.join(tmp, ".omcp", "state", "team", sessionId);
    writePidFile(pidDir, 1, 70007);
    // Report sets max_fix_loops=1 via runTeamVerify with maxLoops=1.
    runTeamVerify({
      sessionId,
      cwd: tmp,
      maxLoops: 1,
      spawnFn: makeSpawnFn({
        ...ALL_PASS,
        "npx vitest": { exitCode: 1, output: "fail" },
      }),
    });
    seedVerifyFailSummary(pidDir, sessionId, [{ index: 1, failedTools: ["vitest"] }]);

    // No env, no opts.maxLoops → falls back to report.max_fix_loops=1.
    // previousCount=1 >= 1 → exhausted.
    const prevEnv = process.env.OMCP_TEAM_MAX_FIX_LOOPS;
    delete process.env.OMCP_TEAM_MAX_FIX_LOOPS;
    try {
      const result = spawnFixWorker({
        sessionId,
        cwd: tmp,
        spawnFn: makeFixSpawn(70907, []),
      });
      expect(result.maxFixLoops).toBe(1);
      expect(result.exhausted).toBe(true);
    } finally {
      if (prevEnv !== undefined) process.env.OMCP_TEAM_MAX_FIX_LOOPS = prevEnv;
    }
  });
});

describe("spawnFixWorker — skips pidfile write when spawn returns no pid", () => {
  it("a spawn returning pid=undefined still completes but writes no pidfile", () => {
    const sessionId = "sess-no-pid";
    seedFixTeamState(sessionId);
    const pidDir = path.join(tmp, ".omcp", "state", "team", sessionId);
    writePidFile(pidDir, 1, 60501);
    seedVerifyReport(pidDir, 1, { biome: true });
    seedVerifyFailSummary(pidDir, sessionId, [{ index: 1, failedTools: ["biome"] }]);

    const result = spawnFixWorker({
      sessionId,
      cwd: tmp,
      spawnFn: makeFixSpawn(undefined, []),
    });

    expect(result.pid).toBeUndefined();
    expect(fs.existsSync(result.pidPath)).toBe(false);
    // fix_loop_count still incremented (intent honored even if spawn was nominal).
    expect(result.fixLoopCount).toBe(1);
  });
});
