/**
 * Story 21 — `omcp team-loop` auto-orchestrator unit tests.
 *
 * The loop body is: verify → collect → (if fixing) spawn-fix → wait shard
 * → loop. Tests inject all 3 spawn surfaces (verifySpawnFn / fixSpawnFn /
 * awaitShardFn) so the entire orchestrator runs in-process without timers
 * or real child processes.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { runTeamLoop, runTeamLoopCli } from "../cli/commands/team-loop.js";
import {
  writeModeState,
  type TeamState,
} from "../runtime/mode-state.js";
import { atomicWriteFileSync } from "../runtime/atomic-write.js";
import type { VerifySpawnResult } from "../cli/commands/team-verify.js";

const SESSION_ID = "team-loop-sid";

let tmp: string;
let cwdSnapshot: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "omcp-team-loop-test-"));
  cwdSnapshot = process.cwd();
  process.chdir(tmp);
});

afterEach(() => {
  process.chdir(cwdSnapshot);
  fs.rmSync(tmp, { recursive: true, force: true });
});

function seedTeamSession(opts: {
  workerCount?: number;
  phase?: TeamState["current_phase"];
  fixLoopCount?: number;
}): { pidDir: string } {
  const workerCount = opts.workerCount ?? 2;
  writeModeState<TeamState>(
    "team",
    {
      active: true,
      session_id: SESSION_ID,
      started_at: "2026-05-25T00:00:00.000Z",
      spawned: workerCount,
      done: workerCount,
      workers: Array.from({ length: workerCount }, (_, i) => ({
        id: `worker-${i + 1}`,
        status: "pending",
      })),
      current_phase: opts.phase ?? "executing",
      stage_history: ["initializing", "executing"],
      fix_loop_count: opts.fixLoopCount,
    },
    SESSION_ID,
  );
  const pidDir = path.join(tmp, ".omcp", "state", "team", SESSION_ID);
  fs.mkdirSync(pidDir, { recursive: true });
  for (let i = 1; i <= workerCount; i++) {
    atomicWriteFileSync(path.join(pidDir, `worker-${i}.pid`), String(50000 + i));
    atomicWriteFileSync(
      path.join(pidDir, `worker-${i}-shard.json`),
      JSON.stringify({ worker: i, done: true }),
    );
  }
  return { pidDir };
}

const ALL_PASS_TABLE: Record<string, VerifySpawnResult> = {
  "npx vitest": { exitCode: 0, output: "ok" },
  "npx tsc": { exitCode: 0, output: "" },
  "npx biome": { exitCode: 0, output: "" },
};
const ALL_FAIL_TABLE: Record<string, VerifySpawnResult> = {
  "npx vitest": { exitCode: 1, output: "fail" },
  "npx tsc": { exitCode: 0, output: "" },
  "npx biome": { exitCode: 0, output: "" },
};
function spawnFromTable(t: Record<string, VerifySpawnResult>) {
  return (cmd: string, args: string[]): VerifySpawnResult => {
    const key = `${cmd} ${args[0] ?? ""}`;
    const r = t[key];
    if (!r) throw new Error(`no mock for ${key}`);
    return r;
  };
}

/**
 * Build a programmable verify spawn that returns FAIL for the first
 * `failCount` calls then PASS forever after. Models "Nth verify pass
 * converges" scenarios.
 */
function programmableVerifySpawn(failCount: number) {
  let calls = 0;
  return (cmd: string, args: string[]): VerifySpawnResult => {
    const key = `${cmd} ${args[0] ?? ""}`;
    // Each verify pass invokes vitest+tsc+biome (3 spawns). Bucket the
    // calls into "iterations of 3" — iteration index = floor(calls / 3).
    const iter = Math.floor(calls / 3);
    calls++;
    const table = iter < failCount ? ALL_FAIL_TABLE : ALL_PASS_TABLE;
    const r = table[key];
    if (!r) throw new Error(`no mock for ${key}`);
    return r;
  };
}

describe("runTeamLoop — happy path (verify already passes)", () => {
  it("exit 0 + iterations=1 + fixAttempts=0 when first verify pass is clean", () => {
    seedTeamSession({});
    const result = runTeamLoop({
      sessionId: SESSION_ID,
      cwd: tmp,
      maxLoops: 3,
      verifySpawnFn: spawnFromTable(ALL_PASS_TABLE),
      fixSpawnFn: () => ({ pid: 1, unref: () => {} }),
      awaitShardFn: () => true,
      now: () => 0,
      sleep: () => {},
      log: () => {},
      errLog: () => {},
    });
    expect(result.exitCode).toBe(0);
    expect(result.iterations).toBe(1);
    expect(result.fixAttempts).toBe(0);
    expect(result.finalPhase).toBe("completed");
    expect(result.loopExhausted).toBe(false);
  });
});

describe("runTeamLoop — single fix-loop converges", () => {
  it("verify fails once, fix-worker spawns, re-verify passes → exit 0", () => {
    const { pidDir } = seedTeamSession({});
    let fixWorkerIdx = 0;
    const result = runTeamLoop({
      sessionId: SESSION_ID,
      cwd: tmp,
      maxLoops: 3,
      verifySpawnFn: programmableVerifySpawn(1),
      fixSpawnFn: (_cmd, _args, _opts) => ({ pid: 90123, unref: () => {} }),
      awaitShardFn: (pidDir2, workerIndex) => {
        fixWorkerIdx = workerIndex;
        // Synthesize the fix-worker's shard immediately for the test.
        atomicWriteFileSync(
          path.join(pidDir2, `worker-${workerIndex}-shard.json`),
          JSON.stringify({ worker: workerIndex, fix_applied: true }),
        );
        return true;
      },
      now: () => 0,
      sleep: () => {},
      log: () => {},
      errLog: () => {},
    });
    expect(result.exitCode).toBe(0);
    expect(result.iterations).toBe(2); // 1 fail + 1 pass
    expect(result.fixAttempts).toBe(1);
    expect(result.finalPhase).toBe("completed");
    expect(fixWorkerIdx).toBe(3); // workers 1+2 + fix-worker = idx 3
    expect(
      fs.existsSync(path.join(pidDir, "worker-3-shard.json")),
    ).toBe(true);
  });
});

describe("runTeamLoop — bound exhaustion", () => {
  it("3 verify-fails with max=3 → exit 1 + finalPhase=failed + loopExhausted=true", () => {
    seedTeamSession({});
    const result = runTeamLoop({
      sessionId: SESSION_ID,
      cwd: tmp,
      maxLoops: 3,
      verifySpawnFn: spawnFromTable(ALL_FAIL_TABLE),
      fixSpawnFn: () => ({ pid: 1, unref: () => {} }),
      awaitShardFn: (pidDir, workerIndex) => {
        atomicWriteFileSync(
          path.join(pidDir, `worker-${workerIndex}-shard.json`),
          JSON.stringify({ worker: workerIndex }),
        );
        return true;
      },
      now: () => 0,
      sleep: () => {},
      log: () => {},
      errLog: () => {},
    });
    expect(result.exitCode).toBe(1);
    expect(result.loopExhausted).toBe(true);
    expect(result.finalPhase).toBe("failed");
    // The bound caught at the collect-side gate; fixAttempts can be 1..3.
    expect(result.fixAttempts).toBeGreaterThanOrEqual(1);
    expect(result.fixAttempts).toBeLessThanOrEqual(3);
  });
});

describe("runTeamLoop — max-loops=1 + persistent fail → exits after 1 attempt", () => {
  it("with max_fix_loops=1 + always-fail verify, 1st fix attempt then exhausted on 2nd collect", () => {
    seedTeamSession({});
    const result = runTeamLoop({
      sessionId: SESSION_ID,
      cwd: tmp,
      maxLoops: 1,
      verifySpawnFn: spawnFromTable(ALL_FAIL_TABLE),
      fixSpawnFn: () => ({ pid: 1, unref: () => {} }),
      awaitShardFn: (pidDir, workerIndex) => {
        atomicWriteFileSync(
          path.join(pidDir, `worker-${workerIndex}-shard.json`),
          JSON.stringify({ worker: workerIndex }),
        );
        return true;
      },
      now: () => 0,
      sleep: () => {},
      log: () => {},
      errLog: () => {},
    });
    expect(result.exitCode).toBe(1);
    expect(result.loopExhausted).toBe(true);
    expect(result.fixAttempts).toBe(1);
  });
});

describe("runTeamLoop — shard wait timeout", () => {
  it("returns exit 1 (loopExhausted=false) when the fix-worker shard never appears", () => {
    seedTeamSession({});
    const result = runTeamLoop({
      sessionId: SESSION_ID,
      cwd: tmp,
      maxLoops: 3,
      verifySpawnFn: spawnFromTable(ALL_FAIL_TABLE),
      fixSpawnFn: () => ({ pid: 1, unref: () => {} }),
      awaitShardFn: () => false, // simulate shard-wait timeout
      now: () => 0,
      sleep: () => {},
      log: () => {},
      errLog: () => {},
    });
    expect(result.exitCode).toBe(1);
    expect(result.loopExhausted).toBe(false);
    expect(result.fixAttempts).toBe(1);
  });
});

describe("runTeamLoop — argv + state guards", () => {
  it("exit 2 on invalid sessionId (assertSafeSlug)", () => {
    const result = runTeamLoop({
      sessionId: "../escape",
      cwd: tmp,
      verifySpawnFn: spawnFromTable(ALL_PASS_TABLE),
      fixSpawnFn: () => ({ pid: 1, unref: () => {} }),
      awaitShardFn: () => true,
      now: () => 0,
      sleep: () => {},
      log: () => {},
      errLog: () => {},
    });
    expect(result.exitCode).toBe(2);
    expect(result.iterations).toBe(0);
  });

  it("exit 3 when pidDir is absent (no team session)", () => {
    const result = runTeamLoop({
      sessionId: "no-such-sid",
      cwd: tmp,
      verifySpawnFn: spawnFromTable(ALL_PASS_TABLE),
      fixSpawnFn: () => ({ pid: 1, unref: () => {} }),
      awaitShardFn: () => true,
      now: () => 0,
      sleep: () => {},
      log: () => {},
      errLog: () => {},
    });
    expect(result.exitCode).toBe(3);
  });

  it("exit 3 when pidDir exists but TeamState is missing", () => {
    const sid = "loose-piddir";
    const pd = path.join(tmp, ".omcp", "state", "team", sid);
    fs.mkdirSync(pd, { recursive: true });
    const result = runTeamLoop({
      sessionId: sid,
      cwd: tmp,
      verifySpawnFn: spawnFromTable(ALL_PASS_TABLE),
      fixSpawnFn: () => ({ pid: 1, unref: () => {} }),
      awaitShardFn: () => true,
      now: () => 0,
      sleep: () => {},
      log: () => {},
      errLog: () => {},
    });
    expect(result.exitCode).toBe(3);
  });
});

describe("runTeamLoop — already-terminal session", () => {
  it("session already in completed phase: returns exit 0 in 1 iteration", () => {
    seedTeamSession({ phase: "completed" });
    const result = runTeamLoop({
      sessionId: SESSION_ID,
      cwd: tmp,
      verifySpawnFn: spawnFromTable(ALL_PASS_TABLE),
      fixSpawnFn: () => ({ pid: 1, unref: () => {} }),
      awaitShardFn: () => true,
      now: () => 0,
      sleep: () => {},
      log: () => {},
      errLog: () => {},
    });
    expect(result.exitCode).toBe(0);
    expect(result.finalPhase).toBe("completed");
  });
});

describe("runTeamLoopCli", () => {
  it("returns same exit code as runTeamLoop", () => {
    seedTeamSession({});
    const code = runTeamLoopCli(SESSION_ID, {
      cwd: tmp,
      maxLoops: 3,
      verifySpawnFn: spawnFromTable(ALL_PASS_TABLE),
      fixSpawnFn: () => ({ pid: 1, unref: () => {} }),
      awaitShardFn: () => true,
      now: () => 0,
      sleep: () => {},
      log: () => {},
      errLog: () => {},
    });
    expect(code).toBe(0);
  });
});

describe("runTeamLoop — summary output", () => {
  it("logs session, max_fix_loops, shard_timeout, per-iteration phases, and outcome", () => {
    seedTeamSession({});
    const out: string[] = [];
    runTeamLoop({
      sessionId: SESSION_ID,
      cwd: tmp,
      maxLoops: 3,
      verifySpawnFn: spawnFromTable(ALL_PASS_TABLE),
      fixSpawnFn: () => ({ pid: 1, unref: () => {} }),
      awaitShardFn: () => true,
      now: () => 0,
      sleep: () => {},
      log: (l) => out.push(l),
      errLog: () => {},
    });
    const summary = out.join("\n");
    expect(summary).toMatch(/session=team-loop-sid/);
    expect(summary).toMatch(/max_fix_loops:\s+3/);
    expect(summary).toMatch(/shard_timeout_ms:\s+\d+/);
    expect(summary).toMatch(/iter 1: verify/);
    expect(summary).toMatch(/iter 1: collect finalPhase=completed/);
    expect(summary).toMatch(/outcome=completed/);
  });
});
