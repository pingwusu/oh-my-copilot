/**
 * Deterministic integration tests for the v1.6 ralph outer-loop redesign.
 *
 * Background (full architecture rationale in
 * docs/architecture/v1.6-outer-loop-redesign.md):
 *
 * v1.3-v1.5 relied on Stop hooks for iteration counter advance +
 * compaction-advise + continuation context injection. But the upstream
 * Copilot Windows pwsh dispatch bug
 * (docs/upstream-reports/copilot-pwsh-dispatch-v1.5-investigation.md)
 * means Stop hooks never execute live on 1.0.53-2 Windows. The v1.4
 * live smoke showed 36 hook failures and ralph-state.iteration stayed
 * at 1 throughout the run.
 *
 * v1.6 fix: mode.ts now owns iteration advancement via a while-loop
 * that re-spawns copilot between iterations. Each iteration stamps
 * ralph-state with `outerLoopOwned: true` so the Stop hook code path
 * (when upstream eventually fixes the dispatch bug) defers via a
 * noop guard rather than double-incrementing.
 *
 * These tests verify the live-observable iteration counter advance
 * that was missing from v1.3-v1.5 — the user's core requirement.
 */

import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  vi,
  type MockInstance,
} from "vitest";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ── module mocks (hoisted) ───────────────────────────────────────────────────

vi.mock("../../src/runtime/resolve-executable.js", () => ({
  spawnSyncCrossPlatform: vi.fn(() => ({ status: 0, pid: 1 })),
}));

vi.mock("../../src/notifications/config-loader.js", () => ({
  loadConfig: vi.fn(() => ({})),
}));

vi.mock("../../src/notifications/dispatcher.js", () => ({
  dispatch: vi.fn(),
}));

// ── imports (after mocks) ────────────────────────────────────────────────────

import { runMode } from "../cli/commands/mode.js";
import {
  readPrd,
  readRalphState,
  writePrd,
  writeRalphState,
  type PRD,
  type RalphState,
} from "../lib/ralph-state.js";
import { createPersistentModeHook } from "../hooks/persistent-mode/index.js";
import * as resolveExecutable from "../runtime/resolve-executable.js";
import type { HookContext } from "../hooks/hook-types.js";

// ── helpers ──────────────────────────────────────────────────────────────────

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), "omcp-ralph-outer-"));
}

function makePrd(storyCount: number, allPasses = false): PRD {
  return {
    project: "outer-loop-test",
    branchName: "main",
    description: "test PRD",
    userStories: Array.from({ length: storyCount }, (_, i) => ({
      id: `US-${String(i + 1).padStart(3, "0")}`,
      title: `Story ${i + 1}`,
      description: `desc ${i + 1}`,
      acceptanceCriteria: [`AC ${i + 1}`],
      priority: i + 1,
      passes: allPasses,
    })),
  };
}

function readPrdFromDisk(): PRD {
  const prd = readPrd();
  if (!prd) throw new Error("expected PRD on disk");
  return prd;
}

// ── setup / teardown ─────────────────────────────────────────────────────────

let tmp: string;
let cwdSnapshot: string;
let spawnMock: MockInstance;

beforeEach(() => {
  tmp = makeTmpDir();
  mkdirSync(join(tmp, ".omcp", "state"), { recursive: true });
  cwdSnapshot = process.cwd();
  process.chdir(tmp);

  spawnMock = resolveExecutable.spawnSyncCrossPlatform as unknown as MockInstance;
  spawnMock.mockClear();
});

afterEach(() => {
  process.chdir(cwdSnapshot);
  rmSync(tmp, { recursive: true, force: true });
  vi.restoreAllMocks();
});

// ── tests ────────────────────────────────────────────────────────────────────

describe("v1.6 ralph outer-loop — iteration advance without Stop hook", () => {
  it("test 1: 3-story PRD with mock that completes one story per spawn → 3 outer iterations, exits cleanly", () => {
    writePrd(makePrd(3, false));

    // Each spawn marks the next incomplete story as passes:true.
    spawnMock.mockImplementation(() => {
      const prd = readPrdFromDisk();
      const next = prd.userStories.find((s) => !s.passes);
      if (next) {
        next.passes = true;
        writePrd(prd);
      }
      return { status: 0, pid: 1 };
    });

    runMode({ mode: "ralph", task: "implement all stories" });

    // Outer loop should spawn exactly 3 times — one per story.
    expect(spawnMock).toHaveBeenCalledTimes(3);

    // After all stories pass, ralph-state should be cleared
    // (clearModeState in last iteration removes the file).
    expect(readRalphState()).toBeNull();

    // PRD should show all 3 stories passing.
    const finalPrd = readPrdFromDisk();
    expect(finalPrd.userStories.every((s) => s.passes)).toBe(true);
  });

  it("test 2: outer loop bails on non-zero exit; state preserved with outerLoopOwned cleared (crash recovery)", () => {
    writePrd(makePrd(3, false));

    // Mock spawn: non-zero exit on first call (crash).
    spawnMock.mockImplementation(() => ({ status: 1, pid: 1 }));

    runMode({ mode: "ralph", task: "implement all stories" });

    // Only one spawn before crash bail-out.
    expect(spawnMock).toHaveBeenCalledTimes(1);

    // Crash recovery: ralph-state preserved with outerLoopOwned cleared
    // so a subsequent `omcp ralph --resume` doesn't think it's still
    // inside an outer-loop iteration. Note: mode.ts pre-spawn always
    // writes iteration:1, so the "preserved snapshot" iteration matches
    // that, not any earlier seeded value — this is the documented
    // behavior (without --resume, fresh runs start fresh).
    const post = readRalphState();
    expect(post).not.toBeNull();
    expect(post!.active).toBe(true);
    expect(post!.iteration).toBe(1);
    expect(post!.outerLoopOwned).toBe(false);
  });

  it("test 3: hook guard — Stop hook returns noop when state.outerLoopOwned is true (prevents double-increment)", async () => {
    // Seed ralph state as if mode.ts outer loop has just written it.
    const seeded: RalphState = {
      active: true,
      iteration: 5,
      lastFiredAt: new Date().toISOString(),
      prompt: "outer-loop owned task",
      outerLoopOwned: true,
    };
    writeRalphState(seeded);

    const hook = createPersistentModeHook();
    const ctx: HookContext = {
      event: "Stop",
      sessionId: "test-session",
      cwd: tmp,
      payload: {
        hook_event_name: "Stop",
        session_id: "test-session",
        stop_reason: "end_turn",
        cwd: tmp,
        timestamp: new Date().toISOString(),
      },
    };

    const result = await hook.run(ctx);

    // Hook MUST defer (noop) when outer loop owns iteration.
    expect(result.kind).toBe("noop");

    // Iteration MUST NOT have advanced — mode.ts owns advancement.
    const post = readRalphState();
    expect(post).not.toBeNull();
    expect(post!.iteration).toBe(5);
    expect(post!.outerLoopOwned).toBe(true);
  });

  it("test 4: outer loop respects maxOuterIterations cap when PRD never completes", () => {
    writePrd(makePrd(10, false));
    // Mock spawn that NEVER completes any story (exit 0 but no PRD progress).
    spawnMock.mockImplementation(() => ({ status: 0, pid: 1 }));

    runMode({
      mode: "ralph",
      task: "impossible task",
      maxOuterIterations: 3,
    });

    // Loop should exit after exactly 3 spawns.
    expect(spawnMock).toHaveBeenCalledTimes(3);

    // PRD still incomplete.
    const finalPrd = readPrdFromDisk();
    expect(finalPrd.userStories.every((s) => !s.passes)).toBe(true);

    // v1.6 critic M4: verify the max-exhaustion state-preservation path.
    // The outer loop should leave ralph-state with:
    //   - active: true (resume-ready)
    //   - iteration: maxOuter (== 3)
    //   - outerLoopOwned: false (loop is no longer running)
    const post = readRalphState();
    expect(post).not.toBeNull();
    expect(post!.active).toBe(true);
    expect(post!.iteration).toBe(3);
    expect(post!.outerLoopOwned).toBe(false);
  });

  it("test 5 (architect A1): maxOuterIterations clamp — pass 0 or negative, falls back to at least 1 spawn", () => {
    writePrd(makePrd(2, false));
    spawnMock.mockImplementation(() => {
      const prd = readPrdFromDisk();
      const next = prd.userStories.find((s) => !s.passes);
      if (next) {
        next.passes = true;
        writePrd(prd);
      }
      return { status: 0, pid: 1 };
    });

    runMode({
      mode: "ralph",
      task: "test clamp",
      maxOuterIterations: 0,
    });

    // Clamp to 1: should still spawn once, complete first story.
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });

  it("test 6 (v1.7 M1): stall detection — bail after N consecutive zero-progress iterations", () => {
    writePrd(makePrd(5, false));
    // Mock spawn: complete first story on call 1, then never progress.
    // Outer loop should observe stall and bail at iteration 3 (1 productive + 2 stalled).
    let call = 0;
    spawnMock.mockImplementation(() => {
      call++;
      if (call === 1) {
        const prd = readPrdFromDisk();
        const next = prd.userStories.find((s) => !s.passes);
        if (next) {
          next.passes = true;
          writePrd(prd);
        }
      }
      // call >= 2: no PRD mutation → stall
      return { status: 0, pid: 1 };
    });

    runMode({
      mode: "ralph",
      task: "stall test",
      maxOuterIterations: 20, // Loose cap so stall bails us before max
      stallBailAfter: 2,
    });

    // Iteration 1: progress (completed: 0 → 1; prevCompleted was -1, no stall)
    // Iteration 2: no progress (completed stays 1; stallCount: 0 → 1, prevCompleted=1)
    // Iteration 3: no progress (stallCount: 1 → 2 == bailAfter, bail)
    expect(spawnMock).toHaveBeenCalledTimes(3);

    // PRD has 1/5 done.
    const finalPrd = readPrdFromDisk();
    const completed = finalPrd.userStories.filter((s) => s.passes).length;
    expect(completed).toBe(1);

    // State preserved at iteration 3, outerLoopOwned cleared.
    const post = readRalphState();
    expect(post).not.toBeNull();
    expect(post!.iteration).toBe(3);
    expect(post!.outerLoopOwned).toBe(false);
    expect(post!.active).toBe(true);
  });

  it("test 8 (v1.7 M2): iteration 2+ spawn args include continuation context", () => {
    writePrd(makePrd(3, false));
    // Mock spawn: complete one story per call so loop iterates ≥ 2 times.
    spawnMock.mockImplementation(() => {
      const prd = readPrdFromDisk();
      const next = prd.userStories.find((s) => !s.passes);
      if (next) {
        next.passes = true;
        writePrd(prd);
      }
      return { status: 0, pid: 1 };
    });

    runMode({ mode: "ralph", task: "M2 continuation test" });

    // First call's prompt is the raw task; subsequent calls must have
    // the continuation wrapper.
    expect(spawnMock.mock.calls.length).toBeGreaterThanOrEqual(2);

    const firstCallArgs = spawnMock.mock.calls[0][1] as string[];
    const firstP = firstCallArgs.indexOf("-p");
    const firstPrompt = firstCallArgs[firstP + 1] as string;
    expect(firstPrompt).not.toContain("<ralph-continuation");

    const secondCallArgs = spawnMock.mock.calls[1][1] as string[];
    const secondP = secondCallArgs.indexOf("-p");
    const secondPrompt = secondCallArgs[secondP + 1] as string;
    expect(secondPrompt).toContain('<ralph-continuation iteration="2">');
    expect(secondPrompt).toContain("</ralph-continuation>");
    // The original task slash command should still be present after the
    // continuation wrapper.
    expect(secondPrompt).toContain("/oh-my-copilot:ralph");
  });

  it("test 7 (v1.7 M1): stallBailAfter clamp — pass 0 falls back to 1", () => {
    writePrd(makePrd(3, false));
    let call = 0;
    spawnMock.mockImplementation(() => {
      call++;
      if (call === 1) {
        const prd = readPrdFromDisk();
        const next = prd.userStories.find((s) => !s.passes);
        if (next) {
          next.passes = true;
          writePrd(prd);
        }
      }
      return { status: 0, pid: 1 };
    });

    runMode({
      mode: "ralph",
      task: "stall clamp",
      maxOuterIterations: 10,
      stallBailAfter: 0, // Should clamp to 1
    });

    // Iter 1: progress (no stall). Iter 2: no progress (stallCount=1, bail
    // since stallBailAfter clamped to 1). So 2 spawns total.
    expect(spawnMock).toHaveBeenCalledTimes(2);
  });
});
