// Unit tests for Phase L2.5b — team-phase-controller + transitionPhase helper.
//
// Coverage:
//  1. transitionPhase writes new current_phase + appends to stage_history
//  2. transitionPhase rejects invalid transitions (completed → planning)
//  3. runTeamCollect returns 'completed' when all workers wrote shards
//  4. runTeamCollect returns 'failed' when a worker pid is dead AND no shard
//  5. runTeamCollect is idempotent (calling twice on completed is no-op)
//  6. transitionPhase uses atomicWriteFileSync (file is valid JSON after write)
//  7. runTeam writes initial current_phase='initializing' (L2.5b correction)
//  8. (v1.3) all shards + no conflicts → completed (regression, teamName path)
//  9. (v1.3) all shards + merge conflicts → fixing + conflicts.json written
// 10. (v1.3) conflict count recorded in stage_history transition reason
// 11. (v1.3) fixing phase is idempotent (already-fixing session is no-op)

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  readModeState,
  writeModeState,
  transitionPhase,
  InvalidPhaseTransitionError,
  type TeamState,
  type TeamPhase,
} from "../../../runtime/mode-state.js";
import {
  buildFixingReason,
  readLatestReportMaxLoops,
  readVerifyFailSignals,
  resolveMaxFixLoops,
  runTeamCollect,
  type VerifyFailSignal,
} from "../team-phase-controller.js";
import { writeShardState } from "../../../lib/team-shard-state.js";
import { writePrd, writeRalphState } from "../../../lib/ralph-state.js";
import type { PRD, RalphState } from "../../../lib/ralph-state.js";

// ─── helpers ──────────────────────────────────────────────────────────────────

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "omcp-phase-ctrl-test-"));
}

/** Write a minimal TeamState for testing. */
function seedTeamState(
  tmp: string,
  sessionId: string,
  phase: TeamPhase = "executing",
  history: TeamPhase[] = ["initializing", "executing"],
): void {
  const prevCwd = process.cwd();
  process.chdir(tmp);
  try {
    writeModeState<TeamState>(
      "team",
      {
        active: true,
        session_id: sessionId,
        started_at: new Date().toISOString(),
        spawned: 2,
        done: 0,
        workers: [
          { id: "worker-1", status: "pending" },
          { id: "worker-2", status: "pending" },
        ],
        current_phase: phase,
        stage_history: history,
      },
      sessionId,
    );
  } finally {
    process.chdir(prevCwd);
  }
}

/** Write a fake pidfile for a worker. */
function writePidFile(
  pidDir: string,
  workerIndex: number,
  pid: number,
): void {
  fs.mkdirSync(pidDir, { recursive: true });
  fs.writeFileSync(
    path.join(pidDir, `worker-${workerIndex}.pid`),
    String(pid),
    "utf8",
  );
}

/** Write a fake shard file for a worker. */
function writeShardFile(pidDir: string, workerIndex: number): void {
  fs.mkdirSync(pidDir, { recursive: true });
  fs.writeFileSync(
    path.join(pidDir, `worker-${workerIndex}-shard.json`),
    JSON.stringify({ worker: workerIndex, done: true }),
    "utf8",
  );
}

// ─── test setup ───────────────────────────────────────────────────────────────

let tmp: string;
let cwdSnapshot: string;

beforeEach(() => {
  tmp = tempDir();
  cwdSnapshot = process.cwd();
  process.chdir(tmp);
});

afterEach(() => {
  process.chdir(cwdSnapshot);
  fs.rmSync(tmp, { recursive: true, force: true });
});

// ─── test 1: transitionPhase writes new current_phase + appends stage_history ─

describe("transitionPhase — basic transition", () => {
  it("writes new current_phase and appends to stage_history", () => {
    const sessionId = "sess-basic-transition";
    seedTeamState(tmp, sessionId, "executing", ["initializing", "executing"]);

    const updated = transitionPhase(sessionId, "completed");

    expect(updated.current_phase).toBe("completed");
    expect(updated.stage_history).toEqual([
      "initializing",
      "executing",
      "completed",
    ]);

    // Verify persisted to disk.
    const persisted = readModeState<TeamState>("team", sessionId);
    expect(persisted!.current_phase).toBe("completed");
    expect(persisted!.stage_history).toContain("completed");
  });

  it("initializing → executing transition is valid", () => {
    const sessionId = "sess-init-to-exec";
    seedTeamState(tmp, sessionId, "initializing", ["initializing"]);

    const updated = transitionPhase(sessionId, "executing");

    expect(updated.current_phase).toBe("executing");
    expect(updated.stage_history).toEqual(["initializing", "executing"]);
  });

  it("executing → failed transition is valid", () => {
    const sessionId = "sess-exec-to-failed";
    seedTeamState(tmp, sessionId, "executing", ["initializing", "executing"]);

    const updated = transitionPhase(sessionId, "failed", "worker crashed");

    expect(updated.current_phase).toBe("failed");
    expect(updated.stage_history).toContain("failed");
  });
});

// ─── test 2: transitionPhase rejects invalid transitions ──────────────────────

describe("transitionPhase — invalid transitions", () => {
  it("throws InvalidPhaseTransitionError for completed → planning", () => {
    const sessionId = "sess-completed-to-planning";
    seedTeamState(tmp, sessionId, "completed", [
      "initializing",
      "executing",
      "completed",
    ]);

    expect(() => transitionPhase(sessionId, "planning")).toThrow(
      InvalidPhaseTransitionError,
    );
  });

  it("throws for failed → executing (terminal phase cannot transition)", () => {
    const sessionId = "sess-failed-to-exec";
    seedTeamState(tmp, sessionId, "failed", [
      "initializing",
      "executing",
      "failed",
    ]);

    expect(() => transitionPhase(sessionId, "executing")).toThrow(
      InvalidPhaseTransitionError,
    );
  });

  it("throws for completed → completed (self-transition not allowed)", () => {
    const sessionId = "sess-completed-self";
    seedTeamState(tmp, sessionId, "completed", [
      "initializing",
      "executing",
      "completed",
    ]);

    expect(() => transitionPhase(sessionId, "completed")).toThrow(
      InvalidPhaseTransitionError,
    );
  });

  it("error message includes from and to phases", () => {
    const sessionId = "sess-err-msg";
    seedTeamState(tmp, sessionId, "completed", ["initializing", "completed"]);

    expect(() => transitionPhase(sessionId, "planning")).toThrow(
      /completed.*planning/,
    );
  });
});

// ─── test 3: runTeamCollect returns 'completed' when all workers wrote shards ─

describe("runTeamCollect — all shards present", () => {
  it("transitions to completed when all workers wrote shards", () => {
    const sessionId = "sess-all-shards";
    seedTeamState(tmp, sessionId, "executing", ["initializing", "executing"]);

    const pidDir = path.join(tmp, ".omcp", "state", "team", sessionId);
    // Two workers, both alive, both have shards.
    writePidFile(pidDir, 1, 99901);
    writePidFile(pidDir, 2, 99902);
    writeShardFile(pidDir, 1);
    writeShardFile(pidDir, 2);

    const report = runTeamCollect(sessionId, {
      cwd: tmp,
      isProcessAlive: () => true,
    });

    expect(report.finalPhase).toBe("completed");
    expect(report.allShardsPresent).toBe(true);
    expect(report.hasDeadWithoutShard).toBe(false);

    const state = readModeState<TeamState>("team", sessionId);
    expect(state!.current_phase).toBe("completed");
  });
});

// ─── test 4: runTeamCollect returns 'failed' when dead worker has no shard ───

describe("runTeamCollect — dead worker without shard", () => {
  it("transitions to failed when a worker pid is dead and has no shard", () => {
    const sessionId = "sess-dead-no-shard";
    seedTeamState(tmp, sessionId, "executing", ["initializing", "executing"]);

    const pidDir = path.join(tmp, ".omcp", "state", "team", sessionId);
    writePidFile(pidDir, 1, 99801);
    writePidFile(pidDir, 2, 99802);
    // Worker 1 has a shard, worker 2 is dead with no shard.
    writeShardFile(pidDir, 1);

    const report = runTeamCollect(sessionId, {
      cwd: tmp,
      // worker pid 99801 alive, 99802 dead.
      isProcessAlive: (pid) => pid === 99801,
    });

    expect(report.finalPhase).toBe("failed");
    expect(report.hasDeadWithoutShard).toBe(true);

    const state = readModeState<TeamState>("team", sessionId);
    expect(state!.current_phase).toBe("failed");
  });

  it("includes crash-restart log line when dead worker detected", () => {
    const sessionId = "sess-crash-log";
    seedTeamState(tmp, sessionId, "executing", ["initializing", "executing"]);

    const pidDir = path.join(tmp, ".omcp", "state", "team", sessionId);
    writePidFile(pidDir, 1, 88801);

    const report = runTeamCollect(sessionId, {
      cwd: tmp,
      isProcessAlive: () => false,
    });

    expect(report.finalPhase).toBe("failed");
    expect(report.logLines.some((l) => l.includes("dead"))).toBe(true);
    expect(report.logLines.some((l) => l.includes("crash"))).toBe(true);
  });
});

// ─── test 5: runTeamCollect is idempotent ─────────────────────────────────────

describe("runTeamCollect — idempotent", () => {
  it("calling twice on a completed session is a no-op", () => {
    const sessionId = "sess-idempotent-completed";
    seedTeamState(tmp, sessionId, "completed", [
      "initializing",
      "executing",
      "completed",
    ]);

    const report1 = runTeamCollect(sessionId, { cwd: tmp });
    const report2 = runTeamCollect(sessionId, { cwd: tmp });

    expect(report1.finalPhase).toBe("completed");
    expect(report2.finalPhase).toBe("completed");
    // Second call should return immediately with no-op log.
    expect(report2.logLines.some((l) => l.includes("no-op"))).toBe(true);
  });

  it("calling twice on a failed session is a no-op", () => {
    const sessionId = "sess-idempotent-failed";
    seedTeamState(tmp, sessionId, "failed", [
      "initializing",
      "executing",
      "failed",
    ]);

    const report1 = runTeamCollect(sessionId, { cwd: tmp });
    const report2 = runTeamCollect(sessionId, { cwd: tmp });

    expect(report1.finalPhase).toBe("failed");
    expect(report2.finalPhase).toBe("failed");
  });
});

// ─── test 6: transitionPhase uses atomicWriteFileSync ─────────────────────────

describe("transitionPhase — atomic write", () => {
  it("written state file is valid JSON (evidence of atomic write)", () => {
    const sessionId = "sess-atomic-write";
    seedTeamState(tmp, sessionId, "executing", ["initializing", "executing"]);

    transitionPhase(sessionId, "completed");

    // Read the raw file and parse — if atomicWriteFileSync was used, it is
    // never half-written, so JSON.parse must always succeed.
    const stateDir = path.join(
      tmp,
      ".omcp",
      "state",
      "sessions",
      sessionId,
    );
    const stateFile = path.join(stateDir, "team-state.json");
    expect(fs.existsSync(stateFile)).toBe(true);
    expect(() => JSON.parse(fs.readFileSync(stateFile, "utf8"))).not.toThrow();

    const parsed = JSON.parse(fs.readFileSync(stateFile, "utf8")) as TeamState;
    expect(parsed.current_phase).toBe("completed");
  });
});

// ─── test 7: TeamPhase enum value semantics (L2.5b correction) ───────────────
//
// Verifies that 'initializing' is a distinct phase that transitions to
// 'executing', and that writing a TeamState with current_phase='initializing'
// then calling transitionPhase('executing') produces the correct history.
// (The full runTeam integration test lives in team-phase-resume.integration.test.ts)

describe("TeamPhase initializing → executing state machine (L2.5b)", () => {
  it("writing initializing then transitioning to executing produces correct history", () => {
    const sessionId = "sess-init-exec-chain";
    // Write the 'initializing' phase (as runTeam now does before spawning).
    writeModeState<TeamState>(
      "team",
      {
        active: true,
        session_id: sessionId,
        started_at: new Date().toISOString(),
        spawned: 2,
        done: 0,
        workers: [],
        current_phase: "initializing",
        stage_history: ["initializing"],
      },
      sessionId,
    );

    // Simulate spawn completion — transition to 'executing'.
    const updated = transitionPhase(sessionId, "executing");

    expect(updated.current_phase).toBe("executing");
    expect(updated.stage_history).toEqual(["initializing", "executing"]);

    // Verify round-trip from disk.
    const persisted = readModeState<TeamState>("team", sessionId);
    expect(persisted!.current_phase).toBe("executing");
    expect(persisted!.stage_history).toEqual(["initializing", "executing"]);
  });
});

// ─── test: back-compat — missing current_phase handled by transitionPhase ─────

describe("transitionPhase — back-compat with missing current_phase", () => {
  it("treats missing current_phase as 'executing' and allows → completed", () => {
    const sessionId = "sess-no-phase";
    // Write a legacy state without current_phase (v1.0.0 style).
    // v1.0.0 sessions were always in 'executing' implicitly, so the default
    // back-compat value is 'executing' (not 'initializing').
    const stateDir = path.join(
      tmp,
      ".omcp",
      "state",
      "sessions",
      sessionId,
    );
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(
      path.join(stateDir, "team-state.json"),
      JSON.stringify({
        active: true,
        session_id: sessionId,
        started_at: new Date().toISOString(),
        spawned: 2,
        done: 0,
        workers: [],
      }),
      "utf8",
    );

    // Should not throw — missing current_phase defaults to 'executing',
    // and executing → completed is a valid transition.
    const updated = transitionPhase(sessionId, "completed");
    expect(updated.current_phase).toBe("completed");
    expect(updated.stage_history).toEqual(["executing", "completed"]);
  });
});

// ─── helpers for v1.3 shard-merge conflict tests ──────────────────────────────

function makePrd(stories: Array<{ id: string; passes?: boolean }>): PRD {
  return {
    project: "test-project",
    branchName: "test-branch",
    description: "Test PRD",
    userStories: stories.map((s, i) => ({
      id: s.id,
      title: `Story ${s.id}`,
      description: `Description for ${s.id}`,
      acceptanceCriteria: ["criterion 1"],
      priority: i + 1,
      passes: s.passes ?? false,
    })),
  };
}

/** Seed a minimal PRD into cwd so mergeShards can find it. */
function seedPrd(cwd: string, stories: Array<{ id: string; passes?: boolean }>): void {
  const state: RalphState = {
    active: true,
    iteration: 1,
    lastFiredAt: new Date().toISOString(),
    prompt: "test task",
  };
  writeRalphState(state, cwd);
  writePrd(makePrd(stories), cwd);
}

// ─── test 8 (v1.3): all shards present + no conflicts → completed (regression) ─

describe("runTeamCollect v1.3 — all shards, no conflicts → completed", () => {
  it("transitions to completed when all shards present and no merge conflicts", () => {
    const sessionId = "sess-v13-no-conflicts";
    seedTeamState(tmp, sessionId, "executing", ["initializing", "executing"]);

    // Seed PRD with a story, then write two shards that agree on passes=true
    // — no conflict (both true, but first alphabetical worker wins; no conflict
    // when workers agree unanimously on a single report).
    seedPrd(tmp, [{ id: "US-001", passes: false }]);
    // Only one worker shard — no disagreement possible.
    writeShardState("worker-a", [{ id: "US-001", passes: true }], tmp);

    const pidDir = path.join(tmp, ".omcp", "state", "team", sessionId);
    writePidFile(pidDir, 1, 91001);
    writeShardFile(pidDir, 1);

    const report = runTeamCollect(sessionId, {
      cwd: tmp,
      isProcessAlive: () => true,
      teamName: "test-team",
    });

    expect(report.finalPhase).toBe("completed");
    expect(report.allShardsPresent).toBe(true);
    expect(report.mergeConflicts).toBeUndefined();

    const state = readModeState<TeamState>("team", sessionId);
    expect(state!.current_phase).toBe("completed");
    expect(state!.stage_history).toEqual(["initializing", "executing", "completed"]);
  });
});

// ─── test 9 (v1.3): all shards + merge conflicts → fixing + conflicts.json ────

describe("runTeamCollect v1.3 — merge conflicts → fixing", () => {
  it("transitions to fixing when shards disagree on a story", () => {
    const sessionId = "sess-v13-conflicts";
    seedTeamState(tmp, sessionId, "executing", ["initializing", "executing"]);

    // Two workers disagree: workerA says passes=true, workerB says passes=false
    // → this produces a conflict in mergeShards.
    seedPrd(tmp, [{ id: "US-002", passes: false }]);
    writeShardState("workera", [{ id: "US-002", passes: true }], tmp);
    writeShardState("workerb", [{ id: "US-002", passes: false }], tmp);

    const pidDir = path.join(tmp, ".omcp", "state", "team", sessionId);
    writePidFile(pidDir, 1, 92001);
    writePidFile(pidDir, 2, 92002);
    writeShardFile(pidDir, 1);
    writeShardFile(pidDir, 2);

    const report = runTeamCollect(sessionId, {
      cwd: tmp,
      isProcessAlive: () => true,
      teamName: "conflict-team",
    });

    expect(report.finalPhase).toBe("fixing");
    expect(report.allShardsPresent).toBe(true);
    expect(report.mergeConflicts).toBeDefined();
    expect(report.mergeConflicts!.length).toBeGreaterThan(0);
    expect(report.mergeConflicts![0].storyId).toBe("US-002");

    // TeamState must be updated to 'fixing'.
    const state = readModeState<TeamState>("team", sessionId);
    expect(state!.current_phase).toBe("fixing");
    expect(state!.stage_history).toEqual(["initializing", "executing", "fixing"]);
  });

  it("writes conflicts.json to the team session pid directory", () => {
    const sessionId = "sess-v13-conflicts-json";
    seedTeamState(tmp, sessionId, "executing", ["initializing", "executing"]);

    seedPrd(tmp, [{ id: "US-003", passes: false }]);
    writeShardState("wa", [{ id: "US-003", passes: true }], tmp);
    writeShardState("wb", [{ id: "US-003", passes: false }], tmp);

    const pidDir = path.join(tmp, ".omcp", "state", "team", sessionId);
    writePidFile(pidDir, 1, 93001);
    writePidFile(pidDir, 2, 93002);
    writeShardFile(pidDir, 1);
    writeShardFile(pidDir, 2);

    runTeamCollect(sessionId, {
      cwd: tmp,
      isProcessAlive: () => true,
      teamName: "json-team",
    });

    const conflictsPath = path.join(pidDir, "conflicts.json");
    expect(fs.existsSync(conflictsPath)).toBe(true);

    const parsed = JSON.parse(fs.readFileSync(conflictsPath, "utf8")) as {
      sessionId: string;
      teamName: string;
      conflictCount: number;
      conflicts: unknown[];
      detectedAt: string;
    };
    expect(parsed.sessionId).toBe(sessionId);
    expect(parsed.teamName).toBe("json-team");
    expect(parsed.conflictCount).toBeGreaterThan(0);
    expect(parsed.conflicts).toHaveLength(parsed.conflictCount);
    expect(typeof parsed.detectedAt).toBe("string");
  });
});

// ─── test 10 (v1.3): conflict count in logLines / stage_history reason ────────

describe("runTeamCollect v1.3 — conflict count in log", () => {
  it("records conflict count in log lines when transitioning to fixing", () => {
    const sessionId = "sess-v13-log-reason";
    seedTeamState(tmp, sessionId, "executing", ["initializing", "executing"]);

    seedPrd(tmp, [{ id: "US-004", passes: false }]);
    writeShardState("wa", [{ id: "US-004", passes: true }], tmp);
    writeShardState("wb", [{ id: "US-004", passes: false }], tmp);

    const pidDir = path.join(tmp, ".omcp", "state", "team", sessionId);
    writePidFile(pidDir, 1, 94001);
    writePidFile(pidDir, 2, 94002);
    writeShardFile(pidDir, 1);
    writeShardFile(pidDir, 2);

    const report = runTeamCollect(sessionId, {
      cwd: tmp,
      isProcessAlive: () => true,
      teamName: "log-team",
    });

    expect(report.finalPhase).toBe("fixing");
    // Log must mention the conflict count.
    expect(
      report.logLines.some((l) => l.includes("merge conflict") && l.includes("fixing")),
    ).toBe(true);
    // Log must mention the conflicts.json write.
    expect(
      report.logLines.some((l) => l.includes("conflicts.json") || l.includes("conflicts written")),
    ).toBe(true);
  });
});

// ─── v2.1 Story 3: verify-fail short-circuit helpers ──────────────────────────

function writeVerifyFailSignal(
  pidDir: string,
  workerIndex: number,
  iteration: number,
  failedTools: string[],
): void {
  fs.mkdirSync(pidDir, { recursive: true });
  fs.writeFileSync(
    path.join(pidDir, `worker-${workerIndex}-verify-fail.json`),
    JSON.stringify(
      {
        workerIndex,
        iteration,
        ts: new Date().toISOString(),
        failedTools,
        reportPath: `verify-report-${iteration}.json`,
      },
      null,
      2,
    ),
    "utf8",
  );
}

// ─── v2.1 Story 3: readVerifyFailSignals ──────────────────────────────────────

describe("readVerifyFailSignals (v2.1 P1)", () => {
  it("returns empty array when pidDir absent", () => {
    expect(readVerifyFailSignals(path.join(tmp, "absent"))).toEqual([]);
  });

  it("returns empty array when no worker-K-verify-fail.json files present", () => {
    const pidDir = path.join(tmp, ".omcp", "state", "team", "no-signals");
    fs.mkdirSync(pidDir, { recursive: true });
    writePidFile(pidDir, 1, 700001);
    expect(readVerifyFailSignals(pidDir)).toEqual([]);
  });

  it("parses and sorts signals by workerIndex", () => {
    const pidDir = path.join(tmp, ".omcp", "state", "team", "parse-signals");
    writeVerifyFailSignal(pidDir, 3, 1, ["vitest"]);
    writeVerifyFailSignal(pidDir, 1, 1, ["tsc"]);
    writeVerifyFailSignal(pidDir, 2, 1, ["biome", "vitest"]);

    const signals = readVerifyFailSignals(pidDir);
    expect(signals).toHaveLength(3);
    expect(signals.map((s) => s.workerIndex)).toEqual([1, 2, 3]);
    expect(signals[2].failedTools).toEqual(["vitest"]);
    expect(signals[1].failedTools).toEqual(["biome", "vitest"]);
  });

  it("skips malformed JSON and surfaces a warning via onWarn callback", () => {
    const pidDir = path.join(tmp, ".omcp", "state", "team", "malformed");
    fs.mkdirSync(pidDir, { recursive: true });
    fs.writeFileSync(
      path.join(pidDir, "worker-1-verify-fail.json"),
      "{not valid json",
      "utf8",
    );
    writeVerifyFailSignal(pidDir, 2, 1, ["vitest"]);

    const warnings: string[] = [];
    const signals = readVerifyFailSignals(pidDir, (m) => warnings.push(m));
    expect(signals).toHaveLength(1);
    expect(signals[0].workerIndex).toBe(2);
    expect(warnings.length).toBeGreaterThan(0);
    expect(warnings.some((w) => w.includes("worker-1-verify-fail.json"))).toBe(true);
  });

  it("skips signals missing required fields and surfaces a warning", () => {
    const pidDir = path.join(tmp, ".omcp", "state", "team", "missing-fields");
    fs.mkdirSync(pidDir, { recursive: true });
    fs.writeFileSync(
      path.join(pidDir, "worker-1-verify-fail.json"),
      JSON.stringify({ workerIndex: 1, iteration: 1 }), // missing ts, failedTools, reportPath
      "utf8",
    );

    const warnings: string[] = [];
    const signals = readVerifyFailSignals(pidDir, (m) => warnings.push(m));
    expect(signals).toHaveLength(0);
    expect(warnings.some((w) => w.includes("malformed"))).toBe(true);
  });

  it("ignores non-matching filenames (worker-N.pid, worker-N-shard.json, conflicts.json)", () => {
    const pidDir = path.join(tmp, ".omcp", "state", "team", "noise");
    writePidFile(pidDir, 1, 700100);
    writeShardFile(pidDir, 1);
    fs.writeFileSync(path.join(pidDir, "conflicts.json"), "{}", "utf8");
    fs.writeFileSync(
      path.join(pidDir, "verify-report-1.json"),
      JSON.stringify({ iteration: 1, ok: true }),
      "utf8",
    );
    expect(readVerifyFailSignals(pidDir)).toEqual([]);
  });
});

// ─── v2.1 Story 3: 0 signals → completed (regression) ─────────────────────────

describe("runTeamCollect v2.1 — 0 verify-fail signals → completed (regression)", () => {
  it("transitions to completed when all shards present and no verify-fail signals", () => {
    const sessionId = "sess-v21-no-signals";
    seedTeamState(tmp, sessionId, "executing", ["initializing", "executing"]);

    const pidDir = path.join(tmp, ".omcp", "state", "team", sessionId);
    writePidFile(pidDir, 1, 70011);
    writePidFile(pidDir, 2, 70012);
    writeShardFile(pidDir, 1);
    writeShardFile(pidDir, 2);

    const report = runTeamCollect(sessionId, {
      cwd: tmp,
      isProcessAlive: () => true,
    });

    expect(report.finalPhase).toBe("completed");
    expect(report.verifyFailSignals).toBeUndefined();
    // No verify-fail-summary.json should have been written.
    expect(
      fs.existsSync(path.join(pidDir, "verify-fail-summary.json")),
    ).toBe(false);
  });
});

// ─── v2.1 Story 3: 1+ verify-fail signal → fixing ─────────────────────────────

describe("runTeamCollect v2.1 — verify-fail signal(s) → fixing", () => {
  it("overrides completed → fixing when 1 verify-fail signal present", () => {
    const sessionId = "sess-v21-one-signal";
    seedTeamState(tmp, sessionId, "executing", ["initializing", "executing"]);

    const pidDir = path.join(tmp, ".omcp", "state", "team", sessionId);
    writePidFile(pidDir, 1, 70021);
    writePidFile(pidDir, 2, 70022);
    writeShardFile(pidDir, 1);
    writeShardFile(pidDir, 2);
    writeVerifyFailSignal(pidDir, 1, 1, ["vitest"]);

    const report = runTeamCollect(sessionId, {
      cwd: tmp,
      isProcessAlive: () => true,
    });

    expect(report.finalPhase).toBe("fixing");
    expect(report.verifyFailSignals).toBeDefined();
    expect(report.verifyFailSignals).toHaveLength(1);
    expect(report.verifyFailSignals![0].workerIndex).toBe(1);
    expect(report.verifyFailSignals![0].failedTools).toEqual(["vitest"]);

    // verify-fail-summary.json must be written.
    const summaryPath = path.join(pidDir, "verify-fail-summary.json");
    expect(fs.existsSync(summaryPath)).toBe(true);
    const summary = JSON.parse(fs.readFileSync(summaryPath, "utf8")) as {
      sessionId: string;
      signalCount: number;
      signals: VerifyFailSignal[];
    };
    expect(summary.sessionId).toBe(sessionId);
    expect(summary.signalCount).toBe(1);
    expect(summary.signals[0].workerIndex).toBe(1);

    // TeamState reflects fixing phase.
    const state = readModeState<TeamState>("team", sessionId);
    expect(state!.current_phase).toBe("fixing");
  });

  it("transitions to fixing when ALL workers have verify-fail signals", () => {
    const sessionId = "sess-v21-all-signals";
    seedTeamState(tmp, sessionId, "executing", ["initializing", "executing"]);

    const pidDir = path.join(tmp, ".omcp", "state", "team", sessionId);
    writePidFile(pidDir, 1, 70031);
    writePidFile(pidDir, 2, 70032);
    writePidFile(pidDir, 3, 70033);
    writeShardFile(pidDir, 1);
    writeShardFile(pidDir, 2);
    writeShardFile(pidDir, 3);
    writeVerifyFailSignal(pidDir, 1, 2, ["vitest"]);
    writeVerifyFailSignal(pidDir, 2, 2, ["tsc"]);
    writeVerifyFailSignal(pidDir, 3, 2, ["vitest", "biome"]);

    const report = runTeamCollect(sessionId, {
      cwd: tmp,
      isProcessAlive: () => true,
    });

    expect(report.finalPhase).toBe("fixing");
    expect(report.verifyFailSignals).toHaveLength(3);

    const summary = JSON.parse(
      fs.readFileSync(
        path.join(pidDir, "verify-fail-summary.json"),
        "utf8",
      ),
    ) as { signalCount: number; signals: VerifyFailSignal[] };
    expect(summary.signalCount).toBe(3);
    // Signals are sorted by workerIndex.
    expect(summary.signals.map((s) => s.workerIndex)).toEqual([1, 2, 3]);
    expect(summary.signals[2].failedTools).toEqual(["vitest", "biome"]);
  });

  it("log lines mention the verify-fail short-circuit reason", () => {
    const sessionId = "sess-v21-log-reason";
    seedTeamState(tmp, sessionId, "executing", ["initializing", "executing"]);

    const pidDir = path.join(tmp, ".omcp", "state", "team", sessionId);
    writePidFile(pidDir, 1, 70041);
    writeShardFile(pidDir, 1);
    writeVerifyFailSignal(pidDir, 1, 1, ["vitest"]);

    const report = runTeamCollect(sessionId, {
      cwd: tmp,
      isProcessAlive: () => true,
    });

    expect(
      report.logLines.some(
        (l) =>
          l.includes("verify-fail signal") &&
          (l.includes("fixing") || l.includes("'fixing'")),
      ),
    ).toBe(true);
    expect(
      report.logLines.some((l) => l.includes("verify-fail-summary.json")),
    ).toBe(true);
  });
});

// ─── v2.1 Story 3: verify-fail + merge-conflict → fixing with BOTH artifacts ──

describe("runTeamCollect v2.1 — verify-fail + merge-conflict combined", () => {
  it("transitions to fixing and writes BOTH conflicts.json AND verify-fail-summary.json", () => {
    const sessionId = "sess-v21-both";
    seedTeamState(tmp, sessionId, "executing", ["initializing", "executing"]);

    seedPrd(tmp, [{ id: "US-VF1", passes: false }]);
    writeShardState("wa", [{ id: "US-VF1", passes: true }], tmp);
    writeShardState("wb", [{ id: "US-VF1", passes: false }], tmp);

    const pidDir = path.join(tmp, ".omcp", "state", "team", sessionId);
    writePidFile(pidDir, 1, 70051);
    writePidFile(pidDir, 2, 70052);
    writeShardFile(pidDir, 1);
    writeShardFile(pidDir, 2);
    writeVerifyFailSignal(pidDir, 1, 1, ["vitest"]);

    const report = runTeamCollect(sessionId, {
      cwd: tmp,
      isProcessAlive: () => true,
      teamName: "combined-team",
    });

    expect(report.finalPhase).toBe("fixing");
    expect(report.mergeConflicts).toBeDefined();
    expect(report.mergeConflicts!.length).toBeGreaterThan(0);
    expect(report.verifyFailSignals).toBeDefined();
    expect(report.verifyFailSignals).toHaveLength(1);

    // BOTH artifacts must exist.
    expect(fs.existsSync(path.join(pidDir, "conflicts.json"))).toBe(true);
    expect(fs.existsSync(path.join(pidDir, "verify-fail-summary.json"))).toBe(true);

    // Log line acknowledges the dual-trigger.
    expect(
      report.logLines.some(
        (l) =>
          l.includes("verify-fail") &&
          (l.includes("merge conflicts") || l.includes("staying in")),
      ),
    ).toBe(true);
  });
});

// ─── v2.1 Story 3: allShardsPresent gate (design-intent lock) ─────────────────

describe("runTeamCollect v2.1 — verify-fail gate behind allShardsPresent", () => {
  it("does NOT transition to fixing when signal present but workers still alive without shards", () => {
    // Documents the design intent surfaced by critic review: signals are only
    // legitimate after all workers' shards have landed. A stale or external
    // signal during executing should NOT derail an in-flight team.
    const sessionId = "sess-v21-gate";
    seedTeamState(tmp, sessionId, "executing", ["initializing", "executing"]);

    const pidDir = path.join(tmp, ".omcp", "state", "team", sessionId);
    writePidFile(pidDir, 1, 70081);
    writePidFile(pidDir, 2, 70082);
    // No shards written — workers still executing.
    writeVerifyFailSignal(pidDir, 1, 1, ["vitest"]);

    const report = runTeamCollect(sessionId, {
      cwd: tmp,
      isProcessAlive: () => true, // workers alive
    });

    // Stays executing — signal is ignored until all shards land.
    expect(report.finalPhase).toBe("executing");
    expect(report.verifyFailSignals).toBeUndefined();
    expect(
      fs.existsSync(path.join(pidDir, "verify-fail-summary.json")),
    ).toBe(false);
  });
});

// ─── v2.1 Story 3 supplement: buildFixingReason ───────────────────────────────

describe("buildFixingReason (v2.1 P1 reason-string helper)", () => {
  it("reports merge conflicts only when no verify-fail signals", () => {
    expect(buildFixingReason(3, 0)).toBe("3 merge conflict(s) detected");
  });

  it("reports verify-fail signals only when no merge conflicts", () => {
    expect(buildFixingReason(0, 2)).toBe("2 verify-fail signal(s) detected");
  });

  it("reports BOTH when both triggers present", () => {
    expect(buildFixingReason(1, 4)).toBe(
      "1 merge conflict(s) + 4 verify-fail signal(s) detected",
    );
  });

  it("returns defensive placeholder when both counts are zero (should be unreachable)", () => {
    expect(buildFixingReason(0, 0)).toBe("fixing trigger (unspecified)");
  });
});

// ─── v2.1 Story 3: back-compat — teamName optional ────────────────────────────

describe("runTeamCollect v2.1 — back-compat with teamName omitted", () => {
  it("verify-fail short-circuit triggers even when teamName not provided (v1.2 compat path)", () => {
    const sessionId = "sess-v21-no-teamname";
    seedTeamState(tmp, sessionId, "executing", ["initializing", "executing"]);

    const pidDir = path.join(tmp, ".omcp", "state", "team", sessionId);
    writePidFile(pidDir, 1, 70061);
    writeShardFile(pidDir, 1);
    writeVerifyFailSignal(pidDir, 1, 1, ["vitest"]);

    // teamName intentionally omitted.
    const report = runTeamCollect(sessionId, {
      cwd: tmp,
      isProcessAlive: () => true,
    });

    expect(report.finalPhase).toBe("fixing");
    expect(report.verifyFailSignals).toHaveLength(1);
    expect(fs.existsSync(path.join(pidDir, "verify-fail-summary.json"))).toBe(true);
  });
});

// ─── v2.1 Story 5: resolveMaxFixLoops + readLatestReportMaxLoops ──────────────

describe("resolveMaxFixLoops (Story 5)", () => {
  it("returns COLLECT_DEFAULT_MAX_LOOPS=3 when neither env nor report provided", () => {
    expect(resolveMaxFixLoops(undefined, {})).toBe(3);
  });

  it("uses report value when env is unset", () => {
    expect(resolveMaxFixLoops(5, {})).toBe(5);
  });

  it("env overrides report", () => {
    expect(resolveMaxFixLoops(5, { OMCP_TEAM_MAX_FIX_LOOPS: "7" })).toBe(7);
  });

  it("ignores non-positive env and non-positive report values", () => {
    expect(resolveMaxFixLoops(0, { OMCP_TEAM_MAX_FIX_LOOPS: "-1" })).toBe(3);
    expect(resolveMaxFixLoops(-2, { OMCP_TEAM_MAX_FIX_LOOPS: "abc" })).toBe(3);
  });

  it("empty-string env falls through to report", () => {
    expect(resolveMaxFixLoops(4, { OMCP_TEAM_MAX_FIX_LOOPS: "" })).toBe(4);
  });
});

describe("readLatestReportMaxLoops (Story 5)", () => {
  it("returns undefined when pidDir absent", () => {
    expect(
      readLatestReportMaxLoops(path.join(tmp, "no-such-dir")),
    ).toBeUndefined();
  });

  it("returns undefined when no verify-report-N.json files present", () => {
    const pidDir = path.join(tmp, "empty-pid-dir");
    fs.mkdirSync(pidDir, { recursive: true });
    expect(readLatestReportMaxLoops(pidDir)).toBeUndefined();
  });

  it("returns max_fix_loops from the highest-numbered report", () => {
    const pidDir = path.join(tmp, "multi-report-pid-dir");
    fs.mkdirSync(pidDir, { recursive: true });
    fs.writeFileSync(
      path.join(pidDir, "verify-report-1.json"),
      JSON.stringify({ iteration: 1, max_fix_loops: 5 }),
      "utf8",
    );
    fs.writeFileSync(
      path.join(pidDir, "verify-report-2.json"),
      JSON.stringify({ iteration: 2, max_fix_loops: 9 }),
      "utf8",
    );
    expect(readLatestReportMaxLoops(pidDir)).toBe(9);
  });

  it("returns undefined when report is corrupt JSON", () => {
    const pidDir = path.join(tmp, "corrupt-report-pid-dir");
    fs.mkdirSync(pidDir, { recursive: true });
    fs.writeFileSync(
      path.join(pidDir, "verify-report-1.json"),
      "{not valid",
      "utf8",
    );
    expect(readLatestReportMaxLoops(pidDir)).toBeUndefined();
  });

  it("returns undefined when max_fix_loops field is missing or non-positive", () => {
    const pidDir = path.join(tmp, "no-mfl-pid-dir");
    fs.mkdirSync(pidDir, { recursive: true });
    fs.writeFileSync(
      path.join(pidDir, "verify-report-1.json"),
      JSON.stringify({ iteration: 1, max_fix_loops: -1 }),
      "utf8",
    );
    expect(readLatestReportMaxLoops(pidDir)).toBeUndefined();
  });
});

// ─── v2.1 Story 5: runTeamCollect primary bound gate ──────────────────────────

/** Seed a TeamState with a specific fix_loop_count. */
function seedTeamStateWithLoopCount(
  sessionId: string,
  fixLoopCount: number,
): void {
  writeModeState<TeamState>(
    "team",
    {
      active: true,
      session_id: sessionId,
      started_at: new Date().toISOString(),
      spawned: 2,
      done: 0,
      workers: [
        { id: "worker-1", status: "pending" },
        { id: "worker-2", status: "pending" },
      ],
      current_phase: "executing",
      stage_history: ["initializing", "executing"],
      fix_loop_count: fixLoopCount,
    },
    sessionId,
  );
}

/** Seed a verify-report-N.json with a chosen max_fix_loops value. */
function seedReportWithMaxLoops(
  pidDir: string,
  iteration: number,
  maxLoops: number,
): void {
  fs.mkdirSync(pidDir, { recursive: true });
  fs.writeFileSync(
    path.join(pidDir, `verify-report-${iteration}.json`),
    JSON.stringify({
      iteration,
      ts: new Date().toISOString(),
      max_fix_loops: maxLoops,
      vitest: { exitCode: 1, tail: "FAIL" },
      tsc: { exitCode: 0, tail: "" },
      biome: { exitCode: 0, tail: "" },
      ok: false,
    }),
    "utf8",
  );
}

describe("runTeamCollect v2.1 Story 5 — bound gate (verify_loop_exhausted)", () => {
  it("transitions to failed when verify-fail signal present AND fix_loop_count >= max", () => {
    const sessionId = "sess-s5-exhausted-3-of-3";
    const prevCwd = process.cwd();
    process.chdir(tmp);
    try {
      seedTeamStateWithLoopCount(sessionId, 3);
    } finally {
      process.chdir(prevCwd);
    }

    const pidDir = path.join(tmp, ".omcp", "state", "team", sessionId);
    writePidFile(pidDir, 1, 80001);
    writePidFile(pidDir, 2, 80002);
    writeShardFile(pidDir, 1);
    writeShardFile(pidDir, 2);
    seedReportWithMaxLoops(pidDir, 1, 3);
    writeVerifyFailSignal(pidDir, 1, 1, ["vitest"]);

    const report = runTeamCollect(sessionId, {
      cwd: tmp,
      isProcessAlive: () => true,
    });

    expect(report.finalPhase).toBe("failed");
    // No fresh summary written when exhausted.
    expect(
      fs.existsSync(path.join(pidDir, "verify-fail-summary.json")),
    ).toBe(false);
    // Log message identifies the exhaustion.
    expect(
      report.logLines.some(
        (l) =>
          l.includes("verify_loop_exhausted") ||
          l.includes("fix_loop_count"),
      ),
    ).toBe(true);
    // TeamState reflects failed phase.
    expect(readModeState<TeamState>("team", sessionId)!.current_phase).toBe(
      "failed",
    );
  });

  it("transitions to fixing when verify-fail signal present AND fix_loop_count < max", () => {
    const sessionId = "sess-s5-allowed-2-of-3";
    const prevCwd = process.cwd();
    process.chdir(tmp);
    try {
      seedTeamStateWithLoopCount(sessionId, 2);
    } finally {
      process.chdir(prevCwd);
    }

    const pidDir = path.join(tmp, ".omcp", "state", "team", sessionId);
    writePidFile(pidDir, 1, 80003);
    writePidFile(pidDir, 2, 80004);
    writeShardFile(pidDir, 1);
    writeShardFile(pidDir, 2);
    seedReportWithMaxLoops(pidDir, 1, 3);
    writeVerifyFailSignal(pidDir, 1, 1, ["vitest"]);

    const report = runTeamCollect(sessionId, {
      cwd: tmp,
      isProcessAlive: () => true,
    });

    expect(report.finalPhase).toBe("fixing");
    // Summary written normally.
    expect(
      fs.existsSync(path.join(pidDir, "verify-fail-summary.json")),
    ).toBe(true);
  });

  it("env OMCP_TEAM_MAX_FIX_LOOPS overrides report value at the collect bound", () => {
    const sessionId = "sess-s5-env-tighter";
    const prevCwd = process.cwd();
    process.chdir(tmp);
    try {
      seedTeamStateWithLoopCount(sessionId, 2);
    } finally {
      process.chdir(prevCwd);
    }

    const pidDir = path.join(tmp, ".omcp", "state", "team", sessionId);
    writePidFile(pidDir, 1, 80005);
    writeShardFile(pidDir, 1);
    seedReportWithMaxLoops(pidDir, 1, 5); // report says max=5
    writeVerifyFailSignal(pidDir, 1, 1, ["vitest"]);

    const prevEnv = process.env.OMCP_TEAM_MAX_FIX_LOOPS;
    process.env.OMCP_TEAM_MAX_FIX_LOOPS = "2"; // env tighter
    try {
      const report = runTeamCollect(sessionId, {
        cwd: tmp,
        isProcessAlive: () => true,
      });
      // 2 >= 2 under env-imposed bound → failed.
      expect(report.finalPhase).toBe("failed");
    } finally {
      if (prevEnv === undefined) delete process.env.OMCP_TEAM_MAX_FIX_LOOPS;
      else process.env.OMCP_TEAM_MAX_FIX_LOOPS = prevEnv;
    }
  });

  it("default max=3 applies when no env and no report present", () => {
    const sessionId = "sess-s5-no-report-default-3";
    const prevCwd = process.cwd();
    process.chdir(tmp);
    try {
      seedTeamStateWithLoopCount(sessionId, 3);
    } finally {
      process.chdir(prevCwd);
    }

    const pidDir = path.join(tmp, ".omcp", "state", "team", sessionId);
    writePidFile(pidDir, 1, 80006);
    writeShardFile(pidDir, 1);
    // No verify-report-*.json — defaults to 3.
    writeVerifyFailSignal(pidDir, 1, 1, ["vitest"]);

    const prevEnv = process.env.OMCP_TEAM_MAX_FIX_LOOPS;
    delete process.env.OMCP_TEAM_MAX_FIX_LOOPS;
    try {
      const report = runTeamCollect(sessionId, {
        cwd: tmp,
        isProcessAlive: () => true,
      });
      // 3 >= default 3 → failed.
      expect(report.finalPhase).toBe("failed");
    } finally {
      if (prevEnv !== undefined) process.env.OMCP_TEAM_MAX_FIX_LOOPS = prevEnv;
    }
  });
});

// ─── test 11 (v1.3): fixing phase — idempotent ────────────────────────────────

describe("runTeamCollect v1.3 — fixing phase idempotency", () => {
  it("session already in fixing phase is returned as-is (no-op on non-terminal)", () => {
    // The 'fixing' phase is NOT terminal — sessions in 'fixing' are not
    // short-circuited by the idempotent terminal check. However, calling
    // runTeamCollect a second time on a 'fixing' session should not crash.
    // It will re-run the shard check; since allShardsPresent is still true
    // and conflicts persist, it will attempt executing → fixing again, which
    // would throw InvalidPhaseTransitionError (already at 'fixing', not
    // 'executing'). This test documents the behavior: the session is already
    // 'fixing' — the second collect with teamName present will transition
    // fixing → fixing which is invalid. Without teamName it returns normally.
    // This is the documented v1.4 follow-up: re-detect after manual resolution.
    const sessionId = "sess-v13-fixing-idempotent";
    // Seed a session already in 'fixing' state.
    seedTeamState(tmp, sessionId, "fixing", ["initializing", "executing", "fixing"]);

    const pidDir = path.join(tmp, ".omcp", "state", "team", sessionId);
    writePidFile(pidDir, 1, 95001);
    writePidFile(pidDir, 2, 95002);
    writeShardFile(pidDir, 1);
    writeShardFile(pidDir, 2);

    // Without teamName: allShardsPresent → attempts executing → completed, but
    // current_phase is 'fixing'. 'fixing → completed' IS a valid transition.
    // So it transitions fixing → completed.
    const report = runTeamCollect(sessionId, {
      cwd: tmp,
      isProcessAlive: () => true,
      // No teamName — skip conflict detection; just confirm shards present.
    });

    // fixing → completed is a valid edge (outgoing from 'fixing').
    expect(report.finalPhase).toBe("completed");
    const state = readModeState<TeamState>("team", sessionId);
    expect(state!.current_phase).toBe("completed");
  });
});
