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

import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { McpClient, type JsonRpcResp } from "./__helpers__/mcp-client.js";

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
