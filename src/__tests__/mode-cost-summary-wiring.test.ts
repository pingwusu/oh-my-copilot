// Deterministic integration tests: mode.ts post-spawn cost-summary wiring
// (ADR-C1 Option C, US-1.8-US05-COST-GOVERNOR-OUTER-LOOP).
//
// Verifies that after runMode("ralph") completes, cost-summary state exists
// with the correct number of entries, iteration numbers, and mode name.

import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  vi,
  type MockInstance,
} from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
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
import { writePrd, readPrd, type PRD } from "../lib/ralph-state.js";
import { readCostSummary } from "../lib/cost-summary-state.js";
import * as resolveExecutable from "../runtime/resolve-executable.js";

// ── helpers ──────────────────────────────────────────────────────────────────

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), "omcp-cost-wiring-"));
}

function makePrd(storyCount: number, allPasses = false): PRD {
  return {
    project: "cost-wiring-test",
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

/**
 * After runMode completes, scan .omcp/state/ for a session subdirectory that
 * contains cost-summary.json. Returns the sessionId string or undefined.
 */
function findCostSummarySessionId(stateDir: string): string | undefined {
  if (!existsSync(stateDir)) return undefined;
  const entries = readdirSync(stateDir, { withFileTypes: true });
  const dirs = entries.filter((e) => e.isDirectory()).map((e) => e.name);
  return dirs.find((d) => existsSync(join(stateDir, d, "cost-summary.json")));
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

describe("mode.ts cost-summary wiring (ADR-C1 Option C)", () => {
  it("test 1: single-iteration ralph run writes one cost-summary entry", () => {
    // PRD already complete → runMode exits after 1 spawn.
    writePrd(makePrd(2, true));
    spawnMock.mockImplementation(() => ({ status: 0, pid: 1 }));

    runMode({ mode: "ralph", task: "wiring test 1" });

    // runMode spawns once (PRD already complete → break after first spawn).
    expect(spawnMock).toHaveBeenCalledTimes(1);

    const stateDir = join(tmp, ".omcp", "state");
    const sessionId = findCostSummarySessionId(stateDir);
    expect(sessionId).toBeDefined();

    const state = readCostSummary(sessionId!);
    expect(state).not.toBeNull();
    expect(state!.entries).toHaveLength(1);
    expect(state!.entries[0]!.iterationNumber).toBe(1);
    expect(state!.entries[0]!.modeName).toBe("ralph");
    expect(state!.entries[0]!.exitCode).toBe(0);
  });

  it("test 2: two-iteration ralph run writes two cost-summary entries with correct iteration numbers", () => {
    writePrd(makePrd(2, false));

    // Each spawn completes one story so the loop runs exactly 2 times.
    spawnMock.mockImplementation(() => {
      const prd = readPrd();
      if (prd) {
        const next = prd.userStories.find((s) => !s.passes);
        if (next) {
          next.passes = true;
          writePrd(prd);
        }
      }
      return { status: 0, pid: 1 };
    });

    runMode({ mode: "ralph", task: "wiring test 2" });

    expect(spawnMock).toHaveBeenCalledTimes(2);

    const stateDir = join(tmp, ".omcp", "state");
    const sessionId = findCostSummarySessionId(stateDir);
    expect(sessionId).toBeDefined();

    const state = readCostSummary(sessionId!);
    expect(state).not.toBeNull();
    expect(state!.entries).toHaveLength(2);
    expect(state!.entries[0]!.iterationNumber).toBe(1);
    expect(state!.entries[1]!.iterationNumber).toBe(2);
    expect(state!.entries[0]!.modeName).toBe("ralph");
    expect(state!.entries[1]!.modeName).toBe("ralph");
    expect(state!.entries[0]!.exitCode).toBe(0);
    expect(state!.entries[1]!.exitCode).toBe(0);
  });

  it("test 3: non-zero exit writes cost entry with exitCode != 0", () => {
    writePrd(makePrd(3, false));
    spawnMock.mockImplementation(() => ({ status: 1, pid: 1 }));

    runMode({ mode: "ralph", task: "wiring test 3 crash" });

    expect(spawnMock).toHaveBeenCalledTimes(1);

    const stateDir = join(tmp, ".omcp", "state");
    const sessionId = findCostSummarySessionId(stateDir);
    expect(sessionId).toBeDefined();

    const state = readCostSummary(sessionId!);
    expect(state).not.toBeNull();
    expect(state!.entries).toHaveLength(1);
    expect(state!.entries[0]!.iterationNumber).toBe(1);
    expect(state!.entries[0]!.exitCode).toBe(1);
    expect(state!.entries[0]!.modeName).toBe("ralph");
  });
});
