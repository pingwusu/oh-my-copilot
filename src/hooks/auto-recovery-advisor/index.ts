/**
 * Auto Recovery Advisor Hook
 *
 * Reads the last N lines of `.omcp/state/errors.jsonl` and detects recurring
 * errors (same message prefix ≥ threshold times). When detected, returns an
 * advise result with a recovery suggestion.
 *
 * Subscribes to: ErrorOccurred
 */

import * as fs from "node:fs";
import * as path from "node:path";

import type { Hook, HookContext, HookResult } from "../hook-types.js";
import {
  DEFAULT_WINDOW,
  DEFAULT_RECURRENCE_THRESHOLD,
  ERROR_KEY_LENGTH,
} from "./constants.js";

/** Path to errors.jsonl — mirrors error-aggregator's convention. */
function errorsFilePath(cwd: string): string {
  return path.join(cwd, ".omcp", "state", "errors.jsonl");
}

/**
 * Read the last `n` non-empty lines from a file.
 * Returns an empty array if the file does not exist or cannot be read.
 */
export function readLastLines(filePath: string, n: number): string[] {
  try {
    if (!fs.existsSync(filePath)) return [];
    const content = fs.readFileSync(filePath, "utf-8");
    const lines = content.split("\n").filter((l) => l.trim().length > 0);
    return lines.slice(-n);
  } catch {
    return [];
  }
}

interface ErrorLine {
  errorMessage?: string;
  [key: string]: unknown;
}

/**
 * Parse a JSONL line into an ErrorLine, returning null on failure.
 */
function parseLine(line: string): ErrorLine | null {
  try {
    return JSON.parse(line) as ErrorLine;
  } catch {
    return null;
  }
}

/**
 * Get the dedup key for an error message: first ERROR_KEY_LENGTH chars.
 */
function errorKey(msg: string): string {
  return msg.slice(0, ERROR_KEY_LENGTH);
}

export interface RecurrenceResult {
  found: boolean;
  pattern: string;
  count: number;
}

/**
 * Scan lines for recurring error messages.
 * Returns the first pattern that meets or exceeds the threshold.
 */
export function detectRecurrence(
  lines: string[],
  threshold: number,
): RecurrenceResult {
  const counts = new Map<string, number>();

  for (const line of lines) {
    const parsed = parseLine(line);
    if (!parsed) continue;
    const msg = typeof parsed.errorMessage === "string" ? parsed.errorMessage : "";
    if (!msg) continue;
    const key = errorKey(msg);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  for (const [pattern, count] of counts) {
    if (count >= threshold) {
      return { found: true, pattern, count };
    }
  }

  return { found: false, pattern: "", count: 0 };
}

/**
 * Build the advisory text for a recurring error.
 */
export function buildAdviceText(pattern: string, count: number): string {
  return (
    `Recurring error detected (${count} times in recent history):\n` +
    `  "${pattern}"\n\n` +
    `Suggested recovery actions:\n` +
    `  1. Re-read the relevant documentation or source file.\n` +
    `  2. Restart the session if the error appears environmental.\n` +
    `  3. Check for missing dependencies or misconfigured tools.\n` +
    `  4. If the error persists, consider filing a bug report.`
  );
}

/**
 * Create the auto-recovery-advisor Hook object.
 *
 * Subscribes to ErrorOccurred.
 * Returns `{ kind: "advise", text }` when recurring errors detected,
 * `{ kind: "noop" }` otherwise.
 */
export function createAutoRecoveryAdvisorHook(): Hook {
  return {
    name: "auto-recovery-advisor",
    events: ["ErrorOccurred"],

    async run(ctx: HookContext): Promise<HookResult> {
      const windowSize =
        process.env.OMCP_RECOVERY_WINDOW != null
          ? parseInt(process.env.OMCP_RECOVERY_WINDOW, 10) || DEFAULT_WINDOW
          : DEFAULT_WINDOW;

      const threshold =
        process.env.OMCP_RECOVERY_RECURRENCE_THRESHOLD != null
          ? parseInt(process.env.OMCP_RECOVERY_RECURRENCE_THRESHOLD, 10) ||
            DEFAULT_RECURRENCE_THRESHOLD
          : DEFAULT_RECURRENCE_THRESHOLD;

      const filePath = errorsFilePath(ctx.cwd);
      const lines = readLastLines(filePath, windowSize);

      if (lines.length === 0) {
        return { kind: "noop" };
      }

      const result = detectRecurrence(lines, threshold);

      if (!result.found) {
        return { kind: "noop" };
      }

      return {
        kind: "advise",
        text: buildAdviceText(result.pattern, result.count),
      };
    },
  };
}

export {
  DEFAULT_WINDOW,
  DEFAULT_RECURRENCE_THRESHOLD,
  ERROR_KEY_LENGTH,
} from "./constants.js";
