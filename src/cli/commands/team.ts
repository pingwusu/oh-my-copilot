// `omcp team <spec> <task>` — spawn a parallel team of Copilot workers.
//
// Spec syntax:
//   N:agent          e.g. "4:executor"  → 4 workers, each running --agent executor
//   N                e.g. "4"           → 4 workers, no agent specified
//
// Implementation: when tmux is available on PATH, create a session with N panes.
// Otherwise spawn N detached `copilot -p` processes and write per-worker logs
// under .omcp/state/sessions/<uuid>/worker-K.log.

import { spawn, spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";

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
}

export function runTeam(spec: TeamSpec, task: string): TeamLaunchReport {
  const sessionId = randomUUID();
  const logDir = join(process.cwd(), ".omcp", "state", "sessions", sessionId);
  mkdirSync(logDir, { recursive: true });

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

  for (let i = 0; i < spec.count; i++) {
    const args = ["-p", `${task} (worker ${i + 1}/${spec.count})`, "--allow-all-tools"];
    if (spec.agent) args.push("--agent", spec.agent);
    const child = spawn("copilot", args, { detached: true, stdio: "ignore" });
    child.unref();
  }
  return {
    sessionId,
    count: spec.count,
    agent: spec.agent,
    mode: "detached",
    logDir,
  };
}
