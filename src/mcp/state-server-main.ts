#!/usr/bin/env node
// omcp state MCP server — exposes state_read/write/clear/list_active/get_status
// to Copilot sessions, backed by FileStateStore under .omcp/state/sessions/.

import { join } from "node:path";
import { runMcpServer } from "./server-runtime.js";
import { FileStateStore } from "./state-server.js";

const ROOT = process.env.OMCP_STATE_ROOT ?? join(process.cwd(), ".omcp", "state", "sessions");
const store = new FileStateStore(ROOT);

runMcpServer({
  name: "omcp-state",
  version: "0.1.0",
  tools: [
    {
      name: "state_read",
      description: "Read a state value by session id and key.",
      inputSchema: {
        type: "object",
        properties: {
          sessionId: { type: "string" },
          key: { type: "string" },
        },
        required: ["sessionId", "key"],
      },
      handler: (args) =>
        store.read(args.sessionId as string, args.key as string) ?? null,
    },
    {
      name: "state_write",
      description: "Write a state value for a session/key pair.",
      inputSchema: {
        type: "object",
        properties: {
          sessionId: { type: "string" },
          key: { type: "string" },
          value: { type: "string" },
        },
        required: ["sessionId", "key", "value"],
      },
      handler: (args) => {
        store.write(args.sessionId as string, args.key as string, args.value as string);
        return { ok: true };
      },
    },
    {
      name: "state_clear",
      description: "Clear a state key (or entire session if key omitted).",
      inputSchema: {
        type: "object",
        properties: {
          sessionId: { type: "string" },
          key: { type: "string" },
        },
        required: ["sessionId"],
      },
      handler: (args) => {
        store.clear(args.sessionId as string, args.key as string | undefined);
        return { ok: true };
      },
    },
    {
      name: "state_list_active",
      description: "List session ids with at least one stored key.",
      inputSchema: { type: "object", properties: {} },
      handler: () => ({ sessions: store.list_active() }),
    },
    {
      name: "state_get_status",
      description: "Get keys + total size for a session.",
      inputSchema: {
        type: "object",
        properties: { sessionId: { type: "string" } },
        required: ["sessionId"],
      },
      handler: (args) => store.get_status(args.sessionId as string),
    },
  ],
}).catch((err) => {
  console.error(err);
  process.exit(1);
});
