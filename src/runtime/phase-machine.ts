// Phase-transition state machine for autopilot and ralph→ultraqa handoff.
//
// Mirrors omc's mode-registry transition logic but adapted to omcp's
// AutopilotState / RalphLoopState / UltraQAState schemas. Pure functions:
// callers persist the returned `next` state via writeModeState() themselves.

import type {
  AutopilotState,
  BaseModeState,
  RalphLoopState,
} from "./mode-state.js";

export type AutopilotPhase = AutopilotState["phase"];

// Default ceiling for qa↔execution loopbacks. Callers may override via
// ctx.ultraqa_cycles (qa→execution) or ctx.ralph_iterations (execution→qa).
export const DEFAULT_LOOPBACK_CAP = 5;

// Legal forward transitions plus the two bounded loopbacks.
const LEGAL_AUTOPILOT_TRANSITIONS: Record<AutopilotPhase, AutopilotPhase[]> = {
  expansion: ["planning"],
  planning: ["execution"],
  execution: ["qa"],
  qa: ["execution", "validation"],
  validation: ["cleanup"],
  cleanup: [],
};

export interface TransitionResult<S> {
  ok: boolean;
  reason?: string;
  next?: S;
}

/**
 * Transition an autopilot phase. Enforces:
 * - forward edges: expansion→planning→execution→qa→validation→cleanup
 * - loopback edges: qa→execution and execution→qa (bounded by cap)
 * - rejects any other edge (including no-op self-transitions)
 *
 * On accept, returns a new AutopilotState with phase updated and the
 * appropriate iteration counter incremented when looping back.
 */
export function transitionAutopilot(
  from: AutopilotPhase,
  to: AutopilotPhase,
  ctx: AutopilotState,
  options: { loopbackCap?: number } = {},
): TransitionResult<AutopilotState> {
  if (ctx.phase !== from) {
    return {
      ok: false,
      reason: `ctx.phase mismatch: expected ${from}, got ${ctx.phase}`,
    };
  }

  const allowed = LEGAL_AUTOPILOT_TRANSITIONS[from];
  if (!allowed.includes(to)) {
    return {
      ok: false,
      reason: `illegal transition: ${from}→${to}`,
    };
  }

  const cap = options.loopbackCap ?? DEFAULT_LOOPBACK_CAP;

  // Bounded-loopback accounting.
  let ralph_iterations = ctx.ralph_iterations ?? 0;
  let ultraqa_cycles = ctx.ultraqa_cycles ?? 0;

  if (from === "execution" && to === "qa") {
    ralph_iterations += 1;
    if (ralph_iterations > cap) {
      return {
        ok: false,
        reason: `execution→qa loopback exceeded cap (${cap})`,
      };
    }
  }

  if (from === "qa" && to === "execution") {
    ultraqa_cycles += 1;
    if (ultraqa_cycles > cap) {
      return {
        ok: false,
        reason: `qa→execution loopback exceeded cap (${cap})`,
      };
    }
  }

  const next: AutopilotState = {
    ...ctx,
    phase: to,
    iteration: ctx.iteration + 1,
    ralph_iterations,
    ultraqa_cycles,
  };

  return { ok: true, next };
}

// UltraQA state schema, kept here so mode-state.ts doesn't need to depend on
// the phase machine. Mirrors RalphLoopState shape — UltraQA is the QA-cycling
// half of the ralph handoff.
export interface UltraQAState extends BaseModeState {
  cycle: number;
  max_cycles: number;
  source_mode?: "ralph" | "autopilot";
  source_session_id?: string;
}

/**
 * Hand off from a ralph loop to an ultraqa cycle.
 *
 * Legal only when the ralph state is active. Carries the session id forward
 * via `source_session_id` so the UltraQA cycle can reference its origin.
 * The returned state has `cycle` initialized to 1 (first QA cycle).
 */
export function transitionRalphToUltraQA(
  from: RalphLoopState,
  to: Partial<UltraQAState> & { max_cycles?: number },
): TransitionResult<UltraQAState> {
  if (!from.active) {
    return { ok: false, reason: "source ralph state is not active" };
  }

  if (from.iteration <= 0) {
    return {
      ok: false,
      reason: "ralph has not run any iterations yet (iteration <= 0)",
    };
  }

  const max_cycles = to.max_cycles ?? DEFAULT_LOOPBACK_CAP;
  if (max_cycles <= 0) {
    return { ok: false, reason: "max_cycles must be > 0" };
  }

  const next: UltraQAState = {
    active: true,
    session_id: to.session_id ?? from.session_id,
    started_at: to.started_at ?? new Date().toISOString(),
    prompt: to.prompt ?? from.prompt,
    cycle: 1,
    max_cycles,
    source_mode: "ralph",
    source_session_id: from.session_id,
  };

  return { ok: true, next };
}
