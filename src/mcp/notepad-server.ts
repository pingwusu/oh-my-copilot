#!/usr/bin/env node
// omcp notepad MCP server — exposes notepad_read/write_priority/write_working/
// write_manual/prune/stats. Backed by .omcp/notepad.md (priority/working/manual
// sections delimited by markdown headers).

import { runMcpServer } from "./server-runtime.js";
import {
  notepadRead,
  notepadWriteSection,
  notepadPrune,
  notepadStats,
  SECTIONS,
} from "../runtime/notepad.js";

runMcpServer({
  name: "omcp-notepad",
  version: "0.1.0",
  tools: [
    {
      name: "notepad_read",
      description: "Read notepad contents (all sections).",
      inputSchema: { type: "object", properties: {} },
      handler: () => notepadRead(),
    },
    {
      name: "notepad_write_priority",
      description: "Append a line to the priority section.",
      inputSchema: {
        type: "object",
        properties: { text: { type: "string" } },
        required: ["text"],
      },
      handler: (args) => notepadWriteSection("priority", args.text as string),
    },
    {
      name: "notepad_write_working",
      description: "Append a line to the working section.",
      inputSchema: {
        type: "object",
        properties: { text: { type: "string" } },
        required: ["text"],
      },
      handler: (args) => notepadWriteSection("working", args.text as string),
    },
    {
      name: "notepad_write_manual",
      description: "Append a line to the manual section.",
      inputSchema: {
        type: "object",
        properties: { text: { type: "string" } },
        required: ["text"],
      },
      handler: (args) => notepadWriteSection("manual", args.text as string),
    },
    {
      name: "notepad_prune",
      description: "Clear a section. section ∈ priority|working|manual",
      inputSchema: {
        type: "object",
        properties: { section: { type: "string", enum: [...SECTIONS] } },
        required: ["section"],
      },
      handler: (args) => notepadPrune(args.section as typeof SECTIONS[number]),
    },
    {
      name: "notepad_stats",
      description: "Return per-section line counts.",
      inputSchema: { type: "object", properties: {} },
      handler: () => notepadStats(),
    },
  ],
}).catch((err) => {
  console.error(err);
  process.exit(1);
});
