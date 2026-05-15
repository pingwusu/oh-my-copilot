#!/usr/bin/env node
// omcp project-memory MCP server — exposes project_memory_read/write/
// add_note/add_directive. Backed by .omcp/project-memory.json.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { runMcpServer } from "./server-runtime.js";

const FILE = process.env.OMCP_PROJECT_MEMORY ?? join(process.cwd(), ".omcp", "project-memory.json");

interface ProjectMemory {
  notes: Array<{ t: string; text: string }>;
  directives: Array<{ t: string; text: string }>;
  data: Record<string, unknown>;
}

function load(): ProjectMemory {
  if (!existsSync(FILE)) return { notes: [], directives: [], data: {} };
  return JSON.parse(readFileSync(FILE, "utf8")) as ProjectMemory;
}

function save(m: ProjectMemory): void {
  mkdirSync(dirname(FILE), { recursive: true });
  writeFileSync(FILE, JSON.stringify(m, null, 2));
}

runMcpServer({
  name: "omcp-project-memory",
  version: "0.1.0",
  tools: [
    {
      name: "project_memory_read",
      description: "Read the project memory.",
      inputSchema: { type: "object", properties: {} },
      handler: () => load(),
    },
    {
      name: "project_memory_write",
      description: "Set arbitrary structured data under .data.",
      inputSchema: {
        type: "object",
        properties: { key: { type: "string" }, value: {} },
        required: ["key", "value"],
      },
      handler: (args) => {
        const m = load();
        m.data[args.key as string] = args.value;
        save(m);
        return { ok: true };
      },
    },
    {
      name: "project_memory_add_note",
      description: "Append a free-form note (timestamped).",
      inputSchema: {
        type: "object",
        properties: { text: { type: "string" } },
        required: ["text"],
      },
      handler: (args) => {
        const m = load();
        m.notes.push({ t: new Date().toISOString(), text: args.text as string });
        save(m);
        return { ok: true, count: m.notes.length };
      },
    },
    {
      name: "project_memory_add_directive",
      description: "Append a directive (timestamped). Use for behaviorally binding rules.",
      inputSchema: {
        type: "object",
        properties: { text: { type: "string" } },
        required: ["text"],
      },
      handler: (args) => {
        const m = load();
        m.directives.push({ t: new Date().toISOString(), text: args.text as string });
        save(m);
        return { ok: true, count: m.directives.length };
      },
    },
  ],
}).catch((err) => {
  console.error(err);
  process.exit(1);
});
