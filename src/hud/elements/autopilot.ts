// Autopilot element — phase progress display.

import { cyan, green, magenta, red, yellow } from "../colors.js";
import type { HudState } from "../types.js";

const PHASE_NAMES: Record<string, string> = {
  expansion: "Expand",
  planning: "Plan",
  execution: "Build",
  qa: "QA",
  validation: "Verify",
  cleanup: "Cleanup",
  complete: "Done",
  failed: "Failed",
};

const PHASE_INDEX: Record<string, number> = {
  expansion: 1,
  planning: 2,
  execution: 3,
  qa: 4,
  validation: 5,
  cleanup: 5,
  complete: 5,
  failed: 0,
};

export function renderAutopilot(state: HudState): string | null {
  const ap = state.autopilot;
  if (!ap?.active) return null;

  const num = PHASE_INDEX[ap.phase] ?? 0;
  const name = PHASE_NAMES[ap.phase] ?? ap.phase;

  let phaseColor: (t: string, env?: NodeJS.ProcessEnv) => string;
  switch (ap.phase) {
    case "complete":
      phaseColor = green;
      break;
    case "failed":
      phaseColor = red;
      break;
    case "validation":
      phaseColor = magenta;
      break;
    case "qa":
      phaseColor = yellow;
      break;
    default:
      phaseColor = cyan;
  }

  let out = `[AUTOPILOT] Phase ${phaseColor(`${num}/5`, state.env)}: ${name}`;
  if (ap.iteration > 1) {
    out += ` (iter ${ap.iteration}/${ap.maxIterations})`;
  }
  if (
    ap.phase === "execution" &&
    ap.tasksTotal &&
    ap.tasksTotal > 0
  ) {
    const taskColor =
      ap.tasksCompleted === ap.tasksTotal ? green : yellow;
    out += ` | Tasks: ${taskColor(`${ap.tasksCompleted ?? 0}/${ap.tasksTotal}`, state.env)}`;
  }
  if (ap.filesCreated && ap.filesCreated > 0) {
    out += ` | ${ap.filesCreated} files`;
  }
  return out;
}
