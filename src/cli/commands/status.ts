// `omcp status` — what's active right now? Reads .omcp/state/* and reports
// active modes, ralph iterations, team workers, cancel marker.

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

export interface StatusReport {
  cancelled: boolean;
  cancelReason?: string;
  activeModes: string[];
  ralphIteration?: { current: number; max: number };
  teamWorkers?: { done: number; spawned: number };
  notepadPriority?: string;
  sessions: number;
}

export function readStatus(): StatusReport {
  const root = join(process.cwd(), ".omcp");
  const stateDir = join(root, "state");

  const out: StatusReport = {
    cancelled: false,
    activeModes: [],
    sessions: 0,
  };

  const cancelMarker = join(stateDir, "cancel.json");
  if (existsSync(cancelMarker)) {
    out.cancelled = true;
    try {
      const m = JSON.parse(readFileSync(cancelMarker, "utf8"));
      out.cancelReason = m.reason;
    } catch {
      // ignore
    }
  }

  const modeFile = join(stateDir, "mode.json");
  if (existsSync(modeFile)) {
    try {
      const m = JSON.parse(readFileSync(modeFile, "utf8"));
      if (Array.isArray(m.modes)) out.activeModes = m.modes as string[];
    } catch {
      // ignore
    }
  }

  const ralphFile = join(stateDir, "ralph.json");
  if (existsSync(ralphFile)) {
    try {
      const r = JSON.parse(readFileSync(ralphFile, "utf8"));
      if (typeof r.iteration === "number" && typeof r.max === "number") {
        out.ralphIteration = { current: r.iteration, max: r.max };
      }
    } catch {
      // ignore
    }
  }

  const teamFile = join(stateDir, "team.json");
  if (existsSync(teamFile)) {
    try {
      const t = JSON.parse(readFileSync(teamFile, "utf8"));
      if (typeof t.done === "number" && typeof t.spawned === "number") {
        out.teamWorkers = { done: t.done, spawned: t.spawned };
      }
    } catch {
      // ignore
    }
  }

  const notepad = join(root, "notepad.md");
  if (existsSync(notepad)) {
    const text = readFileSync(notepad, "utf8");
    const m = text.match(/## priority\n([\s\S]*?)(?=\n##|$)/);
    if (m) {
      const firstLine = m[1].split(/\r?\n/).find((l) => l.trim().length > 0);
      if (firstLine) out.notepadPriority = firstLine.trim().slice(0, 80);
    }
  }

  const sessionsDir = join(stateDir, "sessions");
  if (existsSync(sessionsDir)) {
    out.sessions = readdirSync(sessionsDir).filter((f) => {
      try {
        return statSync(join(sessionsDir, f)).isDirectory();
      } catch {
        return false;
      }
    }).length;
  }

  return out;
}

export function formatStatus(s: StatusReport): string {
  const lines: string[] = ["omcp status:"];
  if (s.cancelled) lines.push(`  cancelled: yes (${s.cancelReason ?? "-"})`);
  else lines.push("  cancelled: no");
  lines.push(
    s.activeModes.length > 0
      ? `  active modes: ${s.activeModes.join(", ")}`
      : "  active modes: -",
  );
  if (s.ralphIteration)
    lines.push(`  ralph iteration: ${s.ralphIteration.current}/${s.ralphIteration.max}`);
  if (s.teamWorkers)
    lines.push(`  team workers: ${s.teamWorkers.done}/${s.teamWorkers.spawned} done`);
  if (s.notepadPriority) lines.push(`  priority note: ${s.notepadPriority}`);
  lines.push(`  sessions: ${s.sessions}`);
  return lines.join("\n");
}
