// Per-stream lockfile primitive (RG-04a / ADR-RG-04 §A2).
//
// Reusable helper extracted from src/cli/commands/team-outbox.ts's
// hand-rolled lockfile pattern. Each JSONL stream owns its own lockfile
// derived as `<stream>.lock` colocated with the stream file. Rationale:
// events.jsonl ingest must NOT block outbox.jsonl ingest — per-stream
// isolation guarantees verbs writing to different streams never contend
// on the same lockfile.
//
// Contract:
//   1. acquirePerStreamLock(streamPath) returns a handle.
//   2. Call handle.release() (typically in try/finally) to drop the lock.
//   3. On lock-acquire failure after the backoff ladder is exhausted, throws
//      PerStreamLockExhaustedError with the retry count.
//   4. Stale lockfiles older than staleLockMs are force-removed during
//      acquisition (multi-process crash recovery).
//
// IMPORTANT: team-outbox.ts keeps its INLINE pattern in RG-04a. This helper
// exists for RG-04a's team-event.ts AND future refactor opportunities.
// Refactoring team-outbox.ts to use this helper is explicitly OUT OF SCOPE
// for RG-04a (follow-up story).

import { closeSync, openSync, rmSync, statSync } from "node:fs";

/** Default lockfile age threshold (ms) — older locks are crash leftovers. */
export const PER_STREAM_LOCK_DEFAULT_STALE_MS = 30_000;

/**
 * Default exponential backoff retry sequence for lockfile acquire (ms).
 * Total: 19,250 ms (8 retries). Sized to handle 8-process contention on
 * slow CI runners — mirrors OUTBOX_LOCK_BACKOFF_MS in team-outbox.ts.
 */
export const PER_STREAM_LOCK_DEFAULT_BACKOFF_MS = [
  50, 100, 200, 400, 1_000, 2_500, 5_000, 10_000,
] as const;

/** Windows NTFS race-recovery: openSync('wx') ↔ rmSync overlap surfaces these. */
const RETRYABLE_LOCK_ERRORS = new Set(["EEXIST", "EBUSY", "EPERM", "ENOENT"]);

export interface AcquirePerStreamLockOpts {
  /** Override stale-lock threshold (default PER_STREAM_LOCK_DEFAULT_STALE_MS). */
  staleLockMs?: number;
  /** Override backoff sequence (default PER_STREAM_LOCK_DEFAULT_BACKOFF_MS). */
  backoffMs?: readonly number[];
  /** Test hook: synchronous sleep. Default Atomics.wait kernel-sleep. */
  sleep?: (ms: number) => void;
}

export interface PerStreamLockHandle {
  /** Path of the held lockfile (`<stream>.lock`). */
  readonly lockPath: string;
  /** Number of backoff retries that fired before acquire. */
  readonly retries: number;
  /** True iff a stale lockfile was force-removed during retry. */
  readonly staleLockfileRemoved: boolean;
  /** Release the lock (close fd + remove lockfile). Idempotent. */
  release(): void;
}

export class PerStreamLockExhaustedError extends Error {
  constructor(
    public readonly lockPath: string,
    public readonly retries: number,
  ) {
    super(
      `per-stream lock exhausted: ${lockPath} not acquired after ${retries} retries`,
    );
    this.name = "PerStreamLockExhaustedError";
  }
}

/**
 * Acquire a per-stream lockfile via `openSync('wx')` + exponential backoff
 * + stale-cleanup. The lockfile path is derived as `${streamPath}.lock`.
 *
 * Multi-process safe: only one process can hold the lock at a time.
 * Throws PerStreamLockExhaustedError when the backoff ladder is exhausted.
 */
export function acquirePerStreamLock(
  streamPath: string,
  opts: AcquirePerStreamLockOpts = {},
): PerStreamLockHandle {
  const lockPath = `${streamPath}.lock`;
  const staleLockMs = opts.staleLockMs ?? PER_STREAM_LOCK_DEFAULT_STALE_MS;
  const backoff = opts.backoffMs ?? PER_STREAM_LOCK_DEFAULT_BACKOFF_MS;
  const sleep = opts.sleep ?? defaultKernelSleep;

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
        // Unexpected error — rethrow to caller.
        throw err;
      }
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
      if (i >= backoff.length) {
        throw new PerStreamLockExhaustedError(lockPath, retries);
      }
      sleep(backoff[i]);
      retries++;
    }
  }

  if (lockFd === undefined) {
    // Defensive — should be unreachable: either we broke out of the loop
    // with a valid fd, or we threw the exhausted error above.
    throw new PerStreamLockExhaustedError(lockPath, retries);
  }

  const fd = lockFd;
  let released = false;
  return {
    lockPath,
    retries,
    staleLockfileRemoved,
    release(): void {
      if (released) return;
      released = true;
      try {
        closeSync(fd);
      } catch {
        // best-effort close
      }
      try {
        rmSync(lockPath, { force: true });
      } catch {
        // best-effort cleanup
      }
    },
  };
}

/**
 * Synchronous kernel-sleep via Atomics.wait on a never-notified
 * SharedArrayBuffer. Yields the thread to the scheduler instead of
 * burning CPU in a date-loop (which starves other contenders under
 * multi-process load).
 */
function defaultKernelSleep(ms: number): void {
  if (ms <= 0) return;
  const view = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(view, 0, 0, ms);
}
