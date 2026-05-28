// `omcp skill-invocation-emit --skill <name> --event <started|completed|failed>
//                              [--detail <json>]`
//
// RP-09 / F28: skill-invocation telemetry verb. Writes one JSONL record per
// skill invocation to a GLOBAL stream at `.omcp/state/skill-invocations.jsonl`
// (NOT session-scoped, unlike team-event.ts which uses
// `.omcp/state/team/<sid>/events.jsonl`).
//
// Wire format (per ADR-RP-skill-telemetry):
//   { ts: ISO-8601, skill: string,
//     event: "started" | "completed" | "failed",
//     detail?: unknown,
//     producer_fork: "omcp-r2" }
//
// Stream path: `.omcp/state/skill-invocations.jsonl`
// Per-stream lockfile: `<stream>.lock` via acquirePerStreamLock.
// 1MB rotation INSIDE the per-stream lockfile (rename to .jsonl.1).
//
// Timestamp validation (PM-G reuse): ts ∉ (now - 24h, now + 5min) → exit 5.
//
// Path-length AC (v4 RP-09 AC): `.omcp/state/skill-invocations.jsonl` is a
// fixed-length suffix (35 chars including leading `.omcp/state/`), so the
// composed path stays ≤ 240 chars when the cwd plus suffix fits in that
// budget. The skill name slug itself is validated via assertSafeSlug (cap
// 1-80 chars per safe-slug.ts:10) but does NOT appear in the path.

import {
  appendFileSync,
  existsSync,
  mkdirSync,
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
import { PRODUCER_FORK_ID } from "./team-outbox.js";
import {
  TEAM_EVENT_ROTATION_BYTES,
  validateEventTs,
} from "./team-event.js";

// ─── constants ──────────────────────────────────────────────────────────────

/** Rotation threshold (bytes). Reuses team-event 1 MiB threshold. */
export const SKILL_INVOCATION_ROTATION_BYTES = TEAM_EVENT_ROTATION_BYTES;

/** Allowed event values for the `--event` flag. */
export const SKILL_INVOCATION_EVENT_VALUES = [
  "started",
  "completed",
  "failed",
] as const;
export type SkillInvocationEvent =
  (typeof SKILL_INVOCATION_EVENT_VALUES)[number];

/**
 * v4 RP-09 AC: composed path must stay ≤ 240 chars on Windows when slug at
 * `assertSafeSlug` max (80) combined with team/worker slugs at `sanitizeSlug`
 * maxLen=30. This constant is the global path-length budget enforced by
 * `validateGlobalStreamPathLength()` below.
 */
export const SKILL_INVOCATION_PATH_LENGTH_MAX = 240;

// ─── types ──────────────────────────────────────────────────────────────────

export interface SkillInvocationRecord {
  ts: string;
  skill: string;
  event: SkillInvocationEvent;
  detail?: unknown;
  producer_fork: string;
}

export interface RunSkillInvocationEmitOpts {
  skill: string;
  event: SkillInvocationEvent | string;
  detail?: unknown;
  /** Override cwd (test hook). */
  cwd?: string;
  /** Test hook: clock source. Default Date.now (returns ms). */
  now?: () => number;
  /** Test hook: timestamp formatter. Default ISO-8601 from now(). */
  nowIso?: () => string;
}

export interface RunSkillInvocationEmitResult {
  /** 0 ok / 2 invalid argv / 4 lock-contention exhausted / 5 ts out of window / 1 other. */
  exitCode: number;
  /** Path of the JSONL stream appended to (when exitCode 0). */
  streamPath?: string;
  /** True iff a rotation fired during this append. */
  rotated: boolean;
  /** Number of lockfile retries before acquire. */
  retries: number;
  /** True iff a stale lockfile was force-removed during retry. */
  staleLockfileRemoved: boolean;
}

// ─── path resolver ──────────────────────────────────────────────────────────

/**
 * Resolve the global stream path for skill-invocation telemetry.
 *
 * Path: `<cwd>/.omcp/state/skill-invocations.jsonl`
 *
 * Throws if the composed path would exceed SKILL_INVOCATION_PATH_LENGTH_MAX.
 */
export function resolveSkillInvocationsPath(cwd: string): string {
  const streamPath = join(cwd, ".omcp", "state", "skill-invocations.jsonl");
  if (streamPath.length > SKILL_INVOCATION_PATH_LENGTH_MAX) {
    throw new Error(
      `skill-invocation-emit: stream path ${streamPath.length} chars exceeds ${SKILL_INVOCATION_PATH_LENGTH_MAX}-char limit`,
    );
  }
  return streamPath;
}

// ─── core emit ──────────────────────────────────────────────────────────────

/**
 * Validate that an event string is one of the allowed values.
 * Returns the narrowed type on success; throws otherwise.
 */
export function assertSkillInvocationEvent(
  value: unknown,
): SkillInvocationEvent {
  if (
    typeof value === "string" &&
    (SKILL_INVOCATION_EVENT_VALUES as readonly string[]).includes(value)
  ) {
    return value as SkillInvocationEvent;
  }
  throw new Error(
    `invalid event: ${JSON.stringify(value)} (allowed: ${SKILL_INVOCATION_EVENT_VALUES.join("|")})`,
  );
}

export function runSkillInvocationEmit(
  opts: RunSkillInvocationEmitOpts,
): RunSkillInvocationEmitResult {
  // Invariant: validate skill slug via assertSafeSlug (1-80 cap).
  try {
    assertSafeSlug(opts.skill, "skill");
  } catch {
    return {
      exitCode: 2,
      rotated: false,
      retries: 0,
      staleLockfileRemoved: false,
    };
  }

  // Validate event value.
  let event: SkillInvocationEvent;
  try {
    event = assertSkillInvocationEvent(opts.event);
  } catch {
    return {
      exitCode: 2,
      rotated: false,
      retries: 0,
      staleLockfileRemoved: false,
    };
  }

  const cwd = opts.cwd ?? process.cwd();
  const now = opts.now ?? Date.now;
  const nowIso = opts.nowIso ?? (() => new Date(now()).toISOString());

  const ts = nowIso();

  // PM-G ts validation (reuse from team-event.ts).
  const v = validateEventTs(ts, now());
  if (!v.ok) {
    return {
      exitCode: 5,
      rotated: false,
      retries: 0,
      staleLockfileRemoved: false,
    };
  }

  const record: SkillInvocationRecord = {
    ts,
    skill: opts.skill,
    event,
    producer_fork: PRODUCER_FORK_ID,
  };
  if (opts.detail !== undefined) record.detail = opts.detail;

  let streamPath: string;
  try {
    streamPath = resolveSkillInvocationsPath(cwd);
  } catch {
    return {
      exitCode: 1,
      rotated: false,
      retries: 0,
      staleLockfileRemoved: false,
    };
  }

  // Ensure parent directory exists.
  const streamDir = join(cwd, ".omcp", "state");
  try {
    mkdirSync(streamDir, { recursive: true });
  } catch {
    return {
      exitCode: 1,
      rotated: false,
      retries: 0,
      staleLockfileRemoved: false,
    };
  }

  let line: string;
  try {
    line = `${JSON.stringify(record)}\n`;
  } catch {
    // detail contained a non-serializable value (e.g. BigInt, circular ref).
    return {
      exitCode: 2,
      rotated: false,
      retries: 0,
      staleLockfileRemoved: false,
    };
  }

  // Acquire per-stream lock; rotate + append inside the lock.
  let handle: ReturnType<typeof acquirePerStreamLock>;
  try {
    handle = acquirePerStreamLock(streamPath);
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
    // Re-check size inside the lock (rotation-lock contract).
    if (existsSync(streamPath)) {
      let sizeBytes = 0;
      try {
        sizeBytes = statSync(streamPath).size;
      } catch {
        // race with another writer; treat as 0 + proceed
      }
      if (sizeBytes >= SKILL_INVOCATION_ROTATION_BYTES) {
        const rotatedPath = `${streamPath}.1`;
        try {
          rmSync(rotatedPath, { force: true });
        } catch {
          // best-effort
        }
        renameSync(streamPath, rotatedPath);
        rotated = true;
      }
    }
    appendFileSync(streamPath, line, { encoding: "utf8" });
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
    streamPath,
    rotated,
    retries: handle.retries,
    staleLockfileRemoved: handle.staleLockfileRemoved,
  };
}

// ─── CLI wrapper ────────────────────────────────────────────────────────────

export interface RunSkillInvocationEmitCliOpts {
  cwd?: string;
  log?: (line: string) => void;
  errLog?: (line: string) => void;
  skill: string;
  event: string;
  /** Pre-parsed JSON detail (or undefined). */
  detail?: unknown;
}

/**
 * CLI wrapper: `omcp skill-invocation-emit --skill X --event Y [--detail JSON]`.
 * Exit codes: 0 ok / 2 invalid argv / 4 lock-contention / 5 ts out of window / 1 other.
 */
export function runSkillInvocationEmitCli(
  opts: RunSkillInvocationEmitCliOpts,
): number {
  const log = opts.log ?? ((l: string) => console.log(l));
  const errLog = opts.errLog ?? ((l: string) => console.error(l));

  try {
    assertSafeSlug(opts.skill, "skill");
  } catch (err) {
    if (err instanceof UnsafeSlugError) {
      errLog(`omcp skill-invocation-emit: ${err.message}`);
    } else {
      errLog("omcp skill-invocation-emit: invalid --skill");
    }
    return 2;
  }

  if (
    typeof opts.event !== "string" ||
    !(SKILL_INVOCATION_EVENT_VALUES as readonly string[]).includes(opts.event)
  ) {
    errLog(
      `omcp skill-invocation-emit: --event must be one of ${SKILL_INVOCATION_EVENT_VALUES.join("|")} (got: ${String(opts.event)})`,
    );
    return 2;
  }

  const result = runSkillInvocationEmit({
    skill: opts.skill,
    event: opts.event as SkillInvocationEvent,
    detail: opts.detail,
    cwd: opts.cwd,
  });

  if (result.exitCode === 0) {
    log(`omcp skill-invocation-emit: appended to ${result.streamPath}`);
    log(`  retries:        ${result.retries}`);
    if (result.rotated) {
      log(
        "  rotated:        skill-invocations.jsonl → skill-invocations.jsonl.1",
      );
    }
    if (result.staleLockfileRemoved) {
      log("  stale-lockfile: force-removed during retry");
    }
  } else if (result.exitCode === 4) {
    errLog(
      `omcp skill-invocation-emit: lock-contention — failed to acquire lockfile after ${result.retries} retries`,
    );
  } else if (result.exitCode === 5) {
    errLog(
      "omcp skill-invocation-emit: ts out of window (must be within now-24h..now+5min)",
    );
  } else if (result.exitCode === 1) {
    errLog("omcp skill-invocation-emit: unexpected error during append");
  }
  return result.exitCode;
}
