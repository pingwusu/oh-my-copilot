// Reference PostToolUse hook bundled with the plugin install.
// Self-contained — no imports from ../src/ or ../dist/, so the file resolves
// cleanly inside ~/.copilot/installed-plugins/oh-my-copilot/oh-my-copilot/hooks/.
//
// Increments an advisory counter in .omcp/state/<sessionId>-counters.json.
// Write-only — never blocks tool execution; swallows all errors to stderr.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

type HookEvent =
  | "PreToolUse"
  | "PostToolUse"
  | "PreSubmit"
  | "PostSubmit"
  | "SessionStart"
  | "PreEnd";

interface HookContext {
  event: HookEvent;
  toolName?: string;
  toolArgs?: unknown;
  toolResult?: unknown;
  sessionId: string;
  cwd: string;
}

type HookResult =
  | { kind: "noop" }
  | { kind: "advise"; text: string }
  | { kind: "block"; reason: string };

interface Hook {
  name: string;
  events: HookEvent[];
  run(ctx: HookContext): Promise<HookResult>;
}

interface CounterFile {
  toolCalls?: number;
  perTool?: Record<string, number>;
  updatedAt?: string;
}

function stateFile(cwd: string, sessionId: string): string {
  return join(cwd, ".omcp", "state", `${sessionId || "default"}-counters.json`);
}

function loadCounters(file: string): CounterFile {
  if (!existsSync(file)) return {};
  try {
    return JSON.parse(readFileSync(file, "utf8")) as CounterFile;
  } catch {
    return {};
  }
}

function saveCounters(file: string, data: CounterFile): void {
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

export const trackStateHook: Hook = {
  name: "post-tool-track-state",
  events: ["PostToolUse"],
  async run(ctx: HookContext): Promise<HookResult> {
    try {
      const file = stateFile(ctx.cwd, ctx.sessionId);
      const data = loadCounters(file);
      data.toolCalls = (data.toolCalls ?? 0) + 1;
      const tool = ctx.toolName ?? "_unknown_";
      data.perTool = data.perTool ?? {};
      data.perTool[tool] = (data.perTool[tool] ?? 0) + 1;
      data.updatedAt = new Date().toISOString();
      saveCounters(file, data);
    } catch (err) {
      process.stderr.write(
        `post-tool-track-state: ${(err as Error).message}\n`,
      );
    }
    return { kind: "noop" };
  },
};

export default trackStateHook;
export const hook = trackStateHook;
