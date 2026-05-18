#!/usr/bin/env node
// omcp trace MCP server — exposes trace_summary, trace_timeline.
// Backed by .omcp/state/trace/{sessionId}.jsonl (one JSON event per line).

import { runMcpServer } from "./server-runtime.js";
import {
  traceAppend,
  traceSummary,
  traceTimeline,
} from "../runtime/trace.js";

runMcpServer({
  name: "omcp-trace",
  version: "0.1.0",
  tools: [
    {
      name: "trace_append",
      description: "Append a trace event (kind + free-form data).",
      inputSchema: {
        type: "object",
        properties: {
          sessionId: { type: "string" },
          kind: { type: "string" },
          data: {},
        },
        required: ["sessionId", "kind"],
      },
      handler: (args) =>
        traceAppend(args.sessionId as string, args.kind as string, args.data),
    },
    {
      name: "trace_summary",
      description: "Counts per trace event kind for a session.",
      inputSchema: {
        type: "object",
        properties: { sessionId: { type: "string" } },
        required: ["sessionId"],
      },
      handler: (args) => traceSummary(args.sessionId as string),
    },
    {
      name: "trace_timeline",
      description: "Full event list in chronological order (most recent N).",
      inputSchema: {
        type: "object",
        properties: {
          sessionId: { type: "string" },
          limit: { type: "number" },
        },
        required: ["sessionId"],
      },
      handler: (args) =>
        traceTimeline(args.sessionId as string, args.limit as number | undefined),
    },
  ],
}).catch((err) => {
  console.error(err);
  process.exit(1);
});
