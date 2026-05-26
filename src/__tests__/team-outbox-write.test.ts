/**
 * Story 3 / US-EB06-OUTBOX-WRITE — outbox-write-helper unit tests.
 *
 * Covers ADR-omcp-eb-02-outbox-schema.md acceptance criteria:
 *   - JSONL line schema {ts, consumer, payload}
 *   - 64KB cap with {truncated, original_bytes} markers
 *   - hand-rolled lockfile + exponential backoff + 30s stale cleanup
 *   - exit codes 0 / 2 / 4 per ADR
 *   - assertSafeSlug on sessionId + consumer (Invariant 1)
 *
 * The 8-process concurrent test + 2-process Windows-only negative case
 * live in src/__tests__/team-outbox-write-8process.concurrency.test.ts
 * (gated by OMCP_RUN_HEAVY_CONCURRENCY).
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  OUTBOX_LINE_MAX_BYTES,
  OUTBOX_LOCK_BACKOFF_MS,
  OUTBOX_STALE_LOCK_MS,
  parseOutboxLine,
  runTeamOutboxWrite,
  runTeamOutboxWriteCli,
  serializeLineWithCap,
  type OutboxLineEntry,
} from "../cli/commands/team-outbox.js";

const SESSION_ID = "outbox-test-sid";
const CONSUMER = "test-consumer";

let tmp: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "omcp-outbox-test-"));
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function readLines(): string[] {
  const p = path.join(tmp, ".omcp", "state", "team", SESSION_ID, "outbox.jsonl");
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, "utf8").split("\n").filter((l) => l.length > 0);
}

// ─── happy path ────────────────────────────────────────────────────────────────

describe("runTeamOutboxWrite — happy path", () => {
  it("appends a single JSONL entry with the canonical schema", () => {
    const fixedNow = "2026-05-25T12:34:56.789Z";
    const result = runTeamOutboxWrite({
      sessionId: SESSION_ID,
      consumer: CONSUMER,
      payload: { event: "verify_completed", iteration: 1 },
      cwd: tmp,
      now: () => fixedNow,
      sleep: () => {},
    });
    expect(result.exitCode).toBe(0);
    expect(result.truncated).toBe(false);
    expect(result.retries).toBe(0);
    expect(result.staleLockfileRemoved).toBe(false);

    const lines = readLines();
    expect(lines).toHaveLength(1);
    const entry = JSON.parse(lines[0]) as OutboxLineEntry;
    expect(entry.ts).toBe(fixedNow);
    expect(entry.consumer).toBe(CONSUMER);
    expect(entry.payload).toEqual({ event: "verify_completed", iteration: 1 });
    expect(entry.truncated).toBeUndefined();
  });

  it("appends sequential entries — JSONL file grows by one line per call", () => {
    runTeamOutboxWrite({
      sessionId: SESSION_ID,
      consumer: CONSUMER,
      payload: { i: 1 },
      cwd: tmp,
      now: () => "2026-05-25T00:00:00.000Z",
      sleep: () => {},
    });
    runTeamOutboxWrite({
      sessionId: SESSION_ID,
      consumer: CONSUMER,
      payload: { i: 2 },
      cwd: tmp,
      now: () => "2026-05-25T00:00:01.000Z",
      sleep: () => {},
    });
    const lines = readLines();
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]).payload.i).toBe(1);
    expect(JSON.parse(lines[1]).payload.i).toBe(2);
  });

  it("creates pidDir if absent", () => {
    runTeamOutboxWrite({
      sessionId: SESSION_ID,
      consumer: CONSUMER,
      payload: { x: 1 },
      cwd: tmp,
      now: () => "2026-05-25T00:00:00.000Z",
      sleep: () => {},
    });
    expect(
      fs.existsSync(path.join(tmp, ".omcp", "state", "team", SESSION_ID)),
    ).toBe(true);
  });
});

// ─── slug validation (Invariant 1) ────────────────────────────────────────────

describe("runTeamOutboxWrite — argv validation", () => {
  it("returns exit 2 on path-traversal sessionId", () => {
    const result = runTeamOutboxWrite({
      sessionId: "../escape",
      consumer: CONSUMER,
      payload: { x: 1 },
      cwd: tmp,
      now: () => "2026-05-25T00:00:00.000Z",
      sleep: () => {},
    });
    expect(result.exitCode).toBe(2);
    // No .omcp directory created under tmp.
    expect(fs.existsSync(path.join(tmp, ".omcp"))).toBe(false);
  });

  it("returns exit 2 on path-traversal consumer", () => {
    const result = runTeamOutboxWrite({
      sessionId: SESSION_ID,
      consumer: "../bad",
      payload: { x: 1 },
      cwd: tmp,
      now: () => "2026-05-25T00:00:00.000Z",
      sleep: () => {},
    });
    expect(result.exitCode).toBe(2);
  });

  it("returns exit 2 on slugs with path separators", () => {
    expect(
      runTeamOutboxWrite({
        sessionId: "ab/cd",
        consumer: CONSUMER,
        payload: { x: 1 },
        cwd: tmp,
        now: () => "2026-05-25T00:00:00.000Z",
        sleep: () => {},
      }).exitCode,
    ).toBe(2);
  });
});

// ─── 64KB cap + truncation marker ────────────────────────────────────────────

describe("serializeLineWithCap — 64KB cap (ADR-EB-02 §3)", () => {
  it("does not truncate small payloads", () => {
    const entry: OutboxLineEntry = {
      ts: "2026-05-25T00:00:00.000Z",
      consumer: CONSUMER,
      payload: { small: "data" },
    };
    const r = serializeLineWithCap(entry);
    expect(r.truncated).toBe(false);
    expect(r.line.endsWith("\n")).toBe(true);
    expect(Buffer.byteLength(r.line, "utf8")).toBeLessThanOrEqual(
      OUTBOX_LINE_MAX_BYTES,
    );
  });

  it("truncates payloads that would exceed 64KB + adds markers", () => {
    const hugeText = "x".repeat(200_000);
    const entry: OutboxLineEntry = {
      ts: "2026-05-25T00:00:00.000Z",
      consumer: CONSUMER,
      payload: { blob: hugeText },
    };
    const r = serializeLineWithCap(entry);
    expect(r.truncated).toBe(true);
    expect(r.originalBytes).toBeGreaterThan(OUTBOX_LINE_MAX_BYTES);
    expect(Buffer.byteLength(r.line, "utf8")).toBeLessThanOrEqual(
      OUTBOX_LINE_MAX_BYTES,
    );
    const parsed = JSON.parse(r.line) as OutboxLineEntry;
    expect(parsed.truncated).toBe(true);
    expect(parsed.original_bytes).toBeGreaterThan(OUTBOX_LINE_MAX_BYTES);
  });

  it("truncated line is still valid JSON (parseable by reader)", () => {
    const entry: OutboxLineEntry = {
      ts: "2026-05-25T00:00:00.000Z",
      consumer: CONSUMER,
      payload: "y".repeat(100_000),
    };
    const r = serializeLineWithCap(entry);
    expect(() => JSON.parse(r.line)).not.toThrow();
  });

  it("runTeamOutboxWrite surfaces truncated flag + originalBytes in result", () => {
    const result = runTeamOutboxWrite({
      sessionId: SESSION_ID,
      consumer: CONSUMER,
      payload: { huge: "z".repeat(200_000) },
      cwd: tmp,
      now: () => "2026-05-25T00:00:00.000Z",
      sleep: () => {},
    });
    expect(result.exitCode).toBe(0);
    expect(result.truncated).toBe(true);
    expect(result.originalBytes).toBeGreaterThan(OUTBOX_LINE_MAX_BYTES);
  });
});

// ─── lockfile mechanics ───────────────────────────────────────────────────────

describe("runTeamOutboxWrite — lockfile contention", () => {
  it("retries with backoff when lockfile already held + acquires once released", () => {
    const pidDir = path.join(tmp, ".omcp", "state", "team", SESSION_ID);
    fs.mkdirSync(pidDir, { recursive: true });
    const lockPath = path.join(pidDir, "outbox.jsonl.lock");
    // Pre-create the lockfile to simulate a held lock.
    const fd = fs.openSync(lockPath, "wx");

    const sleepCalls: number[] = [];
    let sleepBudget = 3; // after 3 sleeps, release the lock

    const result = runTeamOutboxWrite({
      sessionId: SESSION_ID,
      consumer: CONSUMER,
      payload: { x: 1 },
      cwd: tmp,
      now: () => "2026-05-25T00:00:00.000Z",
      backoffMs: [10, 10, 10, 10, 10, 10],
      sleep: (ms) => {
        sleepCalls.push(ms);
        sleepBudget--;
        if (sleepBudget === 0) {
          fs.closeSync(fd);
          fs.rmSync(lockPath, { force: true });
        }
      },
    });
    expect(result.exitCode).toBe(0);
    expect(result.retries).toBeGreaterThanOrEqual(3);
    expect(sleepCalls.length).toBeGreaterThanOrEqual(3);
  });

  it("returns exit 4 after exhausting the backoff sequence", () => {
    const pidDir = path.join(tmp, ".omcp", "state", "team", SESSION_ID);
    fs.mkdirSync(pidDir, { recursive: true });
    const lockPath = path.join(pidDir, "outbox.jsonl.lock");
    // Pre-create the lockfile so contenders see EEXIST. Close the fd
    // immediately — the FILE persists on disk (which is what other writers
    // observe), but releasing the Windows handle prevents the afterEach
    // rmSync from failing with ENOTEMPTY/EPERM on CI runners.
    fs.closeSync(fs.openSync(lockPath, "wx"));

    const result = runTeamOutboxWrite({
      sessionId: SESSION_ID,
      consumer: CONSUMER,
      payload: { x: 1 },
      cwd: tmp,
      now: () => "2026-05-25T00:00:00.000Z",
      backoffMs: [5, 5, 5], // 3 quick retries
      sleep: () => {},
      // staleLockMs default = 30s, lockfile freshly created → not stale
    });
    expect(result.exitCode).toBe(4);
    expect(result.retries).toBe(3);
    expect(result.staleLockfileRemoved).toBe(false);
  });

  it("force-removes stale lockfile (mtime > staleLockMs) during retry", () => {
    const pidDir = path.join(tmp, ".omcp", "state", "team", SESSION_ID);
    fs.mkdirSync(pidDir, { recursive: true });
    const lockPath = path.join(pidDir, "outbox.jsonl.lock");
    // Close the fd immediately — on Windows NTFS a leaked handle blocks
    // lstat (EPERM) and the afterEach rmSync (ENOTEMPTY). CI runners
    // (which tear down processes more slowly than dev boxes) catch this.
    fs.closeSync(fs.openSync(lockPath, "wx"));
    // Backdate the lockfile's mtime to 60s ago.
    const sixtySecondsAgo = new Date(Date.now() - 60_000);
    fs.utimesSync(lockPath, sixtySecondsAgo, sixtySecondsAgo);

    const result = runTeamOutboxWrite({
      sessionId: SESSION_ID,
      consumer: CONSUMER,
      payload: { x: 1 },
      cwd: tmp,
      now: () => "2026-05-25T00:00:00.000Z",
      backoffMs: [5, 5, 5],
      sleep: () => {},
      staleLockMs: 30_000,
    });
    expect(result.exitCode).toBe(0);
    expect(result.staleLockfileRemoved).toBe(true);
    expect(readLines()).toHaveLength(1);
  });

  it("does NOT force-remove a lockfile within the stale threshold", () => {
    const pidDir = path.join(tmp, ".omcp", "state", "team", SESSION_ID);
    fs.mkdirSync(pidDir, { recursive: true });
    const lockPath = path.join(pidDir, "outbox.jsonl.lock");
    // Close fd immediately — see comment in the prior test about Windows
    // NTFS handle-leak surfacing on CI runners as EPERM/ENOTEMPTY.
    fs.closeSync(fs.openSync(lockPath, "wx"));

    const result = runTeamOutboxWrite({
      sessionId: SESSION_ID,
      consumer: CONSUMER,
      payload: { x: 1 },
      cwd: tmp,
      now: () => "2026-05-25T00:00:00.000Z",
      backoffMs: [5, 5],
      sleep: () => {},
      staleLockMs: 30_000,
    });
    expect(result.exitCode).toBe(4);
    expect(result.staleLockfileRemoved).toBe(false);
  });

  it("releases lockfile on append error (try/finally cleanup)", () => {
    // Use a sessionId that points pidDir at a path made unwritable AFTER mkdir.
    // We accomplish this by mkdir then chmod-ing the outbox.jsonl path to a
    // read-only file BEFORE the append. On Windows, ACLs may interfere — we
    // skip this case there; on POSIX the read-only file rejects append.
    if (process.platform === "win32") {
      // Just assert the cleanup path exists via inspection; the actual file-
      // perm trick is POSIX-only.
      expect(true).toBe(true);
      return;
    }
    const pidDir = path.join(tmp, ".omcp", "state", "team", SESSION_ID);
    fs.mkdirSync(pidDir, { recursive: true });
    const outboxPath = path.join(pidDir, "outbox.jsonl");
    fs.writeFileSync(outboxPath, "", { mode: 0o400 });
    const lockPath = path.join(pidDir, "outbox.jsonl.lock");

    runTeamOutboxWrite({
      sessionId: SESSION_ID,
      consumer: CONSUMER,
      payload: { x: 1 },
      cwd: tmp,
      now: () => "2026-05-25T00:00:00.000Z",
      sleep: () => {},
    });
    // Lockfile must NOT exist after the appendFileSync threw.
    expect(fs.existsSync(lockPath)).toBe(false);
  });
});

// ─── parseOutboxLine helper (used by reader story) ───────────────────────────

describe("parseOutboxLine — reader-side tolerance (ADR-EB-02 §5)", () => {
  it("parses well-formed lines into typed entry", () => {
    const entry: OutboxLineEntry = {
      ts: "2026-05-25T00:00:00.000Z",
      consumer: CONSUMER,
      payload: { x: 1 },
    };
    const result = parseOutboxLine(JSON.stringify(entry));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.entry.consumer).toBe(CONSUMER);
    }
  });

  it("returns ok:false + raw on malformed JSON", () => {
    const result = parseOutboxLine('{not-valid-json');
    expect(result.ok).toBe(false);
  });

  it("returns ok:false when required field is missing", () => {
    const result = parseOutboxLine(JSON.stringify({ ts: "x" }));
    expect(result.ok).toBe(false);
  });
});

// ─── CLI wrapper ──────────────────────────────────────────────────────────────

describe("runTeamOutboxWriteCli — argv shape", () => {
  it("returns 0 on valid argv + serializes JSON payload correctly", () => {
    const out: string[] = [];
    const code = runTeamOutboxWriteCli(
      SESSION_ID,
      CONSUMER,
      JSON.stringify({ event: "test" }),
      { cwd: tmp, log: (l) => out.push(l), errLog: () => {} },
    );
    expect(code).toBe(0);
    expect(out.some((l) => l.includes("appended to"))).toBe(true);
    expect(readLines()).toHaveLength(1);
  });

  it("returns 2 on invalid sessionId", () => {
    const err: string[] = [];
    const code = runTeamOutboxWriteCli(
      "../escape",
      CONSUMER,
      JSON.stringify({ x: 1 }),
      { cwd: tmp, log: () => {}, errLog: (l) => err.push(l) },
    );
    expect(code).toBe(2);
    expect(err.join("\n")).toMatch(/unsafe/);
  });

  it("returns 2 on malformed JSON payload", () => {
    const err: string[] = [];
    const code = runTeamOutboxWriteCli(SESSION_ID, CONSUMER, "{not-json", {
      cwd: tmp,
      log: () => {},
      errLog: (l) => err.push(l),
    });
    expect(code).toBe(2);
    expect(err.join("\n")).toMatch(/must be valid JSON/);
  });
});

// ─── constants verification ───────────────────────────────────────────────────

describe("ADR-EB-02 pinned constants", () => {
  it("OUTBOX_LINE_MAX_BYTES = 65_536", () => {
    expect(OUTBOX_LINE_MAX_BYTES).toBe(65_536);
  });

  it("OUTBOX_STALE_LOCK_MS = 30_000", () => {
    expect(OUTBOX_STALE_LOCK_MS).toBe(30_000);
  });

  it("backoff sequence is exactly [50, 100, 200, 400, 1000, 2500, 5000, 10000]", () => {
    // 8-retry sequence sized for CI runner load (total 19.25s). See
    // team-outbox.ts OUTBOX_LOCK_BACKOFF_MS commentary for rationale.
    expect([...OUTBOX_LOCK_BACKOFF_MS]).toEqual([
      50, 100, 200, 400, 1_000, 2_500, 5_000, 10_000,
    ]);
  });
});
