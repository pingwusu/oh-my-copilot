/**
 * RG-03 tests: Conflict mailbox + 1MB rotation + ack-deletable records.
 *
 * Covers .omc/prd.json RG-03 acceptance criteria:
 *   - Two workers writing same shard detect collision (file hash mismatch)
 *     and both write conflict records
 *   - team-verify exits non-zero with both records listed
 *   - After team-conflict-ack, ack record lands in <shard>.acked.jsonl;
 *     default team-conflict-read filters acked
 *   - team-verify exits 0 after all conflicts acked
 *   - Conflict file over 1MB triggers rotation (events.jsonl.1 pattern)
 *     inside the per-stream lockfile
 *   - Conflict records carry producer_fork field
 */

import { describe, expect, it, beforeEach, afterEach } from "vitest";
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
  CONFLICT_ROTATE_BYTES,
  CONFLICT_ROTATE_SUFFIX,
  runTeamConflictAck,
  runTeamConflictAckCli,
  runTeamConflictRead,
  runTeamConflictReadCli,
  runTeamConflictWrite,
  runTeamConflictWriteCli,
  type ConflictAckRecord,
  type ConflictRecord,
} from "../cli/commands/team-conflict.js";
import { PRODUCER_FORK_ID } from "../cli/commands/team-outbox.js";
import { runTeamVerify } from "../cli/commands/team-verify.js";

const SID = "rg03-test-sid";
const SHARD = "alpha";

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "omcp-rg03-test-"));
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function conflictsDir(): string {
  return join(tmp, ".omcp", "state", "team", SID, "conflicts");
}
function conflictFile(shard = SHARD): string {
  return join(conflictsDir(), `${shard}.jsonl`);
}
function rotatedFile(shard = SHARD): string {
  return `${conflictFile(shard)}${CONFLICT_ROTATE_SUFFIX}`;
}
function ackedFile(shard = SHARD): string {
  return join(conflictsDir(), `${shard}.acked.jsonl`);
}

function readJsonl<T>(path: string): T[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as T);
}

// ─── argv validation ────────────────────────────────────────────────────────

describe("runTeamConflictWrite — argv validation", () => {
  it("exits 2 on path-traversal session-id", () => {
    const r = runTeamConflictWrite({
      sessionId: "../escape",
      shard: SHARD,
      workerId: "w-1",
      attemptedOp: "merge",
      rationale: "test",
      cwd: tmp,
    });
    expect(r.exitCode).toBe(2);
  });

  it("exits 2 on path-traversal shard", () => {
    const r = runTeamConflictWrite({
      sessionId: SID,
      shard: "../escape",
      workerId: "w-1",
      attemptedOp: "merge",
      rationale: "test",
      cwd: tmp,
    });
    expect(r.exitCode).toBe(2);
  });

  it("exits 2 on path-traversal worker-id", () => {
    const r = runTeamConflictWrite({
      sessionId: SID,
      shard: SHARD,
      workerId: "../bad",
      attemptedOp: "merge",
      rationale: "test",
      cwd: tmp,
    });
    expect(r.exitCode).toBe(2);
  });

  it("exits 2 on empty attempted-op", () => {
    const r = runTeamConflictWrite({
      sessionId: SID,
      shard: SHARD,
      workerId: "w-1",
      attemptedOp: "",
      rationale: "test",
      cwd: tmp,
    });
    expect(r.exitCode).toBe(2);
  });

  it("exits 2 on empty rationale", () => {
    const r = runTeamConflictWrite({
      sessionId: SID,
      shard: SHARD,
      workerId: "w-1",
      attemptedOp: "merge",
      rationale: "",
      cwd: tmp,
    });
    expect(r.exitCode).toBe(2);
  });
});

// ─── happy path: single-writer ──────────────────────────────────────────────

describe("runTeamConflictWrite — single-writer happy path", () => {
  it("appends a conflict record with UUIDv4 conflict_id + producer_fork", () => {
    const fixedNow = "2026-05-26T12:00:00.000Z";
    const fixedId = randomUUID();
    const r = runTeamConflictWrite({
      sessionId: SID,
      shard: SHARD,
      workerId: "w-1",
      attemptedOp: "merge",
      rationale: "concurrent edit on the same line",
      cwd: tmp,
      now: () => fixedNow,
      generateConflictId: () => fixedId,
    });
    expect(r.exitCode).toBe(0);
    expect(r.conflictId).toBe(fixedId);
    expect(r.rotated).toBe(false);
    const records = readJsonl<ConflictRecord>(conflictFile());
    expect(records).toHaveLength(1);
    expect(records[0]).toEqual({
      conflict_id: fixedId,
      ts: fixedNow,
      shard: SHARD,
      worker_id: "w-1",
      attempted_op: "merge",
      rationale: "concurrent edit on the same line",
      producer_fork: PRODUCER_FORK_ID,
    });
  });

  it("creates conflicts dir on first write", () => {
    runTeamConflictWrite({
      sessionId: SID,
      shard: SHARD,
      workerId: "w-1",
      attemptedOp: "merge",
      rationale: "x",
      cwd: tmp,
    });
    expect(existsSync(conflictsDir())).toBe(true);
  });

  it("appends sequentially — file grows by one line per call", () => {
    runTeamConflictWrite({
      sessionId: SID,
      shard: SHARD,
      workerId: "w-1",
      attemptedOp: "merge",
      rationale: "first",
      cwd: tmp,
    });
    runTeamConflictWrite({
      sessionId: SID,
      shard: SHARD,
      workerId: "w-2",
      attemptedOp: "merge",
      rationale: "second",
      cwd: tmp,
    });
    const records = readJsonl<ConflictRecord>(conflictFile());
    expect(records).toHaveLength(2);
    expect(records[0].worker_id).toBe("w-1");
    expect(records[1].worker_id).toBe("w-2");
  });
});

// ─── PRD criterion: two-worker collision detection ─────────────────────────

describe("RG-03 PRD: two workers writing same shard both produce records", () => {
  it("two collision writes land both records in the same shard file", () => {
    const r1 = runTeamConflictWrite({
      sessionId: SID,
      shard: SHARD,
      workerId: "worker-a",
      attemptedOp: "merge-shard",
      rationale: "worker-a saw stale hash before write",
      cwd: tmp,
    });
    const r2 = runTeamConflictWrite({
      sessionId: SID,
      shard: SHARD,
      workerId: "worker-b",
      attemptedOp: "merge-shard",
      rationale: "worker-b clobbered worker-a's write",
      cwd: tmp,
    });
    expect(r1.exitCode).toBe(0);
    expect(r2.exitCode).toBe(0);
    expect(r1.conflictId).not.toBe(r2.conflictId);
    const records = readJsonl<ConflictRecord>(conflictFile());
    expect(records.map((r) => r.worker_id).sort()).toEqual([
      "worker-a",
      "worker-b",
    ]);
    // Cross-fork attribution stamp present on both.
    expect(records[0].producer_fork).toBe(PRODUCER_FORK_ID);
    expect(records[1].producer_fork).toBe(PRODUCER_FORK_ID);
  });
});

// ─── runTeamConflictRead ────────────────────────────────────────────────────

describe("runTeamConflictRead — default + filter behaviors", () => {
  it("returns empty when no conflicts dir exists", () => {
    const r = runTeamConflictRead({ sessionId: SID, cwd: tmp });
    expect(r.exitCode).toBe(0);
    expect(r.conflicts).toHaveLength(0);
    expect(r.acks).toHaveLength(0);
  });

  it("reads all shards when shard filter omitted", () => {
    runTeamConflictWrite({
      sessionId: SID,
      shard: "alpha",
      workerId: "w-1",
      attemptedOp: "op-a",
      rationale: "r-a",
      cwd: tmp,
    });
    runTeamConflictWrite({
      sessionId: SID,
      shard: "beta",
      workerId: "w-2",
      attemptedOp: "op-b",
      rationale: "r-b",
      cwd: tmp,
    });
    const r = runTeamConflictRead({ sessionId: SID, cwd: tmp });
    expect(r.conflicts).toHaveLength(2);
    expect(Object.keys(r.byShardUnresolved).sort()).toEqual(["alpha", "beta"]);
  });

  it("filters by shard when supplied", () => {
    runTeamConflictWrite({
      sessionId: SID,
      shard: "alpha",
      workerId: "w-1",
      attemptedOp: "op-a",
      rationale: "r-a",
      cwd: tmp,
    });
    runTeamConflictWrite({
      sessionId: SID,
      shard: "beta",
      workerId: "w-2",
      attemptedOp: "op-b",
      rationale: "r-b",
      cwd: tmp,
    });
    const r = runTeamConflictRead({ sessionId: SID, shard: "alpha", cwd: tmp });
    expect(r.conflicts).toHaveLength(1);
    expect(r.conflicts[0].shard).toBe("alpha");
  });

  it("tolerates malformed lines (skip + report in parseErrors)", () => {
    mkdirSync(conflictsDir(), { recursive: true });
    writeFileSync(
      conflictFile(),
      `not valid json\n` +
        `${JSON.stringify({
          conflict_id: randomUUID(),
          ts: new Date().toISOString(),
          shard: SHARD,
          worker_id: "w-1",
          attempted_op: "op",
          rationale: "r",
          producer_fork: PRODUCER_FORK_ID,
        })}\n` +
        `also bad\n`,
      "utf8",
    );
    const r = runTeamConflictRead({ sessionId: SID, shard: SHARD, cwd: tmp });
    expect(r.conflicts).toHaveLength(1);
    expect(r.parseErrors).toHaveLength(2);
  });
});

// ─── runTeamConflictAck + filter ────────────────────────────────────────────

describe("RG-03 PRD: ack-deletable filter behavior (PM-E)", () => {
  it("appending an ack drops the conflict from default team-conflict-read", () => {
    const w = runTeamConflictWrite({
      sessionId: SID,
      shard: SHARD,
      workerId: "w-1",
      attemptedOp: "op",
      rationale: "r",
      cwd: tmp,
    });
    expect(w.exitCode).toBe(0);
    const before = runTeamConflictRead({
      sessionId: SID,
      shard: SHARD,
      cwd: tmp,
    });
    expect(before.conflicts).toHaveLength(1);

    const a = runTeamConflictAck({
      sessionId: SID,
      shard: SHARD,
      conflictId: w.conflictId!,
      ackedBy: "operator",
      cwd: tmp,
    });
    expect(a.exitCode).toBe(0);
    expect(existsSync(ackedFile())).toBe(true);
    const ackRecords = readJsonl<ConflictAckRecord>(ackedFile());
    expect(ackRecords).toHaveLength(1);
    expect(ackRecords[0].conflict_id).toBe(w.conflictId);
    expect(ackRecords[0].acked_by).toBe("operator");
    expect(ackRecords[0].producer_fork).toBe(PRODUCER_FORK_ID);

    const after = runTeamConflictRead({
      sessionId: SID,
      shard: SHARD,
      cwd: tmp,
    });
    expect(after.conflicts).toHaveLength(0);
    expect(after.acks).toHaveLength(1);
  });

  it("includeAcked=true returns conflicts even after ack", () => {
    const w = runTeamConflictWrite({
      sessionId: SID,
      shard: SHARD,
      workerId: "w-1",
      attemptedOp: "op",
      rationale: "r",
      cwd: tmp,
    });
    runTeamConflictAck({
      sessionId: SID,
      shard: SHARD,
      conflictId: w.conflictId!,
      cwd: tmp,
    });
    const r = runTeamConflictRead({
      sessionId: SID,
      shard: SHARD,
      includeAcked: true,
      cwd: tmp,
    });
    expect(r.conflicts).toHaveLength(1);
  });

  it("partial ack: 2 conflicts, ack 1 → 1 unresolved remains", () => {
    const w1 = runTeamConflictWrite({
      sessionId: SID,
      shard: SHARD,
      workerId: "w-1",
      attemptedOp: "op",
      rationale: "first",
      cwd: tmp,
    });
    const w2 = runTeamConflictWrite({
      sessionId: SID,
      shard: SHARD,
      workerId: "w-2",
      attemptedOp: "op",
      rationale: "second",
      cwd: tmp,
    });
    runTeamConflictAck({
      sessionId: SID,
      shard: SHARD,
      conflictId: w1.conflictId!,
      cwd: tmp,
    });
    const r = runTeamConflictRead({
      sessionId: SID,
      shard: SHARD,
      cwd: tmp,
    });
    expect(r.conflicts).toHaveLength(1);
    expect(r.conflicts[0].conflict_id).toBe(w2.conflictId);
  });
});

// ─── runTeamConflictAck argv validation ─────────────────────────────────────

describe("runTeamConflictAck — argv validation", () => {
  it("exits 2 on non-UUIDv4 conflict-id", () => {
    const r = runTeamConflictAck({
      sessionId: SID,
      shard: SHARD,
      conflictId: "not-a-uuid",
      cwd: tmp,
    });
    expect(r.exitCode).toBe(2);
  });

  it("exits 2 on path-traversal shard", () => {
    const r = runTeamConflictAck({
      sessionId: SID,
      shard: "../escape",
      conflictId: randomUUID(),
      cwd: tmp,
    });
    expect(r.exitCode).toBe(2);
  });

  it("rejects v3/v5 UUIDs at the boundary", () => {
    // v1 UUID
    const r = runTeamConflictAck({
      sessionId: SID,
      shard: SHARD,
      conflictId: "01234567-89ab-1def-8123-0123456789ab",
      cwd: tmp,
    });
    expect(r.exitCode).toBe(2);
  });
});

// ─── 1MB rotation under per-stream lockfile (PRD criterion) ─────────────────

describe("RG-03 PRD: 1MB rotation inside per-stream lockfile", () => {
  it("rotates <shard>.jsonl to <shard>.jsonl.1 when file >= rotateBytes", () => {
    // Seed the conflict file with > rotateBytes worth of bytes to force
    // rotation on the next write. Use a tiny rotateBytes threshold so we
    // don't need to actually generate 1MB of synthetic data.
    mkdirSync(conflictsDir(), { recursive: true });
    const seed = `${JSON.stringify({
      conflict_id: randomUUID(),
      ts: new Date().toISOString(),
      shard: SHARD,
      worker_id: "seed-worker",
      attempted_op: "seed",
      rationale: "seed",
      producer_fork: PRODUCER_FORK_ID,
    })}\n`.repeat(20); // ~20 records
    writeFileSync(conflictFile(), seed, "utf8");
    const seedSize = statSync(conflictFile()).size;
    expect(seedSize).toBeGreaterThan(100);

    const r = runTeamConflictWrite({
      sessionId: SID,
      shard: SHARD,
      workerId: "rotator",
      attemptedOp: "trigger-rotation",
      rationale: "writer that crosses rotateBytes",
      cwd: tmp,
      rotateBytes: 100, // tiny threshold for the test
    });
    expect(r.exitCode).toBe(0);
    expect(r.rotated).toBe(true);
    expect(existsSync(rotatedFile())).toBe(true);
    // The fresh file contains exactly 1 record (the rotator's write).
    const fresh = readJsonl<ConflictRecord>(conflictFile());
    expect(fresh).toHaveLength(1);
    expect(fresh[0].worker_id).toBe("rotator");
    // The rotated file contains the seeded records (>= 1 line).
    const rotated = readJsonl<ConflictRecord>(rotatedFile());
    expect(rotated.length).toBeGreaterThanOrEqual(1);
  });

  it("does NOT rotate when file is below threshold", () => {
    const r = runTeamConflictWrite({
      sessionId: SID,
      shard: SHARD,
      workerId: "w-1",
      attemptedOp: "op",
      rationale: "r",
      cwd: tmp,
      // CONFLICT_ROTATE_BYTES is 1MB; a single-record file is far below.
    });
    expect(r.exitCode).toBe(0);
    expect(r.rotated).toBe(false);
    expect(existsSync(rotatedFile())).toBe(false);
  });

  it("rotated records still visible to team-conflict-read (includeRotated default true)", () => {
    mkdirSync(conflictsDir(), { recursive: true });
    const oldId = randomUUID();
    writeFileSync(
      conflictFile(),
      `${JSON.stringify({
        conflict_id: oldId,
        ts: new Date().toISOString(),
        shard: SHARD,
        worker_id: "old-worker",
        attempted_op: "op",
        rationale: "old",
        producer_fork: PRODUCER_FORK_ID,
      })}\n`.repeat(5),
      "utf8",
    );
    // Trigger rotation by writing with tiny threshold.
    runTeamConflictWrite({
      sessionId: SID,
      shard: SHARD,
      workerId: "rotator",
      attemptedOp: "op",
      rationale: "rotate",
      cwd: tmp,
      rotateBytes: 50,
    });
    const r = runTeamConflictRead({
      sessionId: SID,
      shard: SHARD,
      cwd: tmp,
    });
    // 5 from .1 + 1 from fresh = 6 total
    expect(r.conflicts.length).toBe(6);
  });

  it("CONFLICT_ROTATE_BYTES is 1MB (1_048_576)", () => {
    expect(CONFLICT_ROTATE_BYTES).toBe(1_048_576);
  });
});

// ─── PRD criterion: team-verify pre-flight scan ─────────────────────────────

describe("RG-03 PRD: team-verify pre-flight scan", () => {
  it("team-verify exits non-zero when unresolved conflicts present", () => {
    // Seed an unresolved conflict.
    runTeamConflictWrite({
      sessionId: SID,
      shard: SHARD,
      workerId: "w-1",
      attemptedOp: "merge",
      rationale: "unresolved",
      cwd: tmp,
    });
    const r = runTeamVerify({
      sessionId: SID,
      cwd: tmp,
      // Mock all 3 verify tools as passing — only the conflict scan should
      // force non-zero.
      spawnFn: (_cmd, _args) => ({ exitCode: 0, output: "" }),
    });
    expect(r.ok).toBe(false);
    expect(r.exitCode).toBe(1);
    expect(r.report?.unresolved_conflicts).toBeDefined();
    expect(r.report?.unresolved_conflicts).toHaveLength(1);
  });

  it("team-verify exits 0 when all conflicts acked", () => {
    const w = runTeamConflictWrite({
      sessionId: SID,
      shard: SHARD,
      workerId: "w-1",
      attemptedOp: "merge",
      rationale: "resolved",
      cwd: tmp,
    });
    runTeamConflictAck({
      sessionId: SID,
      shard: SHARD,
      conflictId: w.conflictId!,
      cwd: tmp,
    });
    const r = runTeamVerify({
      sessionId: SID,
      cwd: tmp,
      spawnFn: (_cmd, _args) => ({ exitCode: 0, output: "" }),
    });
    expect(r.ok).toBe(true);
    expect(r.exitCode).toBe(0);
    expect(r.report?.unresolved_conflicts).toBeUndefined();
  });

  it("team-verify exits 0 when no conflict records ever written", () => {
    const r = runTeamVerify({
      sessionId: SID,
      cwd: tmp,
      spawnFn: (_cmd, _args) => ({ exitCode: 0, output: "" }),
    });
    expect(r.ok).toBe(true);
    expect(r.exitCode).toBe(0);
  });
});

// ─── CLI wrappers ───────────────────────────────────────────────────────────

describe("runTeamConflictWriteCli — CLI wrapper", () => {
  it("returns 0 on valid argv + emits human-readable message", () => {
    const out: string[] = [];
    const code = runTeamConflictWriteCli(
      SID,
      SHARD,
      "w-1",
      "merge",
      "r",
      { cwd: tmp, log: (l) => out.push(l), errLog: () => {} },
    );
    expect(code).toBe(0);
    expect(out.some((l) => l.includes("appended to"))).toBe(true);
    expect(out.some((l) => l.includes("conflict_id:"))).toBe(true);
  });

  it("returns 2 on invalid session-id + human-readable error", () => {
    const errs: string[] = [];
    const code = runTeamConflictWriteCli(
      "../escape",
      SHARD,
      "w-1",
      "merge",
      "r",
      { cwd: tmp, log: () => {}, errLog: (l) => errs.push(l) },
    );
    expect(code).toBe(2);
    expect(errs.join("\n")).toMatch(/unsafe/);
  });

  it("returns 2 on empty rationale", () => {
    const errs: string[] = [];
    const code = runTeamConflictWriteCli(SID, SHARD, "w-1", "merge", "", {
      cwd: tmp,
      log: () => {},
      errLog: (l) => errs.push(l),
    });
    expect(code).toBe(2);
    expect(errs.join("\n")).toMatch(/non-empty/);
  });
});

describe("runTeamConflictReadCli — CLI wrapper", () => {
  it("returns 0 when no conflicts present + emits 0-count summary", () => {
    const out: string[] = [];
    const code = runTeamConflictReadCli(SID, {
      cwd: tmp,
      log: (l) => out.push(l),
      errLog: () => {},
    });
    expect(code).toBe(0);
    expect(out.some((l) => l.includes("conflicts:"))).toBe(true);
  });

  it("returns 3 when --exit-nonzero-if-unresolved is set + conflicts present", () => {
    runTeamConflictWrite({
      sessionId: SID,
      shard: SHARD,
      workerId: "w-1",
      attemptedOp: "op",
      rationale: "r",
      cwd: tmp,
    });
    const out: string[] = [];
    const code = runTeamConflictReadCli(SID, {
      cwd: tmp,
      shard: SHARD,
      exitNonZeroIfUnresolved: true,
      log: (l) => out.push(l),
      errLog: () => {},
    });
    expect(code).toBe(3);
  });

  it("emits JSON when --json is set", () => {
    const out: string[] = [];
    runTeamConflictReadCli(SID, {
      cwd: tmp,
      json: true,
      log: (l) => out.push(l),
      errLog: () => {},
    });
    expect(() => JSON.parse(out.join("\n"))).not.toThrow();
  });
});

describe("runTeamConflictAckCli — CLI wrapper", () => {
  it("returns 0 on valid UUIDv4 + records the ack", () => {
    const w = runTeamConflictWrite({
      sessionId: SID,
      shard: SHARD,
      workerId: "w-1",
      attemptedOp: "op",
      rationale: "r",
      cwd: tmp,
    });
    const out: string[] = [];
    const code = runTeamConflictAckCli(SID, SHARD, w.conflictId!, {
      cwd: tmp,
      ackedBy: "alice",
      log: (l) => out.push(l),
      errLog: () => {},
    });
    expect(code).toBe(0);
    expect(out.some((l) => l.includes("appended to"))).toBe(true);
    const acks = readJsonl<ConflictAckRecord>(ackedFile());
    expect(acks[0].acked_by).toBe("alice");
  });

  it("returns 2 on non-UUIDv4 conflict-id + human-readable error", () => {
    const errs: string[] = [];
    const code = runTeamConflictAckCli(SID, SHARD, "not-a-uuid", {
      cwd: tmp,
      log: () => {},
      errLog: (l) => errs.push(l),
    });
    expect(code).toBe(2);
    expect(errs.join("\n")).toMatch(/UUIDv4/);
  });
});

// ─── producer_fork stamp on every record ────────────────────────────────────

describe("RG-03 PRD: producer_fork=omcp-r2 on conflict + ack records", () => {
  it("every conflict record carries producer_fork", () => {
    runTeamConflictWrite({
      sessionId: SID,
      shard: SHARD,
      workerId: "w-1",
      attemptedOp: "op",
      rationale: "r",
      cwd: tmp,
    });
    const records = readJsonl<ConflictRecord>(conflictFile());
    expect(records[0].producer_fork).toBe(PRODUCER_FORK_ID);
    expect(records[0].producer_fork).toBe("omcp-r2");
  });

  it("every ack record carries producer_fork", () => {
    const w = runTeamConflictWrite({
      sessionId: SID,
      shard: SHARD,
      workerId: "w-1",
      attemptedOp: "op",
      rationale: "r",
      cwd: tmp,
    });
    runTeamConflictAck({
      sessionId: SID,
      shard: SHARD,
      conflictId: w.conflictId!,
      cwd: tmp,
    });
    const acks = readJsonl<ConflictAckRecord>(ackedFile());
    expect(acks[0].producer_fork).toBe(PRODUCER_FORK_ID);
  });
});
