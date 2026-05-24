/**
 * Persistent Mode Hook
 *
 * Fires on the Stop event. Enforces work continuation for active persistent
 * modes in priority order: Ralph > Ultrawork > Todo-continuation.
 *
 * No-ops when:
 *   - Stop is a context-limit, rate-limit, or auth error (would deadlock)
 *   - Stop is a user abort or explicit /cancel
 *   - No active persistent mode state exists
 *
 * Returns `{ kind: "advise", text }` to inject continuation context into the
 * next iteration. Copilot's `Stop` event does not support hard-blocking, so
 * `advise` is the correct result kind for continuation prompts.
 *
 * State is read via omcp lib modules (never direct fs):
 *   - ralph:      src/lib/ralph-state.ts
 *   - ultrawork:  src/lib/ultrawork-state.ts
 *   - todo:       src/lib/todo-state.ts
 *
 * Subscribes to: Stop
 */

import type { Hook, HookContext, HookResult } from "../hook-types.js";
import {
  readRalphState,
  writeRalphState,
  incrementRalphIteration,
  clearRalphState,
  getPrdCompletionStatus,
  getRalphContext,
  detectArchitectApproval,
  detectArchitectRejection,
} from "../../lib/ralph-state.js";
import {
  readUltraworkState,
  incrementReinforcement,
  deactivateUltrawork,
  getUltraworkPersistenceMessage,
} from "../../lib/ultrawork-state.js";
import {
  checkIncompleteTodos,
  getNextPendingTodo,
  formatTodoStatus,
  TODO_CONTINUATION_PROMPT,
  isContextLimitStop,
  isRateLimitStop,
  isAuthenticationError,
  isExplicitCancelCommand,
  isUserAbort,
  type StopContext,
} from "../../lib/todo-state.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_TODO_CONTINUATION_ATTEMPTS = 5;

/** In-memory attempt counter per session. Prevents infinite todo loops. */
const todoContinuationAttempts = new Map<string, number>();

// ---------------------------------------------------------------------------
// StopContext extraction
// ---------------------------------------------------------------------------

function extractStopContext(ctx: HookContext): StopContext {
  // Copilot emits Stop-event fields directly on the stdin payload root
  // (`stop_reason`, `transcript_path`, `hook_event_name`, ...). Older host
  // CLIs surface info via `toolArgs`/`toolResult`. Prefer the raw payload
  // when present so we see Copilot's snake_case fields; fall back to the
  // legacy tool-args/result locations for compatibility.
  const raw = (ctx.payload ?? ctx.toolArgs ?? ctx.toolResult ?? {}) as Record<
    string,
    unknown
  >;
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
 * Extract a plain-text string from the Stop hook context for pattern matching.
 *
 * Copilot may surface the session's last response or transcript in toolResult
 * or toolArgs. We join all string-valued leaves into one searchable blob so
 * detectArchitectApproval can scan it regardless of where Copilot puts it.
 */
function extractContextText(ctx: HookContext): string {
  const parts: string[] = [];
  for (const bag of [ctx.toolResult, ctx.toolArgs]) {
    if (!bag) continue;
    if (typeof bag === "string") {
      parts.push(bag);
    } else if (typeof bag === "object" && bag !== null) {
      for (const v of Object.values(bag as Record<string, unknown>)) {
        if (typeof v === "string") parts.push(v);
      }
    }
  }
  return parts.join("\n");
}

// ---------------------------------------------------------------------------
// Ralph check
// ---------------------------------------------------------------------------

function checkRalph(
  worktreeRoot: string,
  contextText: string,
): HookResult | null {
  const state = readRalphState(worktreeRoot);
  if (!state || !state.active) return null;

  // Check for architect approval in the stop context text.
  // When detected: persist architectApproved=true to state so the next
  // iteration check (state.architectApproved) also exits cleanly.
  if (detectArchitectApproval(contextText)) {
    writeRalphState({ ...state, architectApproved: true }, worktreeRoot);
    clearRalphState(worktreeRoot);
    deactivateUltrawork(worktreeRoot);
    return {
      kind: "advise",
      text: "[RALPH LOOP COMPLETE — VERIFIED] Architect verified task completion. Ralph loop ending.",
    };
  }

  // If architectApproved was already set in a prior iteration, honor it — exit cleanly.
  if (state.architectApproved) {
    clearRalphState(worktreeRoot);
    deactivateUltrawork(worktreeRoot);
    return { kind: "noop" };
  }

  // PRD-based completion: all stories pass → exit cleanly (noop).
  // The architect-approval check above handles approval detection; if we
  // reach here with allComplete, ralph is done — noop lets Copilot stop.
  const prdStatus = getPrdCompletionStatus(worktreeRoot);
  if (prdStatus.hasPrd && prdStatus.allComplete) {
    clearRalphState(worktreeRoot);
    return { kind: "noop" };
  }

  // Check for architect rejection in context text
  if (contextText) {
    const rejection = detectArchitectRejection(contextText);
    if (rejection.rejected) {
      // Write rejection feedback back to state for next iteration
      const updated = readRalphState(worktreeRoot);
      if (updated) {
        writeRalphState(
          { ...updated, architectApproved: false },
          worktreeRoot,
        );
      }
    }
  }

  // Increment iteration and continue
  const newState = incrementRalphIteration(worktreeRoot);
  if (!newState) return null;

  const ralphContext = getRalphContext(worktreeRoot);
  const prdInstruction = prdStatus.hasPrd
    ? `2. Check prd.json — verify the current story's acceptance criteria are met, then mark it passes: true. Are ALL stories complete?`
    : `2. Check your todo list — are ALL items marked complete?`;

  return {
    kind: "advise",
    text: `<ralph-continuation>

[RALPH — ITERATION ${newState.iteration}]

The task is NOT complete yet. Continue working.
${ralphContext}
CRITICAL INSTRUCTIONS:
1. Review your progress and the original task
${prdInstruction}
3. Continue from where you left off
4. When FULLY complete (after architect/critic verification), run \`/oh-my-copilot:cancel\` to exit cleanly
5. Do NOT stop until the task is truly done

${newState.prompt ? `Original task: ${newState.prompt}` : ""}

</ralph-continuation>

---

`,
  };
}

// ---------------------------------------------------------------------------
// Ultrawork check
// ---------------------------------------------------------------------------

function checkUltrawork(worktreeRoot: string): HookResult | null {
  const state = readUltraworkState(worktreeRoot);
  if (!state || !state.active) return null;

  const newState = incrementReinforcement(worktreeRoot);
  if (!newState) return null;

  return {
    kind: "advise",
    text: getUltraworkPersistenceMessage(newState),
  };
}

// ---------------------------------------------------------------------------
// Todo continuation check
// ---------------------------------------------------------------------------

function checkTodoContinuation(
  worktreeRoot: string,
  sessionId?: string,
  stopCtx?: StopContext,
): HookResult | null {
  const result = checkIncompleteTodos({ worktreeRoot, stopContext: stopCtx });
  if (result.count === 0) {
    if (sessionId) todoContinuationAttempts.delete(sessionId);
    return null;
  }

  // Limit attempts to prevent infinite loops when agent is stuck
  const key = sessionId ?? "global";
  if (todoContinuationAttempts.size > 200) todoContinuationAttempts.clear();
  const attempts = (todoContinuationAttempts.get(key) ?? 0) + 1;
  todoContinuationAttempts.set(key, attempts);

  if (attempts > MAX_TODO_CONTINUATION_ATTEMPTS) {
    todoContinuationAttempts.delete(key);
    return {
      kind: "advise",
      text: `[TODO CONTINUATION LIMIT] Attempted ${MAX_TODO_CONTINUATION_ATTEMPTS} continuations without progress. ${result.count} todo(s) remain incomplete. Consider reviewing stuck items or asking the user for guidance.`,
    };
  }

  const next = getNextPendingTodo(result);
  const statusLine = formatTodoStatus(result);
  const nextLine = next ? `\nNext item: [${next.status}] ${next.content}` : "";
  const attemptInfo =
    attempts > 1
      ? `\n[Continuation attempt ${attempts}/${MAX_TODO_CONTINUATION_ATTEMPTS}]`
      : "";

  return {
    kind: "advise",
    text: `${TODO_CONTINUATION_PROMPT}\nStatus: ${statusLine}${nextLine}${attemptInfo}`,
  };
}

// ---------------------------------------------------------------------------
// Hook factory
// ---------------------------------------------------------------------------

export function createPersistentModeHook(): Hook {
  return {
    name: "persistent-mode",
    events: ["Stop"],

    async run(ctx: HookContext): Promise<HookResult> {
      const stopCtx = extractStopContext(ctx);

      // Never block context-limit, rate-limit, auth, or explicit cancel stops
      if (
        isContextLimitStop(stopCtx) ||
        isRateLimitStop(stopCtx) ||
        isAuthenticationError(stopCtx) ||
        isExplicitCancelCommand(stopCtx) ||
        isUserAbort(stopCtx)
      ) {
        return { kind: "noop" };
      }

      const worktreeRoot = ctx.cwd;
      const sessionId = ctx.sessionId || undefined;

      // Extract text from the stop context for architect-approval detection.
      // Copilot may surface the session transcript or last response in toolResult.
      const stopContextText = extractContextText(ctx);

      // Priority 1: Ralph
      const ralphResult = checkRalph(worktreeRoot, stopContextText);
      if (ralphResult) return ralphResult;

      // Priority 2: Ultrawork
      const ultraworkResult = checkUltrawork(worktreeRoot);
      if (ultraworkResult) return ultraworkResult;

      // Priority 3: Todo continuation
      const todoResult = checkTodoContinuation(worktreeRoot, sessionId, stopCtx);
      if (todoResult) return todoResult;

      return { kind: "noop" };
    },
  };
}
