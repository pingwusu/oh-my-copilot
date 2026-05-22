// Notepad state — orchestrator-friendly API on top of `runtime/notepad.ts`.
//
// The omc-orchestrator hook (Phase 2 Batch C session N+2) needs two
// specific operations beyond the raw section reads/writes:
//   - `addWorkingMemoryEntry(text)` — append a timestamped note
//   - `setPriorityContext(text)` — replace the priority section in full
//     (not append) and remember when/how it was set
//
// All file I/O is delegated to the existing pure-functional notepad
// primitives in `../runtime/notepad.ts`. This module adds:
//   - Worktree-scoped path resolution (default goes through
//     `getWorktreeNotepadPath` from worktree-paths so a non-cwd worktree
//     root is honoured; the runtime's `OMCP_NOTEPAD_PATH` env override
//     still wins for test isolation)
//   - A small JSON sidecar at `.omcp/state/notepad-priority.json` that
//     records the priority context's set timestamp + source label
//   - Default char-limit guard for priority context (500 chars, matching
//     omc's notepad subsystem)

import { existsSync, readFileSync, unlinkSync } from "node:fs";

import { atomicWriteFileSync } from "../runtime/atomic-write.js";
import {
  loadNotepad,
  saveNotepad,
  type Notepad,
} from "../runtime/notepad.js";
import {
  ensureOmcpDir,
  getWorktreeNotepadPath,
  resolveStatePath,
} from "./worktree-paths.js";

// ──────────────────────────────────────────────────────────────────────────
// Types + constants
// ──────────────────────────────────────────────────────────────────────────

/** Sidecar metadata for the priority-context section. */
export interface NotepadPriorityState {
  /** The current priority content (mirrors notepad.md priority section). */
  content: string;
  /** ISO timestamp when the priority context was last set. */
  setAt: string;
  /** Optional label identifying the agent/hook that set this entry. */
  source?: string;
  /** Effective character limit applied at write time. */
  maxChars: number;
}

/** Result of `setPriorityContext`. */
export interface PriorityContextResult {
  success: boolean;
  /** Warning text when input was truncated to fit `maxChars`. */
  warning?: string;
}

/** Three-section stats summary. */
export interface NotepadStats {
  priority: number;
  working: number;
  manual: number;
  /** Effective notepad.md path the stats were read from. */
  path: string;
}

/** Maximum characters retained in priority context (matches omc's default). */
export const PRIORITY_MAX_CHARS = 500;

const PRIORITY_STATE_NAME = "notepad-priority";

// ──────────────────────────────────────────────────────────────────────────
// Path resolution
// ──────────────────────────────────────────────────────────────────────────

/**
 * Resolve the notepad markdown path.
 *
 * Honours `OMCP_NOTEPAD_PATH` (set by the runtime layer for test
 * isolation) before falling back to the worktree-scoped notepad file.
 */
function resolveNotepadFile(worktreeRoot?: string): string {
  return process.env.OMCP_NOTEPAD_PATH ?? getWorktreeNotepadPath(worktreeRoot);
}

function resolvePriorityStateFile(worktreeRoot?: string): string {
  return resolveStatePath(PRIORITY_STATE_NAME, worktreeRoot);
}

// ──────────────────────────────────────────────────────────────────────────
// Priority-state sidecar
// ──────────────────────────────────────────────────────────────────────────

/** Read the priority-context sidecar JSON, returning null when absent. */
export function readPriorityState(
  worktreeRoot?: string,
): NotepadPriorityState | null {
  const file = resolvePriorityStateFile(worktreeRoot);
  if (!existsSync(file)) return null;
  try {
    const parsed = JSON.parse(readFileSync(file, "utf-8")) as Partial<NotepadPriorityState>;
    if (
      typeof parsed.content !== "string" ||
      typeof parsed.setAt !== "string" ||
      typeof parsed.maxChars !== "number"
    ) {
      return null;
    }
    const state: NotepadPriorityState = {
      content: parsed.content,
      setAt: parsed.setAt,
      maxChars: parsed.maxChars,
    };
    if (typeof parsed.source === "string") state.source = parsed.source;
    return state;
  } catch {
    return null;
  }
}

function writePriorityState(
  state: NotepadPriorityState,
  worktreeRoot?: string,
): boolean {
  try {
    ensureOmcpDir("state", worktreeRoot);
    atomicWriteFileSync(
      resolvePriorityStateFile(worktreeRoot),
      JSON.stringify(state, null, 2),
    );
    return true;
  } catch {
    return false;
  }
}

/** Remove the priority-context sidecar (notepad.md is left untouched). */
export function clearPriorityState(worktreeRoot?: string): boolean {
  const file = resolvePriorityStateFile(worktreeRoot);
  if (!existsSync(file)) return true;
  try {
    unlinkSync(file);
    return true;
  } catch {
    return false;
  }
}

// ──────────────────────────────────────────────────────────────────────────
// Working memory operations
// ──────────────────────────────────────────────────────────────────────────

/**
 * Append a timestamped entry to the working-memory section.
 *
 * Entries are written as a single line prefixed with the ISO timestamp,
 * matching the format `runtime/notepad.ts` already round-trips. Returns
 * the new total count of working-memory entries.
 */
export function addWorkingMemoryEntry(
  text: string,
  opts: { source?: string; worktreeRoot?: string } = {},
): { ok: true; count: number } {
  const path = resolveNotepadFile(opts.worktreeRoot);
  const np = loadNotepad(path);
  const stamp = new Date().toISOString();
  const sourceTag = opts.source ? ` [${opts.source}]` : "";
  np.working.push(`- ${stamp}${sourceTag} ${text}`);
  saveNotepad(np, path);
  return { ok: true, count: np.working.length };
}

/** Return the working-memory section as an array of lines. */
export function getWorkingMemory(worktreeRoot?: string): string[] {
  const path = resolveNotepadFile(worktreeRoot);
  return loadNotepad(path).working;
}

/**
 * Drop working-memory entries.
 *
 * When `olderThanDays` is provided, only entries whose ISO-timestamp
 * prefix is older than that many days are removed. Without it every
 * entry is cleared.
 */
export function pruneWorkingMemory(
  opts: { olderThanDays?: number; worktreeRoot?: string } = {},
): { pruned: number; remaining: number } {
  const path = resolveNotepadFile(opts.worktreeRoot);
  const np = loadNotepad(path);
  const before = np.working.length;

  if (opts.olderThanDays === undefined) {
    np.working = [];
  } else {
    const cutoff = Date.now() - opts.olderThanDays * 24 * 60 * 60 * 1000;
    np.working = np.working.filter((line) => {
      const match = line.match(/(\d{4}-\d{2}-\d{2}T[\d:.]+Z)/);
      if (!match) return true;
      return Date.parse(match[1]) >= cutoff;
    });
  }

  saveNotepad(np, path);
  return { pruned: before - np.working.length, remaining: np.working.length };
}

// ──────────────────────────────────────────────────────────────────────────
// Priority context
// ──────────────────────────────────────────────────────────────────────────

/**
 * Replace the priority-context section with `text`.
 *
 * Behaviour:
 *   - `text` longer than `maxChars` (default {@link PRIORITY_MAX_CHARS})
 *     is truncated and the result includes `warning` describing the
 *     truncation. The caller decides whether to surface the warning.
 *   - The priority section in notepad.md is overwritten (not appended).
 *   - The sidecar JSON at `.omcp/state/notepad-priority.json` records
 *     the timestamp, optional source label, and effective limit.
 */
export function setPriorityContext(
  text: string,
  opts: { maxChars?: number; source?: string; worktreeRoot?: string } = {},
): PriorityContextResult {
  const maxChars = opts.maxChars ?? PRIORITY_MAX_CHARS;
  let content = text;
  let warning: string | undefined;
  if (content.length > maxChars) {
    warning = `priority context truncated from ${content.length} to ${maxChars} chars`;
    content = content.slice(0, maxChars);
  }

  const path = resolveNotepadFile(opts.worktreeRoot);
  const np: Notepad = loadNotepad(path);
  np.priority = content
    .split(/\r?\n/)
    .map((l) => l.trimEnd())
    .filter((l) => l.length > 0);
  saveNotepad(np, path);

  const sidecarWritten = writePriorityState(
    {
      content,
      setAt: new Date().toISOString(),
      source: opts.source,
      maxChars,
    },
    opts.worktreeRoot,
  );

  const result: PriorityContextResult = { success: sidecarWritten };
  if (warning) result.warning = warning;
  return result;
}

/** Read the priority section directly from notepad.md (joined back into a string). */
export function getPriorityContext(worktreeRoot?: string): string {
  const path = resolveNotepadFile(worktreeRoot);
  return loadNotepad(path).priority.join("\n");
}

// ──────────────────────────────────────────────────────────────────────────
// Stats
// ──────────────────────────────────────────────────────────────────────────

/** Return the per-section line counts for the active notepad file. */
export function getNotepadStats(worktreeRoot?: string): NotepadStats {
  const path = resolveNotepadFile(worktreeRoot);
  const np = loadNotepad(path);
  return {
    priority: np.priority.length,
    working: np.working.length,
    manual: np.manual.length,
    path,
  };
}
