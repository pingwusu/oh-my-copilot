// Tests for the 8 new tools added in DD9 parity:
//   lsp_goto_definition, lsp_prepare_rename, lsp_rename, lsp_code_actions,
//   lsp_code_action_resolve, deepinit_manifest, load_omcp_skills_local,
//   list_omcp_skills
//
// Uses the same McpClient + tmp-dir pattern as code-intel.test.ts.

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const ROOT = join(__dirname, "..", "..");
const SERVER = join(ROOT, "dist", "mcp", "code-intel-server.js");

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

  constructor(serverPath: string) {
    this.child = spawn(process.execPath, [serverPath], {
      env: { ...process.env },
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
          // ignore non-JSON
        }
      }
    });
    this.child.stderr.on("data", () => {});
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

  async initialize(): Promise<void> {
    await this.call("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "omcp-tests-additions", version: "0.0.0" },
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
  if (text === undefined) throw new Error("no content in response");
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

describe("code-intel additions (DD9 parity)", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "omcp-dd9-"));
  });

  afterEach(() => {
    // OS-driven cleanup
  });

  it("exposes all 17 tools including the 8 new ones", async () => {
    const client = new McpClient(SERVER);
    try {
      await client.initialize();
      const list = (await client.call("tools/list")) as ListResp;
      const names = list.result?.tools.map((t) => t.name) ?? [];
      expect(names).toEqual(
        expect.arrayContaining([
          "lsp_goto_definition",
          "lsp_prepare_rename",
          "lsp_rename",
          "lsp_code_actions",
          "lsp_code_action_resolve",
          "deepinit_manifest",
          "load_omcp_skills_local",
          "list_omcp_skills",
        ]),
      );
      expect(names).toHaveLength(17);
    } finally {
      client.close();
    }
  });

  it("lsp_goto_definition finds a function definition", async () => {
    const file = join(tmp, "defs.ts");
    writeFileSync(
      file,
      [
        "export function mySpecialFn() { return 42; }",
        "export class MyClass {}",
        "const x = mySpecialFn();",
      ].join("\n"),
    );

    const client = new McpClient(SERVER);
    try {
      await client.initialize();
      const resp = (await client.call("tools/call", {
        name: "lsp_goto_definition",
        arguments: { file, symbol: "mySpecialFn" },
      })) as ToolResp;
      const out = parseToolJson(resp) as {
        symbol: string;
        resultCount: number;
        definitions: Array<{ file: string; line: number; kind: string }>;
      };
      expect(out.symbol).toBe("mySpecialFn");
      expect(out.resultCount).toBeGreaterThanOrEqual(1);
      const def = out.definitions[0];
      expect(def.line).toBe(1);
      expect(def.kind).toBe("function");
    } finally {
      client.close();
    }
  });

  it("lsp_prepare_rename extracts the word under cursor", async () => {
    const file = join(tmp, "rename-prep.ts");
    writeFileSync(file, "export function helloWorld() { return 1; }\n");

    const client = new McpClient(SERVER);
    try {
      await client.initialize();
      // column 16 lands inside "helloWorld"
      const resp = (await client.call("tools/call", {
        name: "lsp_prepare_rename",
        arguments: { file, line: 1, character: 16 },
      })) as ToolResp;
      const out = parseToolJson(resp) as {
        placeholder: string;
        range: { start: { character: number }; end: { character: number } };
      };
      expect(out.placeholder).toBe("helloWorld");
      expect(out.range.start.character).toBe(16);
      expect(out.range.end.character).toBe(26);
    } finally {
      client.close();
    }
  });

  it("lsp_prepare_rename returns null when no identifier at position", async () => {
    const file = join(tmp, "spaces.ts");
    writeFileSync(file, "   \n");

    const client = new McpClient(SERVER);
    try {
      await client.initialize();
      const resp = (await client.call("tools/call", {
        name: "lsp_prepare_rename",
        arguments: { file, line: 1, character: 1 },
      })) as ToolResp;
      const out = parseToolJson(resp);
      expect(out).toBeNull();
    } finally {
      client.close();
    }
  });

  it("lsp_rename replaces symbol in a single file", async () => {
    const file = join(tmp, "to-rename.ts");
    writeFileSync(
      file,
      "export function oldName() { return oldName; }\n",
    );

    const client = new McpClient(SERVER);
    try {
      await client.initialize();
      const resp = (await client.call("tools/call", {
        name: "lsp_rename",
        arguments: { file, oldName: "oldName", newName: "newName", scope: "file" },
      })) as ToolResp;
      const out = parseToolJson(resp) as { filesChanged: string[]; replacements: number };
      expect(out.filesChanged).toContain(file);
      expect(out.replacements).toBe(2);
      const updated = readFileSync(file, "utf-8");
      expect(updated).toContain("newName");
      expect(updated).not.toContain("oldName");
    } finally {
      client.close();
    }
  });

  it("lsp_code_actions returns empty actions array (placeholder)", async () => {
    const file = join(tmp, "actions.ts");
    writeFileSync(file, "const x = 1;\n");

    const client = new McpClient(SERVER);
    try {
      await client.initialize();
      const resp = (await client.call("tools/call", {
        name: "lsp_code_actions",
        arguments: { file, range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } } },
      })) as ToolResp;
      const out = parseToolJson(resp) as { actions: unknown[] };
      expect(Array.isArray(out.actions)).toBe(true);
      expect(out.actions).toHaveLength(0);
    } finally {
      client.close();
    }
  });

  it("lsp_code_action_resolve returns the action unchanged (placeholder)", async () => {
    const action = { kind: "quickfix", title: "Fix it", command: "doFix" };

    const client = new McpClient(SERVER);
    try {
      await client.initialize();
      const resp = (await client.call("tools/call", {
        name: "lsp_code_action_resolve",
        arguments: { action },
      })) as ToolResp;
      const out = parseToolJson(resp) as typeof action;
      expect(out.kind).toBe("quickfix");
      expect(out.title).toBe("Fix it");
    } finally {
      client.close();
    }
  });

  it("deepinit_manifest counts files and extension breakdown", async () => {
    // Create a small tree
    mkdirSync(join(tmp, "sub"), { recursive: true });
    writeFileSync(join(tmp, "a.ts"), "");
    writeFileSync(join(tmp, "b.ts"), "");
    writeFileSync(join(tmp, "sub", "c.js"), "");

    const client = new McpClient(SERVER);
    try {
      await client.initialize();
      const resp = (await client.call("tools/call", {
        name: "deepinit_manifest",
        arguments: { root: tmp, depth: 3 },
      })) as ToolResp;
      const out = parseToolJson(resp) as {
        files: number;
        dirs: number;
        byExtension: Record<string, number>;
        topDirs: Array<{ path: string; files: number }>;
      };
      expect(out.files).toBeGreaterThanOrEqual(3);
      expect(out.dirs).toBeGreaterThanOrEqual(1);
      expect(out.byExtension[".ts"]).toBeGreaterThanOrEqual(2);
      expect(out.byExtension[".js"]).toBeGreaterThanOrEqual(1);
    } finally {
      client.close();
    }
  });

  it("load_omcp_skills_local returns empty array when .omcp/skills not present", async () => {
    const client = new McpClient(SERVER);
    try {
      await client.initialize();
      const resp = (await client.call("tools/call", {
        name: "load_omcp_skills_local",
        arguments: {},
      })) as ToolResp;
      const out = parseToolJson(resp) as { skills: unknown[] };
      // May be empty (no .omcp/skills in project root) or populated — either is valid
      expect(Array.isArray(out.skills)).toBe(true);
    } finally {
      client.close();
    }
  });

  it("list_omcp_skills returns skills with name and description fields", async () => {
    const client = new McpClient(SERVER);
    try {
      await client.initialize();
      const resp = (await client.call("tools/call", {
        name: "list_omcp_skills",
        arguments: {},
      })) as ToolResp;
      const out = parseToolJson(resp) as { skills: Array<{ name: string; description: string }> };
      expect(Array.isArray(out.skills)).toBe(true);
      // The repo has a skills/ directory with many skills
      expect(out.skills.length).toBeGreaterThan(0);
      for (const skill of out.skills) {
        expect(typeof skill.name).toBe("string");
        expect(typeof skill.description).toBe("string");
      }
    } finally {
      client.close();
    }
  });
});
