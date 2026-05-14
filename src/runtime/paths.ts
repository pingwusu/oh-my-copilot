// Resolved filesystem paths for omcp's interaction with the Copilot CLI install.
// All paths honor OMCP_HOME for testing isolation.

import { homedir } from "node:os";
import { join } from "node:path";

export interface OmcpPaths {
  copilotHome: string;
  copilotConfig: string;
  copilotMcpConfig: string;
  installedPlugins: string;
  marketplaces: string;
  omcpPluginDir: string;
  omcpMarketplaceFile: string;
}

export function resolvePaths(env: NodeJS.ProcessEnv = process.env): OmcpPaths {
  const copilotHome = env.OMCP_HOME ?? join(homedir(), ".copilot");
  return {
    copilotHome,
    copilotConfig: join(copilotHome, "config.json"),
    copilotMcpConfig: join(copilotHome, "mcp-config.json"),
    installedPlugins: join(copilotHome, "installed-plugins"),
    marketplaces: join(copilotHome, "marketplaces"),
    omcpPluginDir: join(
      copilotHome,
      "installed-plugins",
      "oh-my-copilot",
      "oh-my-copilot",
    ),
    omcpMarketplaceFile: join(copilotHome, "marketplaces", "oh-my-copilot.json"),
  };
}

export function packageRoot(scriptUrl: string): string {
  // src is dist/cli/omcp.js or src/cli/omcp.ts; package root is two levels up.
  const path = scriptUrl.replace(/^file:\/\//, "");
  const decoded = decodeURIComponent(
    path.startsWith("/") && /^\/[A-Za-z]:/.test(path) ? path.slice(1) : path,
  );
  return join(decoded, "..", "..", "..");
}
