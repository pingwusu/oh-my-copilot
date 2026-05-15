import { describe, it, expect } from "vitest";
import { mergeMcpServers, upsertOmcpPlugin } from "../runtime/copilot-config.js";

describe("upsertOmcpPlugin", () => {
  it("adds omcp entry to empty config", () => {
    const next = upsertOmcpPlugin({}, "0.1.0", "/tmp/cache");
    expect(next.installedPlugins).toHaveLength(1);
    expect(next.installedPlugins![0].name).toBe("oh-my-copilot");
    expect(next.installedPlugins![0].version).toBe("0.1.0");
    expect(next.enabledPlugins!["oh-my-copilot@oh-my-copilot"]).toBe(true);
  });

  it("replaces existing omcp entry without duplicating", () => {
    const before = {
      installedPlugins: [
        {
          name: "oh-my-copilot",
          marketplace: "oh-my-copilot",
          version: "0.0.9",
          installed_at: "2026-01-01T00:00:00.000Z",
          enabled: true,
          cache_path: "/old/path",
        },
      ],
    };
    const after = upsertOmcpPlugin(before, "0.1.0", "/new/path");
    expect(after.installedPlugins).toHaveLength(1);
    expect(after.installedPlugins![0].version).toBe("0.1.0");
    expect(after.installedPlugins![0].cache_path).toBe("/new/path");
  });

  it("preserves unrelated plugins", () => {
    const before = {
      installedPlugins: [
        {
          name: "ralph-wiggum",
          marketplace: "claude-code-plugins",
          version: "1.0.0",
          installed_at: "2026-01-01T00:00:00.000Z",
          enabled: true,
          cache_path: "/other",
        },
      ],
      enabledPlugins: { "ralph-wiggum@claude-code-plugins": true },
    };
    const after = upsertOmcpPlugin(before, "0.1.0", "/new");
    expect(after.installedPlugins).toHaveLength(2);
    expect(
      after.installedPlugins!.some((p) => p.name === "ralph-wiggum"),
    ).toBe(true);
    expect(after.enabledPlugins!["ralph-wiggum@claude-code-plugins"]).toBe(true);
  });
});

describe("mergeMcpServers", () => {
  it("substitutes ${PLUGIN_ROOT}", () => {
    const result = mergeMcpServers(
      {},
      "/plugin/root",
      {
        mcpServers: {
          "omcp-state": {
            command: "node",
            args: ["${PLUGIN_ROOT}/dist/mcp/state-server-main.js"],
          },
        },
      },
    );
    expect(result.mcpServers!["omcp-state"].args).toEqual([
      "/plugin/root/dist/mcp/state-server-main.js",
    ]);
  });

  it("preserves existing user mcp servers", () => {
    const result = mergeMcpServers(
      { mcpServers: { user_one: { command: "x" } } },
      "/p",
      { mcpServers: { "omcp-state": { command: "y", args: [] } } },
    );
    expect(result.mcpServers!.user_one).toEqual({ command: "x" });
    expect(result.mcpServers!["omcp-state"]).toBeDefined();
  });
});
