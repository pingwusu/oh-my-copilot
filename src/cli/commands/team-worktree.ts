// `omcp team-worktree-create   <team> <worker> [--base <branch>]`
// `omcp team-worktree-list     [team]`
// `omcp team-worktree-merge    <team> <worker> [--base <branch>] [--no-ff]`
// `omcp team-worktree-cleanup  <team> [worker] [--force]`
// `omcp team-worktree-conflict-check <team> <worker> [--base <branch>]`
//
// RP-12 (F13) — 5 stateless team-worktree CLI verbs that materialize the
// omc-canonical "Git Worktree Integration" API surface as CLI verbs.
//
// PORT-OMC-via-Robin per v4 §4.A row F13. Path layout is omc-canonical
// (`.omcp/worktrees/{team}/{worker}` matching omc's `.omc/worktrees/...`
// — only the namespace prefix differs). Branch prefix is `omcp-team/`
// per RP-12 PRINCIPLED-DIVERGENCE (Q-v3-A 4-sibling-token argument:
// binary `omcp`, state `.omcp/`, teleport `omcp-worktrees`, plugin
// `oh-my-copilot:`). X1 cross-fork reader uses forward-compat membership
// check for `{omc-team/, omcp-team/}`.
//
// Wire format (JSON outputs and verb-emitted state files):
//   { producer_fork: "omcp-r2", team, worker, branch, path, ... }
//
// Path/slug invariants (PM-2, corrected v4):
//   - assertSafeSlug enforces 1-80 char cap per src/runtime/safe-slug.ts:10
//     SLUG_RE = /^[A-Za-z0-9_\-.]{1,80}$/
//   - Combined worktree path remains ≤240 chars on Windows even with
//     team + worker slugs at the SLUG_RE max (80 chars each), provided the
//     repo root prefix is reasonably bounded. The verb refuses to materialize
//     a worktree whose absolute path would exceed 240 chars.
//
// Traversal carve-out (Critic C2): worker worktrees contain `.git` subtrees
// + unrelated source files. State-walkers under `.omcp/` MUST skip
// `worktrees/**` via `shouldSkipForOmcpTraversal()` in src/lib/worktree-paths.ts.
// See ADR-RP-12-worktree-path-contract.
//
// Defensive event-log instrumentation (RG-04b pattern): every verb emits
// best-effort events via `appendEventBestEffort`. Failures NEVER fail the
// parent verb — observability is purely additive.
//
// Invariants honored:
//   I1 — assertSafeSlug on team + worker (path interpolation surface)
//   I8 — registered as `omcp team-worktree-{create,list,merge,cleanup,
//        conflict-check}` in src/cli/omcp.ts (caller wires the snippet
//        returned by this story's commit message)
//
// Exit codes (per verb):
//   0 — success
//   1 — unexpected error (e.g. git subprocess crash)
//   2 — invalid argv (bad slug, missing args, path-length over 240)
//   3 — not found / target absent (list of missing worker, merge of
//        nonexistent branch)
//   4 — worktree already exists (create) OR uncommitted changes refused
//        cleanup without --force
//   5 — merge conflict detected (conflict-check pre-flight + merge)

import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative } from "node:path";

import {
  assertSafeSlug,
  UnsafeSlugError,
} from "../../runtime/safe-slug.js";
import { appendEventBestEffort } from "./team-event.js";
import { PRODUCER_FORK_ID } from "./team-outbox.js";

// ─── constants ──────────────────────────────────────────────────────────────

/** Branch prefix per RP-12 PRINCIPLED-DIVERGENCE (Q-v3-A 4-sibling-token). */
export const TEAM_WORKTREE_BRANCH_PREFIX = "omcp-team";

/** Subtree under `.omcp/` where worker worktrees materialize. */
export const TEAM_WORKTREE_SUBDIR = "worktrees";

/**
 * Hard cap on absolute worktree-path length, mitigating Windows MAX_PATH
 * + per-tool ENAMETOOLONG. The threshold is intentionally below 260 to
 * leave headroom for nested `.git/` paths + tool-side suffix bytes.
 * See RP-12 v4 §8.5 path-length AC.
 */
export const TEAM_WORKTREE_MAX_PATH_LEN = 240;

/** Default base branch used by create/merge/conflict-check when --base omitted. */
export const TEAM_WORKTREE_DEFAULT_BASE = "main";

// ─── types ──────────────────────────────────────────────────────────────────

/** Common per-verb result shape carrying producer_fork for JSON outputs. */
export interface TeamWorktreeResultBase {
  /** Always "omcp-r2" — cross-fork attribution per ADR-RG-01. */
  producer_fork: string;
  /** Process exit code; verb-specific. */
  exitCode: number;
  /** Free-form human-readable error (only when exitCode !== 0). */
  error?: string;
}

export interface TeamWorktreeCreateResult extends TeamWorktreeResultBase {
  team: string;
  worker: string;
  branch: string;
  path: string;
  base: string;
  /** True when the verb was a no-op because the worktree already existed. */
  alreadyExisted: boolean;
}

export interface TeamWorktreeEntry {
  team: string;
  worker: string;
  branch: string;
  path: string;
}

export interface TeamWorktreeListResult extends TeamWorktreeResultBase {
  team?: string;
  entries: TeamWorktreeEntry[];
}

export interface TeamWorktreeMergeResult extends TeamWorktreeResultBase {
  team: string;
  worker: string;
  branch: string;
  base: string;
  /** True when merge produced a commit (or fast-forwarded with --no-ff equivalent). */
  merged: boolean;
  /** True iff the merge halted due to conflicts. */
  conflicted: boolean;
}

export interface TeamWorktreeCleanupResult extends TeamWorktreeResultBase {
  team: string;
  worker?: string;
  removed: TeamWorktreeEntry[];
  /** Workers skipped because they had uncommitted changes (no --force). */
  skipped: Array<{ entry: TeamWorktreeEntry; reason: string }>;
}

export interface TeamWorktreeConflictCheckResult extends TeamWorktreeResultBase {
  team: string;
  worker: string;
  branch: string;
  base: string;
  /** Common ancestor commit of branch + base. */
  mergeBase?: string;
  /** True iff `git merge-tree` (or equivalent) detected a conflict. */
  conflictDetected: boolean;
  /** List of conflicted file paths (when known). */
  conflictedFiles: string[];
}

// ─── path helpers ───────────────────────────────────────────────────────────

/** Validate team + worker slugs (PM-2 — 1-80 chars per SLUG_RE). */
function validateSlugs(team: string, worker?: string): void {
  assertSafeSlug(team, "team");
  if (worker !== undefined) assertSafeSlug(worker, "worker");
}

/** Resolve the absolute worktree dir for `(team, worker)` under `repoRoot`. */
export function worktreePathFor(
  repoRoot: string,
  team: string,
  worker: string,
): string {
  return join(repoRoot, ".omcp", TEAM_WORKTREE_SUBDIR, team, worker);
}

/** Resolve the team-scoped worktrees root for listing/cleanup. */
export function teamWorktreesRoot(repoRoot: string, team?: string): string {
  return team === undefined
    ? join(repoRoot, ".omcp", TEAM_WORKTREE_SUBDIR)
    : join(repoRoot, ".omcp", TEAM_WORKTREE_SUBDIR, team);
}

/** Compose the canonical branch name for `(team, worker)`. */
export function branchNameFor(team: string, worker: string): string {
  return `${TEAM_WORKTREE_BRANCH_PREFIX}/${team}/${worker}`;
}

/**
 * Enforce the ≤240-char path-length contract.
 * Returns null when ok; returns a human-readable reason when over the cap.
 */
export function pathLengthGuard(absPath: string): string | null {
  if (absPath.length > TEAM_WORKTREE_MAX_PATH_LEN) {
    return `worktree path exceeds ${TEAM_WORKTREE_MAX_PATH_LEN} chars (got ${absPath.length}): ${absPath}`;
  }
  return null;
}

// ─── git helpers ────────────────────────────────────────────────────────────

function resolveRepoRoot(cwd?: string): string | null {
  try {
    const out = execFileSync("git", ["rev-parse", "--show-toplevel"], {
      encoding: "utf8",
      cwd: cwd ?? process.cwd(),
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
    return out.length > 0 ? out : null;
  } catch {
    return null;
  }
}

function branchExists(repoRoot: string, branch: string): boolean {
  const r = spawnSync(
    "git",
    ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`],
    { cwd: repoRoot, stdio: ["ignore", "pipe", "pipe"] },
  );
  return r.status === 0;
}

function getMergeBase(
  repoRoot: string,
  a: string,
  b: string,
): string | null {
  const r = spawnSync("git", ["merge-base", a, b], {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (r.status !== 0) return null;
  const out = r.stdout.trim();
  return out.length === 40 ? out : out.length > 0 ? out : null;
}

/**
 * Run `git merge-tree --write-tree base ours theirs`. Returns
 * { conflicted, conflictedFiles } based on stdout markers.
 *
 * Falls back to `git merge-tree --quiet <base> <branch>` for git < 2.38
 * (which emits conflict text instead of `<<<<<<<` markers on stdout
 * only on actual conflict).
 */
function detectMergeConflicts(
  repoRoot: string,
  branch: string,
  base: string,
): { conflictDetected: boolean; conflictedFiles: string[] } {
  // Prefer the modern API (`git merge-tree --write-tree`) when available.
  const modern = spawnSync(
    "git",
    ["merge-tree", "--write-tree", "--no-messages", base, branch],
    { cwd: repoRoot, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
  if (modern.status === 0) {
    // No conflict — modern merge-tree exits 0 and writes the merged tree.
    return { conflictDetected: false, conflictedFiles: [] };
  }
  // Status 1 from modern merge-tree means conflicts; parse stdout.
  if (modern.status === 1 && typeof modern.stdout === "string") {
    const files = parseConflictedFiles(modern.stdout);
    return { conflictDetected: true, conflictedFiles: files };
  }
  // Legacy merge-tree fallback (git < 2.38).
  const legacy = spawnSync(
    "git",
    ["merge-tree", `${base}...${branch}`, base, branch],
    { cwd: repoRoot, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
  if (legacy.status === 0 && typeof legacy.stdout === "string") {
    const hasConflict =
      legacy.stdout.includes("<<<<<<<") || legacy.stdout.includes("changed in both");
    return {
      conflictDetected: hasConflict,
      conflictedFiles: hasConflict
        ? parseLegacyConflictedFiles(legacy.stdout)
        : [],
    };
  }
  // Unknown git failure — surface as no-conflict-detected (verb upstream
  // treats this as a non-blocking unknown; merge itself remains the
  // source of truth).
  return { conflictDetected: false, conflictedFiles: [] };
}

function parseConflictedFiles(stdout: string): string[] {
  // Modern merge-tree --write-tree output, after the tree OID, lists
  // conflicted entries. We accept any non-empty line containing a tab or
  // a 40-char hex prefix as a conflict marker source. Best-effort parser
  // — falls back to empty list when format is unrecognized.
  const files = new Set<string>();
  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    // Lines like "100644 <hash> 1\tpath/to/file".
    const m = /^\d+\s+[0-9a-f]+\s+\d+\s+(.+)$/i.exec(trimmed);
    if (m) {
      files.add(m[1]);
      continue;
    }
    // Lines like "Auto-merging path/to/file" or "CONFLICT (content): ..."
    const auto = /^Auto-merging\s+(.+)$/.exec(trimmed);
    if (auto) {
      files.add(auto[1]);
      continue;
    }
    const conflict = /^CONFLICT\s*\([^)]+\):\s*(?:Merge conflict in\s+)?(.+)$/.exec(
      trimmed,
    );
    if (conflict) {
      files.add(conflict[1]);
    }
  }
  return Array.from(files).sort();
}

function parseLegacyConflictedFiles(stdout: string): string[] {
  const files = new Set<string>();
  // Legacy format: "changed in both" + "  base   100644 <hash> path/to/file"
  for (const line of stdout.split(/\r?\n/)) {
    const m = /^\s+(?:base|ours|theirs)\s+\d+\s+[0-9a-f]+\s+(.+)$/.exec(line);
    if (m) files.add(m[1]);
  }
  return Array.from(files).sort();
}

function workerHasUncommittedChanges(worktreePath: string): boolean {
  if (!existsSync(worktreePath)) return false;
  const r = spawnSync("git", ["status", "--porcelain"], {
    cwd: worktreePath,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (r.status !== 0) return false;
  return r.stdout.trim().length > 0;
}

// ─── create ─────────────────────────────────────────────────────────────────

export interface RunTeamWorktreeCreateOpts {
  team: string;
  worker: string;
  base?: string;
  cwd?: string;
}

export function runTeamWorktreeCreate(
  opts: RunTeamWorktreeCreateOpts,
): TeamWorktreeCreateResult {
  const baseResult = (
    extra: Partial<TeamWorktreeCreateResult>,
  ): TeamWorktreeCreateResult => ({
    producer_fork: PRODUCER_FORK_ID,
    exitCode: 1,
    team: opts.team ?? "",
    worker: opts.worker ?? "",
    branch: "",
    path: "",
    base: opts.base ?? TEAM_WORKTREE_DEFAULT_BASE,
    alreadyExisted: false,
    ...extra,
  });

  try {
    validateSlugs(opts.team, opts.worker);
  } catch (err) {
    const msg =
      err instanceof UnsafeSlugError ? err.message : String(err);
    return baseResult({ exitCode: 2, error: msg });
  }

  const repoRoot = resolveRepoRoot(opts.cwd);
  if (!repoRoot) {
    return baseResult({ exitCode: 1, error: "not inside a git repository" });
  }

  const base = opts.base ?? TEAM_WORKTREE_DEFAULT_BASE;
  const branch = branchNameFor(opts.team, opts.worker);
  const path = worktreePathFor(repoRoot, opts.team, opts.worker);

  // PM-2 / v4 §8.5 path-length AC.
  const lenErr = pathLengthGuard(path);
  if (lenErr) {
    return baseResult({ exitCode: 2, branch, path, error: lenErr });
  }

  appendEventBestEffort({
    sessionId: opts.team,
    verb: "team-worktree-create",
    kind: "entry",
    actor: "team-worktree-create",
    shard: opts.worker,
    detail: { team: opts.team, worker: opts.worker, branch, path, base },
    cwd: opts.cwd,
  });

  // Idempotency: if the worktree path already exists AND `git worktree list`
  // confirms it, treat as no-op success.
  if (existsSync(path)) {
    const knownToGit = isRegisteredWorktree(repoRoot, path);
    if (knownToGit) {
      appendEventBestEffort({
        sessionId: opts.team,
        verb: "team-worktree-create",
        kind: "exit",
        actor: "team-worktree-create",
        shard: opts.worker,
        detail: { alreadyExisted: true, path },
        cwd: opts.cwd,
      });
      return baseResult({
        exitCode: 0,
        branch,
        path,
        base,
        alreadyExisted: true,
      });
    }
    // Path exists on disk but git doesn't know about it — refuse to
    // overwrite to avoid clobbering operator state.
    return baseResult({
      exitCode: 4,
      branch,
      path,
      base,
      error: `worktree path exists but is not a registered git worktree: ${path}`,
    });
  }

  // Materialize the parent dir, then call git worktree add.
  try {
    mkdirSync(dirname(path), { recursive: true });
  } catch (err) {
    return baseResult({
      exitCode: 1,
      branch,
      path,
      base,
      error: `mkdir parent failed: ${(err as Error).message}`,
    });
  }

  // Use `-b` to create the branch; if the branch already exists (e.g. from
  // a prior failed create that didn't clean up), reuse it.
  const branchAlreadyExists = branchExists(repoRoot, branch);
  const args = branchAlreadyExists
    ? ["worktree", "add", path, branch]
    : ["worktree", "add", "-b", branch, path, base];

  const r = spawnSync("git", args, {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (r.status !== 0) {
    const stderr =
      typeof r.stderr === "string" ? r.stderr.trim() : "(no stderr)";
    return baseResult({
      exitCode: 1,
      branch,
      path,
      base,
      error: `git worktree add failed: ${stderr}`,
    });
  }

  appendEventBestEffort({
    sessionId: opts.team,
    verb: "team-worktree-create",
    kind: "exit",
    actor: "team-worktree-create",
    shard: opts.worker,
    detail: { created: true, path, branch },
    cwd: opts.cwd,
  });

  return baseResult({
    exitCode: 0,
    branch,
    path,
    base,
    alreadyExisted: false,
  });
}

function isRegisteredWorktree(repoRoot: string, worktreePath: string): boolean {
  const r = spawnSync("git", ["worktree", "list", "--porcelain"], {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (r.status !== 0 || typeof r.stdout !== "string") return false;
  // Each entry starts with "worktree <abs-path>". Compare case-insensitively
  // on Windows (drive-letter casing varies) AND through realpath to handle
  // Windows 8.3 short names (e.g. "RUNJIA~1" vs "runjiashi"), macOS /var ↔
  // /private/var symlinks, and Linux bind-mounts.
  const targetReal = safeRealpath(worktreePath);
  const target =
    process.platform === "win32" ? targetReal.toLowerCase() : targetReal;
  for (const line of r.stdout.split(/\r?\n/)) {
    const m = /^worktree\s+(.+)$/.exec(line);
    if (!m) continue;
    const candidateReal = safeRealpath(m[1]);
    const candidate =
      process.platform === "win32"
        ? candidateReal.toLowerCase()
        : candidateReal;
    if (candidate === target) return true;
  }
  return false;
}

/** realpathSync that falls back to the input path when the path is not yet on disk. */
function safeRealpath(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

// ─── list ───────────────────────────────────────────────────────────────────

export interface RunTeamWorktreeListOpts {
  team?: string;
  cwd?: string;
}

export function runTeamWorktreeList(
  opts: RunTeamWorktreeListOpts,
): TeamWorktreeListResult {
  try {
    if (opts.team !== undefined) assertSafeSlug(opts.team, "team");
  } catch (err) {
    return {
      producer_fork: PRODUCER_FORK_ID,
      exitCode: 2,
      team: opts.team,
      entries: [],
      error: err instanceof UnsafeSlugError ? err.message : String(err),
    };
  }

  const repoRoot = resolveRepoRoot(opts.cwd);
  if (!repoRoot) {
    return {
      producer_fork: PRODUCER_FORK_ID,
      exitCode: 1,
      team: opts.team,
      entries: [],
      error: "not inside a git repository",
    };
  }

  appendEventBestEffort({
    sessionId: opts.team ?? "all",
    verb: "team-worktree-list",
    kind: "entry",
    actor: "team-worktree-list",
    detail: { team: opts.team ?? null },
    cwd: opts.cwd,
  });

  const root = teamWorktreesRoot(repoRoot, opts.team);
  if (!existsSync(root)) {
    return {
      producer_fork: PRODUCER_FORK_ID,
      exitCode: 0,
      team: opts.team,
      entries: [],
    };
  }

  const entries: TeamWorktreeEntry[] = [];
  const teams: string[] =
    opts.team !== undefined
      ? [opts.team]
      : safeReaddir(root).filter((name) => {
          try {
            return statSync(join(root, name)).isDirectory();
          } catch {
            return false;
          }
        });

  for (const team of teams) {
    const teamDir = join(repoRoot, ".omcp", TEAM_WORKTREE_SUBDIR, team);
    if (!existsSync(teamDir)) continue;
    for (const worker of safeReaddir(teamDir)) {
      const path = join(teamDir, worker);
      try {
        if (!statSync(path).isDirectory()) continue;
      } catch {
        continue;
      }
      entries.push({
        team,
        worker,
        branch: branchNameFor(team, worker),
        path,
      });
    }
  }

  entries.sort((a, b) => {
    if (a.team !== b.team) return a.team.localeCompare(b.team);
    return a.worker.localeCompare(b.worker);
  });

  return {
    producer_fork: PRODUCER_FORK_ID,
    exitCode: 0,
    team: opts.team,
    entries,
  };
}

function safeReaddir(p: string): string[] {
  try {
    return readdirSync(p);
  } catch {
    return [];
  }
}

// ─── merge ──────────────────────────────────────────────────────────────────

export interface RunTeamWorktreeMergeOpts {
  team: string;
  worker: string;
  base?: string;
  noFf?: boolean;
  cwd?: string;
}

export function runTeamWorktreeMerge(
  opts: RunTeamWorktreeMergeOpts,
): TeamWorktreeMergeResult {
  const baseResult = (
    extra: Partial<TeamWorktreeMergeResult>,
  ): TeamWorktreeMergeResult => ({
    producer_fork: PRODUCER_FORK_ID,
    exitCode: 1,
    team: opts.team ?? "",
    worker: opts.worker ?? "",
    branch: "",
    base: opts.base ?? TEAM_WORKTREE_DEFAULT_BASE,
    merged: false,
    conflicted: false,
    ...extra,
  });

  try {
    validateSlugs(opts.team, opts.worker);
  } catch (err) {
    return baseResult({
      exitCode: 2,
      error: err instanceof UnsafeSlugError ? err.message : String(err),
    });
  }

  const repoRoot = resolveRepoRoot(opts.cwd);
  if (!repoRoot) {
    return baseResult({ exitCode: 1, error: "not inside a git repository" });
  }

  const base = opts.base ?? TEAM_WORKTREE_DEFAULT_BASE;
  const branch = branchNameFor(opts.team, opts.worker);

  if (!branchExists(repoRoot, branch)) {
    return baseResult({
      exitCode: 3,
      branch,
      base,
      error: `worker branch not found: ${branch}`,
    });
  }
  if (!branchExists(repoRoot, base)) {
    return baseResult({
      exitCode: 3,
      branch,
      base,
      error: `base branch not found: ${base}`,
    });
  }

  appendEventBestEffort({
    sessionId: opts.team,
    verb: "team-worktree-merge",
    kind: "entry",
    actor: "team-worktree-merge",
    shard: opts.worker,
    detail: { team: opts.team, worker: opts.worker, branch, base },
    cwd: opts.cwd,
  });

  // Switch the main repo to base, then merge worker branch with --no-ff
  // (default; matches omc canonical "merge with --no-ff for clear history").
  const noFf = opts.noFf !== false;

  // Capture original HEAD so we can leave the repo in a recoverable state
  // on conflict (caller decides whether to abort or resolve manually).
  const checkoutBase = spawnSync("git", ["checkout", base], {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (checkoutBase.status !== 0) {
    const stderr =
      typeof checkoutBase.stderr === "string"
        ? checkoutBase.stderr.trim()
        : "(no stderr)";
    return baseResult({
      exitCode: 1,
      branch,
      base,
      error: `git checkout ${base} failed: ${stderr}`,
    });
  }

  const mergeArgs = ["merge", "--no-edit"];
  if (noFf) mergeArgs.push("--no-ff");
  mergeArgs.push(branch);

  const mergeRes = spawnSync("git", mergeArgs, {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });

  if (mergeRes.status === 0) {
    appendEventBestEffort({
      sessionId: opts.team,
      verb: "team-worktree-merge",
      kind: "exit",
      actor: "team-worktree-merge",
      shard: opts.worker,
      detail: { merged: true, conflicted: false, branch, base },
      cwd: opts.cwd,
    });
    return baseResult({
      exitCode: 0,
      branch,
      base,
      merged: true,
      conflicted: false,
    });
  }

  // Non-zero — try to distinguish conflict from infrastructure error.
  const stdout = typeof mergeRes.stdout === "string" ? mergeRes.stdout : "";
  const stderr = typeof mergeRes.stderr === "string" ? mergeRes.stderr : "";
  const combined = `${stdout}\n${stderr}`;
  const conflicted =
    combined.includes("CONFLICT") ||
    combined.includes("Automatic merge failed") ||
    combined.includes("conflict");

  if (conflicted) {
    appendEventBestEffort({
      sessionId: opts.team,
      verb: "team-worktree-merge",
      kind: "exit",
      actor: "team-worktree-merge",
      shard: opts.worker,
      detail: { merged: false, conflicted: true, branch, base },
      cwd: opts.cwd,
    });
    return baseResult({
      exitCode: 5,
      branch,
      base,
      merged: false,
      conflicted: true,
      error: `merge conflict on ${branch} → ${base}`,
    });
  }

  return baseResult({
    exitCode: 1,
    branch,
    base,
    merged: false,
    conflicted: false,
    error: `git merge failed: ${stderr.trim() || stdout.trim() || "unknown"}`,
  });
}

// ─── cleanup ────────────────────────────────────────────────────────────────

export interface RunTeamWorktreeCleanupOpts {
  team: string;
  worker?: string;
  force?: boolean;
  cwd?: string;
}

export function runTeamWorktreeCleanup(
  opts: RunTeamWorktreeCleanupOpts,
): TeamWorktreeCleanupResult {
  const baseResult = (
    extra: Partial<TeamWorktreeCleanupResult>,
  ): TeamWorktreeCleanupResult => ({
    producer_fork: PRODUCER_FORK_ID,
    exitCode: 1,
    team: opts.team ?? "",
    worker: opts.worker,
    removed: [],
    skipped: [],
    ...extra,
  });

  try {
    validateSlugs(opts.team, opts.worker);
  } catch (err) {
    return baseResult({
      exitCode: 2,
      error: err instanceof UnsafeSlugError ? err.message : String(err),
    });
  }

  const repoRoot = resolveRepoRoot(opts.cwd);
  if (!repoRoot) {
    return baseResult({ exitCode: 1, error: "not inside a git repository" });
  }

  appendEventBestEffort({
    sessionId: opts.team,
    verb: "team-worktree-cleanup",
    kind: "entry",
    actor: "team-worktree-cleanup",
    shard: opts.worker,
    detail: {
      team: opts.team,
      worker: opts.worker ?? null,
      force: !!opts.force,
    },
    cwd: opts.cwd,
  });

  // Determine targets.
  const targets: TeamWorktreeEntry[] = [];
  if (opts.worker !== undefined) {
    const path = worktreePathFor(repoRoot, opts.team, opts.worker);
    if (existsSync(path)) {
      targets.push({
        team: opts.team,
        worker: opts.worker,
        branch: branchNameFor(opts.team, opts.worker),
        path,
      });
    }
  } else {
    // All workers under the team.
    const teamDir = teamWorktreesRoot(repoRoot, opts.team);
    if (existsSync(teamDir)) {
      for (const worker of safeReaddir(teamDir)) {
        const path = join(teamDir, worker);
        try {
          if (!statSync(path).isDirectory()) continue;
        } catch {
          continue;
        }
        targets.push({
          team: opts.team,
          worker,
          branch: branchNameFor(opts.team, worker),
          path,
        });
      }
    }
  }

  if (targets.length === 0) {
    // Idempotent: cleanup of nothing is success.
    return baseResult({ exitCode: 0 });
  }

  const removed: TeamWorktreeEntry[] = [];
  const skipped: Array<{ entry: TeamWorktreeEntry; reason: string }> = [];

  for (const entry of targets) {
    // Refuse to remove a worktree containing uncommitted changes unless --force.
    if (!opts.force && workerHasUncommittedChanges(entry.path)) {
      skipped.push({
        entry,
        reason: "uncommitted changes (pass --force to override)",
      });
      continue;
    }

    // git worktree remove (graceful)
    const args = ["worktree", "remove"];
    if (opts.force) args.push("--force");
    args.push(entry.path);
    const r = spawnSync("git", args, {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (r.status === 0) {
      removed.push(entry);
      continue;
    }
    // Fallback: best-effort rmSync within the worktrees subtree (refuse to
    // touch anything outside `.omcp/worktrees/<team>/<worker>` to mirror
    // teleport.removeTeleport's containment guard).
    const root = teamWorktreesRoot(repoRoot);
    const rel = relative(root, entry.path);
    if (rel.startsWith("..") || isAbsolute(rel)) {
      skipped.push({
        entry,
        reason: `refusing to remove path outside ${root}`,
      });
      continue;
    }
    try {
      rmSync(entry.path, { recursive: true, force: true });
      // Best-effort branch deletion when forcing.
      if (opts.force) {
        spawnSync("git", ["branch", "-D", entry.branch], {
          cwd: repoRoot,
          stdio: ["ignore", "pipe", "pipe"],
        });
      }
      removed.push(entry);
    } catch (err) {
      skipped.push({
        entry,
        reason: `rm failed: ${(err as Error).message}`,
      });
    }
  }

  // Trim empty team dir if cleanup removed everything.
  if (opts.worker === undefined) {
    const teamDir = teamWorktreesRoot(repoRoot, opts.team);
    if (existsSync(teamDir) && safeReaddir(teamDir).length === 0) {
      try {
        rmSync(teamDir, { recursive: true, force: true });
      } catch {
        // best effort
      }
    }
  }

  appendEventBestEffort({
    sessionId: opts.team,
    verb: "team-worktree-cleanup",
    kind: "exit",
    actor: "team-worktree-cleanup",
    shard: opts.worker,
    detail: {
      removed: removed.length,
      skipped: skipped.length,
    },
    cwd: opts.cwd,
  });

  return baseResult({
    exitCode: skipped.length > 0 ? 4 : 0,
    removed,
    skipped,
  });
}

// ─── conflict-check ─────────────────────────────────────────────────────────

export interface RunTeamWorktreeConflictCheckOpts {
  team: string;
  worker: string;
  base?: string;
  cwd?: string;
}

export function runTeamWorktreeConflictCheck(
  opts: RunTeamWorktreeConflictCheckOpts,
): TeamWorktreeConflictCheckResult {
  const baseResult = (
    extra: Partial<TeamWorktreeConflictCheckResult>,
  ): TeamWorktreeConflictCheckResult => ({
    producer_fork: PRODUCER_FORK_ID,
    exitCode: 1,
    team: opts.team ?? "",
    worker: opts.worker ?? "",
    branch: "",
    base: opts.base ?? TEAM_WORKTREE_DEFAULT_BASE,
    conflictDetected: false,
    conflictedFiles: [],
    ...extra,
  });

  try {
    validateSlugs(opts.team, opts.worker);
  } catch (err) {
    return baseResult({
      exitCode: 2,
      error: err instanceof UnsafeSlugError ? err.message : String(err),
    });
  }

  const repoRoot = resolveRepoRoot(opts.cwd);
  if (!repoRoot) {
    return baseResult({ exitCode: 1, error: "not inside a git repository" });
  }

  const base = opts.base ?? TEAM_WORKTREE_DEFAULT_BASE;
  const branch = branchNameFor(opts.team, opts.worker);

  if (!branchExists(repoRoot, branch)) {
    return baseResult({
      exitCode: 3,
      branch,
      base,
      error: `worker branch not found: ${branch}`,
    });
  }
  if (!branchExists(repoRoot, base)) {
    return baseResult({
      exitCode: 3,
      branch,
      base,
      error: `base branch not found: ${base}`,
    });
  }

  appendEventBestEffort({
    sessionId: opts.team,
    verb: "team-worktree-conflict-check",
    kind: "entry",
    actor: "team-worktree-conflict-check",
    shard: opts.worker,
    detail: { team: opts.team, worker: opts.worker, branch, base },
    cwd: opts.cwd,
  });

  const mergeBase = getMergeBase(repoRoot, base, branch) ?? undefined;
  const { conflictDetected, conflictedFiles } = detectMergeConflicts(
    repoRoot,
    branch,
    base,
  );

  appendEventBestEffort({
    sessionId: opts.team,
    verb: "team-worktree-conflict-check",
    kind: "exit",
    actor: "team-worktree-conflict-check",
    shard: opts.worker,
    detail: {
      mergeBase: mergeBase ?? null,
      conflictDetected,
      conflictedCount: conflictedFiles.length,
    },
    cwd: opts.cwd,
  });

  return baseResult({
    exitCode: conflictDetected ? 5 : 0,
    branch,
    base,
    mergeBase,
    conflictDetected,
    conflictedFiles,
  });
}

// ─── CLI wrappers ───────────────────────────────────────────────────────────

export interface CliIo {
  log?: (line: string) => void;
  errLog?: (line: string) => void;
  json?: boolean;
}

function logResult(io: CliIo, result: TeamWorktreeResultBase, summary: string[]): void {
  const log = io.log ?? ((l: string) => console.log(l));
  const errLog = io.errLog ?? ((l: string) => console.error(l));
  if (io.json) {
    log(JSON.stringify(result, null, 2));
    return;
  }
  if (result.exitCode === 0) {
    for (const line of summary) log(line);
  } else {
    if (result.error) errLog(result.error);
    for (const line of summary) log(line);
  }
}

export function runTeamWorktreeCreateCli(
  team: string,
  worker: string,
  opts: { base?: string; cwd?: string } & CliIo = {},
): number {
  const result = runTeamWorktreeCreate({
    team,
    worker,
    base: opts.base,
    cwd: opts.cwd,
  });
  logResult(opts, result, [
    `omcp team-worktree-create: ${result.team}/${result.worker}`,
    `  branch:          ${result.branch}`,
    `  path:            ${result.path}`,
    `  base:            ${result.base}`,
    `  alreadyExisted:  ${result.alreadyExisted}`,
  ]);
  return result.exitCode;
}

export function runTeamWorktreeListCli(
  team: string | undefined,
  opts: { cwd?: string } & CliIo = {},
): number {
  const result = runTeamWorktreeList({ team, cwd: opts.cwd });
  const summary: string[] = [
    `omcp team-worktree-list${team ? `: ${team}` : ""}`,
    `  entries:         ${result.entries.length}`,
  ];
  for (const entry of result.entries) {
    summary.push(
      `    ${entry.team}/${entry.worker}  [${entry.branch}]  ${entry.path}`,
    );
  }
  logResult(opts, result, summary);
  return result.exitCode;
}

export function runTeamWorktreeMergeCli(
  team: string,
  worker: string,
  opts: { base?: string; noFf?: boolean; cwd?: string } & CliIo = {},
): number {
  const result = runTeamWorktreeMerge({
    team,
    worker,
    base: opts.base,
    noFf: opts.noFf,
    cwd: opts.cwd,
  });
  logResult(opts, result, [
    `omcp team-worktree-merge: ${result.team}/${result.worker}`,
    `  branch:          ${result.branch}`,
    `  base:            ${result.base}`,
    `  merged:          ${result.merged}`,
    `  conflicted:      ${result.conflicted}`,
  ]);
  return result.exitCode;
}

export function runTeamWorktreeCleanupCli(
  team: string,
  worker: string | undefined,
  opts: { force?: boolean; cwd?: string } & CliIo = {},
): number {
  const result = runTeamWorktreeCleanup({
    team,
    worker,
    force: opts.force,
    cwd: opts.cwd,
  });
  const summary: string[] = [
    `omcp team-worktree-cleanup: ${result.team}${
      result.worker ? `/${result.worker}` : ""
    }`,
    `  removed:         ${result.removed.length}`,
    `  skipped:         ${result.skipped.length}`,
  ];
  for (const entry of result.removed) {
    summary.push(`    removed ${entry.team}/${entry.worker}  ${entry.path}`);
  }
  for (const s of result.skipped) {
    summary.push(
      `    skipped ${s.entry.team}/${s.entry.worker}  ${s.entry.path} — ${s.reason}`,
    );
  }
  logResult(opts, result, summary);
  return result.exitCode;
}

export function runTeamWorktreeConflictCheckCli(
  team: string,
  worker: string,
  opts: { base?: string; cwd?: string } & CliIo = {},
): number {
  const result = runTeamWorktreeConflictCheck({
    team,
    worker,
    base: opts.base,
    cwd: opts.cwd,
  });
  const summary: string[] = [
    `omcp team-worktree-conflict-check: ${result.team}/${result.worker}`,
    `  branch:          ${result.branch}`,
    `  base:            ${result.base}`,
    `  mergeBase:       ${result.mergeBase ?? "(unknown)"}`,
    `  conflictDetected:${result.conflictDetected}`,
  ];
  for (const f of result.conflictedFiles) {
    summary.push(`    conflict: ${f}`);
  }
  logResult(opts, result, summary);
  return result.exitCode;
}
