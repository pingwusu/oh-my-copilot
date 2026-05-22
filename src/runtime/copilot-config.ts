// Read/merge/write ~/.copilot/config.json and mcp-config.json safely.
// We never overwrite unrelated keys; we only add/refresh the omcp plugin entry.

import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { atomicWriteFileSync } from "./atomic-write.js";

export interface InstalledPlugin {
  name: string;
  marketplace: string;
  version: string;
  installed_at: string;
  enabled: boolean;
  cache_path: string;
}

export interface CopilotConfig {
  installedPlugins?: InstalledPlugin[];
  enabledPlugins?: Record<string, boolean>;
  [key: string]: unknown;
}

import { parse as parseJsonc } from "jsonc-parser";

export function readJsonOrDefault<T>(path: string, fallback: T): T {
  if (!existsSync(path)) return fallback;
  const raw = readFileSync(path, "utf8");
  if (!raw.trim()) return fallback;
  // Copilot's own config.json sometimes contains // comments; use jsonc-parser
  // to be permissive.
  return parseJsonc(raw) as T;
}

export function writeJson(path: string, data: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  atomicWriteFileSync(path, `${JSON.stringify(data, null, 2)}\n`);
}

export function upsertOmcpPlugin(
  config: CopilotConfig,
  version: string,
  cachePath: string,
): CopilotConfig {
  const next: CopilotConfig = { ...config };
  next.installedPlugins = (config.installedPlugins ?? []).filter(
    (p) => !(p.name === "oh-my-copilot" && p.marketplace === "oh-my-copilot"),
  );
  next.installedPlugins.push({
    name: "oh-my-copilot",
    marketplace: "oh-my-copilot",
    version,
    installed_at: new Date().toISOString(),
    enabled: true,
    cache_path: cachePath,
  });
  next.enabledPlugins = {
    ...(config.enabledPlugins ?? {}),
    "oh-my-copilot@oh-my-copilot": true,
  };
  return next;
}

export interface McpServerEntry {
  command?: string;
  args?: string[];
  description?: string;
  url?: string;
  type?: string;
}

export interface McpConfig {
  mcpServers?: Record<string, McpServerEntry>;
  [key: string]: unknown;
}

export function mergeMcpServers(
  user: McpConfig,
  pluginRoot: string,
  plugin: McpConfig,
): McpConfig {
  const next: McpConfig = { ...user, mcpServers: { ...(user.mcpServers ?? {}) } };
  for (const [name, entry] of Object.entries(plugin.mcpServers ?? {})) {
    const expanded: McpServerEntry = {
      ...entry,
      args: entry.args?.map((a) => a.replace("${PLUGIN_ROOT}", pluginRoot)),
    };
    next.mcpServers![name] = expanded;
  }
  return next;
}

// ---------------------------------------------------------------------------
// Copilot CLI `hooks` and `statusLine` wiring
// ---------------------------------------------------------------------------
//
// Copilot CLI 1.0.32+ reads inline `hooks` and `statusLine` fields from
// ~/.copilot/config.json. The `hooks` value uses the same shape as
// `.github/hooks/*.json` and Claude Code's hooks config:
//
//   {
//     "<EventName>": [
//       {
//         "matcher": "*",                 // optional tool/glob matcher
//         "hooks": [
//           {
//             "type": "command",
//             "command": "<shell command>",
//             "timeout": <seconds>         // optional
//           }
//         ]
//       }
//     ]
//   }
//
// We dispatch each Copilot hook event to `omcp hook fire <event> --json`, which
// reads the JSON payload Copilot pipes on stdin and invokes every registered
// omcp hook (plugin-cache + repo-local). The marker key `__omcp` lets us
// reliably identify and refresh omcp-managed hook entries without disturbing
// any unrelated user-authored hook entries that share the same event.

/**
 * Hook events omcp wires by default. Aligned with HookEvent in hook-types
 * and with the 13 valid Copilot CLI events (`@github/copilot/app.js aWr Set`).
 *
 * v0.9.0 and earlier shipped Claude-Code-style names ("PreSubmit",
 * "PostSubmit", "PreEnd") — Copilot CLI does NOT recognize those names and
 * silently drops the hook entries, leaving 3 of 6 omcp-managed hooks dead in
 * production. Fixed in v0.9.1 by renaming:
 *   PreSubmit  -> UserPromptSubmit
 *   PreEnd     -> SessionEnd
 *   PostSubmit -> (dropped — Copilot has no equivalent; the closest is Stop
 *                  which fires per-turn, not per-submission)
 * mergeCopilotHooks() already strips stale __omcp-marked entries on next
 * `omcp setup`, so existing settings.json files are migrated automatically.
 *
 * v0.10.0 expands from 5 events to all 13 valid Copilot hook events so that
 * every hook category is wired by default. PascalCase aliases are used where
 * they exist; `subagentStart` is camelCase-only (no PascalCase alias in the
 * Copilot CLI `s2t` map).
 */
export const OMCP_HOOK_EVENTS = [
  "SessionStart",
  "SessionEnd",
  "UserPromptSubmit",
  "PreToolUse",
  "PostToolUse",
  "PostToolUseFailure",
  "ErrorOccurred",
  "Stop",
  "SubagentStop",
  "subagentStart",
  "PreCompact",
  "PermissionRequest",
  "Notification",
] as const;

/** Authoritative set of valid Copilot CLI hook event names (13 total). */
export const COPILOT_VALID_EVENTS = [
  "sessionStart",
  "sessionEnd",
  "userPromptSubmitted",
  "preToolUse",
  "postToolUse",
  "postToolUseFailure",
  "errorOccurred",
  "agentStop",
  "subagentStop",
  "subagentStart",
  "preCompact",
  "permissionRequest",
  "notification",
  // PascalCase aliases (from the Copilot bundle's `s2t` map) — `subagentStart`
  // has NO PascalCase alias and is intentionally absent here.
  "SessionStart",
  "SessionEnd",
  "UserPromptSubmit",
  "PreToolUse",
  "PostToolUse",
  "PostToolUseFailure",
  "ErrorOccurred",
  "Stop",
  "SubagentStop",
  "PreCompact",
  "PermissionRequest",
  "Notification",
] as const;

export type CopilotHookEventName = (typeof OMCP_HOOK_EVENTS)[number] | string;

export interface CopilotHookCommand {
  type: "command";
  command: string;
  timeout?: number;
  /** Internal marker — set on entries omcp manages so refreshes are idempotent. */
  __omcp?: boolean;
}

export interface CopilotHookMatcher {
  matcher?: string;
  hooks: CopilotHookCommand[];
}

export type CopilotHooksMap = Record<CopilotHookEventName, CopilotHookMatcher[]>;

export interface CopilotStatusLine {
  type: "command";
  command: string;
  padding?: number;
  __omcp?: boolean;
}

export interface MergeHookOptions {
  /** Override the executable used to run `omcp hook fire ...`. Defaults to `omcp`. */
  omcpBin?: string;
  /** Per-hook timeout in seconds. Defaults to 5s. */
  timeoutSec?: number;
  /** Override the list of events to wire. Defaults to OMCP_HOOK_EVENTS. */
  events?: readonly CopilotHookEventName[];
}

function omcpHookCommand(event: string, omcpBin: string): string {
  // Use shell-safe quoting; both POSIX shells and pwsh accept single-token
  // command names. We don't quote the event since it's a known identifier.
  return `${omcpBin} hook fire ${event} --json`;
}

/**
 * Merge omcp's hook entries into a Copilot `hooks` map without disturbing
 * user-authored entries for the same events. Existing omcp-managed entries
 * (marked with `__omcp: true`) are replaced; non-omcp entries are preserved.
 */
export function mergeCopilotHooks(
  existing: CopilotHooksMap | undefined,
  opts: MergeHookOptions = {},
): CopilotHooksMap {
  const omcpBin = opts.omcpBin ?? "omcp";
  const timeout = opts.timeoutSec ?? 5;
  const events = opts.events ?? OMCP_HOOK_EVENTS;
  const next: CopilotHooksMap = {};

  // Carry over every existing event, stripping omcp-managed matcher entries
  // so we can rewrite them cleanly.
  for (const [event, matchers] of Object.entries(existing ?? {})) {
    const filteredMatchers: CopilotHookMatcher[] = [];
    for (const matcher of matchers ?? []) {
      const remaining = (matcher.hooks ?? []).filter((h) => h.__omcp !== true);
      if (remaining.length === 0) continue;
      filteredMatchers.push({ ...matcher, hooks: remaining });
    }
    if (filteredMatchers.length > 0) {
      next[event] = filteredMatchers;
    }
  }

  for (const event of events) {
    const omcpMatcher: CopilotHookMatcher = {
      matcher: "*",
      hooks: [
        {
          type: "command",
          command: omcpHookCommand(event, omcpBin),
          timeout,
          __omcp: true,
        },
      ],
    };
    next[event] = [...(next[event] ?? []), omcpMatcher];
  }

  return next;
}

export interface MergeStatusLineOptions {
  /** Override the executable used to render the status line. Defaults to `omcp`. */
  omcpBin?: string;
  /** Padding (spaces) Copilot adds to each status-line render. */
  padding?: number;
}

/**
 * Build (or refresh) the omcp status-line entry. If the user already has a
 * non-omcp `statusLine` configured we leave it untouched and return it as-is —
 * the user's customization wins. Only previously omcp-managed entries are
 * rewritten.
 */
export function mergeCopilotStatusLine(
  existing: CopilotStatusLine | undefined,
  opts: MergeStatusLineOptions = {},
): CopilotStatusLine {
  const omcpBin = opts.omcpBin ?? "omcp";
  // If user has a custom (non-omcp) statusLine, preserve it.
  if (existing && existing.__omcp !== true) {
    return existing;
  }
  const next: CopilotStatusLine = {
    type: "command",
    command: `${omcpBin} hud`,
    __omcp: true,
  };
  if (opts.padding !== undefined) next.padding = opts.padding;
  return next;
}

/**
 * Apply hooks + statusLine wiring on top of an existing CopilotConfig in a
 * single pass. Returns a new config object; never mutates `config`.
 */
export function applyOmcpRuntimeWiring(
  config: CopilotConfig,
  opts: MergeHookOptions & MergeStatusLineOptions = {},
): CopilotConfig {
  const existingHooks = (config.hooks as CopilotHooksMap | undefined) ?? undefined;
  const existingStatus = (config.statusLine as CopilotStatusLine | undefined) ?? undefined;
  const nextHooks = mergeCopilotHooks(existingHooks, opts);
  const nextStatus = mergeCopilotStatusLine(existingStatus, opts);
  return {
    ...config,
    hooks: nextHooks,
    statusLine: nextStatus,
  };
}

/** True when at least one omcp-managed hook entry is present in `hooks`. */
export function hasOmcpHookWiring(hooks: CopilotHooksMap | undefined): boolean {
  if (!hooks) return false;
  for (const matchers of Object.values(hooks)) {
    for (const matcher of matchers ?? []) {
      for (const h of matcher.hooks ?? []) {
        if (h.__omcp === true) return true;
      }
    }
  }
  return false;
}

/** True when the statusLine entry is omcp-managed. */
export function hasOmcpStatusLine(status: CopilotStatusLine | undefined): boolean {
  return Boolean(status && status.__omcp === true);
}
