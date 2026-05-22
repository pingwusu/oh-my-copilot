// Ultrawork state — parallel-execution-engine persistence for omcp.
//
// Ported from omc/src/hooks/ultrawork/index.ts. Ultrawork mode reinforces
// parallel-task execution and tracks reinforcement counts so the consuming
// hook can decide when to re-inject the persistence prompt.
//
// State file: .omcp/state/ultrawork-state.json (atomicWriteFileSync per
// invariant 2). Mirrors omc's UltraworkState shape — camelCase to match
// omcp conventions, and includes `linkedToRalph` so a future ralph hook
// can scope its cancel behaviour to only ultrawork sessions it
// auto-activated.

import { existsSync, readFileSync, unlinkSync } from "node:fs";

import { atomicWriteFileSync } from "../runtime/atomic-write.js";
import { ensureOmcpDir, resolveStatePath } from "./worktree-paths.js";

// ──────────────────────────────────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────────────────────────────────

/** Ultrawork mode state — persisted at `.omcp/state/ultrawork-state.json`. */
export interface UltraworkState {
  /** Whether ultrawork mode is currently active. */
  active: boolean;
  /** ISO timestamp of activation. */
  startedAt: string;
  /** The original prompt that triggered ultrawork. */
  originalPrompt: string;
  /** Times the persistence prompt has been re-injected. */
  reinforcementCount: number;
  /** ISO timestamp of the last reinforcement check. */
  lastCheckedAt: string;
  /**
   * When true, this ultrawork session was auto-activated by ralph and
   * should be cleared by `clearLinkedUltraworkState` whenever ralph
   * deactivates. Stand-alone ultrawork sessions set this to false (or
   * leave it unset).
   */
  linkedToRalph?: boolean;
}

// ──────────────────────────────────────────────────────────────────────────
// File paths
// ──────────────────────────────────────────────────────────────────────────

const STATE_NAME = "ultrawork";

function statePath(worktreeRoot?: string): string {
  return resolveStatePath(STATE_NAME, worktreeRoot);
}

// ──────────────────────────────────────────────────────────────────────────
// State CRUD
// ──────────────────────────────────────────────────────────────────────────

/** Read ultrawork state from disk, or `null` if no state file exists. */
export function readUltraworkState(
  worktreeRoot?: string,
): UltraworkState | null {
  const file = statePath(worktreeRoot);
  if (!existsSync(file)) return null;

  try {
    const parsed = JSON.parse(readFileSync(file, "utf-8")) as Partial<UltraworkState>;
    if (
      typeof parsed.active !== "boolean" ||
      typeof parsed.startedAt !== "string" ||
      typeof parsed.originalPrompt !== "string" ||
      typeof parsed.reinforcementCount !== "number" ||
      typeof parsed.lastCheckedAt !== "string"
    ) {
      return null;
    }
    const state: UltraworkState = {
      active: parsed.active,
      startedAt: parsed.startedAt,
      originalPrompt: parsed.originalPrompt,
      reinforcementCount: parsed.reinforcementCount,
      lastCheckedAt: parsed.lastCheckedAt,
    };
    if (typeof parsed.linkedToRalph === "boolean") {
      state.linkedToRalph = parsed.linkedToRalph;
    }
    return state;
  } catch {
    return null;
  }
}

/** Persist ultrawork state atomically. */
export function writeUltraworkState(
  state: UltraworkState,
  worktreeRoot?: string,
): boolean {
  try {
    ensureOmcpDir("state", worktreeRoot);
    atomicWriteFileSync(statePath(worktreeRoot), JSON.stringify(state, null, 2));
    return true;
  } catch {
    return false;
  }
}

/**
 * Remove the ultrawork state file if it exists.
 *
 * Returns true if the file was removed or absent.
 */
export function clearUltraworkState(worktreeRoot?: string): boolean {
  const file = statePath(worktreeRoot);
  if (!existsSync(file)) return true;
  try {
    unlinkSync(file);
    return true;
  } catch {
    return false;
  }
}

// ──────────────────────────────────────────────────────────────────────────
// Lifecycle
// ──────────────────────────────────────────────────────────────────────────

/** Activate ultrawork mode with the given prompt. */
export function activateUltrawork(
  prompt: string,
  opts: { linkedToRalph?: boolean; worktreeRoot?: string } = {},
): boolean {
  const now = new Date().toISOString();
  const state: UltraworkState = {
    active: true,
    startedAt: now,
    originalPrompt: prompt,
    reinforcementCount: 0,
    lastCheckedAt: now,
    linkedToRalph: opts.linkedToRalph ?? false,
  };
  return writeUltraworkState(state, opts.worktreeRoot);
}

/** Deactivate ultrawork (alias for `clearUltraworkState`). */
export function deactivateUltrawork(worktreeRoot?: string): boolean {
  return clearUltraworkState(worktreeRoot);
}

/**
 * Clear ultrawork state ONLY when it was linked to ralph.
 *
 * Used by the ralph cancel path: stand-alone ultrawork sessions survive a
 * ralph cancel; only sessions ralph auto-activated are torn down.
 *
 * Returns true on success (including the no-op case where nothing was
 * linked).
 */
export function clearLinkedUltraworkState(worktreeRoot?: string): boolean {
  const state = readUltraworkState(worktreeRoot);
  if (!state || !state.linkedToRalph) return true;
  return clearUltraworkState(worktreeRoot);
}

/**
 * Bump the reinforcement counter and refresh `lastCheckedAt`.
 *
 * Returns the updated state. Returns null when no state exists, the state
 * is inactive, or the write fails.
 */
export function incrementReinforcement(
  worktreeRoot?: string,
): UltraworkState | null {
  const state = readUltraworkState(worktreeRoot);
  if (!state || !state.active) return null;

  state.reinforcementCount += 1;
  state.lastCheckedAt = new Date().toISOString();

  return writeUltraworkState(state, worktreeRoot) ? state : null;
}

/**
 * True when ultrawork is active — caller should reinforce the prompt.
 *
 * Strict check: state must exist AND be active. Use this in Stop-style
 * hooks where the absence of state means "do nothing".
 */
export function shouldReinforceUltrawork(worktreeRoot?: string): boolean {
  const state = readUltraworkState(worktreeRoot);
  return state !== null && state.active;
}

// ──────────────────────────────────────────────────────────────────────────
// Prompt injection
// ──────────────────────────────────────────────────────────────────────────

/**
 * Compose the reinforcement message a Stop hook injects when ultrawork is
 * still active.
 *
 * The message restates the ultrawork discipline (parallel calls, background
 * tasks, todo tracking, completion verification) and the original prompt.
 */
export function getUltraworkPersistenceMessage(state: UltraworkState): string {
  return `<ultrawork-persistence>

[ULTRAWORK MODE STILL ACTIVE — Reinforcement #${state.reinforcementCount + 1}]

Your ultrawork session is NOT complete. Pending work remains.

REMEMBER THE ULTRAWORK RULES:
- **PARALLEL**: Fire independent calls simultaneously — never wait sequentially
- **BACKGROUND FIRST**: Use run_in_background for long operations
- **TODO**: Track every step. Mark complete IMMEDIATELY after each
- **VERIFY**: Confirm ALL requirements met before declaring done
- **NO PREMATURE STOPPING**: All tasks must be complete

Continue working on the next pending task.

Original task: ${state.originalPrompt}

</ultrawork-persistence>
`;
}
