// ANSI color helpers for omcp HUD.
// Colors are opt-in via OMCP_HUD_COLORS=1 (default off keeps status-line
// substring matching in tests deterministic).

export const RESET = "\x1b[0m";
const DIM_CODE = "\x1b[2m";
const BOLD_CODE = "\x1b[1m";
const RED_CODE = "\x1b[31m";
const GREEN_CODE = "\x1b[32m";
const YELLOW_CODE = "\x1b[33m";
const MAGENTA_CODE = "\x1b[35m";
const CYAN_CODE = "\x1b[36m";

export function colorsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.OMCP_HUD_COLORS === "1" || env.OMCP_HUD_COLORS === "true";
}

function wrap(code: string, text: string, env: NodeJS.ProcessEnv): string {
  if (!colorsEnabled(env)) return text;
  return `${code}${text}${RESET}`;
}

export const cyan = (t: string, env: NodeJS.ProcessEnv = process.env): string =>
  wrap(CYAN_CODE, t, env);
export const green = (t: string, env: NodeJS.ProcessEnv = process.env): string =>
  wrap(GREEN_CODE, t, env);
export const yellow = (t: string, env: NodeJS.ProcessEnv = process.env): string =>
  wrap(YELLOW_CODE, t, env);
export const red = (t: string, env: NodeJS.ProcessEnv = process.env): string =>
  wrap(RED_CODE, t, env);
export const magenta = (t: string, env: NodeJS.ProcessEnv = process.env): string =>
  wrap(MAGENTA_CODE, t, env);
export const dim = (t: string, env: NodeJS.ProcessEnv = process.env): string =>
  wrap(DIM_CODE, t, env);
export const bold = (t: string, env: NodeJS.ProcessEnv = process.env): string =>
  wrap(BOLD_CODE, t, env);

/**
 * Choose a color for context/ralph progress based on percent.
 */
export function thresholdColor(
  percent: number,
  warn = 70,
  crit = 90,
): (t: string, env?: NodeJS.ProcessEnv) => string {
  if (percent >= crit) return red;
  if (percent >= warn) return yellow;
  return green;
}
