// Deterministic canary-zero harness for the omcp MCP runtime shim.
//
// Spawns dist/mcp/state-server-main.js over stdio, sends JSON-RPC
// `initialize` + `tools/list`, and asserts the protocol invariants:
//   - result.protocolVersion present
//   - result.serverInfo.name === "omcp-state"
//   - result.capabilities.tools present
//   - tools/list returns a non-empty array
//
// Invariants cited:
//   I4 (valid events): no banned tokens may appear in the server name emitted
//       by the shim (serverInfo.name); the shim only ever echoes the `name`
//       field supplied by runMcpServer(), so this test implicitly checks it.
//
// US-1.8-T3-RUNTIME-shared-shim-det

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const ROOT = join(__dirname, "..", "..");
const SERVER_PATH = join(ROOT, "dist", "mcp", "state-server-main.js");

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

describe("mcp-runtime-shim deterministic (canary-zero)", () => {
  let client: McpClient;

  afterEach(() => {
    client?.close();
  });

  it("initialize returns protocolVersion, serverInfo.name, and capabilities.tools", async () => {
    client = new McpClient(SERVER_PATH);
    const resp = await client.initialize();

    expect(resp.error).toBeUndefined();
    const result = resp.result as {
      protocolVersion?: string;
      serverInfo?: { name?: string; version?: string };
      capabilities?: { tools?: unknown };
    };

    expect(result.protocolVersion).toBeDefined();
    // state-server-main.ts calls runMcpServer({ name: "omcp-state", ... })
    expect(result.serverInfo?.name).toBe("omcp-state");
    expect(result.capabilities?.tools).toBeDefined();
  });

  it("tools/list returns a non-empty array after initialize", async () => {
    client = new McpClient(SERVER_PATH);
    await client.initialize();

    const resp = await client.call("tools/list");
    expect(resp.error).toBeUndefined();

    const result = resp.result as { tools?: Array<{ name: string }> };
    expect(Array.isArray(result.tools)).toBe(true);
    expect((result.tools ?? []).length).toBeGreaterThan(0);
  });
});
