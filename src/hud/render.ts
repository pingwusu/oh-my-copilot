// Top-level HUD renderer for omcp.
// Composes element outputs into a single line: "omcp · m1 · m2 · ...".
// Backwards-compatible with the original 120-line script:
//   - always emits "omcp" as the leading token
//   - includes model family, active modes (comma-joined), ralph N/M,
//     team done/spawned, and notepad priority note when present
//   - when richer state is available (autopilot phase, todos, tokens,
//     context%, git), additional segments are appended in stable order.

import { renderAutopilot } from "./elements/autopilot.js";
import { renderContext } from "./elements/context.js";
import { renderGit } from "./elements/git.js";
import { renderModel } from "./elements/model.js";
import { renderNotepadPriority } from "./elements/notepad-priority.js";
import { renderRalph } from "./elements/ralph.js";
import { renderTodos } from "./elements/todos.js";
import { renderTokenUsage } from "./elements/token-usage.js";
import { loadHudState } from "./state.js";
import type { HudElement, HudState } from "./types.js";

export const SEPARATOR = " · ";

/**
 * Render the family segment — for backwards compatibility this is
 * always present (defaults to "claude" when no source is set).
 */
function renderFamily(state: HudState): string {
  return state.modelFamily;
}

/**
 * Render active-modes as a comma-joined list (legacy contract).
 * Returns "" (empty placeholder) so the segment is preserved when other
 * legacy segments need positional alignment.
 */
function renderModes(state: HudState): string {
  return state.activeModes.join(",");
}

function renderRalphLegacy(state: HudState): string {
  const r = state.ralph;
  if (!r || !r.active) return "";
  const iter = Number.isFinite(r.iteration) ? r.iteration : null;
  const max = Number.isFinite(r.maxIterations) ? r.maxIterations : null;
  if (iter === null && max === null) return "";
  if (max !== null && max > 0) return `${iter ?? ""}/${max}`;
  return `${iter ?? ""}`;
}

function renderTeamLegacy(state: HudState): string {
  const t = state.team;
  if (!t) return "";
  return `${t.done ?? ""}/${t.spawned ?? ""}`;
}

/**
 * Optional elements — each returns string | null where null = hidden.
 * The order here is the rendered order in the rich tail of the line.
 */
const OPTIONAL_ELEMENTS: HudElement[] = [
  renderModel,
  renderContext,
  renderTokenUsage,
  renderGit,
  renderAutopilot,
  renderRalph,
  renderTodos,
];

/**
 * Render the omcp HUD to a single line. The leading 6 segments preserve
 * the original 120-line script's column contract:
 *   omcp · {family} · {modes} · {ralph iter/max} · {team done/spawned} · {note}
 * Additional rich segments follow when non-null state is available.
 */
export function renderHud(state: HudState): string {
  // Legacy 6-segment block — `omcp` + family always present; remaining
  // positional slots collapse to `-` when empty (avoids the user-facing
  // "omcp · claude ·  ·  ·  · " look noted in DD3 Lane B). The 6-column
  // contract is preserved (legacy tests assert parts.length >= 6).
  const dash = (s: string): string => (s.length > 0 ? s : "-");
  const legacy = [
    "omcp",
    renderFamily(state),
    dash(renderModes(state)),
    dash(renderRalphLegacy(state)),
    dash(renderTeamLegacy(state)),
    dash(renderNotepadPriority(state) ?? ""),
  ];

  const rich: string[] = [];
  for (const el of OPTIONAL_ELEMENTS) {
    const v = el(state);
    if (v && v.length > 0) rich.push(v);
  }

  const all = rich.length > 0 ? [...legacy, ...rich] : legacy;
  return all.join(SEPARATOR);
}

/**
 * Entry point invoked by scripts/omcp-hud.mjs. Always exits 0; never
 * throws — degraded output is preferable to a missing status line.
 */
export function renderHudFromEnv(
  cwd: string = process.cwd(),
  env: NodeJS.ProcessEnv = process.env,
): string {
  try {
    const state = loadHudState(cwd, env);
    return renderHud(state);
  } catch {
    return "omcp · (status unavailable)";
  }
}
