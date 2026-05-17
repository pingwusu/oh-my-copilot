// Token usage element — formats input/output/reasoning tokens compactly.

import type { HudState } from "../types.js";

function formatTokens(n: number): string {
  if (n < 1000) return `${n}`;
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(1)}m`;
}

export function renderTokenUsage(state: HudState): string | null {
  const usage = state.tokens;
  if (!usage) return null;
  const has = usage.inputTokens > 0 || usage.outputTokens > 0;
  if (!has) return null;
  const parts = [
    `tok:i${formatTokens(usage.inputTokens)}/o${formatTokens(usage.outputTokens)}`,
  ];
  if (usage.reasoningTokens && usage.reasoningTokens > 0) {
    parts.push(`r${formatTokens(usage.reasoningTokens)}`);
  }
  if (state.sessionTotalTokens && state.sessionTotalTokens > 0) {
    parts.push(`s${formatTokens(state.sessionTotalTokens)}`);
  }
  return parts.join(" ");
}
