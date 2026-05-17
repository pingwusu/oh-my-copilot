#!/usr/bin/env node
// omcp hermes MCP server — exposes session-coordination tools for
// dispatching child Copilot sessions, monitoring their progress, and
// collecting artifacts.
//
// Tools:
//   hermes_start_session(prompt, sessionId?, agent?, model?)
//   hermes_send_prompt(sessionId, prompt)
//   hermes_read_status(sessionId)
//   hermes_read_tail(sessionId, lines?)
//   hermes_list_artifacts(sessionId)
//   hermes_kill_session(sessionId)
//   hermes_list_sessions()
//
// State lives under .omcp/state/hermes/<sessionId>/ (override via
// OMCP_HERMES_ROOT). tmux mode preferred when tmux is on PATH; otherwise
// falls back to detached `copilot` processes. For tests, set
// OMCP_HERMES_CHILD_CMD / OMCP_HERMES_CHILD_ARGS to substitute a stub.

import {
  killSession,
  listArtifacts,
  listSessions,
  readStatus,
  readTail,
  sendPrompt,
  startSession,
} from "./hermes-bridge.js";
import { runMcpServer } from "./server-runtime.js";

runMcpServer({
  name: "omcp-hermes",
  version: "0.1.0",
  tools: [
    {
      name: "hermes_start_session",
      description:
        "Spawn a new child Copilot session (tmux pane if available, else detached process) and return the assigned sessionId + spawn metadata.",
      inputSchema: {
        type: "object",
        properties: {
          prompt: { type: "string" },
          sessionId: { type: "string" },
          agent: { type: "string" },
          model: { type: "string" },
        },
        required: ["prompt"],
      },
      handler: (args) =>
        startSession({
          prompt: String(args.prompt ?? ""),
          sessionId: args.sessionId as string | undefined,
          agent: args.agent as string | undefined,
          model: args.model as string | undefined,
        }),
    },
    {
      name: "hermes_send_prompt",
      description:
        "Pipe a new turn to an existing session. tmux mode sends keys to the pane; detached mode appends to a per-session follow-up queue file.",
      inputSchema: {
        type: "object",
        properties: {
          sessionId: { type: "string" },
          prompt: { type: "string" },
        },
        required: ["sessionId", "prompt"],
      },
      handler: (args) =>
        sendPrompt({
          sessionId: String(args.sessionId ?? ""),
          prompt: String(args.prompt ?? ""),
        }),
    },
    {
      name: "hermes_read_status",
      description:
        "Return running/done/idle/killed status for a session, with mode + pid/tmux info.",
      inputSchema: {
        type: "object",
        properties: { sessionId: { type: "string" } },
        required: ["sessionId"],
      },
      handler: (args) => readStatus(String(args.sessionId ?? "")),
    },
    {
      name: "hermes_read_tail",
      description: "Return the last N lines of the session output log.",
      inputSchema: {
        type: "object",
        properties: {
          sessionId: { type: "string" },
          lines: { type: "number" },
        },
        required: ["sessionId"],
      },
      handler: (args) =>
        readTail(
          String(args.sessionId ?? ""),
          typeof args.lines === "number" ? args.lines : 80,
        ),
    },
    {
      name: "hermes_list_artifacts",
      description:
        "List files written under .omcp/state/hermes/<sessionId>/artifacts/.",
      inputSchema: {
        type: "object",
        properties: { sessionId: { type: "string" } },
        required: ["sessionId"],
      },
      handler: (args) => listArtifacts(String(args.sessionId ?? "")),
    },
    {
      name: "hermes_kill_session",
      description:
        "Terminate a running session — kills the tmux session or sends SIGTERM to the detached pid.",
      inputSchema: {
        type: "object",
        properties: { sessionId: { type: "string" } },
        required: ["sessionId"],
      },
      handler: (args) => killSession(String(args.sessionId ?? "")),
    },
    {
      name: "hermes_list_sessions",
      description:
        "List all known Hermes sessions (state directories under .omcp/state/hermes/) with current status.",
      inputSchema: { type: "object", properties: {} },
      handler: () => listSessions(),
    },
  ],
}).catch((err) => {
  console.error(err);
  process.exit(1);
});
