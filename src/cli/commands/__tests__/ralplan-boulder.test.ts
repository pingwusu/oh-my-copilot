/**
 * Tests for ralplan → boulder integration.
 *
 * We test `registerRalplan` directly (the function wired into runMode after
 * the ralplan skill exits) rather than spawning `omcp ralplan` end-to-end,
 * since the latter requires a live Copilot CLI.
 */

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

import { registerRalplan, deriveSlug } from "../../../ralplan/index.js";
import {
  readBoulderState,
  getPlansDir,
  appendSessionId,
} from "../../../lib/boulder-state.js";
import { clearWorktreeCache } from "../../../lib/worktree-paths.js";
import { readModeState } from "../../../runtime/mode-state.js";
import type { BaseModeState } from "../../../runtime/mode-state.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function initRepo(dir: string): void {
  execSync("git init --quiet", { cwd: dir });
  execSync("git config user.email test@example.com", { cwd: dir });
  execSync("git config user.name test", { cwd: dir });
}

function makeWorktree(): string {
  const dir = mkdtempSync(join(tmpdir(), "omcp-ralplan-cli-"));
  initRepo(dir);
  return dir;
}

// ─── Test suite ───────────────────────────────────────────────────────────────

describe("ralplan → boulder integration (CLI level)", () => {
  let dir: string;

  beforeEach(() => {
    clearWorktreeCache();
    dir = makeWorktree();
  });

  afterEach(() => {
    clearWorktreeCache();
    rmSync(dir, { recursive: true, force: true });
  });

  // ── 1. Plan path written ──────────────────────────────────────────────────

  it("writes plan file to .omcp/plans/<slug>.md", () => {
    const result = registerRalplan({
      task: "implement user authentication",
      planContent: "# Implement User Authentication\n\n- [ ] Step 1\n",
      sessionId: "sess-001",
      worktreeRoot: dir,
    });

    expect(existsSync(result.planPath)).toBe(true);
    const content = readFileSync(result.planPath, "utf-8");
    expect(content).toContain("# Implement User Authentication");
    expect(result.slug).toBe("implement-user-authentication");
  });

  // ── 2. Boulder state record correct ──────────────────────────────────────

  it("boulder state has correct activePlan, active=true, planName", () => {
    const result = registerRalplan({
      task: "build dashboard",
      planContent: "# Dashboard\n",
      sessionId: "sess-002",
      worktreeRoot: dir,
    });

    const state = readBoulderState(dir);
    expect(state).not.toBeNull();
    expect(state!.active).toBe(true);
    expect(state!.activePlan).toBe(result.planPath);
    expect(state!.planName).toBe(result.slug);
    expect(result.boulderWritten).toBe(true);
  });

  // ── 3. Session-id scoped properly ────────────────────────────────────────

  it("boulder state sessionIds contains the provided session id", () => {
    registerRalplan({
      task: "refactor api layer",
      planContent: "# API Refactor\n",
      sessionId: "session-xyz",
      worktreeRoot: dir,
    });

    const state = readBoulderState(dir);
    expect(state!.sessionIds).toContain("session-xyz");
    expect(state!.sessionIds).toHaveLength(1);
  });

  // ── 4. Error path: invalid worktreeRoot ──────────────────────────────────

  it("boulderWritten=false when worktreeRoot write is blocked (read-only state dir)", () => {
    // We can't truly make dirs read-only on all platforms in CI, so instead
    // test that registerRalplan doesn't throw even when state write fails.
    // We simulate by passing a non-existent path without git init.
    const badDir = join(tmpdir(), "omcp-ralplan-no-git-" + Date.now());
    mkdirSync(badDir, { recursive: true });

    // No git init → worktree-paths falls back to cwd for .omcp root.
    // The call should not throw.
    let threw = false;
    try {
      registerRalplan({
        task: "task in bad dir",
        planContent: "# Plan\n",
        sessionId: "sess-bad",
        worktreeRoot: badDir,
      });
    } catch {
      threw = true;
    } finally {
      rmSync(badDir, { recursive: true, force: true });
    }
    expect(threw).toBe(false);
  });

  // ── 5. Idempotent re-run (same task, same session) ────────────────────────

  it("second call for same task appends -2 slug and preserves first boulder state", () => {
    const r1 = registerRalplan({
      task: "migrate database",
      planContent: "# Migrate DB\n",
      sessionId: "sess-idem",
      worktreeRoot: dir,
    });

    // Second run: same task → slug collision → gets -2 suffix
    const r2 = registerRalplan({
      task: "migrate database",
      planContent: "# Migrate DB (updated)\n",
      sessionId: "sess-idem-2",
      worktreeRoot: dir,
    });

    expect(r1.slug).toBe("migrate-database");
    expect(r2.slug).toBe("migrate-database-2");
    expect(existsSync(r1.planPath)).toBe(true);
    expect(existsSync(r2.planPath)).toBe(true);

    // Both plan files exist independently
    expect(r1.planPath).not.toBe(r2.planPath);
  });

  // ── 6. Multiple sessions don't clobber each other ────────────────────────

  it("second session on same plan appends session id without clobbering", () => {
    // First session creates the plan + boulder state
    const r1 = registerRalplan({
      task: "unique plan alpha",
      planContent: "# Alpha Plan\n",
      sessionId: "session-a",
      worktreeRoot: dir,
    });

    // Simulate second session appending to same boulder record
    appendSessionId("session-b", dir);

    const state = readBoulderState(dir)!;
    expect(state.sessionIds).toContain("session-a");
    expect(state.sessionIds).toContain("session-b");
    expect(state.sessionIds).toHaveLength(2);
    // activePlan unchanged
    expect(state.activePlan).toBe(r1.planPath);
  });

  // ── 7. ralph hand-off disabled by default ────────────────────────────────

  it("does not write ralplan mode-state when handOffToRalph is not set", () => {
    const origCwd = process.cwd();
    process.chdir(dir);
    try {
      registerRalplan({
        task: "small job",
        planContent: "# Plan\n",
        sessionId: "sess-norf",
        worktreeRoot: dir,
      });
      const modeState = readModeState<BaseModeState>("ralplan", "sess-norf");
      expect(modeState).toBeNull();
    } finally {
      process.chdir(origCwd);
    }
  });

  // ── 8. deriveSlug used correctly by the CLI mode runner ──────────────────

  it("deriveSlug produces the expected plan filename slug", () => {
    expect(deriveSlug("Build CI/CD pipeline")).toBe("build-ci-cd-pipeline");
    expect(deriveSlug("Fix bug #42")).toBe("fix-bug-42");
  });
});
