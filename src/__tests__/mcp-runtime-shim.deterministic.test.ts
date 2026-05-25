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

import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { McpClient, type JsonRpcResp } from "./__helpers__/mcp-client.js";

const ROOT = join(__dirname, "..", "..");
const SERVER_PATH = join(ROOT, "dist", "mcp", "state-server-main.js");

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
