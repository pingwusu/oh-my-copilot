// `omcp trace <subcommand>` — CLI surface for the trace MCP tool.
// Mirrors omx's `omx trace` verbs (timeline, summary).
//
// Subcommands:
//   timeline <sessionId> [--limit=N]   Print most-recent N events (default 100).
//   summary  <sessionId>               Print per-kind event counts.
//
// Path isolation: set OMCP_TRACE_ROOT to override the default .omcp/state/trace/.

import { traceSummary, traceTimeline } from "../../runtime/trace.js";

export function runTraceCommand(args: string[]): void {
  const [sub, ...rest] = args;

  switch (sub) {
    case "timeline":
    case "trace_timeline": {
      const sessionId = rest.find((a) => !a.startsWith("--"));
      if (!sessionId) {
        console.error("omcp trace timeline: <sessionId> is required");
        process.exitCode = 2;
        return;
      }
      // parse optional --limit=N or --limit N
      let limit: number | undefined;
      for (let i = 0; i < rest.length; i++) {
        const a = rest[i];
        if (a.startsWith("--limit=")) {
          limit = Number(a.slice("--limit=".length));
        } else if (a === "--limit" && rest[i + 1] !== undefined) {
          limit = Number(rest[i + 1]);
        }
      }
      const events = traceTimeline(sessionId, limit);
      console.log(JSON.stringify(events, null, 2));
      return;
    }

    case "summary":
    case "trace_summary": {
      const sessionId = rest[0];
      if (!sessionId) {
        console.error("omcp trace summary: <sessionId> is required");
        process.exitCode = 2;
        return;
      }
      const r = traceSummary(sessionId);
      console.log(JSON.stringify(r, null, 2));
      return;
    }

    default: {
      console.log(
        [
          "Usage: omcp trace <subcommand> <sessionId> [options]",
          "",
          "Subcommands:",
          "  timeline <sessionId> [--limit=N]   Most-recent N trace events (default 100)",
          "  summary  <sessionId>               Per-kind event count",
        ].join("\n"),
      );
      if (sub && sub !== "--help" && sub !== "-h" && sub !== "help") {
        console.error(`\nomcp trace: unknown subcommand '${sub}'`);
        process.exitCode = 2;
      }
    }
  }
}
