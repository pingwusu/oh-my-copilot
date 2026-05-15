// `omcp update` — `npm install -g oh-my-copilot@latest` then re-run setup.

import { spawnSync } from "node:child_process";

export interface UpdateReport {
  npmExitCode: number;
  setupExitCode: number;
}

export function runUpdate(): UpdateReport {
  const npm = spawnSync("npm", ["install", "-g", "oh-my-copilot@latest"], {
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  if ((npm.status ?? 1) !== 0) {
    return { npmExitCode: npm.status ?? 1, setupExitCode: -1 };
  }
  const setup = spawnSync("omcp", ["setup", "--force"], {
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  return { npmExitCode: 0, setupExitCode: setup.status ?? 1 };
}
