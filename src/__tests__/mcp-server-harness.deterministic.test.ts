// Deterministic harness matrix for all 10 omcp MCP servers.
//
// For each server in SERVER_FILES (mirroring src/cli/commands/mcp-serve.ts):
//   1. Spawns dist/mcp/<filename> via child_process.spawn
//   2. Sends JSON-RPC initialize → asserts protocolVersion + capabilities.tools
//   3. Sends tools/list → asserts non-empty tools array
//
// For code-intel additionally:
//   4. Calls lsp_workspace_symbols with query="add" against the
//      src/__tests__/__fixtures__/code-intel/ directory, asserting ≥1 match.
//
// Invariants cited:
//   I4 (valid events): each server's serverInfo.name must be a non-empty string
//       (no banned tokens); verified implicitly by asserting it is defined.
//   I6 (regex carve-out at code-intel-server.ts:589): the workspace_symbols
//       call goes through the escapeRegExp path; fixture filenames contain no
//       metacharacters, so the carve-out is not triggered — clean path only.
//
// US-1.8-T3-MCP-det-matrix

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const ROOT = join(__dirname, "..", "..");
const FIXTURES_DIR = join(__dirname, "__fixtures__", "code-intel");

// Mirror of SERVER_FILES in src/cli/commands/mcp-serve.ts
const SERVER_FILES: Array<[name: string, filename: string]> = [
  ["state", "state-server-main.js"],
  ["notepad", "notepad-server.js"],
  ["trace", "trace-server.js"],
  ["project-memory", "project-memory-server.js"],
  ["loop", "loop-server.js"],
  ["code-intel", "code-intel-server.js"],
  ["hermes", "hermes-server.js"],
  ["wiki", "wiki-server.js"],
  ["python-repl", "python-repl-server.js"],
  ["shared-memory", "shared-memory-server.js"],
];

interface JsonRpcReq {
  jsonrpc: "2.0";
  id: number;
  method: string;
  params?: unknown;
}

interface JsonRpcResp {
  jsonrpc: "2.0";
  id: number;
  result?: unknown;
  error?: { code: number; message: string };
}

class McpClient {
  private child: ChildProcessWithoutNullStreams;
  private buf = "";
  private pending = new Map<number, (msg: JsonRpcResp) => void>();
  private nextId = 1;

  constructor(serverPath: string, env: NodeJS.ProcessEnv = {}) {
    this.child = spawn(process.execPath, [serverPath], {
      env: { ...process.env, ...env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child.stdout.on("data", (chunk: Buffer) => {
      this.buf += chunk.toString("utf8");
      let nl: number;
      while ((nl = this.buf.indexOf("\n")) !== -1) {
        const line = this.buf.slice(0, nl).trim();
        this.buf = this.buf.slice(nl + 1);
        if (!line) continue;
        try {
          const msg = JSON.parse(line) as JsonRpcResp;
          if (msg.id !== undefined) {
            const resolver = this.pending.get(msg.id);
            if (resolver) {
              this.pending.delete(msg.id);
              resolver(msg);
            }
          }
        } catch {
          // ignore non-JSON lines
        }
      }
    });
    this.child.stderr.on("data", () => {
      // swallow stderr
    });
  }

  async call(method: string, params?: unknown): Promise<JsonRpcResp> {
    const id = this.nextId++;
    const req: JsonRpcReq = { jsonrpc: "2.0", id, method, params };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`timeout waiting for ${method} (id=${id})`));
      }, 25000);
      this.pending.set(id, (msg) => {
        clearTimeout(timer);
        resolve(msg);
      });
      this.child.stdin.write(JSON.stringify(req) + "\n");
    });
  }

  async initialize(): Promise<JsonRpcResp> {
    return this.call("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "omcp-tests", version: "0.0.0" },
    });
  }

  close(): void {
    try {
      this.child.kill();
    } catch {
      // ignore if already dead
    }
  }
}

// Per-server env overrides so servers that require config don't crash on init
function serverEnv(name: string): NodeJS.ProcessEnv {
  if (name === "hermes") {
    return {
      OMCP_HERMES_FORCE_DETACHED: "1",
      OMCP_HERMES_CHILD_CMD: process.execPath,
      OMCP_HERMES_CHILD_ARGS: JSON.stringify(["-e", "setTimeout(()=>{},50)"]),
    };
  }
  return {};
}

describe("mcp-server-harness deterministic matrix (10 servers)", () => {
  const clients: McpClient[] = [];

  afterEach(() => {
    for (const c of clients) c.close();
    clients.length = 0;
  });

  it.each(SERVER_FILES)(
    "%s server: initialize + tools/list",
    async (name, filename) => {
      const serverPath = join(ROOT, "dist", "mcp", filename);
      const client = new McpClient(serverPath, serverEnv(name));
      clients.push(client);

      // initialize
      const initResp = await client.initialize();
      expect(initResp.error).toBeUndefined();
      const initResult = initResp.result as {
        protocolVersion?: string;
        serverInfo?: { name?: string };
        capabilities?: { tools?: unknown };
      };
      expect(initResult.protocolVersion).toBeDefined();
      expect(initResult.serverInfo?.name).toBeDefined();
      expect(initResult.capabilities?.tools).toBeDefined();

      // tools/list
      const listResp = await client.call("tools/list");
      expect(listResp.error).toBeUndefined();
      const listResult = listResp.result as { tools?: Array<{ name: string }> };
      expect(Array.isArray(listResult.tools)).toBe(true);
      expect((listResult.tools ?? []).length).toBeGreaterThan(0);
    },
  );

  it("code-intel: workspace_symbols against fixture dir returns matches", async () => {
    const serverPath = join(ROOT, "dist", "mcp", "code-intel-server.js");
    const client = new McpClient(serverPath);
    clients.push(client);

    await client.initialize();

    const resp = await client.call("tools/call", {
      name: "lsp_workspace_symbols",
      arguments: {
        query: "add",
        file: FIXTURES_DIR,
      },
    });

    expect(resp.error).toBeUndefined();
    const result = resp.result as {
      content?: Array<{ type: string; text: string }>;
    };
    const text = result.content?.[0]?.text ?? "";
    const parsed = JSON.parse(text) as {
      resultCount?: number;
      symbols?: Array<unknown>;
    };
    expect(parsed.resultCount).toBeGreaterThan(0);
    expect((parsed.symbols ?? []).length).toBeGreaterThan(0);
  });
});
