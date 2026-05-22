import { execSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  addWorkingMemoryEntry,
  clearPriorityState,
  getNotepadStats,
  getPriorityContext,
  getWorkingMemory,
  PRIORITY_MAX_CHARS,
  pruneWorkingMemory,
  readPriorityState,
  setPriorityContext,
} from "../notepad-state.js";
import { clearWorktreeCache } from "../worktree-paths.js";

function initRepo(dir: string): void {
  execSync("git init --quiet", { cwd: dir });
  execSync("git config user.email test@example.com", { cwd: dir });
  execSync("git config user.name test", { cwd: dir });
}

function makeWorktree(): string {
  const dir = mkdtempSync(join(tmpdir(), "omcp-notepad-"));
  initRepo(dir);
  return dir;
}

const SAVED_NOTEPAD_PATH = process.env.OMCP_NOTEPAD_PATH;

beforeEach(() => {
  // OMCP_NOTEPAD_PATH would shadow the worktree-scoped resolution path the
  // tests rely on; clear it for the duration of each test.
  delete process.env.OMCP_NOTEPAD_PATH;
  clearWorktreeCache();
});

afterEach(() => {
  if (SAVED_NOTEPAD_PATH === undefined) {
    delete process.env.OMCP_NOTEPAD_PATH;
  } else {
    process.env.OMCP_NOTEPAD_PATH = SAVED_NOTEPAD_PATH;
  }
  clearWorktreeCache();
});

describe("addWorkingMemoryEntry / getWorkingMemory", () => {
  let dir: string;
  beforeEach(() => {
    dir = makeWorktree();
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("creates notepad.md on first append", () => {
    addWorkingMemoryEntry("first thought", { worktreeRoot: dir });
    expect(existsSync(join(dir, ".omcp", "notepad.md"))).toBe(true);
  });

  it("stamps entries with ISO timestamp and returns running count", () => {
    const result = addWorkingMemoryEntry("alpha", { worktreeRoot: dir });
    expect(result.count).toBe(1);
    const entries = getWorkingMemory(dir);
    expect(entries.length).toBe(1);
    expect(entries[0]).toMatch(/- \d{4}-\d{2}-\d{2}T[\d:.]+Z .*alpha/);
  });

  it("includes source tag when provided", () => {
    addWorkingMemoryEntry("with source", {
      worktreeRoot: dir,
      source: "orchestrator",
    });
    expect(getWorkingMemory(dir)[0]).toContain("[orchestrator]");
  });

  it("preserves prior entries on subsequent appends", () => {
    addWorkingMemoryEntry("one", { worktreeRoot: dir });
    addWorkingMemoryEntry("two", { worktreeRoot: dir });
    expect(getWorkingMemory(dir).length).toBe(2);
  });
});

describe("pruneWorkingMemory", () => {
  let dir: string;
  beforeEach(() => {
    dir = makeWorktree();
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("clears all entries by default", () => {
    addWorkingMemoryEntry("a", { worktreeRoot: dir });
    addWorkingMemoryEntry("b", { worktreeRoot: dir });
    const result = pruneWorkingMemory({ worktreeRoot: dir });
    expect(result.pruned).toBe(2);
    expect(result.remaining).toBe(0);
    expect(getWorkingMemory(dir)).toEqual([]);
  });

  it("retains entries newer than the cutoff and drops older ones", () => {
    // Manually craft notepad.md with one old + one new timestamped entry.
    mkdirSync(join(dir, ".omcp"), { recursive: true });
    const oldStamp = "2020-01-01T00:00:00.000Z";
    const newStamp = new Date().toISOString();
    writeFileSync(
      join(dir, ".omcp", "notepad.md"),
      [
        "# omcp notepad",
        "",
        "## priority",
        "",
        "## working",
        `- ${oldStamp} old entry`,
        `- ${newStamp} new entry`,
        "",
        "## manual",
        "",
      ].join("\n"),
    );

    const result = pruneWorkingMemory({ worktreeRoot: dir, olderThanDays: 7 });
    expect(result.pruned).toBe(1);
    expect(result.remaining).toBe(1);
    expect(getWorkingMemory(dir)[0]).toContain("new entry");
  });

  it("ignores entries with unparseable timestamps under olderThanDays", () => {
    mkdirSync(join(dir, ".omcp"), { recursive: true });
    writeFileSync(
      join(dir, ".omcp", "notepad.md"),
      [
        "# omcp notepad",
        "",
        "## priority",
        "",
        "## working",
        "- not a timestamped entry",
        "",
        "## manual",
        "",
      ].join("\n"),
    );

    const result = pruneWorkingMemory({ worktreeRoot: dir, olderThanDays: 7 });
    expect(result.pruned).toBe(0);
    expect(result.remaining).toBe(1);
  });
});

describe("setPriorityContext / getPriorityContext", () => {
  let dir: string;
  beforeEach(() => {
    dir = makeWorktree();
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("writes content and a sidecar with metadata", () => {
    const result = setPriorityContext("critical fact", {
      worktreeRoot: dir,
      source: "orchestrator",
    });
    expect(result.success).toBe(true);
    expect(result.warning).toBeUndefined();
    expect(getPriorityContext(dir)).toContain("critical fact");

    const sidecar = readPriorityState(dir);
    expect(sidecar?.content).toBe("critical fact");
    expect(sidecar?.source).toBe("orchestrator");
    expect(sidecar?.maxChars).toBe(PRIORITY_MAX_CHARS);
  });

  it("replaces (not appends) on subsequent set", () => {
    setPriorityContext("first version", { worktreeRoot: dir });
    setPriorityContext("second version", { worktreeRoot: dir });
    const content = getPriorityContext(dir);
    expect(content).toContain("second version");
    expect(content).not.toContain("first version");
  });

  it("truncates content longer than maxChars and emits warning", () => {
    const long = "x".repeat(PRIORITY_MAX_CHARS + 50);
    const result = setPriorityContext(long, { worktreeRoot: dir });
    expect(result.warning).toMatch(/truncated/);
    expect(getPriorityContext(dir).length).toBe(PRIORITY_MAX_CHARS);
  });

  it("honors custom maxChars override", () => {
    const result = setPriorityContext("abcdef", {
      worktreeRoot: dir,
      maxChars: 3,
    });
    expect(result.warning).toMatch(/truncated/);
    expect(getPriorityContext(dir)).toBe("abc");
  });
});

describe("readPriorityState / clearPriorityState", () => {
  let dir: string;
  beforeEach(() => {
    dir = makeWorktree();
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("readPriorityState returns null when no sidecar", () => {
    expect(readPriorityState(dir)).toBeNull();
  });

  it("clearPriorityState removes the sidecar but leaves notepad.md alone", () => {
    setPriorityContext("important", { worktreeRoot: dir });
    expect(clearPriorityState(dir)).toBe(true);
    expect(readPriorityState(dir)).toBeNull();
    // Notepad still has the content — sidecar tracks metadata only.
    expect(getPriorityContext(dir)).toContain("important");
  });

  it("clearPriorityState is idempotent", () => {
    expect(clearPriorityState(dir)).toBe(true);
  });

  it("malformed sidecar JSON yields null", () => {
    const stateDir = join(dir, ".omcp", "state");
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(join(stateDir, "notepad-priority-state.json"), "{ not json");
    expect(readPriorityState(dir)).toBeNull();
  });
});

describe("getNotepadStats", () => {
  let dir: string;
  beforeEach(() => {
    dir = makeWorktree();
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("reports per-section counts and the active path", () => {
    setPriorityContext("p", { worktreeRoot: dir });
    addWorkingMemoryEntry("w1", { worktreeRoot: dir });
    addWorkingMemoryEntry("w2", { worktreeRoot: dir });
    const stats = getNotepadStats(dir);
    expect(stats.priority).toBe(1);
    expect(stats.working).toBe(2);
    expect(stats.manual).toBe(0);
    expect(stats.path.endsWith("notepad.md")).toBe(true);
  });
});

describe("OMCP_NOTEPAD_PATH override", () => {
  let dir: string;
  beforeEach(() => {
    dir = makeWorktree();
  });
  afterEach(() => {
    delete process.env.OMCP_NOTEPAD_PATH;
    rmSync(dir, { recursive: true, force: true });
  });

  it("env override takes precedence over worktreeRoot", () => {
    const alt = join(dir, "alt-notepad.md");
    process.env.OMCP_NOTEPAD_PATH = alt;

    addWorkingMemoryEntry("hello", {});
    expect(existsSync(alt)).toBe(true);
    // The worktree-scoped path should be untouched.
    expect(existsSync(join(dir, ".omcp", "notepad.md"))).toBe(false);
  });
});
