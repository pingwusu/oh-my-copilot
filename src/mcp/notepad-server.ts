#!/usr/bin/env node
// omcp notepad MCP server — exposes notepad_read/write_priority/write_working/
// write_manual/prune/stats. Backed by .omcp/notepad.md (priority/working/manual
// sections delimited by markdown headers).

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { runMcpServer } from "./server-runtime.js";

const NOTEPAD_PATH = process.env.OMCP_NOTEPAD_PATH ?? join(process.cwd(), ".omcp", "notepad.md");

const SECTIONS = ["priority", "working", "manual"] as const;
type Section = (typeof SECTIONS)[number];

interface Notepad {
  priority: string[];
  working: string[];
  manual: string[];
}

function ensureFile(): void {
  if (!existsSync(NOTEPAD_PATH)) {
    mkdirSync(dirname(NOTEPAD_PATH), { recursive: true });
    writeFileSync(NOTEPAD_PATH, blank());
  }
}

function blank(): string {
  return "# omcp notepad\n\n## priority\n\n## working\n\n## manual\n";
}

function load(): Notepad {
  ensureFile();
  const raw = readFileSync(NOTEPAD_PATH, "utf8");
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

function save(np: Notepad): void {
  const parts = ["# omcp notepad\n"];
  for (const s of SECTIONS) {
    parts.push(`## ${s}\n`);
    for (const line of np[s]) parts.push(`${line}\n`);
    parts.push("");
  }
  writeFileSync(NOTEPAD_PATH, parts.join("\n"));
}

runMcpServer({
  name: "omcp-notepad",
  version: "0.1.0",
  tools: [
    {
      name: "notepad_read",
      description: "Read notepad contents (all sections).",
      inputSchema: { type: "object", properties: {} },
      handler: () => load(),
    },
    {
      name: "notepad_write_priority",
      description: "Append a line to the priority section.",
      inputSchema: {
        type: "object",
        properties: { text: { type: "string" } },
        required: ["text"],
      },
      handler: (args) => {
        const np = load();
        np.priority.push(args.text as string);
        save(np);
        return { ok: true, count: np.priority.length };
      },
    },
    {
      name: "notepad_write_working",
      description: "Append a line to the working section.",
      inputSchema: {
        type: "object",
        properties: { text: { type: "string" } },
        required: ["text"],
      },
      handler: (args) => {
        const np = load();
        np.working.push(args.text as string);
        save(np);
        return { ok: true, count: np.working.length };
      },
    },
    {
      name: "notepad_write_manual",
      description: "Append a line to the manual section.",
      inputSchema: {
        type: "object",
        properties: { text: { type: "string" } },
        required: ["text"],
      },
      handler: (args) => {
        const np = load();
        np.manual.push(args.text as string);
        save(np);
        return { ok: true, count: np.manual.length };
      },
    },
    {
      name: "notepad_prune",
      description: "Clear a section. section ∈ priority|working|manual",
      inputSchema: {
        type: "object",
        properties: { section: { type: "string", enum: [...SECTIONS] } },
        required: ["section"],
      },
      handler: (args) => {
        const np = load();
        const section = args.section as Section;
        np[section] = [];
        save(np);
        return { ok: true };
      },
    },
    {
      name: "notepad_stats",
      description: "Return per-section line counts.",
      inputSchema: { type: "object", properties: {} },
      handler: () => {
        const np = load();
        return {
          priority: np.priority.length,
          working: np.working.length,
          manual: np.manual.length,
        };
      },
    },
  ],
}).catch((err) => {
  console.error(err);
  process.exit(1);
});
