// HUD column 2 — PRD completion fraction.
// Renders like [prd:5/10] when a prd.json is present.

import { green, yellow } from "../colors.js";
import type { HudState } from "../types.js";

/**
 * Render PRD progress fraction (column 2).
 *
 * Returns null when no PRD is loaded in state.
 */
export function renderPrdProgress(state: HudState): string | null {
  const prd = state.prd;
  if (!prd) return null;

  const { completed, total } = prd;
  const fraction = `${completed}/${total}`;
  const color = completed === total ? green : yellow;

  return `[prd:${color(fraction, state.env)}]`;
}
