// Hook contract for omcp. Hooks run synchronously around Copilot tool calls
// and emit advisory text (returned as the hook payload). They are registered
// via the plugin manifest's optional `hooks:` field; v0.1 ships the type
// definitions and a couple of reference hooks (run-task-checklist, suggest-fleet).

// Aligned with the 13 valid Copilot CLI hook events (v1.0.48), verified
// against (a) docs.github.com/en/copilot/reference/hooks-configuration and
// (b) empirical extraction of the `aWr` Set from the installed Copilot CLI
// bundle (`@github/copilot/app.js`). Use the PascalCase alias where one
// exists; `subagentStart` has no alias and must be the camelCase form.
//
// Previous v0.x (pre-0.9.1) shipped Claude-Code-style names "PreSubmit",
// "PostSubmit", "PreEnd". Copilot CLI silently ignores those event names —
// any hook entries written under them never fire. Fixed in v0.9.1.
export type HookEvent =
  | "SessionStart"
  | "SessionEnd"
  | "UserPromptSubmit"
  | "PreToolUse"
  | "PostToolUse"
  | "PostToolUseFailure"
  | "ErrorOccurred"
  | "Stop"
  | "SubagentStop"
  | "subagentStart"
  | "PreCompact"
  | "PermissionRequest"
  | "Notification";

export interface HookContext {
  event: HookEvent;
  toolName?: string;
  toolArgs?: unknown;
  toolResult?: unknown;
  sessionId: string;
  cwd: string;
  /**
   * Raw stdin JSON payload from Copilot, preserved as-emitted. Used by hooks
   * that need event-specific fields not directly mapped onto HookContext —
   * e.g. Stop's `stop_reason` / `transcript_path` (snake_case) which Copilot
   * emits via the vsCodeCompat path. Field-name conventions vary by event
   * and Copilot version; hooks should tolerate both snake_case and camelCase.
   */
  payload?: Record<string, unknown>;
}

/**
 * Result returned by a hook's `run()` method.
 *
 * - `noop`           — no action; hook ran successfully but has nothing to say.
 * - `advise`         — inject advisory text into the model context
 *                      (`additionalContext` field in Copilot stdout protocol).
 * - `block`          — prevent the tool call from proceeding (PreToolUse only).
 * - `modifiedArgs`   — rewrite tool arguments before execution (PreToolUse only).
 *                      Phase 7 scope; gated on `modifiedArgs` smoke test.
 * - `modifiedResult` — rewrite tool output before the model sees it
 *                      (PostToolUse only). Phase 4 scope; gated on Phase 1
 *                      `modifiedResult` smoke test.
 * - `interrupt`      — hard-stop the agent (PermissionRequest only).
 *                      No Claude-Code equivalent.
 */
export type HookResult =
  | { kind: "noop" }
  | { kind: "advise"; text: string }
  | { kind: "block"; reason: string }
  | { kind: "modifiedArgs"; args: unknown }
  | { kind: "modifiedResult"; result: unknown }
  | { kind: "interrupt"; reason: string };

export interface Hook {
  name: string;
  events: HookEvent[];
  run(ctx: HookContext): Promise<HookResult>;
}

export interface HookRegistry {
  hooks: Hook[];
  register(hook: Hook): void;
  dispatch(ctx: HookContext): Promise<HookResult[]>;
}

export function createRegistry(): HookRegistry {
  const hooks: Hook[] = [];
  return {
    hooks,
    register(h) {
      hooks.push(h);
    },
    async dispatch(ctx) {
      const out: HookResult[] = [];
      for (const h of hooks) {
        if (!h.events.includes(ctx.event)) continue;
        out.push(await h.run(ctx));
      }
      return out;
    },
  };
}
