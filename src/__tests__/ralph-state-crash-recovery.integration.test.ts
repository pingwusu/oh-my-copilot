/**
 * Integration tests for conditional clearRalphState (Phase L3.3)
 *
 * Verifies that runMode("ralph") only clears ralph-state when the PRD is
 * complete OR architectApproved=true, and preserves state on non-zero exit
 * or incomplete PRD (crash/SIGINT/OOM recovery).
 *
 * NOTE: src/hooks/persistent-mode/index.ts has three CORRECT conditional
 * clearRalphState call sites (lines 122-123, 133, 143) that are intentionally
 * NOT modified. Only the previously-unconditional call in mode.ts:~181 is
 * the bug fixed here.
 *
 * Covered cases:
 *   1. exit 0 + allComplete=true  → ralph-state cleared
 *   2. exit 0 + allComplete=false → ralph-state preserved (resume-ready)
 *   3. non-zero exit              → ralph-state preserved
 *   4. exit 0 + architectApproved=true (no PRD) → ralph-state cleared
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
  readRalphState,
  writeRalphState,
  writePrd,
} from "../lib/ralph-state.js";
import type { PRD } from "../lib/ralph-state.js";
import * as resolveExecutable from "../runtime/resolve-executable.js";

// ── helpers ──────────────────────────────────────────────────────────────────

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), "omcp-ralph-crash-"));
}

function makePrd(allPasses: boolean): PRD {
  return {
    project: "crash-recovery-test",
    branchName: "main",
    description: "test PRD",
    userStories: [
      {
        id: "US-001",
        title: "Story 1",
        description: "desc",
        acceptanceCriteria: ["AC1"],
        priority: 1,
        passes: allPasses,
      },
    ],
  };
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
});

afterEach(() => {
  process.chdir(cwdSnapshot);
  rmSync(tmp, { recursive: true, force: true });
  vi.restoreAllMocks();
});

// ── tests ────────────────────────────────────────────────────────────────────

describe("ralph conditional clearRalphState — crash recovery (Phase L3.3)", () => {
  it("test 1: exit 0 + allComplete=true → ralph-state cleared", () => {
    // Seed: ralph active, PRD with all stories passing
    writeRalphState({
      active: true,
      iteration: 3,
      lastFiredAt: new Date().toISOString(),
      prompt: "implement stories",
    });
    writePrd(makePrd(true));
    spawnMock.mockReturnValue({ status: 0, pid: 1 });

    runMode({ mode: "ralph", task: "implement stories" });

    // State must be cleared — run is complete
    expect(readRalphState()).toBeNull();
  });

  it("test 2: exit 0 + allComplete=false → ralph-state preserved (resume-ready)", () => {
    // Note: runMode writes fresh ralph-state (iteration:1) before spawning
    // copilot. The PRD must be written AFTER runMode seeds the state so
    // getPrdCompletionStatus() can find it via the default .omcp/prd.json path.
    // We write the PRD before runMode; since ralph-state has no prdPath,
    // getPrdCompletionStatus falls back to .omcp/prd.json automatically.
    writePrd(makePrd(false)); // pending story
    spawnMock.mockReturnValue({ status: 0, pid: 1 });

    runMode({ mode: "ralph", task: "implement stories" });

    // State must be preserved — PRD not complete, resume-ready.
    // runMode wrote iteration:1 fresh; the key assertion is that state exists.
    const state = readRalphState();
    expect(state).not.toBeNull();
    expect(state?.active).toBe(true);
    expect(state?.iteration).toBe(1);
  });

  it("test 3: non-zero exit → ralph-state preserved", () => {
    // No PRD — simulates a crash/SIGINT during a plain ralph run.
    spawnMock.mockReturnValue({ status: 1, pid: 1 });

    runMode({ mode: "ralph", task: "implement stories" });

    // State must be preserved — non-zero exit = crash/abort.
    // runMode wrote iteration:1 fresh; the key assertion is that state exists.
    const state = readRalphState();
    expect(state).not.toBeNull();
    expect(state?.active).toBe(true);
    expect(state?.iteration).toBe(1);
  });

  it("test 4: exit 0 + architectApproved=true (no PRD) → ralph-state cleared", () => {
    // Seed: ralph active with architectApproved, no PRD file
    writeRalphState({
      active: true,
      iteration: 4,
      lastFiredAt: new Date().toISOString(),
      prompt: "implement stories",
      architectApproved: true,
    });
    // No PRD written — hasPrd=false, allComplete=false from getPrdCompletionStatus
    spawnMock.mockReturnValue({ status: 0, pid: 1 });

    runMode({ mode: "ralph", task: "implement stories" });

    // State must be cleared — architectApproved=true overrides missing PRD
    expect(readRalphState()).toBeNull();
  });
});
