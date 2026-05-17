// Ralph loop iteration display — ralph:N/M.

import { green, red, yellow } from "../colors.js";
import type { HudState } from "../types.js";

export function renderRalph(state: HudState): string | null {
  const r = state.ralph;
  if (!r?.active) return null;
  const { iteration, maxIterations } = r;
  if (!Number.isFinite(iteration) || !Number.isFinite(maxIterations)) {
    return null;
  }
  const warn = state.thresholds.ralphWarning;
  const crit = Math.floor(maxIterations * 0.9);
  let color: (t: string, env?: NodeJS.ProcessEnv) => string;
  if (iteration >= crit) color = red;
  else if (iteration >= warn) color = yellow;
  else color = green;
  return `ralph:${color(`${iteration}/${maxIterations}`, state.env)}`;
}
