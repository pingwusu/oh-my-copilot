/**
 * Preemptive Compaction Hook
 *
 * Monitors context usage and warns before hitting the context limit.
 * Encourages proactive compaction to prevent context overflow.
 *
 * Ported from oh-my-claudecode's preemptive-compaction hook.
 * Adapted for omcp (Copilot CLI sibling): uses omcp's Hook interface,
 * HookContext/HookResult protocol, atomicWriteFileSync for state writes,
 * and assertSafeSlug for session-ID-derived path components.
 *
 * Subscribes to: PostToolUse + PreCompact
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { tmpdir } from "node:os";

import type { Hook, HookContext, HookResult } from "../hook-types.js";
import { atomicWriteFileSync } from "../../runtime/atomic-write.js";
import { assertSafeSlug, isSafeSlug } from "../../runtime/safe-slug.js";

import {
  DEFAULT_THRESHOLD,
  CRITICAL_THRESHOLD,
  COMPACTION_COOLDOWN_MS,
  MAX_WARNINGS,
  CLAUDE_DEFAULT_CONTEXT_LIMIT,
  CHARS_PER_TOKEN,
  CONTEXT_WARNING_MESSAGE,
  CONTEXT_CRITICAL_MESSAGE,
} from "./constants.js";
import type {
  ContextUsageResult,
  PreemptiveCompactionConfig,
} from "./types.js";

const DEBUG = process.env.PREEMPTIVE_COMPACTION_DEBUG === "1";
const DEBUG_FILE = path.join(tmpdir(), "omcp-preemptive-compaction-debug.log");

/**
 * Rapid-fire debounce window (ms).
 * When multiple tool outputs arrive within this window (e.g. simultaneous
 * subagent completions), only the first triggers context analysis.
 * Much shorter than COMPACTION_COOLDOWN_MS — specifically targets the
 * concurrent flood scenario.
 */
export const RAPID_FIRE_DEBOUNCE_MS = 500;

/**
 * Per-session timestamp of last postToolUse analysis.
 * Used to debounce rapid-fire tool completions.
 */
const lastAnalysisTime = new Map<string, number>();

function debugLog(...args: unknown[]): void {
  if (DEBUG) {
    const msg = `[${new Date().toISOString()}] [omcp/preemptive-compaction] ${args
      .map((a) =>
        typeof a === "object" ? JSON.stringify(a, null, 2) : String(a),
      )
      .join(" ")}\n`;
    fs.appendFileSync(DEBUG_FILE, msg);
  }
}

/**
 * In-process session state (per-session, keyed by sessionId).
 * For hooks running in short-lived processes this is always fresh per
 * invocation; we also persist to `.omcp/state/preemptive-compaction/`
 * via atomicWriteFileSync so state survives across invocations when the
 * hook process is long-lived.
 */
const sessionStates = new Map<
  string,
  {
    lastWarningTime: number;
    warningCount: number;
    estimatedTokens: number;
  }
>();

// ─── State persistence (omcp state dir) ──────────────────────────────────────

/**
 * Derive the state directory for preemptive-compaction under the project cwd.
 * Uses `.omcp/state/preemptive-compaction/` — consistent with omcp conventions.
 */
function stateDir(cwd: string): string {
  return path.join(cwd, ".omcp", "state", "preemptive-compaction");
}

/**
 * State file path for a given session ID.
 * Validates the sessionId via assertSafeSlug before building the path.
 */
function stateFilePath(cwd: string, sessionId: string): string {
  assertSafeSlug(sessionId, "sessionId");
  return path.join(stateDir(cwd), `${sessionId}.json`);
}

interface PersistedState {
  lastWarningTime: number;
  warningCount: number;
  estimatedTokens: number;
}

function loadPersistedState(
  cwd: string,
  sessionId: string,
): PersistedState | null {
  if (!isSafeSlug(sessionId)) return null;
  try {
    const file = stateFilePath(cwd, sessionId);
    if (!fs.existsSync(file)) return null;
    const raw = fs.readFileSync(file, "utf-8");
    return JSON.parse(raw) as PersistedState;
  } catch {
    return null;
  }
}

function persistState(
  cwd: string,
  sessionId: string,
  state: PersistedState,
): void {
  if (!isSafeSlug(sessionId)) return;
  try {
    const dir = stateDir(cwd);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    atomicWriteFileSync(stateFilePath(cwd, sessionId), JSON.stringify(state));
  } catch {
    // Best-effort: state persistence must never crash the hook
  }
}

// ─── Pure logic (exported for tests) ─────────────────────────────────────────

/**
 * Estimate tokens from text content
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/**
 * Analyze context usage based on estimated token count
 */
export function analyzeContextUsage(
  content: string,
  config?: PreemptiveCompactionConfig,
): ContextUsageResult {
  const warningThreshold = config?.warningThreshold ?? DEFAULT_THRESHOLD;
  const criticalThreshold = config?.criticalThreshold ?? CRITICAL_THRESHOLD;
  const contextLimit = CLAUDE_DEFAULT_CONTEXT_LIMIT;

  const totalTokens = estimateTokens(content);
  const usageRatio = totalTokens / contextLimit;

  const isWarning = usageRatio >= warningThreshold;
  const isCritical = usageRatio >= criticalThreshold;

  let action: "none" | "warn" | "compact" = "none";
  if (isCritical) {
    action = "compact";
  } else if (isWarning) {
    action = "warn";
  }

  return {
    totalTokens,
    usageRatio,
    isWarning,
    isCritical,
    action,
  };
}

// ─── Session state helpers ────────────────────────────────────────────────────

function getSessionState(
  sessionId: string,
  cwd: string,
): {
  lastWarningTime: number;
  warningCount: number;
  estimatedTokens: number;
} {
  let state = sessionStates.get(sessionId);
  if (!state) {
    // Try to load from persisted state first
    const persisted = loadPersistedState(cwd, sessionId);
    state = persisted ?? {
      lastWarningTime: 0,
      warningCount: 0,
      estimatedTokens: 0,
    };
    sessionStates.set(sessionId, state);
  }
  return state;
}

function shouldShowWarning(
  sessionId: string,
  cwd: string,
  config?: PreemptiveCompactionConfig,
): boolean {
  const state = getSessionState(sessionId, cwd);
  const cooldownMs = config?.cooldownMs ?? COMPACTION_COOLDOWN_MS;
  const maxWarnings = config?.maxWarnings ?? MAX_WARNINGS;
  const now = Date.now();

  if (now - state.lastWarningTime < cooldownMs) {
    debugLog("skipping warning - cooldown active", {
      sessionId,
      elapsed: now - state.lastWarningTime,
      cooldown: cooldownMs,
    });
    return false;
  }

  if (state.warningCount >= maxWarnings) {
    debugLog("skipping warning - max reached", {
      sessionId,
      warningCount: state.warningCount,
      maxWarnings,
    });
    return false;
  }

  return true;
}

function recordWarning(sessionId: string, cwd: string): void {
  const state = getSessionState(sessionId, cwd);
  state.lastWarningTime = Date.now();
  state.warningCount++;
  persistState(cwd, sessionId, state);
}

// ─── Core analysis logic (shared by PostToolUse + PreCompact) ─────────────────

function runContextCheck(
  sessionId: string,
  cwd: string,
  additionalTokens: number,
  config?: PreemptiveCompactionConfig,
): HookResult {
  const state = getSessionState(sessionId, cwd);
  state.estimatedTokens += additionalTokens;

  const usage = analyzeContextUsage(
    "x".repeat(state.estimatedTokens * CHARS_PER_TOKEN),
    config,
  );

  if (!usage.isWarning) {
    return { kind: "noop" };
  }

  if (!shouldShowWarning(sessionId, cwd, config)) {
    return { kind: "noop" };
  }

  recordWarning(sessionId, cwd);

  debugLog("injecting context warning", {
    sessionId,
    usageRatio: usage.usageRatio,
    isCritical: usage.isCritical,
  });

  if (config?.customMessage) {
    return { kind: "advise", text: config.customMessage };
  }

  return {
    kind: "advise",
    text: usage.isCritical ? CONTEXT_CRITICAL_MESSAGE : CONTEXT_WARNING_MESSAGE,
  };
}

// ─── Hook factory ─────────────────────────────────────────────────────────────

/** Tools whose outputs are large enough to warrant a context check. */
const LARGE_OUTPUT_TOOLS = new Set([
  "read",
  "grep",
  "glob",
  "bash",
  "webfetch",
  "task",
]);

/**
 * Create the preemptive-compaction Hook object.
 *
 * Subscribes to PostToolUse + PreCompact.
 * Returns `{ kind: "noop" }` when not triggered; `{ kind: "advise", text }` otherwise.
 */
export function createPreemptiveCompactionHook(
  config?: PreemptiveCompactionConfig,
): Hook {
  debugLog("createPreemptiveCompactionHook called", { config });

  return {
    name: "preemptive-compaction",
    events: ["PostToolUse", "PreCompact"],

    async run(ctx: HookContext): Promise<HookResult> {
      if (config?.enabled === false) {
        return { kind: "noop" };
      }

      const { event, sessionId, cwd, toolName, toolResult } = ctx;

      // ── PostToolUse ─────────────────────────────────────────────────────────
      if (event === "PostToolUse") {
        if (!toolName || !toolResult) {
          return { kind: "noop" };
        }

        // Only check after tools that produce large outputs
        if (!LARGE_OUTPUT_TOOLS.has(toolName.toLowerCase())) {
          return { kind: "noop" };
        }

        // Rapid-fire debounce: skip analysis if another was done very recently
        const now = Date.now();
        const lastAnalysis = lastAnalysisTime.get(sessionId) ?? 0;
        if (now - lastAnalysis < RAPID_FIRE_DEBOUNCE_MS) {
          debugLog("skipping analysis - rapid-fire debounce active", {
            sessionId,
            elapsed: now - lastAnalysis,
          });
          // Still accumulate tokens even when debounced
          const responseStr =
            typeof toolResult === "string"
              ? toolResult
              : JSON.stringify(toolResult);
          const state = getSessionState(sessionId, cwd);
          state.estimatedTokens += estimateTokens(responseStr);
          return { kind: "noop" };
        }
        lastAnalysisTime.set(sessionId, now);

        const responseStr =
          typeof toolResult === "string"
            ? toolResult
            : JSON.stringify(toolResult);
        const responseTokens = estimateTokens(responseStr);

        debugLog("tracking tool output", {
          tool: toolName,
          responseTokens,
        });

        return runContextCheck(sessionId, cwd, responseTokens, config);
      }

      // ── PreCompact ──────────────────────────────────────────────────────────
      if (event === "PreCompact") {
        // On PreCompact we check current cumulative estimate with no new tokens.
        // If already over threshold, warn; otherwise noop.
        return runContextCheck(sessionId, cwd, 0, config);
      }

      return { kind: "noop" };
    },
  };
}

/**
 * Get estimated token usage for a session (in-process map only).
 */
export function getSessionTokenEstimate(sessionId: string): number {
  const state = sessionStates.get(sessionId);
  return state?.estimatedTokens ?? 0;
}

/**
 * Reset token estimate for a session (e.g. after compaction).
 */
export function resetSessionTokenEstimate(sessionId: string): void {
  const state = sessionStates.get(sessionId);
  if (state) {
    state.estimatedTokens = 0;
    state.warningCount = 0;
    state.lastWarningTime = 0;
  }
  lastAnalysisTime.delete(sessionId);
}

/**
 * Clear the rapid-fire debounce state for a session (for testing).
 */
export function clearRapidFireDebounce(sessionId: string): void {
  lastAnalysisTime.delete(sessionId);
}

// ─── Re-exports ───────────────────────────────────────────────────────────────

export type { ContextUsageResult, PreemptiveCompactionConfig } from "./types.js";

export {
  DEFAULT_THRESHOLD,
  CRITICAL_THRESHOLD,
  COMPACTION_COOLDOWN_MS,
  MAX_WARNINGS,
  CLAUDE_DEFAULT_CONTEXT_LIMIT,
  CHARS_PER_TOKEN,
  CONTEXT_WARNING_MESSAGE,
  CONTEXT_CRITICAL_MESSAGE,
} from "./constants.js";
