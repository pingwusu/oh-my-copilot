// Round-trip test against the spawned omcp-wiki MCP server.
// Mirrors mcp-servers.test.ts / loop-server.test.ts.

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

describe("omcp-wiki MCP server", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "omcp-wiki-mcp-"));
  });
  afterEach(() => {
    // tmpdir cleanup is best-effort; OS cleans /tmp periodically.
  });

  it("exposes the 7 wiki tools and persists ingest/query/list/read/delete", async () => {
    const client = new McpClient(
      join(ROOT, "dist", "mcp", "wiki-server.js"),
      { OMCP_WIKI_ROOT: join(tmp, ".omcp") },
    );
    try {
      await client.initialize();

      const list = (await client.call("tools/list")) as ListResp;
      const names = list.result?.tools.map((t) => t.name) ?? [];
      expect(names).toEqual(
        expect.arrayContaining([
          "wiki_ingest",
          "wiki_query",
          "wiki_lint",
          "wiki_add",
          "wiki_list",
          "wiki_read",
          "wiki_delete",
        ]),
      );

      // Ingest a page.
      const ingest = (await client.call("tools/call", {
        name: "wiki_ingest",
        arguments: {
          title: "Auth Architecture",
          content: "JWT-based authentication flow.",
          tags: ["auth", "architecture"],
          category: "architecture",
        },
      })) as ToolResp;
      const ingestResult = parseToolJson(ingest) as {
        created: string[];
        updated: string[];
        totalAffected: number;
      };
      expect(ingestResult.created).toEqual(["auth-architecture.md"]);
      expect(ingestResult.totalAffected).toBe(1);

      // List sees the page.
      const listResp = (await client.call("tools/call", {
        name: "wiki_list",
        arguments: {},
      })) as ToolResp;
      const listResult = parseToolJson(listResp) as {
        count: number;
        pages: string[];
      };
      expect(listResult.count).toBe(1);
      expect(listResult.pages).toContain("auth-architecture.md");

      // Read the page.
      const read = (await client.call("tools/call", {
        name: "wiki_read",
        arguments: { page: "auth-architecture" },
      })) as ToolResp;
      const readResult = parseToolJson(read) as {
        ok: boolean;
        filename: string;
        frontmatter: { title: string; tags: string[] };
      };
      expect(readResult.ok).toBe(true);
      expect(readResult.frontmatter.title).toBe("Auth Architecture");
      expect(readResult.frontmatter.tags).toEqual(
        expect.arrayContaining(["auth", "architecture"]),
      );

      // Query finds it.
      const query = (await client.call("tools/call", {
        name: "wiki_query",
        arguments: { query: "authentication" },
      })) as ToolResp;
      const queryResult = parseToolJson(query) as Array<{ filename: string }>;
      expect(queryResult.length).toBeGreaterThanOrEqual(1);
      expect(queryResult[0].filename).toBe("auth-architecture.md");

      // Lint runs cleanly (1 page with no inbound links → 1 orphan, no errors).
      const lint = (await client.call("tools/call", {
        name: "wiki_lint",
        arguments: {},
      })) as ToolResp;
      const lintResult = parseToolJson(lint) as {
        stats: { totalPages: number };
      };
      expect(lintResult.stats.totalPages).toBe(1);

      // Delete the page.
      const del = (await client.call("tools/call", {
        name: "wiki_delete",
        arguments: { page: "auth-architecture" },
      })) as ToolResp;
      const delResult = parseToolJson(del) as { ok: boolean };
      expect(delResult.ok).toBe(true);

      // List is now empty.
      const list2 = (await client.call("tools/call", {
        name: "wiki_list",
        arguments: {},
      })) as ToolResp;
      const list2Result = parseToolJson(list2) as { count: number };
      expect(list2Result.count).toBe(0);
    } finally {
      client.close();
    }
  });

  it("wiki_add refuses to overwrite an existing page", async () => {
    const client = new McpClient(
      join(ROOT, "dist", "mcp", "wiki-server.js"),
      { OMCP_WIKI_ROOT: join(tmp, ".omcp") },
    );
    try {
      await client.initialize();
      const first = (await client.call("tools/call", {
        name: "wiki_add",
        arguments: { title: "Notes", content: "first" },
      })) as ToolResp;
      expect((parseToolJson(first) as { ok: boolean }).ok).toBe(true);

      const second = (await client.call("tools/call", {
        name: "wiki_add",
        arguments: { title: "Notes", content: "second" },
      })) as ToolResp;
      const r = parseToolJson(second) as { ok: boolean; error?: string };
      expect(r.ok).toBe(false);
      expect(r.error).toMatch(/already exists/);
    } finally {
      client.close();
    }
  });
});
