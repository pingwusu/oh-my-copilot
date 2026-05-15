// `omcp loop <interval> "<cmd>"` — re-invoke a command on a recurring interval
// until cancelled or until a configurable max iteration count.
//
// Examples:
//   omcp loop 5m omcp ralph "fix the failing test"   # every 5 minutes
//   omcp loop 30s npm test                           # every 30 seconds
//   omcp loop --max 10 1m omcp ask claude "status?"  # up to 10 iterations
//
// Cancellation: writes a cancel marker via `omcp cancel` and the loop exits at
// the next iteration boundary. Also exits if .omcp/state/cancel.json exists.

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

export interface LoopOptions {
  interval: string;
  cmd: string[];
  maxIterations?: number;
  onIteration?: (n: number) => void;
}

export function parseInterval(s: string): number {
  const m = s.match(/^(\d+)(ms|s|m|h)?$/);
  if (!m) throw new Error(`bad interval: ${s} (use 30s, 5m, 1h, 200ms)`);
  const n = Number(m[1]);
  const unit = m[2] ?? "s";
  switch (unit) {
    case "ms":
      return n;
    case "s":
      return n * 1000;
    case "m":
      return n * 60_000;
    case "h":
      return n * 3_600_000;
  }
  return n * 1000;
}

function cancelled(): boolean {
  const marker = join(process.cwd(), ".omcp", "state", "cancel.json");
  return existsSync(marker);
}

export async function runLoop(opts: LoopOptions): Promise<number> {
  const intervalMs = parseInterval(opts.interval);
  const max = opts.maxIterations ?? Infinity;
  let i = 0;
  while (i < max) {
    if (cancelled()) {
      console.log(`omcp loop: cancelled after ${i} iterations`);
      return 0;
    }
    i++;
    if (opts.onIteration) opts.onIteration(i);
    const head = opts.cmd[0];
    const rest = opts.cmd.slice(1);
    const r = spawnSync(head, rest, { stdio: "inherit", shell: false });
    if (r.status !== 0) {
      console.error(`omcp loop: iteration ${i} exited ${r.status}`);
    }
    if (i >= max) break;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return 0;
}
