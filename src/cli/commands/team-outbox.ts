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
import { atomicWriteFileSync } from "../../runtime/atomic-write.js";

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
  // On Windows NTFS the openSync('wx') ↔ rmSync race can surface transient
  // EBUSY / EPERM / ENOENT when one writer's lock-release overlaps another
  // writer's lock-acquire. These are not real failures — treat them as
  // retryable just like EEXIST.
  const RETRYABLE_LOCK_ERRORS = new Set(["EEXIST", "EBUSY", "EPERM", "ENOENT"]);
  let lockFd: number | undefined;
  let retries = 0;
  let staleLockfileRemoved = false;
  for (let i = 0; i <= backoff.length; i++) {
    try {
      lockFd = openSync(lockPath, "wx");
      break;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code ?? "";
      if (!RETRYABLE_LOCK_ERRORS.has(code)) {
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
      // (Only stat when the file actually exists; ENOENT/EBUSY/EPERM means
      // the lock is transitioning, not held.)
      if (code === "EEXIST") {
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

/**
 * Synchronous sleep using Atomics.wait on a never-notified SharedArrayBuffer.
 * Yields the thread to the kernel scheduler (unlike a date-loop busy-wait,
 * which burns CPU and starves other contenders under 8-process load — the
 * EB-06 concurrency-lane regression that surfaced this fix).
 */
function defaultBusyWait(ms: number): void {
  if (ms <= 0) return;
  const view = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(view, 0, 0, ms);
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

// ─── Story 4: outbox-read-cursor ──────────────────────────────────────────────

/**
 * Cursor file shape. Per ADR-EB-02 §4, the same shape covers outbox
 * (single-file → fileIndex always 0) and inbox (rotates → fileIndex
 * advances).
 */
export interface OutboxCursor {
  fileIndex: number;
  byteOffset: number;
}

export interface RunTeamOutboxReadOpts {
  sessionId: string;
  consumer: string;
  /** Reset the cursor to {fileIndex:0, byteOffset:0} before reading. */
  reset?: boolean;
  cwd?: string;
}

export interface RunTeamOutboxReadResult {
  exitCode: number;
  /** Parsed entries (well-formed JSON lines) read this invocation. */
  entries: OutboxLineEntry[];
  /** Raw lines that failed to parse (partial writes / corrupt). */
  parseErrors: string[];
  /** New cursor after this read (persisted to disk on exit 0). */
  cursor: OutboxCursor;
  /** Cursor BEFORE this read (informational). */
  previousCursor: OutboxCursor;
  /** Path of the outbox file read from. */
  outboxPath?: string;
  /** Path of the cursor file. */
  cursorPath?: string;
}

function cursorFilePath(pidDir: string, consumer: string): string {
  return join(pidDir, `outbox-cursor-${consumer}.json`);
}

function readCursorFile(cursorPath: string): OutboxCursor {
  if (!existsSync(cursorPath)) {
    return { fileIndex: 0, byteOffset: 0 };
  }
  try {
    const parsed = JSON.parse(readFileSync(cursorPath, "utf8")) as Partial<OutboxCursor>;
    const fileIndex =
      typeof parsed.fileIndex === "number" && parsed.fileIndex >= 0
        ? parsed.fileIndex
        : 0;
    const byteOffset =
      typeof parsed.byteOffset === "number" && parsed.byteOffset >= 0
        ? parsed.byteOffset
        : 0;
    return { fileIndex, byteOffset };
  } catch {
    // Corrupt cursor → fall back to fresh start (ADR-EB-02 §5 tolerance).
    return { fileIndex: 0, byteOffset: 0 };
  }
}

/**
 * Read new lines from the outbox starting at the persisted cursor for
 * `consumer`. Returns successfully-parsed entries + any unparseable lines
 * separately (ADR-EB-02 §5: trailing partial line is non-fatal — cursor
 * advances only past the last successfully-parsed line's \n so the next
 * read picks up the partial line once a full line lands behind it).
 *
 * Exit codes:
 *   0 — read completed; cursor advanced + persisted
 *   2 — invalid sessionId or consumer
 *   3 — outbox file absent (no work done; cursor unchanged)
 */
export function runTeamOutboxRead(
  opts: RunTeamOutboxReadOpts,
): RunTeamOutboxReadResult {
  // Invariant 1.
  try {
    assertSafeSlug(opts.sessionId, "session-id");
    assertSafeSlug(opts.consumer, "consumer");
  } catch {
    return {
      exitCode: 2,
      entries: [],
      parseErrors: [],
      cursor: { fileIndex: 0, byteOffset: 0 },
      previousCursor: { fileIndex: 0, byteOffset: 0 },
    };
  }

  const cwd = opts.cwd ?? process.cwd();
  const pidDir = join(cwd, ".omcp", "state", "team", opts.sessionId);
  const outboxPath = join(pidDir, "outbox.jsonl");
  const cursorPath = cursorFilePath(pidDir, opts.consumer);

  const previousCursor = opts.reset
    ? { fileIndex: 0, byteOffset: 0 }
    : readCursorFile(cursorPath);

  if (!existsSync(outboxPath)) {
    return {
      exitCode: 3,
      entries: [],
      parseErrors: [],
      cursor: previousCursor,
      previousCursor,
      outboxPath,
      cursorPath,
    };
  }

  const content = readFileSync(outboxPath, "utf8");
  // Slice from previous byteOffset onward (UTF-8 byte-accurate).
  const buffer = Buffer.from(content, "utf8");
  const sliceFrom = Math.min(previousCursor.byteOffset, buffer.length);
  const tail = buffer.slice(sliceFrom).toString("utf8");

  // Split on \n. The LAST element after split may be empty (clean
  // trailing newline) OR a partial line (mid-write). Partial line
  // detection: lacks trailing \n in the original tail.
  const hasTrailingNewline = tail.endsWith("\n");
  const allParts = tail.split("\n");
  // If tail ends with \n, the last split() element is "" → drop it.
  // If tail does NOT end with \n, the last element is the partial line.
  const completeLines = hasTrailingNewline
    ? allParts.slice(0, -1) // drop trailing empty
    : allParts.slice(0, -1); // drop the partial last line (advance cursor only past complete ones)
  // partialLine bytes that we will NOT advance past on this read.
  const partialLine = hasTrailingNewline ? "" : allParts[allParts.length - 1];
  const partialBytes = Buffer.byteLength(partialLine, "utf8");

  const entries: OutboxLineEntry[] = [];
  const parseErrors: string[] = [];
  for (const line of completeLines) {
    if (line.length === 0) continue; // skip empty mid-stream lines (defensive)
    const parsed = parseOutboxLine(line);
    if (parsed.ok) {
      entries.push(parsed.entry);
    } else {
      parseErrors.push(parsed.raw);
    }
  }

  const advancedBytes = Buffer.byteLength(tail, "utf8") - partialBytes;
  const newCursor: OutboxCursor = {
    fileIndex: previousCursor.fileIndex, // outbox is single-file in EB-06
    byteOffset: sliceFrom + advancedBytes,
  };

  // Atomic cursor persistence (Invariant 2).
  mkdirSync(pidDir, { recursive: true });
  // Use a separate atomicWriteFileSync import — already imported at top via runtime.
  atomicWriteCursor(cursorPath, newCursor);

  return {
    exitCode: 0,
    entries,
    parseErrors,
    cursor: newCursor,
    previousCursor,
    outboxPath,
    cursorPath,
  };
}

/** Atomically rewrite the cursor file (Invariant 2). Exported for tests. */
export function atomicWriteCursor(cursorPath: string, cursor: OutboxCursor): void {
  atomicWriteFileSync(cursorPath, JSON.stringify(cursor, null, 2));
}

// ─── Story 4: CLI wrapper ─────────────────────────────────────────────────────

export interface RunTeamOutboxReadCliOpts {
  reset?: boolean;
  cwd?: string;
  log?: (line: string) => void;
  errLog?: (line: string) => void;
  /** Optional: emit JSON for machine-readable consumers. */
  json?: boolean;
}

/**
 * `omcp team-outbox-read <session-id> <consumer> [--reset] [--json]` CLI
 * wrapper. Returns exit code per runTeamOutboxRead.
 */
export function runTeamOutboxReadCli(
  sessionId: string,
  consumer: string,
  opts: RunTeamOutboxReadCliOpts = {},
): number {
  const log = opts.log ?? ((l: string) => console.log(l));
  const errLog = opts.errLog ?? ((l: string) => console.error(l));

  try {
    assertSafeSlug(sessionId, "session-id");
    assertSafeSlug(consumer, "consumer");
  } catch (err) {
    if (err instanceof UnsafeSlugError) {
      errLog(`omcp team-outbox-read: ${err.message}`);
    } else {
      errLog(`omcp team-outbox-read: invalid session-id or consumer`);
    }
    return 2;
  }

  const result = runTeamOutboxRead({
    sessionId,
    consumer,
    reset: opts.reset,
    cwd: opts.cwd,
  });

  if (result.exitCode === 3) {
    errLog(
      `omcp team-outbox-read: no outbox file for session '${sessionId}' (yet?)`,
    );
    return 3;
  }

  if (opts.json) {
    log(
      JSON.stringify(
        {
          previousCursor: result.previousCursor,
          cursor: result.cursor,
          entries: result.entries,
          parseErrors: result.parseErrors,
        },
        null,
        2,
      ),
    );
    return 0;
  }

  log(`omcp team-outbox-read: session=${sessionId} consumer=${consumer}`);
  log(
    `  cursor:        ${result.previousCursor.fileIndex}:${result.previousCursor.byteOffset} → ${result.cursor.fileIndex}:${result.cursor.byteOffset}`,
  );
  log(`  entries:       ${result.entries.length}`);
  log(`  parse errors:  ${result.parseErrors.length}`);
  for (const e of result.entries) {
    log(`    ${e.ts} ${e.consumer} ${JSON.stringify(e.payload)}`);
  }
  return 0;
}
