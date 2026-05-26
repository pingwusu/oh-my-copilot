// `omcp team-conflict-write` / `team-conflict-read` / `team-conflict-ack` —
// RG-03 conflict mailbox primitive (ralplan-robin-gap-closing.md §5 RG-03,
// ADR-RG-03, PM-E mitigation).
//
// Per-shard append-only JSONL stream at
// `.omcp/state/team/<sid>/conflicts/<shard>.jsonl` carries conflict records
// emitted by workers that detected a collision on `<shard>`. team-verify
// gains a pre-flight scan that surfaces unresolved conflicts before
// declaring a shard merge clean. Conflict resolution flow:
//
//   1. worker A + worker B both attempt to write the same shard
//   2. each writes a conflict record via team-conflict-write
//   3. team-verify reads unresolved conflicts; exits non-zero with both listed
//   4. human resolves the conflict + writes team-conflict-ack <conflict-id>
//   5. ack record lands in `<shard>.acked.jsonl`; team-conflict-read filters it out
//   6. team-verify exits 0
//
// Storage shape (PM-E retention contract):
//   - Conflict records: `<shard>.jsonl` (append-only, rotated at 1MB to
//     `<shard>.jsonl.1`; rotation happens INSIDE the per-stream lockfile per
//     architect A2 contract)
//   - Ack records: `<shard>.acked.jsonl` (sibling stream; team-conflict-read
//     subtracts these from the conflict set by default)
//
// Concurrency contract (A2 per-stream lockfile):
//   - Conflict-write acquires `<shard>.jsonl.lock`; rotation decision happens
//     INSIDE the lock so two writers cannot race on the `.1` rename.
//   - Ack-write acquires `<shard>.acked.jsonl.lock` (independent stream).
//   - Read is lockless (tolerates partial-line tail per ADR-EB-02 §5 pattern).
//
// Conflict-record schema:
//   {conflict_id: <UUIDv4>, ts, shard, worker_id, attempted_op, rationale,
//    producer_fork: "omcp-r2"}
// Acked-record schema:
//   {conflict_id, acked_ts, acked_by, producer_fork: "omcp-r2"}
//
// Invariants honored:
//   I1 — assertSafeSlug on sessionId + shard + worker_id (path interpolation)
//   I2 — per-stream lockfile sidecar pattern (sibling of outbox carve-out)
//   I8 — registered as `omcp team-conflict-write/read/ack` in src/cli/omcp.ts
//
// Exit codes:
//   0 — success
//   2 — invalid argv (bad slug, missing args, malformed UUIDv4)
//   3 — read found unresolved conflicts (team-conflict-read default with
//        --exit-nonzero-if-unresolved); plain read uses 0 unconditionally
//   4 — lock-contention exhausted (write/ack paths)
//   1 — unexpected I/O error

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";

import { assertSafeSlug, UnsafeSlugError } from "../../runtime/safe-slug.js";
import {
  PerStreamLockExhaustedError,
  acquirePerStreamLock,
} from "../../runtime/per-stream-lock.js";
import { PRODUCER_FORK_ID, isValidUuidV4 } from "./team-outbox.js";

// ─── constants ───────────────────────────────────────────────────────────────

/** Rotation threshold (bytes). Files exceeding this rotate to `<stream>.1`. */
export const CONFLICT_ROTATE_BYTES = 1_048_576; // 1 MB

/** Reserved suffix for rotated conflict files. */
export const CONFLICT_ROTATE_SUFFIX = ".1";

// ─── types ──────────────────────────────────────────────────────────────────

/**
 * Conflict record written by `team-conflict-write`. Append-only per-shard.
 * `conflict_id` is a UUIDv4 generated at write time; callers reference this
 * id when issuing `team-conflict-ack`.
 */
export interface ConflictRecord {
  conflict_id: string;
  ts: string;
  shard: string;
  worker_id: string;
  attempted_op: string;
  rationale: string;
  producer_fork: string;
}

/**
 * Ack record written by `team-conflict-ack`. Append-only per-shard sibling
 * stream. Marks a `conflict_id` as resolved; `team-conflict-read` filters
 * out conflicts whose ids appear here.
 */
export interface ConflictAckRecord {
  conflict_id: string;
  acked_ts: string;
  acked_by: string;
  producer_fork: string;
}

// ─── path helpers ────────────────────────────────────────────────────────────

function conflictsDir(cwd: string, sessionId: string): string {
  return join(cwd, ".omcp", "state", "team", sessionId, "conflicts");
}

function conflictPath(cwd: string, sessionId: string, shard: string): string {
  return join(conflictsDir(cwd, sessionId), `${shard}.jsonl`);
}

function ackedPath(cwd: string, sessionId: string, shard: string): string {
  return join(conflictsDir(cwd, sessionId), `${shard}.acked.jsonl`);
}

// ─── team-conflict-write ─────────────────────────────────────────────────────

export interface RunTeamConflictWriteOpts {
  sessionId: string;
  shard: string;
  workerId: string;
  attemptedOp: string;
  rationale: string;
  /** Override cwd (test hook). */
  cwd?: string;
  /** Test hook: timestamp source. Default new Date().toISOString(). */
  now?: () => string;
  /** Test hook: synchronous sleep for the per-stream lock backoff. */
  sleep?: (ms: number) => void;
  /** Test hook: override backoff sequence. */
  backoffMs?: readonly number[];
  /** Test hook: override stale-lock threshold. */
  staleLockMs?: number;
  /** Test hook: override rotation byte threshold (default CONFLICT_ROTATE_BYTES). */
  rotateBytes?: number;
  /** Test hook: override conflict_id generator. */
  generateConflictId?: () => string;
}

export interface RunTeamConflictWriteResult {
  /** 0 ok, 2 invalid argv, 4 lock-contention, 1 other error. */
  exitCode: number;
  /** Generated conflict_id (when exitCode 0). */
  conflictId?: string;
  /** Absolute path of the conflict file appended to. */
  conflictPath?: string;
  /** True iff the file was rotated to `<shard>.jsonl.1` during this write. */
  rotated: boolean;
  /** Retries spent acquiring the per-stream lockfile. */
  retries: number;
  /** True iff a stale lockfile was force-removed during retry. */
  staleLockfileRemoved: boolean;
}

/**
 * Append a conflict record to `<shard>.jsonl`. When the file is already at
 * or above `rotateBytes`, the per-stream lock is acquired, the file is
 * renamed to `<shard>.jsonl.1` (replacing any previous rotation), and the
 * new record is written to a fresh file. Rotation happens INSIDE the lock
 * so two writers cannot race on the rename (architect A2 contract).
 */
export function runTeamConflictWrite(
  opts: RunTeamConflictWriteOpts,
): RunTeamConflictWriteResult {
  // Invariant 1 — validate every slug used in path interpolation.
  try {
    assertSafeSlug(opts.sessionId, "session-id");
    assertSafeSlug(opts.shard, "shard");
    assertSafeSlug(opts.workerId, "worker-id");
  } catch {
    return {
      exitCode: 2,
      rotated: false,
      retries: 0,
      staleLockfileRemoved: false,
    };
  }

  // attempted_op + rationale are free-form text; reject only if empty.
  if (
    typeof opts.attemptedOp !== "string" ||
    opts.attemptedOp.length === 0 ||
    typeof opts.rationale !== "string" ||
    opts.rationale.length === 0
  ) {
    return {
      exitCode: 2,
      rotated: false,
      retries: 0,
      staleLockfileRemoved: false,
    };
  }

  const cwd = opts.cwd ?? process.cwd();
  const now = opts.now ?? (() => new Date().toISOString());
  const rotateBytes = opts.rotateBytes ?? CONFLICT_ROTATE_BYTES;
  const generateConflictId = opts.generateConflictId ?? (() => randomUUID());

  const dir = conflictsDir(cwd, opts.sessionId);
  mkdirSync(dir, { recursive: true });
  const filePath = conflictPath(cwd, opts.sessionId, opts.shard);

  const conflictId = generateConflictId();
  const record: ConflictRecord = {
    conflict_id: conflictId,
    ts: now(),
    shard: opts.shard,
    worker_id: opts.workerId,
    attempted_op: opts.attemptedOp,
    rationale: opts.rationale,
    producer_fork: PRODUCER_FORK_ID,
  };
  const line = `${JSON.stringify(record)}\n`;

  // Acquire per-stream lock; rotate-then-append inside the critical section.
  let lock;
  try {
    lock = acquirePerStreamLock(filePath, {
      sleep: opts.sleep,
      backoffMs: opts.backoffMs,
      staleLockMs: opts.staleLockMs,
    });
  } catch (err) {
    if (err instanceof PerStreamLockExhaustedError) {
      return {
        exitCode: 4,
        rotated: false,
        retries: err.retries,
        staleLockfileRemoved: false,
      };
    }
    return {
      exitCode: 1,
      rotated: false,
      retries: 0,
      staleLockfileRemoved: false,
    };
  }

  let rotated = false;
  try {
    // 1MB rotation INSIDE the lock — recheck size under the lock so two
    // writers cannot both trigger a rename race.
    if (existsSync(filePath)) {
      const sz = statSync(filePath).size;
      if (sz >= rotateBytes) {
        const rotatedPath = `${filePath}${CONFLICT_ROTATE_SUFFIX}`;
        // renameSync atomically replaces any existing `.1` (POSIX + NTFS).
        renameSync(filePath, rotatedPath);
        rotated = true;
      }
    }
    appendFileSync(filePath, line, { encoding: "utf8" });
  } catch {
    return {
      exitCode: 1,
      conflictId,
      conflictPath: filePath,
      rotated,
      retries: lock.retries,
      staleLockfileRemoved: lock.staleLockfileRemoved,
    };
  } finally {
    lock.release();
  }

  return {
    exitCode: 0,
    conflictId,
    conflictPath: filePath,
    rotated,
    retries: lock.retries,
    staleLockfileRemoved: lock.staleLockfileRemoved,
  };
}

// ─── team-conflict-read ──────────────────────────────────────────────────────

export interface RunTeamConflictReadOpts {
  sessionId: string;
  /** Optional shard filter; when omitted, reads every shard in the conflicts dir. */
  shard?: string;
  /** Include acked records in the result set (default false — filters them out). */
  includeAcked?: boolean;
  /** Include rotated `<shard>.jsonl.1` files in the scan (default true). */
  includeRotated?: boolean;
  /** Override cwd (test hook). */
  cwd?: string;
}

export interface RunTeamConflictReadResult {
  /** 0 ok, 2 invalid argv. */
  exitCode: number;
  /** Conflict records (after acked-filter, unless includeAcked is true). */
  conflicts: ConflictRecord[];
  /** All ack records observed across the scanned shards. */
  acks: ConflictAckRecord[];
  /**
   * Per-shard breakdown so callers (e.g. team-verify pre-flight) can map
   * conflicts to the originating shard for diagnostic output.
   */
  byShardUnresolved: Record<string, ConflictRecord[]>;
  /** Raw lines that failed JSON parse (defensive — surface for diagnostics). */
  parseErrors: string[];
}

/**
 * Read the conflict mailbox. With no `shard`, scans every shard in the
 * conflicts dir. By default filters out conflict_ids that appear in the
 * sibling `<shard>.acked.jsonl`. Tolerates malformed lines (skip + log to
 * parseErrors) per ADR-EB-02 §5 reader-side discipline.
 */
export function runTeamConflictRead(
  opts: RunTeamConflictReadOpts,
): RunTeamConflictReadResult {
  // Invariant 1.
  try {
    assertSafeSlug(opts.sessionId, "session-id");
    if (opts.shard !== undefined) {
      assertSafeSlug(opts.shard, "shard");
    }
  } catch {
    return {
      exitCode: 2,
      conflicts: [],
      acks: [],
      byShardUnresolved: {},
      parseErrors: [],
    };
  }

  const cwd = opts.cwd ?? process.cwd();
  const dir = conflictsDir(cwd, opts.sessionId);
  const includeAcked = opts.includeAcked === true;
  const includeRotated = opts.includeRotated !== false;

  const result: RunTeamConflictReadResult = {
    exitCode: 0,
    conflicts: [],
    acks: [],
    byShardUnresolved: {},
    parseErrors: [],
  };

  if (!existsSync(dir)) return result;

  // Determine target shards.
  const shards: string[] = [];
  if (opts.shard !== undefined) {
    shards.push(opts.shard);
  } else {
    for (const entry of readdirSync(dir)) {
      const m = /^(.+)\.jsonl$/.exec(entry);
      if (!m) continue;
      // Skip the acked sibling — we'll load those alongside the main file.
      if (entry.endsWith(".acked.jsonl")) continue;
      shards.push(m[1]);
    }
  }

  for (const shard of shards) {
    const mainPath = conflictPath(cwd, opts.sessionId, shard);
    const rotatedPath = `${mainPath}${CONFLICT_ROTATE_SUFFIX}`;
    const ackPath = ackedPath(cwd, opts.sessionId, shard);

    const shardConflicts: ConflictRecord[] = [];
    const shardAcks: ConflictAckRecord[] = [];

    // Read rotated first (older) then main (newer) so caller-visible order is
    // chronological-by-rotation.
    if (includeRotated && existsSync(rotatedPath)) {
      readConflictJsonl(rotatedPath, shardConflicts, result.parseErrors);
    }
    if (existsSync(mainPath)) {
      readConflictJsonl(mainPath, shardConflicts, result.parseErrors);
    }
    if (existsSync(ackPath)) {
      readAckJsonl(ackPath, shardAcks, result.parseErrors);
    }

    result.acks.push(...shardAcks);

    if (includeAcked) {
      result.conflicts.push(...shardConflicts);
      if (shardConflicts.length > 0) {
        result.byShardUnresolved[shard] = shardConflicts;
      }
    } else {
      const ackedIds = new Set(shardAcks.map((a) => a.conflict_id));
      const unresolved = shardConflicts.filter(
        (c) => !ackedIds.has(c.conflict_id),
      );
      result.conflicts.push(...unresolved);
      if (unresolved.length > 0) {
        result.byShardUnresolved[shard] = unresolved;
      }
    }
  }

  return result;
}

function readConflictJsonl(
  path: string,
  sink: ConflictRecord[],
  parseErrors: string[],
): void {
  let body: string;
  try {
    body = readFileSync(path, "utf8");
  } catch {
    return;
  }
  for (const raw of body.split("\n")) {
    if (raw.trim() === "") continue;
    try {
      const parsed = JSON.parse(raw) as Partial<ConflictRecord>;
      if (
        typeof parsed.conflict_id === "string" &&
        typeof parsed.ts === "string" &&
        typeof parsed.shard === "string" &&
        typeof parsed.worker_id === "string" &&
        typeof parsed.attempted_op === "string" &&
        typeof parsed.rationale === "string" &&
        typeof parsed.producer_fork === "string"
      ) {
        sink.push(parsed as ConflictRecord);
      } else {
        parseErrors.push(raw);
      }
    } catch {
      parseErrors.push(raw);
    }
  }
}

function readAckJsonl(
  path: string,
  sink: ConflictAckRecord[],
  parseErrors: string[],
): void {
  let body: string;
  try {
    body = readFileSync(path, "utf8");
  } catch {
    return;
  }
  for (const raw of body.split("\n")) {
    if (raw.trim() === "") continue;
    try {
      const parsed = JSON.parse(raw) as Partial<ConflictAckRecord>;
      if (
        typeof parsed.conflict_id === "string" &&
        typeof parsed.acked_ts === "string" &&
        typeof parsed.acked_by === "string" &&
        typeof parsed.producer_fork === "string"
      ) {
        sink.push(parsed as ConflictAckRecord);
      } else {
        parseErrors.push(raw);
      }
    } catch {
      parseErrors.push(raw);
    }
  }
}

// ─── team-conflict-ack ───────────────────────────────────────────────────────

export interface RunTeamConflictAckOpts {
  sessionId: string;
  shard: string;
  conflictId: string;
  /** Identifier of the acker (operator / agent name). Default "operator". */
  ackedBy?: string;
  cwd?: string;
  now?: () => string;
  sleep?: (ms: number) => void;
  backoffMs?: readonly number[];
  staleLockMs?: number;
}

export interface RunTeamConflictAckResult {
  /** 0 ok, 2 invalid argv, 4 lock-contention, 1 other error. */
  exitCode: number;
  ackedPath?: string;
  retries: number;
  staleLockfileRemoved: boolean;
}

/**
 * Append an ack record to `<shard>.acked.jsonl`. Caller-supplied
 * `conflictId` MUST be a UUIDv4 (the same id that team-conflict-write
 * returned). Ack records are append-only — multiple acks for the same
 * conflict_id are tolerated (`team-conflict-read` de-dupes by id when
 * filtering).
 */
export function runTeamConflictAck(
  opts: RunTeamConflictAckOpts,
): RunTeamConflictAckResult {
  try {
    assertSafeSlug(opts.sessionId, "session-id");
    assertSafeSlug(opts.shard, "shard");
  } catch {
    return { exitCode: 2, retries: 0, staleLockfileRemoved: false };
  }

  if (!isValidUuidV4(opts.conflictId)) {
    return { exitCode: 2, retries: 0, staleLockfileRemoved: false };
  }

  const cwd = opts.cwd ?? process.cwd();
  const now = opts.now ?? (() => new Date().toISOString());
  const ackedBy = opts.ackedBy ?? "operator";

  const dir = conflictsDir(cwd, opts.sessionId);
  mkdirSync(dir, { recursive: true });
  const filePath = ackedPath(cwd, opts.sessionId, opts.shard);

  const record: ConflictAckRecord = {
    conflict_id: opts.conflictId,
    acked_ts: now(),
    acked_by: ackedBy,
    producer_fork: PRODUCER_FORK_ID,
  };
  const line = `${JSON.stringify(record)}\n`;

  let lock;
  try {
    lock = acquirePerStreamLock(filePath, {
      sleep: opts.sleep,
      backoffMs: opts.backoffMs,
      staleLockMs: opts.staleLockMs,
    });
  } catch (err) {
    if (err instanceof PerStreamLockExhaustedError) {
      return {
        exitCode: 4,
        retries: err.retries,
        staleLockfileRemoved: false,
      };
    }
    return { exitCode: 1, retries: 0, staleLockfileRemoved: false };
  }

  try {
    appendFileSync(filePath, line, { encoding: "utf8" });
  } catch {
    return {
      exitCode: 1,
      ackedPath: filePath,
      retries: lock.retries,
      staleLockfileRemoved: lock.staleLockfileRemoved,
    };
  } finally {
    lock.release();
  }

  return {
    exitCode: 0,
    ackedPath: filePath,
    retries: lock.retries,
    staleLockfileRemoved: lock.staleLockfileRemoved,
  };
}

// ─── CLI wrappers ────────────────────────────────────────────────────────────

export interface RunTeamConflictWriteCliOpts {
  cwd?: string;
  log?: (line: string) => void;
  errLog?: (line: string) => void;
}

/**
 * CLI wrapper: `omcp team-conflict-write <session-id> <shard> <worker-id> <attempted-op> <rationale>`.
 * Exit codes: 0 ok / 2 invalid argv / 4 lock-contention / 1 other error.
 */
export function runTeamConflictWriteCli(
  sessionId: string,
  shard: string,
  workerId: string,
  attemptedOp: string,
  rationale: string,
  opts: RunTeamConflictWriteCliOpts = {},
): number {
  const log = opts.log ?? ((l: string) => console.log(l));
  const errLog = opts.errLog ?? ((l: string) => console.error(l));

  try {
    assertSafeSlug(sessionId, "session-id");
    assertSafeSlug(shard, "shard");
    assertSafeSlug(workerId, "worker-id");
  } catch (err) {
    if (err instanceof UnsafeSlugError) {
      errLog(`omcp team-conflict-write: ${err.message}`);
    } else {
      errLog(`omcp team-conflict-write: invalid session-id, shard, or worker-id`);
    }
    return 2;
  }

  const result = runTeamConflictWrite({
    sessionId,
    shard,
    workerId,
    attemptedOp,
    rationale,
    cwd: opts.cwd,
  });

  if (result.exitCode === 0) {
    log(`omcp team-conflict-write: appended to ${result.conflictPath}`);
    log(`  conflict_id:    ${result.conflictId}`);
    log(`  rotated:        ${result.rotated}`);
    if (result.retries > 0) {
      log(`  retries:        ${result.retries}`);
    }
    if (result.staleLockfileRemoved) {
      log(`  stale-lockfile: force-removed during retry`);
    }
  } else if (result.exitCode === 4) {
    errLog(
      `omcp team-conflict-write: lock-contention — failed to acquire lockfile after ${result.retries} retries`,
    );
  } else if (result.exitCode === 1) {
    errLog(
      `omcp team-conflict-write: unexpected error during append (retries=${result.retries})`,
    );
  } else if (result.exitCode === 2) {
    errLog(
      `omcp team-conflict-write: attempted-op and rationale must be non-empty`,
    );
  }
  return result.exitCode;
}

export interface RunTeamConflictReadCliOpts {
  cwd?: string;
  shard?: string;
  includeAcked?: boolean;
  json?: boolean;
  /**
   * When true, returns exit 3 if any unresolved conflicts are present
   * (used by team-verify pre-flight scan).
   */
  exitNonZeroIfUnresolved?: boolean;
  log?: (line: string) => void;
  errLog?: (line: string) => void;
}

/**
 * CLI wrapper: `omcp team-conflict-read <session-id> [<shard>] [--include-acked] [--json]`.
 * Exit codes: 0 ok / 2 invalid argv / 3 unresolved-conflicts (with the
 * --exit-nonzero-if-unresolved flag set by team-verify).
 */
export function runTeamConflictReadCli(
  sessionId: string,
  opts: RunTeamConflictReadCliOpts = {},
): number {
  const log = opts.log ?? ((l: string) => console.log(l));
  const errLog = opts.errLog ?? ((l: string) => console.error(l));

  try {
    assertSafeSlug(sessionId, "session-id");
    if (opts.shard !== undefined) {
      assertSafeSlug(opts.shard, "shard");
    }
  } catch (err) {
    if (err instanceof UnsafeSlugError) {
      errLog(`omcp team-conflict-read: ${err.message}`);
    } else {
      errLog(`omcp team-conflict-read: invalid session-id or shard`);
    }
    return 2;
  }

  const result = runTeamConflictRead({
    sessionId,
    shard: opts.shard,
    includeAcked: opts.includeAcked,
    cwd: opts.cwd,
  });

  if (opts.json) {
    log(JSON.stringify(result, null, 2));
  } else {
    log(`omcp team-conflict-read: session=${sessionId}${opts.shard ? ` shard=${opts.shard}` : " (all shards)"}`);
    log(`  conflicts:      ${result.conflicts.length}`);
    log(`  acks:           ${result.acks.length}`);
    if (result.parseErrors.length > 0) {
      log(`  parse-errors:   ${result.parseErrors.length}`);
    }
    for (const [shard, records] of Object.entries(result.byShardUnresolved)) {
      log(`  [${shard}] ${records.length} unresolved:`);
      for (const r of records) {
        log(
          `    ${r.conflict_id} worker=${r.worker_id} op=${r.attempted_op} ts=${r.ts}`,
        );
      }
    }
  }

  if (opts.exitNonZeroIfUnresolved && result.conflicts.length > 0) {
    return 3;
  }
  return result.exitCode;
}

export interface RunTeamConflictAckCliOpts {
  cwd?: string;
  ackedBy?: string;
  log?: (line: string) => void;
  errLog?: (line: string) => void;
}

/**
 * CLI wrapper: `omcp team-conflict-ack <session-id> <shard> <conflict-id> [--acked-by <name>]`.
 * Exit codes: 0 ok / 2 invalid argv / 4 lock-contention / 1 other error.
 */
export function runTeamConflictAckCli(
  sessionId: string,
  shard: string,
  conflictId: string,
  opts: RunTeamConflictAckCliOpts = {},
): number {
  const log = opts.log ?? ((l: string) => console.log(l));
  const errLog = opts.errLog ?? ((l: string) => console.error(l));

  try {
    assertSafeSlug(sessionId, "session-id");
    assertSafeSlug(shard, "shard");
  } catch (err) {
    if (err instanceof UnsafeSlugError) {
      errLog(`omcp team-conflict-ack: ${err.message}`);
    } else {
      errLog(`omcp team-conflict-ack: invalid session-id or shard`);
    }
    return 2;
  }

  if (!isValidUuidV4(conflictId)) {
    errLog(
      `omcp team-conflict-ack: conflict-id must be UUIDv4 (got: ${conflictId})`,
    );
    return 2;
  }

  const result = runTeamConflictAck({
    sessionId,
    shard,
    conflictId,
    ackedBy: opts.ackedBy,
    cwd: opts.cwd,
  });

  if (result.exitCode === 0) {
    log(`omcp team-conflict-ack: appended to ${result.ackedPath}`);
    log(`  conflict_id:    ${conflictId}`);
    if (result.retries > 0) {
      log(`  retries:        ${result.retries}`);
    }
    if (result.staleLockfileRemoved) {
      log(`  stale-lockfile: force-removed during retry`);
    }
  } else if (result.exitCode === 4) {
    errLog(
      `omcp team-conflict-ack: lock-contention — failed to acquire lockfile after ${result.retries} retries`,
    );
  } else if (result.exitCode === 1) {
    errLog(
      `omcp team-conflict-ack: unexpected error during append (retries=${result.retries})`,
    );
  }
  return result.exitCode;
}
