/**
 * Integration tests for the ralplan --handoff flag (Phase L2.1)
 *
 * Tests the ralplan→boulder→ralph chain wired in runMode() at
 * src/cli/commands/mode.ts. We mock spawnSyncCrossPlatform so no real
 * copilot process is spawned.
 *
 * Covered cases:
 *   1. Handoff flag default OFF → registerRalplan called with
 *      handOffToRalph=false and planContent="" (current behavior preserved)
 *   2. Handoff flag ON, skill DID NOT populate boulder state before copilot
 *      exits → falls back to handOffToRalph=false silently
 *   3. Handoff flag ON, skill populated boulder state with activePlan pointing
 *      to a real file → planContent non-empty, handOffToRalph=true
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
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
import { writeBoulderState } from "../lib/boulder-state.js";
import { readBoulderState } from "../lib/boulder-state.js";
import * as ralplanModule from "../ralplan/index.js";
import * as resolveExecutable from "../runtime/resolve-executable.js";

// ── helpers ──────────────────────────────────────────────────────────────────

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), "omcp-ralplan-handoff-"));
}

// ── setup / teardown ─────────────────────────────────────────────────────────

let tmp: string;
let cwdSnapshot: string;
let registerSpy: MockInstance;
let spawnMock: MockInstance;

beforeEach(() => {
  tmp = makeTmpDir();
  mkdirSync(join(tmp, ".omcp", "state"), { recursive: true });
  mkdirSync(join(tmp, ".omcp", "plans"), { recursive: true });
  cwdSnapshot = process.cwd();
  process.chdir(tmp);

  registerSpy = vi.spyOn(ralplanModule, "registerRalplan");
  spawnMock = resolveExecutable.spawnSyncCrossPlatform as unknown as MockInstance;
  spawnMock.mockReturnValue({ status: 0, pid: 1 });
});

afterEach(() => {
  process.chdir(cwdSnapshot);
  rmSync(tmp, { recursive: true, force: true });
  vi.restoreAllMocks();
});

// ── tests ────────────────────────────────────────────────────────────────────

describe("ralplan --handoff flag", () => {
  it("test 1: handoff flag OFF (default) — registerRalplan called with handOffToRalph=false and planContent=''", () => {
    runMode({ mode: "ralplan", task: "build feature X" });

    expect(registerSpy).toHaveBeenCalledTimes(1);
    const call = registerSpy.mock.calls[0]![0];
    expect(call.handOffToRalph).toBe(false);
    expect(call.planContent).toBe("");
    expect(call.task).toBe("build feature X");
  });

  it("test 2: handoff flag ON, skill did NOT populate boulder state — falls back to handOffToRalph=false silently", () => {
    // No boulder state written — simulates skill not running or not writing state
    spawnMock.mockReturnValue({ status: 0, pid: 1 });

    runMode({ mode: "ralplan", task: "build feature Y", handoff: true });

    expect(registerSpy).toHaveBeenCalledTimes(1);
    const call = registerSpy.mock.calls[0]![0];
    expect(call.handOffToRalph).toBe(false);
    expect(call.planContent).toBe("");
  });

  it("test 3: handoff flag ON, skill populated boulder state with activePlan — planContent non-empty, handOffToRalph=true", () => {
    // Write a real plan file
    const planPath = join(tmp, ".omcp", "plans", "build-feature-z.md");
    writeFileSync(planPath, "# Plan\n- [ ] step 1\n- [ ] step 2\n");

    // Write boulder state pointing at it (simulates what the ralplan skill does)
    writeBoulderState({
      activePlan: planPath,
      startedAt: new Date().toISOString(),
      sessionIds: ["test-session"],
      planName: "build-feature-z",
      active: true,
      updatedAt: new Date().toISOString(),
    });

    spawnMock.mockReturnValue({ status: 0, pid: 1 });

    runMode({ mode: "ralplan", task: "build feature Z", handoff: true });

    expect(registerSpy).toHaveBeenCalledTimes(1);
    const call = registerSpy.mock.calls[0]![0];
    expect(call.handOffToRalph).toBe(true);
    expect(call.planContent).toContain("step 1");
    expect(call.planContent).toContain("step 2");
  });

  it("test 4: handoff flag ON, copilot exited non-zero — no handoff even if boulder state exists", () => {
    // Write boulder state and plan file
    const planPath = join(tmp, ".omcp", "plans", "build-feature-w.md");
    writeFileSync(planPath, "# Plan\n- [ ] step 1\n");
    writeBoulderState({
      activePlan: planPath,
      startedAt: new Date().toISOString(),
      sessionIds: ["test-session"],
      planName: "build-feature-w",
      active: true,
      updatedAt: new Date().toISOString(),
    });

    // Simulate non-zero exit
    spawnMock.mockReturnValue({ status: 1, pid: 1 });

    runMode({ mode: "ralplan", task: "build feature W", handoff: true });

    expect(registerSpy).toHaveBeenCalledTimes(1);
    const call = registerSpy.mock.calls[0]![0];
    // Non-zero exit → handoff must NOT fire
    expect(call.handOffToRalph).toBe(false);
    expect(call.planContent).toBe("");
  });
});
