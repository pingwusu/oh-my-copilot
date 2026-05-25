// `omcp team-wait <session-id> [--timeout <secs>]` — Story 13.
//
// Polls TeamState.current_phase every 2 seconds. Returns:
//   0 — phase=completed
//   1 — phase=failed
//   2 — wall-clock timeout fired before terminal phase
//   3 — session not found (no team-state.json)
//
// Polling-based; explicitly NOT heartbeat-based (no Phase 2 IPC
// dependency per iter-2 plan US-omcp-parity-P3-TEAM-WAIT-cli "Polling,
// not heartbeat" note). When `omcp cancel` runs mid-poll, future
// expansions could short-circuit on state.cancelled=true — for now
// team-wait simply observes the on-disk TeamState the team modes write.

import {
  readModeState,
  type TeamState,
  type TeamPhase,
} from "../../runtime/mode-state.js";
import {
  assertSafeSlug,
  UnsafeSlugError,
} from "../../runtime/safe-slug.js";

export type TeamWaitExitCode = 0 | 1 | 2 | 3;

export const TEAM_WAIT_POLL_INTERVAL_MS = 2_000;
export const TEAM_WAIT_DEFAULT_TIMEOUT_MS = 1_800_000;

export interface TeamWaitOpts {
  sessionId: string;
  /** Override the timeout in ms (env OMCP_TEAM_WAIT_TIMEOUT_S takes precedence). */
  timeoutMs?: number;
  /** Override the working directory (test hook). */
  cwd?: string;
  /** Test hook: pollable time source. Returns current ms. */
  now?: () => number;
  /** Test hook: replaces the inter-poll sleep. */
  sleep?: (ms: number) => void;
  /**
   * Test hook: replaces the TeamState reader. Default delegates to
   * readModeState which respects process.cwd(). Used by tests so the
   * harness can pace state transitions without writing real files.
   */
  readTeamState?: (sessionId: string) => TeamState | null;
  /** Test hook: redirect summary lines away from console. */
  log?: (line: string) => void;
  /** Test hook: redirect error lines away from console.error. */
  errLog?: (line: string) => void;
}

/**
 * Resolve the timeout in ms with the documented precedence:
 *   env OMCP_TEAM_WAIT_TIMEOUT_S (positive integer seconds) >
 *   opts.timeoutMs (positive integer ms) >
 *   TEAM_WAIT_DEFAULT_TIMEOUT_MS (1800000)
 *
 * Exported for unit testing the precedence chain independent of runTeamWait.
 */
export function resolveTeamWaitTimeoutMs(
  argMs?: number,
  env: NodeJS.ProcessEnv = process.env,
): number {
  const fromEnv = env.OMCP_TEAM_WAIT_TIMEOUT_S;
  if (fromEnv !== undefined && fromEnv !== "") {
    const n = Number(fromEnv);
    if (Number.isFinite(n) && n > 0) return Math.floor(n * 1000);
  }
  if (argMs !== undefined && Number.isFinite(argMs) && argMs > 0) return argMs;
  return TEAM_WAIT_DEFAULT_TIMEOUT_MS;
}

function isTerminalPhase(phase: TeamPhase | undefined): boolean {
  return phase === "completed" || phase === "failed";
}

function phaseToExitCode(phase: TeamPhase | undefined): TeamWaitExitCode {
  if (phase === "completed") return 0;
  if (phase === "failed") return 1;
  // Other phases (initializing/planning/executing/fixing) shouldn't reach
  // this mapper — the caller loops until isTerminalPhase or timeout.
  return 2;
}

/**
 * Block until the named team session reaches a terminal phase or the timeout
 * fires. Returns the appropriate exit code per AC. Never throws — invalid
 * session ids surface as exit 3 (treated as "session not found").
 */
export function runTeamWait(opts: TeamWaitOpts): TeamWaitExitCode {
  const log = opts.log ?? ((l: string) => console.log(l));
  const errLog = opts.errLog ?? ((l: string) => console.error(l));
  try {
    assertSafeSlug(opts.sessionId, "session-id");
  } catch (err) {
    if (err instanceof UnsafeSlugError) {
      errLog(`omcp team-wait: ${err.message}`);
    } else {
      errLog(`omcp team-wait: invalid session-id`);
    }
    return 3;
  }

  const now = opts.now ?? (() => Date.now());
  const sleep = opts.sleep ?? defaultSleep;
  const readState =
    opts.readTeamState ??
    ((sid: string) => readModeState<TeamState>("team", sid));

  const timeoutMs = resolveTeamWaitTimeoutMs(opts.timeoutMs);
  const deadline = now() + timeoutMs;

  // First poll — fast-path session-not-found.
  let state = readState(opts.sessionId);
  if (state === null) {
    errLog(`omcp team-wait: session '${opts.sessionId}' not found`);
    return 3;
  }
  let phase = state.current_phase;

  // Initial summary so the user sees the wait starting.
  log(`omcp team-wait: session=${opts.sessionId}`);
  log(`  initial phase: ${phase ?? "(unset)"}`);
  log(`  timeout:       ${timeoutMs}ms`);

  while (!isTerminalPhase(phase)) {
    if (now() >= deadline) {
      errLog(
        `omcp team-wait: timed out after ${timeoutMs}ms (last phase: ${phase ?? "(unset)"})`,
      );
      return 2;
    }
    sleep(TEAM_WAIT_POLL_INTERVAL_MS);
    state = readState(opts.sessionId);
    if (state === null) {
      // The session disappeared mid-wait — treat as not-found.
      errLog(`omcp team-wait: session '${opts.sessionId}' disappeared during wait`);
      return 3;
    }
    phase = state.current_phase;
  }

  const code = phaseToExitCode(phase);
  log(`  final phase:   ${phase}`);
  log(`  exit code:     ${code}`);
  return code;
}

function defaultSleep(ms: number): void {
  // Synchronous busy-wait matches the existing busy-wait pattern in
  // src/cli/commands/team.ts shutdownTeam. team-wait runs as a stand-
  // alone CLI invocation that blocks the user's shell; a synchronous
  // sleep is acceptable here and preserves single-process semantics.
  const until = Date.now() + ms;
  while (Date.now() < until) {
    // intentional busy-wait
  }
}
