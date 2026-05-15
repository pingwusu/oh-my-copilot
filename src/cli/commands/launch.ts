// `omcp launch [extra args]` — bare launch wraps `copilot` with omcp's
// preferred defaults (allow-all-tools, mode etc.), mirroring `omc`/`omx`
// bare-command behavior.

import { spawnSync } from "node:child_process";

export interface LaunchOptions {
  args: string[];
  autopilot?: boolean;
  allowAllTools?: boolean;
}

export function runLaunch(opts: LaunchOptions): number {
  const args = [...opts.args];
  if (opts.autopilot) args.push("--autopilot");
  if (opts.allowAllTools !== false && !args.includes("--allow-all-tools")) {
    args.push("--allow-all-tools");
  }
  const result = spawnSync("copilot", args, { stdio: "inherit", shell: false });
  return result.status ?? 1;
}
