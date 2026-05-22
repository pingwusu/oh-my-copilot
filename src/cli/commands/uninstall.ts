// `omcp uninstall` — reverse of `omcp setup`.
//
// Removes:
//   1. ~/.copilot/installed-plugins/oh-my-copilot/oh-my-copilot/   (plugin cache)
//   2. ~/.copilot/marketplaces/oh-my-copilot.json                  (marketplace)
//   3. omcp entries from ~/.copilot/config.json                    (config)
//      - installedPlugins[]   filtered
//      - enabledPlugins       key removed
//   4. omcp-* entries from ~/.copilot/mcp-config.json              (mcp)
//      Removes only the 5 omcp servers (state, notepad, trace,
//      project-memory, loop); any third-party MCP entries are preserved.
//
// --purge  also removes ~/.copilot/.omcp-config.json (notification config)
// --dry-run reports what would change without touching disk.
//
// Honors OMCP_HOME for test isolation (via resolvePaths).

import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
  type CopilotConfig,
  type McpConfig,
  readJsonOrDefault,
  writeJson,
} from "../../runtime/copilot-config.js";
import { resolvePaths } from "../../runtime/paths.js";

/** MCP server keys installed by `omcp setup` (from repo .mcp.json — 7 servers). */
export const OMCP_MCP_SERVER_KEYS = [
  "omcp-state",
  "omcp-notepad",
  "omcp-trace",
  "omcp-project-memory",
  "omcp-loop",
  "omcp-code-intel",
  "omcp-hermes",
  "omcp-wiki",
  "omcp-python-repl",
  "omcp-shared-memory",
] as const;

export interface UninstallOptions {
  purge?: boolean;
  dryRun?: boolean;
}

export interface UninstallReport {
  dryRun: boolean;
  pluginDirRemoved: boolean;
  pluginDirPath: string;
  marketplaceRemoved: boolean;
  marketplacePath: string;
  configUpdated: boolean;
  configPluginEntryRemoved: boolean;
  configEnabledKeyRemoved: boolean;
  mcpUpdated: boolean;
  mcpRemovedKeys: string[];
  notificationConfigRemoved: boolean;
  notificationConfigPath: string;
}

export function runUninstall(opts: UninstallOptions = {}): UninstallReport {
  const paths = resolvePaths();
  const dryRun = Boolean(opts.dryRun);

  // 1. plugin cache
  const pluginExists = existsSync(paths.omcpPluginDir);
  if (pluginExists && !dryRun) {
    rmSync(paths.omcpPluginDir, { recursive: true, force: true });
  }

  // 2. marketplace file
  const marketplaceExists = existsSync(paths.omcpMarketplaceFile);
  if (marketplaceExists && !dryRun) {
    rmSync(paths.omcpMarketplaceFile, { force: true });
  }

  // 3. config.json
  let configPluginEntryRemoved = false;
  let configEnabledKeyRemoved = false;
  let configUpdated = false;
  if (existsSync(paths.copilotConfig)) {
    const config = readJsonOrDefault<CopilotConfig>(paths.copilotConfig, {});
    const next: CopilotConfig = { ...config };
    const before = config.installedPlugins ?? [];
    const after = before.filter(
      (p) => !(p.name === "oh-my-copilot" && p.marketplace === "oh-my-copilot"),
    );
    if (after.length !== before.length) {
      configPluginEntryRemoved = true;
      next.installedPlugins = after;
    }
    if (config.enabledPlugins?.["oh-my-copilot@oh-my-copilot"] !== undefined) {
      const enabled = { ...(config.enabledPlugins ?? {}) };
      delete enabled["oh-my-copilot@oh-my-copilot"];
      next.enabledPlugins = enabled;
      configEnabledKeyRemoved = true;
    }
    if (configPluginEntryRemoved || configEnabledKeyRemoved) {
      configUpdated = true;
      if (!dryRun) writeJson(paths.copilotConfig, next);
    }
  }

  // 4. mcp-config.json
  const mcpRemovedKeys: string[] = [];
  let mcpUpdated = false;
  if (existsSync(paths.copilotMcpConfig)) {
    const mcp = readJsonOrDefault<McpConfig>(paths.copilotMcpConfig, {});
    if (mcp.mcpServers) {
      const nextServers = { ...mcp.mcpServers };
      for (const key of OMCP_MCP_SERVER_KEYS) {
        if (nextServers[key] !== undefined) {
          mcpRemovedKeys.push(key);
          delete nextServers[key];
        }
      }
      if (mcpRemovedKeys.length > 0) {
        mcpUpdated = true;
        const nextMcp: McpConfig = { ...mcp, mcpServers: nextServers };
        if (!dryRun) writeJson(paths.copilotMcpConfig, nextMcp);
      }
    }
  }

  // 5. notification config (--purge only)
  const notificationConfigPath = join(paths.copilotHome, ".omcp-config.json");
  const notificationExists = existsSync(notificationConfigPath);
  let notificationConfigRemoved = false;
  if (opts.purge && notificationExists) {
    if (!dryRun) rmSync(notificationConfigPath, { force: true });
    notificationConfigRemoved = true;
  }

  return {
    dryRun,
    pluginDirRemoved: pluginExists,
    pluginDirPath: paths.omcpPluginDir,
    marketplaceRemoved: marketplaceExists,
    marketplacePath: paths.omcpMarketplaceFile,
    configUpdated,
    configPluginEntryRemoved,
    configEnabledKeyRemoved,
    mcpUpdated,
    mcpRemovedKeys,
    notificationConfigRemoved,
    notificationConfigPath,
  };
}

export function formatUninstallReport(r: UninstallReport): string {
  const lines: string[] = [];
  lines.push(`omcp uninstall ${r.dryRun ? "(dry-run) " : ""}complete`);
  lines.push(
    `  plugin cache     -> ${r.pluginDirRemoved ? "removed" : "not present"} (${r.pluginDirPath})`,
  );
  lines.push(
    `  marketplace file -> ${r.marketplaceRemoved ? "removed" : "not present"} (${r.marketplacePath})`,
  );
  lines.push(
    `  config.json      -> ${
      r.configUpdated
        ? `updated (plugin=${r.configPluginEntryRemoved}, enabled=${r.configEnabledKeyRemoved})`
        : "no omcp entries found"
    }`,
  );
  lines.push(
    `  mcp-config.json  -> ${
      r.mcpUpdated ? `removed ${r.mcpRemovedKeys.join(", ")}` : "no omcp servers found"
    }`,
  );
  if (r.notificationConfigRemoved) {
    lines.push(`  --purge          -> removed ${r.notificationConfigPath}`);
  }
  return lines.join("\n");
}
