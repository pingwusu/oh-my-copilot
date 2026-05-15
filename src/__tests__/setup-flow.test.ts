import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runSetup } from "../cli/commands/setup.js";

describe("runSetup", () => {
  let tmp: string;
  let prevHome: string | undefined;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "omcp-setup-"));
    prevHome = process.env.OMCP_HOME;
    process.env.OMCP_HOME = tmp;
  });

  afterEach(() => {
    if (prevHome === undefined) delete process.env.OMCP_HOME;
    else process.env.OMCP_HOME = prevHome;
  });

  it("installs plugin, marketplace, config, and MCP merge", async () => {
    const packageRoot = join(__dirname, "..", "..");
    const report = await runSetup({ packageRoot });

    expect(report.dryRun).toBe(false);
    expect(report.pluginInstalledAt).toContain("oh-my-copilot");

    expect(existsSync(join(tmp, "installed-plugins", "oh-my-copilot", "oh-my-copilot", "agents", "executor.md"))).toBe(true);
    expect(existsSync(join(tmp, "installed-plugins", "oh-my-copilot", "oh-my-copilot", ".claude-plugin", "plugin.json"))).toBe(true);

    const marketplace = JSON.parse(
      readFileSync(join(tmp, "marketplaces", "oh-my-copilot.json"), "utf8"),
    );
    expect(marketplace.plugins[0].name).toBe("oh-my-copilot");

    const config = JSON.parse(readFileSync(join(tmp, "config.json"), "utf8"));
    expect(config.installedPlugins).toHaveLength(1);
    expect(config.installedPlugins[0].name).toBe("oh-my-copilot");
    expect(config.enabledPlugins["oh-my-copilot@oh-my-copilot"]).toBe(true);

    const mcp = JSON.parse(readFileSync(join(tmp, "mcp-config.json"), "utf8"));
    expect(mcp.mcpServers["omcp-state"]).toBeDefined();
    expect(mcp.mcpServers["omcp-state"].args[0]).toContain("dist/mcp/state-server-main.js");
    expect(mcp.mcpServers["omcp-state"].args[0]).not.toContain("${PLUGIN_ROOT}");
    expect(mcp.mcpServers["omcp-notepad"]).toBeDefined();
    expect(mcp.mcpServers["omcp-trace"]).toBeDefined();
    expect(mcp.mcpServers["omcp-project-memory"]).toBeDefined();
  });

  it("dry-run writes nothing", async () => {
    const packageRoot = join(__dirname, "..", "..");
    await runSetup({ packageRoot, dryRun: true });
    expect(existsSync(join(tmp, "config.json"))).toBe(false);
    expect(existsSync(join(tmp, "marketplaces", "oh-my-copilot.json"))).toBe(false);
  });
});
