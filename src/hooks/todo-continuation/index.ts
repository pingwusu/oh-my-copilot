/**
 * Todo Continuation Hook
 *
 * Fires on the Stop event. Reads the project's todo state and, when
 * incomplete todos remain, injects TODO_CONTINUATION_PROMPT as an
 * `advise` result so the agent resumes work instead of stopping early.
 *
 * No-ops when:
 *   - The stop was a user abort / explicit cancel
 *   - The stop was a context-limit, rate-limit, or auth error
 *   - No todo state file exists
 *   - All todos are completed or cancelled
 *
 * State read via: src/lib/todo-state.ts (readTodoState / checkIncompleteTodos)
 *
 * Subscribes to: Stop
 */

import type { Hook, HookContext, HookResult } from "../hook-types.js";
import {
  checkIncompleteTodos,
  isContextLimitStop,
  isRateLimitStop,
  isAuthenticationError,
  isExplicitCancelCommand,
  TODO_CONTINUATION_PROMPT,
  formatTodoStatus,
  getNextPendingTodo,
} from "../../lib/todo-state.js";
import type { StopContext } from "../../lib/todo-state.js";

/**
 * Extract a StopContext from the raw HookContext toolArgs/toolResult fields.
 *
 * Copilot passes the stop payload as `toolArgs` on the Stop event.
 * Accept any object shape — missing fields default to undefined.
 */
function extractStopContext(ctx: HookContext): StopContext {
  const raw = (ctx.toolArgs ?? ctx.toolResult ?? {}) as Record<string, unknown>;
  return {
    stop_reason: raw.stop_reason as string | undefined,
    stopReason: raw.stopReason as string | undefined,
    end_turn_reason: raw.end_turn_reason as string | undefined,
    endTurnReason: raw.endTurnReason as string | undefined,
    reason: raw.reason as string | undefined,
    user_requested: raw.user_requested as boolean | undefined,
    userRequested: raw.userRequested as boolean | undefined,
    prompt: raw.prompt as string | undefined,
    tool_name: raw.tool_name as string | undefined,
    toolName: raw.toolName as string | undefined,
    tool_input: raw.tool_input,
    toolInput: raw.toolInput,
  };
}

/**
 * Create the todo-continuation Hook object.
 *
 * Subscribes to Stop.
 * Returns `{ kind: "advise", text }` when pending/in-progress todos remain,
 * `{ kind: "noop" }` otherwise.
 */
export function createTodoContinuationHook(): Hook {
  return {
    name: "todo-continuation",
    events: ["Stop"],

    async run(ctx: HookContext): Promise<HookResult> {
      const stopCtx = extractStopContext(ctx);

      // Skip continuation for stops that would deadlock or are user-initiated
      if (
        isContextLimitStop(stopCtx) ||
        isRateLimitStop(stopCtx) ||
        isAuthenticationError(stopCtx) ||
        isExplicitCancelCommand(stopCtx)
      ) {
        return { kind: "noop" };
      }

      const result = checkIncompleteTodos({
        worktreeRoot: ctx.cwd,
        stopContext: stopCtx,
      });

      if (result.count === 0) {
        return { kind: "noop" };
      }

      const next = getNextPendingTodo(result);
      const statusLine = formatTodoStatus(result);
      const nextLine = next
        ? `\nNext item: [${next.status}] ${next.content}`
        : "";

      return {
        kind: "advise",
        text: `${TODO_CONTINUATION_PROMPT}\nStatus: ${statusLine}${nextLine}`,
      };
    },
  };
}
