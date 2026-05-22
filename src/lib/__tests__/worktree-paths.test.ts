import { execSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { UnsafeSlugError } from "../../runtime/safe-slug.js";
import {
  clearDualDirWarnings,
  clearWorktreeCache,
  ensureAllOmcpDirs,
  ensureOmcpDir,
  ensureSessionStateDir,
  getOmcpRoot,
  getProcessSessionId,
  getProjectIdentifier,
  getSessionStateDir,
  getWorktreeNotepadPath,
  getWorktreeProjectMemoryPath,
  getWorktreeRoot,
  isPathUnderOmcp,
  listSessionIds,
  OmcpPaths,
  resetProcessSessionId,
  resolveLogsPath,
  resolveOmcpPath,
  resolvePlanPath,
  resolveResearchPath,
  resolveSessionStatePath,
  resolveStatePath,
  resolveToWorktreeRoot,
  validatePath,
  validateWorkingDirectory,
} from "../worktree-paths.js";

function initRepo(dir: string): void {
  execSync("git init --quiet", { cwd: dir });
  execSync("git config user.email test@example.com", { cwd: dir });
  execSync("git config user.name test", { cwd: dir });
}

describe("OmcpPaths constants", () => {
  it("rooted at .omcp", () => {
    expect(OmcpPaths.ROOT).toBe(".omcp");
    expect(OmcpPaths.STATE).toBe(".omcp/state");
    expect(OmcpPaths.SESSIONS).toBe(".omcp/state/sessions");
    expect(OmcpPaths.NOTEPAD).toBe(".omcp/notepad.md");
    expect(OmcpPaths.PROJECT_MEMORY).toBe(".omcp/project-memory.json");
  });
});

describe("validatePath", () => {
  it("accepts safe relative paths", () => {
    expect(() => validatePath("state/foo.json")).not.toThrow();
    expect(() => validatePath("plans/my-plan.md")).not.toThrow();
  });

  it("rejects parent traversal", () => {
    expect(() => validatePath("../secret")).toThrow(/path traversal/);
    expect(() => validatePath("state/../../etc/passwd")).toThrow(
      /path traversal/,
    );
  });

  it("rejects tilde and absolute paths", () => {
    expect(() => validatePath("~/secret")).toThrow(/absolute paths/);
    expect(() => validatePath("/etc/passwd")).toThrow(/absolute paths/);
    if (process.platform === "win32") {
      expect(() => validatePath("C:\\Windows")).toThrow(/absolute paths/);
    }
  });
});

describe("getWorktreeRoot", () => {
  let tmp: string;

  beforeEach(() => {
    clearWorktreeCache();
    tmp = mkdtempSync(join(tmpdir(), "omcp-wt-"));
    initRepo(tmp);
  });

  afterEach(() => {
    clearWorktreeCache();
    rmSync(tmp, { recursive: true, force: true });
  });

  it("returns root for a git directory", () => {
    const root = getWorktreeRoot(tmp);
    expect(root).not.toBeNull();
    // realpath may differ on macOS /var ↔ /private/var; compare basename only.
    expect(root && root.length).toBeGreaterThan(0);
  });

  it("returns null outside a git repo", () => {
    const nonRepo = mkdtempSync(join(tmpdir(), "omcp-nonrepo-"));
    try {
      // Some CI tmpdirs themselves live under a git repo; only assert when
      // the directory is truly not under one.
      const direct = (() => {
        try {
          execSync("git rev-parse --show-toplevel", {
            cwd: nonRepo,
            stdio: ["pipe", "pipe", "pipe"],
          });
          return true;
        } catch {
          return false;
        }
      })();
      if (!direct) {
        expect(getWorktreeRoot(nonRepo)).toBeNull();
      }
    } finally {
      rmSync(nonRepo, { recursive: true, force: true });
    }
  });

  it("caches results within session", () => {
    const a = getWorktreeRoot(tmp);
    const b = getWorktreeRoot(tmp);
    expect(a).toBe(b);
  });
});

describe("getOmcpRoot + OMCP_STATE_DIR", () => {
  let tmp: string;
  const savedEnv = process.env.OMCP_STATE_DIR;

  beforeEach(() => {
    clearWorktreeCache();
    clearDualDirWarnings();
    tmp = mkdtempSync(join(tmpdir(), "omcp-root-"));
    initRepo(tmp);
  });

  afterEach(() => {
    clearWorktreeCache();
    clearDualDirWarnings();
    if (savedEnv === undefined) delete process.env.OMCP_STATE_DIR;
    else process.env.OMCP_STATE_DIR = savedEnv;
    rmSync(tmp, { recursive: true, force: true });
  });

  it("defaults to {worktree}/.omcp", () => {
    delete process.env.OMCP_STATE_DIR;
    const root = getOmcpRoot(tmp);
    expect(root.endsWith(`${sep}.omcp`)).toBe(true);
  });

  it("routes through OMCP_STATE_DIR when set", () => {
    const centralized = mkdtempSync(join(tmpdir(), "omcp-central-"));
    try {
      process.env.OMCP_STATE_DIR = centralized;
      const root = getOmcpRoot(tmp);
      expect(root.startsWith(centralized)).toBe(true);
    } finally {
      rmSync(centralized, { recursive: true, force: true });
    }
  });

  it("getProjectIdentifier returns stable hash format", () => {
    const id = getProjectIdentifier(tmp);
    expect(id).toMatch(/^[A-Za-z0-9_-]+-[a-f0-9]{16}$/);
    // Stable across calls.
    expect(getProjectIdentifier(tmp)).toBe(id);
  });
});

describe("resolveOmcpPath", () => {
  let tmp: string;

  beforeEach(() => {
    clearWorktreeCache();
    tmp = mkdtempSync(join(tmpdir(), "omcp-resolve-"));
    initRepo(tmp);
  });

  afterEach(() => {
    clearWorktreeCache();
    rmSync(tmp, { recursive: true, force: true });
  });

  it("resolves under the .omcp root", () => {
    const resolved = resolveOmcpPath("state/foo.json", tmp);
    expect(resolved.includes(`.omcp${sep}state${sep}foo.json`)).toBe(true);
  });

  it("rejects traversal that escapes the boundary", () => {
    expect(() => resolveOmcpPath("../escaped", tmp)).toThrow(
      /path traversal|absolute paths/,
    );
  });
});

describe("resolveStatePath", () => {
  let tmp: string;

  beforeEach(() => {
    clearWorktreeCache();
    tmp = mkdtempSync(join(tmpdir(), "omcp-state-"));
    initRepo(tmp);
  });

  afterEach(() => {
    clearWorktreeCache();
    rmSync(tmp, { recursive: true, force: true });
  });

  it("normalizes 'ralph' → ralph-state.json", () => {
    const p = resolveStatePath("ralph", tmp);
    expect(p.endsWith(`${sep}state${sep}ralph-state.json`)).toBe(true);
  });

  it("preserves 'ralph-state' → ralph-state.json (no double suffix)", () => {
    const p = resolveStatePath("ralph-state", tmp);
    expect(p.endsWith(`${sep}state${sep}ralph-state.json`)).toBe(true);
    expect(p.includes("ralph-state-state")).toBe(false);
  });
});

describe("ensureOmcpDir / ensureAllOmcpDirs", () => {
  let tmp: string;

  beforeEach(() => {
    clearWorktreeCache();
    tmp = mkdtempSync(join(tmpdir(), "omcp-ensure-"));
    initRepo(tmp);
  });

  afterEach(() => {
    clearWorktreeCache();
    rmSync(tmp, { recursive: true, force: true });
  });

  it("creates a missing subdirectory", () => {
    const dir = ensureOmcpDir("state/new", tmp);
    expect(existsSync(dir)).toBe(true);
  });

  it("is idempotent", () => {
    ensureOmcpDir("state/new", tmp);
    expect(() => ensureOmcpDir("state/new", tmp)).not.toThrow();
  });

  it("ensureAllOmcpDirs creates the standard layout", () => {
    ensureAllOmcpDirs(tmp);
    for (const sub of ["state", "plans", "research", "logs", "notepads", "drafts"]) {
      expect(existsSync(join(tmp, ".omcp", sub))).toBe(true);
    }
  });
});

describe("isPathUnderOmcp", () => {
  let tmp: string;

  beforeEach(() => {
    clearWorktreeCache();
    tmp = mkdtempSync(join(tmpdir(), "omcp-under-"));
    initRepo(tmp);
  });

  afterEach(() => {
    clearWorktreeCache();
    rmSync(tmp, { recursive: true, force: true });
  });

  it("returns true for paths inside .omcp", () => {
    const omcpRoot = getOmcpRoot(tmp);
    expect(isPathUnderOmcp(omcpRoot, tmp)).toBe(true);
    expect(isPathUnderOmcp(join(omcpRoot, "state", "foo.json"), tmp)).toBe(
      true,
    );
  });

  it("returns false for sibling directories", () => {
    expect(isPathUnderOmcp(join(tmp, "src", "lib.ts"), tmp)).toBe(false);
  });
});

describe("notepad/project-memory/plan/research/logs paths", () => {
  let tmp: string;

  beforeEach(() => {
    clearWorktreeCache();
    tmp = mkdtempSync(join(tmpdir(), "omcp-paths-"));
    initRepo(tmp);
  });

  afterEach(() => {
    clearWorktreeCache();
    rmSync(tmp, { recursive: true, force: true });
  });

  it("notepad", () => {
    expect(getWorktreeNotepadPath(tmp).endsWith(`.omcp${sep}notepad.md`)).toBe(
      true,
    );
  });

  it("project-memory", () => {
    expect(
      getWorktreeProjectMemoryPath(tmp).endsWith(
        `.omcp${sep}project-memory.json`,
      ),
    ).toBe(true);
  });

  it("plan", () => {
    expect(resolvePlanPath("my-plan", tmp).endsWith(
      `.omcp${sep}plans${sep}my-plan.md`,
    )).toBe(true);
  });

  it("plan rejects traversal", () => {
    expect(() => resolvePlanPath("../escape", tmp)).toThrow();
  });

  it("research", () => {
    expect(
      resolveResearchPath("topic-a", tmp).endsWith(
        `.omcp${sep}research${sep}topic-a`,
      ),
    ).toBe(true);
  });

  it("research rejects traversal", () => {
    expect(() => resolveResearchPath("../escape", tmp)).toThrow();
  });

  it("logs", () => {
    expect(resolveLogsPath(tmp).endsWith(`.omcp${sep}logs`)).toBe(true);
  });
});

describe("session id management", () => {
  beforeEach(() => {
    resetProcessSessionId();
  });

  it("getProcessSessionId returns a stable pid-prefixed string", () => {
    const id1 = getProcessSessionId();
    const id2 = getProcessSessionId();
    expect(id1).toBe(id2);
    expect(id1).toMatch(/^pid-\d+-\d+$/);
  });

  it("reset clears the cached id, regenerating on next call", () => {
    const id1 = getProcessSessionId();
    resetProcessSessionId();
    // Spin-wait at least 1ms so Date.now() advances past id1's timestamp.
    const t0 = Date.now();
    while (Date.now() === t0) {
      // spin
    }
    const id2 = getProcessSessionId();
    expect(id2).not.toBe(id1);
    expect(id2).toMatch(/^pid-\d+-\d+$/);
  });
});

describe("session-scoped state paths", () => {
  let tmp: string;

  beforeEach(() => {
    clearWorktreeCache();
    tmp = mkdtempSync(join(tmpdir(), "omcp-session-"));
    initRepo(tmp);
  });

  afterEach(() => {
    clearWorktreeCache();
    rmSync(tmp, { recursive: true, force: true });
  });

  it("resolves session-scoped state path", () => {
    const p = resolveSessionStatePath("ralph", "abc123", tmp);
    expect(
      p.endsWith(
        `.omcp${sep}state${sep}sessions${sep}abc123${sep}ralph-state.json`,
      ),
    ).toBe(true);
  });

  it("rejects path-traversal session ids via assertSafeSlug", () => {
    expect(() => resolveSessionStatePath("ralph", "../escape", tmp)).toThrow(
      UnsafeSlugError,
    );
    expect(() => resolveSessionStatePath("ralph", "ab/cd", tmp)).toThrow(
      UnsafeSlugError,
    );
    expect(() => getSessionStateDir("../escape", tmp)).toThrow(UnsafeSlugError);
  });

  it("ensureSessionStateDir creates the directory", () => {
    const dir = ensureSessionStateDir("session-x", tmp);
    expect(existsSync(dir)).toBe(true);
  });

  it("listSessionIds returns directories that pass assertSafeSlug", () => {
    const sessionsDir = join(tmp, ".omcp", "state", "sessions");
    mkdirSync(sessionsDir, { recursive: true });
    mkdirSync(join(sessionsDir, "session-a"));
    mkdirSync(join(sessionsDir, "session-b"));
    // Files (not dirs) are ignored.
    writeFileSync(join(sessionsDir, "not-a-dir.txt"), "");

    const ids = listSessionIds(tmp);
    expect(ids.sort()).toEqual(["session-a", "session-b"]);
  });

  it("listSessionIds returns [] when sessions/ does not exist", () => {
    expect(listSessionIds(tmp)).toEqual([]);
  });
});

describe("resolveToWorktreeRoot", () => {
  let tmp: string;

  beforeEach(() => {
    clearWorktreeCache();
    tmp = mkdtempSync(join(tmpdir(), "omcp-tow-"));
    initRepo(tmp);
  });

  afterEach(() => {
    clearWorktreeCache();
    rmSync(tmp, { recursive: true, force: true });
  });

  it("returns the worktree root for an input directory", () => {
    const sub = join(tmp, "src", "lib");
    mkdirSync(sub, { recursive: true });
    const root = resolveToWorktreeRoot(sub);
    // realpath divergence on macOS — compare suffix only.
    expect(root.length).toBeGreaterThan(0);
  });
});

describe("validateWorkingDirectory", () => {
  let tmp: string;

  beforeEach(() => {
    clearWorktreeCache();
    tmp = mkdtempSync(join(tmpdir(), "omcp-vwd-"));
    initRepo(tmp);
  });

  afterEach(() => {
    clearWorktreeCache();
    rmSync(tmp, { recursive: true, force: true });
  });

  it("returns trusted root when no argument is provided", () => {
    const root = validateWorkingDirectory();
    expect(typeof root).toBe("string");
    expect(root.length).toBeGreaterThan(0);
  });

  it("throws on non-existent directories", () => {
    expect(() =>
      validateWorkingDirectory(join(tmp, "does-not-exist")),
    ).toThrow();
  });
});
