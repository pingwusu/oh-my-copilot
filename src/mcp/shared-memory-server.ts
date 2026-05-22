#!/usr/bin/env node
// omcp shared-memory MCP server — exposes shared_memory_write/read/list/
// delete/cleanup. Backed by .omcp/state/shared-memory/{key}.json files.

import { runMcpServer } from "./server-runtime.js";
import {
  writeSharedMemory,
  readSharedMemory,
  listSharedMemory,
  deleteSharedMemory,
  cleanupSharedMemory,
} from "../runtime/shared-memory.js";

runMcpServer({
  name: "omcp-shared-memory",
  version: "0.1.0",
  tools: [
    {
      name: "shared_memory_write",
      description:
        "Write a key-value pair to shared memory. Supports optional TTL for auto-expiry.",
      inputSchema: {
        type: "object",
        properties: {
          key: { type: "string" },
          value: {},
          ttl_ms: { type: "number" },
        },
        required: ["key", "value"],
      },
      handler: (args) =>
        writeSharedMemory(
          args.key as string,
          args.value,
          args.ttl_ms as number | undefined,
        ),
    },
    {
      name: "shared_memory_read",
      description:
        "Read a value from shared memory by key. Returns null if missing or expired.",
      inputSchema: {
        type: "object",
        properties: { key: { type: "string" } },
        required: ["key"],
      },
      handler: (args) => readSharedMemory(args.key as string),
    },
    {
      name: "shared_memory_list",
      description:
        "List active (non-expired) keys in shared memory.",
      inputSchema: { type: "object", properties: {} },
      handler: () => listSharedMemory(),
    },
    {
      name: "shared_memory_delete",
      description: "Delete a key from shared memory.",
      inputSchema: {
        type: "object",
        properties: { key: { type: "string" } },
        required: ["key"],
      },
      handler: (args) => deleteSharedMemory(args.key as string),
    },
    {
      name: "shared_memory_cleanup",
      description: "Remove all expired entries from shared memory.",
      inputSchema: { type: "object", properties: {} },
      handler: () => cleanupSharedMemory(),
    },
  ],
}).catch((err) => {
  console.error(err);
  process.exit(1);
});
