// `omcp setup` — install or refresh the omcp plugin in ~/.copilot/.
//
// Steps:
//   1. resolve Copilot home + omcp paths
//   2. ensure target directories exist
//   3. mirror agents/, skills/, plugins/, .claude-plugin/, .mcp.json, prompts/,
//      templates/, AGENTS.md into the installed-plugins cache
//   4. upsert the marketplace file (~/.copilot/marketplaces/oh-my-copilot.json)
//   5. upsert the omcp plugin entry + statusLine in ~/.copilot/config.json
//   6. write hook entries to ~/.copilot/settings.json (Copilot reads hooks from there)
//   7. merge MCP servers into ~/.copilot/mcp-config.json with PLUGIN_ROOT substitution

import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  applyOmcpConfigWiring,
  applyOmcpHookWiring,
  type CopilotConfig,
  type CopilotHooksMap,
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

// Source-of-truth for what omcp setup mirrors into ~/.copilot/installed-plugins/.
// Kept in sync with src/scripts/sync-plugin-mirror.ts:DIR_SOURCES; an invariant
// test in src/__tests__/cli-wiring-invariants.test.ts enforces parity so the
// two arrays can never silently desync again (DD3-A regression).
export const SOURCE_ROOTS = [
  "agents",
  "skills",
  "prompts",
  "templates",
  "hooks",
  "scripts",
  "dist",
  ".claude-plugin",
];

export const SOURCE_FILES = [
  ".mcp.json",
  "AGENTS.md",
  "CLAUDE.md",
  "README.md",
];

export interface SetupOptions {
  force?: boolean;
  dryRun?: boolean;
  packageRoot: string;
  /**
   * Skip the `npm install` step in the plugin install dir. Used by tests/CI
   * where running a real npm install would touch network or take time.
   * Production callers (the `omcp setup` CLI verb) should leave this false.
   */
  skipDepsInstall?: boolean;
}

export interface SetupReport {
  pluginInstalledAt: string;
  marketplaceAt: string;
  configUpdated: boolean;
  mcpUpdated: boolean;
  hooksWired: boolean;
  statusLineWired: boolean;
  dryRun: boolean;
  /** True when `npm install` actually ran (and succeeded) in the plugin dir. */
  depsInstalled: boolean;
  /** True when the npm install step was skipped (dryRun or skipDepsInstall). */
  depsInstallSkipped: boolean;
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
  ) as { version: string; dependencies?: Record<string, string> };
  const version = pkg.version;
  const sourceDependencies = pkg.dependencies ?? {};
  const skipDepsInstall = opts.skipDepsInstall ?? false;
  let depsInstalled = false;
  let depsInstallSkipped = Boolean(dryRun) || skipDepsInstall;

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

    // v1.5 fix: write a minimal runtime package.json so MCP servers can
    // resolve bare ESM specifiers (@modelcontextprotocol/sdk etc.) when
    // Copilot launches them from the plugin install dir. Then run
    // `npm install` to materialize node_modules at that path.
    //
    // We deliberately do NOT copy the source package.json verbatim — it
    // carries devDependencies, scripts (incl. postinstall), and bin
    // entries that have no business at the install path.
    const runtimePkg = {
      name: "oh-my-copilot-plugin-runtime",
      version,
      type: "module" as const,
      private: true,
      dependencies: sourceDependencies,
    };
    writeFileSync(
      join(paths.omcpPluginDir, "package.json"),
      `${JSON.stringify(runtimePkg, null, 2)}\n`,
      "utf8",
    );

    if (!skipDepsInstall) {
      const result = spawnSync(
        "npm",
        [
          "install",
          "--omit=dev",
          "--ignore-scripts",
          "--prefer-offline",
          "--no-audit",
          "--no-fund",
        ],
        {
          cwd: paths.omcpPluginDir,
          stdio: "inherit",
          shell: process.platform === "win32",
        },
      );
      if (result.error && (result.error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new Error(
          `npm not found on PATH. Install Node.js (https://nodejs.org) or run ` +
            `"npm install --omit=dev" manually in ${paths.omcpPluginDir}.`,
        );
      }
      if (result.status !== 0) {
        throw new Error(
          `npm install failed (exit ${result.status ?? "unknown"}) in ` +
            `${paths.omcpPluginDir}. Check network connectivity and that ` +
            `node_modules is writable. Re-run \`omcp setup\` after resolving.`,
        );
      }
      depsInstalled = true;
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

  // config.json: plugin registration + statusLine (no hooks — Copilot reads
  // hooks from settings.json per wire-probe-for-tui.mjs:31-35)
  const config = readJsonOrDefault<CopilotConfig>(paths.copilotConfig, {});
  const withPlugin = upsertOmcpPlugin(config, version, paths.omcpPluginDir);
  const nextConfig = applyOmcpConfigWiring(withPlugin);
  if (!dryRun) writeJson(paths.copilotConfig, nextConfig);

  // settings.json: hook entries only
  const settingsConfig = readJsonOrDefault<CopilotConfig>(paths.copilotSettings, {});
  const existingHooks = (settingsConfig.hooks as CopilotHooksMap | undefined) ?? undefined;
  const nextHooks = applyOmcpHookWiring(existingHooks);
  const nextSettings: CopilotConfig = { ...settingsConfig, hooks: nextHooks };
  if (!dryRun) writeJson(paths.copilotSettings, nextSettings);

  const hooksWired = hasOmcpHookWiring(nextHooks);
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
    depsInstalled,
    depsInstallSkipped,
  };
}
