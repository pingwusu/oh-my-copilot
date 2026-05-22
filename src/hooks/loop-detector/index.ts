/**
 * Loop Detector Hook
 *
 * Tracks recent tool-call signatures in a rolling window and interrupts
 * when the same signature appears too many times in a row.
 *
 * Signature = `${toolName}::${sha256(stableJson(toolArgs)).slice(0,12)}`
 *
 * Subscribes to: PreToolUse
 *
 * State is persisted to `.omcp/state/loop-detector/{sessionId}.json` via
 * atomicWriteFileSync.
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

import type { Hook, HookContext, HookResult } from "../hook-types.js";
import { atomicWriteFileSync } from "../../runtime/atomic-write.js";
import { assertSafeSlug, isSafeSlug } from "../../runtime/safe-slug.js";

import {
  DEFAULT_THRESHOLD,
  DEFAULT_WINDOW,
  THRESHOLD_ENV_VAR,
  WINDOW_ENV_VAR,
} from "./constants.js";

// ─── Types ────────────────────────────────────────────────────────────────────

interface LoopState {
  window: string[];
}

// ─── Stable hash ─────────────────────────────────────────────────────────────

/**
 * Produce a stable JSON string with object keys sorted recursively.
 * This ensures `{a:1, b:2}` and `{b:2, a:1}` produce the same hash.
 */
export function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return "[" + value.map(stableJson).join(",") + "]";
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  const pairs = keys.map((k) => `${JSON.stringify(k)}:${stableJson(obj[k])}`);
  return "{" + pairs.join(",") + "}";
}

/**
 * Compute a 12-hex-char SHA-256 prefix of the stable JSON of args.
 */
export function stableHashOf(args: unknown): string {
  const json = stableJson(args);
  return crypto.createHash("sha256").update(json, "utf8").digest("hex").slice(0, 12);
}

/**
 * Build the deduplication signature for a tool call.
 */
export function buildSignature(toolName: string, toolArgs: unknown): string {
  return `${toolName}::${stableHashOf(toolArgs)}`;
}

// ─── Config resolution ────────────────────────────────────────────────────────

function resolveThreshold(): number {
  const raw = process.env[THRESHOLD_ENV_VAR];
  if (raw !== undefined) {
    const parsed = parseInt(raw, 10);
    if (!isNaN(parsed) && parsed > 0) return parsed;
  }
  return DEFAULT_THRESHOLD;
}

function resolveWindow(): number {
  const raw = process.env[WINDOW_ENV_VAR];
  if (raw !== undefined) {
    const parsed = parseInt(raw, 10);
    if (!isNaN(parsed) && parsed > 0) return parsed;
  }
  return DEFAULT_WINDOW;
}

// ─── State helpers ────────────────────────────────────────────────────────────

function stateDir(cwd: string): string {
  return path.join(cwd, ".omcp", "state", "loop-detector");
}

function stateFilePath(cwd: string, sessionId: string): string {
  assertSafeSlug(sessionId, "sessionId");
  return path.join(stateDir(cwd), `${sessionId}.json`);
}

function loadState(cwd: string, sessionId: string): LoopState {
  if (!isSafeSlug(sessionId)) return { window: [] };
  try {
    const file = stateFilePath(cwd, sessionId);
    if (!fs.existsSync(file)) return { window: [] };
    const raw = fs.readFileSync(file, "utf-8");
    const parsed = JSON.parse(raw) as unknown;
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      "window" in parsed &&
      Array.isArray((parsed as Record<string, unknown>).window)
    ) {
      const w = (parsed as LoopState).window;
      if (w.every((item) => typeof item === "string")) {
        return { window: w };
      }
    }
    return { window: [] };
  } catch {
    return { window: [] };
  }
}

function saveState(cwd: string, sessionId: string, state: LoopState): void {
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

// ─── Hook factory ─────────────────────────────────────────────────────────────

/**
 * Create the loop-detector Hook object.
 *
 * Subscribes to PreToolUse.
 * Returns `{ kind: "noop" }` when no loop detected; `{ kind: "interrupt" }`
 * when the same tool+args signature has been seen >= threshold times.
 */
export function createLoopDetectorHook(): Hook {
  return {
    name: "loop-detector",
    events: ["PreToolUse"],

    async run(ctx: HookContext): Promise<HookResult> {
      const { sessionId, cwd, toolName, toolArgs } = ctx;

      if (!toolName) return { kind: "noop" };

      const threshold = resolveThreshold();
      const windowSize = resolveWindow();

      const sig = buildSignature(toolName, toolArgs);
      const state = loadState(cwd, sessionId);

      // Append current call and trim to window size
      state.window.push(sig);
      if (state.window.length > windowSize) {
        state.window = state.window.slice(state.window.length - windowSize);
      }

      saveState(cwd, sessionId, state);

      // Count occurrences of current signature in the window
      const occurrences = state.window.filter((s) => s === sig).length;

      if (occurrences >= threshold) {
        return {
          kind: "interrupt",
          reason:
            `Loop detected: tool "${toolName}" has been called with identical ` +
            `arguments ${occurrences} times in the last ${state.window.length} tool calls ` +
            `(threshold: ${threshold}). This may indicate an infinite loop. ` +
            `Review the current task and consider a different approach.`,
        };
      }

      return { kind: "noop" };
    },
  };
}

export {
  DEFAULT_THRESHOLD,
  DEFAULT_WINDOW,
  THRESHOLD_ENV_VAR,
  WINDOW_ENV_VAR,
} from "./constants.js";
