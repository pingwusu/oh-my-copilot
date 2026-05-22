import { execSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  appendSessionId,
  clearBoulderState,
  createBoulderState,
  findPlans,
  getActivePlanPath,
  getBoulderFilePath,
  getPlanName,
  getPlanProgress,
  getPlanSummaries,
  getPlansDir,
  hasBoulder,
  readBoulderState,
  writeBoulderState,
  type BoulderState,
} from "../boulder-state.js";
import { clearWorktreeCache } from "../worktree-paths.js";

function initRepo(dir: string): void {
  execSync("git init --quiet", { cwd: dir });
  execSync("git config user.email test@example.com", { cwd: dir });
  execSync("git config user.name test", { cwd: dir });
}

function makeWorktree(): string {
  const dir = mkdtempSync(join(tmpdir(), "omcp-boulder-"));
  initRepo(dir);
  return dir;
}

function freshState(overrides: Partial<BoulderState> = {}): BoulderState {
  return {
    activePlan: "/tmp/plans/sample.md",
    startedAt: "2026-05-22T17:00:00.000Z",
    sessionIds: ["s1"],
    planName: "sample",
    active: true,
    updatedAt: "2026-05-22T17:00:00.000Z",
    ...overrides,
  };
}

describe("read/write/clear boulder state", () => {
  let dir: string;

  beforeEach(() => {
    clearWorktreeCache();
    dir = makeWorktree();
  });

  afterEach(() => {
    clearWorktreeCache();
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns null when no state file exists", () => {
    expect(readBoulderState(dir)).toBeNull();
  });

  it("round-trips a state", () => {
    const state = freshState();
    expect(writeBoulderState(state, dir)).toBe(true);
    expect(readBoulderState(dir)).toEqual(state);
  });

  it("write creates .omcp/state/", () => {
    writeBoulderState(freshState(), dir);
    expect(existsSync(getBoulderFilePath(dir))).toBe(true);
  });

  it("round-trips metadata when present", () => {
    writeBoulderState(
      freshState({ metadata: { phase: "test", attempts: 3 } }),
      dir,
    );
    expect(readBoulderState(dir)?.metadata).toEqual({
      phase: "test",
      attempts: 3,
    });
  });

  it("returns null on malformed JSON", () => {
    const stateDir = join(dir, ".omcp", "state");
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(getBoulderFilePath(dir), "{ not json");
    expect(readBoulderState(dir)).toBeNull();
  });

  it("returns null on schema-violating JSON", () => {
    const stateDir = join(dir, ".omcp", "state");
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(
      getBoulderFilePath(dir),
      JSON.stringify({ activePlan: "x" /* missing other fields */ }),
    );
    expect(readBoulderState(dir)).toBeNull();
  });

  it("clearBoulderState removes the file and is idempotent", () => {
    writeBoulderState(freshState(), dir);
    expect(clearBoulderState(dir)).toBe(true);
    expect(existsSync(getBoulderFilePath(dir))).toBe(false);
    expect(clearBoulderState(dir)).toBe(true);
  });
});

describe("appendSessionId", () => {
  let dir: string;

  beforeEach(() => {
    clearWorktreeCache();
    dir = makeWorktree();
  });

  afterEach(() => {
    clearWorktreeCache();
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns null when no state exists", () => {
    expect(appendSessionId("s2", dir)).toBeNull();
  });

  it("appends a new session id", () => {
    writeBoulderState(freshState({ sessionIds: ["s1"] }), dir);
    const updated = appendSessionId("s2", dir);
    expect(updated?.sessionIds).toEqual(["s1", "s2"]);
  });

  it("is idempotent for duplicate ids", () => {
    writeBoulderState(freshState({ sessionIds: ["s1"] }), dir);
    const updated = appendSessionId("s1", dir);
    expect(updated?.sessionIds).toEqual(["s1"]);
  });

  it("refreshes updatedAt on actual append", () => {
    writeBoulderState(
      freshState({
        sessionIds: ["s1"],
        updatedAt: "2026-01-01T00:00:00.000Z",
      }),
      dir,
    );
    const updated = appendSessionId("s2", dir);
    expect(updated?.updatedAt).not.toBe("2026-01-01T00:00:00.000Z");
  });
});

describe("plan discovery", () => {
  let dir: string;

  beforeEach(() => {
    clearWorktreeCache();
    dir = makeWorktree();
  });

  afterEach(() => {
    clearWorktreeCache();
    rmSync(dir, { recursive: true, force: true });
  });

  it("findPlans returns [] when no plans directory", () => {
    expect(findPlans(dir)).toEqual([]);
  });

  it("findPlans lists *.md and excludes other extensions", () => {
    const plansDir = getPlansDir(dir);
    mkdirSync(plansDir, { recursive: true });
    writeFileSync(join(plansDir, "a.md"), "# A");
    writeFileSync(join(plansDir, "b.md"), "# B");
    writeFileSync(join(plansDir, "c.txt"), "not a plan");

    const plans = findPlans(dir);
    expect(plans.length).toBe(2);
    expect(plans.every((p) => p.endsWith(".md"))).toBe(true);
  });

  it("findPlans sorts newest-modified first", () => {
    const plansDir = getPlansDir(dir);
    mkdirSync(plansDir, { recursive: true });
    const a = join(plansDir, "older.md");
    const b = join(plansDir, "newer.md");
    writeFileSync(a, "# older");
    writeFileSync(b, "# newer");

    const past = new Date("2026-01-01T00:00:00.000Z");
    const recent = new Date("2026-05-22T17:00:00.000Z");
    utimesSync(a, past, past);
    utimesSync(b, recent, recent);

    const plans = findPlans(dir);
    expect(plans[0]).toBe(b);
    expect(plans[1]).toBe(a);
  });
});

describe("getPlanProgress", () => {
  let dir: string;

  beforeEach(() => {
    clearWorktreeCache();
    dir = makeWorktree();
  });

  afterEach(() => {
    clearWorktreeCache();
    rmSync(dir, { recursive: true, force: true });
  });

  it("counts unchecked + checked boxes", () => {
    const plan = join(dir, "p.md");
    writeFileSync(
      plan,
      [
        "# Plan",
        "- [ ] one",
        "- [x] two",
        "- [X] three (capital X)",
        "* [ ] four (asterisk bullet)",
        "regular text",
      ].join("\n"),
    );
    const progress = getPlanProgress(plan);
    expect(progress.total).toBe(4);
    expect(progress.completed).toBe(2);
    expect(progress.isComplete).toBe(false);
  });

  it("isComplete=true when zero checkboxes", () => {
    const plan = join(dir, "p.md");
    writeFileSync(plan, "# Plan\n\nnothing to check.\n");
    const progress = getPlanProgress(plan);
    expect(progress.total).toBe(0);
    expect(progress.isComplete).toBe(true);
  });

  it("isComplete=true when all checked", () => {
    const plan = join(dir, "p.md");
    writeFileSync(plan, "- [x] a\n- [x] b\n");
    expect(getPlanProgress(plan)).toEqual({
      total: 2,
      completed: 2,
      isComplete: true,
    });
  });

  it("missing file → empty progress + isComplete=true", () => {
    const progress = getPlanProgress(join(dir, "does-not-exist.md"));
    expect(progress.total).toBe(0);
    expect(progress.isComplete).toBe(true);
  });
});

describe("getPlanName / getPlanSummaries", () => {
  let dir: string;

  beforeEach(() => {
    clearWorktreeCache();
    dir = makeWorktree();
  });

  afterEach(() => {
    clearWorktreeCache();
    rmSync(dir, { recursive: true, force: true });
  });

  it("getPlanName strips .md", () => {
    expect(getPlanName("/tmp/plans/foo.md")).toBe("foo");
  });

  it("getPlanSummaries reports per-plan progress", () => {
    const plansDir = getPlansDir(dir);
    mkdirSync(plansDir, { recursive: true });
    writeFileSync(join(plansDir, "a.md"), "- [x] done\n- [ ] todo\n");
    writeFileSync(join(plansDir, "b.md"), "no checkboxes here");

    const summaries = getPlanSummaries(dir);
    expect(summaries.length).toBe(2);
    const a = summaries.find((s) => s.name === "a");
    const b = summaries.find((s) => s.name === "b");
    expect(a?.progress.total).toBe(2);
    expect(a?.progress.completed).toBe(1);
    expect(a?.progress.isComplete).toBe(false);
    expect(b?.progress.total).toBe(0);
    expect(b?.progress.isComplete).toBe(true);
  });
});

describe("createBoulderState / hasBoulder / getActivePlanPath", () => {
  let dir: string;

  beforeEach(() => {
    clearWorktreeCache();
    dir = makeWorktree();
  });

  afterEach(() => {
    clearWorktreeCache();
    rmSync(dir, { recursive: true, force: true });
  });

  it("createBoulderState produces a fresh active state", () => {
    const state = createBoulderState("/tmp/plans/foo.md", "session-1");
    expect(state.active).toBe(true);
    expect(state.planName).toBe("foo");
    expect(state.sessionIds).toEqual(["session-1"]);
    expect(state.startedAt).toBe(state.updatedAt);
  });

  it("hasBoulder reflects state presence", () => {
    expect(hasBoulder(dir)).toBe(false);
    writeBoulderState(freshState(), dir);
    expect(hasBoulder(dir)).toBe(true);
  });

  it("getActivePlanPath returns the path or null", () => {
    expect(getActivePlanPath(dir)).toBeNull();
    writeBoulderState(freshState({ activePlan: "/tmp/x.md" }), dir);
    expect(getActivePlanPath(dir)).toBe("/tmp/x.md");
  });
});
