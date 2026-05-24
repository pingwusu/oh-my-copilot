// Read/merge/write ~/.copilot/config.json and mcp-config.json safely.
// We never overwrite unrelated keys; we only add/refresh the omcp plugin entry.

import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import { atomicWriteFileSync } from "./atomic-write.js";
import { findExecutable } from "./resolve-executable.js";

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
// Copilot CLI 1.0.48-1.0.52+ reads hook entries from ~/.copilot/settings.json
// (proven by scripts/smoke/wire-probe-for-tui.mjs:31-35). The `statusLine`
// and plugin registration fields (installedPlugins, enabledPlugins) remain in
// ~/.copilot/config.json. omcp writes to both files: hooks → settings.json,
// everything else → config.json. Never consolidate — Copilot's read surfaces
// for each are separate and documented separately.
//
// The `hooks` value shape:
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

export interface ResolveOmcpBinOptions {
  /**
   * Override the PATH lookup. Defaults to `findExecutable` from
   * resolve-executable.ts. Injectable for tests.
   */
  findOmcpOnPath?: (name: string) => string | null;
  /**
   * Override the package-root used to resolve the absolute-path fallback.
   * Defaults to two levels up from this file's runtime location
   * (`dist/runtime/copilot-config.js` → `dist/` → package root).
   * Injectable for tests so we don't depend on the on-disk dist/.
   */
  packageRoot?: string;
}

function defaultPackageRoot(): string {
  // At runtime this file is `dist/runtime/copilot-config.js`. Climbing two
  // levels lands at the package root (which `package.json#files` ships with
  // `dist/cli/omcp.js`).
  const here = dirname(fileURLToPath(import.meta.url));
  return resolvePath(here, "..", "..");
}

/**
 * Resolve the value emitted into `hooks[<event>][].hooks[].command` as the
 * `omcp` invocation for general (non-hook) use sites.
 *
 *   1. If `omcp` resolves on PATH (npm-linked or globally installed shim)
 *      → return the literal `"omcp"`. Compact, portable, the common case.
 *   2. Otherwise → emit `node "<absolute path to dist/cli/omcp.js>"`.
 *
 * **For Copilot HOOK commands (`settings.json` `hooks` block), prefer
 * `resolveHookCommandBin()` instead.** Hooks dispatched by Copilot's pwsh
 * executor on Windows can hit Node's eval-stdin parser when going through
 * the npm shim layer (the `.ps1` / `.cmd` wrappers), so for hooks we always
 * emit the absolute-node form even when omcp is on PATH. omc's reference at
 * `src/hooks/setup/index.ts:166` follows this same pattern.
 */
export function resolveDefaultOmcpBin(opts: ResolveOmcpBinOptions = {}): string {
  const finder = opts.findOmcpOnPath ?? findExecutable;
  if (finder("omcp")) return "omcp";
  const root = opts.packageRoot ?? defaultPackageRoot();
  return `node "${join(root, "dist", "cli", "omcp.js")}"`;
}

/**
 * Resolve the omcp invocation form used INSIDE Copilot `settings.json` hook
 * commands. Unconditionally returns the absolute-node form
 * (`node "<absolute path to dist/cli/omcp.js>"`).
 *
 * **Why unconditional**: the bare `omcp ...` form goes through the npm shim
 * layer (`omcp.ps1` / `omcp.cmd`). When Copilot 1.0.52-4 on Windows
 * dispatches hooks via `pwsh.exe -nop -nol -c "omcp hook fire X --json"`,
 * the shim's stdin forwarding can fail in a way that puts Node into
 * eval-stdin mode — Node treats the piped JSON payload as TypeScript source
 * code and exits with SyntaxError + code 1. v1.0.0's Phase A smoke logged
 * 42 such failures for PostToolUse alone (`docs/probes/L1-hook-dispatch-format.md`).
 *
 * The absolute-node form mirrors omc's `src/hooks/setup/index.ts:166`
 * pattern and bypasses the shim layer entirely.
 *
 * The optional `omcpBin` argument on `MergeHookOptions` continues to take
 * precedence — tests pass an explicit override to avoid hitting filesystem
 * resolution entirely.
 */
export function resolveHookCommandBin(opts: ResolveOmcpBinOptions = {}): string {
  const root = opts.packageRoot ?? defaultPackageRoot();
  return `node "${join(root, "dist", "cli", "omcp.js")}"`;
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
  // `opts.omcpBin` (explicit override) wins. Otherwise use
  // `resolveHookCommandBin()` which ALWAYS returns the absolute-node form
  // (`node "<abs>" ...`) — bypassing the npm shim layer that causes
  // Copilot's pwsh hook executor to trigger Node's eval-stdin SyntaxError
  // on Windows. See `docs/probes/L1-hook-dispatch-format.md` for the
  // root-cause investigation; mirrors omc's `src/hooks/setup/index.ts:166`.
  const omcpBin = opts.omcpBin ?? resolveHookCommandBin();
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
 * Build the merged hooks map for writing to settings.json.
 * Returns only the `hooks` field — callers write it to paths.copilotSettings.
 */
export function applyOmcpHookWiring(
  existing: CopilotHooksMap | undefined,
  opts: MergeHookOptions = {},
): CopilotHooksMap {
  return mergeCopilotHooks(existing, opts);
}

/**
 * Apply statusLine wiring on top of an existing CopilotConfig for config.json.
 * Hooks are NOT included — those belong in settings.json via applyOmcpHookWiring.
 * Returns a new config object; never mutates `config`.
 */
export function applyOmcpConfigWiring(
  config: CopilotConfig,
  opts: MergeStatusLineOptions = {},
): CopilotConfig {
  const existingStatus = (config.statusLine as CopilotStatusLine | undefined) ?? undefined;
  const nextStatus = mergeCopilotStatusLine(existingStatus, opts);
  return {
    ...config,
    statusLine: nextStatus,
  };
}

/**
 * @deprecated Use applyOmcpHookWiring (→ settings.json) and applyOmcpConfigWiring
 * (→ config.json) separately. This combined form writes hooks to config.json,
 * which Copilot CLI 1.0.48+ does NOT read for hook dispatch.
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
