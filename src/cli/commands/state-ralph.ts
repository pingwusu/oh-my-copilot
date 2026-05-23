// `omcp state ralph <subcommand>` — typed CLI surface over ralph-state lib.
//
// Branch B of next-session-ralplan.md. The state-inspection subcommands nest
// under `omcp state` because top-level `omcp ralph` is already registered as
// a mode launcher (src/cli/omcp.ts MODE_COMMANDS).
//
// Delegates to src/lib/ralph-state.ts so the read/write semantics stay
// consistent with the actual ralph mode runner.

import {
  clearRalphState,
  incrementRalphIteration,
  readRalphState,
  writeRalphState,
  type RalphState,
} from "../../lib/ralph-state.js";

function formatStatus(state: RalphState | null): string {
  if (!state) return "omcp state ralph: no active state";
  const lines = [
    `omcp state ralph:`,
    `  active:       ${state.active}`,
    `  iteration:    ${state.iteration}`,
    `  lastFiredAt:  ${state.lastFiredAt}`,
    `  prompt:       ${state.prompt}`,
  ];
  if (state.prdPath) lines.push(`  prdPath:      ${state.prdPath}`);
  if (state.architectApproved !== undefined) {
    lines.push(`  approved:     ${state.architectApproved}`);
  }
  return lines.join("\n");
}

export function runStateRalph(args: string[], worktreeRoot?: string): number {
  const sub = args[0];
  if (!sub) {
    console.error(
      "omcp state ralph: missing subcommand (status | start <task> | iterate | clear)",
    );
    return 2;
  }

  switch (sub) {
    case "status": {
      console.log(formatStatus(readRalphState(worktreeRoot)));
      return 0;
    }

    case "start": {
      const task = args.slice(1).join(" ").trim();
      if (!task) {
        console.error("omcp state ralph start: <task> argument required");
        return 2;
      }
      const state: RalphState = {
        active: true,
        iteration: 1,
        lastFiredAt: new Date().toISOString(),
        prompt: task,
      };
      if (!writeRalphState(state, worktreeRoot)) {
        console.error("omcp state ralph start: write failed");
        return 1;
      }
      console.log(`omcp state ralph start: iteration 1 (${task})`);
      return 0;
    }

    case "iterate": {
      const next = incrementRalphIteration(worktreeRoot);
      if (!next) {
        console.error(
          "omcp state ralph iterate: no active state (run `start <task>` first)",
        );
        return 1;
      }
      console.log(`omcp state ralph iterate: iteration ${next.iteration}`);
      return 0;
    }

    case "clear": {
      const ok = clearRalphState(worktreeRoot);
      console.log(`omcp state ralph clear: ${ok ? "yes" : "failed"}`);
      return ok ? 0 : 1;
    }

    default:
      console.error(
        `omcp state ralph: unknown subcommand '${sub}' (status | start <task> | iterate | clear)`,
      );
      return 2;
  }
}
