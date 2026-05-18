// Round-trip test against the spawned omcp-hermes MCP server.
//
// Uses process.execPath as the child stub instead of real `copilot` so the
// test never needs the Copilot CLI installed. Forces detached mode (no tmux)
// for deterministic pid + log behavior on Windows + CI.

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";

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
  result?: { content?: Array<{ type: string; text: string }>; isError?: boolean };
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
    return text;
  }
}

describe("omcp-hermes MCP server", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "omcp-hermes-"));
  });

  // Stub child: node -e 'setTimeout(()=>{},50)' — exits quickly so the
  // "done" transition is observable without the test hanging.
  const stubEnv = (): NodeJS.ProcessEnv => ({
    OMCP_HERMES_ROOT: join(tmp, "hermes"),
    OMCP_HERMES_CHILD_CMD: process.execPath,
    OMCP_HERMES_CHILD_ARGS: JSON.stringify([
      "-e",
      "setTimeout(()=>{},50)",
    ]),
    OMCP_HERMES_FORCE_DETACHED: "1",
  });

  it("exposes the full tool surface", async () => {
    const client = new McpClient(
      join(ROOT, "dist", "mcp", "hermes-server.js"),
      stubEnv(),
    );
    try {
      await client.initialize();
      const list = (await client.call("tools/list")) as ListResp;
      const names = list.result?.tools.map((t) => t.name) ?? [];
      expect(names).toEqual(
        expect.arrayContaining([
          "hermes_start_session",
          "hermes_send_prompt",
          "hermes_read_status",
          "hermes_read_tail",
          "hermes_list_artifacts",
          "hermes_kill_session",
          "hermes_list_sessions",
        ]),
      );
    } finally {
      client.close();
    }
  });

  it("round-trips start_session -> read_status -> kill_session", async () => {
    const client = new McpClient(
      join(ROOT, "dist", "mcp", "hermes-server.js"),
      stubEnv(),
    );
    try {
      await client.initialize();

      const started = (await client.call("tools/call", {
        name: "hermes_start_session",
        arguments: {
          prompt: "hello world",
          sessionId: "test_round_trip",
        },
      })) as ToolResp;
      const meta = parseToolJson(started) as {
        sessionId: string;
        status: string;
        mode: string;
        pid?: number;
      };
      expect(meta.sessionId).toBe("test_round_trip");
      expect(meta.mode).toBe("detached");
      expect(meta.status).toBe("running");
      expect(typeof meta.pid).toBe("number");

      const status = (await client.call("tools/call", {
        name: "hermes_read_status",
        arguments: { sessionId: "test_round_trip" },
      })) as ToolResp;
      const statusJson = parseToolJson(status) as {
        sessionId: string;
        status: string;
      };
      expect(statusJson.sessionId).toBe("test_round_trip");
      expect(["running", "done"]).toContain(statusJson.status);

      const tail = (await client.call("tools/call", {
        name: "hermes_read_tail",
        arguments: { sessionId: "test_round_trip", lines: 10 },
      })) as ToolResp;
      const tailJson = parseToolJson(tail) as { lines: string[] };
      expect(Array.isArray(tailJson.lines)).toBe(true);

      const artifacts = (await client.call("tools/call", {
        name: "hermes_list_artifacts",
        arguments: { sessionId: "test_round_trip" },
      })) as ToolResp;
      const artJson = parseToolJson(artifacts) as {
        artifacts: Array<unknown>;
      };
      expect(Array.isArray(artJson.artifacts)).toBe(true);

      // Sessions list contains the one we just made.
      const sessions = (await client.call("tools/call", {
        name: "hermes_list_sessions",
        arguments: {},
      })) as ToolResp;
      const sessionsJson = parseToolJson(sessions) as {
        sessions: Array<{ sessionId: string }>;
      };
      expect(sessionsJson.sessions.map((s) => s.sessionId)).toContain(
        "test_round_trip",
      );

      // Kill returns ok if running, or "not running" if the stub already exited.
      const killed = (await client.call("tools/call", {
        name: "hermes_kill_session",
        arguments: { sessionId: "test_round_trip" },
      })) as ToolResp;
      const killJson = parseToolJson(killed) as {
        sessionId: string;
        killed: boolean;
      };
      expect(killJson.sessionId).toBe("test_round_trip");
      expect(typeof killJson.killed).toBe("boolean");
    } finally {
      client.close();
    }
  });

  it("send_prompt queues for a detached session", async () => {
    const client = new McpClient(
      join(ROOT, "dist", "mcp", "hermes-server.js"),
      stubEnv(),
    );
    try {
      await client.initialize();
      await client.call("tools/call", {
        name: "hermes_start_session",
        arguments: { prompt: "first turn", sessionId: "queue_target" },
      });
      const resp = (await client.call("tools/call", {
        name: "hermes_send_prompt",
        arguments: { sessionId: "queue_target", prompt: "next turn" },
      })) as ToolResp;
      const json = parseToolJson(resp) as {
        sessionId: string;
        delivered: boolean;
        via: string;
      };
      expect(json.sessionId).toBe("queue_target");
      expect(json.via).toBe("queue");
      expect(json.delivered).toBe(false);
    } finally {
      client.close();
    }
  });

  it("rejects unknown sessionId with an error response", async () => {
    const client = new McpClient(
      join(ROOT, "dist", "mcp", "hermes-server.js"),
      stubEnv(),
    );
    try {
      await client.initialize();
      const resp = (await client.call("tools/call", {
        name: "hermes_read_status",
        arguments: { sessionId: "does_not_exist" },
      })) as ToolResp;
      expect(resp.result?.isError).toBe(true);
    } finally {
      client.close();
    }
  });
});
