// Integration tests for Phase L2.5b — crash-restart resume detection.
//
// These tests exercise the full lifecycle: spawn a fake team, simulate crash
// or clean completion, run team-collect, assert correct phase transition.
//
// Test 1: Crash-restart — fake team in 'executing', worker dead without shard
//         → team-collect detects executing → failed with stage_history entry.
// Test 2: Clean completion — all workers write shards
//         → team-collect detects executing → completed.
// Test 3: Backward compat — TeamState file written by v1.1.0 (no current_phase)
//         → readModeState does not crash; runTeamCollect handles gracefully.

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
  type TeamState,
} from "../runtime/mode-state.js";
import { runTeamCollect } from "../cli/commands/team-phase-controller.js";

// ─── helpers ──────────────────────────────────────────────────────────────────

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "omcp-phase-resume-"));
}

function makePidDir(cwd: string, sessionId: string): string {
  const pidDir = path.join(cwd, ".omcp", "state", "team", sessionId);
  fs.mkdirSync(pidDir, { recursive: true });
  return pidDir;
}

function writePid(pidDir: string, index: number, pid: number): void {
  fs.writeFileSync(path.join(pidDir, `worker-${index}.pid`), String(pid), "utf8");
}

function writeShard(pidDir: string, index: number): void {
  fs.writeFileSync(
    path.join(pidDir, `worker-${index}-shard.json`),
    JSON.stringify({ worker: index, done: true }),
    "utf8",
  );
}

function seedExecutingTeam(cwd: string, sessionId: string, workerCount: number): void {
  const prev = process.cwd();
  process.chdir(cwd);
  try {
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
        current_phase: "executing",
        stage_history: ["initializing", "executing"],
      },
      sessionId,
    );
  } finally {
    process.chdir(prev);
  }
}

// ─── setup / teardown ─────────────────────────────────────────────────────────

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

// ─── Test 1: Crash-restart detection ─────────────────────────────────────────

describe("crash-restart: dead worker without shard → executing → failed", () => {
  it("detects dead worker mid-execution and transitions to failed", () => {
    const sessionId = "crash-resume-test-01";

    // Seed a team in executing phase.
    seedExecutingTeam(tmp, sessionId, 2);

    const pidDir = makePidDir(tmp, sessionId);
    // Worker 1 was spawned (pid 77001) but is now dead with no shard.
    writePid(pidDir, 1, 77001);
    // Worker 2 was spawned (pid 77002) and is also dead with no shard.
    writePid(pidDir, 2, 77002);
    // No shard files — simulates crash before any output.

    const report = runTeamCollect(sessionId, {
      cwd: tmp,
      // Both pids are "dead" (simulating killed copilot processes).
      isProcessAlive: () => false,
    });

    // Phase must have transitioned to 'failed'.
    expect(report.finalPhase).toBe("failed");
    expect(report.hasDeadWithoutShard).toBe(true);

    // stage_history must contain the transition record.
    const state = readModeState<TeamState>("team", sessionId);
    expect(state).not.toBeNull();
    expect(state!.current_phase).toBe("failed");
    expect(state!.stage_history).toEqual([
      "initializing",
      "executing",
      "failed",
    ]);

    // Crash-restart log must mention out-of-scope note.
    expect(
      report.logLines.some((l) =>
        l.includes("out of scope") || l.includes("v1.2.0"),
      ),
    ).toBe(true);
  });

  it("partial crash: one worker alive, one dead without shard → failed", () => {
    const sessionId = "crash-partial-01";
    seedExecutingTeam(tmp, sessionId, 2);

    const pidDir = makePidDir(tmp, sessionId);
    writePid(pidDir, 1, 55001); // alive
    writePid(pidDir, 2, 55002); // dead, no shard

    const report = runTeamCollect(sessionId, {
      cwd: tmp,
      isProcessAlive: (pid) => pid === 55001,
    });

    expect(report.finalPhase).toBe("failed");
    expect(report.hasDeadWithoutShard).toBe(true);
  });
});

// ─── Test 2: Clean completion ─────────────────────────────────────────────────

describe("clean completion: all workers write shards → executing → completed", () => {
  it("transitions to completed when all workers produced shards", () => {
    const sessionId = "clean-complete-test-01";

    seedExecutingTeam(tmp, sessionId, 3);

    const pidDir = makePidDir(tmp, sessionId);
    // Three workers, all alive, all wrote shards.
    for (let i = 1; i <= 3; i++) {
      writePid(pidDir, i, 60000 + i);
      writeShard(pidDir, i);
    }

    const report = runTeamCollect(sessionId, {
      cwd: tmp,
      isProcessAlive: () => true,
    });

    expect(report.finalPhase).toBe("completed");
    expect(report.allShardsPresent).toBe(true);
    expect(report.hasDeadWithoutShard).toBe(false);

    const state = readModeState<TeamState>("team", sessionId);
    expect(state!.current_phase).toBe("completed");
    expect(state!.stage_history).toEqual([
      "initializing",
      "executing",
      "completed",
    ]);
  });

  it("dead worker WITH shard counts as completed (graceful exit)", () => {
    // A worker that finished and exited cleanly has a shard but no live pid.
    const sessionId = "clean-dead-with-shard";
    seedExecutingTeam(tmp, sessionId, 2);

    const pidDir = makePidDir(tmp, sessionId);
    writePid(pidDir, 1, 70001);
    writePid(pidDir, 2, 70002);
    // Both shards present — workers finished and exited.
    writeShard(pidDir, 1);
    writeShard(pidDir, 2);

    const report = runTeamCollect(sessionId, {
      cwd: tmp,
      // Both pids dead (processes exited after writing shards).
      isProcessAlive: () => false,
    });

    // allShardsPresent wins — completed despite dead pids.
    expect(report.finalPhase).toBe("completed");
    expect(report.allShardsPresent).toBe(true);
  });
});

// ─── Test 3: Backward compat — v1.1.0 TeamState (no current_phase) ───────────

describe("backward compat: v1.1.0 TeamState without current_phase", () => {
  it("readModeState does not crash on state without current_phase", () => {
    const sessionId = "legacy-v110-compat";

    // Write a v1.1.0-style state WITHOUT current_phase or stage_history.
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
        started_at: "2025-06-01T00:00:00.000Z",
        spawned: 2,
        done: 0,
        workers: [
          { id: "worker-1", status: "running" },
          { id: "worker-2", status: "running" },
        ],
      }),
      "utf8",
    );

    // readModeState must not throw.
    const state = readModeState<TeamState>("team", sessionId);
    expect(state).not.toBeNull();
    expect(state!.spawned).toBe(2);
    // Optional fields absent — no crash.
    expect(state!.current_phase).toBeUndefined();
    expect(state!.stage_history).toBeUndefined();
  });

  it("runTeamCollect handles legacy state (no current_phase) without crashing", () => {
    const sessionId = "legacy-collect-compat";

    // Write legacy state without current_phase.
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
        started_at: "2025-06-01T00:00:00.000Z",
        spawned: 1,
        done: 0,
        workers: [{ id: "worker-1", status: "running" }],
      }),
      "utf8",
    );

    const pidDir = makePidDir(tmp, sessionId);
    writePid(pidDir, 1, 80001);

    // runTeamCollect must not throw even with legacy state.
    // Since current_phase is absent (defaults to 'executing' in collect logic),
    // and the worker is dead without a shard → 'failed'.
    expect(() =>
      runTeamCollect(sessionId, {
        cwd: tmp,
        isProcessAlive: () => false,
      }),
    ).not.toThrow();
  });

  it("runTeamCollect on legacy state with all shards → completed", () => {
    const sessionId = "legacy-collect-complete";

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
        started_at: "2025-06-01T00:00:00.000Z",
        spawned: 1,
        done: 0,
        workers: [{ id: "worker-1", status: "running" }],
      }),
      "utf8",
    );

    const pidDir = makePidDir(tmp, sessionId);
    writePid(pidDir, 1, 81001);
    writeShard(pidDir, 1);

    const report = runTeamCollect(sessionId, {
      cwd: tmp,
      isProcessAlive: () => true,
    });

    expect(report.finalPhase).toBe("completed");
  });
});

