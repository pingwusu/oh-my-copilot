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

import {
  existsSync as fsExistsSync,
  mkdirSync as fsMkdirSync,
  readFileSync as fsReadFileSync,
  rmSync as fsRmSync,
} from "node:fs";
import { dirname as pathDirname, join as pathJoin } from "node:path";
import { atomicWriteFileSync } from "../../runtime/atomic-write.js";
import {
  clearModeState,
  MODE_CONFIGS,
  readModeState,
  writeModeState,
  type BaseModeState,
  type ModeName,
} from "../../runtime/mode-state.js";

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

/**
 * Lifecycle status carried on the chain-state.json marker.
 *
 * The four terminal-ish values describe the chain as a whole; the dynamic
 * `handing-off-to-<mode>` value is set by Story 10's prepareTransition
 * between steps and signals that the from-mode state has been snapshotted
 * and the to-mode is about to spawn.
 */
export type ChainStatus =
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | `handing-off-to-${ModeName}`;

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

// ─── Story 10: prepareTransition — 5-step atomic state handoff ────────────────
//
// Per iter-2 plan H3 + Architect #2: a deterministic 5-step sequence runs
// between consecutive chain steps to carry from-mode state safely into the
// to-mode without leaving torn / orphaned files even under kill -9.
//
//   1. Read from-mode's state file (e.g., team-state.json).
//   2. Write snapshot to .omcp/state/chain-handoffs/<step-N>.json (atomic).
//   3. Write chain-state.json marker (atomic) with status='handing-off-to-<toMode>'.
//   4. Clear from-mode state — ASYMMETRIC: ONLY when to-mode is
//      mutuallyExclusive=true (currently ralph / autopilot / ultrawork /
//      ultraqa / ultragoal). Non-exclusive to-modes (team / ralplan / sciomc)
//      skip the clear so the from-mode state coexists with the to-mode state.
//   5. Spawn to-mode (caller-supplied via opts.spawnToMode).
//
// Crash-resume contract: at every point between steps 2 and 5 inclusive, the
// on-disk file set is sufficient for postmortem to identify what step was
// in flight (chain-state.json carries currentStep + status; the
// chain-handoffs/<step-N>.json snapshot preserves the from-mode state for
// inspection).

export interface PrepareTransitionOpts {
  fromMode: ModeName;
  toMode: ModeName;
  /** 1-based step index of the transition (matches ChainState.currentStep). */
  stepN: number;
  /** Optional pre-computed ChainState payload for chain-state.json. */
  chainStateOverlay?: Pick<
    ChainState,
    "currentStep" | "totalSteps" | "completedSteps" | "steps"
  >;
  /** Test hook: timestamp source. */
  now?: () => string;
  /**
   * Test hook: the actual spawn-to-mode action. The caller is responsible for
   * launching the next mode (e.g., runMode / runTeam). Returns the spawn's
   * exit code. The 5-step sequence runs AROUND this call so a kill -9 inside
   * the spawn does not invalidate the on-disk resume signal.
   */
  spawnToMode: (toMode: ModeName, stepN: number, cwd: string) => number;
  /** Override cwd (test hook). */
  cwd?: string;
  /**
   * Inject a sessionId for the from-mode state read. When omitted, the
   * default `resolveSessionRoot()` lookup is used by readModeState — which
   * matches the runtime behavior.
   */
  fromSessionId?: string;
}

export interface PrepareTransitionResult {
  /** 1-based step index this transition served. */
  stepN: number;
  /** Path of the chain-handoffs/<step-N>.json snapshot. */
  handoffPath: string;
  /** Whether the from-mode state file was cleared (step 4). */
  clearedFromMode: boolean;
  /** Whether to-mode is mutually-exclusive (drives step 4 asymmetry). */
  toModeIsExclusive: boolean;
  /** Exit code returned by opts.spawnToMode (step 5). */
  spawnExitCode: number;
}

/** Path to the chain-handoffs/<step-N>.json snapshot. */
export function chainHandoffSnapshotPath(stepN: number, cwd: string): string {
  return pathJoin(
    cwd,
    ".omcp",
    "state",
    "chain-handoffs",
    `step-${stepN}.json`,
  );
}

/**
 * Read the snapshot of `fromMode`'s state at the given chain step. Used by
 * Story 11's chain-handoff-reader.ts to surface Phase 1 TeamState fields
 * (fix_loop_count etc.) into a subsequent ralph step's postmortem context.
 * Returns undefined when absent or unparseable.
 */
export function readChainHandoffSnapshot(
  stepN: number,
  cwd: string,
): unknown | undefined {
  const p = chainHandoffSnapshotPath(stepN, cwd);
  if (!fsExistsSync(p)) return undefined;
  try {
    return JSON.parse(fsReadFileSync(p, "utf8")) as unknown;
  } catch {
    return undefined;
  }
}

/**
 * Execute the canonical 5-step handoff sequence. Returns the spawn's exit
 * code along with metadata describing what side-effects landed. Throws
 * only if a critical write fails (caller decides how to recover — typically
 * by leaving the chain-state.json marker in place and exiting non-zero so
 * the next `omcp status` surfaces the partial state).
 */
export function prepareTransition(
  opts: PrepareTransitionOpts,
): PrepareTransitionResult {
  const cwd = opts.cwd ?? process.cwd();
  const now = opts.now ?? (() => new Date().toISOString());
  const toModeIsExclusive = MODE_CONFIGS[opts.toMode].mutuallyExclusive;

  // Step 1 — read from-mode's on-disk state. readModeState resolves the
  // generic path (.omcp/state/<mode>-state.json or session-scoped). When
  // no state exists (e.g., the from-mode never ran), the snapshot below
  // simply records `fromState: null` so postmortem can distinguish
  // "from-mode never ran" from "from-mode ran but file went missing".
  const fromState = readGenericModeState(opts.fromMode, opts.fromSessionId);

  // Step 2 — write the chain-handoffs/<step-N>.json snapshot atomically.
  // Snapshot shape includes the chain-step metadata so a postmortem reader
  // doesn't need to cross-reference chain-state.json.
  const handoffPath = chainHandoffSnapshotPath(opts.stepN, cwd);
  fsMkdirSync(pathDirname(handoffPath), { recursive: true });
  atomicWriteFileSync(
    handoffPath,
    JSON.stringify(
      {
        stepN: opts.stepN,
        fromMode: opts.fromMode,
        toMode: opts.toMode,
        toModeIsExclusive,
        ts: now(),
        fromState,
      },
      null,
      2,
    ),
  );

  // Step 3 — update chain-state.json with status='handing-off-to-<toMode>'.
  // Uses chainStateOverlay when caller supplies it (running chain context);
  // else best-effort merges into any pre-existing marker, falling back to a
  // minimal record.
  const baseline =
    readChainState(cwd) ??
    ({
      currentStep: opts.stepN,
      totalSteps: opts.stepN,
      completedSteps: [],
      ts: now(),
      status: "running",
      steps: [],
    } satisfies ChainState);
  const overlay = opts.chainStateOverlay ?? {
    currentStep: opts.stepN,
    totalSteps: baseline.totalSteps,
    completedSteps: baseline.completedSteps,
    steps: baseline.steps,
  };
  const handoffState: ChainState = {
    currentStep: overlay.currentStep,
    totalSteps: overlay.totalSteps,
    completedSteps: overlay.completedSteps,
    ts: now(),
    status: "running",
    steps: overlay.steps,
  };
  // We persist the "handing-off-to-..." semantic in the chain-state.json
  // via a dedicated transitional status string outside the ChainStatus enum
  // — kept under the same `status` key so existing readers parse it.
  const handoffMarker = {
    ...handoffState,
    status: `handing-off-to-${opts.toMode}` as ChainStatus,
  } as ChainState;
  writeChainState(handoffMarker, cwd);

  // Step 4 — clear from-mode state ASYMMETRICALLY. Per critic S2 + iter-2
  // plan H3: the clear runs ONLY when to-mode is mutuallyExclusive=true so
  // the next exclusive mode can take over without colliding with the
  // previous mode's state file. Non-exclusive to-modes leave the from-mode
  // state in place (existing v1.3 behavior).
  let clearedFromMode = false;
  if (toModeIsExclusive) {
    try {
      clearGenericModeState(opts.fromMode, opts.fromSessionId);
      clearedFromMode = true;
    } catch {
      // best-effort — if rmSync fails the snapshot already preserves the
      // state, so postmortem is unaffected.
    }
  }

  // Step 5 — spawn the to-mode via the injected callback.
  const spawnExitCode = opts.spawnToMode(opts.toMode, opts.stepN, cwd);

  return {
    stepN: opts.stepN,
    handoffPath,
    clearedFromMode,
    toModeIsExclusive,
    spawnExitCode,
  };
}

/**
 * Wrapper around readModeState that accepts an arbitrary ModeName + optional
 * session id. Returns null when the state file is absent. readModeState is
 * generic on T extending BaseModeState; we use BaseModeState here because
 * the handoff snapshot is read-only-for-postmortem and simply preserves
 * whatever shape was on disk.
 */
function readGenericModeState(
  mode: ModeName,
  sessionId?: string,
): unknown | null {
  return readModeState<BaseModeState>(mode, sessionId);
}

function clearGenericModeState(mode: ModeName, sessionId?: string): void {
  clearModeState(mode, sessionId);
}

// ─── Story 12: cancel propagation across chain steps ──────────────────────────

/** Subset of ModeName for the "current step verb → mode-state" mapping. */
const CHAIN_STEP_VERB_TO_MODE: Readonly<Record<string, ModeName>> = {
  ralph: "ralph",
  autopilot: "autopilot",
  ultrawork: "ultrawork",
  ultraqa: "ultraqa",
  sciomc: "sciomc",
  ralplan: "ralplan",
  ultragoal: "ultragoal",
  team: "team",
};

export interface PropagateCancelToChainOpts {
  cwd?: string;
  /** Test hook: timestamp source. */
  now?: () => string;
}

export interface PropagateCancelToChainResult {
  /**
   * True when chain-state.json was present AND its status was non-terminal
   * (running / handing-off-to-*). Drives whether the propagation actually
   * fired vs short-circuiting.
   */
  chainWasActive: boolean;
  /**
   * True iff the current step's mode-state was successfully marked with
   * `cancelled: true`. Requires:
   *   - chain was active
   *   - the current step's verb maps to a known ModeName
   *   - the on-disk mode-state file exists for that mode
   * Per the ADR, ralph + team-verify check the cancelled flag at their
   * checkpoints; team-launch's workers ignore it (SIGTERM via stopTeam).
   */
  modeStateSignalled: boolean;
  /** Verb of the chain step that was in flight at cancel time. */
  currentStepVerb?: string;
  /** True iff chain-state.json was cleared as part of propagation. */
  chainStateCleared: boolean;
}

/**
 * Story 12 chain-aware cancel propagation. When chain-state.json exists and
 * is in a non-terminal status, this function:
 *   1. Reads the current step (`chainState.currentStep`).
 *   2. Maps the step's verb to a ModeName via CHAIN_STEP_VERB_TO_MODE.
 *   3. Reads the corresponding mode-state file (if any), sets
 *      `cancelled: true`, and writes it back via writeModeState (atomic).
 *   4. Clears chain-state.json so subsequent `omcp status` does not show
 *      a stale "running" chain.
 *
 * The cancel-marker file (.omcp/state/cancel.json) is written by the
 * existing runCancel helper in mode.ts — NOT by this function. The CLI
 * layer composes both: runCancel writes the marker, propagateCancelToChain
 * fans out into chain + mode states. This keeps the boundary clean and
 * preserves "one writer per file" semantics.
 *
 * Idempotent: a second call when chain-state.json has already been cleared
 * reports `chainWasActive: false` with no further side effects.
 */
export function propagateCancelToChain(
  opts: PropagateCancelToChainOpts = {},
): PropagateCancelToChainResult {
  const cwd = opts.cwd ?? process.cwd();
  const chainState = readChainState(cwd);
  const isActive =
    chainState !== undefined &&
    chainState.status !== "completed" &&
    chainState.status !== "failed" &&
    chainState.status !== "cancelled";
  if (!isActive) {
    return {
      chainWasActive: false,
      modeStateSignalled: false,
      chainStateCleared: false,
    };
  }
  const currentIdx = chainState.currentStep - 1;
  const currentStep =
    currentIdx >= 0 && currentIdx < chainState.steps.length
      ? chainState.steps[currentIdx]
      : undefined;
  const currentStepVerb = currentStep?.verb;
  let modeStateSignalled = false;
  if (currentStepVerb !== undefined) {
    const mode = CHAIN_STEP_VERB_TO_MODE[currentStepVerb];
    if (mode !== undefined) {
      try {
        const state = readModeState<BaseModeState>(mode);
        if (state !== null) {
          writeModeState<BaseModeState & { cancelled?: boolean }>(mode, {
            ...state,
            cancelled: true,
          });
          modeStateSignalled = true;
        }
      } catch {
        // best-effort — the cancel marker itself is the load-bearing
        // signal; mode-state propagation is an optimization.
      }
    }
  }
  clearChainState(cwd);
  return {
    chainWasActive: true,
    modeStateSignalled,
    currentStepVerb,
    chainStateCleared: true,
  };
}
