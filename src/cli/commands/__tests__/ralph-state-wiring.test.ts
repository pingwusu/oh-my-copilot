import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { runMode } from "../mode.js";
import { clearWorktreeCache } from "../../../lib/worktree-paths.js";

// Mock spawnSync so we never actually call copilot.
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    spawnSync: vi.fn(() => ({
      status: 0,
      pid: 1,
      output: [],
      stdout: null,
      stderr: null,
      signal: null,
      error: undefined,
    })),
  };
});

// Suppress notifications in test env.
vi.mock("../../../notifications/config-loader.js", () => ({
  loadConfig: () => ({ notifications: false, customIntegrations: false }),
}));
vi.mock("../../../notifications/dispatcher.js", () => ({
  dispatch: vi.fn(),
}));

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), "omcp-ralph-wiring-"));
}

function stateFile(cwd: string): string {
  return join(cwd, ".omcp", "state", "ralph-state.json");
}

function readState(cwd: string): Record<string, unknown> {
  return JSON.parse(readFileSync(stateFile(cwd), "utf8")) as Record<string, unknown>;
}

type SpawnMock = ReturnType<typeof vi.fn>;

describe("ralph state-machine wiring in runMode", () => {
  let cwd: string;
  let origCwd: string;

  beforeEach(() => {
    clearWorktreeCache();
    cwd = makeTmpDir();
    origCwd = process.cwd();
    process.chdir(cwd);
  });

  afterEach(() => {
    process.chdir(origCwd);
    clearWorktreeCache();
    rmSync(cwd, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  it("writes ralph-state before copilot spawn", async () => {
    const { spawnSync } = await import("node:child_process");
    let stateAtSpawn: Record<string, unknown> | null = null;
    (spawnSync as SpawnMock).mockImplementationOnce(() => {
      if (existsSync(stateFile(cwd))) {
        stateAtSpawn = readState(cwd);
      }
      return { status: 0, pid: 1, output: [], stdout: null, stderr: null, signal: null, error: undefined };
    });

    runMode({ mode: "ralph", task: "build the thing" });

    expect(stateAtSpawn).not.toBeNull();
    expect((stateAtSpawn as Record<string, unknown>).active).toBe(true);
    expect((stateAtSpawn as Record<string, unknown>).iteration).toBe(1);
    expect((stateAtSpawn as Record<string, unknown>).prompt).toBe("build the thing");
  });

  it("clears ralph-state after copilot exits", () => {
    runMode({ mode: "ralph", task: "cleanup task" });
    expect(existsSync(stateFile(cwd))).toBe(false);
  });

  it("clears ralph-state even when copilot exits non-zero", async () => {
    const { spawnSync } = await import("node:child_process");
    (spawnSync as SpawnMock).mockImplementationOnce(() => ({
      status: 1, pid: 1, output: [], stdout: null, stderr: null, signal: null, error: undefined,
    }));

    runMode({ mode: "ralph", task: "failing task" });
    expect(existsSync(stateFile(cwd))).toBe(false);
  });

  it("initial iteration is always 1 regardless of pre-existing stale state", async () => {
    const stateDir = join(cwd, ".omcp", "state");
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(join(stateDir, "ralph-state.json"), JSON.stringify({
      active: true, iteration: 99, lastFiredAt: "2026-01-01T00:00:00.000Z", prompt: "old",
    }));

    const { spawnSync } = await import("node:child_process");
    let iterationAtSpawn = -1;
    (spawnSync as SpawnMock).mockImplementationOnce(() => {
      iterationAtSpawn = (readState(cwd).iteration as number);
      return { status: 0, pid: 1, output: [], stdout: null, stderr: null, signal: null, error: undefined };
    });

    runMode({ mode: "ralph", task: "fresh start" });
    expect(iterationAtSpawn).toBe(1);
  });

  it("stores prdPath in state when prdPath option is provided", async () => {
    const { spawnSync } = await import("node:child_process");
    let capturedPrdPath: unknown = undefined;
    (spawnSync as SpawnMock).mockImplementationOnce(() => {
      capturedPrdPath = readState(cwd).prdPath;
      return { status: 0, pid: 1, output: [], stdout: null, stderr: null, signal: null, error: undefined };
    });

    runMode({ mode: "ralph", task: "prd task", prdPath: "/some/prd.json" });

    expect(capturedPrdPath).toBe("/some/prd.json");
  });

  it("omits prdPath from state when not provided", async () => {
    const { spawnSync } = await import("node:child_process");
    let capturedState: Record<string, unknown> | null = null;
    (spawnSync as SpawnMock).mockImplementationOnce(() => {
      capturedState = readState(cwd);
      return { status: 0, pid: 1, output: [], stdout: null, stderr: null, signal: null, error: undefined };
    });

    runMode({ mode: "ralph", task: "no prd task" });

    expect(capturedState).not.toBeNull();
    expect("prdPath" in (capturedState as Record<string, unknown>)).toBe(false);
  });

  it("does NOT write ralph-state for non-ralph modes", () => {
    runMode({ mode: "autopilot", task: "some task" });
    expect(existsSync(stateFile(cwd))).toBe(false);
  });

  it("returns copilot exit code", async () => {
    const { spawnSync } = await import("node:child_process");
    (spawnSync as SpawnMock).mockImplementationOnce(() => ({
      status: 42, pid: 1, output: [], stdout: null, stderr: null, signal: null, error: undefined,
    }));

    const code = runMode({ mode: "ralph", task: "task" });
    expect(code).toBe(42);
  });

  it("e2e PRD lifecycle: state written with prdPath, incremented by lib, then cleared", async () => {
    const { incrementRalphIteration, readRalphState } = await import("../../../lib/ralph-state.js");
    const { spawnSync } = await import("node:child_process");

    const prdPath = join(cwd, ".omcp", "prd.json");
    mkdirSync(join(cwd, ".omcp"), { recursive: true });
    writeFileSync(prdPath, JSON.stringify({
      project: "test",
      branchName: "main",
      description: "d",
      userStories: [
        { id: "US-001", title: "T1", description: "d", acceptanceCriteria: [], priority: 1, passes: false },
      ],
    }));

    (spawnSync as SpawnMock).mockImplementationOnce(() => {
      incrementRalphIteration(cwd);
      return { status: 0, pid: 1, output: [], stdout: null, stderr: null, signal: null, error: undefined };
    });

    runMode({ mode: "ralph", task: "PRD task", prdPath });

    // After runMode: state is cleared.
    expect(readRalphState(cwd)).toBeNull();
  });

  it("iteration reaches 2 after one increment within the spawn", async () => {
    const { incrementRalphIteration } = await import("../../../lib/ralph-state.js");
    const { spawnSync } = await import("node:child_process");

    let iterAfterIncrement = -1;
    (spawnSync as SpawnMock).mockImplementationOnce(() => {
      const updated = incrementRalphIteration(cwd);
      iterAfterIncrement = updated?.iteration ?? -1;
      return { status: 0, pid: 1, output: [], stdout: null, stderr: null, signal: null, error: undefined };
    });

    runMode({ mode: "ralph", task: "loop task" });
    expect(iterAfterIncrement).toBe(2);
  });
});
