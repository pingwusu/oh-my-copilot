// `omcp state ultrawork <subcommand>` — typed CLI surface over the
// ultrawork-state lib. Branch B step 2 of next-session-ralplan.
//
// Nested under `omcp state` (not top-level) — `omcp ultrawork` is already a
// mode launcher (omcp.ts MODE_COMMANDS).

import {
  activateUltrawork,
  clearUltraworkState,
  readUltraworkState,
  type UltraworkState,
} from "../../lib/ultrawork-state.js";

function formatStatus(state: UltraworkState | null): string {
  if (!state) return "omcp state ultrawork: no active state";
  const lines = [
    `omcp state ultrawork:`,
    `  active:              ${state.active}`,
    `  startedAt:           ${state.startedAt}`,
    `  lastCheckedAt:       ${state.lastCheckedAt}`,
    `  reinforcementCount:  ${state.reinforcementCount}`,
    `  originalPrompt:      ${state.originalPrompt}`,
  ];
  if (state.linkedToRalph !== undefined) {
    lines.push(`  linkedToRalph:       ${state.linkedToRalph}`);
  }
  return lines.join("\n");
}

export function runStateUltrawork(
  args: string[],
  worktreeRoot?: string,
): number {
  const sub = args[0];
  if (!sub) {
    console.error(
      "omcp state ultrawork: missing subcommand (status | start <prompt> | clear)",
    );
    return 2;
  }

  switch (sub) {
    case "status": {
      console.log(formatStatus(readUltraworkState(worktreeRoot)));
      return 0;
    }

    case "start": {
      const prompt = args.slice(1).join(" ").trim();
      if (!prompt) {
        console.error("omcp state ultrawork start: <prompt> argument required");
        return 2;
      }
      const ok = activateUltrawork(prompt, { worktreeRoot });
      if (!ok) {
        console.error("omcp state ultrawork start: write failed");
        return 1;
      }
      console.log(`omcp state ultrawork start: activated (${prompt})`);
      return 0;
    }

    case "clear": {
      const ok = clearUltraworkState(worktreeRoot);
      console.log(`omcp state ultrawork clear: ${ok ? "yes" : "failed"}`);
      return ok ? 0 : 1;
    }

    default:
      console.error(
        `omcp state ultrawork: unknown subcommand '${sub}' (status | start <prompt> | clear)`,
      );
      return 2;
  }
}
