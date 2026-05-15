// Lightweight Mustache-ish template renderer.
//
// Supports:
//   - {{variable}} substitution. Missing variables render as "" (never throw).
//   - {{#if variable}}...{{/if}} truthiness conditionals (no else, no nesting
//     of the same name — we only need flat conditionals for the documented
//     template variables).
//
// Also injects a set of COMPUTED variables (duration, time, projectDisplay,
// reasonDisplay, footer, modesDisplay, iterationDisplay, agentDisplay,
// tmuxTailBlock) before substitution so templates can reference them
// without the caller pre-populating them.

import type { NotifyContext } from "./types.js";

const VAR_RE = /\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/g;
const IF_RE = /\{\{#if\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}([\s\S]*?)\{\{\/if\}\}/g;

function smartDuration(value: unknown): string {
  if (value === undefined || value === null || value === "") return "";
  if (typeof value === "string") return value;
  const ms = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(ms) || ms < 0) return "";
  const totalSeconds = Math.floor(ms / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) {
    return seconds === 0 ? `${minutes}m` : `${minutes}m ${seconds}s`;
  }
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  return mins === 0 ? `${hours}h` : `${hours}h ${mins}m`;
}

function localeTime(ctx: NotifyContext): string {
  const ts = ctx.timestamp;
  let date: Date;
  if (typeof ts === "string" && ts.length > 0) {
    const parsed = new Date(ts);
    date = Number.isNaN(parsed.getTime()) ? new Date() : parsed;
  } else {
    date = new Date();
  }
  // Locale string, but stable enough for tests: hours+minutes 24h.
  return date.toLocaleTimeString("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function projectDisplay(ctx: NotifyContext): string {
  if (typeof ctx.projectName === "string" && ctx.projectName.length > 0) {
    return ctx.projectName;
  }
  if (typeof ctx.projectPath === "string" && ctx.projectPath.length > 0) {
    // Basename fallback. Strip trailing slashes; pick last segment.
    const trimmed = ctx.projectPath.replace(/[/\\]+$/, "");
    const idx = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
    return idx >= 0 ? trimmed.slice(idx + 1) : trimmed;
  }
  return "(unknown project)";
}

function reasonDisplay(ctx: NotifyContext): string {
  if (typeof ctx.reason === "string" && ctx.reason.length > 0) return ctx.reason;
  return "unknown";
}

function modesDisplay(ctx: NotifyContext): string {
  if (Array.isArray(ctx.modes) && ctx.modes.length > 0) return ctx.modes.join(", ");
  if (typeof ctx.activeMode === "string" && ctx.activeMode.length > 0) return ctx.activeMode;
  return "";
}

function iterationDisplay(ctx: NotifyContext): string {
  const iter = ctx.iteration;
  const max = ctx.iterationMax;
  if (typeof iter === "number" && typeof max === "number") return `${iter}/${max}`;
  if (typeof iter === "number") return `${iter}`;
  return "";
}

function agentDisplay(ctx: NotifyContext): string {
  const done = ctx.agentsCompleted;
  const spawned = ctx.agentsSpawned;
  if (typeof done === "number" && typeof spawned === "number") {
    return `${done}/${spawned} completed`;
  }
  if (typeof ctx.agentName === "string" && ctx.agentName.length > 0) {
    return ctx.agentType ? `${ctx.agentName} (${ctx.agentType})` : ctx.agentName;
  }
  return "";
}

function footer(ctx: NotifyContext): string {
  const parts: string[] = [];
  if (typeof ctx.tmuxSession === "string" && ctx.tmuxSession.length > 0) {
    parts.push(`tmux: ${ctx.tmuxSession}`);
  }
  const proj = projectDisplay(ctx);
  if (proj && proj !== "(unknown project)") parts.push(`project: ${proj}`);
  return parts.join(" | ");
}

function tmuxTailBlock(ctx: NotifyContext): string {
  const tail = ctx.tmuxTail;
  if (typeof tail !== "string" || tail.trim().length === 0) return "";
  return "```\n" + tail.replace(/```/g, "ʼʼʼ") + "\n```";
}

export function computeDerived(ctx: NotifyContext): Record<string, string> {
  return {
    duration: smartDuration(ctx.duration ?? ctx.durationMs),
    time: localeTime(ctx),
    projectDisplay: projectDisplay(ctx),
    reasonDisplay: reasonDisplay(ctx),
    modesDisplay: modesDisplay(ctx),
    iterationDisplay: iterationDisplay(ctx),
    agentDisplay: agentDisplay(ctx),
    footer: footer(ctx),
    tmuxTailBlock: tmuxTailBlock(ctx),
  };
}

function stringifyValue(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return "";
  }
}

function isTruthy(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  if (typeof value === "string") return value.length > 0;
  if (typeof value === "number") return value !== 0 && !Number.isNaN(value);
  if (typeof value === "boolean") return value;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "object") return Object.keys(value as object).length > 0;
  return Boolean(value);
}

export function renderTemplate(template: string, ctx: NotifyContext): string {
  if (typeof template !== "string" || template.length === 0) return "";
  const derived = computeDerived(ctx);
  const lookup = (name: string): unknown => {
    if (name in derived) return derived[name];
    return (ctx as Record<string, unknown>)[name];
  };

  // Process conditionals first so their bodies still get variable expansion.
  // Run repeatedly to handle multiple {{#if}} blocks (non-nested).
  let prev: string;
  let out = template;
  let guard = 0;
  do {
    prev = out;
    out = out.replace(IF_RE, (_match, name: string, body: string) => {
      return isTruthy(lookup(name)) ? body : "";
    });
    guard += 1;
  } while (out !== prev && guard < 16);

  // Then variable substitution.
  out = out.replace(VAR_RE, (_match, name: string) => stringifyValue(lookup(name)));

  return out;
}

export function validateTemplate(tpl: string, knownVars: string[]): string[] {
  if (typeof tpl !== "string" || tpl.length === 0) return [];
  const known = new Set(knownVars);
  const seen = new Set<string>();
  const unknown: string[] = [];
  const pushIfUnknown = (name: string): void => {
    if (known.has(name)) return;
    if (seen.has(name)) return;
    seen.add(name);
    unknown.push(name);
  };

  for (const m of tpl.matchAll(IF_RE)) {
    pushIfUnknown(m[1]);
    // also scan inside the body
    for (const inner of m[2].matchAll(VAR_RE)) pushIfUnknown(inner[1]);
  }
  // Strip conditionals before the outer variable pass so we don't double-count
  // their named variable (already handled above) but still catch top-level vars.
  const stripped = tpl.replace(IF_RE, "");
  for (const m of stripped.matchAll(VAR_RE)) pushIfUnknown(m[1]);

  return unknown;
}

// Convenience: documented variable names (raw + computed). Useful for callers
// that want to validate user-supplied templates without re-listing constants.
export const KNOWN_TEMPLATE_VARS: string[] = [
  // Raw fields (see NotifyContext).
  "sessionId",
  "projectName",
  "projectPath",
  "timestamp",
  "duration",
  "durationMs",
  "reason",
  "question",
  "tmuxSession",
  "tmuxTail",
  "activeMode",
  "modes",
  "iteration",
  "iterationMax",
  "agentName",
  "agentType",
  "agentsSpawned",
  "agentsCompleted",
  "contextSummary",
  "event",
  // Computed.
  "time",
  "projectDisplay",
  "reasonDisplay",
  "modesDisplay",
  "iterationDisplay",
  "agentDisplay",
  "footer",
  "tmuxTailBlock",
];
