// Todos element — todos:done/total with optional working hint.

import { cyan, dim, green, yellow } from "../colors.js";
import type { HudState } from "../types.js";

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1)}…`;
}

export function renderTodos(state: HudState): string | null {
  const todos = state.todos;
  if (!todos || todos.length === 0) return null;
  const completed = todos.filter((t) => t.status === "completed").length;
  const total = todos.length;
  const percent = total > 0 ? (completed / total) * 100 : 0;
  let color: (t: string, env?: NodeJS.ProcessEnv) => string;
  if (percent >= 80) color = green;
  else if (percent >= 50) color = yellow;
  else color = cyan;

  let out = `todos:${color(`${completed}/${total}`, state.env)}`;
  const inProgress = todos.find((t) => t.status === "in_progress");
  if (inProgress) {
    const txt = inProgress.activeForm || inProgress.content || "...";
    out += ` ${dim(`(working: ${truncate(txt, 30)})`, state.env)}`;
  }
  return out;
}
