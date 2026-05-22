// Boulder state — active-plan tracking for omcp's orchestrator pattern.
//
// "The boulder" is the eternal task the orchestrator keeps rolling: an
// active plan file (markdown checklist) plus a record of which sessions
// have worked on it. When the boulder is active, hooks remind the agent
// to keep pushing the plan forward.
//
// Ported from omc/src/features/boulder-state/{types,constants,storage,
// index}.ts. Differences:
//   - State file moved from `.omc/boulder.json` to
//     `.omcp/state/boulder-state.json` (HANDOFF spec + omcp convention)
//   - camelCase fields throughout (sessionIds vs session_ids, etc.)
//   - withFileLockSync wrapper dropped (omcp is single-process today —
//     concurrent-session locking would land if/when a multi-session
//     orchestrator is introduced)
//   - Plan directory: `.omcp/plans/` (matches subsystem 1's OmcpPaths.PLANS)

import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { basename, join } from "node:path";

import { atomicWriteFileSync } from "../runtime/atomic-write.js";
import {
  ensureOmcpDir,
  getOmcpRoot,
  OmcpPaths,
  resolveStatePath,
} from "./worktree-paths.js";

// ──────────────────────────────────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────────────────────────────────

/** State tracking an active work plan. */
export interface BoulderState {
  /** Absolute path to the active plan markdown file. */
  activePlan: string;
  /** ISO timestamp when work started. */
  startedAt: string;
  /** Session ids that have worked on this plan. */
  sessionIds: string[];
  /** Plan name derived from the filename (without `.md`). */
  planName: string;
  /** Whether the boulder is currently active. */
  active: boolean;
  /** ISO timestamp of the last state mutation (for stale detection). */
  updatedAt: string;
  /** Optional free-form metadata. */
  metadata?: Record<string, unknown>;
}

/** Aggregate checkbox-progress for a single plan file. */
export interface PlanProgress {
  total: number;
  completed: number;
  isComplete: boolean;
}

/** Summary entry for `getPlanSummaries`. */
export interface PlanSummary {
  path: string;
  name: string;
  progress: PlanProgress;
  lastModified: Date;
}

// ──────────────────────────────────────────────────────────────────────────
// File paths
// ──────────────────────────────────────────────────────────────────────────

const STATE_NAME = "boulder";

/** Absolute path to `.omcp/state/boulder-state.json`. */
export function getBoulderFilePath(worktreeRoot?: string): string {
  return resolveStatePath(STATE_NAME, worktreeRoot);
}

/** Absolute path to the `.omcp/plans/` directory. */
export function getPlansDir(worktreeRoot?: string): string {
  return join(getOmcpRoot(worktreeRoot), "plans");
}

const PLAN_EXTENSION = ".md";

// ──────────────────────────────────────────────────────────────────────────
// State CRUD
// ──────────────────────────────────────────────────────────────────────────

function isValidBoulderState(value: unknown): value is BoulderState {
  if (!value || typeof value !== "object") return false;
  const s = value as Record<string, unknown>;
  return (
    typeof s.activePlan === "string" &&
    typeof s.startedAt === "string" &&
    Array.isArray(s.sessionIds) &&
    s.sessionIds.every((id) => typeof id === "string") &&
    typeof s.planName === "string" &&
    typeof s.active === "boolean" &&
    typeof s.updatedAt === "string"
  );
}

/** Read boulder state, returning null when absent or malformed. */
export function readBoulderState(worktreeRoot?: string): BoulderState | null {
  const file = getBoulderFilePath(worktreeRoot);
  if (!existsSync(file)) return null;

  try {
    const parsed = JSON.parse(readFileSync(file, "utf-8"));
    return isValidBoulderState(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** Persist boulder state atomically. */
export function writeBoulderState(
  state: BoulderState,
  worktreeRoot?: string,
): boolean {
  try {
    ensureOmcpDir("state", worktreeRoot);
    atomicWriteFileSync(
      getBoulderFilePath(worktreeRoot),
      JSON.stringify(state, null, 2),
    );
    return true;
  } catch {
    return false;
  }
}

/**
 * Remove the boulder state file (no-op when already absent).
 *
 * Returns false only if an unexpected removal error occurs.
 */
export function clearBoulderState(worktreeRoot?: string): boolean {
  const file = getBoulderFilePath(worktreeRoot);
  if (!existsSync(file)) return true;
  try {
    unlinkSync(file);
    return true;
  } catch {
    return false;
  }
}

/**
 * Append a session id to the boulder state.
 *
 * Idempotent — duplicate ids are not appended a second time. Returns the
 * updated state, or null when no state exists / the write fails.
 */
export function appendSessionId(
  sessionId: string,
  worktreeRoot?: string,
): BoulderState | null {
  const state = readBoulderState(worktreeRoot);
  if (!state) return null;

  if (state.sessionIds.includes(sessionId)) {
    return state;
  }

  state.sessionIds = [...state.sessionIds, sessionId];
  state.updatedAt = new Date().toISOString();
  return writeBoulderState(state, worktreeRoot) ? state : null;
}

// ──────────────────────────────────────────────────────────────────────────
// Plan discovery + progress
// ──────────────────────────────────────────────────────────────────────────

/**
 * List `.omcp/plans/*.md` paths, newest-modified first.
 *
 * Returns `[]` when the plans directory does not exist — callers do not
 * need to pre-check.
 */
export function findPlans(worktreeRoot?: string): string[] {
  const plansDir = getPlansDir(worktreeRoot);
  if (!existsSync(plansDir)) return [];

  try {
    const files = readdirSync(plansDir);
    return files
      .filter((f) => f.endsWith(PLAN_EXTENSION))
      .map((f) => join(plansDir, f))
      .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  } catch {
    return [];
  }
}

/**
 * Parse a markdown plan file and count `- [ ]` / `- [x]` checkboxes.
 *
 * Returns `{ total: 0, completed: 0, isComplete: true }` when the file is
 * missing or has zero checkboxes — the caller treats a checklist-less
 * plan as trivially complete.
 */
export function getPlanProgress(planPath: string): PlanProgress {
  let content: string;
  try {
    content = readFileSync(planPath, "utf-8");
  } catch {
    return { total: 0, completed: 0, isComplete: true };
  }

  const unchecked = content.match(/^[-*]\s*\[\s\]/gm) || [];
  const checked = content.match(/^[-*]\s*\[[xX]\]/gm) || [];
  const total = unchecked.length + checked.length;
  const completed = checked.length;

  return {
    total,
    completed,
    isComplete: total === 0 || completed === total,
  };
}

/** Extract a plan name (filename without `.md`). */
export function getPlanName(planPath: string): string {
  return basename(planPath, PLAN_EXTENSION);
}

/**
 * Summarize every plan in `.omcp/plans/`.
 *
 * Sorted newest-modified first (matches `findPlans`).
 */
export function getPlanSummaries(worktreeRoot?: string): PlanSummary[] {
  return findPlans(worktreeRoot).map((path) => {
    const stat = statSync(path);
    return {
      path,
      name: getPlanName(path),
      progress: getPlanProgress(path),
      lastModified: new Date(stat.mtimeMs),
    };
  });
}

// ──────────────────────────────────────────────────────────────────────────
// Boulder lifecycle helpers
// ──────────────────────────────────────────────────────────────────────────

/** Build a fresh BoulderState (does not write to disk). */
export function createBoulderState(
  planPath: string,
  sessionId: string,
): BoulderState {
  const now = new Date().toISOString();
  return {
    activePlan: planPath,
    startedAt: now,
    sessionIds: [sessionId],
    planName: getPlanName(planPath),
    active: true,
    updatedAt: now,
  };
}

/** Convenience predicate: does a valid boulder state exist? */
export function hasBoulder(worktreeRoot?: string): boolean {
  return readBoulderState(worktreeRoot) !== null;
}

/** The absolute path of the active plan, or null when no boulder is set. */
export function getActivePlanPath(worktreeRoot?: string): string | null {
  return readBoulderState(worktreeRoot)?.activePlan ?? null;
}

/** Constant exported for callers that just want the plan-extension token. */
export { PLAN_EXTENSION };

/** Convenience re-export so callers do not need to import worktree-paths twice. */
export const PLANS_DIR_NAME: string = OmcpPaths.PLANS;
