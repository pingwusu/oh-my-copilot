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
  clearWorkerVerifyFailSignals,
  resolveMaxLoops,
  runTeamVerify,
  runTeamVerifyCli,
  type VerifyReport,
  type VerifySpawnResult,
} from "../cli/commands/team-verify.js";

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
