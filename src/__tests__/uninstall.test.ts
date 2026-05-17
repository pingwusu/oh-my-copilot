import {
  existsSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runSetup } from "../cli/commands/setup.js";
import { OMCP_MCP_SERVER_KEYS, runUninstall } from "../cli/commands/uninstall.js";

describe("runUninstall", () => {
  let tmp: string;
  let prevHome: string | undefined;
  const packageRoot = join(__dirname, "..", "..");

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "omcp-uninstall-"));
    prevHome = process.env.OMCP_HOME;
    process.env.OMCP_HOME = tmp;
  });

  afterEach(() => {
    if (prevHome === undefined) delete process.env.OMCP_HOME;
    else process.env.OMCP_HOME = prevHome;
  });

  it("removes plugin dir, marketplace, config entries, and omcp MCP servers", async () => {
    await runSetup({ packageRoot });

    // Sanity: plugin is installed.
    const pluginDir = join(tmp, "installed-plugins", "oh-my-copilot", "oh-my-copilot");
    expect(existsSync(pluginDir)).toBe(true);
    expect(existsSync(join(tmp, "marketplaces", "oh-my-copilot.json"))).toBe(true);

    const report = runUninstall();

    expect(report.dryRun).toBe(false);
    expect(report.pluginDirRemoved).toBe(true);
    expect(report.marketplaceRemoved).toBe(true);
    expect(report.configUpdated).toBe(true);
    expect(report.configPluginEntryRemoved).toBe(true);
    expect(report.configEnabledKeyRemoved).toBe(true);
    expect(report.mcpUpdated).toBe(true);

    // omcp MCP keys removed (subset — code-intel is in OMCP keys but may not
    // be in the merged config if .mcp.json didn't have it). Use intersection.
    const expectedKeys = OMCP_MCP_SERVER_KEYS.filter((k) =>
      report.mcpRemovedKeys.includes(k),
    );
    for (const k of ["omcp-state", "omcp-notepad", "omcp-trace", "omcp-project-memory", "omcp-loop"]) {
      expect(report.mcpRemovedKeys).toContain(k);
    }
    expect(expectedKeys.length).toBeGreaterThanOrEqual(5);

    // Disk state
    expect(existsSync(pluginDir)).toBe(false);
    expect(existsSync(join(tmp, "marketplaces", "oh-my-copilot.json"))).toBe(false);

    const config = JSON.parse(readFileSync(join(tmp, "config.json"), "utf8"));
    expect(
      (config.installedPlugins ?? []).some(
        (p: { name: string }) => p.name === "oh-my-copilot",
      ),
    ).toBe(false);
    expect(config.enabledPlugins?.["oh-my-copilot@oh-my-copilot"]).toBeUndefined();

    const mcp = JSON.parse(readFileSync(join(tmp, "mcp-config.json"), "utf8"));
    for (const k of OMCP_MCP_SERVER_KEYS) {
      expect(mcp.mcpServers[k]).toBeUndefined();
    }
  });

  it("preserves unrelated third-party plugin + MCP entries", async () => {
    await runSetup({ packageRoot });

    // Add an unrelated plugin entry + MCP server.
    const configPath = join(tmp, "config.json");
    const config = JSON.parse(readFileSync(configPath, "utf8"));
    config.installedPlugins.push({
      name: "third-party",
      marketplace: "tp-market",
      version: "9.9.9",
      installed_at: "2026-01-01T00:00:00.000Z",
      enabled: true,
      cache_path: "/elsewhere",
    });
    config.enabledPlugins["third-party@tp-market"] = true;
    writeFileSync(configPath, JSON.stringify(config, null, 2));

    const mcpPath = join(tmp, "mcp-config.json");
    const mcp = JSON.parse(readFileSync(mcpPath, "utf8"));
    mcp.mcpServers["third-party-server"] = {
      command: "node",
      args: ["/some/path.js"],
    };
    writeFileSync(mcpPath, JSON.stringify(mcp, null, 2));

    runUninstall();

    const afterConfig = JSON.parse(readFileSync(configPath, "utf8"));
    expect(afterConfig.installedPlugins).toHaveLength(1);
    expect(afterConfig.installedPlugins[0].name).toBe("third-party");
    expect(afterConfig.enabledPlugins["third-party@tp-market"]).toBe(true);

    const afterMcp = JSON.parse(readFileSync(mcpPath, "utf8"));
    expect(afterMcp.mcpServers["third-party-server"]).toBeDefined();
    expect(afterMcp.mcpServers["omcp-state"]).toBeUndefined();
  });

  it("dry-run leaves disk unchanged but reports planned removal", async () => {
    await runSetup({ packageRoot });
    const pluginDir = join(tmp, "installed-plugins", "oh-my-copilot", "oh-my-copilot");

    const report = runUninstall({ dryRun: true });
    expect(report.dryRun).toBe(true);
    expect(report.pluginDirRemoved).toBe(true);
    expect(report.mcpRemovedKeys.length).toBeGreaterThan(0);

    // Nothing actually removed.
    expect(existsSync(pluginDir)).toBe(true);
    expect(existsSync(join(tmp, "marketplaces", "oh-my-copilot.json"))).toBe(true);
    const config = JSON.parse(readFileSync(join(tmp, "config.json"), "utf8"));
    expect(
      (config.installedPlugins ?? []).some(
        (p: { name: string }) => p.name === "oh-my-copilot",
      ),
    ).toBe(true);
  });

  it("--purge removes ~/.copilot/.omcp-config.json", async () => {
    await runSetup({ packageRoot });
    const notifConfig = join(tmp, ".omcp-config.json");
    writeFileSync(notifConfig, JSON.stringify({ notifications: { enabled: true } }));

    const report = runUninstall({ purge: true });
    expect(report.notificationConfigRemoved).toBe(true);
    expect(existsSync(notifConfig)).toBe(false);
  });

  it("without --purge, notification config is left in place", async () => {
    await runSetup({ packageRoot });
    const notifConfig = join(tmp, ".omcp-config.json");
    writeFileSync(notifConfig, "{}");
    const report = runUninstall();
    expect(report.notificationConfigRemoved).toBe(false);
    expect(existsSync(notifConfig)).toBe(true);
  });

  it("is a no-op when nothing is installed", () => {
    const report = runUninstall();
    expect(report.pluginDirRemoved).toBe(false);
    expect(report.marketplaceRemoved).toBe(false);
    expect(report.configUpdated).toBe(false);
    expect(report.mcpUpdated).toBe(false);
  });
});
