// Todo state — todo-continuation persistence + Stop-event detection for omcp.
//
// Ported (with substantial simplification) from
// omc/src/hooks/todo-continuation/index.ts. The omc port scanned both
// Claude Code's modern Task system (~/.claude/tasks/{sessionId}/) and a
// legacy todo file format. Copilot CLI exposes neither, so omcp owns its
// todo state at .omcp/state/todos.json and reads only that.
//
// The Stop-event detection helpers (isUserAbort / isContextLimitStop /
// isRateLimitStop / isAuthenticationError / isExplicitCancelCommand) are
// language-agnostic: they pattern-match free-form stop_reason /
// endTurnReason / reason strings that any host CLI may supply.

import { existsSync, readFileSync, unlinkSync } from "node:fs";

import { atomicWriteFileSync } from "../runtime/atomic-write.js";
import { ensureOmcpDir, resolveStatePath } from "./worktree-paths.js";

// ──────────────────────────────────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────────────────────────────────

/** Allowed states a single todo can be in. */
export type TodoStatus = "pending" | "in_progress" | "completed" | "cancelled";

/** Optional priority tag — purely informational, not used by ordering today. */
export type TodoPriority = "low" | "medium" | "high";

/** A single todo entry. */
export interface Todo {
  id: string;
  content: string;
  status: TodoStatus;
  priority?: TodoPriority;
  /** ISO timestamp of first creation. */
  createdAt: string;
  /** ISO timestamp of the most recent status/content change. */
  updatedAt: string;
}

/** Persisted shape of the todo state file. */
export interface TodoState {
  todos: Todo[];
  /** ISO timestamp of the last write — convenience for stale detection. */
  updatedAt: string;
}

/**
 * Result of `checkIncompleteTodos`.
 *
 * `source` mirrors omc's three-valued field but omcp only ever populates
 * `"todo"` or `"none"` — we have no separate Task system to merge with.
 */
export interface IncompleteTodosResult {
  count: number;
  todos: Todo[];
  total: number;
  source: "todo" | "none";
}

/**
 * Context payload delivered by a Stop-style hook event.
 *
 * Field names cover both camelCase and snake_case variants so this works
 * across Copilot CLI versions and any host that adopts similar
 * conventions.
 */
export interface StopContext {
  stop_reason?: string;
  stopReason?: string;
  end_turn_reason?: string;
  endTurnReason?: string;
  /** Generic free-form `reason` field that some hooks emit. */
  reason?: string;
  user_requested?: boolean;
  userRequested?: boolean;
  /** Most recent user prompt — used by `isExplicitCancelCommand`. */
  prompt?: string;
  tool_name?: string;
  toolName?: string;
  tool_input?: unknown;
  toolInput?: unknown;
}

// ──────────────────────────────────────────────────────────────────────────
// File paths
// ──────────────────────────────────────────────────────────────────────────

const STATE_NAME = "todos";

function statePath(worktreeRoot?: string): string {
  return resolveStatePath(STATE_NAME, worktreeRoot);
}

// ──────────────────────────────────────────────────────────────────────────
// State CRUD
// ──────────────────────────────────────────────────────────────────────────

const TODO_STATUSES: readonly TodoStatus[] = [
  "pending",
  "in_progress",
  "completed",
  "cancelled",
];

function isValidTodo(value: unknown): value is Todo {
  if (!value || typeof value !== "object") return false;
  const t = value as Record<string, unknown>;
  return (
    typeof t.id === "string" &&
    typeof t.content === "string" &&
    typeof t.status === "string" &&
    TODO_STATUSES.includes(t.status as TodoStatus) &&
    typeof t.createdAt === "string" &&
    typeof t.updatedAt === "string"
  );
}

/** Read the todo state file, returning null when absent or invalid. */
export function readTodoState(worktreeRoot?: string): TodoState | null {
  const file = statePath(worktreeRoot);
  if (!existsSync(file)) return null;

  try {
    const parsed = JSON.parse(readFileSync(file, "utf-8")) as Partial<TodoState>;
    if (!Array.isArray(parsed.todos)) return null;
    const todos = parsed.todos.filter(isValidTodo);
    const updatedAt = typeof parsed.updatedAt === "string"
      ? parsed.updatedAt
      : new Date().toISOString();
    return { todos, updatedAt };
  } catch {
    return null;
  }
}

/** Persist a todo state atomically. */
export function writeTodoState(
  state: TodoState,
  worktreeRoot?: string,
): boolean {
  try {
    ensureOmcpDir("state", worktreeRoot);
    atomicWriteFileSync(statePath(worktreeRoot), JSON.stringify(state, null, 2));
    return true;
  } catch {
    return false;
  }
}

/** Remove the todo state file if it exists. */
export function clearTodoState(worktreeRoot?: string): boolean {
  const file = statePath(worktreeRoot);
  if (!existsSync(file)) return true;
  try {
    unlinkSync(file);
    return true;
  } catch {
    return false;
  }
}

// ──────────────────────────────────────────────────────────────────────────
// Todo manipulation
// ──────────────────────────────────────────────────────────────────────────

let idCounter = 0;
function generateTodoId(): string {
  idCounter += 1;
  return `todo-${Date.now().toString(36)}-${idCounter.toString(36)}`;
}

/** Add a new todo, returning the created entry. */
export function addTodo(
  content: string,
  opts: { priority?: TodoPriority; worktreeRoot?: string } = {},
): Todo {
  const now = new Date().toISOString();
  const todo: Todo = {
    id: generateTodoId(),
    content,
    status: "pending",
    priority: opts.priority,
    createdAt: now,
    updatedAt: now,
  };

  const current = readTodoState(opts.worktreeRoot) ?? {
    todos: [],
    updatedAt: now,
  };
  writeTodoState(
    { todos: [...current.todos, todo], updatedAt: now },
    opts.worktreeRoot,
  );
  return todo;
}

/**
 * Apply partial updates to the todo with `id`.
 *
 * Returns the updated todo, or null when no such todo exists.
 */
export function updateTodo(
  id: string,
  updates: Partial<Pick<Todo, "content" | "status" | "priority">>,
  worktreeRoot?: string,
): Todo | null {
  const state = readTodoState(worktreeRoot);
  if (!state) return null;

  const idx = state.todos.findIndex((t) => t.id === id);
  if (idx === -1) return null;

  const now = new Date().toISOString();
  const next: Todo = {
    ...state.todos[idx],
    ...updates,
    updatedAt: now,
  };
  state.todos[idx] = next;
  state.updatedAt = now;
  return writeTodoState(state, worktreeRoot) ? next : null;
}

/** All todos in the state file (empty array when no state exists). */
export function getTodos(worktreeRoot?: string): Todo[] {
  return readTodoState(worktreeRoot)?.todos ?? [];
}

/** Subset of todos that are not completed/cancelled. */
export function getIncompleteTodos(worktreeRoot?: string): Todo[] {
  return getTodos(worktreeRoot).filter(
    (t) => t.status !== "completed" && t.status !== "cancelled",
  );
}

// ──────────────────────────────────────────────────────────────────────────
// Stop-event detection helpers
// ──────────────────────────────────────────────────────────────────────────

function getStopReasonFields(context?: StopContext): string[] {
  if (!context) return [];
  return [
    context.stop_reason,
    context.stopReason,
    context.end_turn_reason,
    context.endTurnReason,
    context.reason,
  ]
    .filter(
      (value): value is string =>
        typeof value === "string" && value.trim().length > 0,
    )
    .map((value) => value.toLowerCase().replace(/[\s-]+/g, "_"));
}

/**
 * Detect that the user explicitly aborted (vs. natural completion).
 *
 * Checks `user_requested`/`userRequested` booleans, exact-match abort
 * tokens (`abort`, `aborted`, `cancel`, `interrupt`), and substring
 * matches for compound markers (`user_cancel`, `user_interrupt`,
 * `ctrl_c`, `manual_stop`).
 */
export function isUserAbort(context?: StopContext): boolean {
  if (!context) return false;
  if (context.user_requested || context.userRequested) return true;

  const exactPatterns = ["aborted", "abort", "cancel", "interrupt"];
  const substringPatterns = [
    "user_cancel",
    "user_interrupt",
    "ctrl_c",
    "manual_stop",
  ];

  const matchesAbort = (value: string): boolean =>
    exactPatterns.some((p) => value === p) ||
    substringPatterns.some((p) => value.includes(p));

  const reasons = [
    (context.stop_reason ?? context.stopReason ?? "").toLowerCase(),
    (context.end_turn_reason ?? context.endTurnReason ?? "").toLowerCase(),
  ];
  return reasons.some(matchesAbort);
}

/**
 * Detect an explicit `/cancel` / `cancelomc` invocation.
 *
 * Stricter than `isUserAbort` — used to short-circuit continuation re-
 * enforcement when the user has signalled deliberate exit. Recognizes:
 *   - `/cancel`, `/cancel --force`, `/oh-my-copilot:cancel`,
 *   - `cancelomc` / `stopomc` keyword prompts,
 *   - stop_reason / end_turn_reason values matching cancel sentinels,
 *   - Skill-tool invocations targeting a `*:cancel` skill.
 */
export function isExplicitCancelCommand(context?: StopContext): boolean {
  if (!context) return false;

  const prompt = (context.prompt ?? "").trim();
  if (prompt) {
    const slashCancelPattern =
      /^\/(?:oh-my-copilot:)?cancel(?:\s+--force)?\s*$/i;
    const keywordCancelPattern = /^(?:cancelomc|stopomc)\s*$/i;
    if (slashCancelPattern.test(prompt) || keywordCancelPattern.test(prompt)) {
      return true;
    }
  }

  const reason = (context.stop_reason ?? context.stopReason ?? "").toLowerCase();
  const endTurnReason = (context.end_turn_reason ?? context.endTurnReason ?? "")
    .toLowerCase();
  const explicitReasonPatterns: RegExp[] = [
    /^cancel$/,
    /^cancelled$/,
    /^canceled$/,
    /^user_cancel$/,
    /^cancel_force$/,
    /^force_cancel$/,
  ];
  if (
    explicitReasonPatterns.some(
      (p) => p.test(reason) || p.test(endTurnReason),
    )
  ) {
    return true;
  }

  const toolName = String(context.tool_name ?? context.toolName ?? "")
    .toLowerCase();
  const toolInput = (context.tool_input ?? context.toolInput) as
    | Record<string, unknown>
    | undefined;
  if (toolName.includes("skill") && toolInput && typeof toolInput.skill === "string") {
    const skill = toolInput.skill.toLowerCase();
    if (skill === "oh-my-copilot:cancel" || skill.endsWith(":cancel")) {
      return true;
    }
  }

  return false;
}

/**
 * Detect that the stop is due to a context-window limit.
 *
 * Re-enforcing continuation on these stops would deadlock: the agent
 * cannot compact because it cannot stop, and cannot continue because the
 * context is full. Patterns: `context_limit`, `context_window`,
 * `context_exceeded`, `context_full`, `max_context`, `token_limit`,
 * `max_tokens`, `conversation_too_long`, `input_too_long`.
 */
export function isContextLimitStop(context?: StopContext): boolean {
  const contextPatterns = [
    "context_limit",
    "context_window",
    "context_exceeded",
    "context_full",
    "max_context",
    "token_limit",
    "max_tokens",
    "conversation_too_long",
    "input_too_long",
  ];
  return getStopReasonFields(context).some((value) =>
    contextPatterns.some((p) => value.includes(p)),
  );
}

/**
 * Detect rate-limit / quota / capacity stops.
 *
 * Re-enforcing continuation on these stops produces an infinite retry
 * loop. Patterns include `rate_limit`, `429`, `quota_exhausted`,
 * `overloaded`, etc.
 */
export function isRateLimitStop(context?: StopContext): boolean {
  if (!context) return false;
  const reason = (context.stop_reason ?? context.stopReason ?? "").toLowerCase();
  const endTurnReason = (context.end_turn_reason ?? context.endTurnReason ?? "")
    .toLowerCase();

  const rateLimitPatterns = [
    "rate_limit",
    "rate_limited",
    "ratelimit",
    "too_many_requests",
    "429",
    "quota_exceeded",
    "quota_limit",
    "quota_exhausted",
    "request_limit",
    "api_limit",
    "overloaded",
    "capacity",
  ];
  return rateLimitPatterns.some(
    (p) => reason.includes(p) || endTurnReason.includes(p),
  );
}

/**
 * Stop-reason substrings that signal an authentication / authorization
 * failure. Kept as a frozen tuple so consumers can re-use the same list
 * without risk of mutation.
 */
export const AUTHENTICATION_ERROR_PATTERNS = Object.freeze([
  "authentication_error",
  "authentication_failed",
  "auth_error",
  "unauthorized",
  "unauthorised",
  "401",
  "403",
  "forbidden",
  "invalid_token",
  "token_invalid",
  "token_expired",
  "expired_token",
  "oauth_expired",
  "oauth_token_expired",
  "invalid_grant",
  "insufficient_scope",
] as const);

/** Detect auth-failure stops so the continuation loop does not re-trigger. */
export function isAuthenticationError(context?: StopContext): boolean {
  if (!context) return false;
  const reason = (context.stop_reason ?? context.stopReason ?? "").toLowerCase();
  const endTurnReason = (context.end_turn_reason ?? context.endTurnReason ?? "")
    .toLowerCase();
  return AUTHENTICATION_ERROR_PATTERNS.some(
    (pattern) =>
      reason.includes(pattern) || endTurnReason.includes(pattern),
  );
}

// ──────────────────────────────────────────────────────────────────────────
// Aggregate todo check + formatting
// ──────────────────────────────────────────────────────────────────────────

/**
 * Aggregate incomplete-todo check used by a Stop-style hook.
 *
 * Returns an empty result (`source: "none"`) when the stop context
 * indicates a user abort — re-enforcement should not fire in that case.
 */
export function checkIncompleteTodos(
  opts: { worktreeRoot?: string; stopContext?: StopContext } = {},
): IncompleteTodosResult {
  if (isUserAbort(opts.stopContext)) {
    return { count: 0, todos: [], total: 0, source: "none" };
  }

  const all = getTodos(opts.worktreeRoot);
  const incomplete = all.filter(
    (t) => t.status !== "completed" && t.status !== "cancelled",
  );

  return {
    count: incomplete.length,
    todos: incomplete,
    total: all.length,
    source: incomplete.length > 0 ? "todo" : "none",
  };
}

/**
 * Pick the next todo to surface to the agent.
 *
 * Prefers an `in_progress` todo (resuming current work) over the first
 * `pending` one.
 */
export function getNextPendingTodo(
  result: IncompleteTodosResult,
): Todo | null {
  const inProgress = result.todos.find((t) => t.status === "in_progress");
  if (inProgress) return inProgress;
  return result.todos.find((t) => t.status === "pending") ?? null;
}

/** Human-readable summary of an `IncompleteTodosResult`. */
export function formatTodoStatus(result: IncompleteTodosResult): string {
  if (result.count === 0) {
    return `All tasks complete (${result.total} total)`;
  }
  return `${result.total - result.count}/${result.total} completed, ${result.count} remaining`;
}

// ──────────────────────────────────────────────────────────────────────────
// Continuation prompt
// ──────────────────────────────────────────────────────────────────────────

/**
 * The continuation prompt injected on Stop when incomplete todos remain.
 *
 * Mirrors omc's TODO_CONTINUATION_PROMPT pattern: surfaces remaining
 * todos and asks the agent to resume work instead of stopping early.
 */
export const TODO_CONTINUATION_PROMPT = `<todo-continuation>

[INCOMPLETE TODOS — continue working]

You have pending todos that are not yet complete. Resume work on the
next pending or in-progress item before stopping.

Use updateTodo(id, { status: "completed" }) when each item is genuinely
done — do not pre-mark items that are still in progress.

</todo-continuation>
`;
