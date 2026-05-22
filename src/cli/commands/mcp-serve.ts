// `omcp mcp-serve <server>` — convenience launcher for omcp's bundled MCP
// servers. Resolves the requested name to the right `dist/mcp/<name>.js` file.
// The CLI dispatcher in omcp.ts spawns the resolved path via spawn+stdio:inherit.
//
// Only names with a real artifact under `dist/mcp/` are registered.

import { existsSync } from "node:fs";
import { resolve } from "node:path";

// name → filename under dist/mcp/. The "state" server has a separate -main entry
// because state-server.ts exports library symbols (FileStateStore, etc.) and
// the stdio main lives in state-server-main.ts.
const SERVER_FILES: Record<string, string> = {
  state: "state-server-main.js",
  notepad: "notepad-server.js",
  trace: "trace-server.js",
  "project-memory": "project-memory-server.js",
  loop: "loop-server.js",
  "code-intel": "code-intel-server.js",
  hermes: "hermes-server.js",
  wiki: "wiki-server.js",
  "python-repl": "python-repl-server.js",
  "shared-memory": "shared-memory-server.js",
};

export interface ResolvedServer {
  name: string;
  path: string;
}

export function listMcpServers(packageRoot: string): string[] {
  const out: string[] = [];
  for (const name of Object.keys(SERVER_FILES)) {
    if (existsSync(resolve(packageRoot, "dist", "mcp", SERVER_FILES[name]))) {
      out.push(name);
    }
  }
  return out;
}

export function resolveMcpServer(
  name: string,
  packageRoot: string,
): ResolvedServer {
  const filename = SERVER_FILES[name];
  if (!filename) {
    const known = Object.keys(SERVER_FILES).sort().join(", ");
    throw new Error(`unknown mcp server "${name}". known: ${known}`);
  }
  const path = resolve(packageRoot, "dist", "mcp", filename);
  if (!existsSync(path)) {
    throw new Error(
      `mcp server "${name}" not built (expected ${path}). Run \`npm run build\`.`,
    );
  }
  return { name, path };
}
