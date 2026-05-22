// Worktree path enforcement for omcp.
//
// Provides strict path validation and resolution for `.omcp/` paths,
// ensuring all operations stay within the worktree boundary.
//
// Honors `OMCP_STATE_DIR` env var for centralized state storage: when set,
// state is stored at `$OMCP_STATE_DIR/{project-identifier}/` instead of
// `{worktree}/.omcp/`, preserving state across worktree deletions.
//
// Ported from oh-my-claudecode's `src/lib/worktree-paths.ts`. Claude-Code-only
// transcript-resolution helpers (~/.claude paths, .claude/worktrees encoding)
// are intentionally dropped — Copilot CLI exposes no equivalent.

import { createHash } from "node:crypto";
import { execSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  realpathSync,
} from "node:fs";
import {
  basename,
  isAbsolute,
  join,
  normalize,
  relative,
  resolve,
  sep,
} from "node:path";

import { assertSafeSlug } from "../runtime/safe-slug.js";

/** Standard `.omcp/` subdirectories. */
export const OmcpPaths = {
  ROOT: ".omcp",
  STATE: ".omcp/state",
  SESSIONS: ".omcp/state/sessions",
  PLANS: ".omcp/plans",
  RESEARCH: ".omcp/research",
  NOTEPAD: ".omcp/notepad.md",
  PROJECT_MEMORY: ".omcp/project-memory.json",
  DRAFTS: ".omcp/drafts",
  NOTEPADS: ".omcp/notepads",
  LOGS: ".omcp/logs",
  SHARED_MEMORY: ".omcp/state/shared-memory",
} as const;

// ──────────────────────────────────────────────────────────────────────────
// Worktree detection (LRU-cached)
// ──────────────────────────────────────────────────────────────────────────

const MAX_WORKTREE_CACHE_SIZE = 8;
const worktreeCacheMap = new Map<string, string>();

/**
 * Resolve the git worktree root for the given directory (or `process.cwd()`).
 * Returns null if not inside a git repository.
 */
export function getWorktreeRoot(cwd?: string): string | null {
  const effectiveCwd = cwd || process.cwd();

  // LRU: refresh insertion order on hit.
  if (worktreeCacheMap.has(effectiveCwd)) {
    const cached = worktreeCacheMap.get(effectiveCwd)!;
    worktreeCacheMap.delete(effectiveCwd);
    worktreeCacheMap.set(effectiveCwd, cached);
    return cached || null;
  }

  try {
    const root = execSync("git rev-parse --show-toplevel", {
      cwd: effectiveCwd,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 5000,
    }).trim();

    if (worktreeCacheMap.size >= MAX_WORKTREE_CACHE_SIZE) {
      const oldest = worktreeCacheMap.keys().next().value;
      if (oldest !== undefined) worktreeCacheMap.delete(oldest);
    }
    worktreeCacheMap.set(effectiveCwd, root);
    return root;
  } catch {
    // Not in a git repository. Do NOT cache — if this dir later becomes a
    // repo, we want to re-detect.
    return null;
  }
}

/** Clear the worktree cache (test helper). */
export function clearWorktreeCache(): void {
  worktreeCacheMap.clear();
}

// ──────────────────────────────────────────────────────────────────────────
// Path validation
// ──────────────────────────────────────────────────────────────────────────

/**
 * Reject relative paths containing traversal sequences or absolute prefixes.
 *
 * Throws if the path:
 *   - contains `..`
 *   - starts with `~`
 *   - is absolute (Unix `/`, Windows `C:\`, UNC `\\`)
 */
export function validatePath(inputPath: string): void {
  if (inputPath.includes("..")) {
    throw new Error(
      `Invalid path: path traversal not allowed (${inputPath})`,
    );
  }
  if (inputPath.startsWith("~") || isAbsolute(inputPath)) {
    throw new Error(
      `Invalid path: absolute paths not allowed (${inputPath})`,
    );
  }
}

// ──────────────────────────────────────────────────────────────────────────
// OMCP_STATE_DIR — centralized state
// ──────────────────────────────────────────────────────────────────────────

const dualDirWarnings = new Set<string>();

/** Clear the dual-directory warning cache (test helper). */
export function clearDualDirWarnings(): void {
  dualDirWarnings.clear();
}

/**
 * Stable project identifier for centralized state storage.
 *
 * Hybrid strategy: prefer git-remote-url SHA-256 prefix (stable across
 * worktrees and clones of the same repo); fall back to worktree-root path
 * hash for local-only repos without remotes.
 *
 * Format: `{dirName}-{hash16}`, with the dir name normalized to
 * `[A-Za-z0-9_-]` characters.
 */
export function getProjectIdentifier(worktreeRoot?: string): string {
  const root = worktreeRoot || getWorktreeRoot() || process.cwd();

  let source: string;
  try {
    const remoteUrl = execSync("git remote get-url origin", {
      cwd: root,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
    source = remoteUrl || root;
  } catch {
    source = root;
  }

  const hash = createHash("sha256").update(source).digest("hex").slice(0, 16);
  const dirName = basename(root).replace(/[^a-zA-Z0-9_-]/g, "_");
  return `${dirName}-${hash}`;
}

/**
 * Resolve the `.omcp/` root directory.
 *
 * When `OMCP_STATE_DIR` is set, returns
 * `$OMCP_STATE_DIR/{project-identifier}/` instead of `{worktree}/.omcp/`.
 * This allows centralized state that survives worktree deletion.
 */
export function getOmcpRoot(worktreeRoot?: string): string {
  const customDir = process.env.OMCP_STATE_DIR;
  if (customDir) {
    const root = worktreeRoot || getWorktreeRoot() || process.cwd();
    const projectId = getProjectIdentifier(root);
    const centralizedPath = join(customDir, projectId);

    // Warn once if both legacy `.omcp/` and centralized state exist.
    const legacyPath = join(root, OmcpPaths.ROOT);
    const warningKey = `${legacyPath}:${centralizedPath}`;
    if (
      !dualDirWarnings.has(warningKey) &&
      existsSync(legacyPath) &&
      existsSync(centralizedPath)
    ) {
      dualDirWarnings.add(warningKey);
      console.warn(
        `[omcp] Both legacy state dir (${legacyPath}) and centralized state dir (${centralizedPath}) exist. ` +
          `Using centralized dir. Consider migrating data from the legacy dir and removing it.`,
      );
    }

    return centralizedPath;
  }
  const root = worktreeRoot || getWorktreeRoot() || process.cwd();
  return join(root, OmcpPaths.ROOT);
}

// ──────────────────────────────────────────────────────────────────────────
// Path resolution under `.omcp/`
// ──────────────────────────────────────────────────────────────────────────

/**
 * Resolve a relative path under `.omcp/` to an absolute path, validating
 * that the result stays inside the omcp boundary.
 *
 * @throws if the path traverses out of the omcp directory
 */
export function resolveOmcpPath(
  relativePath: string,
  worktreeRoot?: string,
): string {
  validatePath(relativePath);

  const omcpDir = getOmcpRoot(worktreeRoot);
  const fullPath = normalize(resolve(omcpDir, relativePath));

  const relativeToOmcp = relative(omcpDir, fullPath);
  if (
    relativeToOmcp.startsWith("..") ||
    relativeToOmcp.startsWith(sep + "..")
  ) {
    throw new Error(`Path escapes omcp boundary: ${relativePath}`);
  }

  return fullPath;
}

/**
 * Resolve a state file path.
 *
 * State files use the naming convention `{name}-state.json`. Callers may
 * pass either `"ralph"` or `"ralph-state"` — both yield
 * `.omcp/state/ralph-state.json`.
 */
export function resolveStatePath(
  stateName: string,
  worktreeRoot?: string,
): string {
  const normalized = stateName.endsWith("-state")
    ? stateName
    : `${stateName}-state`;
  return resolveOmcpPath(`state/${normalized}.json`, worktreeRoot);
}

/** Create (if needed) and return an absolute path to a subdirectory under `.omcp/`. */
export function ensureOmcpDir(
  relativePath: string,
  worktreeRoot?: string,
): string {
  const fullPath = resolveOmcpPath(relativePath, worktreeRoot);
  if (!existsSync(fullPath)) {
    mkdirSync(fullPath, { recursive: true });
  }
  return fullPath;
}

/** Absolute path to the worktree-scoped notepad markdown file. */
export function getWorktreeNotepadPath(worktreeRoot?: string): string {
  return join(getOmcpRoot(worktreeRoot), "notepad.md");
}

/** Absolute path to the worktree-scoped project-memory JSON file. */
export function getWorktreeProjectMemoryPath(worktreeRoot?: string): string {
  return join(getOmcpRoot(worktreeRoot), "project-memory.json");
}

/** Absolute path to a plan file, validated for traversal. */
export function resolvePlanPath(
  planName: string,
  worktreeRoot?: string,
): string {
  validatePath(planName);
  return join(getOmcpRoot(worktreeRoot), "plans", `${planName}.md`);
}

/** Absolute path to a research folder, validated for traversal. */
export function resolveResearchPath(
  name: string,
  worktreeRoot?: string,
): string {
  validatePath(name);
  return join(getOmcpRoot(worktreeRoot), "research", name);
}

/** Absolute path to the `.omcp/logs/` directory. */
export function resolveLogsPath(worktreeRoot?: string): string {
  return join(getOmcpRoot(worktreeRoot), "logs");
}

/** True if `absolutePath` is the omcp root or a descendant of it. */
export function isPathUnderOmcp(
  absolutePath: string,
  worktreeRoot?: string,
): boolean {
  const omcpRoot = getOmcpRoot(worktreeRoot);
  const normalizedPath = normalize(absolutePath);
  const normalizedOmcp = normalize(omcpRoot);
  return (
    normalizedPath.startsWith(normalizedOmcp + sep) ||
    normalizedPath === normalizedOmcp
  );
}

/** Ensure all standard `.omcp/` subdirectories exist. */
export function ensureAllOmcpDirs(worktreeRoot?: string): void {
  const omcpRoot = getOmcpRoot(worktreeRoot);
  const subdirs = ["", "state", "plans", "research", "logs", "notepads", "drafts"];
  for (const subdir of subdirs) {
    const fullPath = subdir ? join(omcpRoot, subdir) : omcpRoot;
    if (!existsSync(fullPath)) {
      mkdirSync(fullPath, { recursive: true });
    }
  }
}

// ──────────────────────────────────────────────────────────────────────────
// Process session id
// ──────────────────────────────────────────────────────────────────────────

let processSessionId: string | null = null;

/**
 * Stable, unique session id for the current process.
 *
 * Format: `pid-{PID}-{startTimestamp}`. The timestamp guards against PID
 * reuse after process exit. Generated once at first call and cached.
 */
export function getProcessSessionId(): string {
  if (!processSessionId) {
    processSessionId = `pid-${process.pid}-${Date.now()}`;
  }
  return processSessionId;
}

/** Reset the cached process session id (test helper). */
export function resetProcessSessionId(): void {
  processSessionId = null;
}

// ──────────────────────────────────────────────────────────────────────────
// Session-scoped state paths
// ──────────────────────────────────────────────────────────────────────────

/**
 * Resolve a session-scoped state file path.
 *
 * Path: `{omcpRoot}/state/sessions/{sessionId}/{name}-state.json`. The
 * session id is validated via `assertSafeSlug` (invariant 1 per HANDOFF).
 */
export function resolveSessionStatePath(
  stateName: string,
  sessionId: string,
  worktreeRoot?: string,
): string {
  assertSafeSlug(sessionId, "sessionId");
  const normalized = stateName.endsWith("-state")
    ? stateName
    : `${stateName}-state`;
  return resolveOmcpPath(
    `state/sessions/${sessionId}/${normalized}.json`,
    worktreeRoot,
  );
}

/** Absolute path to the per-session state directory. */
export function getSessionStateDir(
  sessionId: string,
  worktreeRoot?: string,
): string {
  assertSafeSlug(sessionId, "sessionId");
  return join(getOmcpRoot(worktreeRoot), "state", "sessions", sessionId);
}

/** List all session ids that have state directories (filtered to safe slugs). */
export function listSessionIds(worktreeRoot?: string): string[] {
  const sessionsDir = join(getOmcpRoot(worktreeRoot), "state", "sessions");

  if (!existsSync(sessionsDir)) return [];

  try {
    const entries = readdirSync(sessionsDir, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .filter((name) => {
        try {
          assertSafeSlug(name, "sessionId");
          return true;
        } catch {
          return false;
        }
      });
  } catch {
    return [];
  }
}

/** Create (if needed) the per-session state directory and return its path. */
export function ensureSessionStateDir(
  sessionId: string,
  worktreeRoot?: string,
): string {
  const sessionDir = getSessionStateDir(sessionId, worktreeRoot);
  if (!existsSync(sessionDir)) {
    mkdirSync(sessionDir, { recursive: true });
  }
  return sessionDir;
}

// ──────────────────────────────────────────────────────────────────────────
// Worktree root resolution from arbitrary input
// ──────────────────────────────────────────────────────────────────────────

/**
 * Resolve a directory hint to its git worktree root.
 *
 * Walks up from `directory` via `git rev-parse --show-toplevel`; falls back
 * to `getWorktreeRoot(process.cwd())` and finally `process.cwd()`. Ensures
 * `.omcp/` state is always written at the worktree root, never a
 * subdirectory.
 */
export function resolveToWorktreeRoot(directory?: string): string {
  if (directory) {
    const resolved = resolve(directory);
    const root = getWorktreeRoot(resolved);
    if (root) return root;

    console.error(
      "[omcp/worktree] non-git directory provided, falling back to process root",
      { directory: resolved },
    );
  }
  return getWorktreeRoot(process.cwd()) || process.cwd();
}

/**
 * Validate a user-supplied workingDirectory against the trusted root
 * derived from `process.cwd()`.
 *
 * Always returns a git worktree root — never a subdirectory. Prevents
 * `.omcp/state/` from being created in subdirectories.
 *
 * @throws if `workingDirectory` does not exist, or is outside the trusted
 *   worktree root.
 */
export function validateWorkingDirectory(workingDirectory?: string): string {
  const trustedRoot = getWorktreeRoot(process.cwd()) || process.cwd();

  if (!workingDirectory) return trustedRoot;

  const resolved = resolve(workingDirectory);

  let trustedRootReal: string;
  try {
    trustedRootReal = realpathSync(trustedRoot);
  } catch {
    trustedRootReal = trustedRoot;
  }

  const providedRoot = getWorktreeRoot(resolved);

  if (providedRoot) {
    // Git resolution succeeded — require exact worktree identity.
    let providedRootReal: string;
    try {
      providedRootReal = realpathSync(providedRoot);
    } catch {
      throw new Error(
        `workingDirectory '${workingDirectory}' does not exist or is not accessible.`,
      );
    }

    if (providedRootReal !== trustedRootReal) {
      console.error(
        "[omcp/worktree] workingDirectory resolved to different git worktree root, using trusted root",
        {
          workingDirectory: resolved,
          providedRoot: providedRootReal,
          trustedRoot: trustedRootReal,
        },
      );
      return trustedRoot;
    }

    return providedRoot;
  }

  // Git resolution failed — verify raw directory lies under trusted root.
  let resolvedReal: string;
  try {
    resolvedReal = realpathSync(resolved);
  } catch {
    throw new Error(
      `workingDirectory '${workingDirectory}' does not exist or is not accessible.`,
    );
  }

  const rel = relative(trustedRootReal, resolvedReal);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error(
      `workingDirectory '${workingDirectory}' is outside the trusted worktree root '${trustedRoot}'.`,
    );
  }

  // Directory is under trusted root but git failed — return trusted root,
  // never the subdirectory.
  return trustedRoot;
}
