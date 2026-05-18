import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ultragoalCommand,
  ULTRAGOAL_HELP,
} from "../cli/commands/ultragoal.js";
import {
  canStartMode,
  writeModeState,
  type BaseModeState,
} from "../runtime/mode-state.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function tempCwd(): { setup: () => void; teardown: () => void; dir: () => string } {
  let tmp = "";
  let prev = "";
  return {
    setup() {
      tmp = mkdtempSync(join(tmpdir(), "omcp-ultragoal-"));
      prev = process.cwd();
      process.chdir(tmp);
    },
    teardown() {
      process.chdir(prev);
      try {
        rmSync(tmp, { recursive: true, force: true });
      } catch {
        // ignore
      }
    },
    dir() {
      return tmp;
    },
  };
}

async function capture(
  run: () => Promise<void>,
): Promise<{ stdout: string[]; stderr: string[]; exitCode: number | string | undefined }> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const prevCode = process.exitCode;
  process.exitCode = undefined;
  const logSpy = vi
    .spyOn(console, "log")
    .mockImplementation((...args: unknown[]) =>
      stdout.push(args.map(String).join(" ")),
    );
  const errSpy = vi
    .spyOn(console, "error")
    .mockImplementation((...args: unknown[]) =>
      stderr.push(args.map(String).join(" ")),
    );
  try {
    await run();
    return { stdout, stderr, exitCode: process.exitCode };
  } finally {
    logSpy.mockRestore();
    errSpy.mockRestore();
    process.exitCode = prevCode;
  }
}

function cleanQualityGate(): string {
  return JSON.stringify({
    aiSlopCleaner: { status: "passed", evidence: "ai-slop-cleaner passed" },
    verification: {
      status: "passed",
      commands: ["npm test"],
      evidence: "tests passed after cleaner",
    },
    codeReview: {
      recommendation: "APPROVE",
      architectStatus: "CLEAR",
      evidence: "$code-review APPROVE + CLEAR",
    },
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ultragoal CLI command", () => {
  const ctx = tempCwd();

  beforeEach(() => ctx.setup());
  afterEach(() => ctx.teardown());

  it("SKILL.md help text contains expected keywords", () => {
    expect(ULTRAGOAL_HELP).toMatch(/create-goals/);
    expect(ULTRAGOAL_HELP).toMatch(/complete-goals/);
    expect(ULTRAGOAL_HELP).toMatch(/checkpoint/);
    expect(ULTRAGOAL_HELP).toMatch(/quality-gate-json/);
    expect(ULTRAGOAL_HELP).toMatch(/ai-slop-cleaner/);
    expect(ULTRAGOAL_HELP).toMatch(/record-review-blockers/);
    expect(ULTRAGOAL_HELP).toMatch(/\.omcp\/ultragoal/);
  });

  it("start writes goals.json with active:true-equivalent state", async () => {
    const created = await capture(() =>
      ultragoalCommand([
        "create-goals",
        "--brief",
        "- First milestone\n- Second milestone",
      ]),
    );
    expect(created.exitCode).toBeUndefined();
    expect(created.stdout.join("\n")).toMatch(/ultragoal plan created: 2 goal/);

    const goalsPath = join(ctx.dir(), ".omcp/ultragoal/goals.json");
    const goals = JSON.parse(readFileSync(goalsPath, "utf-8")) as {
      version: number;
      goals: Array<{ status: string }>;
      codexGoalMode: string;
    };
    expect(goals.version).toBe(1);
    expect(goals.goals).toHaveLength(2);
    expect(goals.goals[0].status).toBe("pending");
    expect(goals.codexGoalMode).toBe("aggregate");
  });

  it("start rejects when a mutually-exclusive mode is already active", async () => {
    // Write a ralph state to simulate conflict
    writeModeState<BaseModeState>("ralph", {
      active: true,
      session_id: "s-test",
      started_at: new Date().toISOString(),
      prompt: "other task",
    });
    const check = canStartMode("ultragoal");
    expect(check.ok).toBe(false);
    expect(check.conflict).toBe("ralph");
  });

  it("complete-goals prints handoff with goal id and objective", async () => {
    await capture(() =>
      ultragoalCommand([
        "create-goals",
        "--brief",
        "- First milestone\n- Second milestone",
      ]),
    );
    const next = await capture(() => ultragoalCommand(["complete-goals"]));
    const out = next.stdout.join("\n");
    expect(out).toMatch(/ultragoal/i);
    expect(out).toMatch(/G001/);
    expect(out).toMatch(/first-milestone/i);
  });

  it("status reports pending goals after create", async () => {
    await capture(() =>
      ultragoalCommand(["create-goals", "--brief", "- Alpha\n- Beta"]),
    );
    const s = await capture(() => ultragoalCommand(["status"]));
    const out = s.stdout.join("\n");
    expect(out).toMatch(/2 complete/i);
    // 0/2 complete, 2 pending
    expect(out).toMatch(/0\/2 complete/);
  });

  it("stop: checkpoint complete removes active state", async () => {
    await capture(() =>
      ultragoalCommand(["create-goals", "--brief", "- Solo goal"]),
    );
    await capture(() => ultragoalCommand(["complete-goals"]));

    const goalsPath = join(ctx.dir(), ".omcp/ultragoal/goals.json");

    // Checkpoint the solo goal complete with quality gate (it's final)
    const cp = await capture(() =>
      ultragoalCommand([
        "checkpoint",
        "--goal-id",
        "G001-solo-goal",
        "--status",
        "complete",
        "--evidence",
        "tests passed; implementation done; validation complete",
        "--quality-gate-json",
        cleanQualityGate(),
      ]),
    );
    expect(cp.exitCode).toBeUndefined();
    expect(cp.stdout.join("\n")).toMatch(/G001-solo-goal -> complete/);

    // Subsequent status shows aggregate complete
    const s = await capture(() => ultragoalCommand(["status"]));
    expect(s.stdout.join("\n")).toMatch(/aggregate product: complete/);

    // goals.json no longer has an activeGoalId
    const goals = JSON.parse(readFileSync(goalsPath, "utf-8")) as {
      activeGoalId?: string;
    };
    expect(goals.activeGoalId).toBeUndefined();
  });

  it("subsequent status after stop reports not-active (no activeGoalId)", async () => {
    await capture(() =>
      ultragoalCommand(["create-goals", "--brief", "- Task A"]),
    );
    await capture(() => ultragoalCommand(["complete-goals"]));
    await capture(() =>
      ultragoalCommand([
        "checkpoint",
        "--goal-id",
        "G001-task-a",
        "--status",
        "complete",
        "--evidence",
        "done",
        "--quality-gate-json",
        cleanQualityGate(),
      ]),
    );
    const goalsPath = join(ctx.dir(), ".omcp/ultragoal/goals.json");
    const plan = JSON.parse(readFileSync(goalsPath, "utf-8")) as {
      activeGoalId?: string;
      aggregateCompletion?: { status: string };
    };
    expect(plan.activeGoalId).toBeUndefined();
    expect(plan.aggregateCompletion?.status).toBe("complete");
  });

  it("uses temp dirs — does not pollute repo .omcp/", () => {
    // Verify cwd is a temp dir, not the repo root
    const cwd = process.cwd();
    expect(cwd).not.toBe(
      join(__dirname, "..", ".."),
    );
    expect(cwd).toMatch(/omcp-ultragoal-/);
  });

  it("checkpoint --json returns structured summary", async () => {
    await capture(() =>
      ultragoalCommand([
        "create-goals",
        "--brief",
        "- Feature X\n- Feature Y",
      ]),
    );
    await capture(() => ultragoalCommand(["complete-goals"]));

    const cp = await capture(() =>
      ultragoalCommand([
        "checkpoint",
        "--goal-id",
        "G001-feature-x",
        "--status",
        "complete",
        "--evidence",
        "tests passed",
        "--json",
      ]),
    );
    expect(cp.exitCode).toBeUndefined();
    const parsed = JSON.parse(cp.stdout.join("\n")) as {
      summary: { complete: number; total: number };
    };
    expect(parsed.summary.complete).toBe(1);
    expect(parsed.summary.total).toBe(2);
  });

  it("add-goal appends a new pending story", async () => {
    await capture(() =>
      ultragoalCommand(["create-goals", "--brief", "- Base goal"]),
    );
    const added = await capture(() =>
      ultragoalCommand([
        "add-goal",
        "--title",
        "Extra goal",
        "--objective",
        "Fix the remaining issues.",
        "--json",
      ]),
    );
    expect(added.exitCode).toBeUndefined();
    const parsed = JSON.parse(added.stdout.join("\n")) as {
      addedGoal: { id: string; status: string };
      summary: { total: number; pending: number };
    };
    expect(parsed.addedGoal.status).toBe("pending");
    expect(parsed.summary.total).toBe(2);
    expect(parsed.summary.pending).toBe(2);
  });

  it("record-review-blockers marks goal review_blocked and adds blocker story", async () => {
    await capture(() =>
      ultragoalCommand(["create-goals", "--brief", "- Final story"]),
    );
    await capture(() => ultragoalCommand(["complete-goals"]));

    const blocked = await capture(() =>
      ultragoalCommand([
        "record-review-blockers",
        "--goal-id",
        "G001-final-story",
        "--title",
        "Resolve final code-review blockers",
        "--objective",
        "Fix blockers and rerun gates.",
        "--evidence",
        "code-review REQUEST CHANGES",
        "--json",
      ]),
    );
    expect(blocked.exitCode).toBeUndefined();
    const parsed = JSON.parse(blocked.stdout.join("\n")) as {
      blockedGoal: { status: string };
      addedGoal: { status: string };
      summary: { reviewBlocked: number; pending: number };
    };
    expect(parsed.blockedGoal.status).toBe("review_blocked");
    expect(parsed.addedGoal.status).toBe("pending");
    expect(parsed.summary.reviewBlocked).toBe(1);
    expect(parsed.summary.pending).toBe(1);
  });
});
