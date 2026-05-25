// `omcp ralplan --chain "<chain-spec>"` — Phase 3 chain orchestration.
//
// Story 8 / US-omcp-parity-P3-CHAIN-parser shipped the spec parser.
// Story 9 / US-omcp-parity-P3-CHAIN-runner (this file) adds the sequential
// step runner + the crash-resumable .omcp/state/chain-state.json marker.
// Story 10 will add the 5-step atomic state-handoff. Story 11 will pin the
// Phase 1 TeamState preservation. Story 12 will wire cancel propagation.
//
// Chain spec grammar (whitespace-tokenized, no shell-escape ambiguity since
// we pre-split on whitespace at the parser entry):
//
//   spec        := step*
//   step        := "--then" verb arg*
//   verb        := identifier
//   arg         := any-token (not "--then")
//
// Example:
//   "--then team 4 fix-typo --then ralph-verify"
//      →  [{verb:"team", args:["4","fix-typo"]}, {verb:"ralph-verify", args:[]}]
//
// Empty spec ("") → no steps → caller falls back to legacy ralplan behavior.

const THEN_MARKER = "--then";

export interface ChainStep {
  verb: string;
  args: string[];
}

export class ChainParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ChainParseError";
  }
}

/**
 * Tokenize a chain spec string into raw argv-style tokens. Currently a
 * simple whitespace split — quoted-string handling is intentionally NOT
 * implemented at this layer (the surrounding shell is expected to have
 * already done quoting; if a step needs an arg with spaces, the user
 * passes the entire chain spec as a single quoted argument and the
 * shell delivers the inner string intact).
 *
 * Exported for direct unit-testing.
 */
export function tokenizeChainSpec(spec: string): string[] {
  return spec
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
}

/**
 * Parse a tokenized chain spec into an ordered list of pipeline steps.
 *
 * Each step starts with `--then`, must be followed by at least one verb
 * token (any token that does not itself start with `--`), and may carry
 * additional positional args up to the next `--then`. An empty token
 * array yields an empty step list (legacy ralplan behavior).
 *
 * Throws ChainParseError on malformed input — e.g., a leading token that
 * is not `--then`, or a `--then` followed by another `--then` / nothing.
 *
 * Exported as the primary entry point for Story 9's runChain consumer.
 */
export function parseChainArgs(tokens: string[]): ChainStep[] {
  const steps: ChainStep[] = [];
  let i = 0;
  while (i < tokens.length) {
    const head = tokens[i];
    if (head !== THEN_MARKER) {
      throw new ChainParseError(
        `expected '${THEN_MARKER}' at position ${i}, got ${JSON.stringify(head)}`,
      );
    }
    // Step verb must be the next token, and must NOT be another --then or empty.
    const verbToken = tokens[i + 1];
    if (verbToken === undefined) {
      throw new ChainParseError(
        `'${THEN_MARKER}' at position ${i} is not followed by a verb`,
      );
    }
    if (verbToken === THEN_MARKER) {
      throw new ChainParseError(
        `'${THEN_MARKER}' at position ${i} is followed by another '${THEN_MARKER}' — missing verb`,
      );
    }
    if (verbToken.startsWith("--")) {
      throw new ChainParseError(
        `'${THEN_MARKER}' at position ${i} is followed by an option-like token ${JSON.stringify(verbToken)} — a verb is required`,
      );
    }

    const verb = verbToken;
    const args: string[] = [];
    let j = i + 2;
    while (j < tokens.length && tokens[j] !== THEN_MARKER) {
      args.push(tokens[j]);
      j++;
    }
    steps.push({ verb, args });
    i = j;
  }
  return steps;
}

/**
 * Convenience wrapper: tokenize + parse in one step. Empty / whitespace-only
 * input returns an empty step list (legacy fallback). All ChainParseError
 * propagates to the caller; CLI layer maps these to exit code 2.
 */
export function parseChainSpec(spec: string): ChainStep[] {
  return parseChainArgs(tokenizeChainSpec(spec));
}

// ─── Story 9: sequential runner + chain-state.json marker ─────────────────────

import {
  existsSync as fsExistsSync,
  mkdirSync as fsMkdirSync,
  readFileSync as fsReadFileSync,
  rmSync as fsRmSync,
} from "node:fs";
import { dirname as pathDirname, join as pathJoin } from "node:path";
import { atomicWriteFileSync } from "../../runtime/atomic-write.js";

export type ChainStatus = "running" | "completed" | "failed" | "cancelled";

export interface ChainState {
  /** 1-based index of the current step (or the failed step when failed). */
  currentStep: number;
  /** Total number of steps in the chain. */
  totalSteps: number;
  /** 1-based indices of successfully-completed steps so far. */
  completedSteps: number[];
  /** When status='failed', the 1-based index of the step that failed. */
  failedStep?: number;
  /** ISO timestamp of the last state update. */
  ts: string;
  /** Lifecycle: running → completed | failed | cancelled. */
  status: ChainStatus;
  /** Frozen snapshot of the chain's step list for postmortem reading. */
  steps: ChainStep[];
}

/**
 * Path to the chain-state.json marker (singleton per cwd). Exported for
 * the omcp status surface (N+3 polish) and for tests that inspect the
 * marker directly.
 */
export function chainStateFilePath(cwd: string): string {
  return pathJoin(cwd, ".omcp", "state", "chain-state.json");
}

/**
 * Read the chain-state.json marker. Returns undefined when absent or
 * unparseable — the marker's purpose is best-effort resume guidance,
 * not load-bearing state.
 */
export function readChainState(cwd: string): ChainState | undefined {
  const p = chainStateFilePath(cwd);
  if (!fsExistsSync(p)) return undefined;
  try {
    return JSON.parse(fsReadFileSync(p, "utf8")) as ChainState;
  } catch {
    return undefined;
  }
}

/**
 * Atomically write the chain-state.json marker. Invariant 2 honored via
 * atomicWriteFileSync so a kill -9 mid-write cannot leave torn JSON.
 */
export function writeChainState(state: ChainState, cwd: string): void {
  const p = chainStateFilePath(cwd);
  fsMkdirSync(pathDirname(p), { recursive: true });
  atomicWriteFileSync(p, JSON.stringify(state, null, 2));
}

/**
 * Remove the chain-state.json marker. Used by Story 12 cancel-propagation
 * and by the test cleanup hooks; tolerant of an already-absent file.
 */
export function clearChainState(cwd: string): void {
  const p = chainStateFilePath(cwd);
  if (fsExistsSync(p)) {
    try {
      fsRmSync(p, { force: true });
    } catch {
      // best-effort
    }
  }
}

export interface RunChainOpts {
  steps: ChainStep[];
  cwd?: string;
  /** Test hook: timestamp source for the marker's `ts` field. */
  now?: () => string;
  /**
   * Step actuator. Receives the step + its 1-based index and returns the
   * exit code (0 = success). The default implementation refuses to run —
   * Story 10 will introduce the real CLI-surface dispatch that maps each
   * verb to its corresponding runMode/runTeam/runTeamVerify call. Until
   * then, callers must inject a stepRunner explicitly so the chain is
   * never executed against unwired surfaces.
   */
  stepRunner?: (
    step: ChainStep,
    ctx: { stepIndex: number; cwd: string; totalSteps: number },
  ) => number;
}

export interface RunChainResult {
  /** max(stepExitCodes) — 0 only when every step succeeded. */
  exitCode: number;
  state: ChainState;
}

const DEFAULT_STEP_RUNNER_MESSAGE =
  "runChain: default stepRunner not yet implemented (Story 10 will wire CLI-surface dispatch). Pass opts.stepRunner explicitly to invoke a chain.";

/**
 * Execute a chain sequentially. Writes the chain-state.json marker before
 * each step (status='running'); on success advances completedSteps; on
 * failure persists status='failed' + failedStep and short-circuits. The
 * aggregate exit code is the maximum of per-step exit codes — 0 only when
 * the entire chain ran end-to-end.
 *
 * Empty step list returns exit 0 with status='completed' (legacy ralplan
 * back-compat). Caller decides whether to clear the marker after a
 * successful run.
 */
export function runChain(opts: RunChainOpts): RunChainResult {
  const cwd = opts.cwd ?? process.cwd();
  const now = opts.now ?? (() => new Date().toISOString());
  const totalSteps = opts.steps.length;

  if (totalSteps === 0) {
    const state: ChainState = {
      currentStep: 0,
      totalSteps: 0,
      completedSteps: [],
      ts: now(),
      status: "completed",
      steps: [],
    };
    return { exitCode: 0, state };
  }

  const stepRunner =
    opts.stepRunner ??
    ((_step, _ctx): number => {
      throw new Error(DEFAULT_STEP_RUNNER_MESSAGE);
    });

  const completedSteps: number[] = [];
  let aggregateExit = 0;
  const stepsFrozen: ChainStep[] = opts.steps.map((s) => ({
    verb: s.verb,
    args: [...s.args],
  }));

  for (let i = 0; i < totalSteps; i++) {
    const stepIndex = i + 1;
    writeChainState(
      {
        currentStep: stepIndex,
        totalSteps,
        completedSteps: [...completedSteps],
        ts: now(),
        status: "running",
        steps: stepsFrozen,
      },
      cwd,
    );
    const stepExit = stepRunner(stepsFrozen[i], {
      stepIndex,
      cwd,
      totalSteps,
    });
    aggregateExit = Math.max(aggregateExit, stepExit);
    if (stepExit !== 0) {
      const failedState: ChainState = {
        currentStep: stepIndex,
        totalSteps,
        completedSteps: [...completedSteps],
        failedStep: stepIndex,
        ts: now(),
        status: "failed",
        steps: stepsFrozen,
      };
      writeChainState(failedState, cwd);
      return { exitCode: aggregateExit, state: failedState };
    }
    completedSteps.push(stepIndex);
  }

  const completedState: ChainState = {
    currentStep: totalSteps,
    totalSteps,
    completedSteps,
    ts: now(),
    status: "completed",
    steps: stepsFrozen,
  };
  writeChainState(completedState, cwd);
  return { exitCode: aggregateExit, state: completedState };
}
