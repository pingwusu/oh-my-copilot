/**
 * Deterministic args test: looping modes must pass --autopilot AND --yolo.
 *
 * Per Copilot's official autopilot doc (https://docs.github.com/en/copilot/
 * concepts/agents/copilot-cli/autopilot), the canonical programmatic
 * invocation is:
 *
 *     copilot --autopilot --yolo --max-autopilot-continues 10 -p "..."
 *
 * --yolo is a permission-bundle shortcut (--allow-all-tools --allow-all-paths
 * --allow-all-urls) needed to suppress mid-loop permission prompts that would
 * otherwise stall non-interactive runs. It is documented to have NO effect on
 * hook dispatch — but is required for unattended loops to not block.
 *
 * Before v1.4 this test FAILS — mode.ts pushed only --autopilot. After the
 * v1.4 fix it passes for all LOOPING_MODES and stays absent for ONE_SHOT_MODES.
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
import * as resolveExecutable from "../runtime/resolve-executable.js";

// ── helpers ──────────────────────────────────────────────────────────────────

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), "omcp-runmode-yolo-"));
}

function getCapturedArgs(spawnMock: MockInstance): string[] {
  expect(spawnMock.mock.calls.length).toBeGreaterThan(0);
  // spawnSyncCrossPlatform(cmd, args, opts)
  return spawnMock.mock.calls[0][1] as string[];
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

describe("runMode args — looping modes must include --autopilot AND --yolo (canonical Copilot invocation)", () => {
  it("ralph mode pushes both --autopilot and --yolo", () => {
    runMode({ mode: "ralph", task: "test" });
    const args = getCapturedArgs(spawnMock);
    expect(args).toContain("--autopilot");
    expect(args).toContain("--yolo");
  });

  it("v1.7 US-07: looping mode (ralph) does NOT also push redundant --allow-all-tools (--yolo covers it)", () => {
    runMode({ mode: "ralph", task: "test" });
    const args = getCapturedArgs(spawnMock);
    expect(args).toContain("--yolo");
    expect(args).not.toContain("--allow-all-tools");
  });

  it("v1.7 US-07: one-shot mode (ask) still pushes --allow-all-tools (no --yolo for one-shots)", () => {
    runMode({ mode: "ask", task: "test" });
    const args = getCapturedArgs(spawnMock);
    expect(args).not.toContain("--yolo");
    expect(args).toContain("--allow-all-tools");
  });

  it("autopilot mode pushes both --autopilot and --yolo", () => {
    runMode({ mode: "autopilot", task: "test" });
    const args = getCapturedArgs(spawnMock);
    expect(args).toContain("--autopilot");
    expect(args).toContain("--yolo");
  });

  it("ultrawork mode pushes both --autopilot and --yolo", () => {
    runMode({ mode: "ultrawork", task: "test" });
    const args = getCapturedArgs(spawnMock);
    expect(args).toContain("--autopilot");
    expect(args).toContain("--yolo");
  });

  it("ultraqa mode pushes both --autopilot and --yolo", () => {
    runMode({ mode: "ultraqa", task: "test" });
    const args = getCapturedArgs(spawnMock);
    expect(args).toContain("--autopilot");
    expect(args).toContain("--yolo");
  });

  it("sciomc mode pushes both --autopilot and --yolo", () => {
    runMode({ mode: "sciomc", task: "test" });
    const args = getCapturedArgs(spawnMock);
    expect(args).toContain("--autopilot");
    expect(args).toContain("--yolo");
  });

  it("team mode pushes both --autopilot and --yolo", () => {
    runMode({ mode: "team", task: "test" });
    const args = getCapturedArgs(spawnMock);
    expect(args).toContain("--autopilot");
    expect(args).toContain("--yolo");
  });

  it("one-shot ask mode pushes neither --autopilot nor --yolo (yolo gated by looping branch)", () => {
    runMode({ mode: "ask", task: "test" });
    const args = getCapturedArgs(spawnMock);
    expect(args).not.toContain("--autopilot");
    expect(args).not.toContain("--yolo");
  });

  it("one-shot ralplan mode pushes neither --autopilot nor --yolo (planner runs interactively, hands off to ralph)", () => {
    runMode({ mode: "ralplan", task: "test" });
    const args = getCapturedArgs(spawnMock);
    expect(args).not.toContain("--autopilot");
    expect(args).not.toContain("--yolo");
  });
});
