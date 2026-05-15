#!/usr/bin/env node
// omcp trace MCP server — exposes trace_summary, trace_timeline.
// Backed by .omcp/state/trace/{sessionId}.jsonl (one JSON event per line).

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { runMcpServer } from "./server-runtime.js";

const ROOT = process.env.OMCP_TRACE_ROOT ?? join(process.cwd(), ".omcp", "state", "trace");

interface TraceEvent {
  t: string;
  kind: string;
  data?: unknown;
}

function file(sessionId: string): string {
  return join(ROOT, `${sessionId}.jsonl`);
}

function load(sessionId: string): TraceEvent[] {
  const p = file(sessionId);
  if (!existsSync(p)) return [];
  const raw = readFileSync(p, "utf8");
  return raw
    .split(/\r?\n/)
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as TraceEvent);
}

function append(sessionId: string, ev: TraceEvent): void {
  mkdirSync(dirname(file(sessionId)), { recursive: true });
  const existing = existsSync(file(sessionId)) ? readFileSync(file(sessionId), "utf8") : "";
  writeFileSync(file(sessionId), existing + JSON.stringify(ev) + "\n");
}

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
      handler: (args) => {
        append(args.sessionId as string, {
          t: new Date().toISOString(),
          kind: args.kind as string,
          data: args.data,
        });
        return { ok: true };
      },
    },
    {
      name: "trace_summary",
      description: "Counts per trace event kind for a session.",
      inputSchema: {
        type: "object",
        properties: { sessionId: { type: "string" } },
        required: ["sessionId"],
      },
      handler: (args) => {
        const events = load(args.sessionId as string);
        const byKind: Record<string, number> = {};
        for (const e of events) byKind[e.kind] = (byKind[e.kind] ?? 0) + 1;
        return { total: events.length, byKind };
      },
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
      handler: (args) => {
        const events = load(args.sessionId as string);
        const limit = (args.limit as number | undefined) ?? 100;
        return events.slice(-limit);
      },
    },
  ],
}).catch((err) => {
  console.error(err);
  process.exit(1);
});
