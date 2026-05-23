import { execSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { runStateTodo } from "../state-todo.js";
import { addTodo } from "../../../lib/todo-state.js";
import { clearWorktreeCache } from "../../../lib/worktree-paths.js";

function makeWorktree(): string {
  const dir = mkdtempSync(join(tmpdir(), "omcp-state-todo-"));
  execSync("git init --quiet", { cwd: dir });
  execSync("git config user.email test@example.com", { cwd: dir });
  execSync("git config user.name test", { cwd: dir });
  return dir;
}

describe("runStateTodo", () => {
  let dir: string;
  let logs: string[];
  let errs: string[];
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    clearWorktreeCache();
    dir = makeWorktree();
    logs = [];
    errs = [];
    logSpy = vi.spyOn(console, "log").mockImplementation((...a) => {
      logs.push(a.map(String).join(" "));
    });
    errSpy = vi.spyOn(console, "error").mockImplementation((...a) => {
      errs.push(a.map(String).join(" "));
    });
  });

  afterEach(() => {
    logSpy.mockRestore();
    errSpy.mockRestore();
    clearWorktreeCache();
    rmSync(dir, { recursive: true, force: true });
  });

  it("missing subcommand returns exit 2", () => {
    const code = runStateTodo([], dir);
    expect(code).toBe(2);
    expect(errs.join("\n")).toContain("missing subcommand");
  });

  it("unknown subcommand returns exit 2", () => {
    const code = runStateTodo(["zzz"], dir);
    expect(code).toBe(2);
    expect(errs.join("\n")).toContain("unknown subcommand 'zzz'");
  });

  it("add with no title returns exit 2", () => {
    const code = runStateTodo(["add"], dir);
    expect(code).toBe(2);
    expect(errs.join("\n")).toContain("<title> argument required");
  });

  it("add creates a todo and prints the new id", () => {
    const code = runStateTodo(["add", "ship", "the", "feature"], dir);
    expect(code).toBe(0);
    const file = join(dir, ".omcp", "state", "todos-state.json");
    expect(existsSync(file)).toBe(true);
    expect(logs.join("\n")).toMatch(/todo-/);
    expect(logs.join("\n")).toContain("ship the feature");
  });

  it("update with no args returns exit 2", () => {
    const code = runStateTodo(["update"], dir);
    expect(code).toBe(2);
  });

  it("update with invalid status returns exit 2", () => {
    const todo = addTodo("seed", { worktreeRoot: dir });
    const code = runStateTodo(["update", todo.id, "bogus"], dir);
    expect(code).toBe(2);
    expect(errs.join("\n")).toContain("invalid status 'bogus'");
  });

  it("update with non-existent id returns exit 1", () => {
    const code = runStateTodo(["update", "todo-nope", "completed"], dir);
    expect(code).toBe(1);
    expect(errs.join("\n")).toContain("no todo with id 'todo-nope'");
  });

  it("update flips status to completed and persists", () => {
    const todo = addTodo("do", { worktreeRoot: dir });
    const code = runStateTodo(["update", todo.id, "completed"], dir);
    expect(code).toBe(0);
    expect(logs.join("\n")).toContain("→ completed");
  });

  it("list with no state prints zero count", () => {
    const code = runStateTodo(["list"], dir);
    expect(code).toBe(0);
    expect(logs.join("\n")).toContain("0 todos");
  });

  it("list surfaces every stored todo by content", () => {
    addTodo("first thing", { worktreeRoot: dir });
    addTodo("second thing", { worktreeRoot: dir });
    const code = runStateTodo(["list"], dir);
    expect(code).toBe(0);
    const out = logs.join("\n");
    expect(out).toContain("first thing");
    expect(out).toContain("second thing");
  });

  it("list --filter treats the pattern literally (escapes regex metachars)", () => {
    // Two entries: one with a literal dot, one with arbitrary chars in between
    addTodo("a.b", { worktreeRoot: dir });
    addTodo("aXb", { worktreeRoot: dir });
    const code = runStateTodo(["list", "--filter", "a.b"], dir);
    expect(code).toBe(0);
    const out = logs.join("\n");
    // Filter "a.b" must match literal "a.b" but NOT "aXb" — proves
    // escapeRegExp is wired correctly. Without escaping, RegExp("a.b")
    // would match both.
    expect(out).toContain("a.b");
    expect(out).not.toContain("aXb");
  });

  it("clear removes the state file and reports yes", () => {
    addTodo("delete-me", { worktreeRoot: dir });
    const code = runStateTodo(["clear"], dir);
    expect(code).toBe(0);
    expect(logs.join("\n")).toContain("clear: yes");
    expect(existsSync(join(dir, ".omcp", "state", "todos-state.json"))).toBe(
      false,
    );
  });
});
