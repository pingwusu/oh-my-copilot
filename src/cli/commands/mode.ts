// `omcp <mode> "<task>"` — thin CLI wrapper that delegates to Copilot's
// non-interactive prompt mode (`copilot -p`) with the named skill activated.
//
// Maps to: copilot -p "/oh-my-copilot:<mode> <task>" --allow-all-tools [--autopilot]
//
// Modes that imply long-running loops (ralph, autopilot, ultrawork, ultraqa,
// sciomc) get `--autopilot` automatically so Copilot keeps continuing until
// the skill emits a completion signal or the user cancels.

import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { atomicWriteFileSync } from "../../runtime/atomic-write.js";
import { spawnSyncCrossPlatform } from "../../runtime/resolve-executable.js";
import { join } from "node:path";
import { loadConfig } from "../../notifications/config-loader.js";
import { dispatch } from "../../notifications/dispatcher.js";
import type { NotifyContext } from "../../notifications/types.js";
import {
  loadAgentCatalog,
  resolveAgentModel,
} from "../../runtime/agent-models.js";
import type { ModelFamily } from "../../runtime/model-routing.js";
import {
  type ModeName,
  MODE_CONFIGS,
  canStartMode,
  clearModeState,
  readModeState,
  writeModeState,
  isModeStateStale,
} from "../../runtime/mode-state.js";
import {
  writeRalphState,
  clearRalphState,
  getPrdCompletionStatus,
  readRalphState,
} from "../../lib/ralph-state.js";
import { readBoulderState } from "../../lib/boulder-state.js";
import { registerRalplan } from "../../ralplan/index.js";

export interface ModeOptions {
  mode: string;
  task: string;
  family?: ModelFamily | "auto";
  agent?: string;
  agentsDir?: string;
  allowAllTools?: boolean;
  silent?: boolean;
  interactive?: boolean;
  maxContinues?: number;
  prdPath?: string;
  /**
   * When true (opt-in), after ralplan's copilot exits cleanly (status 0),
   * read boulder state to get the plan file path written by the skill,
   * read the plan content, and pass handOffToRalph=true to registerRalplan.
   * Mirrors omc's --interactive flag pattern. Default: false.
   */
  handoff?: boolean;
  /**
   * When true, auto-clear stale mode-state (older than OMCP_MODE_STATE_STALE_MS,
   * default 60 min) and ralph-state before proceeding with a fresh run.
   * Fails loudly if NO stale state is found — prevents silently resetting
   * a genuinely active session. Default: false.
   */
  resume?: boolean;
  /**
   * v1.6: max iterations for ralph's outer while-loop in mode.ts. Each
   * iteration re-spawns copilot once and re-reads PRD post-spawn. Caps
   * the total spawn count, independent of Copilot's internal
   * --max-autopilot-continues (which still applies per-spawn).
   *
   * Default: 20 (generous for typical 10-story PRDs).
   * Only applies when opts.mode === "ralph".
   */
  maxOuterIterations?: number;
  /**
   * v1.7: stall detection in ralph outer-loop. If `(postRunPrd.status?.completed ?? 0)`
   * count is unchanged for N consecutive iterations, bail out early
   * (preserving state for resume). Prevents wasting `maxOuterIterations`
   * spawns when Copilot is stuck (rate-limited, auth-failed, hallucinating).
   *
   * Default: 2 (bail after 2 consecutive zero-progress iterations).
   * Clamped to >= 1 to keep loop progressing.
   * Only applies when opts.mode === "ralph".
   */
  stallBailAfter?: number;
}

// Modes that should run as a continuous loop (Copilot --autopilot keeps going
// past the first response without re-prompting the user).
const LOOPING_MODES = new Set([
  "ralph",
  "autopilot",
  "ultrawork",
  "ultraqa",
  "sciomc",
  "team",
]);

// Modes that are interactive by default (one-shot questions / single advice).
const ONE_SHOT_MODES = new Set([
  "ask",
  "ccg",
  "plan",
  "ralplan",
  "deep-interview",
  "deep-dive",
  "external-context",
  "note",
  "learner",
  "cancel",
  "hud",
  "visual-verdict",
]);

export function runMode(opts: ModeOptions): number {
  if (process.env.OMCP_DISABLE === "1" || process.env.DISABLE_OMCP === "1") {
    console.error("omcp: disabled via DISABLE_OMCP / OMCP_DISABLE env var");
    return 0;
  }

  // Ralph-specific: read prior state BEFORE writeModeState overwrites the
  // shared .omcp/state/ralph-state.json file. We need architectApproved from
  // any previous iteration to carry it forward into the fresh state write
  // below, and to inform the post-exit conditional clear decision.
  const priorRalphState =
    opts.mode === "ralph" ? readRalphState() : null;

  // Mode-state tracking + mutual-exclusion check for known modes.
  const isTrackedMode = opts.mode in MODE_CONFIGS;
  const sessionId = randomUUID();
  if (isTrackedMode) {
    const target = opts.mode as ModeName;

    // --resume: handle self-resume (ralph resuming its own stale state).
    // canStartMode does not block a mode from starting when its OWN prior
    // state exists (m !== target exclusion). We handle that here before the
    // mutual-exclusion check.
    //
    // selfResumeHandled=true means the own-state was found and processed
    // (either cleared-stale or rejected-live). We skip the "no state found"
    // guard below when this is true.
    let selfResumeHandled = false;
    if (opts.resume && MODE_CONFIGS[target].mutuallyExclusive) {
      const ownState = readModeState(target);
      if (ownState?.active) {
        selfResumeHandled = true;
        if (isModeStateStale(ownState)) {
          clearModeState(target);
          if (target === "ralph") clearRalphState();
          console.error(
            `omcp: cleared stale ${target} state (>OMCP_MODE_STATE_STALE_MS). Starting fresh run.`,
          );
        } else {
          // Own state is active and NOT stale — fail loud.
          console.error(
            `omcp: --resume rejected — ${target} is actively running (not stale). Run 'omcp cancel' to stop it first.`,
          );
          return 2;
        }
      }
    }

    const check = canStartMode(target);
    if (!check.ok) {
      if (check.stale && opts.resume) {
        // Stale conflict from a DIFFERENT mutually-exclusive mode + --resume.
        clearModeState(check.conflict as ModeName);
        if (check.conflict === "ralph") clearRalphState();
        console.error(
          `omcp: cleared stale ${check.conflict} state (>OMCP_MODE_STATE_STALE_MS). Starting fresh ${target} run.`,
        );
      } else if (check.stale && !opts.resume) {
        // Stale conflict but no --resume: inform user about the --resume option.
        console.error(
          `omcp: cannot start ${target} — ${check.conflict} state is stale (started >60min ago). Run with --resume to auto-clear, or run 'omcp cancel' first.`,
        );
        return 2;
      } else if (!check.stale && opts.resume) {
        // --resume with a LIVE (non-stale) conflict — fail loud.
        console.error(
          `omcp: --resume rejected — ${check.conflict} is actively running (not stale). Run 'omcp cancel' to stop it first.`,
        );
        return 2;
      } else {
        // Normal conflict — no stale, no resume.
        console.error(
          `omcp: cannot start ${target} while ${check.conflict} is active. Run 'omcp cancel' first or wait.`,
        );
        return 2;
      }
    } else if (opts.resume && check.ok && !selfResumeHandled) {
      // --resume but neither own state nor a conflicting state was found.
      // There is truly nothing to resume from — fail loud.
      console.error(
        `omcp: --resume rejected — no active ${target} state found to resume from. Start a fresh run without --resume.`,
      );
      return 2;
    }
    writeModeState(target, {
      active: true,
      session_id: sessionId,
      started_at: new Date().toISOString(),
      prompt: opts.task,
    });
  }

  // Ralph-specific: write ralph-state before spawning so the persistent-mode
  // hook and skills can read iteration/prdPath on every Stop event.
  // Carry forward architectApproved from any prior state so the conditional
  // clear logic (post-exit) can detect it even after a fresh write.
  if (opts.mode === "ralph") {
    writeRalphState({
      active: true,
      iteration: 1,
      lastFiredAt: new Date().toISOString(),
      prompt: opts.task,
      ...(opts.prdPath ? { prdPath: opts.prdPath } : {}),
      ...(priorRalphState?.architectApproved
        ? { architectApproved: true }
        : {}),
    });
  }

  // Notifications: session-start. Errors swallowed; never block the run.
  void fireNotification("session-start", {
    sessionId,
    projectPath: process.cwd(),
    projectName: process.cwd().split(/[\\/]/).pop() ?? "",
    timestamp: new Date().toISOString(),
    event: "session-start",
    mode: opts.mode,
  });

  const slash = `/oh-my-copilot:${opts.mode}`;
  const prompt = opts.task ? `${slash} ${opts.task}` : slash;

  // Resolve model: agent-specific (if --agent) or family default.
  let model: string | undefined;
  if (opts.agent) {
    const agentsDir = opts.agentsDir ?? join(process.cwd(), "agents");
    const catalog = loadAgentCatalog(agentsDir);
    const resolved = resolveAgentModel({
      agent: opts.agent,
      override: opts.family,
      env: process.env,
      catalog,
    });
    model = resolved.model;
  }

  const args: string[] = [];
  if (opts.interactive) {
    args.push("-i", prompt);
  } else {
    args.push("-p", prompt);
  }
  if (model) args.push("--model", model);
  if (opts.agent) args.push("--agent", opts.agent);
  if (opts.allowAllTools !== false) args.push("--allow-all-tools");
  if (opts.silent) args.push("-s");
  if (LOOPING_MODES.has(opts.mode)) {
    // Canonical Copilot non-interactive invocation per official docs:
    //   copilot --autopilot --yolo --max-autopilot-continues N -p "..."
    // --yolo is a permission-bundle shortcut (--allow-all-tools
    // --allow-all-paths --allow-all-urls). Has no effect on hook dispatch
    // (verified via app.js scan + permissions help text). Required to
    // suppress mid-loop permission prompts that would otherwise stall the
    // loop on novel tools / paths. See
    // docs/upstream-reports/copilot-yolo-flag-investigation.md.
    args.push("--autopilot", "--yolo");
    if (opts.maxContinues !== undefined) {
      args.push("--max-autopilot-continues", String(opts.maxContinues));
    }
  }

  if (ONE_SHOT_MODES.has(opts.mode) && opts.maxContinues === undefined) {
    // One-shot modes don't get --autopilot.
  }

  // Ralph-specific: capture a pre-spawn snapshot for crash-recovery on
  // non-zero exit only. The outer loop below (ralph branch) re-reads
  // PRD status post-spawn for clean-exit decisions (Fix A, v1.4 RCA).
  const preSpawnRalphSnapshot =
    opts.mode === "ralph" ? readRalphState() : null;

  // v1.6: ralph uses an OUTER while-loop here in mode.ts to advance
  // iteration counter + drive multiple copilot spawns. This replaces
  // the previous single-spawn + Stop-hook-based iteration advance,
  // which was blocked by the upstream Copilot Windows pwsh dispatch
  // bug (see docs/upstream-reports/copilot-pwsh-dispatch-v1.5-
  // investigation.md — Stop hooks never execute on Windows 1.0.53-2).
  //
  // The hook-side code path is preserved for the day upstream fixes
  // the bug; outerLoopOwned=true on each iteration's ralph-state
  // tells checkRalph in persistent-mode/index.ts to defer (return
  // noop) instead of double-incrementing.
  //
  // Non-ralph modes (autopilot, ultrawork, ultraqa, sciomc, team,
  // ralplan, and all one-shot modes) keep the single-spawn behavior
  // — they don't have a PRD-driven completion criterion the outer
  // loop could check.
  let result: ReturnType<typeof spawnSyncCrossPlatform>;

  if (opts.mode === "ralph") {
    // v1.6 input validation: maxOuterIterations <= 0 would either skip the
    // loop body entirely (silent zero-work) or invert termination logic.
    // Clamp to at least 1 so the user always gets a single spawn at minimum
    // even if they pass --max-iterations 0 by mistake.
    const rawMaxOuter = opts.maxOuterIterations ?? 20;
    const maxOuter = Math.max(1, rawMaxOuter);
    // v1.7 M1 stall detection: bail when PRD completed-count is
    // unchanged for N consecutive iterations.
    const rawStallBail = opts.stallBailAfter ?? 2;
    const stallBailAfter = Math.max(1, rawStallBail);
    let prevCompleted = -1; // sentinel: no prior iteration yet
    let stallCount = 0;
    let iteration = 1;
    // Initialize result with a placeholder; the loop must always run at
    // least once and assign it. TypeScript can't see through the loop
    // invariant, so we seed it.
    result = {
      status: 0,
      pid: 0,
      signal: null,
      output: [],
      stdout: "",
      stderr: "",
    } as ReturnType<typeof spawnSyncCrossPlatform>;

    while (iteration <= maxOuter) {
      // Stamp ralph state with current iteration. outerLoopOwned=true
      // is the dedup flag: if upstream pwsh ever fixes the dispatch
      // bug and Stop hooks fire again, checkRalph sees this flag and
      // returns noop instead of also incrementing.
      writeRalphState({
        active: true,
        iteration,
        lastFiredAt: new Date().toISOString(),
        prompt: opts.task,
        prdPath: opts.prdPath,
        architectApproved: preSpawnRalphSnapshot?.architectApproved,
        outerLoopOwned: true,
      });

      result = spawnSyncCrossPlatform("copilot", args, {
        stdio: "inherit",
        shell: false,
      });

      const exitCode = result.status ?? 1;
      if (exitCode !== 0) {
        // Non-zero exit (crash/SIGINT/OOM): restore pre-spawn snapshot
        // (without outerLoopOwned flag, since the outer loop is exiting).
        if (isTrackedMode) {
          clearModeState(opts.mode as ModeName);
        }
        if (preSpawnRalphSnapshot) {
          writeRalphState({
            ...preSpawnRalphSnapshot,
            outerLoopOwned: false,
          });
        }
        break;
      }

      // Clean exit: re-read POST-spawn PRD status to see work Copilot
      // completed during the spawn (the v1.4 Fix A semantics).
      const postRunPrd = getPrdCompletionStatus();
      if (postRunPrd.allComplete) {
        // Done: clear mode-state + ralph-state for clean termination.
        if (isTrackedMode) {
          clearModeState(opts.mode as ModeName);
        }
        break;
      }
      if (preSpawnRalphSnapshot?.architectApproved === true) {
        // Architect approved in a prior iteration: same termination as
        // PRD-complete.
        if (isTrackedMode) {
          clearModeState(opts.mode as ModeName);
        }
        break;
      }

      // v1.7 M1 stall detection: if PRD `completed` count did NOT advance
      // since the previous iteration, increment stallCount. After
      // `stallBailAfter` consecutive stalls, bail out (preserving state
      // for resume). Prevents burning all `maxOuter` spawns when Copilot
      // is stuck.
      if (prevCompleted !== -1 && (postRunPrd.status?.completed ?? 0) === prevCompleted) {
        stallCount++;
        if (stallCount >= stallBailAfter) {
          if (isTrackedMode) {
            clearModeState(opts.mode as ModeName);
          }
          // Preserve state for resume — same shape as max-exhaustion path.
          writeRalphState({
            active: true,
            iteration,
            lastFiredAt: new Date().toISOString(),
            prompt: opts.task,
            prdPath: opts.prdPath,
            architectApproved: preSpawnRalphSnapshot?.architectApproved,
            outerLoopOwned: false,
          });
          break;
        }
      } else {
        stallCount = 0;
      }
      prevCompleted = (postRunPrd.status?.completed ?? 0);

      // PRD not complete + no architect approval + not stalled: advance
      // iteration and re-spawn. The next iteration's writeRalphState above
      // stamps the new iteration value, and Copilot picks up the same task.
      //
      // v1.6 architect finding M3: clearModeState was moved OUT of the
      // per-iteration body — running it each iteration deleted the mutual-
      // exclusion lock file between spawns, allowing concurrent modes to
      // start during the gap. Now clearModeState runs ONLY on termination
      // (allComplete / approved / non-zero exit / stall / max-exhaustion),
      // not between iterations.
      iteration++;
    }

    // If loop exhausted maxOuter without completing, preserve state for
    // resume so the user can `omcp ralph --resume` later. Clear mode-state
    // since the run is over.
    if (iteration > maxOuter) {
      if (isTrackedMode) {
        clearModeState(opts.mode as ModeName);
      }
      // Preserve ralph-state at maxOuter so --resume can pick up.
      writeRalphState({
        active: true,
        iteration: maxOuter,
        lastFiredAt: new Date().toISOString(),
        prompt: opts.task,
        prdPath: opts.prdPath,
        architectApproved: preSpawnRalphSnapshot?.architectApproved,
        outerLoopOwned: false,
      });
    }
  } else {
    // Non-ralph modes: single spawn (pre-v1.6 behavior).
    result = spawnSyncCrossPlatform("copilot", args, {
      stdio: "inherit",
      shell: false,
    });
    if (isTrackedMode) {
      clearModeState(opts.mode as ModeName);
    }
  }

  // Ralplan-specific: register boulder state after the skill completes so the
  // omc-orchestrator hook and ralph can pick up the active plan.
  //
  // When --handoff is set AND copilot exited cleanly (status 0), attempt to
  // read the boulder state that the ralplan skill is expected to have written
  // before exiting. If boulder state is present and activePlan points to a
  // readable file, pass its content and handOffToRalph=true to registerRalplan.
  //
  // Race note: the skill must write boulder state BEFORE copilot exits. If it
  // does not, readBoulderState returns null and we fall back to
  // handOffToRalph=false silently (no crash, no partial state).
  if (opts.mode === "ralplan") {
    const exitedClean = (result.status ?? 1) === 0;
    let planContent = "";
    let handOffToRalph = false;

    if (opts.handoff && exitedClean) {
      const boulder = readBoulderState(process.cwd());
      if (boulder?.activePlan) {
        try {
          planContent = readFileSync(boulder.activePlan, "utf-8");
          handOffToRalph = true;
        } catch {
          // Plan file unreadable — fall back to handOffToRalph=false silently.
        }
      }
      // If boulder state absent, handOffToRalph remains false (skill did not
      // populate it before exiting — see race note above).
    }

    registerRalplan({
      task: opts.task,
      planContent,
      sessionId,
      worktreeRoot: process.cwd(),
      handOffToRalph,
    });
  }

  void fireNotification("session-end", {
    sessionId,
    projectPath: process.cwd(),
    projectName: process.cwd().split(/[\\/]/).pop() ?? "",
    timestamp: new Date().toISOString(),
    event: "session-end",
    mode: opts.mode,
    reason: (result.status ?? 0) === 0 ? "completed" : "exited-nonzero",
  });

  return result.status ?? 1;
}

async function fireNotification(
  event: "session-start" | "session-end" | "ask-user-question" | "session-idle" | "session-continuing",
  ctx: Record<string, unknown>,
): Promise<void> {
  try {
    const config = loadConfig();
    if (!config.notifications && !config.customIntegrations) return;
    await dispatch(event, ctx as unknown as NotifyContext, config);
  } catch {
    // Notifications must never abort a mode run.
  }
}

// Cancel mode — writes a cancel marker into .omcp/state/cancel.json so any
// looping skill polling state can detect it and exit.
export function runCancel(reason?: string): { path: string } {
  const dir = join(process.cwd(), ".omcp", "state");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "cancel.json");
  atomicWriteFileSync(
    path,
    JSON.stringify(
      {
        cancelled_at: new Date().toISOString(),
        reason: reason ?? "user-cancelled",
      },
      null,
      2,
    ),
  );
  return { path };
}

// Note mode — append a line to .omcp/notepad.md priority section.
export function runNote(text: string): { path: string } {
  const file = join(process.cwd(), ".omcp", "notepad.md");
  mkdirSync(join(process.cwd(), ".omcp"), { recursive: true });
  let existing = "";
  try {
    existing = require("node:fs").readFileSync(file, "utf8");
  } catch {
    existing = "# omcp notepad\n\n## priority\n\n## working\n\n## manual\n";
  }
  const insertAt = existing.indexOf("## priority");
  const after = existing.slice(insertAt + "## priority".length);
  const head = existing.slice(0, insertAt + "## priority".length);
  const next = `${head}\n${text}${after}`;
  atomicWriteFileSync(file, next);
  return { path: file };
}
