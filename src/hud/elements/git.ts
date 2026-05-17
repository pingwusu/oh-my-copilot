// Git element — renders repo:NAME branch:BRANCH if available.
// Caches per-cwd for the lifetime of a process (HUD scripts are short-lived).

import { execSync } from "node:child_process";
import { cyan, dim } from "../colors.js";
import type { HudState } from "../types.js";

const repoCache = new Map<string, string | null>();
const branchCache = new Map<string, string | null>();

function safeGit(cmd: string, cwd: string): string | null {
  try {
    const out = execSync(cmd, {
      cwd,
      encoding: "utf8",
      timeout: 1000,
      stdio: ["pipe", "pipe", "pipe"],
      shell: process.platform === "win32" ? "cmd.exe" : undefined,
    }).trim();
    return out || null;
  } catch {
    return null;
  }
}

export function resetGitCache(): void {
  repoCache.clear();
  branchCache.clear();
}

export function getRepoName(cwd: string): string | null {
  if (repoCache.has(cwd)) return repoCache.get(cwd) ?? null;
  const url = safeGit("git remote get-url origin", cwd);
  let name: string | null = null;
  if (url) {
    const m =
      url.match(/\/([^/]+?)(?:\.git)?$/) || url.match(/:([^/]+?)(?:\.git)?$/);
    name = m ? m[1].replace(/\.git$/, "") : null;
  }
  repoCache.set(cwd, name);
  return name;
}

export function getBranch(cwd: string): string | null {
  if (branchCache.has(cwd)) return branchCache.get(cwd) ?? null;
  const b = safeGit("git branch --show-current", cwd);
  branchCache.set(cwd, b);
  return b;
}

export function renderGit(state: HudState): string | null {
  const repo = getRepoName(state.cwd);
  const branch = getBranch(state.cwd);
  if (!repo && !branch) return null;
  const parts: string[] = [];
  if (repo) parts.push(`${dim("repo:", state.env)}${cyan(repo, state.env)}`);
  if (branch)
    parts.push(`${dim("branch:", state.env)}${cyan(branch, state.env)}`);
  return parts.join(" ");
}
