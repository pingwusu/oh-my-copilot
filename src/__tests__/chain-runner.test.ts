/**
 * Unit tests for Story 9 / US-omcp-parity-P3-CHAIN-runner.
 *
 * Pure-runner tests with injected stepRunner — no real spawns. Covers:
 *   - Empty chain returns exit 0 + status=completed
 *   - 3-step happy path: all steps run in order + each gets correct stepIndex
 *   - step-2 fails → step-3 NOT spawned; chain-state.json persists with
 *     status=failed, failedStep=2, completedSteps=[1]
 *   - chain-state.json marker is written before each step (running) +
 *     final (completed/failed) — assertion via cross-step inspection
 *   - readChainState / clearChainState / chainStateFilePath helpers
 *   - default stepRunner refuses to execute (throws) when not injected
 *   - aggregate exit code = max(stepExitCodes)
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  chainStateFilePath,
  clearChainState,
  readChainState,
  runChain,
  writeChainState,
  type ChainState,
  type ChainStep,
} from "../cli/commands/chain.js";

let tmp: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "omcp-chain-runner-"));
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

const fixedNow = () => "2026-05-25T00:00:00.000Z";

describe("runChain — empty chain", () => {
  it("returns exit 0 + status=completed without writing chain-state.json", () => {
    const result = runChain({
      steps: [],
      cwd: tmp,
      now: fixedNow,
      stepRunner: () => 0,
    });
    expect(result.exitCode).toBe(0);
    expect(result.state.status).toBe("completed");
    expect(result.state.totalSteps).toBe(0);
    expect(result.state.completedSteps).toEqual([]);
    // Empty chain skips the marker write entirely.
    expect(fs.existsSync(chainStateFilePath(tmp))).toBe(false);
  });
});

describe("runChain — 3-step happy path", () => {
  it("executes all 3 steps in order with correct stepIndex + completedSteps progression", () => {
    const seenSteps: Array<{ verb: string; stepIndex: number; totalSteps: number }> = [];
    const stepsList: ChainStep[] = [
      { verb: "ralplan", args: ["fix-readme"] },
      { verb: "team", args: ["2", "executor"] },
      { verb: "ralph-verify", args: [] },
    ];
    const result = runChain({
      steps: stepsList,
      cwd: tmp,
      now: fixedNow,
      stepRunner: (step, ctx) => {
        seenSteps.push({
          verb: step.verb,
          stepIndex: ctx.stepIndex,
          totalSteps: ctx.totalSteps,
        });
        return 0;
      },
    });

    expect(result.exitCode).toBe(0);
    expect(result.state.status).toBe("completed");
    expect(result.state.currentStep).toBe(3);
    expect(result.state.completedSteps).toEqual([1, 2, 3]);
    expect(seenSteps).toEqual([
      { verb: "ralplan", stepIndex: 1, totalSteps: 3 },
      { verb: "team", stepIndex: 2, totalSteps: 3 },
      { verb: "ralph-verify", stepIndex: 3, totalSteps: 3 },
    ]);

    // Final marker on disk matches the result.state.
    const marker = readChainState(tmp);
    expect(marker).toBeDefined();
    expect(marker!.status).toBe("completed");
    expect(marker!.completedSteps).toEqual([1, 2, 3]);
  });
});

describe("runChain — step-2 fails → step-3 not spawned", () => {
  it("short-circuits + writes chain-state.json with failedStep=2 + completedSteps=[1]", () => {
    const calls: number[] = [];
    const result = runChain({
      steps: [
        { verb: "ralplan", args: [] },
        { verb: "team", args: ["fail"] },
        { verb: "ralph-verify", args: [] },
      ],
      cwd: tmp,
      now: fixedNow,
      stepRunner: (step, ctx) => {
        calls.push(ctx.stepIndex);
        if (ctx.stepIndex === 2) return 1;
        return 0;
      },
    });

    expect(result.exitCode).toBe(1);
    expect(result.state.status).toBe("failed");
    expect(result.state.failedStep).toBe(2);
    expect(result.state.currentStep).toBe(2);
    expect(result.state.completedSteps).toEqual([1]);
    // Step 3 must NOT have run.
    expect(calls).toEqual([1, 2]);

    // Marker on disk reflects the failure.
    const marker = readChainState(tmp);
    expect(marker!.status).toBe("failed");
    expect(marker!.failedStep).toBe(2);
    expect(marker!.completedSteps).toEqual([1]);
  });
});

describe("runChain — chain-state.json marker lifecycle", () => {
  it("writes status='running' before each step (visible from inside the stepRunner)", () => {
    const observedStatuses: Array<{ stepIndex: number; markerStatus: string }> = [];
    const result = runChain({
      steps: [
        { verb: "step1", args: [] },
        { verb: "step2", args: [] },
      ],
      cwd: tmp,
      now: fixedNow,
      stepRunner: (_step, ctx) => {
        const marker = readChainState(tmp);
        observedStatuses.push({
          stepIndex: ctx.stepIndex,
          markerStatus: marker?.status ?? "(no marker)",
        });
        return 0;
      },
    });

    expect(result.exitCode).toBe(0);
    // Inside step 1's runner, the marker is already at running/current=1.
    expect(observedStatuses[0]).toEqual({ stepIndex: 1, markerStatus: "running" });
    expect(observedStatuses[1]).toEqual({ stepIndex: 2, markerStatus: "running" });
  });

  it("snapshots the steps list inside the marker for postmortem reading", () => {
    runChain({
      steps: [
        { verb: "alpha", args: ["a1", "a2"] },
        { verb: "beta", args: [] },
      ],
      cwd: tmp,
      now: fixedNow,
      stepRunner: () => 0,
    });
    const marker = readChainState(tmp)!;
    expect(marker.steps).toEqual([
      { verb: "alpha", args: ["a1", "a2"] },
      { verb: "beta", args: [] },
    ]);
  });
});

describe("runChain — exit code aggregation", () => {
  it("returns max(stepExitCodes) when chain is allowed to short-circuit on first failure", () => {
    // First non-zero step triggers short-circuit, so aggregate is exactly
    // the first non-zero exit code. (This documents the current runner
    // semantic — a future "keep going through failures" mode would
    // produce a different aggregate.)
    const result = runChain({
      steps: [
        { verb: "a", args: [] },
        { verb: "b", args: [] },
        { verb: "c", args: [] },
      ],
      cwd: tmp,
      now: fixedNow,
      stepRunner: (_s, ctx) => (ctx.stepIndex === 2 ? 7 : 0),
    });
    expect(result.exitCode).toBe(7);
    expect(result.state.failedStep).toBe(2);
  });

  it("returns 0 only when every step succeeded", () => {
    const result = runChain({
      steps: [
        { verb: "a", args: [] },
        { verb: "b", args: [] },
      ],
      cwd: tmp,
      now: fixedNow,
      stepRunner: () => 0,
    });
    expect(result.exitCode).toBe(0);
  });
});

describe("default stepRunner refuses to execute", () => {
  it("throws when no stepRunner is injected (Story 10 will wire the default)", () => {
    expect(() =>
      runChain({
        steps: [{ verb: "anything", args: [] }],
        cwd: tmp,
        now: fixedNow,
      }),
    ).toThrow(/default stepRunner not yet implemented/);
  });
});

describe("chain-state.json helpers", () => {
  it("chainStateFilePath resolves to .omcp/state/chain-state.json under cwd", () => {
    expect(chainStateFilePath(tmp)).toBe(
      path.join(tmp, ".omcp", "state", "chain-state.json"),
    );
  });

  it("readChainState returns undefined when the file does not exist", () => {
    expect(readChainState(tmp)).toBeUndefined();
  });

  it("writeChainState + readChainState roundtrip preserves all fields", () => {
    const state: ChainState = {
      currentStep: 2,
      totalSteps: 3,
      completedSteps: [1],
      ts: fixedNow(),
      status: "running",
      steps: [
        { verb: "a", args: [] },
        { verb: "b", args: ["x"] },
        { verb: "c", args: [] },
      ],
    };
    writeChainState(state, tmp);
    const read = readChainState(tmp);
    expect(read).toEqual(state);
  });

  it("clearChainState removes the marker (tolerant of absent)", () => {
    writeChainState(
      {
        currentStep: 1,
        totalSteps: 1,
        completedSteps: [],
        ts: fixedNow(),
        status: "running",
        steps: [{ verb: "x", args: [] }],
      },
      tmp,
    );
    expect(fs.existsSync(chainStateFilePath(tmp))).toBe(true);
    clearChainState(tmp);
    expect(fs.existsSync(chainStateFilePath(tmp))).toBe(false);
    // Second clear is a no-op.
    expect(() => clearChainState(tmp)).not.toThrow();
  });

  it("readChainState returns undefined for unparseable JSON", () => {
    const p = chainStateFilePath(tmp);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, "{not valid json", "utf8");
    expect(readChainState(tmp)).toBeUndefined();
  });
});
