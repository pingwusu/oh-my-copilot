// Pure-functional trace I/O — shared by the MCP server and the CLI command.
// Path resolution: OMCP_TRACE_ROOT env var overrides the default, so tests
// can isolate to a tmp directory without polluting .omcp/.

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { assertSafeSlug } from "./safe-slug.js";

export interface TraceEvent {
  t: string;
  kind: string;
  data?: unknown;
}

export function traceRoot(): string {
  return process.env.OMCP_TRACE_ROOT ?? join(process.cwd(), ".omcp", "state", "trace");
}

export function traceFile(sessionId: string, root?: string): string {
  // RC1-P0-1 fix: sessionId reaches path.join from MCP-client input; reject
  // path-separator-bearing values to close the traversal exploit RC1 reported.
  assertSafeSlug(sessionId, "sessionId");
  return join(root ?? traceRoot(), `${sessionId}.jsonl`);
}

export function loadTrace(sessionId: string, root?: string): TraceEvent[] {
  const p = traceFile(sessionId, root);
  if (!existsSync(p)) return [];
  const raw = readFileSync(p, "utf8");
  return raw
    .split(/\r?\n/)
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as TraceEvent);
}

export function appendTrace(sessionId: string, ev: TraceEvent, root?: string): void {
  const p = traceFile(sessionId, root);
  mkdirSync(dirname(p), { recursive: true });
  // DD8 Critic-A P0 fix: previous read-modify-write loses events under
  // concurrent appendTrace calls (Writer A and B both read N events, each
  // writes N+1, second write silently overwrites first). The trace file is
  // JSONL — use appendFileSync for OS-level atomic append. POSIX guarantees
  // atomicity for writes ≤ PIPE_BUF; on NTFS single-call writes are atomic
  // for small payloads (well under 4KB).
  appendFileSync(p, `${JSON.stringify(ev)}\n`);
}

export function traceAppend(
  sessionId: string,
  kind: string,
  data?: unknown,
): { ok: true } {
  appendTrace(sessionId, { t: new Date().toISOString(), kind, data });
  return { ok: true };
}

export function traceSummary(
  sessionId: string,
): { total: number; byKind: Record<string, number> } {
  const events = loadTrace(sessionId);
  const byKind: Record<string, number> = {};
  for (const e of events) byKind[e.kind] = (byKind[e.kind] ?? 0) + 1;
  return { total: events.length, byKind };
}

export function traceTimeline(sessionId: string, limit?: number): TraceEvent[] {
  const events = loadTrace(sessionId);
  const n = limit ?? 100;
  return events.slice(-n);
}
