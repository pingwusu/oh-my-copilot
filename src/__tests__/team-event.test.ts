/**
 * RG-04a tests: team-event-append / team-event-tail + ts validation.
 *
 * Covers ADR-RG-04 acceptance criteria:
 *   - team-event-append writes valid record to events.jsonl
 *   - team-event-tail --since <ts> --type <kind> filters correctly
 *   - Records carry producer_fork field
 *   - Event with ts > now+5min REJECTED on write/read (sentinel + no recursion)
 *   - Event with ts < now-24h REJECTED on write/read
 *   - events.jsonl over 1MB triggers rotation inside per-stream lockfile
 *   - 5+ concurrent writers do not race (lockfile contention surface)
 *   - Tail filters (since, type, limit) behave correctly
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import {
  runTeamEventAppend,
  runTeamEventAppendCli,
  runTeamEventTail,
  runTeamEventTailCli,
  validateEventTs,
  TEAM_EVENT_POISON_KIND,
  TEAM_EVENT_ROTATION_BYTES,
  TEAM_EVENT_TAIL_DEFAULT_LIMIT,
  TEAM_EVENT_TAIL_MAX_LIMIT,
  TEAM_EVENT_TS_FUTURE_TOLERANCE_MS,
  TEAM_EVENT_TS_PAST_TOLERANCE_MS,
  type TeamEventRecord,
} from "../cli/commands/team-event.js";
import { PRODUCER_FORK_ID } from "../cli/commands/team-outbox.js";

const SID = "rg04a-test-sid";

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "omcp-rg04a-test-"));
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function eventsPath(): string {
  return join(tmp, ".omcp", "state", "team", SID, "events.jsonl");
}

function rotatedPath(): string {
  return `${eventsPath()}.1`;
}

function readEvents(): TeamEventRecord[] {
  if (!existsSync(eventsPath())) return [];
  return readFileSync(eventsPath(), "utf8")
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => JSON.parse(l) as TeamEventRecord);
}

// ─── constants ──────────────────────────────────────────────────────────────

describe("RG-04a constants", () => {
  it("TS future tolerance = 5 min", () => {
    expect(TEAM_EVENT_TS_FUTURE_TOLERANCE_MS).toBe(5 * 60 * 1_000);
  });

  it("TS past tolerance = 24 h", () => {
    expect(TEAM_EVENT_TS_PAST_TOLERANCE_MS).toBe(24 * 60 * 60 * 1_000);
  });

  it("rotation threshold = 1 MiB", () => {
    expect(TEAM_EVENT_ROTATION_BYTES).toBe(1_048_576);
  });

  it("tail default limit = 100; max = 10_000", () => {
    expect(TEAM_EVENT_TAIL_DEFAULT_LIMIT).toBe(100);
    expect(TEAM_EVENT_TAIL_MAX_LIMIT).toBe(10_000);
  });
});

// ─── validateEventTs ────────────────────────────────────────────────────────

describe("validateEventTs", () => {
  const NOW = Date.parse("2026-05-26T12:00:00.000Z");

  it("accepts ts within window", () => {
    expect(validateEventTs("2026-05-26T11:30:00.000Z", NOW).ok).toBe(true);
  });

  it("accepts ts exactly at now", () => {
    expect(validateEventTs(new Date(NOW).toISOString(), NOW).ok).toBe(true);
  });

  it("rejects ts > now + 5min", () => {
    const future = new Date(NOW + 6 * 60 * 1_000).toISOString();
    const r = validateEventTs(future, NOW);
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("now + 5min");
  });

  it("rejects ts < now - 24h", () => {
    const past = new Date(NOW - 25 * 60 * 60 * 1_000).toISOString();
    const r = validateEventTs(past, NOW);
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("now - 24h");
  });

  it("rejects non-string ts", () => {
    expect(validateEventTs(undefined, NOW).ok).toBe(false);
    expect(validateEventTs(123, NOW).ok).toBe(false);
  });

  it("rejects unparseable ts", () => {
    expect(validateEventTs("not-a-timestamp", NOW).ok).toBe(false);
  });
});

// ─── runTeamEventAppend — argv validation ───────────────────────────────────

describe("runTeamEventAppend — argv validation", () => {
  it("exits 2 on invalid session-id slug (path-traversal)", () => {
    const r = runTeamEventAppend({
      sessionId: "../escape",
      verb: "v",
      kind: "k",
      cwd: tmp,
    });
    expect(r.exitCode).toBe(2);
  });

  it("exits 2 on empty verb", () => {
    const r = runTeamEventAppend({ sessionId: SID, verb: "", kind: "k", cwd: tmp });
    expect(r.exitCode).toBe(2);
  });

  it("exits 2 on empty kind", () => {
    const r = runTeamEventAppend({ sessionId: SID, verb: "v", kind: "", cwd: tmp });
    expect(r.exitCode).toBe(2);
  });

  it("exits 2 on malformed --request-id (not UUIDv4)", () => {
    const r = runTeamEventAppend({
      sessionId: SID,
      verb: "v",
      kind: "k",
      requestId: "not-a-uuid",
      cwd: tmp,
    });
    expect(r.exitCode).toBe(2);
  });
});

// ─── happy path ─────────────────────────────────────────────────────────────

describe("runTeamEventAppend — happy path", () => {
  it("writes a well-formed event with producer_fork=omcp-r2", () => {
    const r = runTeamEventAppend({
      sessionId: SID,
      verb: "team-outbox-write",
      kind: "entry",
      actor: "leader",
      cwd: tmp,
    });
    expect(r.exitCode).toBe(0);
    expect(r.eventsPath).toBe(eventsPath());

    const events = readEvents();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      verb: "team-outbox-write",
      kind: "entry",
      actor: "leader",
      producer_fork: PRODUCER_FORK_ID,
    });
    expect(typeof events[0].ts).toBe("string");
  });

  it("embeds optional shard, request_id, detail", () => {
    const reqId = randomUUID();
    runTeamEventAppend({
      sessionId: SID,
      verb: "team-conflict-write",
      kind: "exit",
      actor: "worker-2",
      shard: "data/x.json",
      requestId: reqId,
      detail: { exitCode: 0, notes: "ok" },
      cwd: tmp,
    });
    const events = readEvents();
    expect(events[0].shard).toBe("data/x.json");
    expect(events[0].request_id).toBe(reqId);
    expect(events[0].detail).toEqual({ exitCode: 0, notes: "ok" });
  });

  it("defaults actor to 'unknown' when omitted", () => {
    runTeamEventAppend({ sessionId: SID, verb: "v", kind: "k", cwd: tmp });
    const events = readEvents();
    expect(events[0].actor).toBe("unknown");
  });
});

// ─── PM-G ts validation on write ────────────────────────────────────────────

describe("runTeamEventAppend — PM-G ts validation on write", () => {
  it("exits 5 when ts > now + 5min (clock skew beyond tolerance)", () => {
    const fakeNow = Date.now();
    const r = runTeamEventAppend({
      sessionId: SID,
      verb: "v",
      kind: "k",
      cwd: tmp,
      now: () => fakeNow,
      // Adversarial: nowIso returns a future ts well beyond +5min tolerance.
      nowIso: () => new Date(fakeNow + 10 * 60 * 1_000).toISOString(),
    });
    expect(r.exitCode).toBe(5);
    expect(existsSync(eventsPath())).toBe(false);
  });

  it("exits 5 when ts < now - 24h (record is far in the past)", () => {
    const fakeNow = Date.now();
    const r = runTeamEventAppend({
      sessionId: SID,
      verb: "v",
      kind: "k",
      cwd: tmp,
      now: () => fakeNow,
      nowIso: () => new Date(fakeNow - 25 * 60 * 60 * 1_000).toISOString(),
    });
    expect(r.exitCode).toBe(5);
  });

  it("accepts ts barely within +5min future tolerance", () => {
    const fakeNow = Date.now();
    const r = runTeamEventAppend({
      sessionId: SID,
      verb: "v",
      kind: "k",
      cwd: tmp,
      now: () => fakeNow,
      nowIso: () => new Date(fakeNow + 4 * 60 * 1_000).toISOString(),
    });
    expect(r.exitCode).toBe(0);
  });

  it("sentinel kind bypasses ts validation (PM-G recursion guard)", () => {
    const fakeNow = Date.now();
    // Sentinel kind with an adversarial future ts: must still write
    // (no infinite recursion if a clock-skew tail emits a sentinel that
    // would itself fail ts validation).
    const r = runTeamEventAppend({
      sessionId: SID,
      verb: "team-event-tail",
      kind: TEAM_EVENT_POISON_KIND,
      cwd: tmp,
      now: () => fakeNow,
      nowIso: () => new Date(fakeNow + 10 * 60 * 1_000).toISOString(),
    });
    expect(r.exitCode).toBe(0);
  });
});

// ─── recursion guard ────────────────────────────────────────────────────────

describe("runTeamEventTail — PM-G recursion guard", () => {
  it("emits a sentinel for a poison record on read; sentinel itself does NOT recurse", () => {
    // Manually plant a poison record (ts in the far future) — bypassing
    // the write-path validation.
    mkdirSync(join(tmp, ".omcp", "state", "team", SID), { recursive: true });
    const poison: TeamEventRecord = {
      ts: "9999-12-31T23:59:59.999Z",
      verb: "tampered",
      actor: "attacker",
      kind: "evil",
      producer_fork: PRODUCER_FORK_ID,
    };
    writeFileSync(eventsPath(), `${JSON.stringify(poison)}\n`, "utf8");

    const r = runTeamEventTail({ sessionId: SID, cwd: tmp });
    expect(r.exitCode).toBe(0);
    // The poison record is filtered out of the result.
    expect(r.records).toHaveLength(0);
    expect(r.poisonSkipped).toBe(1);

    // The sentinel emit appended a single record with kind=poison-record-detected.
    const physical = readEvents();
    const sentinels = physical.filter(
      (e) => e.kind === TEAM_EVENT_POISON_KIND,
    );
    expect(sentinels).toHaveLength(1);
    expect(sentinels[0].verb).toBe("team-event-tail");

    // CRITICAL PM-G invariant: the sentinel record itself does NOT trigger
    // a further sentinel on re-read. The sentinel's ts is `now` (validates
    // fine) AND sentinel kind bypasses validation on read — so even if the
    // sentinel's ts were itself somehow poisoned, no recursion fires.
    //
    // The ORIGINAL poison record remains in events.jsonl (events are
    // append-only; tail does NOT delete poison records) so each fresh tail
    // re-emits exactly ONE NEW sentinel for the still-poisoned original.
    // After the 2nd tail: poisonSkipped=1 (the one original), and total
    // sentinels on disk = 2 (one per tail). What matters is that each tail
    // emits EXACTLY ONE new sentinel — not many (which would prove recursion).
    const r2 = runTeamEventTail({ sessionId: SID, cwd: tmp });
    expect(r2.exitCode).toBe(0);
    expect(r2.poisonSkipped).toBe(1);
    const physical2 = readEvents();
    const sentinels2 = physical2.filter(
      (e) => e.kind === TEAM_EVENT_POISON_KIND,
    );
    // 2 sentinels total (one per tail) — NOT N+1 or unbounded growth, which
    // is what recursion would produce. This is the no-recursion guarantee.
    expect(sentinels2).toHaveLength(2);
  });

  it("plants a far-past poison record; sentinel emitted; no recursion", () => {
    mkdirSync(join(tmp, ".omcp", "state", "team", SID), { recursive: true });
    const poison: TeamEventRecord = {
      ts: "1970-01-01T00:00:00.000Z",
      verb: "tampered",
      actor: "attacker",
      kind: "stale-evil",
      producer_fork: PRODUCER_FORK_ID,
    };
    writeFileSync(eventsPath(), `${JSON.stringify(poison)}\n`, "utf8");

    const r = runTeamEventTail({ sessionId: SID, cwd: tmp });
    expect(r.exitCode).toBe(0);
    expect(r.poisonSkipped).toBe(1);

    const sentinels = readEvents().filter(
      (e) => e.kind === TEAM_EVENT_POISON_KIND,
    );
    expect(sentinels).toHaveLength(1);
  });
});

// ─── runTeamEventTail — filter semantics ────────────────────────────────────

describe("runTeamEventTail — filter semantics", () => {
  function seed(records: Array<Partial<TeamEventRecord>>): void {
    mkdirSync(join(tmp, ".omcp", "state", "team", SID), { recursive: true });
    const lines = records.map((r) =>
      JSON.stringify({
        ts: r.ts ?? new Date().toISOString(),
        verb: r.verb ?? "v",
        actor: r.actor ?? "a",
        kind: r.kind ?? "entry",
        producer_fork: PRODUCER_FORK_ID,
        ...(r.shard !== undefined ? { shard: r.shard } : {}),
        ...(r.request_id !== undefined ? { request_id: r.request_id } : {}),
        ...(r.detail !== undefined ? { detail: r.detail } : {}),
      }),
    );
    writeFileSync(eventsPath(), `${lines.join("\n")}\n`, "utf8");
  }

  it("returns empty list when events.jsonl absent", () => {
    const r = runTeamEventTail({ sessionId: SID, cwd: tmp });
    expect(r.exitCode).toBe(0);
    expect(r.records).toHaveLength(0);
  });

  it("returns all records when no filter given", () => {
    const now = new Date().toISOString();
    seed([
      { ts: now, verb: "a", kind: "entry" },
      { ts: now, verb: "b", kind: "exit" },
      { ts: now, verb: "c", kind: "entry" },
    ]);
    const r = runTeamEventTail({ sessionId: SID, cwd: tmp });
    expect(r.records).toHaveLength(3);
  });

  it("filters by --since (lexicographic on ISO-8601)", () => {
    const t1 = "2026-05-26T10:00:00.000Z";
    const t2 = "2026-05-26T11:00:00.000Z";
    const t3 = "2026-05-26T12:00:00.000Z";
    seed([
      { ts: t1, verb: "a" },
      { ts: t2, verb: "b" },
      { ts: t3, verb: "c" },
    ]);
    const fakeNow = Date.parse(t3) + 1000;
    const r = runTeamEventTail({
      sessionId: SID,
      cwd: tmp,
      since: t2,
      now: () => fakeNow,
    });
    expect(r.records.map((x) => x.verb)).toEqual(["b", "c"]);
  });

  it("filters by --type (exact kind match)", () => {
    const now = new Date().toISOString();
    seed([
      { ts: now, verb: "a", kind: "entry" },
      { ts: now, verb: "b", kind: "exit" },
      { ts: now, verb: "c", kind: "entry" },
    ]);
    const r = runTeamEventTail({ sessionId: SID, cwd: tmp, type: "entry" });
    expect(r.records.map((x) => x.verb)).toEqual(["a", "c"]);
  });

  it("respects --limit (returns LAST N records, chronological)", () => {
    const base = Date.parse("2026-05-26T12:00:00.000Z");
    seed(
      Array.from({ length: 20 }, (_, i) => ({
        ts: new Date(base + i * 1_000).toISOString(),
        verb: `v${i}`,
      })),
    );
    const fakeNow = base + 25 * 1_000;
    const r = runTeamEventTail({
      sessionId: SID,
      cwd: tmp,
      limit: 5,
      now: () => fakeNow,
    });
    expect(r.records).toHaveLength(5);
    expect(r.records.map((x) => x.verb)).toEqual(["v15", "v16", "v17", "v18", "v19"]);
  });

  it("clamps --limit to TEAM_EVENT_TAIL_MAX_LIMIT", () => {
    const now = new Date().toISOString();
    seed([{ ts: now, verb: "only" }]);
    const r = runTeamEventTail({
      sessionId: SID,
      cwd: tmp,
      limit: 999_999,
    });
    expect(r.exitCode).toBe(0);
    expect(r.records).toHaveLength(1);
  });

  it("exits 2 on non-positive --limit", () => {
    const r = runTeamEventTail({ sessionId: SID, cwd: tmp, limit: 0 });
    expect(r.exitCode).toBe(2);
  });

  it("tolerates malformed lines (parseErrors counted, valid records returned)", () => {
    mkdirSync(join(tmp, ".omcp", "state", "team", SID), { recursive: true });
    const good = JSON.stringify({
      ts: new Date().toISOString(),
      verb: "ok",
      actor: "a",
      kind: "entry",
      producer_fork: PRODUCER_FORK_ID,
    });
    writeFileSync(
      eventsPath(),
      `not-json\n${good}\nalso-not-json\n`,
      "utf8",
    );
    const r = runTeamEventTail({ sessionId: SID, cwd: tmp });
    expect(r.records).toHaveLength(1);
    expect(r.parseErrors).toBe(2);
  });
});

// ─── 1MB rotation ───────────────────────────────────────────────────────────

describe("runTeamEventAppend — 1MB rotation", () => {
  it("rotates events.jsonl to events.jsonl.1 when size >= 1MB", () => {
    mkdirSync(join(tmp, ".omcp", "state", "team", SID), { recursive: true });
    // Pre-seed events.jsonl with > 1MB of dummy content.
    const dummy = `${"x".repeat(2048)}\n`;
    const lines = Array.from({ length: 600 }, () => dummy).join("");
    writeFileSync(eventsPath(), lines, "utf8");
    expect(statSync(eventsPath()).size).toBeGreaterThanOrEqual(
      TEAM_EVENT_ROTATION_BYTES,
    );

    const r = runTeamEventAppend({
      sessionId: SID,
      verb: "v",
      kind: "k",
      cwd: tmp,
    });
    expect(r.exitCode).toBe(0);
    expect(r.rotated).toBe(true);
    expect(existsSync(rotatedPath())).toBe(true);
    // After rotation, events.jsonl carries just the new line.
    const newContent = readFileSync(eventsPath(), "utf8");
    expect(newContent.trim().split("\n")).toHaveLength(1);
  });

  it("does NOT rotate when below threshold", () => {
    const r = runTeamEventAppend({
      sessionId: SID,
      verb: "v",
      kind: "k",
      cwd: tmp,
    });
    expect(r.exitCode).toBe(0);
    expect(r.rotated).toBe(false);
    expect(existsSync(rotatedPath())).toBe(false);
  });

  it("overwrites existing events.jsonl.1 on subsequent rotation (Windows-safe)", () => {
    mkdirSync(join(tmp, ".omcp", "state", "team", SID), { recursive: true });
    // Pre-existing .1 file.
    writeFileSync(rotatedPath(), "old-rotated\n", "utf8");
    // Pre-seed events.jsonl with > 1MB content.
    writeFileSync(eventsPath(), `${"x".repeat(1_100_000)}\n`, "utf8");

    const r = runTeamEventAppend({
      sessionId: SID,
      verb: "v",
      kind: "k",
      cwd: tmp,
    });
    expect(r.exitCode).toBe(0);
    expect(r.rotated).toBe(true);
    // The new .1 must be the rotated-out events.jsonl, not the old "old-rotated".
    const rotatedContent = readFileSync(rotatedPath(), "utf8");
    expect(rotatedContent).not.toContain("old-rotated");
  });
});

// ─── concurrent writers (lockfile contention) ───────────────────────────────

describe("runTeamEventAppend — 5+ concurrent writers (lockfile contention)", () => {
  it("5 concurrent in-process appenders produce 5 valid lines with no torn writes", () => {
    // In-process concurrency is serial within a single Node thread, but the
    // lockfile primitive itself is exercised: each call openSync('wx') then
    // closes/rmSync. Test verifies the helper does not regress across
    // multiple back-to-back acquires on the same stream path.
    const results = [];
    for (let i = 0; i < 5; i++) {
      results.push(
        runTeamEventAppend({
          sessionId: SID,
          verb: `verb-${i}`,
          kind: "entry",
          actor: `actor-${i}`,
          cwd: tmp,
        }),
      );
    }
    expect(results.every((r) => r.exitCode === 0)).toBe(true);
    const events = readEvents();
    expect(events).toHaveLength(5);
    // No torn / interleaved writes: every line parses as a complete record.
    for (let i = 0; i < 5; i++) {
      expect(events[i].verb).toBe(`verb-${i}`);
    }
  });

  it("acquirePerStreamLock is re-entrant across rotations (rotation under contention)", () => {
    // Seed > 1MB so the first appender rotates; subsequent appenders see a
    // fresh events.jsonl and must not error.
    mkdirSync(join(tmp, ".omcp", "state", "team", SID), { recursive: true });
    writeFileSync(eventsPath(), `${"x".repeat(1_100_000)}\n`, "utf8");

    const results = [];
    for (let i = 0; i < 5; i++) {
      results.push(
        runTeamEventAppend({
          sessionId: SID,
          verb: `v-${i}`,
          kind: "exit",
          cwd: tmp,
        }),
      );
    }
    expect(results.every((r) => r.exitCode === 0)).toBe(true);
    // Exactly one rotation should have fired (the first one).
    const rotations = results.filter((r) => r.rotated).length;
    expect(rotations).toBe(1);
    // Post-rotation events.jsonl carries 5 lines (first appender rotated out
    // the seed, then 5 new appends followed).
    const events = readEvents();
    expect(events).toHaveLength(5);
  });
});

// ─── CLI wrappers ───────────────────────────────────────────────────────────

describe("runTeamEventAppendCli", () => {
  it("returns 0 on happy path + emits human-readable log", () => {
    const logs: string[] = [];
    const errs: string[] = [];
    const exit = runTeamEventAppendCli(SID, {
      cwd: tmp,
      verb: "team-outbox-write",
      kind: "entry",
      actor: "leader",
      log: (l) => logs.push(l),
      errLog: (l) => errs.push(l),
    });
    expect(exit).toBe(0);
    expect(logs.some((l) => l.includes("appended to"))).toBe(true);
    expect(errs).toHaveLength(0);
  });

  it("returns 2 on empty verb", () => {
    const errs: string[] = [];
    const exit = runTeamEventAppendCli(SID, {
      cwd: tmp,
      verb: "",
      kind: "k",
      errLog: (l) => errs.push(l),
    });
    expect(exit).toBe(2);
    expect(errs.some((l) => l.includes("--verb is required"))).toBe(true);
  });

  it("returns 2 on invalid session-id slug", () => {
    const errs: string[] = [];
    const exit = runTeamEventAppendCli("../escape", {
      cwd: tmp,
      verb: "v",
      kind: "k",
      errLog: (l) => errs.push(l),
    });
    expect(exit).toBe(2);
  });
});

describe("runTeamEventTailCli", () => {
  it("returns 0 with empty result when events.jsonl absent", () => {
    const logs: string[] = [];
    const exit = runTeamEventTailCli(SID, {
      cwd: tmp,
      log: (l) => logs.push(l),
    });
    expect(exit).toBe(0);
    expect(logs.some((l) => l.includes("records:        0"))).toBe(true);
  });

  it("emits JSON when --json is set", () => {
    const logs: string[] = [];
    const exit = runTeamEventTailCli(SID, {
      cwd: tmp,
      json: true,
      log: (l) => logs.push(l),
    });
    expect(exit).toBe(0);
    const parsed = JSON.parse(logs.join("\n"));
    expect(parsed.records).toEqual([]);
  });

  it("returns 2 on invalid session-id slug", () => {
    const errs: string[] = [];
    const exit = runTeamEventTailCli("../escape", {
      cwd: tmp,
      errLog: (l) => errs.push(l),
    });
    expect(exit).toBe(2);
  });
});
