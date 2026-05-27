// `omcp team-event-health-check <session-id> [--since <iso-ts>] [--json]`
//
// RG-05 / O1: observability verb. Scans the events.jsonl pipeline and
// related per-session state for integrity violations + emits a structured
// health report. Detects:
//
//   1. POISON RECORDS  — counts the `poison-record-detected` sentinel
//      events emitted by team-event-tail per PM-G. A non-zero count
//      surfaces upstream tampering (ts out of (now-24h, now+5min)).
//
//   2. ROTATION ANOMALIES — finds orphaned `events.jsonl.N` rotation
//      siblings without a corresponding live `events.jsonl`, or live
//      events.jsonl over the rotation threshold (rotation race).
//
//   3. ORPHANED LOCKFILES — finds `.lock` files older than
//      OUTBOX_STALE_LOCK_MS without an active owning process. Surfaces
//      crashed-writer leftovers.
//
//   4. NON-EMPTY DEAD-LETTER — checks `dead-letter-push.jsonl` (RG-02
//      PM-D) for any records. Non-zero = workers crashed mid-push.
//
// Exit codes (per task spec):
//   0 — healthy
//   4 — warning (dead-letter non-empty OR poison count > 0)
//   5 — critical (orphaned lockfile OR rotation anomaly)
//   2 — invalid argv
//   1 — unexpected error
//
// CRITICAL > WARNING — when both conditions hold, exit 5 takes precedence.
//
// NOTE: the verb itself never emits an `appendEvent` — Open-Question #5
// from the plan resolved tentatively as "stderr + exit code only" to
// avoid infinite-loop risk if the anomaly is IN events.jsonl.

import {
  existsSync,
  readdirSync,
  readFileSync,
  statSync,
} from "node:fs";
import { join } from "node:path";

import { assertSafeSlug, UnsafeSlugError } from "../../runtime/safe-slug.js";
import {
  TEAM_EVENT_POISON_KIND,
  TEAM_EVENT_ROTATION_BYTES,
  type TeamEventRecord,
} from "./team-event.js";
import { OUTBOX_STALE_LOCK_MS } from "./team-outbox.js";

// ─── types ──────────────────────────────────────────────────────────────────

export interface OrphanedLockfile {
  /** Path of the lockfile relative to the session dir. */
  path: string;
  /** Age in milliseconds (now - mtime). */
  ageMs: number;
}

export interface RotationAnomaly {
  /** Kind of anomaly. */
  kind: "orphaned-rotated-sibling" | "live-over-threshold-with-sibling";
  /** Path that triggered the anomaly. */
  path: string;
  /** Optional size in bytes (when kind=live-over-threshold-with-sibling). */
  sizeBytes?: number;
}

export interface TeamEventHealthReport {
  sessionId: string;
  /** Absolute timestamp of the report. */
  generatedAt: string;
  /** True iff events.jsonl exists. False if the session has not yet emitted events. */
  eventsPathExists: boolean;
  /** Path scanned (absolute or relative-to-cwd). */
  eventsPath: string;
  /** Count of poison-record-detected sentinel events in events.jsonl. */
  poisonCount: number;
  /** Optional ISO-8601 lower bound applied to the poison scan. */
  poisonSince?: string;
  /** List of rotation anomalies. */
  rotationAnomalies: RotationAnomaly[];
  /** List of orphaned lockfiles (older than OUTBOX_STALE_LOCK_MS). */
  orphanedLockfiles: OrphanedLockfile[];
  /** Number of records in dead-letter-push.jsonl (RG-02 PM-D). */
  deadLetterCount: number;
  /** Top-level verdict. */
  verdict: "healthy" | "warning" | "critical";
  /** Exit code matching verdict (0/4/5). */
  exitCode: 0 | 4 | 5;
}

// ─── core ───────────────────────────────────────────────────────────────────

export interface RunTeamEventHealthCheckOpts {
  sessionId: string;
  /** ISO-8601 lower bound (lexicographic compare). Default = no lower bound. */
  since?: string;
  /** Override cwd (test hook). */
  cwd?: string;
  /** Override now() (test hook, ms). */
  now?: () => number;
  /** Override stale-lock threshold (test hook, ms). */
  staleLockMs?: number;
}

/**
 * Build the structured health report. The CLI wrapper handles formatting +
 * stderr emission; this function is the load-bearing observability logic.
 */
export function runTeamEventHealthCheck(
  opts: RunTeamEventHealthCheckOpts,
): TeamEventHealthReport | { invalid: true } {
  try {
    assertSafeSlug(opts.sessionId, "session-id");
  } catch {
    return { invalid: true };
  }

  const cwd = opts.cwd ?? process.cwd();
  const now = opts.now ?? Date.now;
  const staleLockMs = opts.staleLockMs ?? OUTBOX_STALE_LOCK_MS;

  const teamDir = join(cwd, ".omcp", "state", "team", opts.sessionId);
  const eventsPath = join(teamDir, "events.jsonl");

  // 1. POISON COUNT — read events.jsonl + count poison sentinels.
  const poisonResult = countPoisonSentinels(eventsPath, opts.since);

  // 2. ROTATION ANOMALIES — scan for .jsonl.N siblings.
  const rotationAnomalies = scanRotationAnomalies(teamDir);

  // 3. ORPHANED LOCKFILES — find *.lock older than staleLockMs.
  const orphanedLockfiles = scanOrphanedLockfiles(teamDir, now(), staleLockMs);

  // 4. DEAD-LETTER COUNT — count lines in dead-letter-push.jsonl.
  const deadLetterCount = countDeadLetterRecords(teamDir);

  // Verdict precedence: CRITICAL > WARNING > HEALTHY.
  let verdict: "healthy" | "warning" | "critical" = "healthy";
  if (orphanedLockfiles.length > 0 || rotationAnomalies.length > 0) {
    verdict = "critical";
  } else if (deadLetterCount > 0 || poisonResult.count > 0) {
    verdict = "warning";
  }

  const exitCode = verdict === "critical" ? 5 : verdict === "warning" ? 4 : 0;

  const report: TeamEventHealthReport = {
    sessionId: opts.sessionId,
    generatedAt: new Date(now()).toISOString(),
    eventsPathExists: existsSync(eventsPath),
    eventsPath,
    poisonCount: poisonResult.count,
    rotationAnomalies,
    orphanedLockfiles,
    deadLetterCount,
    verdict,
    exitCode,
  };
  if (opts.since !== undefined) {
    report.poisonSince = opts.since;
  }
  return report;
}

// ─── scanners ───────────────────────────────────────────────────────────────

function countPoisonSentinels(
  eventsPath: string,
  since: string | undefined,
): { count: number } {
  if (!existsSync(eventsPath)) return { count: 0 };
  let body: string;
  try {
    body = readFileSync(eventsPath, "utf8");
  } catch {
    return { count: 0 };
  }
  let count = 0;
  for (const raw of body.split("\n")) {
    if (raw.trim() === "") continue;
    let parsed: TeamEventRecord;
    try {
      parsed = JSON.parse(raw) as TeamEventRecord;
    } catch {
      // parse errors are NOT poison records — they're a different
      // failure mode that team-event-tail surfaces separately.
      continue;
    }
    if (parsed.kind !== TEAM_EVENT_POISON_KIND) continue;
    if (since !== undefined && typeof parsed.ts === "string" && parsed.ts < since) {
      continue;
    }
    count++;
  }
  return { count };
}

function scanRotationAnomalies(teamDir: string): RotationAnomaly[] {
  if (!existsSync(teamDir)) return [];
  const anomalies: RotationAnomaly[] = [];
  let entries: string[];
  try {
    entries = readdirSync(teamDir);
  } catch {
    return [];
  }
  // Group rotated siblings (events.jsonl.N) by base name. Multiple
  // streams may live in the same dir (events.jsonl, outbox.jsonl, etc.).
  const rotatedByBase = new Map<string, string[]>();
  for (const name of entries) {
    const m = /^(.+\.jsonl)\.(\d+)$/.exec(name);
    if (!m) continue;
    const base = m[1];
    if (!rotatedByBase.has(base)) rotatedByBase.set(base, []);
    rotatedByBase.get(base)!.push(name);
  }

  for (const [base, rotated] of rotatedByBase.entries()) {
    const basePath = join(teamDir, base);
    if (!existsSync(basePath)) {
      // Rotated sibling without a live stream — operator may have
      // deleted the live file by hand, or rotation completed but the
      // next append never came. Surface as anomaly.
      for (const r of rotated) {
        anomalies.push({
          kind: "orphaned-rotated-sibling",
          path: join(teamDir, r),
        });
      }
      continue;
    }
    // Live stream + rotated sibling both present — check live size.
    // If live is ALSO over the rotation threshold, rotation race happened.
    let sizeBytes = 0;
    try {
      sizeBytes = statSync(basePath).size;
    } catch {
      continue;
    }
    if (sizeBytes >= TEAM_EVENT_ROTATION_BYTES) {
      anomalies.push({
        kind: "live-over-threshold-with-sibling",
        path: basePath,
        sizeBytes,
      });
    }
  }
  return anomalies;
}

function scanOrphanedLockfiles(
  teamDir: string,
  nowMs: number,
  staleLockMs: number,
): OrphanedLockfile[] {
  if (!existsSync(teamDir)) return [];
  const orphans: OrphanedLockfile[] = [];
  let entries: string[];
  try {
    entries = readdirSync(teamDir);
  } catch {
    return [];
  }
  for (const name of entries) {
    if (!name.endsWith(".lock")) continue;
    const lockPath = join(teamDir, name);
    let mtimeMs = 0;
    try {
      mtimeMs = statSync(lockPath).mtimeMs;
    } catch {
      continue;
    }
    const ageMs = nowMs - mtimeMs;
    if (ageMs > staleLockMs) {
      orphans.push({ path: lockPath, ageMs });
    }
  }
  return orphans;
}

function countDeadLetterRecords(teamDir: string): number {
  const dlPath = join(teamDir, "dead-letter-push.jsonl");
  if (!existsSync(dlPath)) return 0;
  let body: string;
  try {
    body = readFileSync(dlPath, "utf8");
  } catch {
    return 0;
  }
  let count = 0;
  for (const raw of body.split("\n")) {
    if (raw.trim() === "") continue;
    count++;
  }
  return count;
}

// ─── CLI wrapper ────────────────────────────────────────────────────────────

export interface RunTeamEventHealthCheckCliOpts {
  cwd?: string;
  log?: (line: string) => void;
  errLog?: (line: string) => void;
  /** ISO-8601 lower bound for the poison-count scan. */
  since?: string;
  /** Emit JSON instead of human-readable summary. */
  json?: boolean;
}

/**
 * CLI wrapper: `omcp team-event-health-check <session-id> [--since ts] [--json]`.
 *
 * Exit codes:
 *   0 — healthy
 *   4 — warning (dead-letter / poison)
 *   5 — critical (orphaned lockfile / rotation anomaly)
 *   2 — invalid argv
 */
export function runTeamEventHealthCheckCli(
  sessionId: string,
  opts: RunTeamEventHealthCheckCliOpts = {},
): number {
  const log = opts.log ?? ((l: string) => console.log(l));
  const errLog = opts.errLog ?? ((l: string) => console.error(l));

  try {
    assertSafeSlug(sessionId, "session-id");
  } catch (err) {
    if (err instanceof UnsafeSlugError) {
      errLog(`omcp team-event-health-check: ${err.message}`);
    } else {
      errLog(`omcp team-event-health-check: invalid session-id`);
    }
    return 2;
  }

  const result = runTeamEventHealthCheck({
    sessionId,
    since: opts.since,
    cwd: opts.cwd,
  });
  if ("invalid" in result) {
    errLog(`omcp team-event-health-check: invalid session-id`);
    return 2;
  }

  if (opts.json) {
    log(JSON.stringify(result, null, 2));
    return result.exitCode;
  }

  log(`omcp team-event-health-check: session=${sessionId}`);
  log(`  generatedAt:        ${result.generatedAt}`);
  log(`  eventsPath:         ${result.eventsPath}`);
  log(`  eventsPathExists:   ${result.eventsPathExists}`);
  log(`  poisonCount:        ${result.poisonCount}`);
  if (result.poisonSince) {
    log(`  poisonSince:        ${result.poisonSince}`);
  }
  log(`  rotationAnomalies:  ${result.rotationAnomalies.length}`);
  for (const a of result.rotationAnomalies) {
    const sizePart =
      a.sizeBytes !== undefined ? ` size=${a.sizeBytes}B` : "";
    log(`    [${a.kind}] ${a.path}${sizePart}`);
  }
  log(`  orphanedLockfiles:  ${result.orphanedLockfiles.length}`);
  for (const o of result.orphanedLockfiles) {
    log(`    ${o.path} (age=${o.ageMs}ms)`);
  }
  log(`  deadLetterCount:    ${result.deadLetterCount}`);
  log(`  verdict:            ${result.verdict.toUpperCase()}`);
  if (result.verdict !== "healthy") {
    errLog(
      `omcp team-event-health-check: ${result.verdict} — exit ${result.exitCode}`,
    );
  }
  return result.exitCode;
}
