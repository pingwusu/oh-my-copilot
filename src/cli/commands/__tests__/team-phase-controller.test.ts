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
import { runTeamCollect } from "../team-phase-controller.js";

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
