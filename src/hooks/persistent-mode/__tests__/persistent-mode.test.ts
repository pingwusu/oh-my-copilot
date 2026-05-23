import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createPersistentModeHook } from "../index.js";
import { readRalphState } from "../../../lib/ralph-state.js";
import type { HookContext } from "../../hook-types.js";
import type { RalphState } from "../../../lib/ralph-state.js";
import type { UltraworkState } from "../../../lib/ultrawork-state.js";
import type { Todo } from "../../../lib/todo-state.js";

// ---------------------------------------------------------------------------
// Helpers — write state files directly to .omcp/state/ inside the tmp dir,
// matching the pattern used by todo-continuation tests (no git repo needed).
// ---------------------------------------------------------------------------

function makeTmp(): string {
  const dir = join(
    tmpdir(),
    `omcp-pm-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(dir, { recursive: true });
  return dir;
}

function stateDir(cwd: string): string {
  const dir = join(cwd, ".omcp", "state");
  mkdirSync(dir, { recursive: true });
  return dir;
}

function writeState(cwd: string, name: string, data: unknown): void {
  const dir = stateDir(cwd);
  writeFileSync(join(dir, `${name}-state.json`), JSON.stringify(data, null, 2));
}

function makeCtx(cwd: string, overrides: Partial<HookContext> = {}): HookContext {
  return {
    event: "Stop",
    sessionId: "test-session",
    cwd,
    ...overrides,
  };
}

function makeRalph(overrides: Partial<RalphState> = {}): RalphState {
  return {
    active: true,
    iteration: 1,
    lastFiredAt: new Date().toISOString(),
    prompt: "Build the feature",
    ...overrides,
  };
}

function makeUltrawork(overrides: Partial<UltraworkState> = {}): UltraworkState {
  return {
    active: true,
    startedAt: new Date().toISOString(),
    originalPrompt: "Complete all tasks in parallel",
    reinforcementCount: 0,
    lastCheckedAt: new Date().toISOString(),
    ...overrides,
  };
}

function makeTodo(overrides: Partial<Todo> = {}): Todo {
  const now = new Date().toISOString();
  return {
    id: "todo-1",
    content: "Write unit tests",
    status: "pending",
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function writeTodos(cwd: string, todos: Partial<Todo>[]): void {
  const now = new Date().toISOString();
  writeState(cwd, "todos", {
    updatedAt: now,
    todos: todos.map((t, i) => ({
      id: t.id ?? `todo-${i}`,
      content: t.content ?? `Task ${i}`,
      status: t.status ?? "pending",
      createdAt: t.createdAt ?? now,
      updatedAt: t.updatedAt ?? now,
    })),
  });
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

let tmpDir: string;
let hook: ReturnType<typeof createPersistentModeHook>;

beforeEach(() => {
  tmpDir = makeTmp();
  hook = createPersistentModeHook();
});

afterEach(() => {
  if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Basic hook shape
// ---------------------------------------------------------------------------

describe("createPersistentModeHook", () => {
  it("returns a hook with name 'persistent-mode'", () => {
    expect(hook.name).toBe("persistent-mode");
  });

  it("subscribes only to Stop event", () => {
    expect(hook.events).toEqual(["Stop"]);
  });
});

// ---------------------------------------------------------------------------
// No-state: noop
// ---------------------------------------------------------------------------

describe("no active state", () => {
  it("returns noop when no ralph/ultrawork/todo state exists", async () => {
    const result = await hook.run(makeCtx(tmpDir));
    expect(result.kind).toBe("noop");
  });
});

// ---------------------------------------------------------------------------
// Escape hatches — never block these stop types
// ---------------------------------------------------------------------------

describe("escape hatches", () => {
  beforeEach(() => {
    writeState(tmpDir, "ralph", makeRalph());
  });

  it("returns noop on user abort (user_requested=true)", async () => {
    const ctx = makeCtx(tmpDir, { toolArgs: { user_requested: true } });
    const result = await hook.run(ctx);
    expect(result.kind).toBe("noop");
  });

  it("returns noop on context_limit stop_reason", async () => {
    const ctx = makeCtx(tmpDir, { toolArgs: { stop_reason: "context_limit" } });
    const result = await hook.run(ctx);
    expect(result.kind).toBe("noop");
  });

  it("returns noop on rate_limit stop_reason", async () => {
    const ctx = makeCtx(tmpDir, { toolArgs: { stop_reason: "rate_limit" } });
    const result = await hook.run(ctx);
    expect(result.kind).toBe("noop");
  });

  it("returns noop on explicit /cancel prompt", async () => {
    const ctx = makeCtx(tmpDir, { toolArgs: { prompt: "/cancel" } });
    const result = await hook.run(ctx);
    expect(result.kind).toBe("noop");
  });

  it("returns noop on /oh-my-copilot:cancel prompt", async () => {
    const ctx = makeCtx(tmpDir, {
      toolArgs: { prompt: "/oh-my-copilot:cancel" },
    });
    const result = await hook.run(ctx);
    expect(result.kind).toBe("noop");
  });
});

// ---------------------------------------------------------------------------
// Ralph-driven continuation
// ---------------------------------------------------------------------------

describe("ralph continuation", () => {
  it("returns advise with ralph-continuation tag when ralph is active", async () => {
    writeState(tmpDir, "ralph", makeRalph());
    const result = await hook.run(makeCtx(tmpDir));
    expect(result.kind).toBe("advise");
    if (result.kind === "advise") {
      expect(result.text).toContain("ralph-continuation");
      expect(result.text).toContain("RALPH — ITERATION");
    }
  });

  it("increments iteration counter on each Stop", async () => {
    writeState(tmpDir, "ralph", makeRalph({ iteration: 3 }));
    const result = await hook.run(makeCtx(tmpDir));
    expect(result.kind).toBe("advise");
    if (result.kind === "advise") {
      expect(result.text).toContain("ITERATION 4");
    }
  });

  it("includes original prompt in continuation message", async () => {
    writeState(tmpDir, "ralph", makeRalph({ prompt: "Implement OAuth2 login" }));
    const result = await hook.run(makeCtx(tmpDir));
    expect(result.kind).toBe("advise");
    if (result.kind === "advise") {
      expect(result.text).toContain("Implement OAuth2 login");
    }
  });

  it("returns noop when ralph state is inactive", async () => {
    writeState(tmpDir, "ralph", makeRalph({ active: false }));
    const result = await hook.run(makeCtx(tmpDir));
    expect(result.kind).toBe("noop");
  });

  it("returns COMPLETE message when architectApproved is true", async () => {
    writeState(tmpDir, "ralph", makeRalph({ architectApproved: true }));
    const result = await hook.run(makeCtx(tmpDir));
    expect(result.kind).toBe("advise");
    if (result.kind === "advise") {
      expect(result.text).toContain("COMPLETE");
    }
  });

  it("takes priority over ultrawork when both are active", async () => {
    writeState(tmpDir, "ralph", makeRalph());
    writeState(tmpDir, "ultrawork", makeUltrawork());
    const result = await hook.run(makeCtx(tmpDir));
    expect(result.kind).toBe("advise");
    if (result.kind === "advise") {
      expect(result.text).toContain("ralph-continuation");
      expect(result.text).not.toContain("ULTRAWORK");
    }
  });

  it("requests verification when all PRD stories are complete", async () => {
    const omcpDir = join(tmpDir, ".omcp");
    mkdirSync(omcpDir, { recursive: true });
    writeFileSync(
      join(omcpDir, "prd.json"),
      JSON.stringify({
        project: "test",
        branchName: "main",
        description: "Test PRD",
        userStories: [
          {
            id: "US-001",
            title: "Story 1",
            description: "Desc",
            acceptanceCriteria: ["criterion 1"],
            priority: 1,
            passes: true,
          },
        ],
      }),
    );
    writeState(tmpDir, "ralph", makeRalph());
    const result = await hook.run(makeCtx(tmpDir));
    expect(result.kind).toBe("advise");
    if (result.kind === "advise") {
      expect(result.text).toContain("VERIFICATION REQUIRED");
    }
  });

  it("uses todo-instruction when no PRD exists", async () => {
    writeState(tmpDir, "ralph", makeRalph());
    const result = await hook.run(makeCtx(tmpDir));
    expect(result.kind).toBe("advise");
    if (result.kind === "advise") {
      expect(result.text).toContain("todo list");
    }
  });
});

// ---------------------------------------------------------------------------
// Ultrawork-driven continuation
// ---------------------------------------------------------------------------

describe("ultrawork continuation", () => {
  it("returns advise with ultrawork-persistence tag when ultrawork is active", async () => {
    writeState(tmpDir, "ultrawork", makeUltrawork());
    const result = await hook.run(makeCtx(tmpDir));
    expect(result.kind).toBe("advise");
    if (result.kind === "advise") {
      expect(result.text).toContain("ULTRAWORK MODE STILL ACTIVE");
    }
  });

  it("returns noop when ultrawork state is inactive", async () => {
    writeState(tmpDir, "ultrawork", makeUltrawork({ active: false }));
    const result = await hook.run(makeCtx(tmpDir));
    expect(result.kind).toBe("noop");
  });

  it("includes original prompt in ultrawork message", async () => {
    writeState(
      tmpDir,
      "ultrawork",
      makeUltrawork({ originalPrompt: "Refactor the entire API layer" }),
    );
    const result = await hook.run(makeCtx(tmpDir));
    expect(result.kind).toBe("advise");
    if (result.kind === "advise") {
      expect(result.text).toContain("Refactor the entire API layer");
    }
  });

  it("takes priority over todo continuation when both are active", async () => {
    writeState(tmpDir, "ultrawork", makeUltrawork());
    writeTodos(tmpDir, [makeTodo()]);
    const result = await hook.run(makeCtx(tmpDir));
    expect(result.kind).toBe("advise");
    if (result.kind === "advise") {
      expect(result.text).toContain("ULTRAWORK");
      expect(result.text).not.toContain("INCOMPLETE TODOS");
    }
  });
});

// ---------------------------------------------------------------------------
// Todo continuation
// ---------------------------------------------------------------------------

describe("todo continuation", () => {
  it("returns advise when incomplete todos exist", async () => {
    writeTodos(tmpDir, [makeTodo()]);
    const result = await hook.run(makeCtx(tmpDir));
    expect(result.kind).toBe("advise");
    if (result.kind === "advise") {
      expect(result.text).toContain("INCOMPLETE TODOS");
    }
  });

  it("returns noop when all todos are completed", async () => {
    writeTodos(tmpDir, [{ ...makeTodo(), status: "completed" }]);
    const result = await hook.run(makeCtx(tmpDir));
    expect(result.kind).toBe("noop");
  });

  it("returns noop when all todos are cancelled", async () => {
    writeTodos(tmpDir, [{ ...makeTodo(), status: "cancelled" }]);
    const result = await hook.run(makeCtx(tmpDir));
    expect(result.kind).toBe("noop");
  });

  it("includes next pending todo content in message", async () => {
    writeTodos(tmpDir, [makeTodo()]);
    const result = await hook.run(makeCtx(tmpDir));
    expect(result.kind).toBe("advise");
    if (result.kind === "advise") {
      expect(result.text).toContain("Write unit tests");
    }
  });

  it("returns noop on user abort even with incomplete todos", async () => {
    writeTodos(tmpDir, [makeTodo()]);
    const ctx = makeCtx(tmpDir, { toolArgs: { user_requested: true } });
    const result = await hook.run(ctx);
    expect(result.kind).toBe("noop");
  });

  it("returns noop when no todo state file exists", async () => {
    const result = await hook.run(makeCtx(tmpDir));
    expect(result.kind).toBe("noop");
  });
});

// ---------------------------------------------------------------------------
// detectArchitectApproval wiring (Phase 4.T1)
// ---------------------------------------------------------------------------

describe("architect approval detection", () => {
  it("detects approval in toolResult and completes the ralph loop", async () => {
    writeState(tmpDir, "ralph", makeRalph());
    const ctx = makeCtx(tmpDir, {
      toolResult: {
        response: "<architect-approved>VERIFIED_COMPLETE</architect-approved>",
      },
    });
    const result = await hook.run(ctx);
    expect(result.kind).toBe("advise");
    if (result.kind === "advise") {
      expect(result.text).toContain("COMPLETE");
      expect(result.text).toContain("VERIFIED");
    }
  });

  it("continues loop (no COMPLETE) when no approval signal is present", async () => {
    writeState(tmpDir, "ralph", makeRalph());
    const ctx = makeCtx(tmpDir, {
      toolResult: { response: "Still working on the feature implementation." },
    });
    const result = await hook.run(ctx);
    expect(result.kind).toBe("advise");
    if (result.kind === "advise") {
      expect(result.text).toContain("ralph-continuation");
      expect(result.text).not.toContain("COMPLETE");
    }
  });

  it("does not false-positive on text that contains VERIFIED_COMPLETE without the approved tag", async () => {
    writeState(tmpDir, "ralph", makeRalph());
    const ctx = makeCtx(tmpDir, {
      toolResult: {
        response: "The task is VERIFIED_COMPLETE but without the architect tag.",
      },
    });
    const result = await hook.run(ctx);
    expect(result.kind).toBe("advise");
    if (result.kind === "advise") {
      expect(result.text).toContain("ralph-continuation");
      expect(result.text).not.toContain("RALPH LOOP COMPLETE — VERIFIED");
    }
  });
});

// ---------------------------------------------------------------------------
// incrementRalphIteration on Stop (Phase 4.T2)
// ---------------------------------------------------------------------------

describe("iteration counter increments on Stop", () => {
  it("bumps iteration from 1 to 2 on first Stop fire", async () => {
    writeState(tmpDir, "ralph", makeRalph({ iteration: 1 }));
    await hook.run(makeCtx(tmpDir));
    const state = readRalphState(tmpDir);
    expect(state?.iteration).toBe(2);
  });

  it("bumps iteration across 3 consecutive Stop fires (1→2→3→4)", async () => {
    writeState(tmpDir, "ralph", makeRalph({ iteration: 1 }));
    await hook.run(makeCtx(tmpDir));
    await hook.run(makeCtx(tmpDir));
    await hook.run(makeCtx(tmpDir));
    const state = readRalphState(tmpDir);
    expect(state?.iteration).toBe(4);
  });

  it("does not increment when ralph state is inactive", async () => {
    writeState(tmpDir, "ralph", makeRalph({ active: false, iteration: 5 }));
    await hook.run(makeCtx(tmpDir));
    const state = readRalphState(tmpDir);
    // State is untouched — still iteration 5
    expect(state?.iteration).toBe(5);
  });
});
