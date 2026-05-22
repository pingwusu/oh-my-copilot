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
}

export type HookResult =
  | { kind: "noop" }
  | { kind: "advise"; text: string }
  | { kind: "block"; reason: string };

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
