// `omcp team-inbox-write <session-id> <markdown-body>` (EB-06 Story 6)
//
// Leader-to-worker message channel. Append-only Markdown stream with
// rotation AT 1MB per file. Cursor consumers (US-EB06-OUTBOX-READ-CURSOR
// generalizes) advance via {fileIndex, byteOffset} so file-rollover is
// transparent.
//
// Concurrency contract: shares the same hand-rolled lockfile pattern as
// outbox (ADR-omcp-eb-02 §2). Session-scoped lockfile at
// `<pidDir>/inbox.lock` (NOT per-file — the rotation decision must
// happen inside the lock so two writers don't race on inbox-N.md
// numbering).
//
// Invariants honored:
//   I1 — assertSafeSlug on sessionId
//   I2 — explicit carve-out for fs.appendFileSync (lockfile pattern;
//        sibling of outbox carve-out documented in
//        docs/architecture/invariants.md after EB-02 ADR lands)
//   I8 — registered as `omcp team-inbox-write` in src/cli/omcp.ts

import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs";
import { join } from "node:path";

import {
  assertSafeSlug,
  UnsafeSlugError,
} from "../../runtime/safe-slug.js";
import { appendEventBestEffort } from "./team-event.js";

// ─── constants ────────────────────────────────────────────────────────────────

/** Default rotation byte threshold (1 MB). Env-overridable. */
export const INBOX_ROTATE_BYTES_DEFAULT = 1_048_576;

/** Mirror of outbox lock cadence (ADR-EB-02 §2). */
export const INBOX_LOCK_BACKOFF_MS = [50, 100, 200, 400, 1_000, 2_500] as const;
export const INBOX_STALE_LOCK_MS = 30_000;

// ─── types ───────────────────────────────────────────────────────────────────

export interface RunTeamInboxWriteOpts {
  sessionId: string;
  body: string;
  cwd?: string;
  /** Override rotation threshold (default INBOX_ROTATE_BYTES_DEFAULT or env). */
  rotateBytes?: number;
  /** Test hook: sleep function. */
  sleep?: (ms: number) => void;
  /** Test hook: override backoff sequence. */
  backoffMs?: readonly number[];
  /** Test hook: override stale-lock threshold. */
  staleLockMs?: number;
}

export interface RunTeamInboxWriteResult {
  /** 0 ok, 2 invalid argv, 4 lock-contention, 1 other error. */
  exitCode: number;
  /** Path of the inbox file appended to (when exitCode 0). */
  inboxPath?: string;
  /** Final fileIndex written to (1-based, matches inbox-N.md). */
  fileIndex?: number;
  /** True iff rotation rolled the fileIndex during this write. */
  rotated: boolean;
  retries: number;
  staleLockfileRemoved: boolean;
}

// ─── core ────────────────────────────────────────────────────────────────────

export function resolveRotateBytes(
  arg?: number,
  env: NodeJS.ProcessEnv = process.env,
): number {
  const fromEnv = env.OMCP_INBOX_ROTATE_BYTES;
  if (fromEnv !== undefined && fromEnv !== "") {
    const n = Number(fromEnv);
    if (Number.isFinite(n) && n > 0) return n;
  }
  if (arg !== undefined && Number.isFinite(arg) && arg > 0) return arg;
  return INBOX_ROTATE_BYTES_DEFAULT;
}

/**
 * Append `body` (Markdown text — caller is responsible for content shape)
 * to the current inbox-N.md, rotating to N+1 AT the rotation threshold.
 * Rotation decision happens INSIDE the lockfile to prevent two writers
 * from racing on the index.
 */
export function runTeamInboxWrite(
  opts: RunTeamInboxWriteOpts,
): RunTeamInboxWriteResult {
  // Invariant 1.
  try {
    assertSafeSlug(opts.sessionId, "session-id");
  } catch {
    return { exitCode: 2, rotated: false, retries: 0, staleLockfileRemoved: false };
  }

  // RG-04b instrumentation: defensive entry event.
  appendEventBestEffort({
    sessionId: opts.sessionId,
    verb: "team-inbox-write",
    kind: "entry",
    actor: "team-inbox-write",
    cwd: opts.cwd,
  });

  const cwd = opts.cwd ?? process.cwd();
  const sleep = opts.sleep ?? defaultBusyWait;
  const backoff = opts.backoffMs ?? INBOX_LOCK_BACKOFF_MS;
  const staleLockMs = opts.staleLockMs ?? INBOX_STALE_LOCK_MS;
  const rotateBytes = resolveRotateBytes(opts.rotateBytes);

  const pidDir = join(cwd, ".omcp", "state", "team", opts.sessionId);
  mkdirSync(pidDir, { recursive: true });
  const lockPath = join(pidDir, "inbox.lock");

  // Acquire session-level inbox lock.
  let lockFd: number | undefined;
  let retries = 0;
  let staleLockfileRemoved = false;
  for (let i = 0; i <= backoff.length; i++) {
    try {
      lockFd = openSync(lockPath, "wx");
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") {
        return { exitCode: 1, rotated: false, retries, staleLockfileRemoved };
      }
      try {
        const lockMtime = statSync(lockPath).mtimeMs;
        if (Date.now() - lockMtime > staleLockMs) {
          rmSync(lockPath, { force: true });
          staleLockfileRemoved = true;
          continue;
        }
      } catch {
        // stat raced; try again
      }
      if (i >= backoff.length) {
        return { exitCode: 4, rotated: false, retries, staleLockfileRemoved };
      }
      sleep(backoff[i]);
      retries++;
    }
  }

  // Inside the lock: find current inbox-N.md, decide if rotation needed.
  let inboxPath: string | undefined;
  let fileIndex: number | undefined;
  let rotated = false;
  try {
    const currentIndex = findCurrentInboxIndex(pidDir);
    const bodyBytes = Buffer.byteLength(opts.body, "utf8");
    if (currentIndex === 0) {
      // First write ever — start at inbox-1.md.
      fileIndex = 1;
    } else {
      const currentPath = join(pidDir, `inbox-${currentIndex}.md`);
      const currentSize = existsSync(currentPath) ? statSync(currentPath).size : 0;
      if (currentSize + bodyBytes > rotateBytes) {
        fileIndex = currentIndex + 1;
        rotated = true;
      } else {
        fileIndex = currentIndex;
      }
    }
    inboxPath = join(pidDir, `inbox-${fileIndex}.md`);
    appendFileSync(inboxPath, opts.body, { encoding: "utf8" });
  } catch {
    return {
      exitCode: 1,
      inboxPath,
      fileIndex,
      rotated,
      retries,
      staleLockfileRemoved,
    };
  } finally {
    if (lockFd !== undefined) {
      try {
        closeSync(lockFd);
      } catch {
        // best-effort
      }
    }
    try {
      rmSync(lockPath, { force: true });
    } catch {
      // best-effort
    }
  }

  // RG-04b instrumentation: defensive exit event.
  appendEventBestEffort({
    sessionId: opts.sessionId,
    verb: "team-inbox-write",
    kind: "exit",
    actor: "team-inbox-write",
    cwd: opts.cwd,
    detail: { exitCode: 0, fileIndex, rotated, retries },
  });

  return {
    exitCode: 0,
    inboxPath,
    fileIndex,
    rotated,
    retries,
    staleLockfileRemoved,
  };
}

/**
 * Scan pidDir for inbox-N.md files; return max N or 0 if none.
 * Exported for unit testing.
 */
export function findCurrentInboxIndex(pidDir: string): number {
  if (!existsSync(pidDir)) return 0;
  let max = 0;
  for (const f of readdirSync(pidDir)) {
    const m = /^inbox-(\d+)\.md$/.exec(f);
    if (m) {
      const n = Number(m[1]);
      if (Number.isFinite(n) && n > max) max = n;
    }
  }
  return max;
}

/**
 * Synchronous sleep via Atomics.wait — sibling of team-outbox's helper.
 * Kernel-level wait avoids the CPU-burn cascade under multi-process lock
 * contention (see team-outbox defaultBusyWait commentary).
 */
function defaultBusyWait(ms: number): void {
  if (ms <= 0) return;
  const view = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(view, 0, 0, ms);
}

// ─── CLI wrapper ─────────────────────────────────────────────────────────────

export interface RunTeamInboxWriteCliOpts {
  cwd?: string;
  log?: (line: string) => void;
  errLog?: (line: string) => void;
}

export function runTeamInboxWriteCli(
  sessionId: string,
  body: string,
  opts: RunTeamInboxWriteCliOpts = {},
): number {
  const log = opts.log ?? ((l: string) => console.log(l));
  const errLog = opts.errLog ?? ((l: string) => console.error(l));

  try {
    assertSafeSlug(sessionId, "session-id");
  } catch (err) {
    if (err instanceof UnsafeSlugError) {
      errLog(`omcp team-inbox-write: ${err.message}`);
    } else {
      errLog(`omcp team-inbox-write: invalid session-id`);
    }
    return 2;
  }

  const result = runTeamInboxWrite({ sessionId, body, cwd: opts.cwd });

  if (result.exitCode === 0) {
    log(`omcp team-inbox-write: appended to ${result.inboxPath}`);
    log(`  fileIndex:      ${result.fileIndex}`);
    log(`  rotated:        ${result.rotated}`);
    if (result.retries > 0) {
      log(`  retries:        ${result.retries}`);
    }
  } else if (result.exitCode === 4) {
    errLog(
      `omcp team-inbox-write: lock-contention — failed to acquire lockfile after ${result.retries} retries`,
    );
  } else if (result.exitCode === 1) {
    errLog(`omcp team-inbox-write: unexpected error (retries=${result.retries})`);
  }

  return result.exitCode;
}
