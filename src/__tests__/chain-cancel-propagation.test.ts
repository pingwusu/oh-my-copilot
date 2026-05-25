/**
 * Unit tests for Story 12 / US-omcp-parity-P3-CHAIN-cancel-propagation.
 *
 * Covers iter-2 plan AC: when `omcp cancel` runs while a chain is active,
 *   - writes cancel marker (existing runCancel — covered by mode tests)
 *   - clears chain-state.json
 *   - signals current step's mode-state.cancelled=true
 *
 * Plus per-mode propagation: ralph / team / ralplan / autopilot all
 * receive the cancelled flag when they are the current step.
 *
 * The ADR (docs/adr/ADR-omcp-cancel-semantics.md) covers which modes
 * actually HONOR the cancelled flag — this test file pins the
 * SIGNAL-LANDS contract only.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  chainStateFilePath,
  propagateCancelToChain,
  writeChainState,
  type ChainState,
} from "../cli/commands/chain.js";
import {
  readModeState,
  writeModeState,
  type BaseModeState,
} from "../runtime/mode-state.js";

let tmp: string;
let cwdSnapshot: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "omcp-chain-cancel-"));
  cwdSnapshot = process.cwd();
  process.chdir(tmp);
});
afterEach(() => {
  process.chdir(cwdSnapshot);
  fs.rmSync(tmp, { recursive: true, force: true });
});

function seedRunningChain(currentStep: number, steps: Array<{ verb: string; args?: string[] }>): void {
  const state: ChainState = {
    currentStep,
    totalSteps: steps.length,
    completedSteps: Array.from({ length: currentStep - 1 }, (_, i) => i + 1),
    ts: "2026-05-25T00:00:00.000Z",
    status: "running",
    steps: steps.map((s) => ({ verb: s.verb, args: s.args ?? [] })),
  };
  writeChainState(state, tmp);
}

describe("propagateCancelToChain — no chain active", () => {
  it("returns chainWasActive=false when chain-state.json is absent", () => {
    const r = propagateCancelToChain({ cwd: tmp });
    expect(r.chainWasActive).toBe(false);
    expect(r.modeStateSignalled).toBe(false);
    expect(r.chainStateCleared).toBe(false);
  });

  it("returns chainWasActive=false when chain is already in terminal state", () => {
    writeChainState(
      {
        currentStep: 2,
        totalSteps: 2,
        completedSteps: [1, 2],
        ts: "2026-05-25T00:00:00.000Z",
        status: "completed",
        steps: [
          { verb: "ralplan", args: [] },
          { verb: "ralph", args: [] },
        ],
      },
      tmp,
    );
    const r = propagateCancelToChain({ cwd: tmp });
    expect(r.chainWasActive).toBe(false);
    expect(r.chainStateCleared).toBe(false);
    // chain-state.json still present (untouched).
    expect(fs.existsSync(chainStateFilePath(tmp))).toBe(true);
  });
});

describe("propagateCancelToChain — ralph step in flight (AC happy path)", () => {
  it("ralph step + cancel → ralph-state.cancelled=true + chain-state cleared", () => {
    writeModeState<BaseModeState>("ralph", {
      active: true,
      session_id: "ralph-sid",
      started_at: "2026-05-25T00:00:00.000Z",
    });
    seedRunningChain(2, [
      { verb: "ralplan", args: ["fix-readme"] },
      { verb: "ralph", args: [] },
    ]);

    const r = propagateCancelToChain({ cwd: tmp });
    expect(r.chainWasActive).toBe(true);
    expect(r.currentStepVerb).toBe("ralph");
    expect(r.modeStateSignalled).toBe(true);
    expect(r.chainStateCleared).toBe(true);

    // chain-state.json is cleared.
    expect(fs.existsSync(chainStateFilePath(tmp))).toBe(false);
    // ralph state now carries cancelled=true (additive field).
    const ralphState = readModeState<BaseModeState & { cancelled?: boolean }>("ralph");
    expect(ralphState?.cancelled).toBe(true);
    // Other fields preserved.
    expect(ralphState?.session_id).toBe("ralph-sid");
  });
});

describe("propagateCancelToChain — per-mode coverage", () => {
  it("team step in flight → team-state.cancelled=true", () => {
    writeModeState<BaseModeState>("team", {
      active: true,
      session_id: "team-sid",
      started_at: "2026-05-25T00:00:00.000Z",
    });
    seedRunningChain(1, [{ verb: "team", args: ["2", "executor"] }]);
    const r = propagateCancelToChain({ cwd: tmp });
    expect(r.modeStateSignalled).toBe(true);
    expect(
      readModeState<BaseModeState & { cancelled?: boolean }>("team")?.cancelled,
    ).toBe(true);
  });

  it("ralplan / autopilot / ultrawork / ultraqa / sciomc / ultragoal all propagate", () => {
    for (const verb of [
      "ralplan",
      "autopilot",
      "ultrawork",
      "ultraqa",
      "sciomc",
      "ultragoal",
    ] as const) {
      // Fresh tmp for each iteration via clearing prior state.
      fs.rmSync(path.join(tmp, ".omcp"), { recursive: true, force: true });
      writeModeState<BaseModeState>(verb, {
        active: true,
        session_id: `${verb}-sid`,
        started_at: "2026-05-25T00:00:00.000Z",
      });
      seedRunningChain(1, [{ verb }]);
      const r = propagateCancelToChain({ cwd: tmp });
      expect(r.modeStateSignalled, `${verb} should be signalled`).toBe(true);
      expect(
        readModeState<BaseModeState & { cancelled?: boolean }>(verb)?.cancelled,
        `${verb}.cancelled=true`,
      ).toBe(true);
    }
  });
});

describe("propagateCancelToChain — best-effort fallthroughs", () => {
  it("modeStateSignalled=false when current step verb is unknown (e.g. team-verify)", () => {
    // team-verify is a CLI verb but is NOT a top-level ModeName — the
    // chain step verb → ModeName mapping intentionally omits it. The
    // cancel marker still gets written; modeStateSignalled just reports
    // the propagation didn't fire into a mode-state file.
    seedRunningChain(1, [{ verb: "team-verify", args: ["sid"] }]);
    const r = propagateCancelToChain({ cwd: tmp });
    expect(r.chainWasActive).toBe(true);
    expect(r.currentStepVerb).toBe("team-verify");
    expect(r.modeStateSignalled).toBe(false);
    expect(r.chainStateCleared).toBe(true);
  });

  it("modeStateSignalled=false when mode-state file doesn't exist yet for the verb", () => {
    // Chain step is ralph but no ralph-state.json exists (chain crashed
    // BEFORE ralph spawned). Cancel is still recorded by clearing
    // chain-state but propagation can't fire into a nonexistent state.
    seedRunningChain(1, [{ verb: "ralph", args: [] }]);
    const r = propagateCancelToChain({ cwd: tmp });
    expect(r.chainWasActive).toBe(true);
    expect(r.modeStateSignalled).toBe(false);
    expect(r.chainStateCleared).toBe(true);
  });

  it("handing-off-to-* is treated as non-terminal (propagation applies)", () => {
    // Story 10's handoff status string is non-terminal.
    writeModeState<BaseModeState>("team", {
      active: true,
      session_id: "team-handoff-sid",
      started_at: "2026-05-25T00:00:00.000Z",
    });
    writeChainState(
      {
        currentStep: 1,
        totalSteps: 2,
        completedSteps: [],
        ts: "2026-05-25T00:00:00.000Z",
        status: "handing-off-to-ralph",
        steps: [
          { verb: "team", args: [] },
          { verb: "ralph", args: [] },
        ],
      },
      tmp,
    );
    const r = propagateCancelToChain({ cwd: tmp });
    expect(r.chainWasActive).toBe(true);
    expect(r.currentStepVerb).toBe("team");
    expect(r.modeStateSignalled).toBe(true);
  });
});

describe("propagateCancelToChain — idempotence", () => {
  it("second call after the first cleared chain-state.json is a no-op", () => {
    writeModeState<BaseModeState>("ralph", {
      active: true,
      session_id: "ralph-idem",
      started_at: "2026-05-25T00:00:00.000Z",
    });
    seedRunningChain(1, [{ verb: "ralph", args: [] }]);
    const r1 = propagateCancelToChain({ cwd: tmp });
    expect(r1.chainWasActive).toBe(true);
    const r2 = propagateCancelToChain({ cwd: tmp });
    expect(r2.chainWasActive).toBe(false);
    expect(r2.modeStateSignalled).toBe(false);
    expect(r2.chainStateCleared).toBe(false);
  });
});

describe("propagateCancelToChain — preserves other state fields", () => {
  it("ralph state's other fields survive the cancel update", () => {
    writeModeState<BaseModeState & { iteration?: number; max_iterations?: number }>(
      "ralph",
      {
        active: true,
        session_id: "ralph-preserve-sid",
        started_at: "2026-05-25T00:00:00.000Z",
        iteration: 4,
        max_iterations: 10,
        prompt: "test prompt",
      } as BaseModeState & { iteration?: number; max_iterations?: number },
    );
    seedRunningChain(1, [{ verb: "ralph", args: [] }]);
    propagateCancelToChain({ cwd: tmp });

    const state = readModeState<
      BaseModeState & {
        cancelled?: boolean;
        iteration?: number;
        max_iterations?: number;
      }
    >("ralph")!;
    expect(state.cancelled).toBe(true);
    expect(state.iteration).toBe(4);
    expect(state.max_iterations).toBe(10);
    expect(state.prompt).toBe("test prompt");
    expect(state.session_id).toBe("ralph-preserve-sid");
  });
});
