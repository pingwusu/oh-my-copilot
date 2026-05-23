// `omcp state boulder <subcommand>` — typed CLI surface over the
// boulder-state lib. Branch B step 4 of next-session-ralplan.

import {
  clearBoulderState,
  getPlanSummaries,
  readBoulderState,
  type BoulderState,
  type PlanSummary,
} from "../../lib/boulder-state.js";

function formatStatus(state: BoulderState | null): string {
  if (!state) return "omcp state boulder: no active boulder";
  const lines = [
    `omcp state boulder:`,
    `  active:        ${state.active}`,
    `  planName:      ${state.planName}`,
    `  activePlan:    ${state.activePlan}`,
    `  startedAt:     ${state.startedAt}`,
    `  updatedAt:     ${state.updatedAt}`,
    `  sessionIds:    ${state.sessionIds.join(", ") || "(none)"}`,
  ];
  return lines.join("\n");
}

function formatPlanLine(p: PlanSummary): string {
  const { completed, total, isComplete } = p.progress;
  const flag = isComplete ? "done" : "open";
  const counts = total === 0 ? "no-checklist" : `${completed}/${total}`;
  return `  [${flag}] ${p.name}  ${counts}  ${p.path}`;
}

function formatPlanList(plans: PlanSummary[]): string {
  if (plans.length === 0) return "omcp state boulder: no plans in .omcp/plans/";
  return [
    `omcp state boulder plans (${plans.length}):`,
    ...plans.map(formatPlanLine),
  ].join("\n");
}

export function runStateBoulder(
  args: string[],
  worktreeRoot?: string,
): number {
  const sub = args[0];
  if (!sub) {
    console.error(
      "omcp state boulder: missing subcommand (status | list-plans | clear)",
    );
    return 2;
  }

  switch (sub) {
    case "status": {
      console.log(formatStatus(readBoulderState(worktreeRoot)));
      return 0;
    }

    case "list-plans": {
      console.log(formatPlanList(getPlanSummaries(worktreeRoot)));
      return 0;
    }

    case "clear": {
      const ok = clearBoulderState(worktreeRoot);
      console.log(`omcp state boulder clear: ${ok ? "yes" : "failed"}`);
      return ok ? 0 : 1;
    }

    default:
      console.error(
        `omcp state boulder: unknown subcommand '${sub}' (status | list-plans | clear)`,
      );
      return 2;
  }
}
