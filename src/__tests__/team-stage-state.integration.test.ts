// Integration tests for Phase L2.5a — TeamPhase stage-state schema on TeamState.

import {
  existsSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  readModeState,
  writeModeState,
  type TeamState,
  type TeamPhase,
} from "../runtime/mode-state.js";

describe("TeamPhase type accepts all 6 omc values", () => {
  it("all 6 values are assignable to TeamPhase", () => {
    const phases: TeamPhase[] = [
      "initializing",
      "planning",
      "executing",
      "fixing",
      "completed",
      "failed",
    ];
    // Runtime check: all values are non-empty strings.
    for (const p of phases) {
      expect(typeof p).toBe("string");
      expect(p.length).toBeGreaterThan(0);
    }
    expect(phases).toHaveLength(6);
  });
});

describe("TeamState current_phase written on spawn (integration)", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "omcp-team-stage-"));
    vi.spyOn(process, "cwd").mockReturnValue(tmp);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(tmp, { recursive: true, force: true });
  });

  it("runTeam writes current_phase=executing to TeamState before returning", async () => {
    const { runTeam, parseTeamSpec } = await import("../cli/commands/team.js");
    const spec = parseTeamSpec("2:executor");
    const report = runTeam(spec, "test task");

    const state = readModeState<TeamState>("team", report.sessionId);
    expect(state).not.toBeNull();
    expect(state!.current_phase).toBe("executing");
  });

  it("TeamState stage_history includes initializing and executing after spawn", async () => {
    const { runTeam, parseTeamSpec } = await import("../cli/commands/team.js");
    const spec = parseTeamSpec("1");
    const report = runTeam(spec, "test task");

    const state = readModeState<TeamState>("team", report.sessionId);
    expect(state!.stage_history).toEqual(["initializing", "executing"]);
  });

  it("state is readable via readModeState after restart (persisted to disk)", async () => {
    const { runTeam, parseTeamSpec } = await import("../cli/commands/team.js");
    const spec = parseTeamSpec("3");
    const report = runTeam(spec, "persist test");
    const sessionId = report.sessionId;

    // Simulate "restart": re-read from disk (no in-memory cache).
    const state = readModeState<TeamState>("team", sessionId);
    expect(state).not.toBeNull();
    expect(state!.session_id).toBe(sessionId);
    expect(state!.active).toBe(true);
    expect(state!.spawned).toBe(3);
    expect(state!.current_phase).toBe("executing");
  });

  it("missing current_phase in v1.0.0 state file does not crash readModeState", () => {
    // Back-compat: a v1.0.0 TeamState written WITHOUT current_phase must load cleanly.
    const sessionId = "legacy-session-v100";
    const stateDir = join(tmp, ".omcp", "state", "sessions", sessionId);
    const { mkdirSync } = require("node:fs");
    mkdirSync(stateDir, { recursive: true });
    const stateFile = join(stateDir, "team-state.json");
    // Write a minimal v1.0.0-style state without current_phase or stage_history.
    writeFileSync(
      stateFile,
      JSON.stringify({
        active: true,
        session_id: sessionId,
        started_at: "2025-01-01T00:00:00.000Z",
        spawned: 2,
        done: 1,
        workers: [
          { id: "worker-1", status: "done" },
          { id: "worker-2", status: "running" },
        ],
      }),
      "utf8",
    );

    // Must not throw and must return the state without crashing.
    const state = readModeState<TeamState>("team", sessionId);
    expect(state).not.toBeNull();
    expect(state!.spawned).toBe(2);
    // Optional fields are absent — no crash.
    expect(state!.current_phase).toBeUndefined();
    expect(state!.stage_history).toBeUndefined();
  });
});

describe("writeModeState TeamState with current_phase round-trips", () => {
  let tmp: string;
  let cwdSnapshot: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "omcp-team-phase-rt-"));
    cwdSnapshot = process.cwd();
    process.chdir(tmp);
  });

  afterEach(() => {
    process.chdir(cwdSnapshot);
    rmSync(tmp, { recursive: true, force: true });
  });

  it("all 6 TeamPhase values survive a write/read round-trip", () => {
    const phases: TeamPhase[] = [
      "initializing",
      "planning",
      "executing",
      "fixing",
      "completed",
      "failed",
    ];
    for (const phase of phases) {
      const state: TeamState = {
        active: true,
        session_id: `s-${phase}`,
        started_at: "2026-01-01T00:00:00.000Z",
        spawned: 1,
        done: 0,
        workers: [{ id: "worker-1", status: "pending" }],
        current_phase: phase,
        stage_history: [phase],
      };
      writeModeState<TeamState>("team", state);
      const back = readModeState<TeamState>("team");
      expect(back!.current_phase).toBe(phase);
      expect(back!.stage_history).toEqual([phase]);
    }
  });
});
