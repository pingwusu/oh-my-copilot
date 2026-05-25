// HUD column 1 — current active mode + outer-loop iteration.
// Renders like [mode:ralph iter:3/10] for any looping mode.
// Multi-mode: when 2+ modes are active, renders a comma-joined list.

import { cyan } from "../colors.js";
import type { HudState } from "../types.js";

/**
 * Render the primary mode + iteration counter (column 1).
 *
 * Returns null when no looping mode is active.
 */
export function renderModeIter(state: HudState): string | null {
  const mi = state.modeIter;
  if (!mi) return null;

  const iterStr =
    mi.maxIterations > 0
      ? `${mi.iteration}/${mi.maxIterations}`
      : `${mi.iteration}`;

  return `[mode:${cyan(mi.modeName, state.env)} iter:${iterStr}]`;
}

/**
 * Render all active modes as a bracketed comma-joined list (multi-mode).
 *
 * Returns null when fewer than 2 modes are active (single-mode falls back
 * to renderModeIter for a richer display with iteration counts).
 */
export function renderMultiMode(state: HudState): string | null {
  if (state.activeModes.length < 2) return null;
  const joined = state.activeModes.join(",");
  return `[modes:${joined}]`;
}
