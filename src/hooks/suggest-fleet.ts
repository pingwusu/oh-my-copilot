// Hook: when the agent appears to be doing repetitive single-threaded work that
// would benefit from parallelism, advise switching to /fleet.

import type { Hook, HookContext, HookResult } from "./hook-types.js";

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
