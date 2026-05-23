/**
 * OMC Orchestrator Hook
 *
 * Enforces orchestrator behavior — delegation over direct implementation.
 *
 * PreToolUse: when an orchestrator agent attempts to modify files outside
 * .omcp/, injects a delegation reminder (warn mode) or blocks the tool call
 * (strict mode). No-ops when enforcement is "off".
 *
 * PostToolUse: after a write/edit tool fires on a non-allowed path, appends
 * DIRECT_WORK_REMINDER to the tool result via modifiedResult. After a
 * delegation tool (Task/Agent) completes, injects a verification reminder
 * and, when an active boulder exists, the plan-progress context.
 *
 * Subscribes to: PreToolUse, PostToolUse
 */

import * as fs from "node:fs";
import * as path from "node:path";

import type { Hook, HookContext, HookResult } from "../hook-types.js";
import {
  getOmcpRoot,
  OmcpPaths,
} from "../../lib/worktree-paths.js";
import {
  readBoulderState,
  getPlanProgress,
} from "../../lib/boulder-state.js";
import {
  addWorkingMemoryEntry,
  setPriorityContext,
} from "../../lib/notepad-state.js";
import {
  HOOK_NAME,
  ALLOWED_PATH_PATTERNS,
  WARNED_EXTENSIONS,
  WRITE_EDIT_TOOLS,
  DIRECT_WORK_REMINDER,
  ORCHESTRATOR_DELEGATION_REQUIRED,
  BOULDER_CONTINUATION_PROMPT,
  VERIFICATION_REMINDER,
  ENFORCEMENT_LEVEL_ENV_VAR,
  DEFAULT_ENFORCEMENT_LEVEL,
} from "./constants.js";

export type EnforcementLevel = "off" | "warn" | "strict";

export interface AuditEntry {
  timestamp: string;
  tool: string;
  filePath: string;
  decision: "allowed" | "warned" | "blocked";
  reason: "allowed_path" | "source_file" | "other";
  enforcementLevel: EnforcementLevel;
  sessionId?: string;
}

// ─── Path helpers ─────────────────────────────────────────────────────────────

/** Normalize a path to forward slashes. */
function toForwardSlash(p: string): string {
  return p.replace(/\\/g, "/");
}

/**
 * Check whether a file path is allowed for direct orchestrator modification.
 *
 * Allowed: anything under .omcp/, CLAUDE.md, AGENTS.md. Absolute paths are
 * resolved relative to cwd before pattern matching.
 */
export function isAllowedPath(filePath: string, cwd?: string): boolean {
  if (!filePath) return true;
  const normalized = toForwardSlash(path.normalize(toForwardSlash(filePath)));
  // Reject explicit traversal
  if (normalized.startsWith("../") || normalized === "..") return false;
  // Relative path — check patterns directly
  if (ALLOWED_PATH_PATTERNS.some((p) => p.test(normalized))) return true;
  // Absolute path — make relative to cwd first
  if (path.isAbsolute(filePath) && cwd) {
    const rel = toForwardSlash(path.relative(cwd, filePath));
    if (rel.startsWith("../") || rel === ".." || path.isAbsolute(rel)) {
      return false;
    }
    return ALLOWED_PATH_PATTERNS.some((p) => p.test(rel));
  }
  return false;
}

/** Return true when the extension is in WARNED_EXTENSIONS. */
export function isSourceFile(filePath: string): boolean {
  if (!filePath) return false;
  return WARNED_EXTENSIONS.includes(path.extname(filePath).toLowerCase());
}

/** Return true when toolName is a write/edit tool. */
export function isWriteEditTool(toolName: string): boolean {
  return WRITE_EDIT_TOOLS.includes(toolName);
}

/** Return true when toolName is a delegation tool (Task or Agent). */
export function isDelegationTool(toolName: string): boolean {
  const n = toolName.toLowerCase();
  return n === "task" || n === "agent";
}

// ─── Config ───────────────────────────────────────────────────────────────────

/** Read enforcement level from env, then .omcp/config.json, defaulting to warn. */
export function getEnforcementLevel(cwd: string): EnforcementLevel {
  const fromEnv = process.env[ENFORCEMENT_LEVEL_ENV_VAR];
  if (fromEnv === "off" || fromEnv === "warn" || fromEnv === "strict") {
    return fromEnv;
  }
  const configPath = path.join(getOmcpRoot(cwd), "config.json");
  if (fs.existsSync(configPath)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(configPath, "utf-8")) as Record<string, unknown>;
      const level = parsed.delegationEnforcementLevel ?? parsed.enforcementLevel;
      if (level === "off" || level === "warn" || level === "strict") {
        return level as EnforcementLevel;
      }
    } catch {
      // fall through to default
    }
  }
  return DEFAULT_ENFORCEMENT_LEVEL;
}

// ─── Audit logging ────────────────────────────────────────────────────────────

function logAuditEntry(
  entry: Omit<AuditEntry, "timestamp">,
  cwd: string,
): void {
  try {
    const logsDir = path.join(cwd, OmcpPaths.LOGS);
    fs.mkdirSync(logsDir, { recursive: true });
    const logPath = path.join(logsDir, "delegation-audit.jsonl");
    const full: AuditEntry = { ...entry, timestamp: new Date().toISOString() };
    fs.appendFileSync(logPath, JSON.stringify(full) + "\n");
  } catch {
    // Audit logging must never crash the hook
  }
}

// ─── Message builders ─────────────────────────────────────────────────────────

/** Suggest an agent type by file extension. */
function suggestAgent(filePath: string): string {
  const suggestions: Record<string, string> = {
    ".ts": "executor-low (simple) or executor (complex)",
    ".tsx": "designer-low (simple) or designer (complex UI)",
    ".js": "executor-low",
    ".jsx": "designer-low",
    ".py": "executor-low (simple) or executor (complex)",
    ".vue": "designer",
    ".svelte": "designer",
    ".css": "designer-low",
    ".scss": "designer-low",
    ".md": "writer (documentation)",
    ".json": "executor-low",
  };
  return suggestions[path.extname(filePath).toLowerCase()] ?? "executor";
}

export function buildVerificationReminder(sessionId?: string): string {
  let text = VERIFICATION_REMINDER;
  if (sessionId) {
    text +=
      `\n\n---\n\n**If ANY verification fails, resume the subagent with the fix:**\n` +
      `Task tool with resume="${sessionId}", prompt="fix: [describe the specific failure]"`;
  }
  return text;
}

export function buildOrchestratorReminder(
  planName: string,
  progress: { total: number; completed: number },
  sessionId?: string,
): string {
  const remaining = progress.total - progress.completed;
  return (
    `\n---\n\n**State:** Plan: ${planName} | ${progress.completed}/${progress.total} done, ${remaining} left\n\n---\n\n` +
    buildVerificationReminder(sessionId) +
    `\n\nALL pass? → commit atomic unit, mark \`[x]\`, next task.`
  );
}

export function buildBoulderContinuation(
  planName: string,
  remaining: number,
  total: number,
): string {
  return (
    BOULDER_CONTINUATION_PROMPT.replace(/{PLAN_NAME}/g, planName) +
    `\n\n[Status: ${total - remaining}/${total} completed, ${remaining} remaining]`
  );
}

// ─── <remember> tag processing ────────────────────────────────────────────────

function processRememberTags(output: string, cwd: string): void {
  for (const match of output.matchAll(/<remember\s+priority>([\s\S]*?)<\/remember>/gi)) {
    const content = match[1].trim();
    if (content) setPriorityContext(content, { source: "omc-orchestrator", worktreeRoot: cwd });
  }
  for (const match of output.matchAll(/<remember>([\s\S]*?)<\/remember>/gi)) {
    const content = match[1].trim();
    if (content) addWorkingMemoryEntry(content, { source: "omc-orchestrator", worktreeRoot: cwd });
  }
}

// ─── PreToolUse logic ─────────────────────────────────────────────────────────

function runPreToolUse(ctx: HookContext): HookResult {
  const { toolName, toolArgs, sessionId, cwd } = ctx;
  const enforcementLevel = getEnforcementLevel(cwd);

  if (enforcementLevel === "off") return { kind: "noop" };
  if (!toolName || !isWriteEditTool(toolName)) return { kind: "noop" };

  const args = (toolArgs ?? {}) as Record<string, unknown>;
  const filePath = (
    args.file_path ?? args.filePath ?? args.path ?? args.file ?? args.notebook_path
  ) as string | undefined;

  if (!filePath || isAllowedPath(filePath, cwd)) {
    if (filePath) {
      logAuditEntry(
        { tool: toolName, filePath, decision: "allowed", reason: "allowed_path", enforcementLevel, sessionId },
        cwd,
      );
    }
    return { kind: "noop" };
  }

  const isSource = isSourceFile(filePath);
  const decision = enforcementLevel === "strict" ? "blocked" : "warned";
  logAuditEntry(
    { tool: toolName, filePath, decision, reason: isSource ? "source_file" : "other", enforcementLevel, sessionId },
    cwd,
  );

  const agentSuggestion = suggestAgent(filePath);
  const message =
    ORCHESTRATOR_DELEGATION_REQUIRED.replace("$FILE_PATH", filePath) +
    `\n\nSuggested agent: ${agentSuggestion}`;

  if (enforcementLevel === "strict") {
    return { kind: "block", reason: message };
  }
  return { kind: "advise", text: message };
}

// ─── PostToolUse logic ────────────────────────────────────────────────────────

function runPostToolUse(ctx: HookContext): HookResult {
  const { toolName, toolArgs, toolResult, cwd } = ctx;
  if (!toolName) return { kind: "noop" };

  const output = typeof toolResult === "string" ? toolResult : JSON.stringify(toolResult ?? "");

  // Write/edit tool on non-allowed path — append reminder to result
  if (isWriteEditTool(toolName)) {
    const args = (toolArgs ?? {}) as Record<string, unknown>;
    const filePath = (
      args.file_path ?? args.filePath ?? args.path ?? args.file ?? args.notebook_path
    ) as string | undefined;
    if (filePath && !isAllowedPath(filePath, cwd)) {
      return { kind: "modifiedResult", result: output + DIRECT_WORK_REMINDER };
    }
    return { kind: "noop" };
  }

  // Delegation tool completed — inject verification context
  if (isDelegationTool(toolName)) {
    // Background task launch: skip augmentation
    if (
      output.includes("Background task launched") ||
      output.includes("Background task resumed")
    ) {
      return { kind: "noop" };
    }

    // Process <remember> tags embedded in agent output
    processRememberTags(output, cwd);

    // Boulder state: inject plan-progress reminder
    const boulder = readBoulderState(cwd);
    if (boulder && boulder.active) {
      const progress = getPlanProgress(boulder.activePlan);
      const enhanced =
        `## SUBAGENT WORK COMPLETED\n\n` +
        `<system-reminder>\n${buildOrchestratorReminder(boulder.planName, progress)}\n</system-reminder>`;
      return { kind: "modifiedResult", result: enhanced };
    }

    // No boulder — standalone verification reminder
    return {
      kind: "modifiedResult",
      result: output + `\n<system-reminder>\n${buildVerificationReminder()}\n</system-reminder>`,
    };
  }

  return { kind: "noop" };
}

// ─── Hook factory ─────────────────────────────────────────────────────────────

export function createOmcOrchestratorHook(): Hook {
  return {
    name: HOOK_NAME,
    events: ["PreToolUse", "PostToolUse"],

    async run(ctx: HookContext): Promise<HookResult> {
      if (ctx.event === "PreToolUse") return runPreToolUse(ctx);
      if (ctx.event === "PostToolUse") return runPostToolUse(ctx);
      return { kind: "noop" };
    },
  };
}

export {
  HOOK_NAME,
  ALLOWED_PATH_PATTERNS,
  WARNED_EXTENSIONS,
  WRITE_EDIT_TOOLS,
  DIRECT_WORK_REMINDER,
  ORCHESTRATOR_DELEGATION_REQUIRED,
  BOULDER_CONTINUATION_PROMPT,
  VERIFICATION_REMINDER,
  SINGLE_TASK_DIRECTIVE,
  ENFORCEMENT_LEVEL_ENV_VAR,
  DEFAULT_ENFORCEMENT_LEVEL,
} from "./constants.js";
