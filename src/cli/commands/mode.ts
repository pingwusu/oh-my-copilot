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
  // non-zero exit only. Do NOT use this for the shouldClear decision on
  // clean exit — the PRD status must be re-read POST-spawn (Fix A, v1.4 RCA).
  const preSpawnRalphSnapshot =
    opts.mode === "ralph" ? readRalphState() : null;

  const result = spawnSyncCrossPlatform("copilot", args, {
    stdio: "inherit",
    shell: false,
  });

  if (isTrackedMode) {
    clearModeState(opts.mode as ModeName);
  }

  // Ralph-specific: conditionally clear ralph-state after copilot exits.
  //
  // Only clear if BOTH conditions hold:
  //   (a) copilot exited with status 0, AND
  //   (b) either the PRD reports allComplete===true (re-read POST-spawn so we
  //       see work Copilot completed during the run), OR ralph state already
  //       has architectApproved===true.
  //
  // Any other exit (non-zero, or zero-but-incomplete-PRD, or no PRD and no
  // architect approval) preserves the state so a subsequent `omcp ralph`
  // can resume from where it left off (crash/SIGINT/OOM recovery).
  //
  // NOTE: clearModeState("ralph") above deletes the same file as ralph-state
  // (both use .omcp/state/ralph-state.json). We re-read post-spawn state
  // to get the correct file content after Copilot may have updated it.
  //
  // NOTE: src/hooks/persistent-mode/index.ts also calls clearRalphState at
  // three specific conditional points:
  //   - line 122-123: architectApproved detected in Stop context text (fresh)
  //   - line 133:     architectApproved was already set in a prior iteration
  //   - line 143:     allComplete branch (PRD fully done)
  // Those call sites are the CORRECT conditional paths and must NOT be
  // modified. Only the snapshot-timing bug here (mode.ts) is fixed in v1.4.
  if (opts.mode === "ralph") {
    const ralphExitCode = result.status ?? 1;
    if (ralphExitCode !== 0) {
      // Non-zero exit (crash/SIGINT/OOM): restore pre-spawn snapshot so the
      // user can resume from where the iteration started.
      if (preSpawnRalphSnapshot) {
        writeRalphState(preSpawnRalphSnapshot);
      }
    } else {
      // Clean exit: re-read POST-spawn PRD status and ralph-state so we see
      // any work Copilot completed during the run (Fix A — never use the
      // pre-spawn prdStatusSnapshot for this decision).
      const postRunPrd = getPrdCompletionStatus();
      const postRunRalph = readRalphState();
      const shouldClear =
        postRunPrd.allComplete ||
        (postRunRalph?.architectApproved === true) ||
        (preSpawnRalphSnapshot?.architectApproved === true);
      if (!shouldClear) {
        // PRD not complete and no architect approval: preserve state for
        // resume. If clearModeState deleted the file, restore post-run state
        // (preferred) or fall back to pre-spawn snapshot.
        const stateToRestore = postRunRalph ?? preSpawnRalphSnapshot;
        if (stateToRestore) {
          writeRalphState(stateToRestore);
        }
      }
      // else: clearModeState already removed the file — done.
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
