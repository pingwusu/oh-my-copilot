import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { renderHud } from "../hud/render.js";
import { loadHudState } from "../hud/state.js";
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
