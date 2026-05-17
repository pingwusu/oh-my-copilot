// `omcp setup` — install or refresh the omcp plugin in ~/.copilot/.
//
// Steps:
//   1. resolve Copilot home + omcp paths
//   2. ensure target directories exist
//   3. mirror agents/, skills/, plugins/, .claude-plugin/, .mcp.json, prompts/,
//      templates/, AGENTS.md into the installed-plugins cache
//   4. upsert the marketplace file (~/.copilot/marketplaces/oh-my-copilot.json)
//   5. upsert the omcp entry in ~/.copilot/config.json
//   6. merge MCP servers into ~/.copilot/mcp-config.json with PLUGIN_ROOT substitution

import { cpSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  applyOmcpRuntimeWiring,
  type CopilotConfig,
  hasOmcpHookWiring,
  hasOmcpStatusLine,
  type McpConfig,
  mergeMcpServers,
  readJsonOrDefault,
  upsertOmcpPlugin,
  writeJson,
} from "../../runtime/copilot-config.js";
import { resolvePaths } from "../../runtime/paths.js";

// `force` is accepted for forward-compat with a future "fail if already
// installed" mode; today setup is always a refresh.

const SOURCE_ROOTS = [
  "agents",
  "skills",
  "prompts",
  "templates",
  "hooks",
  "dist",
  ".claude-plugin",
];

const SOURCE_FILES = [".mcp.json", "AGENTS.md", "CLAUDE.md", "README.md"];

export interface SetupOptions {
  force?: boolean;
  dryRun?: boolean;
  packageRoot: string;
}

export interface SetupReport {
  pluginInstalledAt: string;
  marketplaceAt: string;
  configUpdated: boolean;
  mcpUpdated: boolean;
  hooksWired: boolean;
  statusLineWired: boolean;
  dryRun: boolean;
}

export async function runSetup(opts: SetupOptions): Promise<SetupReport> {
  const paths = resolvePaths();
  const { packageRoot, dryRun } = opts;

  // Validate the plugin manifest parses (we read but do not consume fields here).
  JSON.parse(
    readFileSync(join(packageRoot, ".claude-plugin", "plugin.json"), "utf8"),
  );
  const pkg = JSON.parse(
    readFileSync(join(packageRoot, "package.json"), "utf8"),
  ) as { version: string };
  const version = pkg.version;

  if (!dryRun) {
    mkdirSync(paths.omcpPluginDir, { recursive: true });
    for (const root of SOURCE_ROOTS) {
      const src = join(packageRoot, root);
      if (!existsSync(src)) continue;
      cpSync(src, join(paths.omcpPluginDir, root), { recursive: true, force: true });
    }
    for (const file of SOURCE_FILES) {
      const src = join(packageRoot, file);
      if (!existsSync(src)) continue;
      cpSync(src, join(paths.omcpPluginDir, file), { force: true });
    }
  }

  const marketplace = {
    name: "oh-my-copilot",
    description: "oh-my-copilot plugin marketplace",
    owner: { name: "oh-my-copilot contributors" },
    plugins: [
      {
        name: "oh-my-copilot",
        description:
          "Multi-agent orchestration layer for GitHub Copilot CLI (Claude + GPT dual-model)",
        source: { type: "local", path: paths.omcpPluginDir },
        version,
      },
    ],
  };
  if (!dryRun) writeJson(paths.omcpMarketplaceFile, marketplace);

  const config = readJsonOrDefault<CopilotConfig>(paths.copilotConfig, {});
  const withPlugin = upsertOmcpPlugin(config, version, paths.omcpPluginDir);
  const nextConfig = applyOmcpRuntimeWiring(withPlugin);
  if (!dryRun) writeJson(paths.copilotConfig, nextConfig);
  const hooksWired = hasOmcpHookWiring(
    (nextConfig.hooks as Parameters<typeof hasOmcpHookWiring>[0]) ?? undefined,
  );
  const statusLineWired = hasOmcpStatusLine(
    (nextConfig.statusLine as Parameters<typeof hasOmcpStatusLine>[0]) ?? undefined,
  );

  let mcpUpdated = false;
  const pluginMcpPath = join(packageRoot, ".mcp.json");
  if (existsSync(pluginMcpPath)) {
    const pluginMcp = JSON.parse(readFileSync(pluginMcpPath, "utf8")) as McpConfig;
    const userMcp = readJsonOrDefault<McpConfig>(paths.copilotMcpConfig, {});
    const merged = mergeMcpServers(userMcp, paths.omcpPluginDir, pluginMcp);
    if (!dryRun) writeJson(paths.copilotMcpConfig, merged);
    mcpUpdated = true;
  }

  return {
    pluginInstalledAt: paths.omcpPluginDir,
    marketplaceAt: paths.omcpMarketplaceFile,
    configUpdated: true,
    mcpUpdated,
    hooksWired,
    statusLineWired,
    dryRun: Boolean(dryRun),
  };
}
