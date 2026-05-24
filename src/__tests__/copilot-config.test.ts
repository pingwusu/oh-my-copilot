import { describe, it, expect } from "vitest";
import {
  applyOmcpRuntimeWiring,
  EVENT_DEFAULT_TIMEOUTS,
  hasOmcpHookWiring,
  hasOmcpStatusLine,
  mergeCopilotHooks,
  mergeCopilotStatusLine,
  mergeMcpServers,
  OMCP_HOOK_EVENTS,
  upsertOmcpPlugin,
} from "../runtime/copilot-config.js";

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

describe("mergeCopilotHooks", () => {
  it("creates entries for all default omcp hook events", () => {
    // Pass an explicit omcpBin override so the command form is predictable in
    // tests (the real default emits `node "<abs>"` to bypass the npm shim layer
    // on Windows — see L1.1 / resolveHookCommandBin).
    const next = mergeCopilotHooks(undefined, { omcpBin: "omcp" });
    for (const event of OMCP_HOOK_EVENTS) {
      expect(next[event]).toBeDefined();
      expect(next[event]).toHaveLength(1);
      const matcher = next[event][0];
      expect(matcher.matcher).toBe("*");
      expect(matcher.hooks).toHaveLength(1);
      expect(matcher.hooks[0]).toMatchObject({
        type: "command",
        __omcp: true,
      });
      expect(matcher.hooks[0].command).toContain(`omcp hook fire ${event} --json`);
      // EVENT_DEFAULT_TIMEOUTS overrides the base 5s for Stop and PreCompact.
      const expectedTimeout = EVENT_DEFAULT_TIMEOUTS[event] ?? 5;
      expect(matcher.hooks[0].timeout).toBe(expectedTimeout);
    }
  });

  it("respects custom omcpBin and timeoutSec", () => {
    const next = mergeCopilotHooks(undefined, {
      omcpBin: "/usr/local/bin/omcp",
      timeoutSec: 10,
    });
    expect(next.PreToolUse[0].hooks[0].command).toBe(
      "/usr/local/bin/omcp hook fire PreToolUse --json",
    );
    expect(next.PreToolUse[0].hooks[0].timeout).toBe(10);
  });

  it("preserves user-authored hook entries (no __omcp marker)", () => {
    const existing = {
      PreToolUse: [
        {
          matcher: "Bash",
          hooks: [
            { type: "command" as const, command: "echo user-pre" },
          ],
        },
      ],
      UserPromptSubmit: [
        {
          matcher: "*",
          hooks: [
            { type: "command" as const, command: "echo user-submit" },
          ],
        },
      ],
    };
    const next = mergeCopilotHooks(existing);
    // user PreToolUse matcher preserved alongside omcp matcher
    const preMatchers = next.PreToolUse;
    expect(preMatchers).toHaveLength(2);
    expect(preMatchers[0].matcher).toBe("Bash");
    expect(preMatchers[0].hooks[0].command).toBe("echo user-pre");
    expect(preMatchers[1].hooks[0].__omcp).toBe(true);
    // Untouched non-omcp event survives.
    expect(next.UserPromptSubmit).toBeDefined();
    expect(next.UserPromptSubmit[0].hooks[0].command).toBe("echo user-submit");
  });

  it("is idempotent on repeated merges (refreshes omcp entries)", () => {
    const once = mergeCopilotHooks(undefined);
    const twice = mergeCopilotHooks(once);
    for (const event of OMCP_HOOK_EVENTS) {
      // Still exactly one matcher per event (no duplicates).
      const omcpMatchers = twice[event].filter((m) =>
        m.hooks.some((h) => h.__omcp === true),
      );
      expect(omcpMatchers).toHaveLength(1);
      expect(omcpMatchers[0].hooks).toHaveLength(1);
    }
  });

  it("drops empty matcher groups after stripping omcp hooks", () => {
    const existing = {
      PreToolUse: [
        {
          matcher: "*",
          hooks: [{ type: "command" as const, command: "old", __omcp: true }],
        },
      ],
    };
    const next = mergeCopilotHooks(existing);
    // Only the freshly-written omcp matcher remains; no stale empty group.
    expect(next.PreToolUse).toHaveLength(1);
    expect(next.PreToolUse[0].hooks[0].__omcp).toBe(true);
  });
});

describe("mergeCopilotStatusLine", () => {
  it("writes an omcp-managed statusLine when none exists", () => {
    const sl = mergeCopilotStatusLine(undefined);
    expect(sl).toMatchObject({
      type: "command",
      command: "omcp hud",
      __omcp: true,
    });
  });

  it("preserves a user-authored statusLine", () => {
    const userSl = {
      type: "command" as const,
      command: "my-custom-status",
      padding: 2,
    };
    const sl = mergeCopilotStatusLine(userSl);
    expect(sl).toBe(userSl);
    expect(sl.__omcp).toBeUndefined();
  });

  it("refreshes an existing omcp-managed statusLine", () => {
    const stale = {
      type: "command" as const,
      command: "old-omcp",
      __omcp: true,
    };
    const sl = mergeCopilotStatusLine(stale, { omcpBin: "omcp-next" });
    expect(sl.command).toBe("omcp-next hud");
    expect(sl.__omcp).toBe(true);
  });
});

describe("applyOmcpRuntimeWiring", () => {
  it("adds hooks + statusLine to a config without disturbing other fields", () => {
    const before = {
      installedPlugins: [
        {
          name: "x",
          marketplace: "y",
          version: "1",
          installed_at: "t",
          enabled: true,
          cache_path: "/p",
        },
      ],
      hooks: undefined,
    };
    const after = applyOmcpRuntimeWiring(before);
    expect(after.installedPlugins).toEqual(before.installedPlugins);
    expect(after.hooks).toBeDefined();
    expect(after.statusLine).toBeDefined();
    expect(hasOmcpHookWiring(after.hooks as never)).toBe(true);
    expect(hasOmcpStatusLine(after.statusLine as never)).toBe(true);
  });

  it("does not mutate the input config", () => {
    const before = { hooks: {}, statusLine: undefined };
    const snapshot = JSON.parse(JSON.stringify(before));
    applyOmcpRuntimeWiring(before);
    expect(before).toEqual(snapshot);
  });
});

describe("hasOmcpHookWiring / hasOmcpStatusLine", () => {
  it("returns false for undefined inputs", () => {
    expect(hasOmcpHookWiring(undefined)).toBe(false);
    expect(hasOmcpStatusLine(undefined)).toBe(false);
  });

  it("returns false when no __omcp marker is present", () => {
    const hooks = {
      PreToolUse: [
        {
          matcher: "*",
          hooks: [{ type: "command" as const, command: "user-only" }],
        },
      ],
    };
    expect(hasOmcpHookWiring(hooks)).toBe(false);
    expect(
      hasOmcpStatusLine({ type: "command", command: "user-only" }),
    ).toBe(false);
  });

  it("returns true when at least one __omcp entry is present", () => {
    const hooks = {
      PreToolUse: [
        {
          matcher: "*",
          hooks: [
            { type: "command" as const, command: "user" },
            { type: "command" as const, command: "omcp", __omcp: true },
          ],
        },
      ],
    };
    expect(hasOmcpHookWiring(hooks)).toBe(true);
    expect(
      hasOmcpStatusLine({ type: "command", command: "omcp hud", __omcp: true }),
    ).toBe(true);
  });
});
