import { execSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  appendProgressNote,
  clearRalphState,
  detectArchitectApproval,
  detectArchitectRejection,
  getPrdCompletionStatus,
  getPrdStatus,
  getRalphContext,
  incrementRalphIteration,
  readPrd,
  readProgressNotes,
  readRalphState,
  writeRalphState,
  type PRD,
  type RalphState,
} from "../ralph-state.js";
import { clearWorktreeCache } from "../worktree-paths.js";

function initRepo(dir: string): void {
  execSync("git init --quiet", { cwd: dir });
  execSync("git config user.email test@example.com", { cwd: dir });
  execSync("git config user.name test", { cwd: dir });
}

function makeWorktree(): string {
  const dir = mkdtempSync(join(tmpdir(), "omcp-ralph-"));
  initRepo(dir);
  return dir;
}

function freshState(overrides: Partial<RalphState> = {}): RalphState {
  return {
    active: true,
    iteration: 1,
    lastFiredAt: "2026-05-22T17:00:00.000Z",
    prompt: "test prompt",
    ...overrides,
  };
}

describe("readRalphState / writeRalphState", () => {
  let dir: string;

  beforeEach(() => {
    clearWorktreeCache();
    dir = makeWorktree();
  });

  afterEach(() => {
    clearWorktreeCache();
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns null when state file does not exist", () => {
    expect(readRalphState(dir)).toBeNull();
  });

  it("round-trips a minimal state", () => {
    const state = freshState();
    expect(writeRalphState(state, dir)).toBe(true);
    expect(readRalphState(dir)).toEqual(state);
  });

  it("round-trips optional fields", () => {
    const state = freshState({
      prdPath: ".omcp/prd.json",
      architectApproved: true,
    });
    writeRalphState(state, dir);
    const read = readRalphState(dir);
    expect(read?.prdPath).toBe(".omcp/prd.json");
    expect(read?.architectApproved).toBe(true);
  });

  it("creates .omcp/state/ directory on first write", () => {
    writeRalphState(freshState(), dir);
    expect(existsSync(join(dir, ".omcp", "state", "ralph-state.json"))).toBe(
      true,
    );
  });

  it("uses atomic write — no .tmp.* sibling left over", () => {
    writeRalphState(freshState(), dir);
    const stateDir = join(dir, ".omcp", "state");
    const entries = readFileSync(
      join(stateDir, "ralph-state.json"),
      "utf-8",
    );
    expect(entries).toContain("\"active\": true");
    // Ensure no tmp file remains.
    const dirents = require("node:fs").readdirSync(stateDir);
    expect(dirents.filter((d: string) => d.includes(".tmp."))).toEqual([]);
  });

  it("rejects malformed JSON with null", () => {
    const stateDir = join(dir, ".omcp", "state");
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(join(stateDir, "ralph-state.json"), "{ not json");
    expect(readRalphState(dir)).toBeNull();
  });

  it("rejects schema violations with null", () => {
    const stateDir = join(dir, ".omcp", "state");
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(
      join(stateDir, "ralph-state.json"),
      JSON.stringify({ active: "yes", iteration: 1 }),
    );
    expect(readRalphState(dir)).toBeNull();
  });
});

describe("clearRalphState", () => {
  let dir: string;

  beforeEach(() => {
    clearWorktreeCache();
    dir = makeWorktree();
  });

  afterEach(() => {
    clearWorktreeCache();
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns true when nothing to clear", () => {
    expect(clearRalphState(dir)).toBe(true);
  });

  it("removes the state file when present", () => {
    writeRalphState(freshState(), dir);
    expect(clearRalphState(dir)).toBe(true);
    expect(existsSync(join(dir, ".omcp", "state", "ralph-state.json"))).toBe(
      false,
    );
  });
});

describe("incrementRalphIteration", () => {
  let dir: string;

  beforeEach(() => {
    clearWorktreeCache();
    dir = makeWorktree();
  });

  afterEach(() => {
    clearWorktreeCache();
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns null with no state", () => {
    expect(incrementRalphIteration(dir)).toBeNull();
  });

  it("returns null when state is inactive", () => {
    writeRalphState(freshState({ active: false }), dir);
    expect(incrementRalphIteration(dir)).toBeNull();
  });

  it("bumps iteration + updates lastFiredAt", () => {
    writeRalphState(freshState({ iteration: 3 }), dir);
    const updated = incrementRalphIteration(dir);
    expect(updated?.iteration).toBe(4);
    expect(updated?.lastFiredAt).not.toBe("2026-05-22T17:00:00.000Z");
  });
});

describe("PRD reading + status", () => {
  let dir: string;

  beforeEach(() => {
    clearWorktreeCache();
    dir = makeWorktree();
  });

  afterEach(() => {
    clearWorktreeCache();
    rmSync(dir, { recursive: true, force: true });
  });

  function writePrdFile(path: string, prd: PRD): void {
    mkdirSync(require("node:path").dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(prd, null, 2));
  }

  it("readPrd returns null when no PRD exists", () => {
    expect(readPrd(dir)).toBeNull();
  });

  it("readPrd reads default .omcp/prd.json when no state.prdPath", () => {
    const prd: PRD = {
      project: "p",
      branchName: "b",
      description: "d",
      userStories: [
        { id: "US-001", title: "x", description: "d", acceptanceCriteria: [], priority: 1, passes: false },
      ],
    };
    writePrdFile(join(dir, ".omcp", "prd.json"), prd);
    expect(readPrd(dir)?.userStories.length).toBe(1);
  });

  it("readPrd honors state.prdPath when set (relative to worktree)", () => {
    const prd: PRD = {
      project: "p",
      branchName: "b",
      description: "d",
      userStories: [
        { id: "US-001", title: "x", description: "d", acceptanceCriteria: [], priority: 1, passes: false },
      ],
    };
    writePrdFile(join(dir, "docs", "my-prd.json"), prd);
    writeRalphState(freshState({ prdPath: "docs/my-prd.json" }), dir);
    expect(readPrd(dir)?.project).toBe("p");
  });

  it("readPrd returns null on malformed PRD", () => {
    mkdirSync(join(dir, ".omcp"), { recursive: true });
    writeFileSync(join(dir, ".omcp", "prd.json"), "{ not json");
    expect(readPrd(dir)).toBeNull();
  });

  it("readPrd returns null when userStories is missing/invalid", () => {
    mkdirSync(join(dir, ".omcp"), { recursive: true });
    writeFileSync(
      join(dir, ".omcp", "prd.json"),
      JSON.stringify({ project: "p", branchName: "b", description: "d" }),
    );
    expect(readPrd(dir)).toBeNull();
  });

  it("getPrdStatus identifies next story by lowest priority", () => {
    const prd: PRD = {
      project: "p",
      branchName: "b",
      description: "d",
      userStories: [
        { id: "B", title: "b", description: "", acceptanceCriteria: [], priority: 5, passes: false },
        { id: "A", title: "a", description: "", acceptanceCriteria: [], priority: 1, passes: false },
        { id: "C", title: "c", description: "", acceptanceCriteria: [], priority: 3, passes: true },
      ],
    };
    const status = getPrdStatus(prd);
    expect(status.total).toBe(3);
    expect(status.completed).toBe(1);
    expect(status.pending).toBe(2);
    expect(status.allComplete).toBe(false);
    expect(status.nextStory?.id).toBe("A");
    expect(status.incompleteIds.sort()).toEqual(["A", "B"]);
  });

  it("getPrdStatus reports allComplete when every story passes", () => {
    const prd: PRD = {
      project: "p",
      branchName: "b",
      description: "d",
      userStories: [
        { id: "A", title: "", description: "", acceptanceCriteria: [], priority: 1, passes: true },
      ],
    };
    const status = getPrdStatus(prd);
    expect(status.allComplete).toBe(true);
    expect(status.nextStory).toBeNull();
  });

  it("getPrdCompletionStatus returns hasPrd:false absent PRD", () => {
    const result = getPrdCompletionStatus(dir);
    expect(result.hasPrd).toBe(false);
    expect(result.allComplete).toBe(false);
    expect(result.status).toBeNull();
    expect(result.nextStory).toBeNull();
  });
});

describe("progress notes", () => {
  let dir: string;

  beforeEach(() => {
    clearWorktreeCache();
    dir = makeWorktree();
  });

  afterEach(() => {
    clearWorktreeCache();
    rmSync(dir, { recursive: true, force: true });
  });

  it("readProgressNotes returns '' when no file exists", () => {
    expect(readProgressNotes(dir)).toBe("");
  });

  it("appendProgressNote creates and appends", () => {
    expect(appendProgressNote("first entry", dir)).toBe(true);
    expect(appendProgressNote("second entry", dir, "US-002")).toBe(true);

    const notes = readProgressNotes(dir);
    expect(notes).toContain("first entry");
    expect(notes).toContain("second entry");
    expect(notes).toContain("US-002");
  });
});

describe("getRalphContext", () => {
  let dir: string;

  beforeEach(() => {
    clearWorktreeCache();
    dir = makeWorktree();
  });

  afterEach(() => {
    clearWorktreeCache();
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns empty string when nothing is present", () => {
    expect(getRalphContext(dir)).toBe("");
  });

  it("includes progress notes when present", () => {
    appendProgressNote("learned something", dir);
    expect(getRalphContext(dir)).toContain("learned something");
    expect(getRalphContext(dir)).toContain("<progress-notes>");
  });

  it("includes next-story prompt + status summary when PRD has pending work", () => {
    const prd: PRD = {
      project: "p",
      branchName: "b",
      description: "d",
      userStories: [
        {
          id: "US-001",
          title: "First story",
          description: "Do the first thing",
          acceptanceCriteria: ["A1", "A2"],
          priority: 1,
          passes: false,
        },
      ],
    };
    mkdirSync(join(dir, ".omcp"), { recursive: true });
    writeFileSync(join(dir, ".omcp", "prd.json"), JSON.stringify(prd));

    const ctx = getRalphContext(dir);
    expect(ctx).toContain("US-001");
    expect(ctx).toContain("First story");
    expect(ctx).toContain("A1");
    expect(ctx).toContain("0/1 stories complete");
  });
});

describe("detectArchitectApproval", () => {
  it("matches the architect-approved sentinel", () => {
    expect(
      detectArchitectApproval(
        "<architect-approved>VERIFIED_COMPLETE</architect-approved>",
      ),
    ).toBe(true);
  });

  it("matches the ralph-approved sentinel with critic attribute", () => {
    expect(
      detectArchitectApproval(
        '<ralph-approved critic="critic">VERIFIED_COMPLETE</ralph-approved>',
      ),
    ).toBe(true);
  });

  it("matches across newlines (dotall)", () => {
    expect(
      detectArchitectApproval(
        "<ralph-approved>\nVERIFIED_COMPLETE\n</ralph-approved>",
      ),
    ).toBe(true);
  });

  it("rejects malformed or absent sentinels", () => {
    expect(detectArchitectApproval("looks good to me")).toBe(false);
    expect(detectArchitectApproval("<ralph-approved>not the magic string</ralph-approved>")).toBe(false);
  });
});

describe("detectArchitectRejection", () => {
  it("flags explicit reviewer rejection", () => {
    const result = detectArchitectRejection(
      "Architect rejected this — bug found in error handling.",
    );
    expect(result.rejected).toBe(true);
    expect(result.feedback.length).toBeGreaterThan(0);
  });

  it("flags 'issues found'", () => {
    expect(
      detectArchitectRejection("Several issues found in the implementation.")
        .rejected,
    ).toBe(true);
  });

  it("flags 'not yet complete'", () => {
    expect(detectArchitectRejection("The task is not yet complete.").rejected).toBe(
      true,
    );
  });

  it("flags 'missing implementation'", () => {
    expect(
      detectArchitectRejection("Missing implementation for the API layer.")
        .rejected,
    ).toBe(true);
  });

  it("returns false when no rejection pattern matches", () => {
    const result = detectArchitectRejection("Looks great, ship it.");
    expect(result.rejected).toBe(false);
    expect(result.feedback).toBe("");
  });
});
