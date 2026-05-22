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
    // Minimal schema validation: required fields + enum constraints.
    const schema = tool.inputSchema as {
      required?: string[];
      properties?: Record<string, { type?: string; enum?: unknown[] }>;
    };
    if (schema.required) {
      for (const field of schema.required) {
        if (!(field in (args as Record<string, unknown>))) {
          return {
            isError: true,
            content: [{ type: "text", text: `missing required field: ${field}` }],
          };
        }
      }
    }
    if (schema.properties) {
      for (const [field, def] of Object.entries(schema.properties)) {
        if (def.enum && field in (args as Record<string, unknown>)) {
          const val = (args as Record<string, unknown>)[field];
          if (!def.enum.includes(val)) {
            return {
              isError: true,
              content: [{ type: "text", text: `invalid value for ${field}: expected one of ${JSON.stringify(def.enum)}` }],
            };
          }
        }
      }
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
