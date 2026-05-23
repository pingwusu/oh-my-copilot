import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { createTodoContinuationHook } from "../index.js";
import type { HookContext } from "../../hook-types.js";
import type { Todo, TodoState } from "../../../lib/todo-state.js";
import { TODO_CONTINUATION_PROMPT } from "../../../lib/todo-state.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "omcp-todo-cont-test-"));
}

function makeCtx(
  cwd: string,
  toolArgs?: Record<string, unknown>,
): HookContext {
  return {
    event: "Stop",
    sessionId: "test-session-1",
    cwd,
    toolArgs,
  };
}

function writeTodos(cwd: string, todos: Partial<Todo>[]): void {
  const stateDir = path.join(cwd, ".omcp", "state");
  fs.mkdirSync(stateDir, { recursive: true });
  const now = new Date().toISOString();
  const full: TodoState = {
    updatedAt: now,
    todos: todos.map((t, i) => ({
      id: t.id ?? `todo-${i}`,
      content: t.content ?? `Task ${i}`,
      status: t.status ?? "pending",
      createdAt: t.createdAt ?? now,
      updatedAt: t.updatedAt ?? now,
    })),
  };
  // resolveStatePath("todos") → .omcp/state/todos-state.json
  fs.writeFileSync(
    path.join(stateDir, "todos-state.json"),
    JSON.stringify(full, null, 2),
  );
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("todo-continuation", () => {
  let cwd: string;

  beforeEach(() => {
    cwd = makeTempDir();
  });

  afterEach(() => {
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  // ── 1. Empty state → noop ─────────────────────────────────────────────────

  it("returns noop when no todo state file exists", async () => {
    const hook = createTodoContinuationHook();
    const result = await hook.run(makeCtx(cwd));
    expect(result).toEqual({ kind: "noop" });
  });

  // ── 2. All todos completed → noop ─────────────────────────────────────────

  it("returns noop when all todos are completed", async () => {
    writeTodos(cwd, [
      { content: "Task A", status: "completed" },
      { content: "Task B", status: "completed" },
    ]);
    const hook = createTodoContinuationHook();
    const result = await hook.run(makeCtx(cwd));
    expect(result).toEqual({ kind: "noop" });
  });

  // ── 3. All todos cancelled → noop ─────────────────────────────────────────

  it("returns noop when all todos are cancelled", async () => {
    writeTodos(cwd, [
      { content: "Task A", status: "cancelled" },
    ]);
    const hook = createTodoContinuationHook();
    const result = await hook.run(makeCtx(cwd));
    expect(result).toEqual({ kind: "noop" });
  });

  // ── 4. Pending todos → advise with continuation prompt ───────────────────

  it("returns advise when pending todos remain", async () => {
    writeTodos(cwd, [
      { content: "Finish the report", status: "pending" },
      { content: "Run tests", status: "pending" },
    ]);
    const hook = createTodoContinuationHook();
    const result = await hook.run(makeCtx(cwd));
    expect(result.kind).toBe("advise");
    if (result.kind === "advise") {
      expect(result.text).toContain(TODO_CONTINUATION_PROMPT);
      expect(result.text).toContain("Finish the report");
    }
  });

  // ── 5. in_progress todo → advise, surfaces in-progress item first ────────

  it("surfaces in-progress todo as next item", async () => {
    writeTodos(cwd, [
      { content: "First pending", status: "pending" },
      { content: "Currently doing", status: "in_progress" },
    ]);
    const hook = createTodoContinuationHook();
    const result = await hook.run(makeCtx(cwd));
    expect(result.kind).toBe("advise");
    if (result.kind === "advise") {
      expect(result.text).toContain("Currently doing");
      expect(result.text).toContain("in_progress");
    }
  });

  // ── 6. Mixed completed + pending → advise ────────────────────────────────

  it("returns advise when some todos are done and some are still pending", async () => {
    writeTodos(cwd, [
      { content: "Done task", status: "completed" },
      { content: "Pending task", status: "pending" },
    ]);
    const hook = createTodoContinuationHook();
    const result = await hook.run(makeCtx(cwd));
    expect(result.kind).toBe("advise");
    if (result.kind === "advise") {
      expect(result.text).toContain("1/2 completed");
    }
  });

  // ── 7. User abort → noop (isUserAbort guard) ──────────────────────────────

  it("returns noop when stop reason is user abort", async () => {
    writeTodos(cwd, [{ content: "Unfinished task", status: "pending" }]);
    const hook = createTodoContinuationHook();
    const result = await hook.run(
      makeCtx(cwd, { stop_reason: "aborted", userRequested: true }),
    );
    expect(result).toEqual({ kind: "noop" });
  });

  // ── 8. Context limit stop → noop ─────────────────────────────────────────

  it("returns noop when stop reason is context limit", async () => {
    writeTodos(cwd, [{ content: "Unfinished task", status: "pending" }]);
    const hook = createTodoContinuationHook();
    const result = await hook.run(
      makeCtx(cwd, { stop_reason: "context_limit" }),
    );
    expect(result).toEqual({ kind: "noop" });
  });

  // ── 9. Rate limit stop → noop ─────────────────────────────────────────────

  it("returns noop when stop reason is rate limit", async () => {
    writeTodos(cwd, [{ content: "Unfinished task", status: "pending" }]);
    const hook = createTodoContinuationHook();
    const result = await hook.run(
      makeCtx(cwd, { stop_reason: "rate_limit" }),
    );
    expect(result).toEqual({ kind: "noop" });
  });

  // ── 10. Auth error stop → noop ───────────────────────────────────────────

  it("returns noop when stop reason is authentication error", async () => {
    writeTodos(cwd, [{ content: "Unfinished task", status: "pending" }]);
    const hook = createTodoContinuationHook();
    const result = await hook.run(
      makeCtx(cwd, { stop_reason: "authentication_error" }),
    );
    expect(result).toEqual({ kind: "noop" });
  });

  // ── 11. Explicit cancel command → noop ───────────────────────────────────

  it("returns noop when prompt is explicit /cancel command", async () => {
    writeTodos(cwd, [{ content: "Unfinished task", status: "pending" }]);
    const hook = createTodoContinuationHook();
    const result = await hook.run(
      makeCtx(cwd, { prompt: "/cancel" }),
    );
    expect(result).toEqual({ kind: "noop" });
  });

  // ── 12. Malformed state file → graceful noop ─────────────────────────────

  it("returns noop gracefully when todo state file is malformed JSON", async () => {
    const stateDir = path.join(cwd, ".omcp", "state");
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(path.join(stateDir, "todos-state.json"), "{ not valid json }}}");
    const hook = createTodoContinuationHook();
    const result = await hook.run(makeCtx(cwd));
    expect(result).toEqual({ kind: "noop" });
  });

  // ── 13. Malformed todos array → graceful noop ────────────────────────────

  it("returns noop gracefully when todos field is not an array", async () => {
    const stateDir = path.join(cwd, ".omcp", "state");
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(
      path.join(stateDir, "todos-state.json"),
      JSON.stringify({ todos: "not-an-array", updatedAt: new Date().toISOString() }),
    );
    const hook = createTodoContinuationHook();
    const result = await hook.run(makeCtx(cwd));
    expect(result).toEqual({ kind: "noop" });
  });

  // ── 14. Subscribes to Stop event ─────────────────────────────────────────

  it("subscribes to Stop event only", () => {
    const hook = createTodoContinuationHook();
    expect(hook.events).toEqual(["Stop"]);
    expect(hook.name).toBe("todo-continuation");
  });

  // ── 15. advise text includes status summary ───────────────────────────────

  it("advise text includes todo status summary line", async () => {
    writeTodos(cwd, [
      { content: "Task 1", status: "completed" },
      { content: "Task 2", status: "pending" },
      { content: "Task 3", status: "pending" },
    ]);
    const hook = createTodoContinuationHook();
    const result = await hook.run(makeCtx(cwd));
    expect(result.kind).toBe("advise");
    if (result.kind === "advise") {
      expect(result.text).toContain("Status:");
      expect(result.text).toContain("1/3 completed");
      expect(result.text).toContain("2 remaining");
    }
  });
});
