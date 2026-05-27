/**
 * RG-05 / O1 tests: team-event-health-check verb.
 *
 * Covers:
 *   - healthy: no poison, no rotation anomaly, no orphaned lockfile,
 *     no dead-letter → exit 0
 *   - warning: non-empty dead-letter-push.jsonl → exit 4
 *   - warning: poison-record-detected sentinel present → exit 4
 *   - critical: orphaned lockfile (older than staleLockMs) → exit 5
 *   - critical: rotation anomaly (orphaned .jsonl.N sibling) → exit 5
 *   - critical: live events.jsonl over threshold WITH sibling → exit 5
 *   - precedence: CRITICAL > WARNING when both conditions present
 *   - --since filter restricts poison count
 *   - invalid slug → exit 2
 *   - CLI JSON mode emits structured report
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  appendFileSync,
  closeSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  runTeamEventHealthCheck,
  runTeamEventHealthCheckCli,
  type TeamEventHealthReport,
} from "../cli/commands/team-event-health-check.js";
import {
  TEAM_EVENT_POISON_KIND,
  TEAM_EVENT_ROTATION_BYTES,
} from "../cli/commands/team-event.js";
import {
  OUTBOX_STALE_LOCK_MS,
  PRODUCER_FORK_ID,
} from "../cli/commands/team-outbox.js";

const SID = "rg05-health-test";

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "omcp-rg05-health-"));
  mkdirSync(join(tmp, ".omcp", "state", "team", SID), { recursive: true });
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function teamDir(): string {
  return join(tmp, ".omcp", "state", "team", SID);
}

function writeEvent(kind: string, ts: string, extras: Record<string, unknown> = {}): void {
  const record = {
    ts,
    verb: extras.verb ?? "team-event-append",
    actor: extras.actor ?? "test",
    producer_fork: PRODUCER_FORK_ID,
    kind,
    ...extras,
  };
  const eventsPath = join(teamDir(), "events.jsonl");
  const line = `${JSON.stringify(record)}\n`;
  appendFileSync(eventsPath, line, { encoding: "utf8" });
}

function writeDeadLetter(n: number): void {
  const dlPath = join(teamDir(), "dead-letter-push.jsonl");
  for (let i = 0; i < n; i++) {
    const record = {
      ts: `2026-05-26T10:00:0${i % 10}.000Z`,
      worker_index: i + 1,
      prompt: `dead-letter-${i}`,
      producer_fork: PRODUCER_FORK_ID,
      priority: "push",
    };
    appendFileSync(dlPath, `${JSON.stringify(record)}\n`, { encoding: "utf8" });
  }
}

function expectReport(r: ReturnType<typeof runTeamEventHealthCheck>): TeamEventHealthReport {
  if ("invalid" in r) throw new Error("expected report, got invalid");
  return r;
}

describe("runTeamEventHealthCheck — healthy path", () => {
  it("exits 0 when session dir has no events.jsonl yet", () => {
    const r = expectReport(runTeamEventHealthCheck({ sessionId: SID, cwd: tmp }));
    expect(r.verdict).toBe("healthy");
    expect(r.exitCode).toBe(0);
    expect(r.eventsPathExists).toBe(false);
    expect(r.poisonCount).toBe(0);
    expect(r.deadLetterCount).toBe(0);
    expect(r.rotationAnomalies.length).toBe(0);
    expect(r.orphanedLockfiles.length).toBe(0);
  });

  it("exits 0 with clean events.jsonl + no anomalies", () => {
    writeEvent("entry", "2026-05-26T10:00:00.000Z");
    writeEvent("exit", "2026-05-26T10:00:01.000Z");
    const r = expectReport(runTeamEventHealthCheck({ sessionId: SID, cwd: tmp }));
    expect(r.verdict).toBe("healthy");
    expect(r.exitCode).toBe(0);
    expect(r.eventsPathExists).toBe(true);
    expect(r.poisonCount).toBe(0);
  });
});

describe("runTeamEventHealthCheck — warning paths", () => {
  it("exit 4 when dead-letter-push.jsonl is non-empty", () => {
    writeDeadLetter(3);
    const r = expectReport(runTeamEventHealthCheck({ sessionId: SID, cwd: tmp }));
    expect(r.verdict).toBe("warning");
    expect(r.exitCode).toBe(4);
    expect(r.deadLetterCount).toBe(3);
  });

  it("exit 4 when a poison-record-detected sentinel is present", () => {
    writeEvent("entry", "2026-05-26T10:00:00.000Z");
    writeEvent(TEAM_EVENT_POISON_KIND, "2026-05-26T10:00:01.000Z");
    writeEvent(TEAM_EVENT_POISON_KIND, "2026-05-26T10:00:02.000Z");
    const r = expectReport(runTeamEventHealthCheck({ sessionId: SID, cwd: tmp }));
    expect(r.verdict).toBe("warning");
    expect(r.exitCode).toBe(4);
    expect(r.poisonCount).toBe(2);
  });

  it("--since filter restricts poison count window", () => {
    writeEvent(TEAM_EVENT_POISON_KIND, "2026-05-25T10:00:00.000Z");
    writeEvent(TEAM_EVENT_POISON_KIND, "2026-05-26T10:00:00.000Z");
    const r = expectReport(
      runTeamEventHealthCheck({
        sessionId: SID,
        cwd: tmp,
        since: "2026-05-26T00:00:00.000Z",
      }),
    );
    expect(r.poisonCount).toBe(1);
    expect(r.poisonSince).toBe("2026-05-26T00:00:00.000Z");
    expect(r.exitCode).toBe(4);
  });
});

describe("runTeamEventHealthCheck — critical paths", () => {
  it("exit 5 when an orphaned lockfile is older than staleLockMs", () => {
    // Create a lockfile + backdate its mtime so it qualifies as stale.
    const lockPath = join(teamDir(), "events.jsonl.lock");
    const fd = openSync(lockPath, "w");
    closeSync(fd);
    const ancient = new Date(Date.now() - (OUTBOX_STALE_LOCK_MS + 5_000));
    utimesSync(lockPath, ancient, ancient);

    const r = expectReport(runTeamEventHealthCheck({ sessionId: SID, cwd: tmp }));
    expect(r.verdict).toBe("critical");
    expect(r.exitCode).toBe(5);
    expect(r.orphanedLockfiles.length).toBe(1);
    expect(r.orphanedLockfiles[0].path).toContain("events.jsonl.lock");
  });

  it("exit 5 when a rotated .jsonl.N sibling exists without a live .jsonl", () => {
    // Write only the rotated sibling — no live stream.
    writeFileSync(
      join(teamDir(), "events.jsonl.1"),
      '{"ts":"2026-05-26T10:00:00.000Z","verb":"x","actor":"a","kind":"entry","producer_fork":"omcp-r2"}\n',
      "utf8",
    );
    const r = expectReport(runTeamEventHealthCheck({ sessionId: SID, cwd: tmp }));
    expect(r.verdict).toBe("critical");
    expect(r.exitCode).toBe(5);
    expect(r.rotationAnomalies.length).toBe(1);
    expect(r.rotationAnomalies[0].kind).toBe("orphaned-rotated-sibling");
  });

  it("exit 5 when live events.jsonl is over threshold AND sibling exists", () => {
    // Write a sibling.
    writeFileSync(join(teamDir(), "events.jsonl.1"), "sibling\n", "utf8");
    // Write a live events.jsonl > 1 MiB.
    const big = "x".repeat(TEAM_EVENT_ROTATION_BYTES + 100);
    writeFileSync(join(teamDir(), "events.jsonl"), big, "utf8");
    const r = expectReport(runTeamEventHealthCheck({ sessionId: SID, cwd: tmp }));
    expect(r.verdict).toBe("critical");
    expect(r.exitCode).toBe(5);
    const anom = r.rotationAnomalies.find(
      (a) => a.kind === "live-over-threshold-with-sibling",
    );
    expect(anom).toBeDefined();
    expect(anom!.sizeBytes).toBeGreaterThanOrEqual(TEAM_EVENT_ROTATION_BYTES);
  });

  it("CRITICAL > WARNING precedence: orphan-lock + dead-letter → exit 5", () => {
    // Both conditions present — critical wins.
    writeDeadLetter(2);
    const lockPath = join(teamDir(), "outbox.jsonl.lock");
    const fd = openSync(lockPath, "w");
    closeSync(fd);
    const ancient = new Date(Date.now() - (OUTBOX_STALE_LOCK_MS + 1_000));
    utimesSync(lockPath, ancient, ancient);

    const r = expectReport(runTeamEventHealthCheck({ sessionId: SID, cwd: tmp }));
    expect(r.verdict).toBe("critical");
    expect(r.exitCode).toBe(5);
    expect(r.deadLetterCount).toBe(2);
    expect(r.orphanedLockfiles.length).toBe(1);
  });
});

describe("runTeamEventHealthCheck — invalid argv", () => {
  it("rejects unsafe slug", () => {
    const r = runTeamEventHealthCheck({ sessionId: "../escape", cwd: tmp });
    expect("invalid" in r).toBe(true);
  });

  it("ignores fresh lockfile (recently-created lockfile is healthy contention)", () => {
    // Lockfile with current mtime — NOT orphaned.
    const lockPath = join(teamDir(), "events.jsonl.lock");
    const fd = openSync(lockPath, "w");
    closeSync(fd);
    const r = expectReport(runTeamEventHealthCheck({ sessionId: SID, cwd: tmp }));
    expect(r.orphanedLockfiles.length).toBe(0);
    expect(r.verdict).toBe("healthy");
  });
});

describe("runTeamEventHealthCheckCli", () => {
  it("emits structured JSON when --json is set + returns correct exit code", () => {
    writeDeadLetter(1);
    const logged: string[] = [];
    const exit = runTeamEventHealthCheckCli(SID, {
      cwd: tmp,
      json: true,
      log: (l) => logged.push(l),
      errLog: () => {
        /* swallow */
      },
    });
    expect(exit).toBe(4);
    const joined = logged.join("\n");
    const parsed = JSON.parse(joined) as TeamEventHealthReport;
    expect(parsed.sessionId).toBe(SID);
    expect(parsed.verdict).toBe("warning");
    expect(parsed.deadLetterCount).toBe(1);
  });

  it("rejects invalid slug + returns exit 2", () => {
    const errs: string[] = [];
    const exit = runTeamEventHealthCheckCli("../escape", {
      cwd: tmp,
      log: () => {
        /* swallow */
      },
      errLog: (l) => errs.push(l),
    });
    expect(exit).toBe(2);
    expect(errs.some((l) => l.includes("team-event-health-check"))).toBe(true);
  });

  it("emits human-readable summary by default", () => {
    const logs: string[] = [];
    const exit = runTeamEventHealthCheckCli(SID, {
      cwd: tmp,
      log: (l) => logs.push(l),
      errLog: () => {
        /* swallow */
      },
    });
    expect(exit).toBe(0);
    const joined = logs.join("\n");
    expect(joined).toContain(`session=${SID}`);
    expect(joined).toContain("verdict:");
    expect(joined.toUpperCase()).toContain("HEALTHY");
  });
});
