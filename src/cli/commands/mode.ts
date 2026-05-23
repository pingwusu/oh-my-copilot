// `omcp <mode> "<task>"` — thin CLI wrapper that delegates to Copilot's
// non-interactive prompt mode (`copilot -p`) with the named skill activated.
//
// Maps to: copilot -p "/oh-my-copilot:<mode> <task>" --allow-all-tools [--autopilot]
//
// Modes that imply long-running loops (ralph, autopilot, ultrawork, ultraqa,
// sciomc) get `--autopilot` automatically so Copilot keeps continuing until
// the skill emits a completion signal or the user cancels.

import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
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
  writeModeState,
} from "../../runtime/mode-state.js";
import {
  writeRalphState,
  clearRalphState,
} from "../../lib/ralph-state.js";
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

  // Mode-state tracking + mutual-exclusion check for known modes.
  const isTrackedMode = opts.mode in MODE_CONFIGS;
  const sessionId = randomUUID();
  if (isTrackedMode) {
    const target = opts.mode as ModeName;
    const check = canStartMode(target);
    if (!check.ok) {
      console.error(
        `omcp: cannot start ${target} while ${check.conflict} is active. Run 'omcp cancel' first or wait.`,
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
  if (opts.mode === "ralph") {
    writeRalphState({
      active: true,
      iteration: 1,
      lastFiredAt: new Date().toISOString(),
      prompt: opts.task,
      ...(opts.prdPath ? { prdPath: opts.prdPath } : {}),
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
    args.push("--autopilot");
    if (opts.maxContinues !== undefined) {
      args.push("--max-autopilot-continues", String(opts.maxContinues));
    }
  }

  if (ONE_SHOT_MODES.has(opts.mode) && opts.maxContinues === undefined) {
    // One-shot modes don't get --autopilot.
  }

  const result = spawnSyncCrossPlatform("copilot", args, {
    stdio: "inherit",
    shell: false,
  });

  if (isTrackedMode) {
    clearModeState(opts.mode as ModeName);
  }

  // Ralph-specific: clear ralph-state after copilot exits.
  if (opts.mode === "ralph") {
    clearRalphState();
  }

  // Ralplan-specific: register boulder state after the skill completes so the
  // omc-orchestrator hook and ralph can pick up the active plan.
  if (opts.mode === "ralplan") {
    registerRalplan({
      task: opts.task,
      planContent: "",
      sessionId,
      worktreeRoot: process.cwd(),
      handOffToRalph: false,
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
