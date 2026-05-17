// `omcp mission-board` — workspace mission snapshot.
// Reads .omcp/missions/*.md (if present) and renders a board view.
// Mirrors omc's mission-board with omcp paths.

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

export interface Mission {
  slug: string;
  title: string;
  status: "active" | "done" | "blocked" | "unknown";
  priority?: number;
  body: string;
  path: string;
}

function parseFrontmatter(text: string): Record<string, string> {
  if (!text.startsWith("---")) return {};
  const end = text.indexOf("\n---", 3);
  if (end === -1) return {};
  const block = text.slice(3, end);
  const out: Record<string, string> = {};
  for (const line of block.split(/\r?\n/)) {
    const m = line.match(/^([a-zA-Z_-]+):\s*(.+)$/);
    if (m) out[m[1]] = m[2].trim();
  }
  return out;
}

export function loadMissions(): Mission[] {
  const dir = join(process.cwd(), ".omcp", "missions");
  if (!existsSync(dir)) return [];
  const out: Mission[] = [];
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".md")) continue;
    const fp = join(dir, f);
    const text = readFileSync(fp, "utf8");
    const fm = parseFrontmatter(text);
    const status = (fm.status as Mission["status"]) ?? "unknown";
    const priority = fm.priority ? Number(fm.priority) : undefined;
    out.push({
      slug: f.replace(/\.md$/, ""),
      title: fm.title ?? f.replace(/\.md$/, ""),
      status,
      priority,
      body: text.slice(text.indexOf("\n---", 3) + 4),
      path: fp,
    });
  }
  // Sort: active first by priority (lower=higher), then blocked, then unknown, then done
  const statusOrder: Record<string, number> = {
    active: 0,
    blocked: 1,
    unknown: 2,
    done: 3,
  };
  out.sort((a, b) => {
    const so = statusOrder[a.status] - statusOrder[b.status];
    if (so !== 0) return so;
    const pa = a.priority ?? 99;
    const pb = b.priority ?? 99;
    return pa - pb;
  });
  return out;
}

export function formatBoard(missions: Mission[]): string {
  if (missions.length === 0) {
    return "omcp mission-board: no missions found (create one at .omcp/missions/<slug>.md with frontmatter `title:`, `status:`, optional `priority:`)";
  }
  const lines: string[] = [`omcp mission-board (${missions.length}):`];
  for (const m of missions) {
    const p = m.priority !== undefined ? `[p${m.priority}] ` : "";
    lines.push(`  ${m.status.padEnd(8)} ${p}${m.slug.padEnd(24)}  ${m.title}`);
  }
  return lines.join("\n");
}
