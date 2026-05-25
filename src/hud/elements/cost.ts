// HUD column 6 — estimated AI Credits / cost total.
// Renders like [cost:0] (placeholder — real tracking lands when Copilot
// exposes per-request token counters in v1.9+).

import { dim } from "../colors.js";
import type { HudState } from "../types.js";

/**
 * Render the estimated cost total (column 6).
 *
 * Always renders — shows [cost:0] when no cost data is available yet.
 * The value is schema-first in v1.8; real AI Credits tracking lands in v1.9
 * when Copilot exposes per-request token counters.
 */
export function renderCost(state: HudState): string | null {
  const total = state.estimatedCostTotal;
  const label = total === 0 ? dim("0", state.env) : `${total}`;
  return `[cost:${label}]`;
}
