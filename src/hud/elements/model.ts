// Model element — renders a friendly model name or family label.
// Adapted from omc src/hud/elements/model.ts but family-aware (claude+gpt).

import { cyan } from "../colors.js";
import type { HudState } from "../types.js";

function extractVersion(id: string): string | null {
  const m = id.match(/(?:opus|sonnet|haiku)-(\d+)-(\d+)/i);
  if (m) return `${m[1]}.${m[2]}`;
  const d = id.match(/(?:opus|sonnet|haiku)\s+(\d+(?:\.\d+)?)/i);
  if (d) return d[1];
  const gpt = id.match(/gpt-?(\d+(?:[.-]\d+)?)/i);
  if (gpt) return gpt[1].replace("-", ".");
  return null;
}

function formatModel(modelName: string | null, family: string): string {
  if (!modelName) {
    return family;
  }
  const id = modelName.toLowerCase();
  let short: string | null = null;
  if (id.includes("opus")) short = "Opus";
  else if (id.includes("sonnet")) short = "Sonnet";
  else if (id.includes("haiku")) short = "Haiku";
  else if (id.includes("gpt")) short = "GPT";

  if (!short) {
    return modelName.length > 20 ? `${modelName.slice(0, 19)}…` : modelName;
  }
  const v = extractVersion(id);
  return v ? `${short} ${v}` : short;
}

export function renderModel(state: HudState): string | null {
  const text = formatModel(state.modelName, state.modelFamily);
  if (!text) return null;
  return cyan(text, state.env);
}
