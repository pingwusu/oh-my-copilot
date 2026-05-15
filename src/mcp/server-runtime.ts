// Thin wrapper over @modelcontextprotocol/sdk to register a catalog of tools
// and connect over stdio. Each omcp MCP server is one file calling
// `runMcpServer({ name, version, tools })` and that's it.

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

export interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: (args: Record<string, unknown>) => Promise<unknown> | unknown;
}

export interface ServerSpec {
  name: string;
  version: string;
  tools: ToolDef[];
}

export async function runMcpServer(spec: ServerSpec): Promise<void> {
  const server = new Server(
    { name: spec.name, version: spec.version },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: spec.tools.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const args = request.params.arguments ?? {};
    const tool = spec.tools.find((t) => t.name === request.params.name);
    if (!tool) {
      return {
        isError: true,
        content: [{ type: "text", text: `unknown tool: ${request.params.name}` }],
      };
    }
    try {
      const result = await tool.handler(args as Record<string, unknown>);
      return {
        content: [
          { type: "text", text: typeof result === "string" ? result : JSON.stringify(result) },
        ],
      };
    } catch (err) {
      return {
        isError: true,
        content: [
          { type: "text", text: `error: ${(err as Error).message}` },
        ],
      };
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
}
