/**
 * Audit Logger Hook
 *
 * Appends one JSON-line per hook fire to `.omcp/state/audit/{sessionId}.jsonl`.
 * Append-only (not atomic-overwrite): each line is independently parseable
 * and crash-truncation only loses the partial last line.
 *
 * toolArgs are clamped to MAX_ARGS_LEN characters.
 * toolResult is NOT logged — only whether it was present.
 *
 * Rotates the file when it exceeds ROTATION_BYTES.
 *
 * Subscribes to: PreToolUse, PostToolUse, PostToolUseFailure
 */

import * as fs from "node:fs";
import * as path from "node:path";

import type { Hook, HookContext, HookResult } from "../hook-types.js";
import { assertSafeSlug, isSafeSlug } from "../../runtime/safe-slug.js";

import { ROTATION_BYTES, MAX_ARGS_LEN } from "./constants.js";

// ─── Record schema ────────────────────────────────────────────────────────────

interface AuditRecord {
  ts: string;
  event: string;
  toolName: string | undefined;
  toolArgs: string;
  toolResultPresence: "present" | "null" | "absent";
}

// ─── Path helpers ─────────────────────────────────────────────────────────────

function auditDir(cwd: string): string {
  return path.join(cwd, ".omcp", "state", "audit");
}

function auditFilePath(cwd: string, sessionId: string): string {
  assertSafeSlug(sessionId, "sessionId");
  return path.join(auditDir(cwd), `${sessionId}.jsonl`);
}

// ─── Rotation ─────────────────────────────────────────────────────────────────

/**
 * If the audit file at `filePath` exceeds ROTATION_BYTES, rename it to
 * `{sessionId}.{timestamp}.jsonl` so that the next append starts a fresh file.
 */
export function maybeRotate(filePath: string): void {
  try {
    if (!fs.existsSync(filePath)) return;
    const stat = fs.statSync(filePath);
    if (stat.size < ROTATION_BYTES) return;

    const dir = path.dirname(filePath);
    const base = path.basename(filePath, ".jsonl");
    const ts = Date.now();
    const rotated = path.join(dir, `${base}.${ts}.jsonl`);
    fs.renameSync(filePath, rotated);
  } catch {
    // Best-effort: rotation failure must never crash the hook
  }
}

// ─── Args clamping ────────────────────────────────────────────────────────────

/**
 * Serialize toolArgs to JSON and clamp to MAX_ARGS_LEN chars.
 * Appends `[...truncated]` when clamped.
 */
export function clampArgs(toolArgs: unknown): string {
  const json = JSON.stringify(toolArgs);
  // JSON.stringify(undefined) returns undefined (not a string)
  if (json === undefined) return "undefined";
  if (json.length <= MAX_ARGS_LEN) return json;
  return json.slice(0, MAX_ARGS_LEN) + "[...truncated]";
}

// ─── Result presence check ────────────────────────────────────────────────────

function resultPresence(toolResult: unknown): "present" | "null" | "absent" {
  if (toolResult === undefined) return "absent";
  if (toolResult === null) return "null";
  return "present";
}

// ─── Hook factory ─────────────────────────────────────────────────────────────

/**
 * Create the audit-logger Hook object.
 *
 * Subscribes to PreToolUse, PostToolUse, PostToolUseFailure.
 * Always returns `{ kind: "noop" }` — audit is observational only.
 */
export function createAuditLoggerHook(): Hook {
  return {
    name: "audit-logger",
    events: ["PreToolUse", "PostToolUse", "PostToolUseFailure"],

    async run(ctx: HookContext): Promise<HookResult> {
      const { event, sessionId, cwd, toolName, toolArgs, toolResult } = ctx;

      if (!isSafeSlug(sessionId)) return { kind: "noop" };

      const record: AuditRecord = {
        ts: new Date().toISOString(),
        event,
        toolName,
        toolArgs: clampArgs(toolArgs),
        toolResultPresence: resultPresence(toolResult),
      };

      try {
        const dir = auditDir(cwd);
        if (!fs.existsSync(dir)) {
          fs.mkdirSync(dir, { recursive: true });
        }

        const filePath = auditFilePath(cwd, sessionId);
        maybeRotate(filePath);
        fs.appendFileSync(filePath, JSON.stringify(record) + "\n", "utf-8");
      } catch {
        // Best-effort: logging failure must never crash the hook
      }

      return { kind: "noop" };
    },
  };
}

export { ROTATION_BYTES, MAX_ARGS_LEN } from "./constants.js";
