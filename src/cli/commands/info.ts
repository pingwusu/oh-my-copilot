// `omcp info` — diagnostic dump of catalog, MCP servers, env vars, paths.
// Complements `omcp doctor` (health checks) and `omcp status` (active modes).

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { resolvePaths } from "../../runtime/paths.js";

export interface InfoReport {
  version: string;
  packageRoot: string;
  installedPluginDir: string;
  installed: boolean;
  agentCount: number;
  skillCount: number;
  mcpServers: string[];
  hooksDir?: string;
  hookFiles: string[];
  envVars: Record<string, string | undefined>;
}

export function readInfo(packageRoot: string): InfoReport {
  const paths = resolvePaths();
  const pkgPath = join(packageRoot, "package.json");
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { version: string };

  const agentsDir = join(packageRoot, "agents");
  const skillsDir = join(packageRoot, "skills");
  const hooksDir = join(packageRoot, "hooks");

  const agentCount = existsSync(agentsDir)
    ? readdirSync(agentsDir).filter((f) => f.endsWith(".md")).length
    : 0;
  const skillCount = existsSync(skillsDir)
    ? readdirSync(skillsDir).filter((f) => {
        try {
          return statSync(join(skillsDir, f)).isDirectory();
        } catch {
          return false;
        }
      }).length
    : 0;

  const mcpServers: string[] = [];
  const mcpManifest = join(packageRoot, ".mcp.json");
  if (existsSync(mcpManifest)) {
    try {
      const m = JSON.parse(readFileSync(mcpManifest, "utf8")) as {
        mcpServers?: Record<string, unknown>;
      };
      mcpServers.push(...Object.keys(m.mcpServers ?? {}));
    } catch {
      // ignore
    }
  }

  const hookFiles = existsSync(hooksDir)
    ? readdirSync(hooksDir).filter((f) =>
        /\.(ts|js|mjs|cjs|sh|ps1)$/.test(f),
      )
    : [];

  const envVars: Record<string, string | undefined> = {
    OMCP_MODEL_FAMILY: process.env.OMCP_MODEL_FAMILY,
    OMCP_HOME: process.env.OMCP_HOME,
    DISABLE_OMCP: process.env.DISABLE_OMCP,
    OMCP_SKIP_HOOKS: process.env.OMCP_SKIP_HOOKS,
    OMCP_DEV: process.env.OMCP_DEV,
    OMCP_PLUGIN_ROOT: process.env.OMCP_PLUGIN_ROOT,
  };

  return {
    version: pkg.version,
    packageRoot,
    installedPluginDir: paths.omcpPluginDir,
    installed: existsSync(paths.omcpPluginDir),
    agentCount,
    skillCount,
    mcpServers,
    hooksDir,
    hookFiles,
    envVars,
  };
}

export function formatInfo(r: InfoReport): string {
  const lines: string[] = [];
  lines.push(`omcp info`);
  lines.push(`  version:           ${r.version}`);
  lines.push(`  package root:      ${r.packageRoot}`);
  lines.push(`  install path:      ${r.installedPluginDir}`);
  lines.push(`  installed:         ${r.installed ? "yes" : "no"}`);
  lines.push(`  agents:            ${r.agentCount}`);
  lines.push(`  skills:            ${r.skillCount}`);
  lines.push(
    `  mcp servers:       ${r.mcpServers.length > 0 ? r.mcpServers.join(", ") : "(none)"}`,
  );
  lines.push(
    `  hooks (${r.hookFiles.length}):       ${r.hookFiles.length > 0 ? r.hookFiles.join(", ") : "(none)"}`,
  );
  lines.push("  env:");
  for (const [k, v] of Object.entries(r.envVars)) {
    lines.push(`    ${k}=${v ?? "(unset)"}`);
  }
  return lines.join("\n");
}
