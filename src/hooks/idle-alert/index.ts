/**
 * Idle Alert Hook
 *
 * Tracks the timestamp of the last Notification event per session.
 * If the gap since the last fire exceeds the configured threshold,
 * returns an advise result noting the idle duration.
 *
 * State persisted at: `.omcp/state/idle-alert/{sessionId}.json`
 *
 * Subscribes to: Notification
 */

import * as fs from "node:fs";
import * as path from "node:path";

import type { Hook, HookContext, HookResult } from "../hook-types.js";
import { atomicWriteFileSync } from "../../runtime/atomic-write.js";
import { assertSafeSlug, isSafeSlug } from "../../runtime/safe-slug.js";
import { DEFAULT_THRESHOLD_MS, STATE_SUBDIR } from "./constants.js";

export interface IdleAlertState {
  lastFireTs: number;
}

/** Derive the state directory under the project cwd. */
export function stateDir(cwd: string): string {
  return path.join(cwd, ".omcp", "state", STATE_SUBDIR);
}

/** State file path for a given session ID. */
export function stateFilePath(cwd: string, sessionId: string): string {
  assertSafeSlug(sessionId, "sessionId");
  return path.join(stateDir(cwd), `${sessionId}.json`);
}

/** Load persisted state for a session. Returns null if not found or on error. */
export function loadState(cwd: string, sessionId: string): IdleAlertState | null {
  if (!isSafeSlug(sessionId)) return null;
  try {
    const file = stateFilePath(cwd, sessionId);
    if (!fs.existsSync(file)) return null;
    const raw = fs.readFileSync(file, "utf-8");
    return JSON.parse(raw) as IdleAlertState;
  } catch {
    return null;
  }
}

/** Persist state for a session using atomic write. */
export function persistState(cwd: string, sessionId: string, state: IdleAlertState): void {
  if (!isSafeSlug(sessionId)) return;
  try {
    const dir = stateDir(cwd);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    atomicWriteFileSync(stateFilePath(cwd, sessionId), JSON.stringify(state));
  } catch {
    // Best-effort — state persistence must never crash the hook
  }
}

/** Format a millisecond duration as a human-readable string. */
export function formatDuration(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes === 0) return `${seconds}s`;
  return `${minutes}m ${seconds}s`;
}

/**
 * Create the idle-alert Hook object.
 *
 * Subscribes to Notification.
 * Returns `{ kind: "advise", text }` when idle gap exceeds threshold,
 * `{ kind: "noop" }` otherwise.
 */
export function createIdleAlertHook(): Hook {
  return {
    name: "idle-alert",
    events: ["Notification"],

    async run(ctx: HookContext): Promise<HookResult> {
      const thresholdMs =
        process.env.OMCP_IDLE_ALERT_THRESHOLD_MS != null
          ? parseInt(process.env.OMCP_IDLE_ALERT_THRESHOLD_MS, 10) ||
            DEFAULT_THRESHOLD_MS
          : DEFAULT_THRESHOLD_MS;

      const now = Date.now();
      const existing = loadState(ctx.cwd, ctx.sessionId);
      const lastFire = existing?.lastFireTs ?? 0;
      const gap = existing != null ? now - lastFire : 0;

      // Persist updated timestamp
      persistState(ctx.cwd, ctx.sessionId, { lastFireTs: now });

      if (existing == null || gap < thresholdMs) {
        return { kind: "noop" };
      }

      return {
        kind: "advise",
        text:
          `Session has been idle for ${formatDuration(gap)} ` +
          `(threshold: ${formatDuration(thresholdMs)}). ` +
          `Consider reviewing pending tasks or resuming active work.`,
      };
    },
  };
}

export { DEFAULT_THRESHOLD_MS, STATE_SUBDIR } from "./constants.js";
