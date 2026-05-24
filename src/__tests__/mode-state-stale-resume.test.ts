/**
 * Tests for stale mode-state auto-detection + --resume flag (Phase L3.4)
 *
 * Covers:
 *   1. canStartMode: state newer than 60min → stale: false (no stale flag)
 *   2. canStartMode: state older than 60min → stale: true
 *   3. runMode --resume with stale state → state cleared + ralph proceeds
 *   4. runMode --resume with NO stale state (fresh conflict) → fail loud (exit 2)
 *   5. runMode --resume with NO conflicting state at all → fail loud (exit 2)
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

import {
  canStartMode,
  writeModeState,
  clearModeState,
  type RalphLoopState,
} from "../runtime/mode-state.js";
import { runMode } from "../cli/commands/mode.js";
import { readRalphState, writeRalphState } from "../lib/ralph-state.js";
import * as resolveExecutable from "../runtime/resolve-executable.js";

// ── helpers ──────────────────────────────────────────────────────────────────

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), "omcp-stale-resume-"));
}

/** ISO timestamp that is `offsetMs` milliseconds in the past. */
function pastTimestamp(offsetMs: number): string {
  return new Date(Date.now() - offsetMs).toISOString();
}

const ONE_HOUR_MS = 3_600_000;
const JUST_OVER_ONE_HOUR_MS = ONE_HOUR_MS + 5_000; // 60min + 5s
const JUST_UNDER_ONE_HOUR_MS = ONE_HOUR_MS - 5_000; // 60min - 5s

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
  spawnMock.mockReturnValue({ status: 0, pid: 1 });
  // Ensure env override is cleared between tests
  delete process.env["OMCP_MODE_STATE_STALE_MS"];
});

afterEach(() => {
  process.chdir(cwdSnapshot);
  rmSync(tmp, { recursive: true, force: true });
  vi.clearAllMocks();
  delete process.env["OMCP_MODE_STATE_STALE_MS"];
});

// ── tests ────────────────────────────────────────────────────────────────────

describe("canStartMode stale detection (Phase L3.4)", () => {
  it("test 1: state newer than 60min → canStartMode returns stale: false (or absent)", () => {
    // Write a fresh (recent) ralph mode-state
    writeModeState<RalphLoopState>("ralph", {
      active: true,
      session_id: "s1",
      started_at: pastTimestamp(JUST_UNDER_ONE_HOUR_MS), // 59min 55s ago
      iteration: 1,
      max_iterations: 10,
    });

    const result = canStartMode("autopilot");
    expect(result.ok).toBe(false);
    expect(result.conflict).toBe("ralph");
    // stale should be false/undefined — state is within the threshold
    expect(result.stale).toBeFalsy();

    clearModeState("ralph");
  });

  it("test 2: state older than 60min → canStartMode returns stale: true", () => {
    // Write a stale (old) ralph mode-state
    writeModeState<RalphLoopState>("ralph", {
      active: true,
      session_id: "s1",
      started_at: pastTimestamp(JUST_OVER_ONE_HOUR_MS), // 60min + 5s ago
      iteration: 1,
      max_iterations: 10,
    });

    const result = canStartMode("autopilot");
    expect(result.ok).toBe(false);
    expect(result.conflict).toBe("ralph");
    expect(result.stale).toBe(true);

    clearModeState("ralph");
  });

  it("test 2b: OMCP_MODE_STATE_STALE_MS env var overrides the 60min default", () => {
    // Set threshold to 10 seconds
    process.env["OMCP_MODE_STATE_STALE_MS"] = "10000";

    // State is 30 seconds old — stale under 10s threshold
    writeModeState<RalphLoopState>("ralph", {
      active: true,
      session_id: "s1",
      started_at: pastTimestamp(30_000), // 30 seconds ago
      iteration: 1,
      max_iterations: 10,
    });

    const result = canStartMode("autopilot");
    expect(result.stale).toBe(true);

    clearModeState("ralph");
  });
});

describe("runMode --resume flag (Phase L3.4)", () => {
  it("test 3: --resume with stale ralph state → state cleared + new ralph run proceeds", () => {
    // Seed: stale ralph mode-state (older than default 60min)
    // Use env override for speed: set threshold to 1s, seed state 2s old
    process.env["OMCP_MODE_STATE_STALE_MS"] = "1000";

    writeModeState<RalphLoopState>("ralph", {
      active: true,
      session_id: "old-session",
      started_at: pastTimestamp(2_000), // 2 seconds ago, stale under 1s threshold
      iteration: 5,
      max_iterations: 10,
    });

    spawnMock.mockReturnValue({ status: 0, pid: 1 });

    // runMode with --resume should clear the stale state and start fresh
    const code = runMode({ mode: "ralph", task: "do work", resume: true });

    // Should succeed (0 = ran copilot, then conditional preserved state since no PRD)
    // The key assertion is that it didn't return 2 (conflict error)
    expect(code).not.toBe(2);
    // spawnMock should have been called (copilot was invoked)
    expect(spawnMock).toHaveBeenCalled();
  });

  it("test 4: --resume with non-stale (fresh) conflict → fail loud with exit 2", () => {
    // Seed: fresh ralph state (NOT stale)
    process.env["OMCP_MODE_STATE_STALE_MS"] = "3600000"; // 60min

    writeModeState<RalphLoopState>("ralph", {
      active: true,
      session_id: "active-session",
      started_at: new Date().toISOString(), // just started — not stale
      iteration: 1,
      max_iterations: 10,
    });

    // Try to start autopilot with --resume while ralph is actively running
    const code = runMode({ mode: "autopilot", task: "do work", resume: true });

    // Must fail loud — live session, not stale
    expect(code).toBe(2);
    // spawnMock must NOT have been called
    expect(spawnMock).not.toHaveBeenCalled();

    clearModeState("ralph");
  });

  it("test 5: --resume with NO conflicting state → fail loud with exit 2", () => {
    // No mode-state at all — nothing to resume from
    // (ralph is not mutually exclusive with itself, so use autopilot)
    spawnMock.mockReturnValue({ status: 0, pid: 1 });

    const code = runMode({ mode: "ralph", task: "do work", resume: true });

    // Should fail: no stale state to clear
    expect(code).toBe(2);
    expect(spawnMock).not.toHaveBeenCalled();
  });
});
