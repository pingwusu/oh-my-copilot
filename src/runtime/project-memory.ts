// Pure-functional project-memory I/O — shared by the MCP server and the CLI command.
// Path resolution: OMCP_PROJECT_MEMORY env var overrides the default, so tests
// can isolate to a tmp directory without polluting .omcp/.

import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { atomicWriteFileSync } from "./atomic-write.js";

export interface ProjectMemory {
  notes: Array<{ t: string; text: string }>;
  directives: Array<{ t: string; text: string }>;
  data: Record<string, unknown>;
}

export function projectMemoryPath(): string {
  return process.env.OMCP_PROJECT_MEMORY ?? join(process.cwd(), ".omcp", "project-memory.json");
}

export function loadProjectMemory(path?: string): ProjectMemory {
  const p = path ?? projectMemoryPath();
  if (!existsSync(p)) return { notes: [], directives: [], data: {} };
  try {
    return JSON.parse(readFileSync(p, "utf8")) as ProjectMemory;
  } catch {
    console.error(`[project-memory] corrupt file at ${p} — returning empty state`);
    return { notes: [], directives: [], data: {} };
  }
}

export function saveProjectMemory(m: ProjectMemory, path?: string): void {
  const p = path ?? projectMemoryPath();
  mkdirSync(dirname(p), { recursive: true });
  atomicWriteFileSync(p, JSON.stringify(m, null, 2));
}

export function projectMemoryRead(): ProjectMemory {
  return loadProjectMemory();
}

export function projectMemoryWrite(key: string, value: unknown): { ok: true } {
  const m = loadProjectMemory();
  m.data[key] = value;
  saveProjectMemory(m);
  return { ok: true };
}

export function projectMemoryAddNote(text: string): { ok: true; count: number } {
  const m = loadProjectMemory();
  m.notes.push({ t: new Date().toISOString(), text });
  saveProjectMemory(m);
  return { ok: true, count: m.notes.length };
}

export function projectMemoryAddDirective(text: string): { ok: true; count: number } {
  const m = loadProjectMemory();
  m.directives.push({ t: new Date().toISOString(), text });
  saveProjectMemory(m);
  return { ok: true, count: m.directives.length };
}
