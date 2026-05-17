// Round-trip test against the spawned omcp-loop MCP server.

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const ROOT = join(__dirname, "..", "..");

interface JsonRpcReq {
  jsonrpc: "2.0";
  id: number;
  method: string;
  params?: unknown;
}

class McpClient {
  private child: ChildProcessWithoutNullStreams;
  private buf = "";
  private pending = new Map<number, (msg: unknown) => void>();
  private nextId = 1;

  constructor(serverPath: string, env: NodeJS.ProcessEnv) {
    this.child = spawn(process.execPath, [serverPath], {
      env: { ...process.env, ...env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child.stdout.on("data", (chunk) => {
      this.buf += chunk.toString("utf8");
      let nl: number;
      while ((nl = this.buf.indexOf("\n")) !== -1) {
        const line = this.buf.slice(0, nl).trim();
        this.buf = this.buf.slice(nl + 1);
        if (!line) continue;
        try {
          const msg = JSON.parse(line) as { id?: number };
          if (msg.id !== undefined) {
            const resolver = this.pending.get(msg.id);
            if (resolver) {
              this.pending.delete(msg.id);
              resolver(msg);
            }
          }
        } catch {
          // ignore
        }
      }
    });
    this.child.stderr.on("data", () => {
      // swallow
    });
  }

  async call(method: string, params?: unknown): Promise<unknown> {
    const id = this.nextId++;
    const req: JsonRpcReq = { jsonrpc: "2.0", id, method, params };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`timeout waiting for ${method}`));
      }, 5000);
      this.pending.set(id, (msg) => {
        clearTimeout(timer);
        resolve(msg);
      });
      this.child.stdin.write(JSON.stringify(req) + "\n");
    });
  }

  async initialize(): Promise<unknown> {
    return this.call("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "omcp-tests", version: "0.0.0" },
    });
  }

  close(): void {
    this.child.kill();
  }
}

interface ToolResp {
  result?: { content?: Array<{ type: string; text: string }> };
}

function parseToolJson(resp: ToolResp): unknown {
  const text = resp.result?.content?.[0]?.text;
  if (text === undefined) throw new Error("no content");
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

describe("omcp-loop MCP server", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "omcp-loop-"));
  });

  it("exposes 6 tools and round-trips schedule/list/cancel", async () => {
    const client = new McpClient(join(ROOT, "dist", "mcp", "loop-server.js"), {
      OMCP_LOOP_QUEUE: join(tmp, "loop-queue.json"),
    });
    try {
      await client.initialize();

      const list = (await client.call("tools/list")) as {
        result?: { tools: Array<{ name: string }> };
      };
      const names = list.result?.tools.map((t) => t.name) ?? [];
      expect(names).toEqual(
        expect.arrayContaining([
          "loop_schedule",
          "loop_list_pending",
          "loop_check_due",
          "loop_cancel",
          "loop_cancel_all",
          "loop_mark_fired",
        ]),
      );

      const sched = (await client.call("tools/call", {
        name: "loop_schedule",
        arguments: {
          taskId: "t1",
          intervalMs: 60000,
          prompt: "/oh-my-copilot:status",
        },
      })) as ToolResp;
      const schedResult = parseToolJson(sched) as {
        ok: boolean;
        entry: { taskId: string };
      };
      expect(schedResult.ok).toBe(true);
      expect(schedResult.entry.taskId).toBe("t1");

      const listed = (await client.call("tools/call", {
        name: "loop_list_pending",
        arguments: {},
      })) as ToolResp;
      const entries = parseToolJson(listed) as Array<{ taskId: string }>;
      expect(entries).toHaveLength(1);

      const cancel = (await client.call("tools/call", {
        name: "loop_cancel",
        arguments: { taskId: "t1" },
      })) as ToolResp;
      expect((parseToolJson(cancel) as { ok: boolean }).ok).toBe(true);

      const due = (await client.call("tools/call", {
        name: "loop_check_due",
        arguments: { now: new Date(Date.now() + 600000).toISOString() },
      })) as ToolResp;
      // After cancel, no entries should be due.
      expect((parseToolJson(due) as Array<unknown>).length).toBe(0);
    } finally {
      client.close();
    }
  });

  it("loop_check_due returns due entries; loop_mark_fired advances nextFireAt", async () => {
    const client = new McpClient(join(ROOT, "dist", "mcp", "loop-server.js"), {
      OMCP_LOOP_QUEUE: join(tmp, "loop-queue.json"),
    });
    try {
      await client.initialize();
      await client.call("tools/call", {
        name: "loop_schedule",
        arguments: { taskId: "tA", intervalMs: 10, prompt: "ping" },
      });
      // Wait > 10ms so it becomes due.
      await new Promise((r) => setTimeout(r, 30));
      const due = (await client.call("tools/call", {
        name: "loop_check_due",
        arguments: {},
      })) as ToolResp;
      const dueList = parseToolJson(due) as Array<{ taskId: string }>;
      expect(dueList.some((e) => e.taskId === "tA")).toBe(true);

      const fired = (await client.call("tools/call", {
        name: "loop_mark_fired",
        arguments: { taskId: "tA" },
      })) as ToolResp;
      const firedResult = parseToolJson(fired) as {
        ok: boolean;
        entry: { fireCount: number };
      };
      expect(firedResult.ok).toBe(true);
      expect(firedResult.entry.fireCount).toBe(1);
    } finally {
      client.close();
    }
  });

  it("loop_cancel_all marks all entries inactive", async () => {
    const client = new McpClient(join(ROOT, "dist", "mcp", "loop-server.js"), {
      OMCP_LOOP_QUEUE: join(tmp, "loop-queue.json"),
    });
    try {
      await client.initialize();
      for (const id of ["x", "y", "z"]) {
        await client.call("tools/call", {
          name: "loop_schedule",
          arguments: { taskId: id, intervalMs: 60000, prompt: "p" },
        });
      }
      const cancel = (await client.call("tools/call", {
        name: "loop_cancel_all",
        arguments: {},
      })) as ToolResp;
      const r = parseToolJson(cancel) as { ok: boolean; count: number };
      expect(r.ok).toBe(true);
      expect(r.count).toBe(3);

      const listed = (await client.call("tools/call", {
        name: "loop_list_pending",
        arguments: {},
      })) as ToolResp;
      const entries = parseToolJson(listed) as Array<{ active: boolean }>;
      expect(entries.every((e) => !e.active)).toBe(true);
    } finally {
      client.close();
    }
  });
});
