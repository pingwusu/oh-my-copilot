#!/usr/bin/env node
// omcp project-memory MCP server — exposes project_memory_read/write/
// add_note/add_directive. Backed by .omcp/project-memory.json.

import { runMcpServer } from "./server-runtime.js";
import {
  projectMemoryRead,
  projectMemoryWrite,
  projectMemoryAddNote,
  projectMemoryAddDirective,
} from "../runtime/project-memory.js";

runMcpServer({
  name: "omcp-project-memory",
  version: "0.1.0",
  tools: [
    {
      name: "project_memory_read",
      description: "Read the project memory.",
      inputSchema: { type: "object", properties: {} },
      handler: () => projectMemoryRead(),
    },
    {
      name: "project_memory_write",
      description: "Set arbitrary structured data under .data.",
      inputSchema: {
        type: "object",
        properties: { key: { type: "string" }, value: {} },
        required: ["key", "value"],
      },
      handler: (args) =>
        projectMemoryWrite(args.key as string, args.value),
    },
    {
      name: "project_memory_add_note",
      description: "Append a free-form note (timestamped).",
      inputSchema: {
        type: "object",
        properties: { text: { type: "string" } },
        required: ["text"],
      },
      handler: (args) => projectMemoryAddNote(args.text as string),
    },
    {
      name: "project_memory_add_directive",
      description: "Append a directive (timestamped). Use for behaviorally binding rules.",
      inputSchema: {
        type: "object",
        properties: { text: { type: "string" } },
        required: ["text"],
      },
      handler: (args) => projectMemoryAddDirective(args.text as string),
    },
  ],
}).catch((err) => {
  console.error(err);
  process.exit(1);
});
