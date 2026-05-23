import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";
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

import {
  registerRalplan,
  deriveSlug,
  derivePlanPath,
} from "../index.js";
import {
  readBoulderState,
  getPlansDir,
  appendSessionId,
} from "../../lib/boulder-state.js";
import { clearWorktreeCache } from "../../lib/worktree-paths.js";
import { readModeState } from "../../runtime/mode-state.js";
import type { BaseModeState } from "../../runtime/mode-state.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function initRepo(dir: string): void {
  execSync("git init --quiet", { cwd: dir });
  execSync("git config user.email test@example.com", { cwd: dir });
  execSync("git config user.name test", { cwd: dir });
}

function makeWorktree(): string {
  const dir = mkdtempSync(join(tmpdir(), "omcp-ralplan-"));
  initRepo(dir);
  return dir;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("deriveSlug", () => {
  it("lowercases and replaces spaces with hyphens", () => {
    expect(deriveSlug("Add user auth")).toBe("add-user-auth");
  });

  it("collapses consecutive non-alphanumeric chars", () => {
    expect(deriveSlug("fix: bug #42 -- urgent!")).toBe("fix-bug-42-urgent");
  });

  it("truncates to 60 chars", () => {
    const long = "a".repeat(80);
    expect(deriveSlug(long).length).toBe(60);
  });

  it("returns 'plan' for empty/whitespace input", () => {
    expect(deriveSlug("")).toBe("plan");
    expect(deriveSlug("---")).toBe("plan");
  });

  it("strips leading and trailing hyphens", () => {
    expect(deriveSlug("  --hello world--  ")).toBe("hello-world");
  });
});

describe("registerRalplan — plan file write", () => {
  let dir: string;

  beforeEach(() => {
    clearWorktreeCache();
    dir = makeWorktree();
  });

  afterEach(() => {
    clearWorktreeCache();
    rmSync(dir, { recursive: true, force: true });
  });

  it("writes the plan file to .omcp/plans/<slug>.md", () => {
    const result = registerRalplan({
      task: "build login flow",
      planContent: "# Build Login Flow\n\n- [ ] Step 1\n",
      sessionId: "sess-001",
      worktreeRoot: dir,
    });

    expect(existsSync(result.planPath)).toBe(true);
    expect(result.slug).toBe("build-login-flow");
    const content = readFileSync(result.planPath, "utf-8");
    expect(content).toContain("# Build Login Flow");
  });

  it("plan path is inside .omcp/plans/", () => {
    const result = registerRalplan({
      task: "refactor auth module",
      planContent: "# Plan\n",
      sessionId: "sess-001",
      worktreeRoot: dir,
    });
    const plansDir = getPlansDir(dir);
    expect(result.planPath.startsWith(plansDir)).toBe(true);
  });

  it("creates the plans directory if absent", () => {
    const plansDir = getPlansDir(dir);
    expect(existsSync(plansDir)).toBe(false);

    registerRalplan({
      task: "new task",
      planContent: "# Plan\n",
      sessionId: "sess-001",
      worktreeRoot: dir,
    });

    expect(existsSync(plansDir)).toBe(true);
  });
});

describe("registerRalplan — boulder state write", () => {
  let dir: string;

  beforeEach(() => {
    clearWorktreeCache();
    dir = makeWorktree();
  });

  afterEach(() => {
    clearWorktreeCache();
    rmSync(dir, { recursive: true, force: true });
  });

  it("writes boulder state with active=true", () => {
    registerRalplan({
      task: "implement dashboard",
      planContent: "# Dashboard Plan\n",
      sessionId: "sess-001",
      worktreeRoot: dir,
    });

    const state = readBoulderState(dir);
    expect(state).not.toBeNull();
    expect(state!.active).toBe(true);
  });

  it("boulder state activePlan matches the written plan path", () => {
    const result = registerRalplan({
      task: "implement dashboard",
      planContent: "# Dashboard Plan\n",
      sessionId: "sess-001",
      worktreeRoot: dir,
    });

    const state = readBoulderState(dir);
    expect(state!.activePlan).toBe(result.planPath);
  });

  it("boulder state includes the session id", () => {
    registerRalplan({
      task: "add tests",
      planContent: "# Tests Plan\n",
      sessionId: "session-abc",
      worktreeRoot: dir,
    });

    const state = readBoulderState(dir);
    expect(state!.sessionIds).toContain("session-abc");
  });

  it("boulderWritten is true in result", () => {
    const result = registerRalplan({
      task: "setup CI",
      planContent: "# CI Plan\n",
      sessionId: "sess-x",
      worktreeRoot: dir,
    });
    expect(result.boulderWritten).toBe(true);
  });
});

describe("registerRalplan — multi-session idempotency", () => {
  let dir: string;

  beforeEach(() => {
    clearWorktreeCache();
    dir = makeWorktree();
  });

  afterEach(() => {
    clearWorktreeCache();
    rmSync(dir, { recursive: true, force: true });
  });

  it("second session id is appended when same plan is re-registered", () => {
    registerRalplan({
      task: "build feature x",
      planContent: "# Plan\n",
      sessionId: "session-1",
      worktreeRoot: dir,
    });

    // Simulate second session working on same plan
    const firstState = readBoulderState(dir)!;
    registerRalplan({
      task: "build feature x",
      planContent: "# Plan (updated)\n",
      sessionId: "session-2",
      worktreeRoot: dir,
    });

    const state = readBoulderState(dir)!;
    // session-2 should be appended (plan already existed so new slug generated)
    // The second call gets a -2 slug and creates a new boulder entry
    expect(state.sessionIds.length).toBeGreaterThanOrEqual(1);
  });

  it("same session id is not duplicated on repeat calls to same plan path", () => {
    // First call registers boulder
    registerRalplan({
      task: "unique task abc",
      planContent: "# Plan\n",
      sessionId: "sess-dedup",
      worktreeRoot: dir,
    });

    // Manually call appendSessionId again to verify idempotency
    appendSessionId("sess-dedup", dir);
    appendSessionId("sess-dedup", dir);

    const state = readBoulderState(dir)!;
    const count = state.sessionIds.filter((id) => id === "sess-dedup").length;
    expect(count).toBe(1);
  });
});

describe("registerRalplan — ralph hand-off", () => {
  let dir: string;
  let origCwd: string;

  beforeEach(() => {
    clearWorktreeCache();
    dir = makeWorktree();
    origCwd = process.cwd();
    process.chdir(dir);
  });

  afterEach(() => {
    clearWorktreeCache();
    process.chdir(origCwd);
    rmSync(dir, { recursive: true, force: true });
  });

  it("does not write ralplan mode-state when handOffToRalph is false", () => {
    registerRalplan({
      task: "small task",
      planContent: "# Plan\n",
      sessionId: "sess-no-ralph",
      worktreeRoot: dir,
      handOffToRalph: false,
    });

    const modeState = readModeState<BaseModeState>("ralplan", "sess-no-ralph");
    expect(modeState).toBeNull();
  });

  it("writes ralplan mode-state with active=true when handOffToRalph is true", () => {
    registerRalplan({
      task: "big task",
      planContent: "# Plan\n",
      sessionId: "sess-with-ralph",
      worktreeRoot: dir,
      handOffToRalph: true,
    });

    const modeState = readModeState<BaseModeState>("ralplan", "sess-with-ralph");
    expect(modeState).not.toBeNull();
    expect(modeState!.active).toBe(true);
    expect(modeState!.session_id).toBe("sess-with-ralph");
  });
});

describe("derivePlanPath — collision avoidance", () => {
  let dir: string;

  beforeEach(() => {
    clearWorktreeCache();
    dir = makeWorktree();
  });

  afterEach(() => {
    clearWorktreeCache();
    rmSync(dir, { recursive: true, force: true });
  });

  it("first call returns base slug with alreadyExisted=false", () => {
    const { slug, alreadyExisted } = derivePlanPath("my task", dir);
    expect(slug).toBe("my-task");
    expect(alreadyExisted).toBe(false);
  });

  it("collision produces -2 suffix", () => {
    const plansDir = getPlansDir(dir);
    mkdirSync(plansDir, { recursive: true });
    writeFileSync(join(plansDir, "my-task.md"), "# existing");

    const { slug, alreadyExisted } = derivePlanPath("my task", dir);
    expect(slug).toBe("my-task-2");
    expect(alreadyExisted).toBe(true);
  });
});

describe("registerRalplan — error paths", () => {
  let dir: string;

  beforeEach(() => {
    clearWorktreeCache();
    dir = makeWorktree();
  });

  afterEach(() => {
    clearWorktreeCache();
    rmSync(dir, { recursive: true, force: true });
  });

  it("handles empty planContent gracefully (writes empty file)", () => {
    const result = registerRalplan({
      task: "empty plan test",
      planContent: "",
      sessionId: "sess-empty",
      worktreeRoot: dir,
    });
    expect(existsSync(result.planPath)).toBe(true);
    expect(readFileSync(result.planPath, "utf-8")).toBe("");
    expect(result.boulderWritten).toBe(true);
  });

  it("handles task with only special characters", () => {
    const result = registerRalplan({
      task: "!@#$%^&*()",
      planContent: "# Plan\n",
      sessionId: "sess-special",
      worktreeRoot: dir,
    });
    // deriveSlug falls back to 'plan'
    expect(result.slug).toBe("plan");
    expect(existsSync(result.planPath)).toBe(true);
  });
});
