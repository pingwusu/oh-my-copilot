// `omcp mcp-serve <server>` — convenience launcher for omcp's bundled MCP
// servers. Resolves the requested name to the right `dist/mcp/<name>.js` file
// and exec-replaces the current process so the parent MCP client sees a clean
// stdio chain (no extra fork sitting between).
//
// Only names with a real artifact under `dist/mcp/` are registered.

import { spawnSync } from "node:child_process";
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

// Exec the resolved server, replacing this process. We use spawn+stdio:inherit
// rather than Node's child_process.exec because Node doesn't expose POSIX
// execve; the parent omcp process exits as soon as the server is up.
export function runMcpServer(name: string, packageRoot: string): number {
  const resolved = resolveMcpServer(name, packageRoot);
  const r = spawnSync(process.execPath, [resolved.path], {
    stdio: "inherit",
    env: process.env,
  });
  return typeof r.status === "number" ? r.status : 1;
}
