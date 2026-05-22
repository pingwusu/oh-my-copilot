/**
 * Cost Governor Hook
 *
 * Tracks cumulative tool-call count per session and interrupts when a
 * configurable budget is reached.
 *
 * Subscribes to: PermissionRequest
 *
 * State is persisted to `.omcp/state/cost-governor/{sessionId}.json` via
 * atomicWriteFileSync so the count survives across short-lived hook processes.
 */

import * as fs from "node:fs";
import * as path from "node:path";

import type { Hook, HookContext, HookResult } from "../hook-types.js";
import { atomicWriteFileSync } from "../../runtime/atomic-write.js";
import { assertSafeSlug, isSafeSlug } from "../../runtime/safe-slug.js";

import { DEFAULT_BUDGET, BUDGET_ENV_VAR } from "./constants.js";

// ─── Types ────────────────────────────────────────────────────────────────────

interface CostState {
  count: number;
}

// ─── State helpers ────────────────────────────────────────────────────────────

function stateDir(cwd: string): string {
  return path.join(cwd, ".omcp", "state", "cost-governor");
}

function stateFilePath(cwd: string, sessionId: string): string {
  assertSafeSlug(sessionId, "sessionId");
  return path.join(stateDir(cwd), `${sessionId}.json`);
}

function loadState(cwd: string, sessionId: string): CostState {
  if (!isSafeSlug(sessionId)) return { count: 0 };
  try {
    const file = stateFilePath(cwd, sessionId);
    if (!fs.existsSync(file)) return { count: 0 };
    const raw = fs.readFileSync(file, "utf-8");
    const parsed = JSON.parse(raw) as unknown;
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      "count" in parsed &&
      typeof (parsed as Record<string, unknown>).count === "number"
    ) {
      return { count: (parsed as CostState).count };
    }
    return { count: 0 };
  } catch {
    return { count: 0 };
  }
}

function saveState(cwd: string, sessionId: string, state: CostState): void {
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

// ─── Budget resolution ────────────────────────────────────────────────────────

function resolveBudget(): number {
  const raw = process.env[BUDGET_ENV_VAR];
  if (raw !== undefined) {
    const parsed = parseInt(raw, 10);
    if (!isNaN(parsed) && parsed > 0) return parsed;
  }
  return DEFAULT_BUDGET;
}

// ─── Hook factory ─────────────────────────────────────────────────────────────

/**
 * Create the cost-governor Hook object.
 *
 * Subscribes to PermissionRequest.
 * Returns `{ kind: "noop" }` when under budget; `{ kind: "interrupt" }` when
 * the budget is reached or exceeded.
 */
export function createCostGovernorHook(): Hook {
  return {
    name: "cost-governor",
    events: ["PermissionRequest"],

    async run(ctx: HookContext): Promise<HookResult> {
      const { sessionId, cwd } = ctx;

      // Throws UnsafeSlugError for path-traversal attempts
      assertSafeSlug(sessionId, "sessionId");

      const budget = resolveBudget();
      const state = loadState(cwd, sessionId);
      state.count += 1;
      saveState(cwd, sessionId, state);

      if (state.count < budget) {
        return { kind: "noop" };
      }

      return {
        kind: "interrupt",
        reason:
          `Cost budget reached: ${state.count} tool calls used, ` +
          `budget is ${budget}. ` +
          `Consider starting a new session or raising ${BUDGET_ENV_VAR} if intentional.`,
      };
    },
  };
}

export { DEFAULT_BUDGET, BUDGET_ENV_VAR } from "./constants.js";
