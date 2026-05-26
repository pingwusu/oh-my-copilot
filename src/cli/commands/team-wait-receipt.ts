// `omcp team-wait-receipt --request-id <uuidv4> --session-id <sid> [--timeout-ms N] [--poll-ms N]`
//
// RG-01: leader-side receipt poll. Blocks until a worker emits an ack record
// carrying { request_id: <uuidv4>, producer_fork: "omcp-r2" } that matches
// the dispatched message, or until the configured timeout elapses.
//
// Idempotent under SIGTERM-then-retry (PM-F): once a matching receipt is
// observed, append it to `<sid>/consumed-receipts.jsonl`. A subsequent
// re-invocation of `team-wait-receipt --request-id <same>` finds the
// receipt in that file and exits 0 immediately without re-polling.
//
// Cross-fork safety (C1 / ADR-RG-01): both pingwusu and RobinNorberg forks
// emit UUIDv4 via crypto.randomUUID; the format alone does NOT disambiguate
// records. Receipt match requires BOTH request_id AND producer_fork ===
// "omcp-r2". An ack carrying our request_id but a foreign or missing
// producer_fork is logged as an ambiguous-attribution event and ignored.
//
// Stale-ack TTL (architect A4): an ack written more than (timeout * 2)
// milliseconds in the past — i.e., from a previous wait window that already
// timed out — is ignored. Workers that crash silently and only ack hours
// later don't false-positive a fresh wait call.
//
// Exit codes:
//   0 — receipt observed (or already consumed). Logs the (request_id, ackFile, source).
//   2 — invalid argv (bad UUID, bad session-id slug, malformed numeric flag).
//   3 — timeout: no matching receipt within the timeout window.
//   1 — unexpected I/O error.

import { existsSync, mkdirSync, readFileSync, readdirSync, appendFileSync } from "node:fs";
import { join } from "node:path";

import { assertSafeSlug, UnsafeSlugError } from "../../runtime/safe-slug.js";
import { PRODUCER_FORK_ID, isValidUuidV4 } from "./team-outbox.js";

/** Default poll interval — matches team-wait's existing TEAM_WAIT_POLL_INTERVAL_MS. */
export const TEAM_WAIT_RECEIPT_DEFAULT_POLL_MS = 2_000;

/** Default timeout — matches team-wait's existing TEAM_WAIT_DEFAULT_TIMEOUT_MS. */
export const TEAM_WAIT_RECEIPT_DEFAULT_TIMEOUT_MS = 1_800_000;

/**
 * Stale-ack TTL multiplier: acks older than (timeout × this) are ignored as
 * leftovers from a previously-timed-out wait window. ADR-RG-01 §Decision.
 */
export const TEAM_WAIT_RECEIPT_STALE_TTL_MULTIPLIER = 2;

// ─── types ──────────────────────────────────────────────────────────────────

export interface RunTeamWaitReceiptOpts {
  sessionId: string;
  requestId: string;
  /** Override poll interval (ms). Default TEAM_WAIT_RECEIPT_DEFAULT_POLL_MS. */
  pollMs?: number;
  /** Override total timeout (ms). Default TEAM_WAIT_RECEIPT_DEFAULT_TIMEOUT_MS. */
  timeoutMs?: number;
  /** Override cwd (test hook). */
  cwd?: string;
  /** Test hook: clock source. Default Date.now. */
  now?: () => number;
  /** Test hook: synchronous sleep. Default Atomics.wait on never-notified SAB. */
  sleep?: (ms: number) => void;
}

export interface RunTeamWaitReceiptResult {
  /** 0 ok, 2 invalid argv, 3 timeout, 1 other error. */
  exitCode: number;
  /** True iff the receipt was already in consumed-receipts.jsonl on entry. */
  fromConsumedCache: boolean;
  /** Path of the ack file that matched (when exitCode 0). */
  ackFile?: string;
  /** Elapsed wall-clock ms until match (or timeout). */
  elapsedMs: number;
  /** Per-iteration poll count (informational). */
  polls: number;
  /**
   * Non-fatal ambiguous-attribution log events. Each entry records an ack
   * file that carried our request_id but had a missing or foreign
   * producer_fork — ignored for match purposes but surfaced for audit.
   */
  ambiguousAttribution: Array<{ ackFile: string; reason: string }>;
}

interface AckRecord {
  workerIndex?: number;
  ackedAt?: string;
  request_id?: string;
  producer_fork?: string;
  status?: string;
}

// ─── core ────────────────────────────────────────────────────────────────────

export function runTeamWaitReceipt(
  opts: RunTeamWaitReceiptOpts,
): RunTeamWaitReceiptResult {
  // Invariant 1: validate slug before any path interpolation.
  try {
    assertSafeSlug(opts.sessionId, "session-id");
  } catch {
    return {
      exitCode: 2,
      fromConsumedCache: false,
      elapsedMs: 0,
      polls: 0,
      ambiguousAttribution: [],
    };
  }

  // RG-01: validate UUIDv4 receipt id at the boundary.
  if (!isValidUuidV4(opts.requestId)) {
    return {
      exitCode: 2,
      fromConsumedCache: false,
      elapsedMs: 0,
      polls: 0,
      ambiguousAttribution: [],
    };
  }

  const cwd = opts.cwd ?? process.cwd();
  const pollMs = opts.pollMs ?? TEAM_WAIT_RECEIPT_DEFAULT_POLL_MS;
  const timeoutMs = opts.timeoutMs ?? TEAM_WAIT_RECEIPT_DEFAULT_TIMEOUT_MS;
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? defaultSleep;

  if (!Number.isFinite(pollMs) || pollMs <= 0 || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return {
      exitCode: 2,
      fromConsumedCache: false,
      elapsedMs: 0,
      polls: 0,
      ambiguousAttribution: [],
    };
  }

  const teamDir = join(cwd, ".omcp", "state", "team", opts.sessionId);
  mkdirSync(teamDir, { recursive: true });
  const consumedReceiptsPath = join(teamDir, "consumed-receipts.jsonl");

  // PM-F: idempotent re-invocation. If the request_id was already consumed
  // by a prior team-wait-receipt call (which may have been SIGTERM'd before
  // exit), return 0 immediately without polling.
  const cachedAck = lookupConsumedReceipt(consumedReceiptsPath, opts.requestId);
  if (cachedAck) {
    return {
      exitCode: 0,
      fromConsumedCache: true,
      ackFile: cachedAck.ackFile,
      elapsedMs: 0,
      polls: 0,
      ambiguousAttribution: [],
    };
  }

  // Poll worker-N-ack.json files until a match appears or timeout fires.
  const startMs = now();
  const staleTtlMs = timeoutMs * TEAM_WAIT_RECEIPT_STALE_TTL_MULTIPLIER;
  const ambiguousAttribution: Array<{ ackFile: string; reason: string }> = [];
  let polls = 0;
  while (true) {
    polls++;
    const matchResult = scanAckFiles(teamDir, opts.requestId, staleTtlMs, now);
    for (const item of matchResult.ambiguous) {
      ambiguousAttribution.push(item);
    }
    if (matchResult.match) {
      appendConsumedReceipt(consumedReceiptsPath, {
        request_id: opts.requestId,
        producer_fork: PRODUCER_FORK_ID,
        ackFile: matchResult.match.ackFile,
        consumedAt: new Date(now()).toISOString(),
      });
      return {
        exitCode: 0,
        fromConsumedCache: false,
        ackFile: matchResult.match.ackFile,
        elapsedMs: now() - startMs,
        polls,
        ambiguousAttribution,
      };
    }
    const elapsedMs = now() - startMs;
    if (elapsedMs >= timeoutMs) {
      return {
        exitCode: 3,
        fromConsumedCache: false,
        elapsedMs,
        polls,
        ambiguousAttribution,
      };
    }
    sleep(pollMs);
  }
}

// ─── helpers ────────────────────────────────────────────────────────────────

interface ConsumedReceiptRecord {
  request_id: string;
  producer_fork: string;
  ackFile: string;
  consumedAt: string;
}

/**
 * Look up a request_id in the consumed-receipts.jsonl stream. Returns the
 * matching record if present, null otherwise. Idempotent — only matches when
 * the record's producer_fork equals PRODUCER_FORK_ID.
 *
 * Tolerates partial-line tail (a producer was SIGTERM'd mid-write) and
 * malformed records (parse error → skip the line, continue).
 */
function lookupConsumedReceipt(
  path: string,
  requestId: string,
): ConsumedReceiptRecord | null {
  if (!existsSync(path)) return null;
  let body: string;
  try {
    body = readFileSync(path, "utf8");
  } catch {
    return null;
  }
  const lines = body.split("\n");
  for (const raw of lines) {
    if (raw.trim() === "") continue;
    let parsed: Partial<ConsumedReceiptRecord>;
    try {
      parsed = JSON.parse(raw) as Partial<ConsumedReceiptRecord>;
    } catch {
      continue;
    }
    if (
      parsed.request_id === requestId &&
      parsed.producer_fork === PRODUCER_FORK_ID &&
      typeof parsed.ackFile === "string" &&
      typeof parsed.consumedAt === "string"
    ) {
      return parsed as ConsumedReceiptRecord;
    }
  }
  return null;
}

/**
 * Append a consumed-receipt record. Uses appendFileSync — atomic at the
 * per-line POSIX append level. Multiple concurrent waiters on the same
 * request_id all exit 0; the file may carry duplicate rows in that case,
 * which is observe-only and harmless (lookupConsumedReceipt returns the
 * first match). ADR-RG-01 §Decision: consumed-receipts is observe-only,
 * not lock-style.
 */
function appendConsumedReceipt(
  path: string,
  record: ConsumedReceiptRecord,
): void {
  appendFileSync(path, `${JSON.stringify(record)}\n`, "utf8");
}

interface ScanResult {
  match: { ackFile: string; record: AckRecord } | null;
  ambiguous: Array<{ ackFile: string; reason: string }>;
}

/**
 * Walk the team dir for worker-N-ack.json files and look for one carrying
 * { request_id: <opts.requestId>, producer_fork: PRODUCER_FORK_ID }.
 *
 * Ambiguous-attribution events (architect's verified C2 mitigation):
 *   - Ack carries our request_id but producer_fork is missing → log + ignore.
 *   - Ack carries our request_id but producer_fork is a foreign value → log + ignore.
 *
 * Stale-ack filter: an ack older than (timeout × TEAM_WAIT_RECEIPT_STALE_TTL_MULTIPLIER)
 * relative to the current wait's start time is ignored. Lets workers crash
 * silently and ack hours later without false-positiving fresh waits.
 */
function scanAckFiles(
  teamDir: string,
  requestId: string,
  staleTtlMs: number,
  now: () => number,
): ScanResult {
  const result: ScanResult = { match: null, ambiguous: [] };
  let entries: string[];
  try {
    entries = readdirSync(teamDir);
  } catch {
    return result;
  }
  for (const entry of entries) {
    if (!/^worker-\d+-ack\.json$/.test(entry)) continue;
    const ackPath = join(teamDir, entry);
    let record: AckRecord;
    try {
      record = JSON.parse(readFileSync(ackPath, "utf8")) as AckRecord;
    } catch {
      continue;
    }
    if (record.request_id !== requestId) continue;
    // Stale-ack filter.
    if (typeof record.ackedAt === "string") {
      const ackedAtMs = Date.parse(record.ackedAt);
      if (Number.isFinite(ackedAtMs) && now() - ackedAtMs > staleTtlMs) {
        result.ambiguous.push({
          ackFile: ackPath,
          reason: `stale ack (acked > ${staleTtlMs}ms ago; ignored)`,
        });
        continue;
      }
    }
    // Cross-fork attribution check.
    if (record.producer_fork === undefined) {
      result.ambiguous.push({
        ackFile: ackPath,
        reason: "missing producer_fork (cross-fork ambiguous; ignored)",
      });
      continue;
    }
    if (record.producer_fork !== PRODUCER_FORK_ID) {
      result.ambiguous.push({
        ackFile: ackPath,
        reason: `foreign producer_fork ${JSON.stringify(record.producer_fork)} (cross-fork ambiguous; ignored)`,
      });
      continue;
    }
    result.match = { ackFile: ackPath, record };
    return result;
  }
  return result;
}

/**
 * Synchronous sleep via Atomics.wait on a never-notified SharedArrayBuffer.
 * Matches the kernel-sleep pattern used in team-outbox.ts to avoid the
 * CPU-burn cascade under multi-process scenarios. Sibling implementation,
 * intentionally not imported (different file, different scope, same idea).
 */
function defaultSleep(ms: number): void {
  if (ms <= 0) return;
  const view = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(view, 0, 0, ms);
}

// ─── CLI wrapper ─────────────────────────────────────────────────────────────

export interface RunTeamWaitReceiptCliOpts {
  cwd?: string;
  log?: (line: string) => void;
  errLog?: (line: string) => void;
  /** --poll-ms (numeric flag value, pre-parsed by Commander). */
  pollMs?: number;
  /** --timeout-ms (numeric flag value, pre-parsed by Commander). */
  timeoutMs?: number;
}

/**
 * CLI wrapper: `omcp team-wait-receipt <session-id> --request-id <uuid> [--timeout-ms N] [--poll-ms N]`.
 * Exit codes: 0 ok / 2 invalid argv / 3 timeout / 1 other error (per ADR-RG-01).
 */
export function runTeamWaitReceiptCli(
  sessionId: string,
  requestId: string,
  opts: RunTeamWaitReceiptCliOpts = {},
): number {
  const log = opts.log ?? ((l: string) => console.log(l));
  const errLog = opts.errLog ?? ((l: string) => console.error(l));

  try {
    assertSafeSlug(sessionId, "session-id");
  } catch (err) {
    if (err instanceof UnsafeSlugError) {
      errLog(`omcp team-wait-receipt: ${err.message}`);
    } else {
      errLog(`omcp team-wait-receipt: invalid session-id`);
    }
    return 2;
  }

  if (!isValidUuidV4(requestId)) {
    errLog(`omcp team-wait-receipt: --request-id must be UUIDv4 (got: ${requestId})`);
    return 2;
  }

  const result = runTeamWaitReceipt({
    sessionId,
    requestId,
    pollMs: opts.pollMs,
    timeoutMs: opts.timeoutMs,
    cwd: opts.cwd,
  });

  if (result.exitCode === 0) {
    if (result.fromConsumedCache) {
      log(
        `omcp team-wait-receipt: receipt ${requestId} already consumed (cache hit); ackFile=${result.ackFile}`,
      );
    } else {
      log(
        `omcp team-wait-receipt: receipt ${requestId} observed in ${result.elapsedMs}ms (${result.polls} polls); ackFile=${result.ackFile}`,
      );
    }
    for (const a of result.ambiguousAttribution) {
      log(`  [ambiguous-attribution] ${a.ackFile}: ${a.reason}`);
    }
  } else if (result.exitCode === 3) {
    errLog(
      `omcp team-wait-receipt: timeout — no matching receipt within ${result.elapsedMs}ms (${result.polls} polls)`,
    );
    for (const a of result.ambiguousAttribution) {
      errLog(`  [ambiguous-attribution] ${a.ackFile}: ${a.reason}`);
    }
  }
  return result.exitCode;
}
