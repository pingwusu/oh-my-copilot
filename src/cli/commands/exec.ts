// `omcp exec <prompt>` — generic non-interactive Copilot invocation.
//
// Sibling of `omcp ask`, but without the `family` positional. Useful when the
// caller already knows which model/agent they want, or just wants the default.
//
// Notable features:
//   --inject <sessionId>   resume an existing copilot session via --resume
//                          (also exposed as `omcp exec inject <sid> <prompt>`)
//   --share                pass copilot's --share flag (publish transcript)
//   --no-allow-all-tools   skip the default --allow-all-tools
//   --silent               -s to copilot
//
// Every invocation is appended as a JSONL row to
// `.omcp/state/exec-history.jsonl` for later audit.

import { type SpawnSyncReturns, spawnSync } from "node:child_process";
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

export interface ExecOptions {
  prompt: string;
  model?: string;
  agent?: string;
  silent?: boolean;
  inject?: string;
  share?: boolean;
  allowAllTools?: boolean;
  /** Test hook — defaults to real spawnSync against `copilot`. */
  spawn?: (
    bin: string,
    args: string[],
  ) => Pick<SpawnSyncReturns<Buffer>, "status">;
  /** Test hook — override cwd used for the history file. */
  cwd?: string;
  /** Test hook — override Date.now / new Date(). */
  now?: () => Date;
}

export interface ExecResult {
  exitCode: number;
  sessionId?: string;
  args: string[];
}

export function runExec(opts: ExecOptions): ExecResult {
  if (!opts.prompt) {
    console.error("omcp exec: <prompt> is required");
    return { exitCode: 2, args: [] };
  }

  const args: string[] = ["-p", opts.prompt];
  if (opts.model) args.push("--model", opts.model);
  if (opts.agent) args.push("--agent", opts.agent);
  if (opts.allowAllTools !== false) args.push("--allow-all-tools");
  if (opts.silent) args.push("-s");
  if (opts.share) args.push("--share");
  if (opts.inject) args.push(`--resume=${opts.inject}`);

  const cwd = opts.cwd ?? process.cwd();
  const t0 = Date.now();
  const doSpawn =
    opts.spawn ??
    ((bin: string, a: string[]) =>
      spawnSync(bin, a, { stdio: "inherit", shell: false }));
  const result = doSpawn("copilot", args);
  const exitCode = result.status ?? 1;
  const durationMs = Date.now() - t0;

  appendHistory(cwd, {
    t: (opts.now?.() ?? new Date()).toISOString(),
    prompt: opts.prompt,
    model: opts.model,
    agent: opts.agent,
    sessionId: opts.inject,
    exitCode,
    durationMs,
  });

  return { exitCode, sessionId: opts.inject, args };
}

export interface ExecHistoryRow {
  t: string;
  prompt: string;
  model?: string;
  agent?: string;
  sessionId?: string;
  exitCode: number;
  durationMs: number;
}

export function execHistoryPath(cwd: string = process.cwd()): string {
  return join(cwd, ".omcp", "state", "exec-history.jsonl");
}

function appendHistory(cwd: string, row: ExecHistoryRow): void {
  const path = execHistoryPath(cwd);
  try {
    mkdirSync(join(cwd, ".omcp", "state"), { recursive: true });
    appendFileSync(path, `${JSON.stringify(row)}\n`, "utf8");
  } catch {
    // History is best-effort; never break exec on disk failure.
  }
}
