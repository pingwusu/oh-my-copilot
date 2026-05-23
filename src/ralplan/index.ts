/**
 * Ralplan → Boulder integration
 *
 * After a consensus planning loop produces a plan, this module:
 *   1. Derives a filesystem-safe slug from the task description
 *   2. Writes the plan content to `.omcp/plans/<slug>.md`
 *   3. Registers boulder state (active=true, activePlan=<path>) via
 *      writeBoulderState so the omc-orchestrator hook picks it up
 *   4. Optionally writes a ralplan mode-state entry so the persistent-mode
 *      hook can hand off to ralph execution
 *
 * This is intentionally a pure coordination layer — it does not run any
 * consensus loop itself; that belongs to the skill/skill-runner layer.
 * The function `registerRalplan` is the single integration entry point.
 */

import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

import {
  createBoulderState,
  writeBoulderState,
  appendSessionId,
  readBoulderState,
  getPlansDir,
  getPlanName,
} from "../lib/boulder-state.js";
import { atomicWriteFileSync } from "../runtime/atomic-write.js";
import { ensureOmcpDir } from "../lib/worktree-paths.js";
import { writeModeState } from "../runtime/mode-state.js";
import type { BaseModeState } from "../runtime/mode-state.js";

// ──────────────────────────────────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────────────────────────────────

export interface RalplanInput {
  /** Free-form task description — used to derive the plan file slug. */
  task: string;
  /** Markdown content of the consensus plan. */
  planContent: string;
  /** Session id of the current agent session. */
  sessionId: string;
  /** Worktree root (defaults to process.cwd()). */
  worktreeRoot?: string;
  /**
   * When true, writes a `ralplan` mode-state entry so the persistent-mode
   * hook can hand off to ralph for plan execution.
   * Defaults to false.
   */
  handOffToRalph?: boolean;
}

export interface RalplanResult {
  /** Absolute path of the written plan file. */
  planPath: string;
  /** Slug derived from the task (filename without .md). */
  slug: string;
  /** Whether boulder state was written successfully. */
  boulderWritten: boolean;
  /** Whether the plan file already existed before this call. */
  planAlreadyExisted: boolean;
}

// ──────────────────────────────────────────────────────────────────────────
// Slug derivation
// ──────────────────────────────────────────────────────────────────────────

/**
 * Derive a safe, readable file slug from a free-form task description.
 *
 * Rules:
 *   - Lowercase
 *   - Replace non-alphanumeric runs with single hyphens
 *   - Strip leading/trailing hyphens
 *   - Truncate to 60 characters
 *   - Fall back to "plan" when the result is empty
 */
export function deriveSlug(task: string): string {
  const slug = task
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return slug || "plan";
}

/**
 * Derive a unique plan file path under `.omcp/plans/`.
 *
 * If `<slug>.md` already exists, appends `-2`, `-3`, … until a free slot
 * is found (up to 99). Callers that want to overwrite an existing plan
 * should pass the path directly to `registerRalplan`.
 */
export function derivePlanPath(
  task: string,
  worktreeRoot?: string,
): { path: string; slug: string; alreadyExisted: boolean } {
  const base = deriveSlug(task);
  const plansDir = getPlansDir(worktreeRoot);

  const candidate = join(plansDir, `${base}.md`);
  if (!existsSync(candidate)) {
    return { path: candidate, slug: base, alreadyExisted: false };
  }

  for (let i = 2; i <= 99; i++) {
    const slug = `${base}-${i}`;
    const p = join(plansDir, `${slug}.md`);
    if (!existsSync(p)) {
      return { path: p, slug, alreadyExisted: true };
    }
  }

  // Extremely unlikely fallback — timestamp suffix
  const slug = `${base}-${Date.now()}`;
  return { path: join(plansDir, `${slug}.md`), slug, alreadyExisted: true };
}

// ──────────────────────────────────────────────────────────────────────────
// Core integration
// ──────────────────────────────────────────────────────────────────────────

/**
 * Write the plan file and register boulder state.
 *
 * This is idempotent when called with the same session id — if boulder
 * state already exists for the same plan, the session id is appended
 * rather than resetting the state.
 */
export function registerRalplan(input: RalplanInput): RalplanResult {
  const { task, planContent, sessionId, worktreeRoot, handOffToRalph } = input;

  // 1. Ensure plans directory exists
  const plansDir = getPlansDir(worktreeRoot);
  if (!existsSync(plansDir)) {
    mkdirSync(plansDir, { recursive: true });
  }

  // 2. Derive plan path
  const { path: planPath, slug, alreadyExisted } = derivePlanPath(task, worktreeRoot);

  // 3. Write plan file atomically
  ensureOmcpDir("plans", worktreeRoot);
  atomicWriteFileSync(planPath, planContent);

  // 4. Register or update boulder state
  const existing = readBoulderState(worktreeRoot);
  let boulderWritten: boolean;

  if (existing && existing.activePlan === planPath) {
    // Same plan already registered — just append session id
    const updated = appendSessionId(sessionId, worktreeRoot);
    boulderWritten = updated !== null;
  } else {
    // New plan — create fresh boulder state
    const state = createBoulderState(planPath, sessionId);
    boulderWritten = writeBoulderState(state, worktreeRoot);
  }

  // 5. Optionally register ralplan mode-state for ralph hand-off
  if (handOffToRalph) {
    const modeState: BaseModeState = {
      active: true,
      session_id: sessionId,
      started_at: new Date().toISOString(),
      prompt: `Execute plan: ${planPath}`,
    };
    try {
      writeModeState("ralplan", modeState, sessionId);
    } catch {
      // Non-fatal — boulder state is the authoritative record
    }
  }

  return { planPath, slug, boulderWritten, planAlreadyExisted: alreadyExisted };
}

// ──────────────────────────────────────────────────────────────────────────
// Convenience re-exports for callers
// ──────────────────────────────────────────────────────────────────────────

export { getPlanName, getPlansDir };
