// `omcp list [type]` — list agents and/or skills with descriptions.
// type ∈ "agents" | "skills" | "all" (default)

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

export interface CatalogEntry {
  kind: "agent" | "skill";
  name: string;
  description?: string;
  level?: string;
  model?: { claude?: string; gpt?: string };
}

function parseFrontmatter(text: string): Record<string, string> {
  if (!text.startsWith("---")) return {};
  const end = text.indexOf("\n---", 3);
  if (end === -1) return {};
  const block = text.slice(3, end);
  const out: Record<string, string> = {};
  let inModelBlock = false;
  const model: Record<string, string> = {};
  for (const line of block.split(/\r?\n/)) {
    if (/^model:\s*$/.test(line)) {
      inModelBlock = true;
      continue;
    }
    if (inModelBlock) {
      const m = line.match(/^\s+(claude|gpt):\s*(.+)$/);
      if (m) {
        model[m[1]] = m[2].trim();
        continue;
      }
      if (!/^\s/.test(line)) inModelBlock = false;
    }
    const m = line.match(/^([a-zA-Z_-]+):\s*(.+)$/);
    if (m) out[m[1]] = m[2].trim();
  }
  if (Object.keys(model).length > 0) {
    out.__claude = model.claude ?? "";
    out.__gpt = model.gpt ?? "";
  }
  return out;
}

export function listAgents(packageRoot: string): CatalogEntry[] {
  const dir = join(packageRoot, "agents");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".md"))
    .map((f) => {
      const fm = parseFrontmatter(readFileSync(join(dir, f), "utf8"));
      return {
        kind: "agent" as const,
        name: fm.name ?? f.replace(/\.md$/, ""),
        description: fm.description,
        level: fm.level,
        model:
          fm.__claude || fm.__gpt
            ? { claude: fm.__claude || undefined, gpt: fm.__gpt || undefined }
            : undefined,
      };
    });
}

export function listSkills(packageRoot: string): CatalogEntry[] {
  const dir = join(packageRoot, "skills");
  if (!existsSync(dir)) return [];
  const out: CatalogEntry[] = [];
  for (const f of readdirSync(dir)) {
    const skillDir = join(dir, f);
    let isDir = false;
    try {
      isDir = statSync(skillDir).isDirectory();
    } catch {
      continue;
    }
    if (!isDir) continue;
    const sf = join(skillDir, "SKILL.md");
    if (!existsSync(sf)) continue;
    const fm = parseFrontmatter(readFileSync(sf, "utf8"));
    out.push({
      kind: "skill",
      name: fm.name ?? f,
      description: fm.description,
      level: fm.level,
    });
  }
  return out;
}

export function formatCatalog(
  entries: CatalogEntry[],
  type: "agents" | "skills" | "all",
): string {
  if (entries.length === 0) return `omcp list: no ${type} found`;
  const lines: string[] = [];
  let header: string;
  if (type === "agents") header = `Agents (${entries.length}):`;
  else if (type === "skills") header = `Skills (${entries.length}):`;
  else
    header = `Catalog (${entries.filter((e) => e.kind === "agent").length} agents, ${entries.filter((e) => e.kind === "skill").length} skills):`;
  lines.push(header);
  for (const e of entries) {
    const tag = e.kind === "agent" ? "[A]" : "[S]";
    const desc = e.description ? `  ${e.description.slice(0, 70)}` : "";
    lines.push(`  ${tag} ${e.name.padEnd(28)}${desc}`);
  }
  return lines.join("\n");
}
