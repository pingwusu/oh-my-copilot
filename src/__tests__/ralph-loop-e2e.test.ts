/**
 * E2E ralph loop integration test (Phase 4.T4)
 *
 * Drives a 2-story PRD through the full ralph lifecycle using the
 * persistent-mode hook directly. No spawnSync mock needed — we manipulate
 * state files between hook invocations to simulate what copilot would do
 * across iterations.
 *
 * Lifecycle under test:
 *   Iteration 1: hook fires → advise (story 1 pending) → simulate copilot
 *                marking story 1 passes:true + incrementing iteration
 *   Iteration 2: hook fires → advise (story 2 pending) → simulate copilot
 *                marking story 2 passes:true + incrementing iteration
 *   Iteration 3: hook fires → noop (allComplete) → ralph-state cleared
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createPersistentModeHook } from "../hooks/persistent-mode/index.js";
import {
  readRalphState,
  writeRalphState,
  writePrd,
} from "../lib/ralph-state.js";
import type { HookContext } from "../hooks/hook-types.js";
import type { PRD } from "../lib/ralph-state.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), "omcp-ralph-e2e-"));
}

function makeCtx(cwd: string): HookContext {
  return { event: "Stop", sessionId: "e2e-session", cwd };
}

function makePrd(story1Passes: boolean, story2Passes: boolean): PRD {
  return {
    project: "e2e-test",
    branchName: "main",
    description: "Two-story PRD for e2e test",
    userStories: [
      {
        id: "US-001",
        title: "Story 1",
        description: "First story",
        acceptanceCriteria: ["AC1"],
        priority: 1,
        passes: story1Passes,
      },
      {
        id: "US-002",
        title: "Story 2",
        description: "Second story",
        acceptanceCriteria: ["AC2"],
        priority: 2,
        passes: story2Passes,
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

let cwd: string;
let hook: ReturnType<typeof createPersistentModeHook>;

beforeEach(() => {
  cwd = makeTmpDir();
  mkdirSync(join(cwd, ".omcp", "state"), { recursive: true });
  hook = createPersistentModeHook();
});

afterEach(() => {
  rmSync(cwd, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// E2E: 2-story PRD lifecycle
// ---------------------------------------------------------------------------

describe("ralph loop e2e — 2-story PRD lifecycle", () => {
  it("drives PRD from pending to allComplete across 3 Stop events", async () => {
    // Seed: both stories pending, ralph active at iteration 1
    writePrd(makePrd(false, false), cwd);
    writeRalphState(
      { active: true, iteration: 1, lastFiredAt: new Date().toISOString(), prompt: "implement stories" },
      cwd,
    );

    // --- Stop event 1: story 1 still pending → should advise ---
    const result1 = await hook.run(makeCtx(cwd));
    expect(result1.kind).toBe("advise");
    if (result1.kind === "advise") {
      expect(result1.text).toContain("ralph-continuation");
    }

    // Simulate copilot completing story 1 (hook already incremented iteration)
    writePrd(makePrd(true, false), cwd);

    // --- Stop event 2: story 2 still pending → should advise ---
    const result2 = await hook.run(makeCtx(cwd));
    expect(result2.kind).toBe("advise");
    if (result2.kind === "advise") {
      expect(result2.text).toContain("ralph-continuation");
    }

    // Simulate copilot completing story 2 (hook already incremented iteration)
    writePrd(makePrd(true, true), cwd);

    // State should now be at iteration 3 (1 + 2 increments from hook)
    const stateBeforeFinal = readRalphState(cwd);
    expect(stateBeforeFinal?.iteration).toBe(3);

    // --- Stop event 3: allComplete → should noop and clear state ---
    const result3 = await hook.run(makeCtx(cwd));
    expect(result3.kind).toBe("noop");

    // Ralph state must be cleared after allComplete exit
    const stateAfter = readRalphState(cwd);
    expect(stateAfter).toBeNull();
  });

  it("loop exits at first Stop when PRD is already complete on start", async () => {
    writePrd(makePrd(true, true), cwd);
    writeRalphState(
      { active: true, iteration: 1, lastFiredAt: new Date().toISOString(), prompt: "nothing to do" },
      cwd,
    );

    const result = await hook.run(makeCtx(cwd));
    expect(result.kind).toBe("noop");
    expect(readRalphState(cwd)).toBeNull();
  });

  it("architect approval in Stop context short-circuits remaining stories", async () => {
    // Story 2 still pending, but architect approved in this Stop's context
    writePrd(makePrd(true, false), cwd);
    writeRalphState(
      { active: true, iteration: 2, lastFiredAt: new Date().toISOString(), prompt: "implement stories" },
      cwd,
    );

    const ctx: HookContext = {
      event: "Stop",
      sessionId: "e2e-session",
      cwd,
      toolResult: {
        response: "<architect-approved>VERIFIED_COMPLETE</architect-approved>",
      },
    };

    const result = await hook.run(ctx);
    // T1 approval path: returns advise with COMPLETE message
    expect(result.kind).toBe("advise");
    if (result.kind === "advise") {
      expect(result.text).toContain("COMPLETE");
    }
    // State cleared after approval
    expect(readRalphState(cwd)).toBeNull();
  });
});
