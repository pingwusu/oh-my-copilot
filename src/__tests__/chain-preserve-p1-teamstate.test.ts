/**
 * Unit tests for Story 11 / US-omcp-parity-P3-CHAIN-preserve-P1-teamstate.
 *
 * Covers the iter-2 plan AC: when prepareTransition (Story 10) snapshots
 * a team → exclusive-to-mode handoff, the chain-handoffs/step-N.json
 * snapshot MUST preserve every Phase 1 TeamState field verbatim so a
 * downstream ralph step (or postmortem inspector) can read the team's
 * loop posture intact. The explicit field list:
 *
 *   - fix_loop_count   (v2.1 Story 4 addition)
 *   - current_phase    (v1.3+)
 *   - stage_history    (v1.3+)
 *   - started_at       (v1.0+)
 *   - workers[].status (v1.0+ + Story 7 --status writes)
 *
 * Plus end-to-end cross-mode integration: a real verify/fix loop runs to
 * completion with fix_loop_count=1, then prepareTransition fires, and
 * readChainHandoff returns the same fix_loop_count value to a simulated
 * ralph step.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  prepareTransition,
} from "../cli/commands/chain.js";
import {
  getTeamHandoffPhase1Metadata,
  readChainHandoff,
} from "../lib/chain-handoff-reader.js";
import {
  runTeamVerify,
  spawnFixWorker,
  type VerifySpawnResult,
} from "../cli/commands/team-verify.js";
import { runTeamCollect } from "../cli/commands/team-phase-controller.js";
import {
  readModeState,
  writeModeState,
  type TeamState,
} from "../runtime/mode-state.js";
import { atomicWriteFileSync } from "../runtime/atomic-write.js";

const fixedNow = () => "2026-05-25T00:00:00.000Z";

let tmp: string;
let cwdSnapshot: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "omcp-preserve-p1-"));
  cwdSnapshot = process.cwd();
  process.chdir(tmp);
});
afterEach(() => {
  process.chdir(cwdSnapshot);
  fs.rmSync(tmp, { recursive: true, force: true });
});

function seedTeamState(overrides: Partial<TeamState> = {}): void {
  writeModeState<TeamState>(
    "team",
    {
      active: true,
      session_id: "preserve-p1-sid",
      started_at: "2026-05-25T00:00:00.000Z",
      spawned: 4,
      done: 4,
      workers: [
        { id: "worker-1", status: "completed" },
        { id: "worker-2", status: "completed" },
        { id: "worker-3", status: "in_progress", agent: "debugger" },
        { id: "worker-4", status: "failed" },
      ],
      current_phase: "completed",
      stage_history: ["initializing", "executing", "completed"],
      fix_loop_count: 1,
      ...overrides,
    },
  );
}

describe("Story 11 — explicit Phase 1 field preservation", () => {
  it("snapshot preserves fix_loop_count verbatim", () => {
    seedTeamState({ fix_loop_count: 2 });
    prepareTransition({
      fromMode: "team",
      toMode: "ralph",
      stepN: 1,
      cwd: tmp,
      now: fixedNow,
      spawnToMode: () => 0,
    });
    const snapshot = readChainHandoff(1, tmp)!;
    const md = getTeamHandoffPhase1Metadata(snapshot)!;
    expect(md.fix_loop_count).toBe(2);
  });

  it("snapshot preserves current_phase verbatim", () => {
    seedTeamState({ current_phase: "completed" });
    prepareTransition({
      fromMode: "team",
      toMode: "ralph",
      stepN: 1,
      cwd: tmp,
      now: fixedNow,
      spawnToMode: () => 0,
    });
    const md = getTeamHandoffPhase1Metadata(readChainHandoff(1, tmp)!)!;
    expect(md.current_phase).toBe("completed");
    expect(md.team_completed).toBe(true);
  });

  it("snapshot preserves stage_history verbatim", () => {
    seedTeamState({
      stage_history: ["initializing", "executing", "fixing", "completed"],
    });
    prepareTransition({
      fromMode: "team",
      toMode: "ralph",
      stepN: 1,
      cwd: tmp,
      now: fixedNow,
      spawnToMode: () => 0,
    });
    const md = getTeamHandoffPhase1Metadata(readChainHandoff(1, tmp)!)!;
    expect(md.stage_history).toEqual([
      "initializing",
      "executing",
      "fixing",
      "completed",
    ]);
  });

  it("snapshot preserves started_at verbatim", () => {
    seedTeamState({ started_at: "2026-05-25T12:34:56.789Z" });
    prepareTransition({
      fromMode: "team",
      toMode: "ralph",
      stepN: 1,
      cwd: tmp,
      now: fixedNow,
      spawnToMode: () => 0,
    });
    const md = getTeamHandoffPhase1Metadata(readChainHandoff(1, tmp)!)!;
    expect(md.started_at).toBe("2026-05-25T12:34:56.789Z");
  });

  it("snapshot preserves workers[].status verbatim including --status updates", () => {
    seedTeamState();
    prepareTransition({
      fromMode: "team",
      toMode: "ralph",
      stepN: 1,
      cwd: tmp,
      now: fixedNow,
      spawnToMode: () => 0,
    });
    const md = getTeamHandoffPhase1Metadata(readChainHandoff(1, tmp)!)!;
    expect(md.workers).toEqual([
      { id: "worker-1", status: "completed" },
      { id: "worker-2", status: "completed" },
      { id: "worker-3", status: "in_progress", agent: "debugger" },
      { id: "worker-4", status: "failed" },
    ]);
  });

  it("team_completed flag mirrors current_phase=='completed'", () => {
    seedTeamState({ current_phase: "failed" });
    prepareTransition({
      fromMode: "team",
      toMode: "ralph",
      stepN: 1,
      cwd: tmp,
      now: fixedNow,
      spawnToMode: () => 0,
    });
    const md = getTeamHandoffPhase1Metadata(readChainHandoff(1, tmp)!)!;
    expect(md.team_completed).toBe(false);
  });
});

describe("Story 11 — extractor returns undefined for non-team handoffs", () => {
  it("returns undefined when fromMode !== 'team'", () => {
    writeModeState("ralph", {
      active: true,
      session_id: "x",
      started_at: "x",
      iteration: 1,
      max_iterations: 10,
    } as unknown as Parameters<typeof writeModeState>[1]);
    prepareTransition({
      fromMode: "ralph",
      toMode: "team",
      stepN: 1,
      cwd: tmp,
      now: fixedNow,
      spawnToMode: () => 0,
    });
    const snapshot = readChainHandoff(1, tmp)!;
    expect(getTeamHandoffPhase1Metadata(snapshot)).toBeUndefined();
  });

  it("returns undefined when fromState=null (team never ran)", () => {
    // No seedTeamState() call — fromState in snapshot will be null.
    prepareTransition({
      fromMode: "team",
      toMode: "ralph",
      stepN: 1,
      cwd: tmp,
      now: fixedNow,
      spawnToMode: () => 0,
    });
    const snapshot = readChainHandoff(1, tmp)!;
    expect(getTeamHandoffPhase1Metadata(snapshot)).toBeUndefined();
  });
});

describe("Story 11 — readChainHandoff defensive shape validation", () => {
  it("returns undefined when snapshot is absent", () => {
    expect(readChainHandoff(99, tmp)).toBeUndefined();
  });

  it("returns undefined when snapshot is corrupt JSON", () => {
    const p = path.join(tmp, ".omcp", "state", "chain-handoffs", "step-1.json");
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, "{ corrupt", "utf8");
    expect(readChainHandoff(1, tmp)).toBeUndefined();
  });

  it("returns undefined when snapshot is JSON but missing required fields", () => {
    const p = path.join(tmp, ".omcp", "state", "chain-handoffs", "step-1.json");
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(
      p,
      JSON.stringify({ stepN: "not-a-number" }),
      "utf8",
    );
    expect(readChainHandoff(1, tmp)).toBeUndefined();
  });
});

describe("Story 11 — cross-mode integration: verify/fix loop → chain handoff", () => {
  it("4-worker team with fix_loop_count=1 → handoff → ralph readChainHandoff sees fix_loop_count=1", () => {
    // STEP A: seed 4-worker team in 'executing'.
    const sessionId = "preserve-p1-int-sid";
    writeModeState<TeamState>(
      "team",
      {
        active: true,
        session_id: sessionId,
        started_at: fixedNow(),
        spawned: 4,
        done: 0,
        workers: Array.from({ length: 4 }, (_, i) => ({
          id: `worker-${i + 1}`,
          status: "pending",
        })),
        current_phase: "executing",
        stage_history: ["initializing", "executing"],
      },
      sessionId,
    );

    // STEP B: write 4 pidfiles + shards to simulate completed workers.
    const pidDir = path.join(tmp, ".omcp", "state", "team", sessionId);
    fs.mkdirSync(pidDir, { recursive: true });
    for (let i = 1; i <= 4; i++) {
      atomicWriteFileSync(path.join(pidDir, `worker-${i}.pid`), String(50000 + i));
      atomicWriteFileSync(
        path.join(pidDir, `worker-${i}-shard.json`),
        JSON.stringify({ worker: i, done: true }),
      );
    }

    // STEP C: first verify pass fails on vitest → writes 4 worker-K signals.
    const failTable: Record<string, VerifySpawnResult> = {
      "npx vitest": { exitCode: 1, output: "fail" },
      "npx tsc": { exitCode: 0, output: "" },
      "npx biome": { exitCode: 0, output: "" },
    };
    runTeamVerify({
      sessionId,
      cwd: tmp,
      spawnFn: (cmd, args) => {
        const k = `${cmd} ${args[0] ?? ""}`;
        if (!failTable[k]) throw new Error(`no mock for ${k}`);
        return failTable[k];
      },
    });

    // STEP D: collect → fixing (writes verify-fail-summary.json).
    runTeamCollect(sessionId, {
      cwd: tmp,
      isProcessAlive: () => true,
    });

    // STEP E: spawn one fix-worker → fix_loop_count → 1.
    const fixResult = spawnFixWorker({
      sessionId,
      cwd: tmp,
      maxLoops: 3,
      spawnFn: (_cmd, _args, _opts) => ({
        pid: 60123,
        unref: () => {},
      }),
    });
    expect(fixResult.fixLoopCount).toBe(1);
    expect(readModeState<TeamState>("team", sessionId)!.fix_loop_count).toBe(1);

    // STEP F: post-fix-worker re-verify (all pass) so team completes.
    const passTable: Record<string, VerifySpawnResult> = {
      "npx vitest": { exitCode: 0, output: "ok" },
      "npx tsc": { exitCode: 0, output: "" },
      "npx biome": { exitCode: 0, output: "" },
    };
    // Synthesize the fix-worker's shard so collect sees it.
    atomicWriteFileSync(
      path.join(pidDir, `worker-${fixResult.fixWorkerIndex}-shard.json`),
      JSON.stringify({ worker: fixResult.fixWorkerIndex, fix_applied: true }),
    );
    runTeamVerify({
      sessionId,
      cwd: tmp,
      spawnFn: (cmd, args) => {
        const k = `${cmd} ${args[0] ?? ""}`;
        if (!passTable[k]) throw new Error(`no mock for ${k}`);
        return passTable[k];
      },
    });
    runTeamCollect(sessionId, {
      cwd: tmp,
      isProcessAlive: () => true,
    });

    // STEP G: confirm team state shows fix_loop_count=1 + completed.
    const afterLoop = readModeState<TeamState>("team", sessionId)!;
    expect(afterLoop.fix_loop_count).toBe(1);
    expect(afterLoop.current_phase).toBe("completed");

    // STEP H: prepareTransition team → ralph (handoff snapshot at step 2).
    prepareTransition({
      fromMode: "team",
      toMode: "ralph",
      stepN: 2,
      cwd: tmp,
      now: fixedNow,
      fromSessionId: sessionId,
      spawnToMode: () => 0,
    });

    // STEP I: readChainHandoff(2) MUST surface fix_loop_count=1 to ralph.
    const snapshot = readChainHandoff(2, tmp)!;
    expect(snapshot.fromMode).toBe("team");
    expect(snapshot.toMode).toBe("ralph");
    const md = getTeamHandoffPhase1Metadata(snapshot)!;
    expect(md.fix_loop_count).toBe(1);
    expect(md.current_phase).toBe("completed");
    expect(md.team_completed).toBe(true);
  });
});
