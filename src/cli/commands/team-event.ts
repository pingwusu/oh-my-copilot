// `omcp team-event-append <session-id> --verb <name> --kind <type> ...`
// `omcp team-event-tail   <session-id> [--since <iso-ts>] [--type <kind>] [--limit N]`
//
// RG-04a: event-log infrastructure. Standalone verb pair with NO
// instrumentation of other verbs in this story (that's RG-04b).
//
// Wire format (per ADR-RG-04 §Decision):
//   { ts: ISO-8601, verb: string, actor: string,
//     shard?: string, request_id?: string,
//     producer_fork: "omcp-r2", kind: string, detail?: unknown }
//
// Stream path: `.omcp/state/team/<sid>/events.jsonl`
// Per-stream lockfile: `<events.jsonl>.lock` via acquirePerStreamLock.
// 1MB rotation INSIDE the per-stream lockfile (rename to events.jsonl.1).
//
// Timestamp validation (PM-G mitigation, C5):
//   - On write: reject when ts ∉ (now - 24h, now + 5min). Verb exits 2.
//   - On read: skip + emit a sentinel event with kind=poison-record-detected,
//     ts=now to break recursion. Sentinel events themselves skip validation.

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs";
import { join } from "node:path";

import { assertSafeSlug, UnsafeSlugError } from "../../runtime/safe-slug.js";
import {
  acquirePerStreamLock,
  PerStreamLockExhaustedError,
} from "../../runtime/per-stream-lock.js";
import { PRODUCER_FORK_ID, isValidUuidV4 } from "./team-outbox.js";

// ─── constants ──────────────────────────────────────────────────────────────

/** Rotation threshold (bytes). When events.jsonl exceeds this, rotate to .1. */
export const TEAM_EVENT_ROTATION_BYTES = 1_048_576; // 1 MiB

/** Window past `now` allowed on write/read (PM-G clock-skew tolerance). */
export const TEAM_EVENT_TS_FUTURE_TOLERANCE_MS = 5 * 60 * 1_000; // 5 min

/** Window before `now` allowed on write/read (PM-G upper-bound staleness). */
export const TEAM_EVENT_TS_PAST_TOLERANCE_MS = 24 * 60 * 60 * 1_000; // 24h

/** Tail default + max limit (caller can specify --limit up to this). */
export const TEAM_EVENT_TAIL_DEFAULT_LIMIT = 100;
export const TEAM_EVENT_TAIL_MAX_LIMIT = 10_000;

/** Sentinel kind for poison-record diagnostics; bypasses ts validation on write. */
export const TEAM_EVENT_POISON_KIND = "poison-record-detected";

// ─── types ──────────────────────────────────────────────────────────────────

export interface TeamEventRecord {
  ts: string;
  verb: string;
  actor: string;
  shard?: string;
  request_id?: string;
  producer_fork: string;
  kind: string;
  detail?: unknown;
}

export interface RunTeamEventAppendOpts {
  sessionId: string;
  verb: string;
  kind: string;
  actor?: string;
  shard?: string;
  requestId?: string;
  detail?: unknown;
  /** Override cwd (test hook). */
  cwd?: string;
  /** Test hook: clock source. Default Date.now (returns ms). */
  now?: () => number;
  /** Test hook: timestamp formatter. Default ISO-8601 from now(). */
  nowIso?: () => string;
  /**
   * Test hook: when true, bypass ts validation (used internally by the
   * sentinel emitter to avoid infinite recursion when ts=now is itself
   * somehow rejected, e.g. by an adversarial clock test).
   */
  _bypassTsValidation?: boolean;
}

export interface RunTeamEventAppendResult {
  /** 0 ok / 2 invalid argv / 4 lock-contention exhausted / 5 ts out of window / 1 other. */
  exitCode: number;
  /** Path of the events.jsonl appended to (when exitCode 0). */
  eventsPath?: string;
  /** True iff a rotation fired during this append. */
  rotated: boolean;
  /** Number of lockfile retries before acquire. */
  retries: number;
  /** True iff a stale lockfile was force-removed during retry. */
  staleLockfileRemoved: boolean;
}

export interface RunTeamEventTailOpts {
  sessionId: string;
  /** ISO-8601 lower-bound (lexicographic compare). Omit = no lower bound. */
  since?: string;
  /** Exact kind match. Omit = no kind filter. */
  type?: string;
  /** Tail limit; clamped to TEAM_EVENT_TAIL_MAX_LIMIT. Default 100. */
  limit?: number;
  cwd?: string;
  now?: () => number;
  nowIso?: () => string;
}

export interface RunTeamEventTailResult {
  exitCode: number;
  /** Valid records passing the filter, ordered chronologically. */
  records: TeamEventRecord[];
  /** Path of events.jsonl read. */
  eventsPath?: string;
  /** Count of records skipped due to ts validation (poison records). */
  poisonSkipped: number;
  /** Count of records skipped due to parse error. */
  parseErrors: number;
}

// ─── ts validation ──────────────────────────────────────────────────────────

export interface TsValidationResult {
  ok: boolean;
  /** Present when ok=false: human-readable reason (e.g. "ts > now + 5min"). */
  reason?: string;
}

/**
 * Validate that a record's `ts` lies within (now - 24h, now + 5min).
 *
 * Lexicographic comparison via Date.parse is sufficient for the ISO-8601
 * normalized form. We do NOT enforce strict ISO-8601 syntax here — a record
 * whose `ts` does not parse is itself a poison record (reason="unparseable").
 */
export function validateEventTs(ts: unknown, nowMs: number): TsValidationResult {
  if (typeof ts !== "string") {
    return { ok: false, reason: "ts missing or not a string" };
  }
  const parsed = Date.parse(ts);
  if (!Number.isFinite(parsed)) {
    return { ok: false, reason: `ts unparseable: ${ts}` };
  }
  if (parsed > nowMs + TEAM_EVENT_TS_FUTURE_TOLERANCE_MS) {
    return { ok: false, reason: `ts > now + 5min (${ts})` };
  }
  if (parsed < nowMs - TEAM_EVENT_TS_PAST_TOLERANCE_MS) {
    return { ok: false, reason: `ts < now - 24h (${ts})` };
  }
  return { ok: true };
}

// ─── append verb ────────────────────────────────────────────────────────────

export function runTeamEventAppend(
  opts: RunTeamEventAppendOpts,
): RunTeamEventAppendResult {
  // Invariant 1: validate slug.
  try {
    assertSafeSlug(opts.sessionId, "session-id");
  } catch {
    return { exitCode: 2, rotated: false, retries: 0, staleLockfileRemoved: false };
  }

  // Required string fields.
  if (typeof opts.verb !== "string" || opts.verb.length === 0) {
    return { exitCode: 2, rotated: false, retries: 0, staleLockfileRemoved: false };
  }
  if (typeof opts.kind !== "string" || opts.kind.length === 0) {
    return { exitCode: 2, rotated: false, retries: 0, staleLockfileRemoved: false };
  }

  // Optional request_id must be UUIDv4 when supplied.
  if (opts.requestId !== undefined && !isValidUuidV4(opts.requestId)) {
    return { exitCode: 2, rotated: false, retries: 0, staleLockfileRemoved: false };
  }

  const cwd = opts.cwd ?? process.cwd();
  const now = opts.now ?? Date.now;
  const nowIso = opts.nowIso ?? (() => new Date(now()).toISOString());

  const ts = nowIso();

  // PM-G recursion guard: sentinel kind bypasses ts validation on write so
  // an adversarial clock can't recursively trigger another sentinel.
  if (!opts._bypassTsValidation && opts.kind !== TEAM_EVENT_POISON_KIND) {
    const v = validateEventTs(ts, now());
    if (!v.ok) {
      return { exitCode: 5, rotated: false, retries: 0, staleLockfileRemoved: false };
    }
  }

  const record: TeamEventRecord = {
    ts,
    verb: opts.verb,
    actor: opts.actor ?? "unknown",
    producer_fork: PRODUCER_FORK_ID,
    kind: opts.kind,
  };
  if (opts.shard !== undefined) record.shard = opts.shard;
  if (opts.requestId !== undefined) record.request_id = opts.requestId;
  if (opts.detail !== undefined) record.detail = opts.detail;

  const teamDir = join(cwd, ".omcp", "state", "team", opts.sessionId);
  mkdirSync(teamDir, { recursive: true });
  const eventsPath = join(teamDir, "events.jsonl");

  let line: string;
  try {
    line = `${JSON.stringify(record)}\n`;
  } catch {
    // detail contained a non-serializable value (e.g. BigInt, circular ref).
    return { exitCode: 2, rotated: false, retries: 0, staleLockfileRemoved: false };
  }

  // Acquire per-stream lock; rotate + append inside the lock.
  let handle;
  try {
    handle = acquirePerStreamLock(eventsPath);
  } catch (err) {
    if (err instanceof PerStreamLockExhaustedError) {
      return {
        exitCode: 4,
        rotated: false,
        retries: err.retries,
        staleLockfileRemoved: false,
      };
    }
    return { exitCode: 1, rotated: false, retries: 0, staleLockfileRemoved: false };
  }

  let rotated = false;
  try {
    // Re-check size inside the lock (rotation-lock contract per A2).
    if (existsSync(eventsPath)) {
      let sizeBytes = 0;
      try {
        sizeBytes = statSync(eventsPath).size;
      } catch {
        // race with another writer; treat as 0 + proceed
      }
      if (sizeBytes >= TEAM_EVENT_ROTATION_BYTES) {
        const rotatedPath = `${eventsPath}.1`;
        // renameSync overwrites .1 atomically on POSIX; on Windows we must
        // remove the prior .1 first (rename onto existing file fails).
        try {
          rmSync(rotatedPath, { force: true });
        } catch {
          // best-effort
        }
        renameSync(eventsPath, rotatedPath);
        rotated = true;
      }
    }
    appendFileSync(eventsPath, line, { encoding: "utf8" });
  } catch {
    return {
      exitCode: 1,
      rotated,
      retries: handle.retries,
      staleLockfileRemoved: handle.staleLockfileRemoved,
    };
  } finally {
    handle.release();
  }

  return {
    exitCode: 0,
    eventsPath,
    rotated,
    retries: handle.retries,
    staleLockfileRemoved: handle.staleLockfileRemoved,
  };
}

// ─── tail verb ──────────────────────────────────────────────────────────────

export function runTeamEventTail(
  opts: RunTeamEventTailOpts,
): RunTeamEventTailResult {
  try {
    assertSafeSlug(opts.sessionId, "session-id");
  } catch {
    return { exitCode: 2, records: [], poisonSkipped: 0, parseErrors: 0 };
  }

  const cwd = opts.cwd ?? process.cwd();
  const now = opts.now ?? Date.now;
  const nowIso = opts.nowIso ?? (() => new Date(now()).toISOString());

  // Clamp limit to [1, MAX]; default 100.
  let limit = opts.limit ?? TEAM_EVENT_TAIL_DEFAULT_LIMIT;
  if (!Number.isFinite(limit) || limit <= 0) {
    return { exitCode: 2, records: [], poisonSkipped: 0, parseErrors: 0 };
  }
  if (limit > TEAM_EVENT_TAIL_MAX_LIMIT) limit = TEAM_EVENT_TAIL_MAX_LIMIT;

  const teamDir = join(cwd, ".omcp", "state", "team", opts.sessionId);
  const eventsPath = join(teamDir, "events.jsonl");

  if (!existsSync(eventsPath)) {
    return { exitCode: 0, records: [], eventsPath, poisonSkipped: 0, parseErrors: 0 };
  }

  let body: string;
  try {
    body = readFileSync(eventsPath, "utf8");
  } catch {
    return { exitCode: 1, records: [], eventsPath, poisonSkipped: 0, parseErrors: 0 };
  }

  const records: TeamEventRecord[] = [];
  let poisonSkipped = 0;
  let parseErrors = 0;

  for (const raw of body.split("\n")) {
    if (raw.trim() === "") continue;
    let parsed: TeamEventRecord;
    try {
      parsed = JSON.parse(raw) as TeamEventRecord;
    } catch {
      parseErrors++;
      continue;
    }
    // Basic shape check.
    if (
      typeof parsed.ts !== "string" ||
      typeof parsed.verb !== "string" ||
      typeof parsed.actor !== "string" ||
      typeof parsed.kind !== "string"
    ) {
      parseErrors++;
      continue;
    }
    // PM-G ts validation on read. Sentinel records always pass to avoid
    // recursive validation skip (they were ALREADY validated on write).
    if (parsed.kind !== TEAM_EVENT_POISON_KIND) {
      const v = validateEventTs(parsed.ts, now());
      if (!v.ok) {
        poisonSkipped++;
        // Emit the sentinel via a recursion-guarded call. The sentinel kind
        // bypasses ts validation on write — PM-G recursion guard. Errors
        // here are swallowed: a poison record on read should not prevent
        // surfacing the OTHER valid records to the caller.
        try {
          runTeamEventAppend({
            sessionId: opts.sessionId,
            verb: "team-event-tail",
            kind: TEAM_EVENT_POISON_KIND,
            actor: "team-event-tail",
            detail: {
              reason: v.reason,
              original_ts: parsed.ts,
              original_kind: parsed.kind,
            },
            cwd,
            now,
            nowIso,
          });
        } catch {
          // best-effort
        }
        continue;
      }
    }
    // Apply filters.
    if (opts.since !== undefined && parsed.ts < opts.since) continue;
    if (opts.type !== undefined && parsed.kind !== opts.type) continue;
    records.push(parsed);
  }

  // Tail semantics: return the LAST `limit` records after filtering.
  const tailed = records.slice(-limit);

  return {
    exitCode: 0,
    records: tailed,
    eventsPath,
    poisonSkipped,
    parseErrors,
  };
}

// ─── RG-04b instrumentation helper ──────────────────────────────────────────

/**
 * Defensive wrapper around runTeamEventAppend used by RG-04b instrumentation
 * patches in other verbs (team-outbox, team-inbox, team-heartbeat, team-conflict,
 * team-push-prompt). Swallows EVERY error so a broken event-log pipeline cannot
 * cause a parent verb to fail — instrumentation is purely additive observability
 * (RG-04b principle: "DO NOT change verb behavior").
 *
 * Callers should pass {verb, kind, sessionId, ...} and ignore the return value.
 * On any throw or non-zero exitCode from runTeamEventAppend, this helper returns
 * silently with no side effects on the caller.
 */
export function appendEventBestEffort(opts: RunTeamEventAppendOpts): void {
  try {
    runTeamEventAppend(opts);
  } catch {
    // best-effort: instrumentation must never fail the parent verb
  }
}

// ─── CLI wrappers ───────────────────────────────────────────────────────────

export interface RunTeamEventAppendCliOpts {
  cwd?: string;
  log?: (line: string) => void;
  errLog?: (line: string) => void;
  verb: string;
  kind: string;
  actor?: string;
  shard?: string;
  requestId?: string;
  /** Pre-parsed JSON detail (or undefined). */
  detail?: unknown;
}

/**
 * CLI wrapper: `omcp team-event-append <session-id> --verb X --kind Y ...`.
 * Exit codes: 0 ok / 2 invalid argv / 4 lock-contention / 5 ts out of window / 1 other.
 */
export function runTeamEventAppendCli(
  sessionId: string,
  opts: RunTeamEventAppendCliOpts,
): number {
  const log = opts.log ?? ((l: string) => console.log(l));
  const errLog = opts.errLog ?? ((l: string) => console.error(l));

  try {
    assertSafeSlug(sessionId, "session-id");
  } catch (err) {
    if (err instanceof UnsafeSlugError) {
      errLog(`omcp team-event-append: ${err.message}`);
    } else {
      errLog(`omcp team-event-append: invalid session-id`);
    }
    return 2;
  }

  if (typeof opts.verb !== "string" || opts.verb.length === 0) {
    errLog(`omcp team-event-append: --verb is required`);
    return 2;
  }
  if (typeof opts.kind !== "string" || opts.kind.length === 0) {
    errLog(`omcp team-event-append: --kind is required`);
    return 2;
  }
  if (opts.requestId !== undefined && !isValidUuidV4(opts.requestId)) {
    errLog(`omcp team-event-append: --request-id must be UUIDv4 (got: ${opts.requestId})`);
    return 2;
  }

  const result = runTeamEventAppend({
    sessionId,
    verb: opts.verb,
    kind: opts.kind,
    actor: opts.actor,
    shard: opts.shard,
    requestId: opts.requestId,
    detail: opts.detail,
    cwd: opts.cwd,
  });

  if (result.exitCode === 0) {
    log(`omcp team-event-append: appended to ${result.eventsPath}`);
    log(`  retries:        ${result.retries}`);
    if (result.rotated) {
      log(`  rotated:        events.jsonl → events.jsonl.1`);
    }
    if (result.staleLockfileRemoved) {
      log(`  stale-lockfile: force-removed during retry`);
    }
  } else if (result.exitCode === 4) {
    errLog(
      `omcp team-event-append: lock-contention — failed to acquire lockfile after ${result.retries} retries`,
    );
  } else if (result.exitCode === 5) {
    errLog(
      `omcp team-event-append: ts out of window (must be within now-24h..now+5min)`,
    );
  } else if (result.exitCode === 1) {
    errLog(`omcp team-event-append: unexpected error during append`);
  }
  return result.exitCode;
}

export interface RunTeamEventTailCliOpts {
  cwd?: string;
  log?: (line: string) => void;
  errLog?: (line: string) => void;
  since?: string;
  type?: string;
  limit?: number;
  /** Emit JSON instead of human-readable summary. */
  json?: boolean;
}

/**
 * CLI wrapper: `omcp team-event-tail <session-id> [--since ts] [--type kind] [--limit N]`.
 * Exit codes: 0 ok / 2 invalid argv / 1 other error.
 */
export function runTeamEventTailCli(
  sessionId: string,
  opts: RunTeamEventTailCliOpts = {},
): number {
  const log = opts.log ?? ((l: string) => console.log(l));
  const errLog = opts.errLog ?? ((l: string) => console.error(l));

  try {
    assertSafeSlug(sessionId, "session-id");
  } catch (err) {
    if (err instanceof UnsafeSlugError) {
      errLog(`omcp team-event-tail: ${err.message}`);
    } else {
      errLog(`omcp team-event-tail: invalid session-id`);
    }
    return 2;
  }

  const result = runTeamEventTail({
    sessionId,
    since: opts.since,
    type: opts.type,
    limit: opts.limit,
    cwd: opts.cwd,
  });

  if (result.exitCode !== 0) {
    if (result.exitCode === 2) {
      errLog(`omcp team-event-tail: invalid argv`);
    } else {
      errLog(`omcp team-event-tail: unexpected error reading events.jsonl`);
    }
    return result.exitCode;
  }

  if (opts.json) {
    log(
      JSON.stringify(
        {
          eventsPath: result.eventsPath,
          records: result.records,
          poisonSkipped: result.poisonSkipped,
          parseErrors: result.parseErrors,
        },
        null,
        2,
      ),
    );
    return 0;
  }

  log(`omcp team-event-tail: session=${sessionId}`);
  log(`  eventsPath:     ${result.eventsPath ?? "(none)"}`);
  log(`  records:        ${result.records.length}`);
  if (result.poisonSkipped > 0) {
    log(`  poisonSkipped:  ${result.poisonSkipped}`);
  }
  if (result.parseErrors > 0) {
    log(`  parseErrors:    ${result.parseErrors}`);
  }
  for (const r of result.records) {
    const reqIdPart = r.request_id ? ` req=${r.request_id}` : "";
    const shardPart = r.shard ? ` shard=${r.shard}` : "";
    log(`    ${r.ts} ${r.verb} ${r.kind} actor=${r.actor}${reqIdPart}${shardPart}`);
  }
  return 0;
}
