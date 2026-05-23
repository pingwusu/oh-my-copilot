// `omcp doctor` — diagnose the omcp install and surrounding Copilot CLI state.
// Runs a sequence of probes and prints a single-line verdict per check.

import { execSync } from "node:child_process";
import { copyFileSync, existsSync, readFileSync } from "node:fs";
import { atomicWriteFileSync } from "../../runtime/atomic-write.js";
import {
  type CopilotConfig,
  type CopilotHooksMap,
  hasOmcpHookWiring,
  hasOmcpStatusLine,
  readJsonOrDefault,
  writeJson,
} from "../../runtime/copilot-config.js";
import { resolvePaths } from "../../runtime/paths.js";
import { probeTeamModeState } from "./doctor-team-routing.js";

export type CheckLevel = "ok" | "warn" | "fail";

export interface CheckResult {
  name: string;
  level: CheckLevel;
  detail: string;
}

export function runDoctor(): CheckResult[] {
  const paths = resolvePaths();
  const checks: CheckResult[] = [];

  // 1. copilot CLI on PATH
  try {
    const v = execSync("copilot --version", { encoding: "utf8" }).trim();
    checks.push({ name: "copilot CLI", level: "ok", detail: v });
  } catch {
    checks.push({
      name: "copilot CLI",
      level: "fail",
      detail: "not found on PATH — install GitHub Copilot CLI 1.0.32+",
    });
  }

  // 2. ~/.copilot exists
  checks.push({
    name: "~/.copilot directory",
    level: existsSync(paths.copilotHome) ? "ok" : "fail",
    detail: paths.copilotHome,
  });

  // 3. plugin installed
  checks.push({
    name: "oh-my-copilot plugin cache",
    level: existsSync(paths.omcpPluginDir) ? "ok" : "warn",
    detail: existsSync(paths.omcpPluginDir)
      ? paths.omcpPluginDir
      : "not installed — run `omcp setup`",
  });

  // 4. plugin manifest readable
  const manifestPath = `${paths.omcpPluginDir}/.claude-plugin/plugin.json`;
  if (existsSync(manifestPath)) {
    try {
      const m = JSON.parse(readFileSync(manifestPath, "utf8")) as {
        version: string;
      };
      checks.push({
        name: "plugin manifest",
        level: "ok",
        detail: `version ${m.version}`,
      });
    } catch (err) {
      checks.push({
        name: "plugin manifest",
        level: "fail",
        detail: `parse error: ${(err as Error).message}`,
      });
    }
  } else {
    checks.push({
      name: "plugin manifest",
      level: "warn",
      detail: "not present (plugin not installed)",
    });
  }

  // 5. user mcp config
  checks.push({
    name: "mcp-config.json",
    level: existsSync(paths.copilotMcpConfig) ? "ok" : "warn",
    detail: existsSync(paths.copilotMcpConfig)
      ? paths.copilotMcpConfig
      : "not present — omcp's MCP servers will not be registered until `omcp setup` runs",
  });

  // 6. agents present in plugin cache
  const agentsDir = `${paths.omcpPluginDir}/agents`;
  checks.push({
    name: "agent catalog",
    level: existsSync(agentsDir) ? "ok" : "warn",
    detail: existsSync(agentsDir) ? agentsDir : "agents/ not yet mirrored",
  });

  // 7. Copilot CLI hook wiring — hooks live in settings.json (1.0.48+).
  // Also checks for stale omcp hooks in config.json and migrates them.
  try {
    // Check settings.json for current hook wiring
    const settings = readJsonOrDefault<CopilotConfig>(paths.copilotSettings, {});
    const hookWired = hasOmcpHookWiring(
      settings.hooks as Parameters<typeof hasOmcpHookWiring>[0],
    );
    checks.push({
      name: "hook wiring",
      level: hookWired ? "ok" : "warn",
      detail: hookWired
        ? "omcp hook entries present in settings.json"
        : "not wired — run `omcp setup` (see docs/architecture/hooks-wiring.md)",
    });

    // Check statusLine in config.json (it stays there)
    if (existsSync(paths.copilotConfig)) {
      const cfg = readJsonOrDefault<CopilotConfig>(paths.copilotConfig, {});
      const statusWired = hasOmcpStatusLine(
        cfg.statusLine as Parameters<typeof hasOmcpStatusLine>[0],
      );
      checks.push({
        name: "statusLine wiring",
        level: statusWired ? "ok" : "warn",
        detail: statusWired
          ? "omcp hud configured as statusLine.command"
          : "not wired — run `omcp setup` to enable `omcp hud` as statusLine",
      });

      // Migration: detect omcp-owned hooks in the old config.json location
      const cfgHooks = cfg.hooks as CopilotHooksMap | undefined;
      if (cfgHooks && hasOmcpHookWiring(cfgHooks)) {
        // Auto-migrate OMCP-owned hooks (identified by `omcp hook fire` command)
        // to settings.json. User-authored hooks are left in place with a warning.
        const backupPath = `${paths.copilotConfig}.pre-omcp-migration-backup`;
        copyFileSync(paths.copilotConfig, backupPath);

        // Separate omcp-owned from user-authored entries
        const migratedHooks: CopilotHooksMap = {};
        const remainingHooks: CopilotHooksMap = {};
        for (const [event, matchers] of Object.entries(cfgHooks)) {
          const omcpMatchers = (matchers ?? []).filter((m) =>
            m.hooks.some((h) => h.__omcp === true),
          );
          const userMatchers = (matchers ?? []).filter((m) =>
            m.hooks.some((h) => h.__omcp !== true),
          );
          if (omcpMatchers.length > 0) migratedHooks[event] = omcpMatchers;
          if (userMatchers.length > 0) remainingHooks[event] = userMatchers;
        }

        // Merge omcp hooks into settings.json
        const existingSettings = readJsonOrDefault<CopilotConfig>(paths.copilotSettings, {});
        const existingSettingsHooks = (existingSettings.hooks as CopilotHooksMap | undefined) ?? {};
        const mergedSettingsHooks: CopilotHooksMap = { ...existingSettingsHooks, ...migratedHooks };
        writeJson(paths.copilotSettings, { ...existingSettings, hooks: mergedSettingsHooks });

        // Remove omcp hooks from config.json; leave user hooks intact
        const nextCfg: CopilotConfig = { ...cfg };
        if (Object.keys(remainingHooks).length > 0) {
          nextCfg.hooks = remainingHooks;
        } else {
          delete nextCfg.hooks;
        }
        atomicWriteFileSync(paths.copilotConfig, `${JSON.stringify(nextCfg, null, 2)}\n`);

        checks.push({
          name: "hook migration",
          level: "ok",
          detail: `migrated omcp hooks from config.json → settings.json (backup: ${backupPath})`,
        });

        // Warn about any user-authored hooks left in config.json
        if (Object.keys(remainingHooks).length > 0) {
          checks.push({
            name: "hook migration (user hooks)",
            level: "warn",
            detail:
              "user-authored hooks remain in config.json — move them to settings.json manually for Copilot 1.0.48+ to fire them",
          });
        }
      }
    } else {
      checks.push({
        name: "statusLine wiring",
        level: "warn",
        detail: "config.json not present — run `omcp setup` to wire hooks",
      });
    }
  } catch (err) {
    checks.push({
      name: "hook wiring",
      level: "warn",
      detail: `unable to check hook wiring: ${(err as Error).message}`,
    });
  }

  // 8. team-routing sub-check (fast path) — only inspects mode-state on disk
  // so the base doctor stays exec-free. Run `omcp doctor team-routing` for the
  // full report with binary probes (copilot, tmux).
  try {
    for (const probe of probeTeamModeState()) {
      checks.push({
        name: `team: ${probe.name}`,
        level: probe.level,
        detail: probe.detail,
      });
    }
  } catch (err) {
    checks.push({
      name: "team: routing probe",
      level: "warn",
      detail: `unable to probe: ${(err as Error).message}`,
    });
  }

  return checks;
}

export function formatChecks(checks: CheckResult[]): string {
  return checks
    .map((c) => {
      const sym = c.level === "ok" ? "OK " : c.level === "warn" ? "WARN" : "FAIL";
      return `[${sym}] ${c.name.padEnd(28)} ${c.detail}`;
    })
    .join("\n");
}

export function exitCodeFor(checks: CheckResult[]): number {
  if (checks.some((c) => c.level === "fail")) return 2;
  if (checks.some((c) => c.level === "warn")) return 1;
  return 0;
}
