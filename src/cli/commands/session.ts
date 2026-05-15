// `omcp session [query]` — list omcp session dirs under .omcp/state/sessions/
// with optional grep-style filter on contained logs/state.

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

export interface SessionEntry {
  id: string;
  path: string;
  modifiedAt: string;
  workerLogs: string[];
  matches?: number;
}

export function listSessions(query?: string): SessionEntry[] {
  const root = join(process.cwd(), ".omcp", "state", "sessions");
  if (!existsSync(root)) return [];
  const out: SessionEntry[] = [];
  for (const id of readdirSync(root)) {
    const dir = join(root, id);
    const st = statSync(dir);
    if (!st.isDirectory()) continue;
    const workerLogs = readdirSync(dir)
      .filter((f) => f.endsWith(".log"))
      .map((f) => join(dir, f));
    let matches: number | undefined;
    if (query) {
      matches = 0;
      for (const f of workerLogs) {
        try {
          const text = readFileSync(f, "utf8");
          matches += (text.match(new RegExp(query, "gi")) ?? []).length;
        } catch {
          // ignore unreadable file
        }
      }
    }
    out.push({
      id,
      path: dir,
      modifiedAt: st.mtime.toISOString(),
      workerLogs,
      matches,
    });
  }
  out.sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt));
  return out;
}

export function formatSessions(sessions: SessionEntry[]): string {
  if (sessions.length === 0) return "omcp session: no sessions found";
  const rows = sessions.map((s) => {
    const matchSuffix = s.matches !== undefined ? `  matches=${s.matches}` : "";
    return `  ${s.id}  (${s.workerLogs.length} workers, modified ${s.modifiedAt})${matchSuffix}`;
  });
  return [`omcp session (${sessions.length}):`, ...rows].join("\n");
}
