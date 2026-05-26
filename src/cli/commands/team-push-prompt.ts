// `omcp team-push-prompt --worker <idx> --prompt <text>` (RG-02 / ADR-RG-02)
//
// Priority-mailbox push (Hybrid B-prime). Writes a high-priority record to a
// per-worker mailbox shard at
//   `.omcp/state/team/<sid>/worker-<idx>-push.jsonl`
// which the worker SKILL polls on a 500ms cadence between major work
// checkpoints, draining priority records before normal inbox.
//
// NO `--via stdin` flag — architect A1 rejected the Windows named-pipe
// stdin transport (process stdin is a kernel HANDLE inherited at
// CreateProcess, not filesystem-addressable; team-loop.ts spawns
// detached+unref'd with no parent retaining a stdin handle). This file
// must remain free of any "stdin", "named-pipe", or "tmux" transport
// references; grep enforces it (RG-02 acceptance criterion).
//
// Pre-write heartbeat-freshness gate (PM-D / C2 mitigation):
//   Before appending to the worker's push shard, read
//   `worker-<idx>-heartbeat.json` and verify the `ts` field is fresher
//   than HEARTBEAT_INTERVAL_S_DEFAULT × HEARTBEAT_FRESHNESS_MULTIPLIER_DEFAULT
//   = 30s × 3 = 90s. When stale (or absent), DO NOT write the record to
//   the worker's push shard; instead append it to
//   `<sid>/dead-letter-push.jsonl` and exit 5 ("worker stale").
//
// Cross-fork attribution: every push record carries
// `producer_fork: "omcp-r2"` so co-located other-fork records remain
// distinguishable on the same state dir (RG-01 / ADR-RG-01 contract).
//
// Exit codes:
//   0 — record written to worker push shard
//   2 — invalid argv (bad slug / bad worker-index / empty prompt)
//   4 — lock-contention exhausted on the push shard lockfile
//   5 — worker stale (heartbeat older than 90s OR missing); record was
//       routed to dead-letter-push.jsonl instead
//   1 — unexpected I/O error

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

import { assertSafeSlug, UnsafeSlugError } from "../../runtime/safe-slug.js";
import {
  OUTBOX_LOCK_BACKOFF_MS,
  OUTBOX_STALE_LOCK_MS,
  PRODUCER_FORK_ID,
} from "./team-outbox.js";
import {
  HEARTBEAT_FRESHNESS_MULTIPLIER_DEFAULT,
  HEARTBEAT_INTERVAL_S_DEFAULT,
  heartbeatFilePath,
  resolveHeartbeatFreshnessMs,
  type HeartbeatPayload,
} from "./team-heartbeat.js";
import { appendEventBestEffort } from "./team-event.js";

// ─── constants ───────────────────────────────────────────────────────────────

/**
 * Worker SKILL poll cadence for the push shard (ms). Documented for callers
 * computing p95 latency expectations; the verb itself does not sleep this
 * value — workers do. ADR-RG-02 §Decision pins 500ms.
 */
export const PUSH_PROMPT_WORKER_POLL_MS = 500;

// ─── types ───────────────────────────────────────────────────────────────────

/**
 * Wire shape of a single push-prompt record. Append-only JSONL line.
 * Schema-additive — readers tolerate extra keys (P4).
 */
export interface PushPromptRecord {
  ts: string;
  worker_index: number;
  prompt: string;
  producer_fork: string;
  priority: "push";
}

export interface RunTeamPushPromptOpts {
  sessionId: string;
  workerIndex: number;
  prompt: string;
  /** Override cwd (test hook). */
  cwd?: string;
  /** Test hook: timestamp source (default new Date().toISOString()). */
  now?: () => string;
  /** Test hook: wall-clock now in ms for heartbeat-freshness math. */
  nowMs?: () => number;
  /** Test hook: sleep function (default kernel-sleep via Atomics.wait). */
  sleep?: (ms: number) => void;
  /** Test hook: override backoff sequence (default OUTBOX_LOCK_BACKOFF_MS). */
  backoffMs?: readonly number[];
  /** Test hook: override stale-lock threshold (default OUTBOX_STALE_LOCK_MS). */
  staleLockMs?: number;
  /** Test hook: override heartbeat-freshness threshold (ms). */
  heartbeatFreshnessMs?: number;
}

export interface RunTeamPushPromptResult {
  /** 0 ok, 2 invalid argv, 4 lock-contention, 5 worker stale, 1 other error. */
  exitCode: number;
  /** Path of the push shard appended to (when exitCode 0). */
  pushPath?: string;
  /** Path of the dead-letter file appended to (when exitCode 5). */
  deadLetterPath?: string;
  /** Number of lockfile retries that fired before acquire (or exhaustion). */
  retries: number;
  /** True iff a stale lockfile was force-removed during retry. */
  staleLockfileRemoved: boolean;
  /**
   * When exitCode === 5, the staleness reason ("missing heartbeat",
   * "ts older than threshold", "malformed heartbeat"). Informational.
   */
  staleReason?: string;
}

// ─── core ────────────────────────────────────────────────────────────────────

export function runTeamPushPrompt(
  opts: RunTeamPushPromptOpts,
): RunTeamPushPromptResult {
  // Invariant 1: validate slug before any path interpolation.
  try {
    assertSafeSlug(opts.sessionId, "session-id");
  } catch {
    return {
      exitCode: 2,
      retries: 0,
      staleLockfileRemoved: false,
    };
  }

  if (!Number.isInteger(opts.workerIndex) || opts.workerIndex < 0) {
    return {
      exitCode: 2,
      retries: 0,
      staleLockfileRemoved: false,
    };
  }

  if (typeof opts.prompt !== "string" || opts.prompt.length === 0) {
    return {
      exitCode: 2,
      retries: 0,
      staleLockfileRemoved: false,
    };
  }

  // RG-04b instrumentation: defensive entry event.
  appendEventBestEffort({
    sessionId: opts.sessionId,
    verb: "team-push-prompt",
    kind: "entry",
    actor: `worker-${opts.workerIndex}`,
    cwd: opts.cwd,
  });

  const cwd = opts.cwd ?? process.cwd();
  const now = opts.now ?? (() => new Date().toISOString());
  const nowMs = opts.nowMs ?? Date.now;
  const sleep = opts.sleep ?? defaultSleep;
  const backoff = opts.backoffMs ?? OUTBOX_LOCK_BACKOFF_MS;
  const staleLockMs = opts.staleLockMs ?? OUTBOX_STALE_LOCK_MS;
  const freshnessMs =
    opts.heartbeatFreshnessMs ?? resolveHeartbeatFreshnessMs();

  const teamDir = join(cwd, ".omcp", "state", "team", opts.sessionId);
  mkdirSync(teamDir, { recursive: true });

  const record: PushPromptRecord = {
    ts: now(),
    worker_index: opts.workerIndex,
    prompt: opts.prompt,
    producer_fork: PRODUCER_FORK_ID,
    priority: "push",
  };
  const line = `${JSON.stringify(record)}\n`;

  // ── PM-D heartbeat-freshness gate ───────────────────────────────────────
  const staleness = inspectHeartbeatFreshness(
    teamDir,
    opts.workerIndex,
    freshnessMs,
    nowMs,
  );
  if (staleness.stale) {
    const deadLetterPath = join(teamDir, "dead-letter-push.jsonl");
    const deadLetterLock = `${deadLetterPath}.lock`;
    const dlResult = appendWithLock(
      deadLetterPath,
      deadLetterLock,
      line,
      backoff,
      staleLockMs,
      sleep,
    );
    return {
      exitCode: 5,
      deadLetterPath,
      retries: dlResult.retries,
      staleLockfileRemoved: dlResult.staleLockfileRemoved,
      staleReason: staleness.reason,
    };
  }

  // ── Happy path: append to the worker's push shard ───────────────────────
  const pushPath = pushShardPath(teamDir, opts.workerIndex);
  const lockPath = `${pushPath}.lock`;
  const result = appendWithLock(
    pushPath,
    lockPath,
    line,
    backoff,
    staleLockMs,
    sleep,
  );
  if (result.exitCode !== 0) {
    return {
      exitCode: result.exitCode,
      retries: result.retries,
      staleLockfileRemoved: result.staleLockfileRemoved,
    };
  }

  // RG-04b instrumentation: defensive exit event.
  appendEventBestEffort({
    sessionId: opts.sessionId,
    verb: "team-push-prompt",
    kind: "exit",
    actor: `worker-${opts.workerIndex}`,
    cwd: opts.cwd,
    detail: { exitCode: 0, retries: result.retries },
  });

  return {
    exitCode: 0,
    pushPath,
    retries: result.retries,
    staleLockfileRemoved: result.staleLockfileRemoved,
  };
}

// ─── helpers ────────────────────────────────────────────────────────────────

/** Push shard path for a given worker index. */
export function pushShardPath(teamDir: string, workerIndex: number): string {
  return join(teamDir, `worker-${workerIndex}-push.jsonl`);
}

interface FreshnessVerdict {
  stale: boolean;
  reason?: string;
}

/**
 * Inspect a worker's heartbeat for liveness without modifying the schema.
 * Reads worker-<idx>-heartbeat.json and checks the existing {ts} field
 * against the resolved freshness threshold. Returns {stale:true,reason}
 * when the heartbeat is missing, malformed, or older than the threshold.
 *
 * Note: ADR-RG-02 §Decision explicitly forbids adding new fields to the
 * heartbeat payload — this function uses the existing {ts, workerIndex,
 * pid} shape only.
 */
function inspectHeartbeatFreshness(
  teamDir: string,
  workerIndex: number,
  freshnessMs: number,
  nowMs: () => number,
): FreshnessVerdict {
  const hbPath = heartbeatFilePath(teamDir, workerIndex);
  if (!existsSync(hbPath)) {
    return { stale: true, reason: "missing heartbeat" };
  }
  let parsed: Partial<HeartbeatPayload>;
  try {
    parsed = JSON.parse(readFileSync(hbPath, "utf8")) as Partial<HeartbeatPayload>;
  } catch {
    return { stale: true, reason: "malformed heartbeat" };
  }
  if (typeof parsed.ts !== "string") {
    return { stale: true, reason: "malformed heartbeat" };
  }
  const tsMs = Date.parse(parsed.ts);
  if (!Number.isFinite(tsMs)) {
    return { stale: true, reason: "malformed heartbeat ts" };
  }
  const ageMs = nowMs() - tsMs;
  if (ageMs > freshnessMs) {
    return {
      stale: true,
      reason: `ts older than threshold (age=${ageMs}ms > ${freshnessMs}ms)`,
    };
  }
  return { stale: false };
}

interface AppendWithLockResult {
  exitCode: number;
  retries: number;
  staleLockfileRemoved: boolean;
}

/**
 * Append a line to a JSONL stream under a per-stream lockfile. Mirrors the
 * outbox lockfile primitive (team-outbox.ts:189-269) for byte-identical
 * cross-platform semantics: exclusive-create lock sidecar + exponential
 * backoff + 30s stale-lock cleanup. Retryable errors on Windows NTFS:
 * EEXIST / EBUSY / EPERM / ENOENT.
 */
function appendWithLock(
  streamPath: string,
  lockPath: string,
  line: string,
  backoff: readonly number[],
  staleLockMs: number,
  sleep: (ms: number) => void,
): AppendWithLockResult {
  const RETRYABLE_LOCK_ERRORS = new Set([
    "EEXIST",
    "EBUSY",
    "EPERM",
    "ENOENT",
  ]);
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
        return { exitCode: 1, retries, staleLockfileRemoved };
      }
      if (code === "EEXIST") {
        try {
          const lockMtime = statSync(lockPath).mtimeMs;
          if (Date.now() - lockMtime > staleLockMs) {
            rmSync(lockPath, { force: true });
            staleLockfileRemoved = true;
            continue;
          }
        } catch {
          // stat raced with another process's release; try again
        }
      }
      if (i >= backoff.length) {
        return { exitCode: 4, retries, staleLockfileRemoved };
      }
      sleep(backoff[i]);
      retries++;
    }
  }

  try {
    appendFileSync(streamPath, line, { encoding: "utf8" });
  } catch {
    return { exitCode: 1, retries, staleLockfileRemoved };
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

  return { exitCode: 0, retries, staleLockfileRemoved };
}

/**
 * Synchronous sleep via Atomics.wait on a never-notified SharedArrayBuffer.
 * Yields the thread to the kernel scheduler instead of CPU-burning under
 * multi-process contention. Mirrors team-outbox.ts's defaultBusyWait.
 */
function defaultSleep(ms: number): void {
  if (ms <= 0) return;
  const view = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(view, 0, 0, ms);
}

// ─── CLI wrapper ─────────────────────────────────────────────────────────────

export interface RunTeamPushPromptCliOpts {
  cwd?: string;
  log?: (line: string) => void;
  errLog?: (line: string) => void;
}

/**
 * CLI wrapper: `omcp team-push-prompt <session-id> --worker <idx> --prompt <text>`.
 *
 * Exit codes: 0 ok / 2 invalid argv / 4 lock-contention / 5 worker stale /
 * 1 other error (per ADR-RG-02).
 */
export function runTeamPushPromptCli(
  sessionId: string,
  workerIndexStr: string,
  prompt: string,
  opts: RunTeamPushPromptCliOpts = {},
): number {
  const log = opts.log ?? ((l: string) => console.log(l));
  const errLog = opts.errLog ?? ((l: string) => console.error(l));

  try {
    assertSafeSlug(sessionId, "session-id");
  } catch (err) {
    if (err instanceof UnsafeSlugError) {
      errLog(`omcp team-push-prompt: ${err.message}`);
    } else {
      errLog(`omcp team-push-prompt: invalid session-id`);
    }
    return 2;
  }

  const workerIndex = Number.parseInt(workerIndexStr, 10);
  if (
    !Number.isFinite(workerIndex) ||
    workerIndex < 0 ||
    String(workerIndex) !== workerIndexStr.trim()
  ) {
    errLog(
      `omcp team-push-prompt: --worker must be a non-negative integer (got: ${JSON.stringify(workerIndexStr)})`,
    );
    return 2;
  }

  if (typeof prompt !== "string" || prompt.length === 0) {
    errLog(`omcp team-push-prompt: --prompt must be a non-empty string`);
    return 2;
  }

  const result = runTeamPushPrompt({
    sessionId,
    workerIndex,
    prompt,
    cwd: opts.cwd,
  });

  if (result.exitCode === 0) {
    log(`omcp team-push-prompt: appended to ${result.pushPath}`);
    log(`  retries:        ${result.retries}`);
    if (result.staleLockfileRemoved) {
      log(`  stale-lockfile: force-removed during retry`);
    }
  } else if (result.exitCode === 5) {
    errLog(
      `omcp team-push-prompt: worker-${workerIndex} stale (${result.staleReason}); record routed to dead-letter ${result.deadLetterPath}`,
    );
    errLog(
      `  freshness threshold: ${HEARTBEAT_INTERVAL_S_DEFAULT}s × ${HEARTBEAT_FRESHNESS_MULTIPLIER_DEFAULT} = ${HEARTBEAT_INTERVAL_S_DEFAULT * HEARTBEAT_FRESHNESS_MULTIPLIER_DEFAULT}s`,
    );
  } else if (result.exitCode === 4) {
    errLog(
      `omcp team-push-prompt: lock-contention — failed to acquire lockfile after ${result.retries} retries`,
    );
  } else if (result.exitCode === 1) {
    errLog(
      `omcp team-push-prompt: unexpected error during append (retries=${result.retries})`,
    );
  }
  return result.exitCode;
}
