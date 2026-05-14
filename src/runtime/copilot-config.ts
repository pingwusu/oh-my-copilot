// Read/merge/write ~/.copilot/config.json and mcp-config.json safely.
// We never overwrite unrelated keys; we only add/refresh the omcp plugin entry.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export interface InstalledPlugin {
  name: string;
  marketplace: string;
  version: string;
  installed_at: string;
  enabled: boolean;
  cache_path: string;
}

export interface CopilotConfig {
  installedPlugins?: InstalledPlugin[];
  enabledPlugins?: Record<string, boolean>;
  [key: string]: unknown;
}

export function readJsonOrDefault<T>(path: string, fallback: T): T {
  if (!existsSync(path)) return fallback;
  const raw = readFileSync(path, "utf8");
  if (!raw.trim()) return fallback;
  return JSON.parse(raw) as T;
}

export function writeJson(path: string, data: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

export function upsertOmcpPlugin(
  config: CopilotConfig,
  version: string,
  cachePath: string,
): CopilotConfig {
  const next: CopilotConfig = { ...config };
  next.installedPlugins = (config.installedPlugins ?? []).filter(
    (p) => !(p.name === "oh-my-copilot" && p.marketplace === "oh-my-copilot"),
  );
  next.installedPlugins.push({
    name: "oh-my-copilot",
    marketplace: "oh-my-copilot",
    version,
    installed_at: new Date().toISOString(),
    enabled: true,
    cache_path: cachePath,
  });
  next.enabledPlugins = {
    ...(config.enabledPlugins ?? {}),
    "oh-my-copilot@oh-my-copilot": true,
  };
  return next;
}

export interface McpServerEntry {
  command?: string;
  args?: string[];
  description?: string;
  url?: string;
  type?: string;
}

export interface McpConfig {
  mcpServers?: Record<string, McpServerEntry>;
  [key: string]: unknown;
}

export function mergeMcpServers(
  user: McpConfig,
  pluginRoot: string,
  plugin: McpConfig,
): McpConfig {
  const next: McpConfig = { ...user, mcpServers: { ...(user.mcpServers ?? {}) } };
  for (const [name, entry] of Object.entries(plugin.mcpServers ?? {})) {
    const expanded: McpServerEntry = {
      ...entry,
      args: entry.args?.map((a) => a.replace("${PLUGIN_ROOT}", pluginRoot)),
    };
    next.mcpServers![name] = expanded;
  }
  return next;
}
