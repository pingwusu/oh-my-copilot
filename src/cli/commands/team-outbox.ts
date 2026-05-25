// `omcp team-outbox-write <session-id> <consumer> <jsonPayload>` (EB-06 Story 3)
//
// Hand-rolled lockfile-protected JSONL append to the per-session outbox.
// Wire format + concurrency contract + 64KB line cap all pinned by
// docs/adr/ADR-omcp-eb-02-outbox-schema.md.
//
// Cursor-based reader follows in src/cli/commands/team-outbox.ts (extended
// in EB-06 Story 4 — US-EB06-OUTBOX-READ-CURSOR).
//
// Invariants honored:
//   I1 — assertSafeSlug on sessionId + consumer (both used in path interpolation)
//   I2 — explicit carve-out for the append path; lockfile sidecar +
//        exclusive-create is the multi-process equivalent of atomic write
//        (sibling pattern to hermes-bridge's existing Inv-2 carve-out)
//   I8 — registered as `omcp team-outbox-write` in src/cli/omcp.ts

import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { join } from "node:path";

import {
  assertSafeSlug,
  UnsafeSlugError,
} from "../../runtime/safe-slug.js";

// ─── constants pinned by ADR-omcp-eb-02 ──────────────────────────────────────

/** Max bytes per JSONL line (utf8) inclusive of trailing newline. */
export const OUTBOX_LINE_MAX_BYTES = 65_536;

/** Lockfile age threshold (ms) — older locks are crash leftovers + force-removed. */
export const OUTBOX_STALE_LOCK_MS = 30_000;

/** Exponential backoff retry sequence for lockfile acquire (ms). */
export const OUTBOX_LOCK_BACKOFF_MS = [50, 100, 200, 400, 1_000, 2_500] as const;

// ─── types ──────────────────────────────────────────────────────────────────

export interface OutboxLineEntry {
  ts: string;
  consumer: string;
  payload: unknown;
  /** Present + true ONLY when the original payload exceeded OUTBOX_LINE_MAX_BYTES. */
  truncated?: true;
  /** Present only with truncated:true — original Buffer.byteLength before truncation. */
  original_bytes?: number;
}

export interface RunTeamOutboxWriteOpts {
  sessionId: string;
  consumer: string;
  payload: unknown;
  /** Override cwd (test hook). */
  cwd?: string;
  /** Test hook: timestamp source (default new Date().toISOString()). */
  now?: () => string;
  /** Test hook: sleep function (default synchronous busy-wait). */
  sleep?: (ms: number) => void;
  /** Test hook: override backoff sequence (default OUTBOX_LOCK_BACKOFF_MS). */
  backoffMs?: readonly number[];
  /** Test hook: override stale-lock threshold (default OUTBOX_STALE_LOCK_MS). */
  staleLockMs?: number;
}

export interface RunTeamOutboxWriteResult {
  /** 0 ok, 2 invalid argv, 4 lock-contention exhausted, 1 other error. */
  exitCode: number;
  /** True iff the payload was truncated to fit OUTBOX_LINE_MAX_BYTES. */
  truncated: boolean;
  /** Original Buffer.byteLength of the serialized payload BEFORE truncation. */
  originalBytes?: number;
  /** Path of the outbox file appended to (when exitCode 0). */
  outboxPath?: string;
  /** Number of lockfile retries that fired before acquire (or exhaustion). */
  retries: number;
  /** True iff a stale lockfile was force-removed during retry. */
  staleLockfileRemoved: boolean;
}

// ─── core ────────────────────────────────────────────────────────────────────

export function runTeamOutboxWrite(
  opts: RunTeamOutboxWriteOpts,
): RunTeamOutboxWriteResult {
  // Invariant 1: validate slugs before path interpolation.
  try {
    assertSafeSlug(opts.sessionId, "session-id");
    assertSafeSlug(opts.consumer, "consumer");
  } catch {
    return {
      exitCode: 2,
      truncated: false,
      retries: 0,
      staleLockfileRemoved: false,
    };
  }

  const cwd = opts.cwd ?? process.cwd();
  const now = opts.now ?? (() => new Date().toISOString());
  const sleep = opts.sleep ?? defaultBusyWait;
  const backoff = opts.backoffMs ?? OUTBOX_LOCK_BACKOFF_MS;
  const staleLockMs = opts.staleLockMs ?? OUTBOX_STALE_LOCK_MS;

  const pidDir = join(cwd, ".omcp", "state", "team", opts.sessionId);
  mkdirSync(pidDir, { recursive: true });
  const outboxPath = join(pidDir, "outbox.jsonl");
  const lockPath = `${outboxPath}.lock`;

  // Construct line + apply 64KB cap.
  const ts = now();
  const fullEntry: OutboxLineEntry = {
    ts,
    consumer: opts.consumer,
    payload: opts.payload,
  };
  const { line, truncated, originalBytes } = serializeLineWithCap(fullEntry);

  // Acquire lockfile via exponential backoff.
  let lockFd: number | undefined;
  let retries = 0;
  let staleLockfileRemoved = false;
  for (let i = 0; i <= backoff.length; i++) {
    try {
      lockFd = openSync(lockPath, "wx");
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") {
        // Unexpected error path — bubble up.
        return {
          exitCode: 1,
          truncated,
          originalBytes,
          retries,
          staleLockfileRemoved,
        };
      }
      // EEXIST — check if it's a stale lock from a crashed prior writer.
      try {
        const lockMtime = statSync(lockPath).mtimeMs;
        if (Date.now() - lockMtime > staleLockMs) {
          rmSync(lockPath, { force: true });
          staleLockfileRemoved = true;
          continue; // retry immediately after stale-cleanup
        }
      } catch {
        // stat raced with another process's release; try again
      }
      // Backoff + retry.
      if (i >= backoff.length) {
        // Exhausted.
        return {
          exitCode: 4,
          truncated,
          originalBytes,
          retries,
          staleLockfileRemoved,
        };
      }
      sleep(backoff[i]);
      retries++;
    }
  }

  // Lock held — append + release in try/finally.
  try {
    appendFileSync(outboxPath, line, { encoding: "utf8" });
  } catch (err) {
    return {
      exitCode: 1,
      truncated,
      originalBytes,
      retries,
      staleLockfileRemoved,
    };
  } finally {
    if (lockFd !== undefined) {
      try {
        closeSync(lockFd);
      } catch {
        // best-effort close
      }
    }
    try {
      rmSync(lockPath, { force: true });
    } catch {
      // best-effort cleanup
    }
  }

  return {
    exitCode: 0,
    truncated,
    originalBytes,
    outboxPath,
    retries,
    staleLockfileRemoved,
  };
}

// ─── line serialization with 64KB cap ────────────────────────────────────────

interface SerializeResult {
  /** Final line text including trailing newline. */
  line: string;
  truncated: boolean;
  originalBytes?: number;
}

/**
 * Serialize an OutboxLineEntry to JSONL, enforcing the 64KB cap from
 * docs/adr/ADR-omcp-eb-02-outbox-schema.md §3. When the full serialization
 * exceeds the cap, binary-search the largest truncation length that fits
 * (accounting for JSON-escape blowup of arbitrary characters) and emit
 * `truncated: true` + `original_bytes` markers alongside the truncated
 * payload string.
 *
 * Exported for unit testing the cap logic independently.
 */
export function serializeLineWithCap(entry: OutboxLineEntry): SerializeResult {
  const fullJson = JSON.stringify(entry);
  const fullLine = `${fullJson}\n`;
  const fullBytes = Buffer.byteLength(fullLine, "utf8");
  if (fullBytes <= OUTBOX_LINE_MAX_BYTES) {
    return { line: fullLine, truncated: false };
  }

  // Truncated path: binary-search the largest payload-string length that
  // fits the 64KB cap. JSON.stringify of arbitrary text can produce escape
  // sequences that grow byte count unpredictably (e.g., a unicode quote
  // grows to 6 bytes via \u-escape); binary search handles this without
  // an explicit growth heuristic.
  let payloadStr: string;
  try {
    payloadStr = JSON.stringify(entry.payload) ?? String(entry.payload);
  } catch {
    payloadStr = String(entry.payload);
  }

  let lo = 0;
  let hi = payloadStr.length;
  let bestLine = "";
  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2);
    const truncatedPayload = payloadStr.slice(0, mid);
    const candidate: OutboxLineEntry = {
      ts: entry.ts,
      consumer: entry.consumer,
      payload: truncatedPayload,
      truncated: true,
      original_bytes: fullBytes,
    };
    const candidateLine = `${JSON.stringify(candidate)}\n`;
    const bytes = Buffer.byteLength(candidateLine, "utf8");
    if (bytes <= OUTBOX_LINE_MAX_BYTES) {
      bestLine = candidateLine;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }

  // Defensive fallback: even an empty payload didn't fit (would only
  // happen if ts + consumer + markers already exceed 64KB). Emit a
  // minimal entry; downstream readers see truncated:true + a marker.
  if (!bestLine) {
    bestLine = `${JSON.stringify({
      ts: entry.ts,
      consumer: entry.consumer,
      payload: "",
      truncated: true,
      original_bytes: fullBytes,
    } satisfies OutboxLineEntry)}\n`;
  }

  return {
    line: bestLine,
    truncated: true,
    originalBytes: fullBytes,
  };
}

function defaultBusyWait(ms: number): void {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    // intentional busy-wait — matches existing shutdownTeam pattern
  }
}

// ─── CLI wrapper ─────────────────────────────────────────────────────────────

export interface RunTeamOutboxWriteCliOpts {
  cwd?: string;
  log?: (line: string) => void;
  errLog?: (line: string) => void;
}

/**
 * CLI wrapper: validates argv shape, parses JSON payload, dispatches.
 * Returns exit code per ADR-EB-02: 0 ok / 2 invalid argv / 4 lock-contention
 * / 1 other error.
 */
export function runTeamOutboxWriteCli(
  sessionId: string,
  consumer: string,
  jsonPayloadStr: string,
  opts: RunTeamOutboxWriteCliOpts = {},
): number {
  const log = opts.log ?? ((l: string) => console.log(l));
  const errLog = opts.errLog ?? ((l: string) => console.error(l));

  try {
    assertSafeSlug(sessionId, "session-id");
    assertSafeSlug(consumer, "consumer");
  } catch (err) {
    if (err instanceof UnsafeSlugError) {
      errLog(`omcp team-outbox-write: ${err.message}`);
    } else {
      errLog(`omcp team-outbox-write: invalid session-id or consumer`);
    }
    return 2;
  }

  let payload: unknown;
  try {
    payload = JSON.parse(jsonPayloadStr);
  } catch (err) {
    errLog(
      `omcp team-outbox-write: payload must be valid JSON (${(err as Error).message})`,
    );
    return 2;
  }

  const result = runTeamOutboxWrite({
    sessionId,
    consumer,
    payload,
    cwd: opts.cwd,
  });

  if (result.exitCode === 0) {
    log(`omcp team-outbox-write: appended to ${result.outboxPath}`);
    if (result.truncated) {
      log(
        `  truncated:      true (original_bytes=${result.originalBytes})`,
      );
    }
    log(`  retries:        ${result.retries}`);
    if (result.staleLockfileRemoved) {
      log(`  stale-lockfile: force-removed during retry`);
    }
  } else if (result.exitCode === 4) {
    errLog(
      `omcp team-outbox-write: lock-contention — failed to acquire lockfile after ${result.retries} retries`,
    );
  } else if (result.exitCode === 1) {
    errLog(
      `omcp team-outbox-write: unexpected error during append (retries=${result.retries})`,
    );
  }
  return result.exitCode;
}

// ─── re-export for the read-cursor story (US-EB06-OUTBOX-READ-CURSOR) ────────

/**
 * Parse a single outbox JSONL line. Returns {ok:true, entry} on parse success;
 * {ok:false, raw} otherwise so callers can decide how to handle partial writes
 * (per ADR-EB-02 §5 reader tolerance).
 */
export function parseOutboxLine(
  line: string,
):
  | { ok: true; entry: OutboxLineEntry }
  | { ok: false; raw: string } {
  try {
    const parsed = JSON.parse(line) as OutboxLineEntry;
    if (
      typeof parsed.ts !== "string" ||
      typeof parsed.consumer !== "string" ||
      !("payload" in parsed)
    ) {
      return { ok: false, raw: line };
    }
    return { ok: true, entry: parsed };
  } catch {
    return { ok: false, raw: line };
  }
}

/** Read the raw outbox JSONL file from a sessionId; returns "" when absent. */
export function readOutboxRaw(sessionId: string, cwd: string): string {
  const outboxPath = join(cwd, ".omcp", "state", "team", sessionId, "outbox.jsonl");
  if (!existsSync(outboxPath)) return "";
  return readFileSync(outboxPath, "utf8");
}
