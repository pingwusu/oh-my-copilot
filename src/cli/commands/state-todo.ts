// `omcp state todo <subcommand>` — typed CLI surface over todo-state lib.
// Branch B step 3 of next-session-ralplan.
//
// The --filter pattern for `list` is treated as a literal string (escaped
// via runtime/escape-regexp before being compiled into a RegExp) so that a
// dot in a todo content matches a dot in the filter, not "any character."

import {
  addTodo,
  clearTodoState,
  getTodos,
  updateTodo,
  type Todo,
  type TodoStatus,
} from "../../lib/todo-state.js";
import { escapeRegExp } from "../../runtime/escape-regexp.js";

const VALID_STATUSES: readonly TodoStatus[] = [
  "pending",
  "in_progress",
  "completed",
  "cancelled",
];

function isTodoStatus(value: string): value is TodoStatus {
  return (VALID_STATUSES as readonly string[]).includes(value);
}

function formatTodo(todo: Todo): string {
  const tag = todo.status.padEnd(11, " ");
  return `  [${tag}] ${todo.id}  ${todo.content}`;
}

function formatList(todos: Todo[]): string {
  if (todos.length === 0) return "omcp state todo: 0 todos";
  return [`omcp state todo (${todos.length}):`, ...todos.map(formatTodo)].join(
    "\n",
  );
}

interface ListFilter {
  pattern?: string;
}

function parseListFlags(args: string[]): ListFilter {
  const out: ListFilter = {};
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    if (a === "--filter") {
      out.pattern = args[i + 1];
      i += 1;
    }
  }
  return out;
}

export function runStateTodo(
  args: string[],
  worktreeRoot?: string,
): number {
  const sub = args[0];
  if (!sub) {
    console.error(
      "omcp state todo: missing subcommand (add <title> | update <id> <status> | list [--filter <pattern>] | clear)",
    );
    return 2;
  }

  switch (sub) {
    case "add": {
      const title = args.slice(1).join(" ").trim();
      if (!title) {
        console.error("omcp state todo add: <title> argument required");
        return 2;
      }
      const todo = addTodo(title, { worktreeRoot });
      console.log(`omcp state todo add: ${todo.id} (${todo.content})`);
      return 0;
    }

    case "update": {
      const [id, status] = args.slice(1);
      if (!id || !status) {
        console.error("omcp state todo update: <id> <status> required");
        return 2;
      }
      if (!isTodoStatus(status)) {
        console.error(
          `omcp state todo update: invalid status '${status}' (pending | in_progress | completed | cancelled)`,
        );
        return 2;
      }
      const updated = updateTodo(id, { status }, worktreeRoot);
      if (!updated) {
        console.error(`omcp state todo update: no todo with id '${id}'`);
        return 1;
      }
      console.log(`omcp state todo update: ${updated.id} → ${updated.status}`);
      return 0;
    }

    case "list": {
      const flags = parseListFlags(args.slice(1));
      let todos = getTodos(worktreeRoot);
      if (flags.pattern !== undefined) {
        const re = new RegExp(escapeRegExp(flags.pattern));
        todos = todos.filter((t) => re.test(t.content));
      }
      console.log(formatList(todos));
      return 0;
    }

    case "clear": {
      const ok = clearTodoState(worktreeRoot);
      console.log(`omcp state todo clear: ${ok ? "yes" : "failed"}`);
      return ok ? 0 : 1;
    }

    default:
      console.error(
        `omcp state todo: unknown subcommand '${sub}' (add <title> | update <id> <status> | list [--filter <pattern>] | clear)`,
      );
      return 2;
  }
}
