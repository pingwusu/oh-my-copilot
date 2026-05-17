// Context window usage element — ctx:NN% with optional severity suffix.

import { thresholdColor } from "../colors.js";
import type { HudState } from "../types.js";

function clamp(percent: number): number {
  return Math.min(100, Math.max(0, Math.round(percent)));
}

export function renderContext(state: HudState): string | null {
  if (state.contextPercent === null || state.contextPercent === undefined) {
    return null;
  }
  const pct = clamp(state.contextPercent);
  const { contextWarning, contextCompactSuggestion, contextCritical } =
    state.thresholds;
  const color = thresholdColor(pct, contextWarning, contextCritical);

  let suffix = "";
  if (pct >= contextCritical) suffix = " CRITICAL";
  else if (pct >= contextCompactSuggestion) suffix = " COMPRESS?";

  return `ctx:${color(`${pct}%${suffix}`, state.env)}`;
}
