import { mkdtempSync, readFileSync, existsSync, writeFileSync } from "node:fs";
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

    // Hooks land in settings.json (Copilot 1.0.48+ reads hooks from there).
    // statusLine stays in config.json.
    expect(report.hooksWired).toBe(true);
    expect(report.statusLineWired).toBe(true);
    const settings = JSON.parse(readFileSync(join(tmp, "settings.json"), "utf8"));
    expect(settings.hooks).toBeDefined();
    expect(settings.hooks.PreToolUse).toBeDefined();
    // L1.1: default command is now `node "<abs>" hook fire ...` form; match
    // the stable suffix present in both the absolute-node form and any
    // explicit omcpBin override.
    expect(settings.hooks.PreToolUse[0].hooks[0].command).toContain(
      "hook fire PreToolUse --json",
    );
    expect(settings.hooks.PreToolUse[0].hooks[0].__omcp).toBe(true);
    expect(config.hooks).toBeUndefined();
    expect(config.statusLine).toBeDefined();
    expect(config.statusLine.command).toBe("omcp hud");
    expect(config.statusLine.__omcp).toBe(true);
  });

  it("dry-run writes nothing", async () => {
    const packageRoot = join(__dirname, "..", "..");
    await runSetup({ packageRoot, dryRun: true });
    expect(existsSync(join(tmp, "config.json"))).toBe(false);
    expect(existsSync(join(tmp, "marketplaces", "oh-my-copilot.json"))).toBe(false);
  });

  it("re-running setup preserves user-authored hook entries", async () => {
    const packageRoot = join(__dirname, "..", "..");
    // 1. First setup writes omcp wiring to settings.json.
    await runSetup({ packageRoot });
    // 2. User edits settings.json to add a custom hook.
    const settingsPath = join(tmp, "settings.json");
    const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
    settings.hooks.PreToolUse.unshift({
      matcher: "Bash",
      hooks: [{ type: "command", command: "echo user-custom" }],
    });
    writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
    // 3. Re-run setup — user entry must survive.
    const report2 = await runSetup({ packageRoot });
    const settings2 = JSON.parse(readFileSync(settingsPath, "utf8"));
    expect(report2.hooksWired).toBe(true);
    const userMatcher = settings2.hooks.PreToolUse.find(
      (m: { matcher?: string }) => m.matcher === "Bash",
    );
    expect(userMatcher).toBeDefined();
    expect(userMatcher.hooks[0].command).toBe("echo user-custom");
    // Exactly one omcp-managed matcher.
    const omcpMatchers = settings2.hooks.PreToolUse.filter(
      (m: { hooks: { __omcp?: boolean }[] }) =>
        m.hooks.some((h) => h.__omcp === true),
    );
    expect(omcpMatchers).toHaveLength(1);
  });
});
