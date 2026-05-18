// Reference PreToolUse hook bundled with the plugin install.
// Self-contained — no imports from ../src/ or ../dist/, so the file resolves
// cleanly inside ~/.copilot/installed-plugins/oh-my-copilot/oh-my-copilot/hooks/
// where neither directory exists.
//
// Behavior: when the current tool args mention "several files" / "in parallel"
// / "many files" / "concurrent", emit an advisory recommending /fleet for
// parallel dispatch. Otherwise return no-op.

type HookEvent =
  | "PreToolUse"
  | "PostToolUse"
  | "PreSubmit"
  | "PostSubmit"
  | "SessionStart"
  | "PreEnd";

interface HookContext {
  event: HookEvent;
  toolName?: string;
  toolArgs?: unknown;
  toolResult?: unknown;
  sessionId: string;
  cwd: string;
}

type HookResult =
  | { kind: "noop" }
  | { kind: "advise"; text: string }
  | { kind: "block"; reason: string };

interface Hook {
  name: string;
  events: HookEvent[];
  run(ctx: HookContext): Promise<HookResult>;
}

const TRIGGERS = ["several files", "many files", "in parallel", "concurrent"];

export const suggestFleetHook: Hook = {
  name: "suggest-fleet",
  events: ["PreToolUse"],
  async run(ctx: HookContext): Promise<HookResult> {
    const blob = JSON.stringify(ctx.toolArgs ?? "").toLowerCase();
    if (TRIGGERS.some((t) => blob.includes(t))) {
      return {
        kind: "advise",
        text:
          "Consider `/fleet` to dispatch parallel subagents for independent work; sequential single-threaded execution is slower for 2+ unrelated targets.",
      };
    }
    return { kind: "noop" };
  },
};

export default suggestFleetHook;
export const hook = suggestFleetHook;
