// `omcp team <spec> <task>` — spawn a parallel team of Copilot workers.
//
// Spec syntax:
//   N:agent          e.g. "4:executor"  -> 4 workers, each running --agent executor
//   N                e.g. "4"           -> 4 workers, no agent specified
//
// Implementation: when tmux is available on PATH, create a session with N panes.
// Otherwise spawn N detached `copilot -p` processes and write per-worker logs
// under .omcp/state/sessions/<uuid>/worker-K.log.
// Per-worker pidfiles are written to .omcp/state/team/<sessionId>/worker-K.pid
// so that stopTeam can SIGTERM them on Ctrl+C.

import { spawnSync } from "node:child_process";
import { spawnCrossPlatform } from "../../runtime/resolve-executable.js";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  unlinkSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";

import { mergeShards } from "../../lib/team-shard-state.js";
import type { MergeReport } from "../../lib/team-shard-state.js";
import { writeModeState } from "../../runtime/mode-state.js";
import type { TeamState } from "../../runtime/mode-state.js";
import { atomicWriteFileSync } from "../../runtime/atomic-write.js";

export interface TeamSpec {
  count: number;
  agent?: string;
}

export function parseTeamSpec(input: string): TeamSpec {
  const [left, right] = input.split(":");
  const count = Number.parseInt(left ?? "0", 10);
  if (!Number.isFinite(count) || count < 1) {
    throw new Error(`team spec must start with a positive integer (got: ${input})`);
  }
  if (right && !/^[a-z0-9_-]+$/i.test(right)) {
    throw new Error(`team spec agent must be a slug (got: ${right})`);
  }
  return { count, agent: right };
}

function tmuxAvailable(): boolean {
  const r = spawnSync(process.platform === "win32" ? "where" : "which", ["tmux"], {
    encoding: "utf8",
  });
  return r.status === 0 && r.stdout.trim().length > 0;
}

export interface TeamLaunchReport {
  sessionId: string;
  count: number;
  agent?: string;
  mode: "tmux" | "detached";
  logDir: string;
  /** Only present in detached mode. Directory containing per-worker .pid files. */
  pidDir?: string;
}

export function runTeam(spec: TeamSpec, task: string): TeamLaunchReport {
  const sessionId = randomUUID();
  const logDir = join(process.cwd(), ".omcp", "state", "sessions", sessionId);
  mkdirSync(logDir, { recursive: true });

  // Write TeamState with current_phase='executing' before spawning workers so
  // that readModeState('team') is available immediately after this call returns.
  writeModeState<TeamState>("team", {
    active: true,
    session_id: sessionId,
    started_at: new Date().toISOString(),
    spawned: spec.count,
    done: 0,
    workers: Array.from({ length: spec.count }, (_, i) => ({
      id: `worker-${i + 1}`,
      agent: spec.agent,
      status: "pending",
    })),
    current_phase: "executing",
    stage_history: ["initializing", "executing"],
  }, sessionId);

  if (tmuxAvailable()) {
    const sessionName = `omcp-team-${sessionId.slice(0, 8)}`;
    const cmds = Array.from({ length: spec.count }, (_, i) => {
      const args = ["-p", `${task} (worker ${i + 1}/${spec.count})`, "--allow-all-tools"];
      if (spec.agent) args.push("--agent", spec.agent);
      const log = join(logDir, `worker-${i + 1}.log`);
      return `copilot ${args.map((a) => JSON.stringify(a)).join(" ")} 2>&1 | tee ${JSON.stringify(log)}`;
    });
    spawnSync("tmux", ["new-session", "-d", "-s", sessionName, cmds[0]], {
      stdio: "inherit",
    });
    for (let i = 1; i < cmds.length; i++) {
      spawnSync("tmux", ["split-window", "-t", sessionName, cmds[i]], {
        stdio: "inherit",
      });
    }
    spawnSync("tmux", ["select-layout", "-t", sessionName, "tiled"], {
      stdio: "inherit",
    });
    return { sessionId, count: spec.count, agent: spec.agent, mode: "tmux", logDir };
  }

  const pidDir = join(process.cwd(), ".omcp", "state", "team", sessionId);
  mkdirSync(pidDir, { recursive: true });

  for (let i = 0; i < spec.count; i++) {
    const args = ["-p", `${task} (worker ${i + 1}/${spec.count})`, "--allow-all-tools"];
    if (spec.agent) args.push("--agent", spec.agent);
    const child = spawnCrossPlatform("copilot", args, {
      detached: true,
      stdio: "ignore",
    });
    child.unref();
    if (child.pid !== undefined) {
      // Record the worker pid so stopTeam can SIGTERM it later.
      // Invariant 2: use atomicWriteFileSync (carve-out lifted in Phase L2.6).
      atomicWriteFileSync(join(pidDir, `worker-${i + 1}.pid`), String(child.pid));
    }
  }
  return {
    sessionId,
    count: spec.count,
    agent: spec.agent,
    mode: "detached",
    logDir,
    pidDir,
  };
}

export interface TeamStopReport {
  sessionId: string;
  killed: number[];
  errors: string[];
}

/**
 * Stop all detached workers for a session by reading their pidfiles,
 * SIGTERMing them, and removing the pidfiles.
 */
export function stopTeam(
  sessionId: string,
  opts: {
    /** Test hook: override process killer. Defaults to platform SIGTERM/taskkill. */
    killProcess?: (pid: number) => void;
  } = {},
): TeamStopReport {
  const killProcess =
    opts.killProcess ??
    ((pid: number) => {
      if (process.platform === "win32") {
        spawnSync("taskkill", ["/PID", String(pid), "/F"], { stdio: "ignore" });
      } else {
        process.kill(pid, "SIGTERM");
      }
    });

  const pidDir = join(process.cwd(), ".omcp", "state", "team", sessionId);
  const killed: number[] = [];
  const errors: string[] = [];

  if (!existsSync(pidDir)) {
    return { sessionId, killed, errors };
  }

  for (const f of readdirSync(pidDir)) {
    if (!f.endsWith(".pid")) continue;
    const pidPath = join(pidDir, f);
    try {
      const pid = Number(readFileSync(pidPath, "utf8").trim());
      if (Number.isFinite(pid) && pid > 0) {
        try {
          killProcess(pid);
        } catch (err) {
          errors.push(`kill ${pid}: ${(err as Error).message}`);
          // pidfile left intact so user can retry after fixing the underlying
          // issue (access denied, zombie process, etc.).
          continue;
        }
        // DD8 Critic-A P1 fix: verify the process actually died before
        // claiming success and deleting the pidfile. Without this, a failed
        // taskkill (Win) or SIGTERM (POSIX) silently orphans the worker
        // AND removes the only mechanism to stop it later.
        if (isProcessAlive(pid, 600)) {
          errors.push(`kill ${pid}: process still alive after kill signal`);
          // Leave pidfile intact.
          continue;
        }
        killed.push(pid);
      }
      unlinkSync(pidPath);
    } catch (err) {
      errors.push(`read ${pidPath}: ${(err as Error).message}`);
    }
  }

  return { sessionId, killed, errors };
}

// ─── merge-shards subcommand ──────────────────────────────────────────────────

export interface TeamMergeResult {
  ok: boolean;
  report?: MergeReport;
  error?: string;
}

/**
 * Merge all per-worker PRD shards for `teamName` into the canonical PRD.
 *
 * Called by `omcp team merge-shards <team-name>` and optionally auto-triggered
 * by the persistent-mode hook when ralph PRD allComplete is detected.
 */
export function runTeamMergeShards(
  teamName: string,
  opts: { cwd?: string } = {},
): TeamMergeResult {
  const cwd = opts.cwd ?? process.cwd();
  try {
    const report = mergeShards(teamName, cwd);
    return { ok: true, report };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

// DD8: short busy-poll for process termination. Bounded by deadlineMs.
// Returns true if the pid is still alive after the deadline, false if it died.
function isProcessAlive(pid: number, deadlineMs: number): boolean {
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    try {
      // `process.kill(pid, 0)` throws ESRCH if the process is gone.
      // On Windows this is implemented via libuv and is reliable enough.
      process.kill(pid, 0);
    } catch {
      return false;
    }
    // ~30ms spin between checks. Acceptable: stopTeam is rare and synchronous.
    const spinUntil = Date.now() + 30;
    while (Date.now() < spinUntil) {
      // intentional busy wait — keeps the loop synchronous.
    }
  }
  // Final attempt.
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
