/**
 * Story 4 / US-EB06-OUTBOX-READ-CURSOR — byte-offset cursor reader.
 *
 * Covers ADR-omcp-eb-02-outbox-schema.md §4 + §5:
 *   - Cursor shape {fileIndex, byteOffset} (single-file outbox: fileIndex
 *     always 0)
 *   - Per-consumer cursor independence
 *   - --reset re-emits from offset 0
 *   - Reader tolerates trailing partial line (advances cursor only past
 *     last successfully-parsed \n)
 *   - Cursor file rewritten via atomicWriteFileSync (Invariant 2)
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  atomicWriteCursor,
  runTeamOutboxRead,
  runTeamOutboxReadCli,
  runTeamOutboxWrite,
  type OutboxCursor,
} from "../cli/commands/team-outbox.js";

const SESSION_ID = "outbox-read-sid";
const CONSUMER_A = "consumer-a";
const CONSUMER_B = "consumer-b";

let tmp: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "omcp-outbox-read-"));
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function seedEntries(consumer: string, count: number, prefix = "msg"): void {
  for (let i = 0; i < count; i++) {
    runTeamOutboxWrite({
      sessionId: SESSION_ID,
      consumer,
      payload: { prefix, i },
      cwd: tmp,
      now: () => `2026-05-25T00:00:${String(i).padStart(2, "0")}.000Z`,
      sleep: () => {},
    });
  }
}

function cursorPath(consumer: string): string {
  return path.join(
    tmp,
    ".omcp",
    "state",
    "team",
    SESSION_ID,
    `outbox-cursor-${consumer}.json`,
  );
}

// ─── happy path ────────────────────────────────────────────────────────────────

describe("runTeamOutboxRead — happy path", () => {
  it("first read from empty cursor returns ALL entries + advances cursor", () => {
    seedEntries(CONSUMER_A, 5);
    const result = runTeamOutboxRead({
      sessionId: SESSION_ID,
      consumer: CONSUMER_A,
      cwd: tmp,
    });
    expect(result.exitCode).toBe(0);
    expect(result.entries).toHaveLength(5);
    expect(result.parseErrors).toEqual([]);
    expect(result.previousCursor).toEqual({ fileIndex: 0, byteOffset: 0 });
    expect(result.cursor.byteOffset).toBeGreaterThan(0);
    expect(fs.existsSync(cursorPath(CONSUMER_A))).toBe(true);
  });

  it("subsequent read returns NO entries when no new lines + cursor unchanged", () => {
    seedEntries(CONSUMER_A, 3);
    const r1 = runTeamOutboxRead({
      sessionId: SESSION_ID,
      consumer: CONSUMER_A,
      cwd: tmp,
    });
    const r2 = runTeamOutboxRead({
      sessionId: SESSION_ID,
      consumer: CONSUMER_A,
      cwd: tmp,
    });
    expect(r1.entries).toHaveLength(3);
    expect(r2.entries).toHaveLength(0);
    expect(r2.previousCursor).toEqual(r1.cursor);
    expect(r2.cursor).toEqual(r1.cursor);
  });

  it("returns NEW entries only after additional writes (incremental)", () => {
    seedEntries(CONSUMER_A, 3);
    runTeamOutboxRead({
      sessionId: SESSION_ID,
      consumer: CONSUMER_A,
      cwd: tmp,
    });
    // Seed 2 more entries.
    seedEntries(CONSUMER_A, 2, "msg2");
    const r2 = runTeamOutboxRead({
      sessionId: SESSION_ID,
      consumer: CONSUMER_A,
      cwd: tmp,
    });
    expect(r2.entries).toHaveLength(2);
    expect((r2.entries[0].payload as { prefix: string }).prefix).toBe("msg2");
  });
});

// ─── --reset ──────────────────────────────────────────────────────────────────

describe("runTeamOutboxRead — --reset flag", () => {
  it("re-reads all entries from {fileIndex:0, byteOffset:0}", () => {
    seedEntries(CONSUMER_A, 4);
    runTeamOutboxRead({
      sessionId: SESSION_ID,
      consumer: CONSUMER_A,
      cwd: tmp,
    });
    const reset = runTeamOutboxRead({
      sessionId: SESSION_ID,
      consumer: CONSUMER_A,
      cwd: tmp,
      reset: true,
    });
    expect(reset.previousCursor).toEqual({ fileIndex: 0, byteOffset: 0 });
    expect(reset.entries).toHaveLength(4);
  });
});

// ─── per-consumer cursor independence ────────────────────────────────────────

describe("runTeamOutboxRead — per-consumer cursor independence", () => {
  it("consumer-a and consumer-b advance cursors independently", () => {
    seedEntries(CONSUMER_A, 5);
    const r1 = runTeamOutboxRead({
      sessionId: SESSION_ID,
      consumer: CONSUMER_A,
      cwd: tmp,
    });
    const r2 = runTeamOutboxRead({
      sessionId: SESSION_ID,
      consumer: CONSUMER_B,
      cwd: tmp,
    });
    // Both read all 5 entries since they have independent cursors.
    expect(r1.entries).toHaveLength(5);
    expect(r2.entries).toHaveLength(5);
    // Cursor files are separate.
    expect(cursorPath(CONSUMER_A)).not.toBe(cursorPath(CONSUMER_B));
    expect(fs.existsSync(cursorPath(CONSUMER_A))).toBe(true);
    expect(fs.existsSync(cursorPath(CONSUMER_B))).toBe(true);
  });
});

// ─── partial-line tolerance (ADR-EB-02 §5) ───────────────────────────────────

describe("runTeamOutboxRead — partial-line tolerance", () => {
  it("trailing partial line: cursor advances only past last complete \\n; partial NOT emitted", () => {
    seedEntries(CONSUMER_A, 2);
    // Manually append a partial line (no trailing newline) to simulate a
    // crashed writer.
    const outboxPath = path.join(
      tmp,
      ".omcp",
      "state",
      "team",
      SESSION_ID,
      "outbox.jsonl",
    );
    fs.appendFileSync(
      outboxPath,
      '{"ts":"2026-05-25T00:00:03.000Z","consumer":"a","payload":{partial',
      "utf8",
    );
    const result = runTeamOutboxRead({
      sessionId: SESSION_ID,
      consumer: CONSUMER_A,
      cwd: tmp,
    });
    // Only the 2 complete lines emitted; partial line held back.
    expect(result.entries).toHaveLength(2);
    expect(result.parseErrors).toHaveLength(0);
    // Cursor advanced past the 2 complete lines but NOT past the partial.
    const fullContent = fs.readFileSync(outboxPath, "utf8");
    expect(result.cursor.byteOffset).toBeLessThan(
      Buffer.byteLength(fullContent, "utf8"),
    );
  });

  it("malformed but newline-terminated line: emitted as parseError + cursor advances past it", () => {
    seedEntries(CONSUMER_A, 1);
    const outboxPath = path.join(
      tmp,
      ".omcp",
      "state",
      "team",
      SESSION_ID,
      "outbox.jsonl",
    );
    fs.appendFileSync(outboxPath, "garbage-not-json\n", "utf8");
    const result = runTeamOutboxRead({
      sessionId: SESSION_ID,
      consumer: CONSUMER_A,
      cwd: tmp,
    });
    expect(result.entries).toHaveLength(1);
    expect(result.parseErrors).toEqual(["garbage-not-json"]);
    // Cursor advanced past everything (no partial line).
    const fullBytes = Buffer.byteLength(
      fs.readFileSync(outboxPath, "utf8"),
      "utf8",
    );
    expect(result.cursor.byteOffset).toBe(fullBytes);
  });

  it("once the trailing partial line completes via a later write, the next read picks it up", () => {
    seedEntries(CONSUMER_A, 1);
    const outboxPath = path.join(
      tmp,
      ".omcp",
      "state",
      "team",
      SESSION_ID,
      "outbox.jsonl",
    );
    fs.appendFileSync(outboxPath, '{"partial":"start"', "utf8");
    // First read: only the 1 complete line; cursor sits before the partial.
    const r1 = runTeamOutboxRead({
      sessionId: SESSION_ID,
      consumer: CONSUMER_A,
      cwd: tmp,
    });
    expect(r1.entries).toHaveLength(1);

    // Now complete the partial line with the rest + newline.
    fs.appendFileSync(outboxPath, ',"end":"yes"}\n', "utf8");
    const r2 = runTeamOutboxRead({
      sessionId: SESSION_ID,
      consumer: CONSUMER_A,
      cwd: tmp,
    });
    // The previously-partial line is now complete + emitted (but it's
    // malformed JSON — the original "msg" line shape mismatch — so it
    // surfaces as a parseError, not an entry).
    expect(r2.entries.length + r2.parseErrors.length).toBeGreaterThanOrEqual(1);
  });
});

// ─── exit codes ───────────────────────────────────────────────────────────────

describe("runTeamOutboxRead — exit codes", () => {
  it("exit 2 on path-traversal sessionId", () => {
    const result = runTeamOutboxRead({
      sessionId: "../escape",
      consumer: CONSUMER_A,
      cwd: tmp,
    });
    expect(result.exitCode).toBe(2);
  });

  it("exit 2 on path-traversal consumer", () => {
    const result = runTeamOutboxRead({
      sessionId: SESSION_ID,
      consumer: "../bad",
      cwd: tmp,
    });
    expect(result.exitCode).toBe(2);
  });

  it("exit 3 when outbox file does not exist", () => {
    const result = runTeamOutboxRead({
      sessionId: SESSION_ID,
      consumer: CONSUMER_A,
      cwd: tmp,
    });
    expect(result.exitCode).toBe(3);
    expect(result.entries).toEqual([]);
  });
});

// ─── cursor file resilience ────────────────────────────────────────────────────

describe("runTeamOutboxRead — cursor file resilience", () => {
  it("corrupt cursor file falls back to fresh start (ADR §5)", () => {
    seedEntries(CONSUMER_A, 3);
    // Write garbage to cursor file.
    fs.writeFileSync(cursorPath(CONSUMER_A), "{not valid", "utf8");
    const result = runTeamOutboxRead({
      sessionId: SESSION_ID,
      consumer: CONSUMER_A,
      cwd: tmp,
    });
    expect(result.previousCursor).toEqual({ fileIndex: 0, byteOffset: 0 });
    expect(result.entries).toHaveLength(3);
  });

  it("partial cursor file with missing fields defaults each to 0", () => {
    seedEntries(CONSUMER_A, 2);
    fs.writeFileSync(
      cursorPath(CONSUMER_A),
      JSON.stringify({ fileIndex: 5 }), // missing byteOffset
      "utf8",
    );
    const result = runTeamOutboxRead({
      sessionId: SESSION_ID,
      consumer: CONSUMER_A,
      cwd: tmp,
    });
    expect(result.previousCursor.fileIndex).toBe(5);
    expect(result.previousCursor.byteOffset).toBe(0);
  });

  it("negative byteOffset in cursor file → defaults to 0", () => {
    seedEntries(CONSUMER_A, 2);
    fs.writeFileSync(
      cursorPath(CONSUMER_A),
      JSON.stringify({ fileIndex: 0, byteOffset: -100 }),
      "utf8",
    );
    const result = runTeamOutboxRead({
      sessionId: SESSION_ID,
      consumer: CONSUMER_A,
      cwd: tmp,
    });
    expect(result.previousCursor.byteOffset).toBe(0);
  });
});

// ─── atomicWriteCursor helper ─────────────────────────────────────────────────

describe("atomicWriteCursor — Invariant 2", () => {
  it("rewrites cursor file with valid JSON shape", () => {
    const p = path.join(tmp, "test-cursor.json");
    const cursor: OutboxCursor = { fileIndex: 2, byteOffset: 1024 };
    atomicWriteCursor(p, cursor);
    expect(JSON.parse(fs.readFileSync(p, "utf8"))).toEqual(cursor);
  });

  it("repeated writes overwrite cleanly without torn JSON", () => {
    const p = path.join(tmp, "test-cursor.json");
    for (let i = 0; i < 50; i++) {
      atomicWriteCursor(p, { fileIndex: 0, byteOffset: i * 100 });
    }
    expect(JSON.parse(fs.readFileSync(p, "utf8"))).toEqual({
      fileIndex: 0,
      byteOffset: 4900,
    });
  });
});

// ─── CLI wrapper ──────────────────────────────────────────────────────────────

describe("runTeamOutboxReadCli", () => {
  it("returns 0 + human-readable summary on happy path", () => {
    seedEntries(CONSUMER_A, 2);
    const out: string[] = [];
    const code = runTeamOutboxReadCli(SESSION_ID, CONSUMER_A, {
      cwd: tmp,
      log: (l) => out.push(l),
      errLog: () => {},
    });
    expect(code).toBe(0);
    const summary = out.join("\n");
    expect(summary).toMatch(/cursor:\s+0:0 →/);
    expect(summary).toMatch(/entries:\s+2/);
  });

  it("--json emits JSON shape with cursor + entries + parseErrors", () => {
    seedEntries(CONSUMER_A, 2);
    const out: string[] = [];
    runTeamOutboxReadCli(SESSION_ID, CONSUMER_A, {
      cwd: tmp,
      json: true,
      log: (l) => out.push(l),
    });
    const parsed = JSON.parse(out.join("\n")) as {
      previousCursor: OutboxCursor;
      cursor: OutboxCursor;
      entries: unknown[];
      parseErrors: string[];
    };
    expect(parsed.previousCursor).toEqual({ fileIndex: 0, byteOffset: 0 });
    expect(parsed.entries).toHaveLength(2);
  });

  it("returns 3 with errLog when outbox absent", () => {
    const err: string[] = [];
    const code = runTeamOutboxReadCli(SESSION_ID, CONSUMER_A, {
      cwd: tmp,
      log: () => {},
      errLog: (l) => err.push(l),
    });
    expect(code).toBe(3);
    expect(err.some((l) => l.includes("no outbox file"))).toBe(true);
  });

  it("--reset re-emits all entries", () => {
    seedEntries(CONSUMER_A, 3);
    runTeamOutboxReadCli(SESSION_ID, CONSUMER_A, {
      cwd: tmp,
      log: () => {},
      errLog: () => {},
    });
    const out: string[] = [];
    runTeamOutboxReadCli(SESSION_ID, CONSUMER_A, {
      cwd: tmp,
      reset: true,
      log: (l) => out.push(l),
      errLog: () => {},
    });
    expect(out.some((l) => l.includes("entries:        3") || l.includes("entries:       3"))).toBe(
      true,
    );
  });
});
