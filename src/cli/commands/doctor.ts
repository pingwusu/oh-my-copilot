// `omcp doctor` — diagnose the omcp install and surrounding Copilot CLI state.
// Runs a sequence of probes and prints a single-line verdict per check.

import { execSync, spawnSync } from "node:child_process";
import {
  closeSync,
  copyFileSync,
  existsSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  statSync,
} from "node:fs";
import { join } from "node:path";
import { atomicWriteFileSync } from "../../runtime/atomic-write.js";
import {
  type CopilotConfig,
  type CopilotHooksMap,
  COPILOT_VALID_EVENTS,
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

  // 9. Hook delivery health — best-effort scan of the most recent Copilot
  // log for the upstream Windows pwsh dispatch bug pattern. See
  // docs/upstream-reports/copilot-pwsh-dispatch-v1.5-investigation.md.
  // When this probe lights up, the user's hook handlers ARE failing silently
  // upstream-side; the omcp install itself is correct.
  try {
    const logsDir = join(paths.copilotHome, "logs");
    const probe = probeHookDeliveryHealth(logsDir);
    checks.push({
      name: "hook delivery health",
      level: probe.level,
      detail: probe.detail,
    });
  } catch (err) {
    checks.push({
      name: "hook delivery health",
      level: "warn",
      detail: `unable to probe: ${(err as Error).message}`,
    });
  }

  // 10. MCP config integrity — parse ~/.copilot/mcp-config.json and check for
  // missing server script files, non-executable command paths, and malformed JSON.
  // US-1.9-T2-DOCTOR-check-mcp-config (Invariant 8: CLI registration).
  try {
    const probe = probeMcpConfigIntegrity(paths.copilotMcpConfig);
    checks.push({
      name: "mcp-config integrity",
      level: probe.level,
      detail: probe.detail,
    });
  } catch (err) {
    checks.push({
      name: "mcp-config integrity",
      level: "warn",
      detail: `unable to probe: ${(err as Error).message}`,
    });
  }

  // 11. Stale hook commands — detect entries in ~/.copilot/settings.json
  // that point to scripts that no longer exist on disk (the v1.4 RCA
  // scenario: scripts/omcp-hook-dispatch.cjs was deleted by L1.2 revert
  // but settings.json was never refreshed). v1.7 US-06 carry-forward
  // from v1.4 audit. Suggests `omcp setup` to refresh.
  try {
    const probe = probeStaleSettings(paths.copilotSettings);
    checks.push({
      name: "stale hook commands",
      level: probe.level,
      detail: probe.detail,
    });
  } catch (err) {
    checks.push({
      name: "stale hook commands",
      level: "warn",
      detail: `unable to probe: ${(err as Error).message}`,
    });
  }

  // 12. Settings drift — detect entries in ~/.copilot/settings.json referencing
  // missing scripts (broader than stale-settings: checks all hook commands, not
  // just __omcp-owned). US-1.9-T2-DOCTOR-check-settings-drift (Invariant 8).
  try {
    const probe = probeSettingsDrift(paths.copilotSettings);
    checks.push({
      name: "settings drift",
      level: probe.level,
      detail: probe.detail,
    });
  } catch (err) {
    checks.push({
      name: "settings drift",
      level: "warn",
      detail: `unable to probe: ${(err as Error).message}`,
    });
  }

  // 13. Hook registration — validate each registered hook event in settings.json
  // is in COPILOT_VALID_EVENTS, with special enforcement that `subagentStart`
  // is camelCase (Invariant 5). US-1.9-T2-DOCTOR-check-hook-registration.
  try {
    const probe = probeHookRegistration(paths.copilotSettings);
    checks.push({
      name: "hook registration",
      level: probe.level,
      detail: probe.detail,
    });
  } catch (err) {
    checks.push({
      name: "hook registration",
      level: "warn",
      detail: `unable to probe: ${(err as Error).message}`,
    });
  }

  // 14. Agent catalog count — verify all 19 agents/*.md are present in the
  // plugin cache. US-1.9-T2-DOCTOR-check-agent-catalog (Invariant 8).
  try {
    const probe = probeAgentCatalog(paths.omcpPluginDir);
    checks.push({
      name: "agent catalog (count)",
      level: probe.level,
      detail: probe.detail,
    });
  } catch (err) {
    checks.push({
      name: "agent catalog (count)",
      level: "warn",
      detail: `unable to probe: ${(err as Error).message}`,
    });
  }

  // 15. Plugin install mirror — run sync-plugin-mirror --check to detect drift.
  // US-1.9-T2-DOCTOR-check-plugin-install (Invariant 8).
  try {
    const probe = probePluginInstall();
    checks.push({
      name: "plugin mirror",
      level: probe.level,
      detail: probe.detail,
    });
  } catch (err) {
    checks.push({
      name: "plugin mirror",
      level: "warn",
      detail: `unable to probe: ${(err as Error).message}`,
    });
  }

  // 16. Copilot auth — spawn `copilot -p "echo test"` and assert exit 0.
  // US-1.9-T2-DOCTOR-check-copilot-auth (Invariant 8).
  try {
    const probe = probeCopilotAuth();
    checks.push({
      name: "copilot auth",
      level: probe.level,
      detail: probe.detail,
    });
  } catch (err) {
    checks.push({
      name: "copilot auth",
      level: "warn",
      detail: `unable to probe: ${(err as Error).message}`,
    });
  }

  // 17. Verify-spawn shape — spawn `copilot -p "echo verify-spawn-check"` and
  // assert exit 0 + a recognizable model-id token (`gpt-` or `claude-`) appears
  // in stdout. Gates `omcp team-verify` readiness — if Copilot CLI renames
  // `--allow-all-tools` or changes `-p` stdin semantics, the verify-worker
  // spawn would silently no-op. US-omcp-parity-P1-DOCTOR-verify-spawn-shape
  // (Invariants 8 + 4).
  try {
    const probe = probeVerifySpawnShape();
    checks.push({
      name: "verify-spawn shape",
      level: probe.level,
      detail: probe.detail,
    });
  } catch (err) {
    checks.push({
      name: "verify-spawn shape",
      level: "warn",
      detail: `unable to probe: ${(err as Error).message}`,
    });
  }

  return checks;
}

/**
 * Maximum number of bytes read from the tail of each Copilot log file.
 * Hook errors are appended at runtime so the most recent failures live
 * at the end. A 512 KB window covers ~5000 typical error stack frames
 * — more than enough to surface the upstream pattern — without OOM
 * risk on multi-MB session logs.
 */
const LOG_TAIL_BYTES = 512 * 1024;

/**
 * Scan the most recent Copilot log file for the upstream Windows pwsh
 * dispatch bug signature (eval_stdin SyntaxError). Returns a doctor check
 * result; never throws (best-effort).
 *
 * Reads only the last LOG_TAIL_BYTES of the file so a multi-MB log
 * doesn't block doctor for seconds or risk OOM. The bug signature
 * repeats throughout long sessions, so the tail is sufficient.
 */
export function probeHookDeliveryHealth(
  logsDir: string,
): { level: CheckLevel; detail: string } {
  if (!existsSync(logsDir)) {
    return { level: "ok", detail: "no Copilot logs directory yet" };
  }
  const files = readdirSync(logsDir).filter(
    (f) => f.startsWith("process-") && f.endsWith(".log"),
  );
  if (files.length === 0) {
    return { level: "ok", detail: "no Copilot log files yet" };
  }
  const stats = files.map((f) => ({
    f,
    mtime: statSync(join(logsDir, f)).mtimeMs,
  }));
  stats.sort((a, b) => b.mtime - a.mtime);
  const latest = stats[0].f;
  const content = readLogTail(join(logsDir, latest));
  return analyzeHookDeliveryFromLog(content, latest);
}

/**
 * Read the final LOG_TAIL_BYTES of a file as UTF-8. For files smaller
 * than the window, returns the entire content. Exported for testing.
 */
export function readLogTail(filePath: string): string {
  const stat = statSync(filePath);
  if (stat.size <= LOG_TAIL_BYTES) {
    return readFileSync(filePath, "utf8");
  }
  const fd = openSync(filePath, "r");
  try {
    const buf = Buffer.alloc(LOG_TAIL_BYTES);
    readSync(fd, buf, 0, LOG_TAIL_BYTES, stat.size - LOG_TAIL_BYTES);
    return buf.toString("utf8");
  } finally {
    closeSync(fd);
  }
}

/**
 * Scan ~/.copilot/settings.json for omcp-owned hook entries that
 * reference script files that no longer exist on disk.
 *
 * v1.7 US-06 carry-forward from v1.4 RCA: the L1.2 wrapper-script
 * revert (commit c7cbc21) deleted scripts/omcp-hook-dispatch.cjs but
 * never refreshed ~/.copilot/settings.json. All 13 hook entries kept
 * pointing to the deleted file. The L3.6 smoke surfaced "3/3 Stop
 * handlers exit code 1" as a symptom. This probe catches the same
 * shape BEFORE runtime so the user can `omcp setup` to refresh.
 *
 * Returns ok if settings.json absent (nothing to check) or all paths
 * resolve. Returns warn if any omcp-owned hook command references a
 * missing script.
 */
export function probeStaleSettings(
  settingsPath: string,
): { level: CheckLevel; detail: string } {
  if (!existsSync(settingsPath)) {
    return { level: "ok", detail: "no settings.json yet" };
  }
  return analyzeStaleSettingsFromJson(
    readFileSync(settingsPath, "utf8"),
    settingsPath,
  );
}

/**
 * Pure analyzer for ~/.copilot/settings.json content. Exported for
 * testing. Scans hook entries marked `__omcp: true`, extracts the
 * script path from each `command` string (regex `node "<path>"`), and
 * checks `existsSync(scriptPath)`.
 */
export function analyzeStaleSettingsFromJson(
  jsonContent: string,
  settingsPath: string,
): { level: CheckLevel; detail: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonContent);
  } catch {
    return {
      level: "warn",
      detail: `settings.json at ${settingsPath} is not valid JSON; run \`omcp setup\` to rewrite.`,
    };
  }
  const root = parsed as { hooks?: Record<string, unknown> };
  if (!root.hooks || typeof root.hooks !== "object") {
    return { level: "ok", detail: "no hook entries in settings.json" };
  }
  const stale: { event: string; path: string }[] = [];
  let totalOmcpEntries = 0;
  for (const [event, matchers] of Object.entries(root.hooks)) {
    if (!Array.isArray(matchers)) continue;
    for (const matcher of matchers) {
      const hooks = (matcher as { hooks?: unknown[] }).hooks;
      if (!Array.isArray(hooks)) continue;
      for (const h of hooks) {
        const entry = h as {
          command?: string;
          __omcp?: boolean;
        };
        if (entry.__omcp !== true) continue;
        if (typeof entry.command !== "string") continue;
        totalOmcpEntries++;
        // Extract script path from `node "<path>" ...` or
        // `<path> hook fire ...` (legacy bare form).
        const nodeMatch = entry.command.match(/node\s+"([^"]+)"/);
        const candidate = nodeMatch?.[1];
        if (candidate && !existsSync(candidate)) {
          stale.push({ event, path: candidate });
        }
      }
    }
  }
  if (totalOmcpEntries === 0) {
    return {
      level: "ok",
      detail: "no omcp-owned hook entries in settings.json (run `omcp setup` to wire)",
    };
  }
  if (stale.length === 0) {
    return {
      level: "ok",
      detail: `${totalOmcpEntries} omcp hook entries verified — all script paths exist`,
    };
  }
  const sample = stale
    .slice(0, 3)
    .map((s) => `${s.event}→${s.path.split(/[\\/]/).pop()}`)
    .join(", ");
  return {
    level: "warn",
    detail:
      `${stale.length}/${totalOmcpEntries} omcp hook entries reference missing scripts ` +
      `(${sample}${stale.length > 3 ? ", ..." : ""}). Run \`omcp setup\` to refresh.`,
  };
}

/**
 * Pure analyzer for a Copilot log file's content. Extracted for testing.
 *
 * Detects two failure patterns:
 *   1. eval_stdin SyntaxError — the upstream Windows pwsh dispatch bug
 *      documented in copilot-pwsh-dispatch-v1.5-investigation.md. Child
 *      Node loses the script-path argument and treats stdin payload as
 *      TypeScript source.
 *   2. Bare HookExitCodeError with code 1 (no eval_stdin) — a handler ran
 *      and exited 1 for a non-upstream reason (handler bug, stale
 *      settings.json target, etc.).
 */
export function analyzeHookDeliveryFromLog(
  content: string,
  filename: string,
): { level: CheckLevel; detail: string } {
  const evalStdinMatches =
    content.match(/node:internal\/main\/eval_stdin/g) ?? [];
  const hookErrMatches =
    content.match(/HookExitCodeError: Hook command failed with code 1/g) ?? [];

  if (evalStdinMatches.length > 0) {
    return {
      level: "warn",
      detail:
        `${evalStdinMatches.length} eval_stdin failures in ${filename} — ` +
        `upstream Copilot Windows pwsh dispatch bug (handlers correctly ` +
        `registered but Node loses script-path). See ` +
        `docs/upstream-reports/copilot-pwsh-dispatch-v1.5-investigation.md.`,
    };
  }
  if (hookErrMatches.length > 0) {
    return {
      level: "warn",
      detail:
        `${hookErrMatches.length} HookExitCodeError(s) in ${filename} ` +
        `(non-eval_stdin) — handler script likely exited non-zero; ` +
        `inspect stderr context in the log for the proximate cause.`,
    };
  }
  return { level: "ok", detail: `latest log clean (${filename})` };
}

/**
 * Probe ~/.copilot/mcp-config.json for integrity issues.
 *
 * Checks:
 *   1. Malformed JSON → error
 *   2. Missing server script files (args[0] for node/npx commands) → error
 *   3. Non-existent command path (when command is an absolute path) → warn
 *
 * US-1.9-T2-DOCTOR-check-mcp-config; Invariant 8: CLI registration.
 */
export function probeMcpConfigIntegrity(
  mcpConfigPath: string,
): { level: CheckLevel; detail: string } {
  if (!existsSync(mcpConfigPath)) {
    return { level: "ok", detail: "no mcp-config.json present (run `omcp setup` to create)" };
  }
  let raw: string;
  try {
    raw = readFileSync(mcpConfigPath, "utf8");
  } catch (err) {
    return { level: "warn", detail: `unable to read mcp-config.json: ${(err as Error).message}` };
  }
  return analyzeMcpConfigFromJson(raw, mcpConfigPath);
}

/**
 * Pure analyzer for ~/.copilot/mcp-config.json content. Exported for testing.
 *
 * For each server entry, checks:
 *   - args[0] (when command is "node" or "npx") must be an existing file
 *   - command (when absolute path) must exist on disk
 */
export function analyzeMcpConfigFromJson(
  jsonContent: string,
  mcpConfigPath: string,
): { level: CheckLevel; detail: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonContent);
  } catch {
    return {
      level: "fail",
      detail: `mcp-config.json at ${mcpConfigPath} is not valid JSON; run \`omcp setup\` to rewrite.`,
    };
  }

  const root = parsed as { mcpServers?: Record<string, unknown> };
  if (!root.mcpServers || typeof root.mcpServers !== "object") {
    return { level: "ok", detail: "mcp-config.json present but has no mcpServers entries" };
  }

  const missingScripts: string[] = [];
  const missingCommands: string[] = [];
  const serverNames = Object.keys(root.mcpServers);

  for (const [name, entry] of Object.entries(root.mcpServers)) {
    const server = entry as { command?: string; args?: string[]; url?: string };
    if (!server || typeof server !== "object") continue;

    // Check script file referenced in args[0] for node/npx launchers
    const cmd = server.command ?? "";
    const isNodeLauncher =
      cmd === "node" ||
      cmd === "npx" ||
      /[/\\]node(?:\.exe)?$/.test(cmd) ||
      /[/\\]npx(?:\.exe)?$/.test(cmd);

    if (isNodeLauncher && Array.isArray(server.args) && server.args.length > 0) {
      const scriptPath = server.args[0];
      if (scriptPath && !scriptPath.startsWith("${") && !existsSync(scriptPath)) {
        missingScripts.push(`${name}:${scriptPath.split(/[\\/]/).pop() ?? scriptPath}`);
      }
    }

    // Check absolute command path exists
    if (cmd && /^[/\\]|^[A-Za-z]:/.test(cmd) && !existsSync(cmd)) {
      missingCommands.push(`${name}:${cmd.split(/[\\/]/).pop() ?? cmd}`);
    }
  }

  const total = serverNames.length;

  if (missingScripts.length > 0) {
    const sample = missingScripts.slice(0, 3).join(", ");
    return {
      level: "fail",
      detail:
        `${missingScripts.length}/${total} mcp server(s) reference missing script files ` +
        `(${sample}${missingScripts.length > 3 ? ", ..." : ""}). Run \`omcp setup\` to refresh.`,
    };
  }
  if (missingCommands.length > 0) {
    const sample = missingCommands.slice(0, 3).join(", ");
    return {
      level: "warn",
      detail:
        `${missingCommands.length}/${total} mcp server(s) have non-existent command paths ` +
        `(${sample}${missingCommands.length > 3 ? ", ..." : ""}). Run \`omcp setup\` to refresh.`,
    };
  }

  return {
    level: "ok",
    detail: `${total} mcp server(s) verified — all paths present`,
  };
}

export function formatChecks(checks: CheckResult[]): string {
  return checks
    .map((c) => {
      const sym = c.level === "ok" ? "OK " : c.level === "warn" ? "WARN" : "FAIL";
      return `[${sym}] ${c.name.padEnd(28)} ${c.detail}`;
    })
    .join("\n");
}

export function formatChecksJson(checks: CheckResult[]): string {
  return JSON.stringify({ checks }, null, 2);
}

export function exitCodeFor(checks: CheckResult[]): number {
  if (checks.some((c) => c.level === "fail")) return 2;
  if (checks.some((c) => c.level === "warn")) return 1;
  return 0;
}

// ---------------------------------------------------------------------------
// US-1.9-T2-DOCTOR-check-settings-drift (Invariant 8: CLI registration)
// ---------------------------------------------------------------------------

/**
 * Probe ~/.copilot/settings.json for entries referencing missing scripts.
 * Unlike probeStaleSettings (scoped to __omcp:true entries), this probe
 * scans ALL hook command entries for missing `node "<path>"` script references.
 * Returns ok if settings.json absent or all referenced scripts resolve.
 */
export function probeSettingsDrift(
  settingsPath: string,
): { level: CheckLevel; detail: string } {
  if (!existsSync(settingsPath)) {
    return { level: "ok", detail: "no settings.json yet" };
  }
  return analyzeSettingsDriftFromJson(
    readFileSync(settingsPath, "utf8"),
    settingsPath,
  );
}

/**
 * Pure analyzer for settings drift. Scans every hook command for
 * `node "<path>"` patterns and checks whether the path exists.
 * Exported for testing.
 */
export function analyzeSettingsDriftFromJson(
  jsonContent: string,
  settingsPath: string,
): { level: CheckLevel; detail: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonContent);
  } catch {
    return {
      level: "warn",
      detail: `settings.json at ${settingsPath} is not valid JSON; run \`omcp setup\` to rewrite.`,
    };
  }
  const root = parsed as { hooks?: Record<string, unknown> };
  if (!root.hooks || typeof root.hooks !== "object") {
    return { level: "ok", detail: "no hook entries in settings.json" };
  }
  const missing: { event: string; path: string }[] = [];
  let totalEntries = 0;
  for (const [event, matchers] of Object.entries(root.hooks)) {
    if (!Array.isArray(matchers)) continue;
    for (const matcher of matchers) {
      const hooks = (matcher as { hooks?: unknown[] }).hooks;
      if (!Array.isArray(hooks)) continue;
      for (const h of hooks) {
        const entry = h as { command?: string };
        if (typeof entry.command !== "string") continue;
        totalEntries++;
        const nodeMatch = entry.command.match(/node\s+"([^"]+)"/);
        const candidate = nodeMatch?.[1];
        if (candidate && !existsSync(candidate)) {
          missing.push({ event, path: candidate });
        }
      }
    }
  }
  if (totalEntries === 0) {
    return { level: "ok", detail: "no hook command entries in settings.json" };
  }
  if (missing.length === 0) {
    return {
      level: "ok",
      detail: `${totalEntries} hook command entries — all referenced scripts exist`,
    };
  }
  const sample = missing
    .slice(0, 3)
    .map((s) => `${s.event}→${s.path.split(/[\\/]/).pop()}`)
    .join(", ");
  return {
    level: "warn",
    detail:
      `${missing.length}/${totalEntries} hook entries reference missing scripts ` +
      `(${sample}${missing.length > 3 ? ", ..." : ""}). Run \`omcp setup\` to refresh.`,
  };
}

// ---------------------------------------------------------------------------
// US-1.9-T2-DOCTOR-check-hook-registration (Invariant 5: subagentStart camelCase)
// ---------------------------------------------------------------------------

/**
 * Probe ~/.copilot/settings.json hook event names against COPILOT_VALID_EVENTS.
 * Flags unknown event names as fail and warns if `SubagentStart` (PascalCase)
 * is used instead of the required camelCase `subagentStart` (Invariant 5).
 */
export function probeHookRegistration(
  settingsPath: string,
): { level: CheckLevel; detail: string } {
  if (!existsSync(settingsPath)) {
    return { level: "ok", detail: "no settings.json yet" };
  }
  return analyzeHookRegistrationFromJson(
    readFileSync(settingsPath, "utf8"),
    settingsPath,
  );
}

/**
 * Pure analyzer for hook event registration. Exported for testing.
 */
export function analyzeHookRegistrationFromJson(
  jsonContent: string,
  settingsPath: string,
): { level: CheckLevel; detail: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonContent);
  } catch {
    return {
      level: "warn",
      detail: `settings.json at ${settingsPath} is not valid JSON; run \`omcp setup\` to rewrite.`,
    };
  }
  const root = parsed as { hooks?: Record<string, unknown> };
  if (!root.hooks || typeof root.hooks !== "object") {
    return { level: "ok", detail: "no hook events registered in settings.json" };
  }
  const validSet = new Set<string>(COPILOT_VALID_EVENTS);
  const unknown: string[] = [];
  const badCase: string[] = []; // e.g. SubagentStart instead of subagentStart
  for (const event of Object.keys(root.hooks)) {
    if (!validSet.has(event)) {
      // Check specifically for SubagentStart — camelCase violation (Invariant 5)
      if (event.toLowerCase() === "subagentstart" && event !== "subagentStart") {
        badCase.push(event);
      } else {
        unknown.push(event);
      }
    }
  }
  if (unknown.length === 0 && badCase.length === 0) {
    return {
      level: "ok",
      detail: `${Object.keys(root.hooks).length} hook event(s) all valid`,
    };
  }
  const parts: string[] = [];
  if (badCase.length > 0) {
    parts.push(
      `${badCase.join(", ")} must be camelCase \`subagentStart\` (Invariant 5)`,
    );
  }
  if (unknown.length > 0) {
    parts.push(`unknown event(s): ${unknown.join(", ")}`);
  }
  return {
    level: "fail",
    detail: parts.join("; ") + " — run `omcp setup` to fix.",
  };
}

// ---------------------------------------------------------------------------
// US-1.9-T2-DOCTOR-check-agent-catalog (Invariant 8: CLI registration)
// ---------------------------------------------------------------------------

/** Expected number of agents per the omcp manifest. */
const EXPECTED_AGENT_COUNT = 19;

/**
 * Probe the agents directory inside the omcp plugin cache and verify all
 * 19 expected agents are present. Returns warn (not fail) when the plugin
 * cache is absent (mirrors the "agent catalog" tier-1 check above).
 */
export function probeAgentCatalog(
  omcpPluginDir: string,
): { level: CheckLevel; detail: string } {
  const agentsDir = join(omcpPluginDir, "agents");
  if (!existsSync(agentsDir)) {
    return {
      level: "warn",
      detail: `agents/ directory not found at ${agentsDir} — run \`omcp setup\``,
    };
  }
  return analyzeAgentCatalogFromDir(agentsDir);
}

/**
 * Pure analyzer: count *.md files in the agents directory and compare
 * against EXPECTED_AGENT_COUNT. Exported for testing.
 */
export function analyzeAgentCatalogFromDir(
  agentsDir: string,
): { level: CheckLevel; detail: string } {
  let files: string[];
  try {
    files = readdirSync(agentsDir).filter((f) => f.endsWith(".md"));
  } catch (err) {
    return {
      level: "warn",
      detail: `unable to read agents/: ${(err as Error).message}`,
    };
  }
  const count = files.length;
  if (count === EXPECTED_AGENT_COUNT) {
    return {
      level: "ok",
      detail: `${count}/${EXPECTED_AGENT_COUNT} agents present in catalog`,
    };
  }
  if (count > EXPECTED_AGENT_COUNT) {
    return {
      level: "ok",
      detail: `${count} agents present (${count - EXPECTED_AGENT_COUNT} extra beyond expected ${EXPECTED_AGENT_COUNT})`,
    };
  }
  const missing = EXPECTED_AGENT_COUNT - count;
  return {
    level: "warn",
    detail:
      `${count}/${EXPECTED_AGENT_COUNT} agents present — ${missing} missing. ` +
      `Run \`omcp setup\` to refresh the plugin cache.`,
  };
}

// ---------------------------------------------------------------------------
// US-1.9-T2-DOCTOR-check-plugin-install (Invariant 8: CLI registration)
// ---------------------------------------------------------------------------

/**
 * Run `node src/scripts/sync-plugin-mirror.ts --check` (via the compiled
 * dist equivalent) and report mirror drift. If the compiled script is not
 * found, falls back gracefully to a warn.
 *
 * Spawns synchronously so doctor stays single-threaded. The --check flag
 * causes sync-plugin-mirror to exit 1 on any drift.
 */
export function probePluginInstall(
  syncScriptPath?: string,
): { level: CheckLevel; detail: string } {
  // Resolve the compiled script path: dist/scripts/sync-plugin-mirror.js
  // This file is at dist/cli/commands/doctor.js at runtime; climb to dist/
  // then to package root, then dist/scripts/
  let scriptPath = syncScriptPath;
  if (!scriptPath) {
    // __dirname-equivalent for ESM: derive from import.meta logic is not
    // available here so we use a relative approach from process.argv[1]
    // (dist/cli/omcp.js) — climb two levels to package root.
    try {
      // Try to find via process.argv[1] which is omcp.js at dist/cli/omcp.js
      const argv1 = process.argv[1];
      if (argv1) {
        const pkgRoot = join(argv1, "..", "..", "..");
        scriptPath = join(pkgRoot, "dist", "scripts", "sync-plugin-mirror.js");
      }
    } catch {
      // ignore; leave undefined → warn below
    }
  }
  if (!scriptPath || !existsSync(scriptPath)) {
    return {
      level: "warn",
      detail: "sync-plugin-mirror script not found in dist/ — run `npm run build` first",
    };
  }
  const result = spawnSync(
    process.execPath,
    [scriptPath, "--check"],
    { encoding: "utf8", timeout: 15000 },
  );
  if (result.status === 0) {
    return { level: "ok", detail: "plugin mirror in sync with source" };
  }
  const stderr = (result.stderr ?? "").trim();
  const driftLine = stderr.split("\n").find((l) => l.includes("drift entries"));
  return {
    level: "warn",
    detail:
      `plugin mirror has drift${driftLine ? ` (${driftLine.trim()})` : ""} — ` +
      `run \`omcp setup\` or \`node src/scripts/sync-plugin-mirror.ts\` to refresh.`,
  };
}

// ---------------------------------------------------------------------------
// US-1.9-T2-DOCTOR-check-copilot-auth (Invariant 8: CLI registration)
// ---------------------------------------------------------------------------

export interface CopilotAuthSpawnResult {
  status: number | null;
  stderr?: string;
}

/**
 * Probe whether the Copilot CLI is authenticated by spawning
 * `copilot -p "echo test"` with a short timeout. Exit 0 → ok; non-zero → warn.
 *
 * The `spawnFn` parameter is injectable for tests so CI does not need a real
 * Copilot auth session.
 */
export function probeCopilotAuth(
  spawnFn?: (cmd: string, args: string[]) => CopilotAuthSpawnResult,
): { level: CheckLevel; detail: string } {
  const doSpawn = spawnFn ?? ((cmd: string, args: string[]) => {
    const r = spawnSync(cmd, args, {
      encoding: "utf8",
      timeout: 10000,
      stdio: ["ignore", "ignore", "pipe"],
    });
    return { status: r.status, stderr: (r.stderr as string | null) ?? "" };
  });
  try {
    const result = doSpawn("copilot", ["-p", "echo test"]);
    if (result.status === 0) {
      return { level: "ok", detail: "copilot CLI authenticated (exit 0)" };
    }
    const hint = (result.stderr ?? "")
      .split("\n")
      .find((l) => l.toLowerCase().includes("auth") || l.toLowerCase().includes("login"));
    return {
      level: "warn",
      detail:
        `copilot exited ${result.status ?? "null"}${hint ? ` — ${hint.trim()}` : ""} — ` +
        `run \`copilot auth login\` to authenticate.`,
    };
  } catch (err) {
    return {
      level: "warn",
      detail: `unable to spawn copilot: ${(err as Error).message}`,
    };
  }
}

// ---------------------------------------------------------------------------
// US-omcp-parity-P1-DOCTOR-verify-spawn-shape (Invariants 8 + 4)
// ---------------------------------------------------------------------------

export interface CopilotVerifySpawnResult {
  status: number | null;
  stdout?: string;
  stderr?: string;
  /** True when spawnSync killed the child due to the timeout option firing. */
  timedOut?: boolean;
}

/**
 * Timeout for the verify-spawn probe in ms. Per US-P1-DOCTOR-verify-spawn-shape
 * acceptance criteria — 30s. Independent of `probeCopilotAuth`'s 10s since this
 * probe also has to capture stdout (model-id token) which Copilot prints after
 * the model has loaded.
 */
const VERIFY_SPAWN_TIMEOUT_MS = 30000;

/** Substrings that identify a recognizable Copilot model-id banner. */
const MODEL_ID_TOKENS = ["gpt-", "claude-"] as const;

/**
 * Detect whether a spawnSync result was killed by its `timeout` option.
 *
 * POSIX: spawnSync sets `signal` to a non-null string ("SIGTERM") when the
 * timeout fires.
 *
 * Windows: spawnSync exposes the timeout via `result.error.code === "ETIMEDOUT"`
 * (the `.message` string is not a reliable check — Node's SystemError carries
 * the canonical reason on `.code`).
 *
 * Exported for direct unit-testing without spawning a real child process.
 */
export function detectVerifySpawnTimeout(r: {
  status: number | null;
  signal: NodeJS.Signals | null;
  errorCode?: string;
}): boolean {
  if (r.signal !== null) return true;
  if (r.status === null && r.errorCode === "ETIMEDOUT") return true;
  return false;
}

/**
 * Probe whether the Copilot CLI's `-p` mode produces a recognizable model-id
 * token. Spawns `copilot -p "echo verify-spawn-check"`; returns ok when exit 0
 * AND stdout contains `gpt-` or `claude-`. Anything else → warn with the
 * captured stderr hint surfaced.
 *
 * The `spawnFn` parameter is injectable for tests so CI can run this check
 * without a real Copilot auth session. Gates `omcp team-verify` readiness:
 * if `--allow-all-tools` is renamed or `-p` stdin semantics drift between
 * Copilot CLI versions, the verify-worker spawn would silently no-op without
 * this guard. (Pre-mortem scenario 1 in iter-2 plan.)
 */
export function probeVerifySpawnShape(
  spawnFn?: (cmd: string, args: string[]) => CopilotVerifySpawnResult,
): { level: CheckLevel; detail: string } {
  const doSpawn = spawnFn ?? ((cmd: string, args: string[]) => {
    const r = spawnSync(cmd, args, {
      encoding: "utf8",
      timeout: VERIFY_SPAWN_TIMEOUT_MS,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return {
      status: r.status,
      stdout: (r.stdout as string | null) ?? "",
      stderr: (r.stderr as string | null) ?? "",
      timedOut: detectVerifySpawnTimeout({
        status: r.status,
        signal: r.signal,
        errorCode: (r.error as { code?: string } | undefined)?.code,
      }),
    };
  });

  try {
    const result = doSpawn("copilot", ["-p", "echo verify-spawn-check"]);

    if (result.timedOut) {
      return {
        level: "warn",
        detail:
          `copilot -p timed out after ${VERIFY_SPAWN_TIMEOUT_MS}ms — ` +
          `verify-worker spawns may hang. Re-run \`omcp doctor\` after \`copilot auth login\`.`,
      };
    }

    if (result.status !== 0) {
      const hint = (result.stderr ?? "")
        .split("\n")
        .map((l) => l.trim())
        .find((l) => l.length > 0);
      return {
        level: "warn",
        detail:
          `copilot -p exited ${result.status ?? "null"}${hint ? ` — ${hint}` : ""} — ` +
          `verify-worker spawns will fail. Run \`copilot auth login\`.`,
      };
    }

    const stdout = result.stdout ?? "";
    const matched = MODEL_ID_TOKENS.find((tok) => stdout.includes(tok));
    if (!matched) {
      return {
        level: "warn",
        detail:
          `copilot -p exit 0 but no model-id token (gpt-/claude-) found in stdout — ` +
          `Copilot CLI banner shape may have drifted; team-verify may not be reachable.`,
      };
    }

    return {
      level: "ok",
      detail: `verify-spawn ready (model-id token '${matched}' present)`,
    };
  } catch (err) {
    return {
      level: "warn",
      detail: `unable to spawn copilot: ${(err as Error).message}`,
    };
  }
}
