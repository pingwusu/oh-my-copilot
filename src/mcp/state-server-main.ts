#!/usr/bin/env node
// omcp state MCP server — exposes state_read/write/clear/list_active/get_status
// to Copilot sessions, backed by FileStateStore under .omcp/state/sessions/.

import { join } from "node:path";
import { runMcpServer } from "./server-runtime.js";
import { FileStateStore } from "./state-server.js";
import {
  clearModeState,
  listActiveModes,
  readModeState,
  writeModeState,
  type BaseModeState,
  type ModeName,
} from "../runtime/mode-state.js";
import { assertSafeSlug } from "../runtime/safe-slug.js";

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
    {
      name: "mode_write",
      description: "Persist mode state payload under .omcp/state/ (omc-compatible shape).",
      inputSchema: {
        type: "object",
        properties: {
          mode: { type: "string" },
          sessionId: { type: "string" },
          payload: { type: "object" },
        },
        required: ["mode", "payload"],
      },
      handler: (args) => {
        try {
          assertSafeSlug(args.mode, "mode");
          if (args.sessionId !== undefined) assertSafeSlug(args.sessionId, "sessionId");
        } catch (err) {
          return { isError: true, content: [{ type: "text", text: (err as Error).message }] };
        }
        const sid = typeof args.sessionId === "string" ? args.sessionId : undefined;
        writeModeState(args.mode as ModeName, args.payload as BaseModeState, sid);
        return { ok: true };
      },
    },
    {
      name: "mode_read",
      description: "Read mode state payload from .omcp/state/ (omc-compatible shape).",
      inputSchema: {
        type: "object",
        properties: {
          mode: { type: "string" },
          sessionId: { type: "string" },
        },
        required: ["mode"],
      },
      handler: (args) => {
        try {
          assertSafeSlug(args.mode, "mode");
          if (args.sessionId !== undefined) assertSafeSlug(args.sessionId, "sessionId");
        } catch (err) {
          return { isError: true, content: [{ type: "text", text: (err as Error).message }] };
        }
        const sid = typeof args.sessionId === "string" ? args.sessionId : undefined;
        return readModeState(args.mode as ModeName, sid);
      },
    },
    {
      name: "mode_clear",
      description: "Delete mode state file from .omcp/state/.",
      inputSchema: {
        type: "object",
        properties: {
          mode: { type: "string" },
          sessionId: { type: "string" },
        },
        required: ["mode"],
      },
      handler: (args) => {
        try {
          assertSafeSlug(args.mode, "mode");
          if (args.sessionId !== undefined) assertSafeSlug(args.sessionId, "sessionId");
        } catch (err) {
          return { isError: true, content: [{ type: "text", text: (err as Error).message }] };
        }
        const sid = typeof args.sessionId === "string" ? args.sessionId : undefined;
        clearModeState(args.mode as ModeName, sid);
        return { ok: true };
      },
    },
    {
      name: "mode_list_active",
      description: "Return ModeName[] where payload.active === true.",
      inputSchema: {
        type: "object",
        properties: {
          sessionId: { type: "string" },
        },
      },
      handler: (args) => {
        if (args.sessionId !== undefined) {
          try {
            assertSafeSlug(args.sessionId, "sessionId");
          } catch (err) {
            return { isError: true, content: [{ type: "text", text: (err as Error).message }] };
          }
        }
        const sid = typeof args.sessionId === "string" ? args.sessionId : undefined;
        return { modes: listActiveModes(sid) };
      },
    },
    {
      name: "mode_get_status",
      description: "Return brief status {active, phase?, iteration?, started_at} for a mode.",
      inputSchema: {
        type: "object",
        properties: {
          mode: { type: "string" },
          sessionId: { type: "string" },
        },
        required: ["mode"],
      },
      handler: (args) => {
        try {
          assertSafeSlug(args.mode, "mode");
          if (args.sessionId !== undefined) assertSafeSlug(args.sessionId, "sessionId");
        } catch (err) {
          return { isError: true, content: [{ type: "text", text: (err as Error).message }] };
        }
        const sid = typeof args.sessionId === "string" ? args.sessionId : undefined;
        const s = readModeState<BaseModeState & { phase?: string; iteration?: number }>(
          args.mode as ModeName,
          sid,
        );
        if (!s) return null;
        return {
          active: s.active,
          ...(s.phase !== undefined ? { phase: s.phase } : {}),
          ...(s.iteration !== undefined ? { iteration: s.iteration } : {}),
          ...(s.started_at !== undefined ? { started_at: s.started_at } : {}),
        };
      },
    },
  ],
}).catch((err) => {
  console.error(err);
  process.exit(1);
});
