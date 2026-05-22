import { execSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  addTodo,
  AUTHENTICATION_ERROR_PATTERNS,
  checkIncompleteTodos,
  clearTodoState,
  formatTodoStatus,
  getIncompleteTodos,
  getNextPendingTodo,
  getTodos,
  isAuthenticationError,
  isContextLimitStop,
  isExplicitCancelCommand,
  isRateLimitStop,
  isUserAbort,
  readTodoState,
  TODO_CONTINUATION_PROMPT,
  updateTodo,
  writeTodoState,
  type StopContext,
  type Todo,
} from "../todo-state.js";
import { clearWorktreeCache } from "../worktree-paths.js";

function initRepo(dir: string): void {
  execSync("git init --quiet", { cwd: dir });
  execSync("git config user.email test@example.com", { cwd: dir });
  execSync("git config user.name test", { cwd: dir });
}

function makeWorktree(): string {
  const dir = mkdtempSync(join(tmpdir(), "omcp-todo-"));
  initRepo(dir);
  return dir;
}

describe("read/write/clear todo state", () => {
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
    expect(readTodoState(dir)).toBeNull();
  });

  it("round-trips a state with todos", () => {
    const todo: Todo = {
      id: "t1",
      content: "do it",
      status: "pending",
      createdAt: "2026-05-22T17:00:00.000Z",
      updatedAt: "2026-05-22T17:00:00.000Z",
    };
    expect(
      writeTodoState({ todos: [todo], updatedAt: todo.updatedAt }, dir),
    ).toBe(true);
    const read = readTodoState(dir);
    expect(read?.todos.length).toBe(1);
    expect(read?.todos[0].id).toBe("t1");
  });

  it("filters out malformed todo entries silently on read", () => {
    const stateDir = join(dir, ".omcp", "state");
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(
      join(stateDir, "todos-state.json"),
      JSON.stringify({
        todos: [
          {
            id: "good",
            content: "x",
            status: "pending",
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
          },
          { id: "bad" /* missing fields */ },
        ],
        updatedAt: "2026-01-01T00:00:00.000Z",
      }),
    );

    expect(readTodoState(dir)?.todos.length).toBe(1);
    expect(readTodoState(dir)?.todos[0].id).toBe("good");
  });

  it("returns null on malformed JSON", () => {
    const stateDir = join(dir, ".omcp", "state");
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(join(stateDir, "todos-state.json"), "{ not json");
    expect(readTodoState(dir)).toBeNull();
  });

  it("clearTodoState is idempotent when no file exists", () => {
    expect(clearTodoState(dir)).toBe(true);
  });
});

describe("addTodo / updateTodo / getTodos", () => {
  let dir: string;

  beforeEach(() => {
    clearWorktreeCache();
    dir = makeWorktree();
  });

  afterEach(() => {
    clearWorktreeCache();
    rmSync(dir, { recursive: true, force: true });
  });

  it("addTodo appends and persists", () => {
    addTodo("first", { worktreeRoot: dir });
    addTodo("second", { worktreeRoot: dir });
    const todos = getTodos(dir);
    expect(todos.length).toBe(2);
    expect(todos.map((t) => t.content).sort()).toEqual(["first", "second"]);
    expect(todos.every((t) => t.status === "pending")).toBe(true);
  });

  it("addTodo returns the created todo with id + timestamps", () => {
    const t = addTodo("x", { worktreeRoot: dir, priority: "high" });
    expect(t.id).toMatch(/^todo-/);
    expect(t.priority).toBe("high");
    expect(t.createdAt).toBeTruthy();
  });

  it("updateTodo applies partial updates + bumps updatedAt", () => {
    const created = addTodo("x", { worktreeRoot: dir });
    const updated = updateTodo(
      created.id,
      { status: "completed" },
      dir,
    );
    expect(updated?.status).toBe("completed");
    expect(updated?.updatedAt).not.toBe(created.updatedAt);
  });

  it("updateTodo returns null for unknown id", () => {
    addTodo("x", { worktreeRoot: dir });
    expect(updateTodo("does-not-exist", { status: "completed" }, dir)).toBeNull();
  });

  it("updateTodo returns null with no state", () => {
    expect(updateTodo("any", { status: "completed" }, dir)).toBeNull();
  });

  it("getIncompleteTodos excludes completed and cancelled", () => {
    const a = addTodo("a", { worktreeRoot: dir });
    const b = addTodo("b", { worktreeRoot: dir });
    addTodo("c", { worktreeRoot: dir });
    updateTodo(a.id, { status: "completed" }, dir);
    updateTodo(b.id, { status: "cancelled" }, dir);

    const incomplete = getIncompleteTodos(dir);
    expect(incomplete.length).toBe(1);
    expect(incomplete[0].content).toBe("c");
  });
});

describe("isUserAbort", () => {
  it("false for empty / missing context", () => {
    expect(isUserAbort()).toBe(false);
    expect(isUserAbort({})).toBe(false);
  });

  it("true when userRequested is set (camelCase or snake_case)", () => {
    expect(isUserAbort({ userRequested: true })).toBe(true);
    expect(isUserAbort({ user_requested: true })).toBe(true);
  });

  it("matches exact abort tokens", () => {
    for (const r of ["abort", "aborted", "cancel", "interrupt"]) {
      expect(isUserAbort({ stop_reason: r })).toBe(true);
    }
  });

  it("matches substring abort patterns", () => {
    expect(isUserAbort({ stop_reason: "user_cancel_received" })).toBe(true);
    expect(isUserAbort({ stop_reason: "ctrl_c" })).toBe(true);
  });

  it("does not match natural-completion reasons", () => {
    expect(isUserAbort({ stop_reason: "end_turn" })).toBe(false);
    expect(isUserAbort({ stop_reason: "stop_sequence" })).toBe(false);
  });
});

describe("isExplicitCancelCommand", () => {
  it("matches /cancel and /oh-my-copilot:cancel prompts", () => {
    expect(isExplicitCancelCommand({ prompt: "/cancel" })).toBe(true);
    expect(isExplicitCancelCommand({ prompt: "/oh-my-copilot:cancel" })).toBe(true);
    expect(isExplicitCancelCommand({ prompt: "/cancel --force" })).toBe(true);
  });

  it("matches cancelomc / stopomc keywords", () => {
    expect(isExplicitCancelCommand({ prompt: "cancelomc" })).toBe(true);
    expect(isExplicitCancelCommand({ prompt: "stopomc" })).toBe(true);
  });

  it("matches reason cancel sentinels", () => {
    expect(isExplicitCancelCommand({ stop_reason: "cancel_force" })).toBe(true);
    expect(isExplicitCancelCommand({ stop_reason: "user_cancel" })).toBe(true);
  });

  it("matches Skill tool invocations targeting *:cancel", () => {
    expect(
      isExplicitCancelCommand({
        tool_name: "Skill",
        tool_input: { skill: "oh-my-copilot:cancel" },
      }),
    ).toBe(true);
    expect(
      isExplicitCancelCommand({
        toolName: "skill",
        toolInput: { skill: "other:cancel" },
      }),
    ).toBe(true);
  });

  it("does not match non-cancel prompts or reasons", () => {
    expect(isExplicitCancelCommand({ prompt: "do the thing" })).toBe(false);
    expect(isExplicitCancelCommand({ stop_reason: "end_turn" })).toBe(false);
    expect(
      isExplicitCancelCommand({ tool_name: "Skill", tool_input: { skill: "other:run" } }),
    ).toBe(false);
  });
});

describe("isContextLimitStop", () => {
  it("matches context_limit patterns", () => {
    expect(isContextLimitStop({ stop_reason: "context_limit" })).toBe(true);
    expect(isContextLimitStop({ stopReason: "max_tokens" })).toBe(true);
    expect(isContextLimitStop({ end_turn_reason: "conversation_too_long" })).toBe(
      true,
    );
    expect(isContextLimitStop({ reason: "input_too_long" })).toBe(true);
  });

  it("false for natural-stop reasons", () => {
    expect(isContextLimitStop({ stop_reason: "end_turn" })).toBe(false);
  });

  it("normalizes hyphens/spaces", () => {
    expect(isContextLimitStop({ stop_reason: "context limit" })).toBe(true);
    expect(isContextLimitStop({ stop_reason: "max-tokens" })).toBe(true);
  });
});

describe("isRateLimitStop", () => {
  it("matches rate-limit patterns", () => {
    expect(isRateLimitStop({ stop_reason: "rate_limit_exceeded" })).toBe(true);
    expect(isRateLimitStop({ stop_reason: "429" })).toBe(true);
    expect(isRateLimitStop({ stop_reason: "quota_exhausted" })).toBe(true);
    expect(isRateLimitStop({ end_turn_reason: "overloaded_error" })).toBe(true);
  });

  it("false for unrelated reasons", () => {
    expect(isRateLimitStop({ stop_reason: "end_turn" })).toBe(false);
  });
});

describe("isAuthenticationError", () => {
  it("matches all documented auth patterns", () => {
    for (const pattern of AUTHENTICATION_ERROR_PATTERNS) {
      expect(isAuthenticationError({ stop_reason: pattern })).toBe(true);
    }
  });

  it("false for unrelated reasons", () => {
    expect(isAuthenticationError({ stop_reason: "end_turn" })).toBe(false);
  });

  it("exports the pattern list as a frozen tuple", () => {
    expect(Object.isFrozen(AUTHENTICATION_ERROR_PATTERNS)).toBe(true);
  });
});

describe("checkIncompleteTodos + getNextPendingTodo", () => {
  let dir: string;

  beforeEach(() => {
    clearWorktreeCache();
    dir = makeWorktree();
  });

  afterEach(() => {
    clearWorktreeCache();
    rmSync(dir, { recursive: true, force: true });
  });

  it("empty when no state", () => {
    const result = checkIncompleteTodos({ worktreeRoot: dir });
    expect(result.count).toBe(0);
    expect(result.source).toBe("none");
  });

  it("counts pending + in_progress", () => {
    addTodo("a", { worktreeRoot: dir });
    const b = addTodo("b", { worktreeRoot: dir });
    updateTodo(b.id, { status: "in_progress" }, dir);
    const c = addTodo("c", { worktreeRoot: dir });
    updateTodo(c.id, { status: "completed" }, dir);

    const result = checkIncompleteTodos({ worktreeRoot: dir });
    expect(result.count).toBe(2);
    expect(result.total).toBe(3);
    expect(result.source).toBe("todo");
  });

  it("returns 'none' when user aborted, regardless of pending todos", () => {
    addTodo("x", { worktreeRoot: dir });
    const result = checkIncompleteTodos({
      worktreeRoot: dir,
      stopContext: { user_requested: true },
    });
    expect(result.count).toBe(0);
    expect(result.source).toBe("none");
  });

  it("getNextPendingTodo prefers in_progress over pending", () => {
    addTodo("a", { worktreeRoot: dir });
    const b = addTodo("b", { worktreeRoot: dir });
    updateTodo(b.id, { status: "in_progress" }, dir);
    addTodo("c", { worktreeRoot: dir });

    const result = checkIncompleteTodos({ worktreeRoot: dir });
    const next = getNextPendingTodo(result);
    expect(next?.content).toBe("b");
  });

  it("getNextPendingTodo returns null when no pending or in_progress", () => {
    expect(getNextPendingTodo({ count: 0, todos: [], total: 0, source: "none" })).toBeNull();
  });
});

describe("formatTodoStatus", () => {
  it("formats the all-complete state", () => {
    expect(formatTodoStatus({ count: 0, todos: [], total: 5, source: "none" })).toBe(
      "All tasks complete (5 total)",
    );
  });

  it("formats the partial state", () => {
    expect(
      formatTodoStatus({
        count: 2,
        todos: [],
        total: 5,
        source: "todo",
      }),
    ).toBe("3/5 completed, 2 remaining");
  });
});

describe("TODO_CONTINUATION_PROMPT", () => {
  it("is non-empty and contains the expected sentinel tag", () => {
    expect(TODO_CONTINUATION_PROMPT).toContain("<todo-continuation>");
    expect(TODO_CONTINUATION_PROMPT.length).toBeGreaterThan(50);
  });
});

function _typingTest(): StopContext {
  return { stop_reason: "end_turn", stopReason: "end_turn" };
}
