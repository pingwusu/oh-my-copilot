/**
 * Error Aggregator Hook
 *
 * Observational hook that appends a JSON line per ErrorOccurred event to
 * `.omcp/state/errors.jsonl`. Supports rotation when the file exceeds 10 MB.
 *
 * Subscribes to: ErrorOccurred
 */

import * as fs from "node:fs";
import * as path from "node:path";

import type { Hook, HookContext, HookResult } from "../hook-types.js";
import { ROTATION_BYTES } from "./constants.js";

export interface ErrorRecord {
  ts: string;
  sessionId: string;
  toolName: string | null;
  errorMessage: string;
  errorStack: string | null;
}

/** Resolve the errors.jsonl path for a given project cwd. */
export function errorsFilePath(cwd: string): string {
  return path.join(cwd, ".omcp", "state", "errors.jsonl");
}

/** Coerce an unknown value to string, with a fallback. */
function coerceString(val: unknown, fallback: string): string {
  if (typeof val === "string" && val.length > 0) return val;
  if (val != null) {
    const s = String(val);
    if (s.length > 0) return s;
  }
  return fallback;
}

/**
 * Rotate errors.jsonl → errors.{timestamp}.jsonl if the file exceeds
 * ROTATION_BYTES. Creates the state dir if needed.
 */
export function maybeRotate(filePath: string): void {
  try {
    if (!fs.existsSync(filePath)) return;
    const stat = fs.statSync(filePath);
    if (stat.size >= ROTATION_BYTES) {
      const ts = new Date().toISOString().replace(/[:.]/g, "-");
      const rotated = filePath.replace(/\.jsonl$/, `.${ts}.jsonl`);
      fs.renameSync(filePath, rotated);
    }
  } catch {
    // Best-effort — rotation must never crash the hook
  }
}

/**
 * Append a single ErrorRecord as a JSON line to errors.jsonl.
 * Creates the parent directory and the file if they do not exist.
 */
export function appendErrorRecord(cwd: string, record: ErrorRecord): void {
  const filePath = errorsFilePath(cwd);
  const dir = path.dirname(filePath);
  try {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    maybeRotate(filePath);
    fs.appendFileSync(filePath, JSON.stringify(record) + "\n", "utf-8");
  } catch {
    // Best-effort — logging must never crash the hook
  }
}

/**
 * Build an ErrorRecord from hook context.
 */
export function buildErrorRecord(ctx: HookContext): ErrorRecord {
  const args = ctx.toolArgs as Record<string, unknown> | undefined;
  return {
    ts: new Date().toISOString(),
    sessionId: ctx.sessionId,
    toolName: ctx.toolName ?? null,
    errorMessage: coerceString(args?.errorMessage, "(unknown)"),
    errorStack: args?.errorStack != null
      ? coerceString(args.errorStack, "")
      : null,
  };
}

/**
 * Create the error-aggregator Hook object.
 *
 * Subscribes to ErrorOccurred.
 * Returns `{ kind: "noop" }` — observational only.
 */
export function createErrorAggregatorHook(): Hook {
  return {
    name: "error-aggregator",
    events: ["ErrorOccurred"],

    async run(ctx: HookContext): Promise<HookResult> {
      const record = buildErrorRecord(ctx);
      appendErrorRecord(ctx.cwd, record);
      return { kind: "noop" };
    },
  };
}

export { ROTATION_BYTES } from "./constants.js";
