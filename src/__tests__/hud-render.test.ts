import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { renderHud } from "../hud/render.js";
import { loadHudState, readEstimatedCostTotal, readModeIter, readPrdProgress } from "../hud/state.js";
import { resetGitCache } from "../hud/elements/git.js";
import { DEFAULT_THRESHOLDS, type HudState } from "../hud/types.js";

function baseState(overrides: Partial<HudState> = {}): HudState {
  // Use a fresh tmp dir so renderGit (which calls execSync) sees no repo
  // and returns null. This keeps "no state" assertions deterministic.
  const cleanCwd = mkdtempSync(join(tmpdir(), "omcp-hud-base-"));
  return {
    cwd: cleanCwd,
    env: {
      OMCP_HOME: "/no-such-dir",
      OMCP_PLUGIN_ROOT: "/no-such-plugin",
      OMCP_MODEL_FAMILY: "",
      // colors off by default for deterministic substring matching
    },
    modelFamily: "claude",
    modelName: null,
    activeModes: [],
    ralph: null,
    autopilot: null,
    team: null,
    todos: [],
    contextPercent: null,
    tokens: null,
    sessionTotalTokens: null,
    priorityNote: null,
    thresholds: DEFAULT_THRESHOLDS,
    modeIter: null,
    prd: null,
    estimatedCostTotal: 0,
    ...overrides,
  };
}

describe("renderHud — element composition", () => {
  beforeEach(() => {
    resetGitCache();
  });

  it("emits leading legacy columns (omcp · family · modes …) with no state", () => {
    const line = renderHud(baseState());
    const parts = line.split(" · ");
    // Legacy contract: at least 6 leading columns are always present.
    expect(parts.length).toBeGreaterThanOrEqual(6);
    expect(parts[0]).toBe("omcp");
    expect(parts[1]).toBe("claude");
    // Legacy slots collapse to "-" when their data source is empty (DD3 fix).
    expect(parts[2]).toBe("-"); // no active modes
    expect(parts[3]).toBe("-"); // no ralph iter/max
    expect(parts[4]).toBe("-"); // no team done/spawned
    expect(parts[5]).toBe("-"); // no priority note
  });

  it("renders ralph element when state is active", () => {
    const state = baseState({
      ralph: { active: true, iteration: 3, maxIterations: 10 },
    });
    const line = renderHud(state);
    // legacy column "3/10" plus rich "ralph:3/10"
    expect(line).toContain("3/10");
    expect(line).toContain("ralph:");
  });

  it("renders autopilot phase", () => {
    const state = baseState({
      autopilot: {
        active: true,
        phase: "planning",
        iteration: 1,
        maxIterations: 5,
      },
    });
    const line = renderHud(state);
    expect(line).toContain("[AUTOPILOT]");
    expect(line).toContain("Phase");
    expect(line).toContain("Plan");
  });

  it("renders todos progress with working hint", () => {
    const state = baseState({
      todos: [
        { content: "task a", status: "completed" },
        {
          content: "task b",
          status: "in_progress",
          activeForm: "Doing task B",
        },
        { content: "task c", status: "pending" },
      ],
    });
    const line = renderHud(state);
    expect(line).toContain("todos:1/3");
    expect(line).toContain("working:");
    expect(line).toContain("Doing task B");
  });

  it("renders model name from modelName when present", () => {
    const state = baseState({ modelName: "claude-opus-4-7-20260101" });
    const line = renderHud(state);
    expect(line).toContain("Opus 4.7");
  });

  it("renders context percent with severity suffix", () => {
    const state = baseState({ contextPercent: 95 });
    const line = renderHud(state);
    expect(line).toContain("ctx:");
    expect(line).toContain("95%");
    expect(line).toContain("CRITICAL");
  });

  it("renders token usage compactly", () => {
    const state = baseState({
      tokens: { inputTokens: 1500, outputTokens: 800, reasoningTokens: 300 },
      sessionTotalTokens: 12500,
    });
    const line = renderHud(state);
    expect(line).toContain("tok:i");
    expect(line).toContain("/o");
    // 1500 -> 1.5k, 800 -> 800, 12500 -> 13k
    expect(line).toContain("1.5k");
    expect(line).toContain("800");
  });

  it("includes priority note as the 6th legacy column", () => {
    const state = baseState({ priorityNote: "Ship the HUD port today" });
    const line = renderHud(state);
    const parts = line.split(" · ");
    expect(parts[5]).toBe("Ship the HUD port today");
  });

  it("truncates long priority notes to 60 chars (incl. ellipsis)", () => {
    const state = baseState({ priorityNote: "x".repeat(120) });
    const line = renderHud(state);
    const parts = line.split(" · ");
    // notepad-priority element renders up to 60 chars including trailing ellipsis
    expect(parts[5].length).toBeLessThanOrEqual(60);
    expect(parts[5].endsWith("…")).toBe(true);
  });
});

describe("loadHudState — reads from .omcp/state", () => {
  let cwd: string;
  beforeEach(() => {
    resetGitCache();
    cwd = mkdtempSync(join(tmpdir(), "omcp-hud-state-"));
  });

  it("reads ralph-state.json (new schema)", () => {
    const dir = join(cwd, ".omcp", "state");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "ralph-state.json"),
      JSON.stringify({
        active: true,
        session_id: "s1",
        started_at: "2026",
        iteration: 4,
        max_iterations: 12,
      }),
      "utf8",
    );
    const state = loadHudState(cwd, {
      OMCP_HOME: "/no-such-dir",
      OMCP_MODEL_FAMILY: "",
    });
    expect(state.ralph?.iteration).toBe(4);
    expect(state.ralph?.maxIterations).toBe(12);
    expect(state.activeModes).toContain("ralph");
  });

  it("reads autopilot-state.json", () => {
    const dir = join(cwd, ".omcp", "state");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "autopilot-state.json"),
      JSON.stringify({
        active: true,
        session_id: "s1",
        started_at: "2026",
        phase: "execution",
        iteration: 2,
        max_iterations: 5,
      }),
      "utf8",
    );
    const state = loadHudState(cwd, {
      OMCP_HOME: "/no-such-dir",
      OMCP_MODEL_FAMILY: "",
    });
    expect(state.autopilot?.active).toBe(true);
    expect(state.autopilot?.phase).toBe("execution");
    expect(state.autopilot?.iteration).toBe(2);
  });

  it("reads legacy mode.json + ralph.json + team.json", () => {
    const dir = join(cwd, ".omcp", "state");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "mode.json"),
      JSON.stringify({ modes: ["ralph", "autopilot"] }),
      "utf8",
    );
    writeFileSync(
      join(dir, "ralph.json"),
      JSON.stringify({ iter: 5, max: 10 }),
      "utf8",
    );
    writeFileSync(
      join(dir, "team.json"),
      JSON.stringify({ agentsDone: 2, spawned: 6 }),
      "utf8",
    );
    const state = loadHudState(cwd, {
      OMCP_HOME: "/no-such-dir",
      OMCP_MODEL_FAMILY: "",
    });
    expect(state.activeModes).toEqual(["ralph", "autopilot"]);
    expect(state.ralph?.iteration).toBe(5);
    expect(state.team?.done).toBe(2);
    expect(state.team?.spawned).toBe(6);
  });

  it("degrades gracefully on malformed JSON", () => {
    const dir = join(cwd, ".omcp", "state");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "ralph-state.json"), "{not json", "utf8");
    writeFileSync(join(dir, "autopilot-state.json"), "{not json", "utf8");
    const state = loadHudState(cwd, {
      OMCP_HOME: "/no-such-dir",
      OMCP_MODEL_FAMILY: "",
    });
    expect(state.ralph).toBeNull();
    expect(state.autopilot).toBeNull();
    // composing should not throw
    expect(() => renderHud(state)).not.toThrow();
  });

  it("reads priority note from .omcp/notepad.md", () => {
    mkdirSync(join(cwd, ".omcp"), { recursive: true });
    writeFileSync(
      join(cwd, ".omcp", "notepad.md"),
      "\n\n# Hello world note\nignored line",
      "utf8",
    );
    const state = loadHudState(cwd, {
      OMCP_HOME: "/no-such-dir",
      OMCP_MODEL_FAMILY: "",
    });
    expect(state.priorityNote).toBe("Hello world note");
  });
});

describe("renderHud — columns 3-5 wiring (v1.3)", () => {
  let cwd: string;
  beforeEach(() => {
    resetGitCache();
    cwd = mkdtempSync(join(tmpdir(), "omcp-hud-col-"));
  });

  const env = { OMCP_HOME: "/no-such-dir", OMCP_MODEL_FAMILY: "" };

  function stateDir(base: string) {
    return join(base, ".omcp", "state");
  }

  // Test 1: no state files → columns 3-5 all show "-"
  it("no state files → columns 3,4,5 show dash (regression)", () => {
    const state = loadHudState(cwd, env);
    const line = renderHud(state);
    const parts = line.split(" · ");
    expect(parts.length).toBeGreaterThanOrEqual(6);
    expect(parts[2]).toBe("-"); // modes
    expect(parts[3]).toBe("-"); // ralph
    expect(parts[4]).toBe("-"); // team
  });

  // Test 2: ralph-state.json active=true → column 4 shows iter count
  it("ralph-state active=true → column 4 shows iter/max", () => {
    const dir = stateDir(cwd);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "ralph-state.json"),
      JSON.stringify({ active: true, iteration: 3, max_iterations: 8 }),
      "utf8",
    );
    const state = loadHudState(cwd, env);
    const line = renderHud(state);
    const parts = line.split(" · ");
    expect(parts[3]).toBe("3/8");
  });

  // Test 3: ralph-state active=false (and iteration=0) → column 4 shows dash.
  // The state loader treats iter>0 as active for backward compat; a stopped
  // ralph session resets iteration to 0 before writing active:false.
  it("ralph-state active=false, iteration=0 → column 4 shows dash", () => {
    const dir = stateDir(cwd);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "ralph-state.json"),
      JSON.stringify({ active: false, iteration: 0, max_iterations: 5 }),
      "utf8",
    );
    const state = loadHudState(cwd, env);
    const line = renderHud(state);
    const parts = line.split(" · ");
    expect(parts[3]).toBe("-");
  });

  // Test 4: ralph-state.json present → column 3 shows "ralph" mode
  it("ralph-state active=true → column 3 shows ralph in modes", () => {
    const dir = stateDir(cwd);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "ralph-state.json"),
      JSON.stringify({ active: true, iteration: 1, max_iterations: 10 }),
      "utf8",
    );
    const state = loadHudState(cwd, env);
    const line = renderHud(state);
    const parts = line.split(" · ");
    expect(parts[2]).toBe("ralph");
  });

  // Test 5: ralph-state.json + team-state.json both active → column 3 shows comma-joined
  it("ralph + team both active → column 3 shows comma-joined modes", () => {
    const dir = stateDir(cwd);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "ralph-state.json"),
      JSON.stringify({ active: true, iteration: 1, max_iterations: 5 }),
      "utf8",
    );
    writeFileSync(
      join(dir, "team-state.json"),
      JSON.stringify({ active: true, spawned: 4, done: 1 }),
      "utf8",
    );
    const state = loadHudState(cwd, env);
    const line = renderHud(state);
    const parts = line.split(" · ");
    expect(parts[2]).toContain("ralph");
    expect(parts[2]).toContain("team");
    expect(parts[2]).toContain(",");
  });

  // Test 6: team-state.json with spawned=2, done=1 → column 5 shows "1/2"
  it("team-state with done=1 spawned=2 → column 5 shows 1/2", () => {
    const dir = stateDir(cwd);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "team-state.json"),
      JSON.stringify({ active: true, spawned: 2, done: 1 }),
      "utf8",
    );
    const state = loadHudState(cwd, env);
    const line = renderHud(state);
    const parts = line.split(" · ");
    expect(parts[4]).toBe("1/2");
  });

  // Test 7: partial state (only ralph active) → team and note columns stay "-"
  it("only ralph active → team and note columns remain dash", () => {
    const dir = stateDir(cwd);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "ralph-state.json"),
      JSON.stringify({ active: true, iteration: 2, max_iterations: 6 }),
      "utf8",
    );
    const state = loadHudState(cwd, env);
    const line = renderHud(state);
    const parts = line.split(" · ");
    expect(parts[4]).toBe("-"); // team still dash
    expect(parts[5]).toBe("-"); // note still dash
  });

  // Test 8: extended mode candidates (plan, ccg, learner) are detected
  it("plan-state.json active=true → column 3 shows plan", () => {
    const dir = stateDir(cwd);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "plan-state.json"),
      JSON.stringify({ active: true }),
      "utf8",
    );
    const state = loadHudState(cwd, env);
    expect(state.activeModes).toContain("plan");
    const line = renderHud(state);
    const parts = line.split(" · ");
    expect(parts[2]).toBe("plan");
  });
});

// ──────────────────────────────────────────────────────────────────────────
// US-1.9-T1-HUD-column-1: mode + iteration
// ──────────────────────────────────────────────────────────────────────────
describe("HUD column 1 — mode + iteration (v1.9)", () => {
  let cwd: string;
  beforeEach(() => {
    resetGitCache();
    cwd = mkdtempSync(join(tmpdir(), "omcp-hud-col1-"));
  });

  it("renderModeIter returns null when no looping mode is active", () => {
    const result = readModeIter(cwd);
    expect(result).toBeNull();
  });

  it("readModeIter returns ralph when ralph-state.json active=true", () => {
    const dir = join(cwd, ".omcp", "state");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "ralph-state.json"),
      JSON.stringify({ active: true, iteration: 3, max_iterations: 10 }),
      "utf8",
    );
    const mi = readModeIter(cwd);
    expect(mi).not.toBeNull();
    expect(mi!.modeName).toBe("ralph");
    expect(mi!.iteration).toBe(3);
    expect(mi!.maxIterations).toBe(10);
  });

  it("readModeIter returns autopilot when only autopilot active", () => {
    const dir = join(cwd, ".omcp", "state");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "autopilot-state.json"),
      JSON.stringify({ active: true, iteration: 2, max_iterations: 5 }),
      "utf8",
    );
    const mi = readModeIter(cwd);
    expect(mi).not.toBeNull();
    expect(mi!.modeName).toBe("autopilot");
    expect(mi!.iteration).toBe(2);
  });

  it("renderHud emits [mode:ralph iter:3/10] in rich tail", () => {
    const state = baseState({
      modeIter: { modeName: "ralph", iteration: 3, maxIterations: 10 },
    });
    const line = renderHud(state);
    expect(line).toContain("[mode:ralph iter:3/10]");
  });

  it("renderHud omits mode-iter segment when modeIter is null", () => {
    const state = baseState({ modeIter: null });
    const line = renderHud(state);
    expect(line).not.toContain("[mode:");
  });
});

// ──────────────────────────────────────────────────────────────────────────
// US-1.9-T1-HUD-column-2: PRD progress
// ──────────────────────────────────────────────────────────────────────────
describe("HUD column 2 — PRD progress (v1.9)", () => {
  let cwd: string;
  beforeEach(() => {
    resetGitCache();
    cwd = mkdtempSync(join(tmpdir(), "omcp-hud-col2-"));
  });

  it("readPrdProgress returns null when no prd.json present", () => {
    expect(readPrdProgress(cwd)).toBeNull();
  });

  it("readPrdProgress counts completed vs total (passes field)", () => {
    mkdirSync(join(cwd, ".omcp"), { recursive: true });
    writeFileSync(
      join(cwd, ".omcp", "prd.json"),
      JSON.stringify({
        userStories: [
          { id: "US-1", passes: true },
          { id: "US-2", passes: false },
          { id: "US-3", passes: false },
        ],
      }),
      "utf8",
    );
    const prd = readPrdProgress(cwd);
    expect(prd).toEqual({ completed: 1, total: 3 });
  });

  it("readPrdProgress counts completed via status field", () => {
    mkdirSync(join(cwd, ".omcp"), { recursive: true });
    writeFileSync(
      join(cwd, ".omcp", "prd.json"),
      JSON.stringify({
        userStories: [
          { id: "US-1", status: "completed" },
          { id: "US-2", status: "pending" },
        ],
      }),
      "utf8",
    );
    const prd = readPrdProgress(cwd);
    expect(prd).toEqual({ completed: 1, total: 2 });
  });

  it("renderHud emits [prd:1/3] when PRD has 1 of 3 complete", () => {
    const state = baseState({ prd: { completed: 1, total: 3 } });
    const line = renderHud(state);
    expect(line).toContain("[prd:1/3]");
  });

  it("renderHud omits prd segment when prd is null", () => {
    const state = baseState({ prd: null });
    const line = renderHud(state);
    expect(line).not.toContain("[prd:");
  });
});

// ──────────────────────────────────────────────────────────────────────────
// US-1.9-T1-HUD-column-6: cost/tokens estimate
// ──────────────────────────────────────────────────────────────────────────
describe("HUD column 6 — cost/tokens estimate (v1.9)", () => {
  let cwd: string;
  beforeEach(() => {
    resetGitCache();
    cwd = mkdtempSync(join(tmpdir(), "omcp-hud-col6-"));
  });

  it("readEstimatedCostTotal returns 0 when no state dir", () => {
    expect(readEstimatedCostTotal(cwd)).toBe(0);
  });

  it("readEstimatedCostTotal sums estimatedCost across entries", () => {
    const sessionDir = join(cwd, ".omcp", "state", "sess-abc123");
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(
      join(sessionDir, "cost-summary.json"),
      JSON.stringify({
        sessionId: "sess-abc123",
        entries: [
          { iterationNumber: 1, durationMs: 1000, exitCode: 0, estimatedCost: 0, modeName: "ralph", prdProgress: null, timestamp: "2026-01-01" },
          { iterationNumber: 2, durationMs: 2000, exitCode: 0, estimatedCost: 0, modeName: "ralph", prdProgress: null, timestamp: "2026-01-02" },
        ],
      }),
      "utf8",
    );
    expect(readEstimatedCostTotal(cwd)).toBe(0);
  });

  it("renderHud always emits [cost:0] segment", () => {
    const state = baseState({ estimatedCostTotal: 0 });
    const line = renderHud(state);
    expect(line).toContain("[cost:0]");
  });
});

// ──────────────────────────────────────────────────────────────────────────
// US-1.9-T1-HUD-multi-mode: multiple active modes
// ──────────────────────────────────────────────────────────────────────────
describe("HUD multi-mode active display (v1.9)", () => {
  beforeEach(() => {
    resetGitCache();
  });

  it("renders [modes:...] when 2+ modes active", () => {
    const state = baseState({ activeModes: ["ralph", "team"] });
    const line = renderHud(state);
    expect(line).toContain("[modes:ralph,team]");
  });

  it("does not render [modes:...] when only 1 mode active", () => {
    const state = baseState({ activeModes: ["ralph"] });
    const line = renderHud(state);
    expect(line).not.toContain("[modes:");
  });

  it("does not render [modes:...] when no modes active", () => {
    const state = baseState({ activeModes: [] });
    const line = renderHud(state);
    expect(line).not.toContain("[modes:");
  });
});

// ──────────────────────────────────────────────────────────────────────────
// US-1.9-T1-HUD-regression-cols-3-5: v1.3.0 cols still render after v1.9 wiring
// ──────────────────────────────────────────────────────────────────────────
describe("HUD regression — cols 3-5 still render after v1.9 cols 1+2+6 wire", () => {
  let cwd: string;
  beforeEach(() => {
    resetGitCache();
    cwd = mkdtempSync(join(tmpdir(), "omcp-hud-regr-"));
  });

  const env = { OMCP_HOME: "/no-such-dir", OMCP_MODEL_FAMILY: "" };

  function stateDir(base: string) {
    return join(base, ".omcp", "state");
  }

  it("all 6 legacy columns still present with full state (cols 3-5 regression)", () => {
    const dir = stateDir(cwd);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "ralph-state.json"),
      JSON.stringify({ active: true, iteration: 2, max_iterations: 5 }),
      "utf8",
    );
    writeFileSync(
      join(dir, "team-state.json"),
      JSON.stringify({ active: true, spawned: 3, done: 1 }),
      "utf8",
    );
    // Write a PRD and cost-summary to also exercise col 1/2/6 wiring together.
    mkdirSync(join(cwd, ".omcp"), { recursive: true });
    writeFileSync(
      join(cwd, ".omcp", "prd.json"),
      JSON.stringify({ userStories: [{ id: "US-1", passes: true }, { id: "US-2", passes: false }] }),
      "utf8",
    );
    const state = loadHudState(cwd, env);
    const line = renderHud(state);
    const parts = line.split(" · ");

    // Legacy contract: at least 6 columns.
    expect(parts.length).toBeGreaterThanOrEqual(6);
    expect(parts[0]).toBe("omcp");
    expect(parts[1]).toBe("claude");
    // col 3: modes (ralph + team comma-joined)
    expect(parts[2]).toContain("ralph");
    expect(parts[2]).toContain("team");
    // col 4: ralph iter/max
    expect(parts[3]).toBe("2/5");
    // col 5: team done/spawned
    expect(parts[4]).toBe("1/3");

    // v1.9 cols appear in rich tail.
    expect(line).toContain("[mode:ralph iter:2/5]");
    expect(line).toContain("[prd:1/2]");
    expect(line).toContain("[cost:0]");
  });

  it("cols 3-5 all dash when no state (regression)", () => {
    const state = loadHudState(cwd, env);
    const line = renderHud(state);
    const parts = line.split(" · ");
    expect(parts[2]).toBe("-");
    expect(parts[3]).toBe("-");
    expect(parts[4]).toBe("-");
  });
});
