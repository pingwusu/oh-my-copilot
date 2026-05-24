import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  canStartMode,
  clearModeState,
  readModeState,
  resolveSessionRoot,
  type RalphLoopState,
  writeModeState,
} from "../runtime/mode-state.js";

describe("mode-state session isolation", () => {
  let tmp: string;
  let cwdSnapshot: string;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "omcp-mode-sess-"));
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

  it("two sessions writing to ralph do not see each other's state", () => {
    const a: RalphLoopState = {
      active: true,
      session_id: "sess-A",
      started_at: "2026",
      iteration: 1,
      max_iterations: 10,
      prompt: "task-A",
    };
    const b: RalphLoopState = {
      active: true,
      session_id: "sess-B",
      started_at: "2026",
      iteration: 5,
      max_iterations: 20,
      prompt: "task-B",
    };
    writeModeState<RalphLoopState>("ralph", a, "sess-A");
    writeModeState<RalphLoopState>("ralph", b, "sess-B");

    const readA = readModeState<RalphLoopState>("ralph", "sess-A");
    const readB = readModeState<RalphLoopState>("ralph", "sess-B");
    expect(readA?.prompt).toBe("task-A");
    expect(readA?.iteration).toBe(1);
    expect(readB?.prompt).toBe("task-B");
    expect(readB?.iteration).toBe(5);

    // Clearing one session leaves the other intact.
    clearModeState("ralph", "sess-A");
    expect(readModeState<RalphLoopState>("ralph", "sess-A")).toBeNull();
    expect(readModeState<RalphLoopState>("ralph", "sess-B")?.prompt).toBe(
      "task-B",
    );
  });

  it("canStartMode is scoped per session", () => {
    writeModeState(
      "ralph",
      {
        active: true,
        session_id: "sess-A",
        started_at: "2026",
        iteration: 1,
        max_iterations: 10,
      } as RalphLoopState,
      "sess-A",
    );

    // Same session: autopilot conflicts with ralph.
    // L3.4: canStartMode now includes stale:boolean in the conflict response.
    // The state has started_at:"2026" which is >60 min old, so stale:true.
    expect(canStartMode("autopilot", "sess-A")).toEqual({
      ok: false,
      conflict: "ralph",
      stale: true,
    });
    // Different session: clear to start.
    expect(canStartMode("autopilot", "sess-B")).toEqual({ ok: true });
  });

  it("legacy single-dir layout still works when no sessionId is supplied", () => {
    // Default (no env, no explicit sessionId) maps to the legacy .omcp/state/
    // path so existing repos aren't broken.
    const state: RalphLoopState = {
      active: true,
      session_id: "legacy",
      started_at: "2026",
      iteration: 2,
      max_iterations: 5,
    };
    writeModeState<RalphLoopState>("ralph", state);
    expect(readModeState<RalphLoopState>("ralph")?.iteration).toBe(2);
    clearModeState("ralph");
    expect(readModeState<RalphLoopState>("ralph")).toBeNull();
  });

  it("resolveSessionRoot reads COPILOT_SESSION_ID / OMCP_SESSION_ID, defaults to 'default'", () => {
    expect(resolveSessionRoot({})).toBe("default");
    expect(resolveSessionRoot({ COPILOT_SESSION_ID: "abc" })).toBe("abc");
    expect(resolveSessionRoot({ OMCP_SESSION_ID: "xyz" })).toBe("xyz");
    // COPILOT_SESSION_ID wins over OMCP_SESSION_ID.
    expect(
      resolveSessionRoot({ COPILOT_SESSION_ID: "co", OMCP_SESSION_ID: "om" }),
    ).toBe("co");
  });
});
