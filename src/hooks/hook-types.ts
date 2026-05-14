// Hook contract for omcp. Hooks run synchronously around Copilot tool calls
// and emit advisory text (returned as the hook payload). They are registered
// via the plugin manifest's optional `hooks:` field; v0.1 ships the type
// definitions and a couple of reference hooks (run-task-checklist, suggest-fleet).

export type HookEvent =
  | "PreToolUse"
  | "PostToolUse"
  | "PreSubmit"
  | "PostSubmit"
  | "SessionStart"
  | "PreEnd";

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
