// Integration tests for the code-intel MCP server.
// Spawns the built server, sends JSON-RPC over stdio, asserts round-trip on
// 4 tools: tools/list, lsp_servers, lsp_document_symbols, ast_grep_search.
// Avoids tests that depend on tsc/ast-grep binaries being installed.

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
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
          // ignore non-JSON lines (e.g., banners or probe error messages)
        }
      }
    });
    this.child.stderr.on("data", () => {
      // swallow stderr in tests — ast-grep/grep probes write here
    });
  }

  async call(method: string, params?: unknown): Promise<unknown> {
    const id = this.nextId++;
    const req: JsonRpcReq = { jsonrpc: "2.0", id, method, params };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`timeout waiting for ${method}`));
      }, 30_000);
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
    return text;
  }
}

const SERVER = join(ROOT, "dist", "mcp", "code-intel-server.js");

describe("code-intel MCP server round-trip", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "omcp-code-intel-"));
  });
  afterEach(() => {
    // tmp dir cleanup is OS-driven; tests shouldn't leave large data
  });

  it("exposes the 9 original tools (now 18 total with DD9 + DD10 additions)", async () => {
    const client = new McpClient(SERVER, {});
    try {
      await client.initialize();
      const list = (await client.call("tools/list")) as ListResp;
      const names = list.result?.tools.map((t) => t.name) ?? [];
      expect(names).toEqual(
        expect.arrayContaining([
          "lsp_diagnostics",
          "lsp_diagnostics_directory",
          "lsp_document_symbols",
          "lsp_workspace_symbols",
          "lsp_hover",
          "lsp_find_references",
          "lsp_servers",
          "ast_grep_search",
          "ast_grep_replace",
        ]),
      );
      expect(names).toHaveLength(18);
    } finally {
      client.close();
    }
  });

  it("lsp_document_symbols extracts TS symbols from a file", async () => {
    const file = join(tmp, "sample.ts");
    writeFileSync(
      file,
      [
        "export function alpha() { return 1; }",
        "export class Beta {}",
        "export interface Gamma {}",
        "export const delta = 42;",
      ].join("\n"),
    );

    const client = new McpClient(SERVER, {});
    try {
      await client.initialize();
      const resp = (await client.call("tools/call", {
        name: "lsp_document_symbols",
        arguments: { file },
      })) as ToolResp;
      const out = parseToolJson(resp) as {
        symbolCount: number;
        symbols: Array<{ name: string; kind: string }>;
      };
      const names = out.symbols.map((s) => s.name);
      expect(names).toEqual(expect.arrayContaining(["alpha", "Beta", "Gamma", "delta"]));
      expect(out.symbolCount).toBeGreaterThanOrEqual(4);
    } finally {
      client.close();
    }
  });

  it("lsp_servers reports binary availability without crashing", async () => {
    const client = new McpClient(SERVER, {});
    try {
      await client.initialize();
      const resp = (await client.call("tools/call", {
        name: "lsp_servers",
        arguments: {},
      })) as ToolResp;
      const out = parseToolJson(resp) as {
        servers: Record<string, { available: boolean }>;
      };
      expect(out.servers).toHaveProperty("typescript");
      expect(out.servers).toHaveProperty("ast-grep");
      expect(out.servers).toHaveProperty("grep");
      // Each entry must have an `available` boolean regardless of platform.
      for (const key of Object.keys(out.servers)) {
        expect(typeof out.servers[key].available).toBe("boolean");
      }
    } finally {
      client.close();
    }
  }, 60_000);

  it("ast_grep_search returns structured result even if binary missing", async () => {
    const client = new McpClient(SERVER, {});
    try {
      await client.initialize();
      const resp = (await client.call("tools/call", {
        name: "ast_grep_search",
        arguments: {
          pattern: "function $NAME($$$ARGS)",
          language: "typescript",
          path: tmp,
        },
      })) as ToolResp;
      const out = parseToolJson(resp) as { matches: unknown[]; command: string };
      expect(Array.isArray(out.matches)).toBe(true);
      expect(typeof out.command).toBe("string");
    } finally {
      client.close();
    }
  }, 60_000);

  it("lsp_diagnostics returns empty diagnostics when no tsconfig is present", async () => {
    const file = join(tmp, "lone.ts");
    writeFileSync(file, "export const x = 1;\n");

    const client = new McpClient(SERVER, {});
    try {
      await client.initialize();
      const resp = (await client.call("tools/call", {
        name: "lsp_diagnostics",
        arguments: { file },
      })) as ToolResp;
      const out = parseToolJson(resp) as {
        diagnosticCount: number;
        diagnostics: unknown[];
        command: string;
      };
      // tmp dir has no tsconfig and no package.json, so runTscDiagnostics should
      // short-circuit with the "tsc skipped" sentinel.
      expect(out.diagnosticCount).toBe(0);
      expect(out.diagnostics).toEqual([]);
      expect(out.command).toMatch(/tsc skipped|npx tsc/);
    } finally {
      client.close();
    }
  }, 60_000);
});
