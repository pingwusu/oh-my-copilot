import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createWorktree,
  defaultWorktreeRoot,
  formatTeleportList,
  listTeleports,
  refToSlug,
  removeTeleport,
  runTeleport,
  sanitizeSlug,
} from "../cli/commands/teleport.js";

function gitAvailable(): boolean {
  try {
    execFileSync("git", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function initSourceRepo(dir: string): void {
  execFileSync("git", ["init", "-b", "main", dir], { stdio: "ignore" });
  // Identity is required for commits even in a temp repo.
  execFileSync("git", ["-C", dir, "config", "user.email", "t@example.com"], {
    stdio: "ignore",
  });
  execFileSync("git", ["-C", dir, "config", "user.name", "Test"], {
    stdio: "ignore",
  });
  execFileSync("git", ["-C", dir, "config", "commit.gpgsign", "false"], {
    stdio: "ignore",
  });
  writeFileSync(join(dir, "README.md"), "# hello\n");
  execFileSync("git", ["-C", dir, "add", "."], { stdio: "ignore" });
  execFileSync("git", ["-C", dir, "commit", "-m", "init"], { stdio: "ignore" });
}

describe("teleport pure helpers", () => {
  it("refToSlug handles #123 issue numbers", () => {
    expect(refToSlug("#123")).toEqual({ slug: "issue-123", branch: "fix/123" });
    expect(refToSlug("42")).toEqual({ slug: "issue-42", branch: "fix/42" });
  });

  it("refToSlug recognises a GitHub PR URL", () => {
    const got = refToSlug("https://github.com/foo/bar/pull/7");
    expect(got).toEqual({ slug: "pr-7", branch: "pr/7-review" });
  });

  it("refToSlug falls back to feature slug for arbitrary names", () => {
    expect(refToSlug("Add Auth Flow")).toEqual({
      slug: "feat-add-auth-flow",
      branch: "feat/add-auth-flow",
    });
  });

  it("sanitizeSlug strips noise + caps length", () => {
    expect(sanitizeSlug("Hello, World!!!")).toBe("hello-world");
    expect(sanitizeSlug("x".repeat(50), 10)).toBe("xxxxxxxxxx");
  });

  it("defaultWorktreeRoot honours OMCP_TELEPORT_ROOT", () => {
    const prev = process.env.OMCP_TELEPORT_ROOT;
    process.env.OMCP_TELEPORT_ROOT = "/tmp/custom-teleport";
    try {
      expect(defaultWorktreeRoot()).toBe("/tmp/custom-teleport");
    } finally {
      if (prev === undefined) delete process.env.OMCP_TELEPORT_ROOT;
      else process.env.OMCP_TELEPORT_ROOT = prev;
    }
  });

  it("formatTeleportList prints empty + populated forms", () => {
    expect(formatTeleportList([])).toMatch(/no worktrees found/);
    const out = formatTeleportList([
      { slug: "issue-1", path: "/tmp/issue-1", branch: "fix/1" },
    ]);
    expect(out).toMatch(/issue-1/);
    expect(out).toMatch(/fix\/1/);
  });
});

const describeIfGit = gitAvailable() ? describe : describe.skip;

describeIfGit("teleport with real git", () => {
  let src: string;
  let root: string;
  let envSnapshot: string | undefined;

  beforeEach(() => {
    src = mkdtempSync(join(tmpdir(), "omcp-teleport-src-"));
    root = mkdtempSync(join(tmpdir(), "omcp-teleport-root-"));
    initSourceRepo(src);
    envSnapshot = process.env.OMCP_TELEPORT_ROOT;
    process.env.OMCP_TELEPORT_ROOT = root;
  });

  afterEach(() => {
    if (envSnapshot === undefined) delete process.env.OMCP_TELEPORT_ROOT;
    else process.env.OMCP_TELEPORT_ROOT = envSnapshot;
    try {
      rmSync(src, { recursive: true, force: true });
    } catch {
      // ignore
    }
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it("listTeleports returns [] for an empty root", () => {
    expect(listTeleports(root)).toEqual([]);
  });

  it("createWorktree adds a new worktree on the requested branch", () => {
    const wt = join(root, "issue-9");
    const r = createWorktree({
      repoRoot: src,
      worktreePath: wt,
      branch: "fix/9",
      base: "main",
    });
    expect(r.ok).toBe(true);
    expect(existsSync(wt)).toBe(true);
    const branches = execFileSync("git", ["-C", src, "branch"], {
      encoding: "utf8",
    });
    expect(branches).toMatch(/fix\/9/);
  });

  it("createWorktree refuses to overwrite an existing path", () => {
    const wt = join(root, "issue-9");
    createWorktree({
      repoRoot: src,
      worktreePath: wt,
      branch: "fix/9",
      base: "main",
    });
    const second = createWorktree({
      repoRoot: src,
      worktreePath: wt,
      branch: "fix/9b",
      base: "main",
    });
    expect(second.ok).toBe(false);
    expect(second.error).toMatch(/already exists/);
  });

  it("runTeleport creates a worktree + listTeleports surfaces it", () => {
    const result = runTeleport("#42", {
      worktreeRoot: root,
      repoRoot: src,
      noTmux: true,
    });
    expect(result.ok).toBe(true);
    expect(result.slug).toBe("issue-42");
    expect(result.branch).toBe("fix/42");
    expect(result.launched).toBe("skipped");
    expect(existsSync(result.worktreePath)).toBe(true);

    const entries = listTeleports(root);
    expect(entries.map((e) => e.slug)).toContain("issue-42");
  });

  it("removeTeleport tears down a created worktree", () => {
    const created = runTeleport("#7", {
      worktreeRoot: root,
      repoRoot: src,
      noTmux: true,
    });
    expect(created.ok).toBe(true);
    const rm = removeTeleport("issue-7", root);
    expect(rm.ok).toBe(true);
    expect(existsSync(created.worktreePath)).toBe(false);
  });

  it("removeTeleport refuses to delete paths outside the root", () => {
    const outside = mkdtempSync(join(tmpdir(), "omcp-teleport-outside-"));
    try {
      const r = removeTeleport(outside, root);
      expect(r.ok).toBe(false);
      expect(r.error).toMatch(/outside/);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});
