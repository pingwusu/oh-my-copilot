// Integration tests: spawn each MCP server, send JSON-RPC over stdio,
// assert round-trip.

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
          // ignore non-JSON lines (e.g., banner)
        }
      }
    });
    this.child.stderr.on("data", () => {
      // swallow stderr in tests
    });
  }

  async call(method: string, params?: unknown): Promise<unknown> {
    const id = this.nextId++;
    const req: JsonRpcReq = { jsonrpc: "2.0", id, method, params };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`timeout waiting for ${method}`));
      }, 25000);
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
  error?: { message: string };
}

interface ListResp {
  result?: { tools: Array<{ name: string }> };
}

function parseToolJson(resp: ToolResp): unknown {
  const text = resp.result?.content?.[0]?.text;
  if (text === undefined) throw new Error("no content");
  try {
    return JSON.parse(text);
  } catch {
    // Non-JSON text response — return as-is (e.g., state_read of a raw string value).
    return text;
  }
}

describe("MCP servers round-trip", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "omcp-mcp-"));
  });

  it("state server exposes 5 tools and round-trips a write/read/clear", async () => {
    const client = new McpClient(join(ROOT, "dist", "mcp", "state-server-main.js"), {
      OMCP_STATE_ROOT: join(tmp, "state"),
    });
    try {
      await client.initialize();
      const list = (await client.call("tools/list")) as ListResp;
      const names = list.result?.tools.map((t) => t.name) ?? [];
      expect(names).toEqual(
        expect.arrayContaining([
          "state_read",
          "state_write",
          "state_clear",
          "state_list_active",
          "state_get_status",
        ]),
      );

      await client.call("tools/call", {
        name: "state_write",
        arguments: { sessionId: "s1", key: "k", value: "v" },
      });
      const read = (await client.call("tools/call", {
        name: "state_read",
        arguments: { sessionId: "s1", key: "k" },
      })) as ToolResp;
      expect(parseToolJson(read)).toBe("v");

      const list_active = (await client.call("tools/call", {
        name: "state_list_active",
        arguments: {},
      })) as ToolResp;
      expect(parseToolJson(list_active)).toEqual({ sessions: ["s1"] });

      await client.call("tools/call", {
        name: "state_clear",
        arguments: { sessionId: "s1", key: "k" },
      });
      const afterClear = (await client.call("tools/call", {
        name: "state_read",
        arguments: { sessionId: "s1", key: "k" },
      })) as ToolResp;
      expect(parseToolJson(afterClear)).toBe(null);
    } finally {
      client.close();
    }
  });

  it("notepad server exposes 6 tools and persists writes", async () => {
    const client = new McpClient(join(ROOT, "dist", "mcp", "notepad-server.js"), {
      OMCP_NOTEPAD_PATH: join(tmp, "notepad.md"),
    });
    try {
      await client.initialize();
      const list = (await client.call("tools/list")) as ListResp;
      const names = list.result?.tools.map((t) => t.name) ?? [];
      expect(names).toEqual(
        expect.arrayContaining([
          "notepad_read",
          "notepad_write_priority",
          "notepad_write_working",
          "notepad_write_manual",
          "notepad_prune",
          "notepad_stats",
        ]),
      );

      await client.call("tools/call", {
        name: "notepad_write_priority",
        arguments: { text: "stop everything else" },
      });
      await client.call("tools/call", {
        name: "notepad_write_working",
        arguments: { text: "in progress" },
      });
      const stats = (await client.call("tools/call", {
        name: "notepad_stats",
        arguments: {},
      })) as ToolResp;
      expect(parseToolJson(stats)).toEqual({ priority: 1, working: 1, manual: 0 });
    } finally {
      client.close();
    }
  });

  it("trace server appends + summarizes events", async () => {
    const client = new McpClient(join(ROOT, "dist", "mcp", "trace-server.js"), {
      OMCP_TRACE_ROOT: join(tmp, "trace"),
    });
    try {
      await client.initialize();
      await client.call("tools/call", {
        name: "trace_append",
        arguments: { sessionId: "s1", kind: "hypothesis", data: { lane: 1 } },
      });
      await client.call("tools/call", {
        name: "trace_append",
        arguments: { sessionId: "s1", kind: "hypothesis", data: { lane: 2 } },
      });
      await client.call("tools/call", {
        name: "trace_append",
        arguments: { sessionId: "s1", kind: "evidence", data: { detail: "found" } },
      });
      const summary = (await client.call("tools/call", {
        name: "trace_summary",
        arguments: { sessionId: "s1" },
      })) as ToolResp;
      expect(parseToolJson(summary)).toEqual({
        total: 3,
        byKind: { hypothesis: 2, evidence: 1 },
      });

      const timeline = (await client.call("tools/call", {
        name: "trace_timeline",
        arguments: { sessionId: "s1", limit: 2 },
      })) as ToolResp;
      const events = parseToolJson(timeline) as Array<{ kind: string }>;
      expect(events).toHaveLength(2);
    } finally {
      client.close();
    }
  });

  it("project-memory server stores notes and directives", async () => {
    const client = new McpClient(
      join(ROOT, "dist", "mcp", "project-memory-server.js"),
      { OMCP_PROJECT_MEMORY: join(tmp, "pm.json") },
    );
    try {
      await client.initialize();
      await client.call("tools/call", {
        name: "project_memory_add_note",
        arguments: { text: "rebuild after merge" },
      });
      await client.call("tools/call", {
        name: "project_memory_add_directive",
        arguments: { text: "never commit .env" },
      });
      await client.call("tools/call", {
        name: "project_memory_write",
        arguments: { key: "config-version", value: 3 },
      });
      const read = (await client.call("tools/call", {
        name: "project_memory_read",
        arguments: {},
      })) as ToolResp;
      const pm = parseToolJson(read) as {
        notes: Array<{ text: string }>;
        directives: Array<{ text: string }>;
        data: Record<string, unknown>;
      };
      expect(pm.notes.map((n) => n.text)).toEqual(["rebuild after merge"]);
      expect(pm.directives.map((d) => d.text)).toEqual(["never commit .env"]);
      expect(pm.data["config-version"]).toBe(3);
    } finally {
      client.close();
    }
  });
});
