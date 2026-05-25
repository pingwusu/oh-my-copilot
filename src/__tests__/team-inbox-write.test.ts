/**
 * Story 6 / US-EB06-INBOX-WRITE — inbox-write-helper tests.
 *
 * Covers iter-2 plan AC + ADR-omcp-eb-02 sibling contract:
 *   - First write seeds inbox-1.md
 *   - Appends under 1MB stay in same file
 *   - 1MB rotation rolls to inbox-2.md
 *   - Env OMCP_INBOX_ROTATE_BYTES overrides
 *   - Hand-rolled lockfile + 30s stale-cleanup + exponential backoff
 *   - Path-traversal sessionId → exit 2
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  findCurrentInboxIndex,
  INBOX_LOCK_BACKOFF_MS,
  INBOX_ROTATE_BYTES_DEFAULT,
  INBOX_STALE_LOCK_MS,
  resolveRotateBytes,
  runTeamInboxWrite,
  runTeamInboxWriteCli,
} from "../cli/commands/team-inbox.js";

const SESSION_ID = "inbox-test-sid";

let tmp: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "omcp-inbox-test-"));
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function pidDir(): string {
  return path.join(tmp, ".omcp", "state", "team", SESSION_ID);
}

// ─── happy path ────────────────────────────────────────────────────────────────

describe("runTeamInboxWrite — happy path", () => {
  it("first write seeds inbox-1.md", () => {
    const result = runTeamInboxWrite({
      sessionId: SESSION_ID,
      body: "# task\nrun verify\n",
      cwd: tmp,
      sleep: () => {},
    });
    expect(result.exitCode).toBe(0);
    expect(result.fileIndex).toBe(1);
    expect(result.rotated).toBe(false);
    expect(fs.existsSync(path.join(pidDir(), "inbox-1.md"))).toBe(true);
  });

  it("multiple appends under 1MB stay in inbox-1.md", () => {
    for (let i = 0; i < 5; i++) {
      runTeamInboxWrite({
        sessionId: SESSION_ID,
        body: `message ${i}\n`,
        cwd: tmp,
        sleep: () => {},
      });
    }
    expect(findCurrentInboxIndex(pidDir())).toBe(1);
    const content = fs.readFileSync(path.join(pidDir(), "inbox-1.md"), "utf8");
    expect(content.split("\n").filter((l) => l.length > 0)).toHaveLength(5);
  });
});

// ─── rotation ─────────────────────────────────────────────────────────────────

describe("runTeamInboxWrite — rotation at 1MB", () => {
  it("rotates AT threshold: write that would exceed rolls to inbox-2.md", () => {
    // Use a small custom rotateBytes to make the test fast.
    const ROTATE = 1_000;
    // First write fills most of inbox-1.md.
    const big = "x".repeat(800);
    const r1 = runTeamInboxWrite({
      sessionId: SESSION_ID,
      body: big,
      cwd: tmp,
      rotateBytes: ROTATE,
      sleep: () => {},
    });
    expect(r1.fileIndex).toBe(1);
    expect(r1.rotated).toBe(false);

    // Second write would push past 1000 bytes → rolls to inbox-2.md.
    const r2 = runTeamInboxWrite({
      sessionId: SESSION_ID,
      body: "y".repeat(300),
      cwd: tmp,
      rotateBytes: ROTATE,
      sleep: () => {},
    });
    expect(r2.fileIndex).toBe(2);
    expect(r2.rotated).toBe(true);

    expect(fs.existsSync(path.join(pidDir(), "inbox-1.md"))).toBe(true);
    expect(fs.existsSync(path.join(pidDir(), "inbox-2.md"))).toBe(true);
  });

  it("very large single write exceeding rotateBytes still lands in next inbox-N+1.md", () => {
    const ROTATE = 100;
    runTeamInboxWrite({
      sessionId: SESSION_ID,
      body: "filler\n",
      cwd: tmp,
      rotateBytes: ROTATE,
      sleep: () => {},
    });
    const r = runTeamInboxWrite({
      sessionId: SESSION_ID,
      body: "z".repeat(500),
      cwd: tmp,
      rotateBytes: ROTATE,
      sleep: () => {},
    });
    expect(r.rotated).toBe(true);
    expect(r.fileIndex).toBe(2);
  });

  it("subsequent writes within rotateBytes of inbox-2.md stay in inbox-2.md", () => {
    const ROTATE = 100;
    runTeamInboxWrite({
      sessionId: SESSION_ID,
      body: "x".repeat(150),
      cwd: tmp,
      rotateBytes: ROTATE,
      sleep: () => {},
    });
    runTeamInboxWrite({
      sessionId: SESSION_ID,
      body: "y".repeat(50),
      cwd: tmp,
      rotateBytes: ROTATE,
      sleep: () => {},
    });
    expect(findCurrentInboxIndex(pidDir())).toBe(2);
  });
});

// ─── argv validation ──────────────────────────────────────────────────────────

describe("runTeamInboxWrite — argv validation", () => {
  it("exit 2 on path-traversal sessionId", () => {
    const r = runTeamInboxWrite({
      sessionId: "../escape",
      body: "x",
      cwd: tmp,
      sleep: () => {},
    });
    expect(r.exitCode).toBe(2);
    expect(fs.existsSync(path.join(tmp, ".omcp"))).toBe(false);
  });

  it("exit 2 on path-separator sessionId", () => {
    const r = runTeamInboxWrite({
      sessionId: "ab/cd",
      body: "x",
      cwd: tmp,
      sleep: () => {},
    });
    expect(r.exitCode).toBe(2);
  });
});

// ─── lockfile mechanics ───────────────────────────────────────────────────────

describe("runTeamInboxWrite — lockfile contention", () => {
  it("returns exit 4 when lockfile held for the entire backoff sequence", () => {
    mkdirAll();
    const lockPath = path.join(pidDir(), "inbox.lock");
    fs.openSync(lockPath, "wx");
    const r = runTeamInboxWrite({
      sessionId: SESSION_ID,
      body: "x",
      cwd: tmp,
      backoffMs: [5, 5, 5],
      sleep: () => {},
    });
    expect(r.exitCode).toBe(4);
    expect(r.retries).toBe(3);
  });

  it("force-removes stale lockfile (>30s) and acquires", () => {
    mkdirAll();
    const lockPath = path.join(pidDir(), "inbox.lock");
    fs.openSync(lockPath, "wx");
    const sixtySecondsAgo = new Date(Date.now() - 60_000);
    fs.utimesSync(lockPath, sixtySecondsAgo, sixtySecondsAgo);
    const r = runTeamInboxWrite({
      sessionId: SESSION_ID,
      body: "x",
      cwd: tmp,
      backoffMs: [5, 5],
      sleep: () => {},
      staleLockMs: 30_000,
    });
    expect(r.exitCode).toBe(0);
    expect(r.staleLockfileRemoved).toBe(true);
  });
});

// ─── env override ─────────────────────────────────────────────────────────────

describe("resolveRotateBytes — env > arg > default", () => {
  it("default = 1 MB when no env + no arg", () => {
    expect(resolveRotateBytes(undefined, {})).toBe(INBOX_ROTATE_BYTES_DEFAULT);
  });

  it("arg overrides default", () => {
    expect(resolveRotateBytes(5_000, {})).toBe(5_000);
  });

  it("env overrides arg", () => {
    expect(resolveRotateBytes(5_000, { OMCP_INBOX_ROTATE_BYTES: "2048" })).toBe(
      2_048,
    );
  });

  it("ignores non-positive env", () => {
    expect(resolveRotateBytes(8_000, { OMCP_INBOX_ROTATE_BYTES: "0" })).toBe(8_000);
    expect(resolveRotateBytes(8_000, { OMCP_INBOX_ROTATE_BYTES: "-1" })).toBe(8_000);
    expect(resolveRotateBytes(8_000, { OMCP_INBOX_ROTATE_BYTES: "not" })).toBe(8_000);
  });
});

// ─── findCurrentInboxIndex ────────────────────────────────────────────────────

describe("findCurrentInboxIndex", () => {
  it("returns 0 when pidDir absent", () => {
    expect(findCurrentInboxIndex(path.join(tmp, "nope"))).toBe(0);
  });

  it("returns 0 when no inbox-*.md files", () => {
    mkdirAll();
    fs.writeFileSync(path.join(pidDir(), "other.md"), "x", "utf8");
    expect(findCurrentInboxIndex(pidDir())).toBe(0);
  });

  it("returns highest N when multiple inbox-N.md files present", () => {
    mkdirAll();
    fs.writeFileSync(path.join(pidDir(), "inbox-1.md"), "x", "utf8");
    fs.writeFileSync(path.join(pidDir(), "inbox-5.md"), "x", "utf8");
    fs.writeFileSync(path.join(pidDir(), "inbox-3.md"), "x", "utf8");
    expect(findCurrentInboxIndex(pidDir())).toBe(5);
  });
});

// ─── pinned constants ─────────────────────────────────────────────────────────

describe("ADR pinned constants", () => {
  it("INBOX_ROTATE_BYTES_DEFAULT = 1 MB", () => {
    expect(INBOX_ROTATE_BYTES_DEFAULT).toBe(1_048_576);
  });

  it("INBOX_STALE_LOCK_MS = 30s (matches outbox)", () => {
    expect(INBOX_STALE_LOCK_MS).toBe(30_000);
  });

  it("backoff sequence matches outbox", () => {
    expect([...INBOX_LOCK_BACKOFF_MS]).toEqual([50, 100, 200, 400, 1_000, 2_500]);
  });
});

// ─── CLI wrapper ──────────────────────────────────────────────────────────────

describe("runTeamInboxWriteCli", () => {
  it("returns 0 + summary on happy path", () => {
    const out: string[] = [];
    const code = runTeamInboxWriteCli(SESSION_ID, "test message", {
      cwd: tmp,
      log: (l) => out.push(l),
      errLog: () => {},
    });
    expect(code).toBe(0);
    expect(out.some((l) => l.includes("appended to"))).toBe(true);
    expect(out.some((l) => l.includes("fileIndex:"))).toBe(true);
  });

  it("returns 2 on invalid sessionId", () => {
    const err: string[] = [];
    const code = runTeamInboxWriteCli("../bad", "x", {
      cwd: tmp,
      log: () => {},
      errLog: (l) => err.push(l),
    });
    expect(code).toBe(2);
    expect(err.join("\n")).toMatch(/unsafe/);
  });
});

function mkdirAll(): void {
  fs.mkdirSync(pidDir(), { recursive: true });
}
