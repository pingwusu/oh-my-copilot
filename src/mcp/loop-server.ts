#!/usr/bin/env node
// omcp loop MCP server — exposes scheduling tools that let a Copilot session
// register "wake me up in N seconds with this prompt" requests. A separate
// watcher process (scripts/omcp-loop-watcher.mjs) polls the queue and spawns
// `copilot -p` for any due entries.
//
// Tools:
//   loop_schedule(taskId, intervalMs, prompt, sessionId?)
//   loop_list_pending()
//   loop_check_due(now?)
//   loop_cancel(taskId)
//   loop_cancel_all()
//   loop_mark_fired(taskId)
//
// Backing store: .omcp/state/loop-queue.json — a flat JSON array of pending
// entries. Atomic write via rename. Watcher reads + spawns + writes the
// `last_fired_at` field, so the MCP server stays read-only-ish (it just
// appends/removes entries).

import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { runMcpServer } from "./server-runtime.js";

interface LoopEntry {
  taskId: string;
  prompt: string;
  intervalMs: number;
  sessionId?: string;
  createdAt: string;
  nextFireAt: string;
  lastFiredAt?: string;
  fireCount: number;
  active: boolean;
}

interface LoopQueue {
  entries: LoopEntry[];
}

const FILE =
  process.env.OMCP_LOOP_QUEUE ??
  join(process.cwd(), ".omcp", "state", "loop-queue.json");

function load(): LoopQueue {
  if (!existsSync(FILE)) return { entries: [] };
  try {
    return JSON.parse(readFileSync(FILE, "utf8")) as LoopQueue;
  } catch {
    return { entries: [] };
  }
}

function save(q: LoopQueue): void {
  mkdirSync(dirname(FILE), { recursive: true });
  const tmp = `${FILE}.tmp`;
  writeFileSync(tmp, JSON.stringify(q, null, 2));
  renameSync(tmp, FILE);
}

function upsert(entry: LoopEntry): void {
  const q = load();
  const idx = q.entries.findIndex((e) => e.taskId === entry.taskId);
  if (idx >= 0) q.entries[idx] = entry;
  else q.entries.push(entry);
  save(q);
}

runMcpServer({
  name: "omcp-loop",
  version: "0.1.0",
  tools: [
    {
      name: "loop_schedule",
      description:
        "Register a recurring task. The watcher will fire `copilot -p \"<prompt>\"` every <intervalMs> until cancelled.",
      inputSchema: {
        type: "object",
        properties: {
          taskId: { type: "string" },
          intervalMs: { type: "number" },
          prompt: { type: "string" },
          sessionId: { type: "string" },
        },
        required: ["taskId", "intervalMs", "prompt"],
      },
      handler: (args) => {
        const now = Date.now();
        const entry: LoopEntry = {
          taskId: args.taskId as string,
          prompt: args.prompt as string,
          intervalMs: args.intervalMs as number,
          sessionId: args.sessionId as string | undefined,
          createdAt: new Date(now).toISOString(),
          nextFireAt: new Date(now + (args.intervalMs as number)).toISOString(),
          fireCount: 0,
          active: true,
        };
        upsert(entry);
        return { ok: true, entry };
      },
    },
    {
      name: "loop_list_pending",
      description: "List all scheduled loop entries (active and inactive).",
      inputSchema: { type: "object", properties: {} },
      handler: () => load().entries,
    },
    {
      name: "loop_check_due",
      description:
        "Return the subset of entries whose nextFireAt <= now and active=true. Watcher uses this.",
      inputSchema: {
        type: "object",
        properties: { now: { type: "string" } },
      },
      handler: (args) => {
        const now = args.now ? new Date(args.now as string) : new Date();
        return load().entries.filter(
          (e) => e.active && new Date(e.nextFireAt) <= now,
        );
      },
    },
    {
      name: "loop_cancel",
      description: "Mark an entry as inactive by taskId.",
      inputSchema: {
        type: "object",
        properties: { taskId: { type: "string" } },
        required: ["taskId"],
      },
      handler: (args) => {
        const q = load();
        const e = q.entries.find((x) => x.taskId === args.taskId);
        if (!e) return { ok: false, reason: "not found" };
        e.active = false;
        save(q);
        return { ok: true };
      },
    },
    {
      name: "loop_cancel_all",
      description: "Mark all entries as inactive.",
      inputSchema: { type: "object", properties: {} },
      handler: () => {
        const q = load();
        for (const e of q.entries) e.active = false;
        save(q);
        return { ok: true, count: q.entries.length };
      },
    },
    {
      name: "loop_mark_fired",
      description:
        "Watcher calls this after a successful spawn. Advances nextFireAt by intervalMs.",
      inputSchema: {
        type: "object",
        properties: { taskId: { type: "string" } },
        required: ["taskId"],
      },
      handler: (args) => {
        const q = load();
        const e = q.entries.find((x) => x.taskId === args.taskId);
        if (!e) return { ok: false, reason: "not found" };
        const now = Date.now();
        e.lastFiredAt = new Date(now).toISOString();
        e.nextFireAt = new Date(now + e.intervalMs).toISOString();
        e.fireCount++;
        save(q);
        return { ok: true, entry: e };
      },
    },
  ],
}).catch((err) => {
  console.error(err);
  process.exit(1);
});
