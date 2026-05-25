// HUD state loader — reads .omcp/state/*-state.json + .omcp/notepad.md
// + ~/.copilot/config.json. All reads are graceful (errors become nulls).

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_THRESHOLDS,
  type AutopilotStateForHud,
  type HudState,
  type ModelFamily,
  type ModeIterForHud,
  type PrdProgressForHud,
  type RalphStateForHud,
  type TeamStateForHud,
  type TodoItem,
  type TokenUsageForHud,
} from "./types.js";

function readJsonSafe(path: string): unknown {
  try {
    if (!existsSync(path)) return null;
    const raw = readFileSync(path, "utf8");
    if (!raw.trim()) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function asObject(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

function asNumber(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function asString(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

function asBool(v: unknown): boolean {
  return v === true;
}

function copilotHome(env: NodeJS.ProcessEnv): string {
  return env.OMCP_HOME ?? join(homedir(), ".copilot");
}

export function detectModelFamily(env: NodeJS.ProcessEnv): ModelFamily {
  const fromEnv = (env.OMCP_MODEL_FAMILY ?? "").toLowerCase();
  if (fromEnv === "claude" || fromEnv === "gpt") return fromEnv;
  const cfg = asObject(readJsonSafe(join(copilotHome(env), "config.json")));
  const model = cfg && asString(cfg.model);
  if (model) {
    const low = model.toLowerCase();
    if (low.startsWith("claude")) return "claude";
    if (low.startsWith("gpt")) return "gpt";
  }
  return "claude";
}

export function detectModelName(env: NodeJS.ProcessEnv): string | null {
  const direct = asString(env.OMCP_MODEL_NAME);
  if (direct) return direct;
  const cfg = asObject(readJsonSafe(join(copilotHome(env), "config.json")));
  if (cfg) {
    return asString(cfg.model);
  }
  return null;
}

function stateDir(cwd: string): string {
  return join(cwd, ".omcp", "state");
}

export function readActiveModes(cwd: string): string[] {
  // Legacy schema: mode.json { modes: ["..."] }
  const legacy = asObject(readJsonSafe(join(stateDir(cwd), "mode.json")));
  if (legacy && Array.isArray(legacy.modes)) {
    return legacy.modes.filter((m): m is string => typeof m === "string" && m.length > 0);
  }
  // New schema: per-mode `<mode>-state.json` with `active: true`.
  const modes: string[] = [];
  const candidates = [
    "ralph",
    "autopilot",
    "ultrawork",
    "ultraqa",
    "team",
    "sciomc",
    "plan",
    "ralplan",
    "ccg",
    "learner",
    "deep-interview",
    "deep-dive",
    "external-context",
    "ai-slop-cleaner",
  ];
  for (const m of candidates) {
    const obj = asObject(readJsonSafe(join(stateDir(cwd), `${m}-state.json`)));
    if (obj && asBool(obj.active)) modes.push(m);
  }
  return modes;
}

export function readRalph(cwd: string): RalphStateForHud | null {
  // Prefer new schema: ralph-state.json
  const newSchema = asObject(
    readJsonSafe(join(stateDir(cwd), "ralph-state.json")),
  );
  if (newSchema) {
    const iter = asNumber(newSchema.iteration) ?? asNumber(newSchema.iter);
    const max =
      asNumber(newSchema.max_iterations) ?? asNumber(newSchema.max);
    if (iter !== null && max !== null) {
      return {
        active: asBool(newSchema.active) || iter > 0,
        iteration: iter,
        maxIterations: max,
      };
    }
  }
  // Legacy: ralph.json { iter, max }
  const legacy = asObject(readJsonSafe(join(stateDir(cwd), "ralph.json")));
  if (legacy) {
    const iter = asNumber(legacy.iter);
    const max = asNumber(legacy.max);
    if (iter !== null || max !== null) {
      return {
        active: true,
        iteration: iter ?? 0,
        maxIterations: max ?? 0,
      };
    }
  }
  return null;
}

export function readAutopilot(cwd: string): AutopilotStateForHud | null {
  const obj = asObject(
    readJsonSafe(join(stateDir(cwd), "autopilot-state.json")),
  );
  if (!obj) return null;
  const phase = asString(obj.phase) ?? "execution";
  const iter = asNumber(obj.iteration) ?? 0;
  const max = asNumber(obj.max_iterations) ?? asNumber(obj.maxIterations) ?? 5;
  return {
    active: asBool(obj.active),
    phase,
    iteration: iter,
    maxIterations: max,
    tasksCompleted:
      asNumber(obj.tasks_completed) ?? asNumber(obj.tasksCompleted) ?? undefined,
    tasksTotal:
      asNumber(obj.tasks_total) ?? asNumber(obj.tasksTotal) ?? undefined,
    filesCreated:
      asNumber(obj.files_created) ?? asNumber(obj.filesCreated) ?? undefined,
  };
}

export function readTeam(cwd: string): TeamStateForHud | null {
  // New schema: team-state.json
  const newSchema = asObject(
    readJsonSafe(join(stateDir(cwd), "team-state.json")),
  );
  if (newSchema) {
    const spawned = asNumber(newSchema.spawned);
    const done = asNumber(newSchema.done) ?? asNumber(newSchema.agentsDone);
    if (spawned !== null || done !== null) {
      return {
        active: asBool(newSchema.active),
        spawned: spawned ?? 0,
        done: done ?? 0,
      };
    }
  }
  // Legacy: team.json { agentsDone, spawned }
  const legacy = asObject(readJsonSafe(join(stateDir(cwd), "team.json")));
  if (legacy) {
    const spawned = asNumber(legacy.spawned);
    const done = asNumber(legacy.agentsDone) ?? asNumber(legacy.done);
    if (spawned !== null || done !== null) {
      return {
        active: true,
        spawned: spawned ?? 0,
        done: done ?? 0,
      };
    }
  }
  return null;
}

export function readTodos(cwd: string): TodoItem[] {
  const data = readJsonSafe(join(stateDir(cwd), "todos.json"));
  const arr = Array.isArray(data)
    ? data
    : asObject(data)?.todos && Array.isArray(asObject(data)!.todos)
      ? (asObject(data)!.todos as unknown[])
      : [];
  const out: TodoItem[] = [];
  for (const item of arr) {
    const obj = asObject(item);
    if (!obj) continue;
    const content = asString(obj.content);
    const status = asString(obj.status);
    if (!content || !status) continue;
    const af = asString(obj.activeForm);
    const t: TodoItem = { content, status };
    if (af) t.activeForm = af;
    out.push(t);
  }
  return out;
}

interface HudExternalData {
  contextPercent: number | null;
  tokens: TokenUsageForHud | null;
  sessionTotalTokens: number | null;
}

export function readHudData(cwd: string): HudExternalData {
  const obj = asObject(readJsonSafe(join(stateDir(cwd), "hud-state.json")));
  if (!obj) {
    return { contextPercent: null, tokens: null, sessionTotalTokens: null };
  }
  const contextPercent =
    asNumber(obj.contextPercent) ?? asNumber(obj.context_percent);
  const tokensObj = asObject(obj.tokens) ?? asObject(obj.lastRequestTokenUsage);
  let tokens: TokenUsageForHud | null = null;
  if (tokensObj) {
    const i = asNumber(tokensObj.inputTokens) ?? asNumber(tokensObj.input_tokens);
    const o = asNumber(tokensObj.outputTokens) ?? asNumber(tokensObj.output_tokens);
    if (i !== null || o !== null) {
      tokens = { inputTokens: i ?? 0, outputTokens: o ?? 0 };
      const r =
        asNumber(tokensObj.reasoningTokens) ??
        asNumber(tokensObj.reasoning_tokens);
      if (r !== null && r > 0) tokens.reasoningTokens = r;
    }
  }
  const sessionTotalTokens =
    asNumber(obj.sessionTotalTokens) ?? asNumber(obj.session_total_tokens);
  return {
    contextPercent: contextPercent ?? null,
    tokens,
    sessionTotalTokens: sessionTotalTokens ?? null,
  };
}

/**
 * Read the primary active looping mode + iteration for HUD column 1.
 *
 * Priority order: ralph > autopilot > (first other active mode with iter).
 * Returns null when no looping mode is active.
 */
export function readModeIter(cwd: string): ModeIterForHud | null {
  // Ralph takes priority.
  const ralph = asObject(readJsonSafe(join(stateDir(cwd), "ralph-state.json")));
  if (ralph && asBool(ralph.active)) {
    const iter = asNumber(ralph.iteration) ?? asNumber(ralph.iter) ?? 0;
    const max = asNumber(ralph.max_iterations) ?? asNumber(ralph.max) ?? 0;
    if (iter > 0 || max > 0) {
      return { modeName: "ralph", iteration: iter, maxIterations: max };
    }
  }
  // Autopilot second.
  const ap = asObject(readJsonSafe(join(stateDir(cwd), "autopilot-state.json")));
  if (ap && asBool(ap.active)) {
    const iter = asNumber(ap.iteration) ?? 0;
    const max = asNumber(ap.max_iterations) ?? asNumber(ap.maxIterations) ?? 5;
    return { modeName: "autopilot", iteration: iter, maxIterations: max };
  }
  return null;
}

/**
 * Read PRD completion fraction for HUD column 2.
 *
 * Reads `.omcp/prd.json` (default path) and counts completed vs total
 * userStories. Returns null when no PRD is present or it cannot be parsed.
 */
export function readPrdProgress(cwd: string): PrdProgressForHud | null {
  const prdPath = join(cwd, ".omcp", "prd.json");
  try {
    if (!existsSync(prdPath)) return null;
    const raw = readFileSync(prdPath, "utf8");
    if (!raw.trim()) return null;
    const parsed = JSON.parse(raw) as unknown;
    const obj = asObject(parsed);
    if (!obj) return null;
    const stories = Array.isArray(obj.userStories) ? obj.userStories : null;
    if (!stories) return null;
    const total = stories.length;
    if (total === 0) return null;
    const completed = stories.filter((s: unknown) => {
      const so = asObject(s);
      return so && (asBool(so.passes) || asString(so.status) === "completed");
    }).length;
    return { completed, total };
  } catch {
    return null;
  }
}

/**
 * Read total estimated cost from the most recent session's cost-summary.json
 * for HUD column 6. Scans .omcp/state/ for session subdirs and picks the
 * most recently modified cost-summary.json. Returns 0 when none found.
 */
export function readEstimatedCostTotal(cwd: string): number {
  const stateRoot = stateDir(cwd);
  try {
    if (!existsSync(stateRoot)) return 0;
    const entries = readdirSync(stateRoot, { withFileTypes: true });
    let best: { mtime: number; total: number } | null = null;
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const candidate = join(stateRoot, entry.name, "cost-summary.json");
      if (!existsSync(candidate)) continue;
      try {
        const mtime = statSync(candidate).mtimeMs;
        const obj = asObject(readJsonSafe(candidate));
        if (!obj || !Array.isArray(obj.entries)) continue;
        const total = (obj.entries as unknown[]).reduce((sum: number, e: unknown) => {
          const eo = asObject(e);
          return sum + (asNumber(eo ? eo.estimatedCost : null) ?? 0);
        }, 0);
        if (best === null || mtime > best.mtime) {
          best = { mtime, total };
        }
      } catch {
        // skip unreadable entries
      }
    }
    return best?.total ?? 0;
  } catch {
    return 0;
  }
}

export function readPriorityNote(cwd: string): string | null {
  try {
    const file = join(cwd, ".omcp", "notepad.md");
    if (!existsSync(file)) return null;
    const raw = readFileSync(file, "utf8");
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const cleaned = trimmed.replace(/^([#>*\-]+\s+)+/, "").trim();
      if (!cleaned) continue;
      return cleaned;
    }
    return null;
  } catch {
    return null;
  }
}

export function loadHudState(
  cwd: string = process.cwd(),
  env: NodeJS.ProcessEnv = process.env,
): HudState {
  const ext = readHudData(cwd);
  return {
    cwd,
    env,
    modelFamily: detectModelFamily(env),
    modelName: detectModelName(env),
    activeModes: readActiveModes(cwd),
    ralph: readRalph(cwd),
    autopilot: readAutopilot(cwd),
    team: readTeam(cwd),
    todos: readTodos(cwd),
    contextPercent: ext.contextPercent,
    tokens: ext.tokens,
    sessionTotalTokens: ext.sessionTotalTokens,
    priorityNote: readPriorityNote(cwd),
    thresholds: DEFAULT_THRESHOLDS,
    modeIter: readModeIter(cwd),
    prd: readPrdProgress(cwd),
    estimatedCostTotal: readEstimatedCostTotal(cwd),
  };
}
