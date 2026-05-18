// `omcp doctor team-routing` — verify the runtime prerequisites for `omcp team`.
//
// Adapted from omc 4.14.0. omc's version probes the configured /team role
// providers (claude/codex/gemini). omcp's team runtime is different:
//
//   - All workers are `copilot` CLI processes; there is no per-role provider
//     to probe.
//   - Concurrency depends on `tmux` (optional — falls back to detached
//     processes when absent — see `src/cli/commands/team.ts`).
//   - team mode is non-mutually-exclusive in MODE_CONFIGS, but other
//     mutually-exclusive modes (ralph, autopilot, ultrawork, ultraqa) can
//     leave stale state that disrupts a team launch.
//
// This check therefore:
//   1. Probes `copilot` on PATH (fail if missing — team cannot run)
//   2. Probes `tmux` on PATH (warn if missing — team falls back to detached)
//   3. Reads mode-state and warns about active mutually-exclusive modes
//   4. Confirms `team` itself is currently startable (canStartMode)

import { execSync } from "node:child_process";
import {
  canStartMode,
  listActiveModes,
  MODE_CONFIGS,
  type ModeName,
} from "../../runtime/mode-state.js";

export type ProbeLevel = "ok" | "warn" | "fail";

export interface ProbeResult {
  name: string;
  level: ProbeLevel;
  detail: string;
}

interface BinaryProbe {
  binary: string;
  found: boolean;
  path?: string;
  version?: string;
}

function probeBinary(binary: string): BinaryProbe {
  const probe: BinaryProbe = { binary, found: false };
  try {
    const lookup = process.platform === "win32" ? "where" : "command -v";
    const resolved = execSync(`${lookup} ${binary}`, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    })
      .trim()
      .split(/\r?\n/)[0];
    if (resolved) {
      probe.found = true;
      probe.path = resolved;
      try {
        const v = execSync(`${binary} --version`, {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"],
          timeout: 3000,
        })
          .trim()
          .split("\n")[0];
        if (v) probe.version = v;
      } catch {
        // version is best-effort.
      }
    }
  } catch {
    // not on PATH — leave found=false.
  }
  return probe;
}

export interface TeamRoutingReport {
  probes: ProbeResult[];
  activeModes: ModeName[];
  canStartTeam: boolean;
  conflict?: ModeName;
}

/**
 * Fast-path probes — no exec calls. Safe to call from the base `omcp doctor`
 * runner where adding ~3s of `copilot --version` is unacceptable. Inspects
 * mode-state on disk and reports team mutual-exclusion availability.
 */
export function probeTeamModeState(): ProbeResult[] {
  const probes: ProbeResult[] = [];

  let activeModes: ModeName[] = [];
  try {
    activeModes = listActiveModes();
  } catch {
    activeModes = [];
  }
  const activeExclusive = activeModes.filter(
    (m) => MODE_CONFIGS[m].mutuallyExclusive,
  );
  if (activeExclusive.length === 0) {
    probes.push({
      name: "mode state",
      level: "ok",
      detail: "no mutually-exclusive modes active",
    });
  } else {
    probes.push({
      name: "mode state",
      level: "warn",
      detail: `active mutually-exclusive mode(s): ${activeExclusive.join(", ")} — clear with \`omcp cancel\` before \`omcp team\``,
    });
  }

  const start = canStartMode("team");
  probes.push(
    start.ok
      ? {
          name: "team mode availability",
          level: "ok",
          detail: "team is startable",
        }
      : {
          name: "team mode availability",
          level: "warn",
          detail: `team currently blocked by ${start.conflict ?? "unknown"}`,
        },
  );

  return probes;
}

/**
 * Full team-routing report — runs binary probes (copilot, tmux) plus
 * mode-state probes. Slower; invoke via `omcp doctor team-routing`.
 */
export function runDoctorTeamRouting(): TeamRoutingReport {
  const probes: ProbeResult[] = [];

  const copilot = probeBinary("copilot");
  probes.push(
    copilot.found
      ? {
          name: "copilot CLI",
          level: "ok",
          detail: `${copilot.path}${copilot.version ? ` (${copilot.version})` : ""}`,
        }
      : {
          name: "copilot CLI",
          level: "fail",
          detail: "not on PATH — `omcp team` cannot launch workers",
        },
  );

  const tmux = probeBinary("tmux");
  probes.push(
    tmux.found
      ? {
          name: "tmux",
          level: "ok",
          detail: `${tmux.path}${tmux.version ? ` (${tmux.version})` : ""}`,
        }
      : {
          name: "tmux",
          level: "warn",
          detail:
            "not on PATH — `omcp team` will fall back to detached child processes (no pane multiplexing)",
        },
  );

  probes.push(...probeTeamModeState());

  let activeModes: ModeName[] = [];
  try {
    activeModes = listActiveModes();
  } catch {
    activeModes = [];
  }
  const start = canStartMode("team");

  return {
    probes,
    activeModes,
    canStartTeam: start.ok,
    conflict: start.conflict,
  };
}

export interface DoctorTeamRoutingOptions {
  json?: boolean;
}

export async function doctorTeamRoutingCommand(
  options: DoctorTeamRoutingOptions = {},
): Promise<number> {
  const report = runDoctorTeamRouting();
  if (options.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    process.stdout.write("Team routing diagnostics\n");
    for (const p of report.probes) {
      const sym = p.level === "ok" ? "OK  " : p.level === "warn" ? "WARN" : "FAIL";
      process.stdout.write(`  [${sym}] ${p.name}: ${p.detail}\n`);
    }
  }
  // Warn-only by default — a missing copilot CLI fails because that's a hard
  // blocker for team, but anything else returns 0.
  if (report.probes.some((p) => p.level === "fail")) return 2;
  return 0;
}
