// `omcp teleport <issue-ref>` — create a git worktree for an isolated copy of
// the current repo and (if tmux is available) open it in a new pane running
// `copilot --autopilot`. Ported from omc's teleport command but slimmed down
// for omcp's narrower surface.
//
// Worktree root defaults to `~/Workspace/omcp-worktrees/` and can be overridden
// with `OMCP_TELEPORT_ROOT`.

import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative } from "node:path";

export interface TeleportOptions {
  // Optional override for the worktree root directory. If not provided we use
  // OMCP_TELEPORT_ROOT env var, then fall back to ~/Workspace/omcp-worktrees/.
  worktreeRoot?: string;
  // Base branch to fork from when creating the new branch. Defaults to "main".
  base?: string;
  // Optional override for the source repo root. If not provided we resolve via
  // `git rev-parse --show-toplevel` from process.cwd().
  repoRoot?: string;
  // Skip the tmux launch (still creates the worktree). Defaults to false.
  noTmux?: boolean;
}

export interface TeleportResult {
  ok: boolean;
  slug: string;
  worktreePath: string;
  branch: string;
  launched: "tmux" | "skipped";
  error?: string;
}

export interface TeleportEntry {
  slug: string;
  path: string;
  branch: string;
}

export function defaultWorktreeRoot(): string {
  const override = process.env.OMCP_TELEPORT_ROOT;
  if (override && override.trim().length > 0) return override;
  return join(homedir(), "Workspace", "omcp-worktrees");
}

export function sanitizeSlug(input: string, maxLen = 30): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, maxLen);
}

// Parse an issue/PR/feature ref into a worktree slug + branch name. We avoid
// network calls so this command works offline; omc's version fetches PR titles
// via the gh CLI, but omcp keeps it local.
export function refToSlug(ref: string): { slug: string; branch: string } {
  const hashMatch = ref.match(/^#?(\d+)$/);
  if (hashMatch) {
    const n = hashMatch[1];
    return { slug: `issue-${n}`, branch: `fix/${n}` };
  }
  const ghIssueUrl = ref.match(/github\.com\/[^/]+\/[^/]+\/issues\/(\d+)/);
  if (ghIssueUrl) {
    const n = ghIssueUrl[1];
    return { slug: `issue-${n}`, branch: `fix/${n}` };
  }
  const ghPrUrl = ref.match(/github\.com\/[^/]+\/[^/]+\/pull\/(\d+)/);
  if (ghPrUrl) {
    const n = ghPrUrl[1];
    return { slug: `pr-${n}`, branch: `pr/${n}-review` };
  }
  const safe = sanitizeSlug(ref) || "feature";
  return { slug: `feat-${safe}`, branch: `feat/${safe}` };
}

function tmuxAvailable(): boolean {
  const r = spawnSync(process.platform === "win32" ? "where" : "which", ["tmux"], {
    encoding: "utf8",
  });
  return r.status === 0 && r.stdout.trim().length > 0;
}

function resolveRepoRoot(opts: TeleportOptions): string | null {
  if (opts.repoRoot) return opts.repoRoot;
  try {
    const out = execFileSync("git", ["rev-parse", "--show-toplevel"], {
      encoding: "utf8",
      cwd: process.cwd(),
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
    return out.length > 0 ? out : null;
  } catch {
    return null;
  }
}

// Create the worktree using `git worktree add`. The branch is created from the
// requested base. Returns { ok, error? } so the caller can surface the failure
// without throwing — useful when tmux fallback is in play.
export function createWorktree(args: {
  repoRoot: string;
  worktreePath: string;
  branch: string;
  base: string;
}): { ok: boolean; error?: string } {
  const { repoRoot, worktreePath, branch, base } = args;
  try {
    if (existsSync(worktreePath)) {
      return { ok: false, error: `worktree already exists at ${worktreePath}` };
    }
    mkdirSync(join(worktreePath, ".."), { recursive: true });
    execFileSync("git", ["worktree", "add", "-b", branch, worktreePath, base], {
      cwd: repoRoot,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export function runTeleport(
  ref: string,
  options: TeleportOptions = {},
): TeleportResult {
  const root = options.worktreeRoot ?? defaultWorktreeRoot();
  const { slug, branch } = refToSlug(ref);
  const worktreePath = join(root, slug);
  const base = options.base ?? "main";

  const repoRoot = resolveRepoRoot(options);
  if (!repoRoot) {
    return {
      ok: false,
      slug,
      worktreePath,
      branch,
      launched: "skipped",
      error: "not inside a git repository",
    };
  }

  const created = createWorktree({ repoRoot, worktreePath, branch, base });
  if (!created.ok) {
    return {
      ok: false,
      slug,
      worktreePath,
      branch,
      launched: "skipped",
      error: created.error,
    };
  }

  let launched: "tmux" | "skipped" = "skipped";
  if (!options.noTmux && tmuxAvailable()) {
    const sessionName = `omcp-teleport-${slug}`;
    spawnSync(
      "tmux",
      [
        "new-session",
        "-d",
        "-s",
        sessionName,
        "-c",
        worktreePath,
        "copilot --autopilot",
      ],
      { stdio: "inherit" },
    );
    launched = "tmux";
  }

  return { ok: true, slug, worktreePath, branch, launched };
}

export function listTeleports(rootOverride?: string): TeleportEntry[] {
  const root = rootOverride ?? defaultWorktreeRoot();
  if (!existsSync(root)) return [];
  const out: TeleportEntry[] = [];
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return [];
  }
  for (const slug of entries) {
    const p = join(root, slug);
    try {
      if (!statSync(p).isDirectory()) continue;
    } catch {
      continue;
    }
    let branch = "(unknown)";
    try {
      branch = execFileSync("git", ["branch", "--show-current"], {
        cwd: p,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      }).trim();
    } catch {
      // Not a worktree — surface it anyway so the user can clean it up.
    }
    out.push({ slug, path: p, branch });
  }
  out.sort((a, b) => a.slug.localeCompare(b.slug));
  return out;
}

export interface TeleportRemoveResult {
  ok: boolean;
  path: string;
  error?: string;
}

export function removeTeleport(
  slugOrPath: string,
  rootOverride?: string,
): TeleportRemoveResult {
  const root = rootOverride ?? defaultWorktreeRoot();
  const target = isAbsolute(slugOrPath) ? slugOrPath : join(root, slugOrPath);

  // Refuse to delete anything outside the configured root — guards against a
  // typo'd absolute path nuking unrelated files.
  const rel = relative(root, target);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    return {
      ok: false,
      path: target,
      error: `refusing to remove path outside ${root}`,
    };
  }

  if (!existsSync(target)) {
    return { ok: false, path: target, error: "worktree not found" };
  }

  // Best-effort `git worktree remove` first; if that fails (e.g. not a real
  // worktree) fall back to plain rm so list/remove is symmetric.
  const repoRoot = resolveRepoRoot({});
  if (repoRoot) {
    const r = spawnSync("git", ["worktree", "remove", "--force", target], {
      cwd: repoRoot,
      stdio: "pipe",
    });
    if (r.status === 0) return { ok: true, path: target };
  }
  try {
    rmSync(target, { recursive: true, force: true });
    return { ok: true, path: target };
  } catch (err) {
    return {
      ok: false,
      path: target,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export function formatTeleportList(entries: TeleportEntry[]): string {
  if (entries.length === 0) return "omcp teleport: no worktrees found";
  const lines = [`omcp teleport (${entries.length}):`];
  for (const e of entries) {
    lines.push(`  ${e.slug}  [${e.branch}]  ${e.path}`);
  }
  return lines.join("\n");
}
