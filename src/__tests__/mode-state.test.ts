import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  canStartMode,
  clearCancel,
  clearModeState,
  isCancelled,
  listActiveModes,
  readModeState,
  writeModeState,
  type RalphLoopState,
} from "../runtime/mode-state.js";

describe("mode-state", () => {
  let tmp: string;
  let cwdSnapshot: string;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "omcp-mode-"));
    cwdSnapshot = process.cwd();
    process.chdir(tmp);
  });
  afterEach(() => {
    process.chdir(cwdSnapshot);
    try {
      rmSync(tmp, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it("writes and reads ralph state", () => {
    const state: RalphLoopState = {
      active: true,
      session_id: "s1",
      started_at: new Date().toISOString(),
      iteration: 3,
      max_iterations: 10,
      prompt: "fix bug",
    };
    writeModeState<RalphLoopState>("ralph", state);
    const back = readModeState<RalphLoopState>("ralph");
    expect(back?.iteration).toBe(3);
    expect(back?.active).toBe(true);
  });

  it("returns null when mode state absent", () => {
    expect(readModeState("ralph")).toBeNull();
  });

  it("listActiveModes filters to active=true entries", () => {
    writeModeState("ralph", {
      active: true,
      session_id: "s1",
      started_at: "2026",
      iteration: 1,
      max_iterations: 10,
    } as RalphLoopState);
    writeModeState("autopilot", {
      active: false,
      session_id: "s1",
      started_at: "2026",
      phase: "execution",
      iteration: 0,
    } as never);
    expect(listActiveModes()).toEqual(["ralph"]);
  });

  it("canStartMode blocks mutually-exclusive conflict", () => {
    writeModeState("ralph", {
      active: true,
      session_id: "s1",
      started_at: "2026",
      iteration: 1,
      max_iterations: 10,
    } as RalphLoopState);
    expect(canStartMode("autopilot")).toEqual({ ok: false, conflict: "ralph" });
    expect(canStartMode("team")).toEqual({ ok: true });
  });

  it("clearModeState removes the file", () => {
    writeModeState("ralph", {
      active: true,
      session_id: "s1",
      started_at: "2026",
      iteration: 1,
      max_iterations: 10,
    } as RalphLoopState);
    clearModeState("ralph");
    expect(readModeState("ralph")).toBeNull();
  });

  it("isCancelled detects cancel marker", () => {
    expect(isCancelled()).toBe(false);
    clearCancel(); // no-op should not throw
  });
});
