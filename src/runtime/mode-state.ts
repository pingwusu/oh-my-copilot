// Typed mode state — mirrors omc's mode-registry pattern.
//
// Tracks "active mode" (ralph, autopilot, ultrawork, ultraqa, team, sciomc)
// across context compactions by persisting JSON state under .omcp/state/.
//
// Each mode has its own state schema. The MODE_CONFIGS map enforces mutual
// exclusion: only one mutually-exclusive mode may be active at a time.

import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";
import { atomicWriteFileSync } from "./atomic-write.js";
import { assertSafeSlug } from "./safe-slug.js";

export type ModeName =
  | "ralph"
  | "autopilot"
  | "ultrawork"
  | "ultraqa"
  | "team"
  | "sciomc"
  | "ralplan"
  | "ultragoal";

export interface BaseModeState {
  active: boolean;
  session_id: string;
  started_at: string;
  prompt?: string;
}

export interface RalphLoopState extends BaseModeState {
  iteration: number;
  max_iterations: number;
}

export interface AutopilotState extends BaseModeState {
  phase:
    | "expansion"
    | "planning"
    | "execution"
    | "qa"
    | "validation"
    | "cleanup";
  iteration: number;
  ralph_iterations?: number;
  ultraqa_cycles?: number;
}

/** omc-aligned phase enum — mirrors omc src/team/phase-controller.ts:3-9. */
export type TeamPhase =
  | "initializing"
  | "planning"
  | "executing"
  | "fixing"
  | "completed"
  | "failed";

export interface TeamState extends BaseModeState {
  spawned: number;
  done: number;
  workers: Array<{ id: string; agent?: string; status: string }>;
  /** Current lifecycle phase of this team session. Optional for back-compat. */
  current_phase?: TeamPhase;
  /** Ordered list of phases this session has passed through. Optional for back-compat. */
  stage_history?: TeamPhase[];
}

export interface ModeConfig {
  mutuallyExclusive: boolean;
}

export const MODE_CONFIGS: Record<ModeName, ModeConfig> = {
  ralph: { mutuallyExclusive: true },
  autopilot: { mutuallyExclusive: true },
  ultrawork: { mutuallyExclusive: true },
  ultraqa: { mutuallyExclusive: true },
  team: { mutuallyExclusive: false },
  sciomc: { mutuallyExclusive: false },
  ralplan: { mutuallyExclusive: false },
  ultragoal: { mutuallyExclusive: true },
};

export function resolveSessionRoot(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const sid = env.COPILOT_SESSION_ID ?? env.OMCP_SESSION_ID;
  if (typeof sid === "string" && sid.length > 0) return sid;
  return "default";
}

function stateRoot(sessionId?: string): string {
  if (sessionId === "") {
    return join(process.cwd(), ".omcp", "state");
  }
  const sid = sessionId ?? resolveSessionRoot();
  if (sid === "default") {
    return join(process.cwd(), ".omcp", "state");
  }
  return join(process.cwd(), ".omcp", "state", "sessions", sid);
}

function modeFile(mode: ModeName, sessionId?: string): string {
  // DD4 Lane B fix: ModeName is a typed enum and sessionId is validated via
  // resolveSessionRoot, but defense-in-depth — refuse any callers that
  // bypass typing.
  assertSafeSlug(mode, "mode");
  if (sessionId !== undefined && sessionId !== "") {
    assertSafeSlug(sessionId, "sessionId");
  }
  return join(stateRoot(sessionId), `${mode}-state.json`);
}

export function readModeState<T extends BaseModeState>(
  mode: ModeName,
  sessionId?: string,
): T | null {
  const f = modeFile(mode, sessionId);
  if (!existsSync(f)) return null;
  try {
    return JSON.parse(readFileSync(f, "utf8")) as T;
  } catch {
    return null;
  }
}

export function writeModeState<T extends BaseModeState>(
  mode: ModeName,
  state: T,
  sessionId?: string,
): void {
  const f = modeFile(mode, sessionId);
  mkdirSync(stateRoot(sessionId), { recursive: true });
  atomicWriteFileSync(f, JSON.stringify(state, null, 2));
}

export function clearModeState(mode: ModeName, sessionId?: string): void {
  const f = modeFile(mode, sessionId);
  if (existsSync(f)) rmSync(f);
}

export function listActiveModes(sessionId?: string): ModeName[] {
  const root = stateRoot(sessionId);
  if (!existsSync(root)) return [];
  const out: ModeName[] = [];
  for (const mode of Object.keys(MODE_CONFIGS) as ModeName[]) {
    const s = readModeState<BaseModeState>(mode, sessionId);
    if (s?.active) out.push(mode);
  }
  return out;
}

/**
 * Default stale threshold: 60 minutes in milliseconds.
 *
 * Override via `OMCP_MODE_STATE_STALE_MS` env var (any positive integer).
 * Re-read on every call so tests can override without module-level caching.
 */
function staleMsThreshold(): number {
  const raw = process.env["OMCP_MODE_STATE_STALE_MS"];
  if (raw !== undefined) {
    const parsed = Number(raw);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return 3_600_000; // 60 minutes
}

/**
 * Return true when the mode-state file's `started_at` timestamp is older
 * than the configured stale threshold.
 *
 * A missing or unparseable `started_at` is treated as NOT stale (safe
 * default — prefer the user runs `omcp cancel` explicitly).
 */
export function isModeStateStale(state: BaseModeState): boolean {
  if (!state.started_at) return false;
  const started = Date.parse(state.started_at);
  if (!Number.isFinite(started)) return false;
  return Date.now() - started > staleMsThreshold();
}

export function canStartMode(
  target: ModeName,
  sessionId?: string,
): {
  ok: boolean;
  conflict?: ModeName;
  stale?: boolean;
} {
  if (!MODE_CONFIGS[target].mutuallyExclusive) return { ok: true };
  const activeModes = listActiveModes(sessionId);
  const conflicting = activeModes.find(
    (m) => MODE_CONFIGS[m].mutuallyExclusive && m !== target,
  );
  if (!conflicting) return { ok: true };

  // Check if the conflicting mode-state is stale (older than threshold).
  const conflictState = readModeState<BaseModeState>(conflicting, sessionId);
  const stale = conflictState ? isModeStateStale(conflictState) : false;

  return { ok: false, conflict: conflicting, stale };
}

// ─── valid phase transitions ──────────────────────────────────────────────────

/**
 * Allowed phase transitions for the TeamPhase state machine.
 *
 * 'fixing' is reserved per the phase enum (mirrored from omc) but has no
 * incoming transitions in v1.2.0 — a worker reassignment path would add one.
 * TODO: add 'executing' → 'fixing' transition when worker-reassignment lands (post-L2.6)
 */
const VALID_TEAM_TRANSITIONS: ReadonlyMap<TeamPhase, ReadonlySet<TeamPhase>> =
  new Map([
    ["initializing", new Set<TeamPhase>(["planning", "executing", "failed"])],
    ["planning", new Set<TeamPhase>(["executing", "failed"])],
    ["executing", new Set<TeamPhase>(["completed", "failed"])],
    // 'fixing' has no incoming edges in v1.2.0 — reserved for reassignment UX
    ["fixing", new Set<TeamPhase>(["completed", "failed"])],
    ["completed", new Set<TeamPhase>()],
    ["failed", new Set<TeamPhase>()],
  ]);

export class InvalidPhaseTransitionError extends Error {
  constructor(from: TeamPhase, to: TeamPhase) {
    super(
      `invalid TeamPhase transition: '${from}' → '${to}' is not allowed`,
    );
    this.name = "InvalidPhaseTransitionError";
  }
}

export interface PhaseTransitionRecord {
  from: TeamPhase;
  to: TeamPhase;
  at: string;
  reason?: string;
}

/**
 * Atomically transition a TeamState's current_phase and append a record to
 * stage_history.  Reads the existing state from disk, validates the transition,
 * writes back via atomicWriteFileSync, and returns the updated state.
 *
 * Throws {@link InvalidPhaseTransitionError} if the transition is not in the
 * allowed set.  Throws if no TeamState exists for the given sessionId.
 */
export function transitionPhase(
  sessionId: string,
  to: TeamPhase,
  /** Optional annotation stored for observability; currently logged but not persisted to stage_history (which is TeamPhase[]). */
  _reason?: string,
): TeamState {
  const state = readModeState<TeamState>("team", sessionId);
  if (state === null) {
    throw new Error(
      `transitionPhase: no TeamState found for session '${sessionId}'`,
    );
  }

  // Default to 'executing' for back-compat: v1.0.0 states without current_phase
  // were always in the executing phase (L2.5a always wrote 'executing' before
  // the transitionPhase helper existed).
  const from: TeamPhase = state.current_phase ?? "executing";
  const allowed = VALID_TEAM_TRANSITIONS.get(from);
  if (!allowed || !allowed.has(to)) {
    throw new InvalidPhaseTransitionError(from, to);
  }

  // Ensure the history chain includes the current 'from' phase if not already
  // present (back-compat with states written before transitionPhase existed).
  const existingHistory = state.stage_history ?? [];
  const baseHistory =
    existingHistory.length > 0 ? existingHistory : [from];

  const updated: TeamState = {
    ...state,
    current_phase: to,
    stage_history: [...baseHistory, to],
  };

  writeModeState<TeamState>("team", updated, sessionId);
  return updated;
}

export function isCancelled(sessionId?: string): boolean {
  return existsSync(join(stateRoot(sessionId), "cancel.json"));
}

export function clearCancel(sessionId?: string): void {
  const f = join(stateRoot(sessionId), "cancel.json");
  if (existsSync(f)) rmSync(f);
}
