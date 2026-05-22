/**
 * Factcheck Guard Configuration
 *
 * Loads guard config from .omcp/guards.jsonc (workspace-local) with token
 * expansion and deep merge over sensible defaults.
 * Ported from oh-my-claudecode factcheck library.
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { readJsonOrDefault } from "../../runtime/copilot-config.js";
import type { GuardsConfig, FactcheckPolicy, SentinelPolicy } from "./types.js";

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const DEFAULT_FACTCHECK_POLICY: FactcheckPolicy = {
  enabled: false,
  mode: "quick",
  strict_project_patterns: [],
  forbidden_path_prefixes: ["${HOME}/.copilot/plugins/cache/omcp/"],
  forbidden_path_substrings: ["/.omcp/", ".omcp-config.json"],
  readonly_command_prefixes: [
    "ls ",
    "cat ",
    "find ",
    "grep ",
    "head ",
    "tail ",
    "stat ",
    "echo ",
    "wc ",
  ],
  warn_on_cwd_mismatch: true,
  enforce_cwd_parity_in_quick: false,
  warn_on_unverified_gates: true,
  warn_on_unverified_gates_when_no_source_files: false,
};

const DEFAULT_SENTINEL_POLICY: SentinelPolicy = {
  enabled: false,
  readiness: {
    min_pass_rate: 0.6,
    max_timeout_rate: 0.1,
    max_warn_plus_fail_rate: 0.4,
    min_reason_coverage_rate: 0.95,
  },
};

export const DEFAULT_GUARDS_CONFIG: GuardsConfig = {
  factcheck: { ...DEFAULT_FACTCHECK_POLICY },
  sentinel: { ...DEFAULT_SENTINEL_POLICY },
};

// ---------------------------------------------------------------------------
// Token expansion
// ---------------------------------------------------------------------------

/**
 * Expand ${HOME} and ${WORKSPACE} tokens in a string.
 */
export function expandTokens(value: string, workspace?: string): string {
  const home = homedir();
  const ws = workspace ?? process.env["OMCP_WORKSPACE"] ?? process.cwd();
  return value
    .replace(/\$\{HOME\}/g, home)
    .replace(/\$\{WORKSPACE\}/g, ws);
}

/**
 * Recursively expand tokens in string values within an object or array.
 */
function expandTokensDeep<T>(obj: T, workspace?: string): T {
  if (typeof obj === "string") {
    return expandTokens(obj, workspace) as unknown as T;
  }
  if (Array.isArray(obj)) {
    return obj.map((item) => expandTokensDeep(item, workspace)) as unknown as T;
  }
  if (typeof obj === "object" && obj !== null) {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj)) {
      result[key] = expandTokensDeep(value, workspace);
    }
    return result as T;
  }
  return obj;
}

// ---------------------------------------------------------------------------
// Deep merge (local, type-safe for guards config)
// ---------------------------------------------------------------------------

function deepMergeGuards(
  target: GuardsConfig,
  source: Partial<GuardsConfig>,
): GuardsConfig {
  const result = { ...target };

  if (source.factcheck) {
    result.factcheck = { ...result.factcheck, ...source.factcheck };
  }
  if (source.sentinel) {
    result.sentinel = {
      ...result.sentinel,
      ...source.sentinel,
      readiness: {
        ...result.sentinel.readiness,
        ...(source.sentinel.readiness ?? {}),
      },
    };
  }

  return result;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Load guards config from .omcp/guards.jsonc relative to workspace root.
 *
 * Reads the guards config file, deep-merges over defaults, and expands
 * ${HOME}/${WORKSPACE} tokens.
 */
export function loadGuardsConfig(workspace?: string): GuardsConfig {
  const ws = workspace ?? process.env["OMCP_WORKSPACE"] ?? process.cwd();
  try {
    const configPath = join(ws, ".omcp", "guards.jsonc");
    const guardsRaw = readJsonOrDefault<Partial<GuardsConfig>>(configPath, {});
    const merged = deepMergeGuards(DEFAULT_GUARDS_CONFIG, guardsRaw);
    return expandTokensDeep(merged, ws);
  } catch {
    // If config loading fails, return expanded defaults
    return expandTokensDeep({ ...DEFAULT_GUARDS_CONFIG }, workspace);
  }
}

/**
 * Check if a project name matches any strict project patterns.
 * Uses simple glob-style matching (supports * wildcard).
 */
export function shouldUseStrictMode(
  projectName: string,
  patterns: string[],
): boolean {
  for (const pattern of patterns) {
    const escaped = pattern
      .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
      .replace(/\\\*/g, ".*")
      .replace(/\\\?/g, ".");
    const regex = new RegExp("^" + escaped + "$");
    if (regex.test(projectName)) {
      return true;
    }
  }
  return false;
}
