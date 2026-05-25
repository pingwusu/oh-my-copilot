// Typed readers for the chain-handoffs/step-N.json snapshots written by
// Story 10's prepareTransition. Story 11 (US-omcp-parity-P3-CHAIN-preserve-
// P1-teamstate) pins the Phase 1 TeamState field preservation contract:
// every TeamState field that participates in the Phase 1 verify/fix loop
// (current_phase, fix_loop_count, workers[].status, stage_history,
// started_at) MUST survive a team → ralph chain handoff intact so the
// downstream ralph step can read the team's loop posture for postmortem
// and decision-making.
//
// The on-disk handoff snapshot is the JSON written by
// `prepareTransition`'s step 2. This module provides:
//   - readChainHandoff(stepN, cwd) — typed return shape
//   - getTeamHandoffPhase1Metadata(snapshot) — extracts the explicit
//     Phase 1 field subset called out in the iter-2 plan AC
//
// Both helpers are defensive: corrupt JSON / missing fields surface as
// undefined rather than throwing.

import {
  chainHandoffSnapshotPath,
  readChainHandoffSnapshot,
} from "../cli/commands/chain.js";
import type { TeamState, TeamPhase, ModeName } from "../runtime/mode-state.js";

/**
 * Full typed shape of one chain-handoffs/step-N.json snapshot. The
 * `fromState` field is typed as `unknown` because the from-mode shape
 * varies (TeamState, RalphLoopState, ...); callers should narrow via
 * the typed helpers below.
 */
export interface ChainHandoffSnapshot {
  stepN: number;
  fromMode: ModeName;
  toMode: ModeName;
  toModeIsExclusive: boolean;
  ts: string;
  fromState: unknown | null;
}

/**
 * The explicit Phase 1 TeamState field subset called out in iter-2
 * plan US-omcp-parity-P3-CHAIN-preserve-P1-teamstate. Each entry is
 * optional because:
 *   - back-compat: pre-v2.1 team states won't carry fix_loop_count
 *   - postmortem: a snapshot of a team that never finished may not
 *     have completed_phase/workers populated yet
 */
export interface TeamHandoffPhase1Metadata {
  fix_loop_count?: number;
  current_phase?: TeamPhase;
  stage_history?: TeamPhase[];
  started_at?: string;
  workers?: Array<{ id: string; status: string; agent?: string }>;
  /** Convenience flag — true iff the team transitioned to completed before handoff. */
  team_completed?: boolean;
}

/**
 * Read the typed handoff snapshot for a chain step. Returns undefined when
 * the snapshot is absent or unparseable.
 */
export function readChainHandoff(
  stepN: number,
  cwd: string,
): ChainHandoffSnapshot | undefined {
  const raw = readChainHandoffSnapshot(stepN, cwd);
  if (raw === undefined) return undefined;
  if (!isPlainObject(raw)) return undefined;
  // Validate the minimum required fields. A missing/wrong-typed key here
  // is treated the same as a corrupt snapshot.
  if (
    typeof raw.stepN !== "number" ||
    typeof raw.fromMode !== "string" ||
    typeof raw.toMode !== "string" ||
    typeof raw.toModeIsExclusive !== "boolean" ||
    typeof raw.ts !== "string"
  ) {
    return undefined;
  }
  return {
    stepN: raw.stepN,
    fromMode: raw.fromMode as ModeName,
    toMode: raw.toMode as ModeName,
    toModeIsExclusive: raw.toModeIsExclusive,
    ts: raw.ts,
    fromState: raw.fromState as unknown,
  };
}

/**
 * Extract the explicit Phase 1 TeamState metadata called out by the
 * iter-2 plan when from-mode=team. Returns undefined when:
 *   - the snapshot is not a team handoff (`fromMode !== "team"`)
 *   - `fromState` is null (team never ran) or not an object
 *
 * Each Phase 1 field is preserved verbatim from the on-disk TeamState
 * if present; missing fields surface as undefined for back-compat with
 * pre-v2.1 team states.
 */
export function getTeamHandoffPhase1Metadata(
  snapshot: ChainHandoffSnapshot,
): TeamHandoffPhase1Metadata | undefined {
  if (snapshot.fromMode !== "team") return undefined;
  if (!isPlainObject(snapshot.fromState)) return undefined;
  const ts = snapshot.fromState as Partial<TeamState>;
  const md: TeamHandoffPhase1Metadata = {};
  if (typeof ts.fix_loop_count === "number") md.fix_loop_count = ts.fix_loop_count;
  if (typeof ts.current_phase === "string")
    md.current_phase = ts.current_phase as TeamPhase;
  if (Array.isArray(ts.stage_history))
    md.stage_history = ts.stage_history as TeamPhase[];
  if (typeof ts.started_at === "string") md.started_at = ts.started_at;
  if (Array.isArray(ts.workers))
    md.workers = ts.workers.map((w) => ({
      id: String(w.id ?? ""),
      status: String(w.status ?? "pending"),
      ...(typeof w.agent === "string" ? { agent: w.agent } : {}),
    }));
  md.team_completed = ts.current_phase === "completed";
  return md;
}

/** Re-export chainHandoffSnapshotPath for callers that want the disk path. */
export { chainHandoffSnapshotPath };

function isPlainObject(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}
