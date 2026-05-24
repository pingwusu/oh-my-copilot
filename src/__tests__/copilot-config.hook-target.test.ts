// Tests for the Phase 1 hook-target fix:
// - hooks write to settings.json (not config.json)
// - doctor detects and migrates misplaced hooks from config.json

import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolvePaths } from "../runtime/paths.js";
import { runSetup } from "../cli/commands/setup.js";
import { runDoctor } from "../cli/commands/doctor.js";
import { hasOmcpHookWiring } from "../runtime/copilot-config.js";

describe("Phase 1 hook-target fix", () => {
  let tmp: string;
  let prevHome: string | undefined;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "omcp-hook-target-"));
    prevHome = process.env.OMCP_HOME;
    process.env.OMCP_HOME = tmp;
  });

  afterEach(() => {
    if (prevHome === undefined) delete process.env.OMCP_HOME;
    else process.env.OMCP_HOME = prevHome;
  });

  it("T1: paths.copilotSettings resolves to a path ending with settings.json", () => {
    const paths = resolvePaths({ OMCP_HOME: tmp });
    expect(paths.copilotSettings).toMatch(/settings\.json$/);
    expect(paths.copilotSettings).toContain(tmp);
  });

  it("T2: setup writes hook entries to settings.json", async () => {
    const packageRoot = join(__dirname, "..", "..");
    await runSetup({ packageRoot });

    const settingsPath = join(tmp, "settings.json");
    expect(existsSync(settingsPath)).toBe(true);
    const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
    expect(settings.hooks).toBeDefined();
    expect(hasOmcpHookWiring(settings.hooks)).toBe(true);
    // Spot-check one well-known event
    expect(settings.hooks.PreToolUse).toBeDefined();
    const omcpEntry = settings.hooks.PreToolUse[0];
    // L1.1: default command is now `node "<abs>" hook fire ...` form; match
    // the stable suffix that is present in both the new absolute-node form and
    // any explicit omcpBin override.
    expect(omcpEntry.hooks[0].command).toContain("hook fire PreToolUse --json");
    expect(omcpEntry.hooks[0].__omcp).toBe(true);
  });

  it("T3: setup leaves config.json without hook entries", async () => {
    const packageRoot = join(__dirname, "..", "..");
    await runSetup({ packageRoot });

    const config = JSON.parse(readFileSync(join(tmp, "config.json"), "utf8"));
    // Plugin registration and statusLine are in config.json
    expect(config.installedPlugins).toBeDefined();
    expect(config.statusLine).toBeDefined();
    // Hooks must NOT be written to config.json
    expect(config.hooks).toBeUndefined();
  });

  it("T4: doctor detects misplaced omcp hooks in config.json and migrates them", () => {
    // Simulate the pre-fix state: omcp hooks written to config.json
    const staleConfig = {
      installedPlugins: [],
      hooks: {
        PreToolUse: [
          {
            matcher: "*",
            hooks: [
              {
                type: "command",
                command: "omcp hook fire PreToolUse --json",
                __omcp: true,
              },
            ],
          },
        ],
      },
      statusLine: { type: "command", command: "omcp hud", __omcp: true },
    };
    writeFileSync(join(tmp, "config.json"), JSON.stringify(staleConfig, null, 2));

    const checks = runDoctor();

    // Migration should have auto-moved the omcp hook to settings.json
    const migrationCheck = checks.find((c) => c.name === "hook migration");
    expect(migrationCheck).toBeDefined();
    expect(migrationCheck?.level).toBe("ok");
    expect(migrationCheck?.detail).toContain("settings.json");

    // settings.json should now have the hook
    const settingsPath = join(tmp, "settings.json");
    expect(existsSync(settingsPath)).toBe(true);
    const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
    expect(hasOmcpHookWiring(settings.hooks)).toBe(true);

    // config.json should no longer have the hooks key
    const cfg = JSON.parse(readFileSync(join(tmp, "config.json"), "utf8"));
    expect(cfg.hooks).toBeUndefined();

    // Backup must exist
    const backupPath = join(tmp, "config.json.pre-omcp-migration-backup");
    expect(existsSync(backupPath)).toBe(true);
  });

  it("T5: migration preserves user-authored hooks in config.json and warns", () => {
    // Mix of omcp-owned and user-authored hooks in config.json
    const staleConfig = {
      installedPlugins: [],
      hooks: {
        PreToolUse: [
          {
            matcher: "*",
            hooks: [
              {
                type: "command",
                command: "omcp hook fire PreToolUse --json",
                __omcp: true,
              },
            ],
          },
          {
            matcher: "Bash",
            hooks: [{ type: "command", command: "echo user-hook" }],
          },
        ],
      },
    };
    writeFileSync(join(tmp, "config.json"), JSON.stringify(staleConfig, null, 2));

    const checks = runDoctor();

    // Migration check should still be ok
    const migrationCheck = checks.find((c) => c.name === "hook migration");
    expect(migrationCheck?.level).toBe("ok");

    // Warning about user hooks left in config.json
    const userHookWarn = checks.find((c) => c.name === "hook migration (user hooks)");
    expect(userHookWarn).toBeDefined();
    expect(userHookWarn?.level).toBe("warn");

    // User hook must remain in config.json
    const cfg = JSON.parse(readFileSync(join(tmp, "config.json"), "utf8"));
    const userEntry = (cfg.hooks?.PreToolUse ?? []).find(
      (m: { matcher?: string }) => m.matcher === "Bash",
    );
    expect(userEntry).toBeDefined();
    expect(userEntry.hooks[0].command).toBe("echo user-hook");

    // omcp hook must NOT be in config.json
    const omcpEntry = (cfg.hooks?.PreToolUse ?? []).find(
      (m: { hooks: { __omcp?: boolean }[] }) => m.hooks.some((h) => h.__omcp === true),
    );
    expect(omcpEntry).toBeUndefined();

    // omcp hook must be in settings.json
    const settings = JSON.parse(readFileSync(join(tmp, "settings.json"), "utf8"));
    expect(hasOmcpHookWiring(settings.hooks)).toBe(true);
  });

  it("T6: applyOmcpHookWiring produces the correct hooks map shape", async () => {
    const { applyOmcpHookWiring, OMCP_HOOK_EVENTS } = await import(
      "../runtime/copilot-config.js"
    );
    const result = applyOmcpHookWiring(undefined);
    // All configured events must have at least one omcp-managed matcher
    for (const event of OMCP_HOOK_EVENTS) {
      expect(result[event]).toBeDefined();
      const omcpMatcher = result[event].find(
        (m: { hooks: { __omcp?: boolean }[] }) => m.hooks.some((h) => h.__omcp === true),
      );
      expect(omcpMatcher).toBeDefined();
    }
  });
});
