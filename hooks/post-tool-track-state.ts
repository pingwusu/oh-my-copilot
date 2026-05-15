// Reference PostToolUse hook: increments an advisory counter in the per-session
// state file under .omcp/state/. Write-only — never blocks tool execution.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Hook, HookContext, HookResult } from "../src/hooks/hook-types.js";

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
