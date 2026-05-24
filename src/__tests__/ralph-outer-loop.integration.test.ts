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
});
