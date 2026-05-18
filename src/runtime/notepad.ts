// Pure-functional notepad I/O — shared by the MCP server and the CLI command.
// Path resolution: OMCP_NOTEPAD_PATH env var overrides the default, so tests
// can isolate to a tmp directory without polluting .omcp/.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const SECTIONS = ["priority", "working", "manual"] as const;
export type Section = (typeof SECTIONS)[number];

export interface Notepad {
  priority: string[];
  working: string[];
  manual: string[];
}

export function notepadPath(): string {
  return process.env.OMCP_NOTEPAD_PATH ?? join(process.cwd(), ".omcp", "notepad.md");
}

export function blank(): string {
  return "# omcp notepad\n\n## priority\n\n## working\n\n## manual\n";
}

export function ensureFile(path: string): void {
  if (!existsSync(path)) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, blank());
  }
}

export function loadNotepad(path?: string): Notepad {
  const p = path ?? notepadPath();
  ensureFile(p);
  const raw = readFileSync(p, "utf8");
  const out: Notepad = { priority: [], working: [], manual: [] };
  let current: Section | null = null;
  for (const line of raw.split(/\r?\n/)) {
    const m = line.match(/^##\s+(priority|working|manual)\s*$/);
    if (m) {
      current = m[1] as Section;
      continue;
    }
    if (!current) continue;
    if (line.trim().length === 0) continue;
    out[current].push(line);
  }
  return out;
}

export function saveNotepad(np: Notepad, path?: string): void {
  const p = path ?? notepadPath();
  const parts = ["# omcp notepad\n"];
  for (const s of SECTIONS) {
    parts.push(`## ${s}\n`);
    for (const line of np[s]) parts.push(`${line}\n`);
    parts.push("");
  }
  writeFileSync(p, parts.join("\n"));
}

export function notepadRead(): Notepad {
  return loadNotepad();
}

export function notepadWriteSection(section: Section, text: string): { ok: true; count: number } {
  const np = loadNotepad();
  np[section].push(text);
  saveNotepad(np);
  return { ok: true, count: np[section].length };
}

export function notepadPrune(section: Section): { ok: true } {
  const np = loadNotepad();
  np[section] = [];
  saveNotepad(np);
  return { ok: true };
}

export function notepadStats(): { priority: number; working: number; manual: number } {
  const np = loadNotepad();
  return {
    priority: np.priority.length,
    working: np.working.length,
    manual: np.manual.length,
  };
}
