/**
 * Story 7 / US-EB06-HEARTBEAT — heartbeat write + watchdog integration tests.
 *
 * Covers ADR-omcp-eb-05:
 *   §1: schema {ts, workerIndex, pid} written via atomicWriteFileSync
 *   §2: freshness threshold default 30s × 3 = 90s with env overrides
 *   §3: watchdog precedence — heartbeat wins; shard-mtime fallback
 *   §4: heartbeat-absent observability warning at 2× interval
 *   §5: NTFS mtime quantum simulation — JSON-ts primary side-steps the race
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  HEARTBEAT_ABSENT_WARNING_MULTIPLIER,
  HEARTBEAT_FRESHNESS_MULTIPLIER_DEFAULT,
  HEARTBEAT_INTERVAL_S_DEFAULT,
  heartbeatFilePath,
  resolveHeartbeatFreshnessMs,
  resolveHeartbeatIntervalMs,
  runTeamHeartbeat,
  runTeamHeartbeatCli,
} from "../cli/commands/team-heartbeat.js";
import { runTeamWatchdog } from "../cli/commands/team.js";

const SESSION_ID = "heartbeat-test-sid";

let tmp: string;
let cwdSnapshot: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "omcp-heartbeat-test-"));
  cwdSnapshot = process.cwd();
  process.chdir(tmp);
});
afterEach(() => {
  process.chdir(cwdSnapshot);
  fs.rmSync(tmp, { recursive: true, force: true });
});

function pidDir(): string {
  return path.join(tmp, ".omcp", "state", "team", SESSION_ID);
}

function writePidFile(idx: number, pid: number): void {
  fs.mkdirSync(pidDir(), { recursive: true });
  fs.writeFileSync(path.join(pidDir(), `worker-${idx}.pid`), String(pid), "utf8");
}

// ─── ADR pinned constants ─────────────────────────────────────────────────────

describe("ADR-EB-05 pinned constants", () => {
  it("default interval = 30s", () => {
    expect(HEARTBEAT_INTERVAL_S_DEFAULT).toBe(30);
  });

  it("default multiplier = 3", () => {
    expect(HEARTBEAT_FRESHNESS_MULTIPLIER_DEFAULT).toBe(3);
  });

  it("absent-warning multiplier = 2", () => {
    expect(HEARTBEAT_ABSENT_WARNING_MULTIPLIER).toBe(2);
  });
});

// ─── env > opts > default precedence ─────────────────────────────────────────

describe("resolveHeartbeatFreshnessMs — env > opts > default", () => {
  it("default = 30s × 3 = 90_000ms", () => {
    expect(resolveHeartbeatFreshnessMs({}, {})).toBe(90_000);
  });

  it("opts overrides default", () => {
    expect(resolveHeartbeatFreshnessMs({ intervalS: 10, multiplier: 5 }, {})).toBe(
      50_000,
    );
  });

  it("env overrides opts", () => {
    const env = {
      OMCP_HEARTBEAT_INTERVAL_S: "5",
      OMCP_HEARTBEAT_FRESHNESS_MULTIPLIER: "10",
    };
    expect(resolveHeartbeatFreshnessMs({ intervalS: 100, multiplier: 100 }, env)).toBe(
      50_000,
    );
  });

  it("ignores non-positive env values", () => {
    const env = { OMCP_HEARTBEAT_INTERVAL_S: "0" };
    expect(resolveHeartbeatFreshnessMs({}, env)).toBe(90_000);
  });

  it("ignores non-positive multiplier env values", () => {
    const env = { OMCP_HEARTBEAT_FRESHNESS_MULTIPLIER: "-1" };
    expect(resolveHeartbeatFreshnessMs({}, env)).toBe(90_000);
  });
});

describe("resolveHeartbeatIntervalMs", () => {
  it("default = 30_000ms", () => {
    expect(resolveHeartbeatIntervalMs({}, {})).toBe(30_000);
  });

  it("env overrides", () => {
    expect(resolveHeartbeatIntervalMs({}, { OMCP_HEARTBEAT_INTERVAL_S: "5" })).toBe(
      5_000,
    );
  });
});

// ─── heartbeat write ─────────────────────────────────────────────────────────

describe("runTeamHeartbeat — schema + write semantics", () => {
  it("writes {ts, workerIndex, pid} schema via atomicWriteFileSync", () => {
    const fixedTs = "2026-05-25T12:34:56.789Z";
    const result = runTeamHeartbeat({
      sessionId: SESSION_ID,
      workerIndex: 3,
      cwd: tmp,
      now: () => fixedTs,
      pid: 99999,
    });
    expect(result.exitCode).toBe(0);
    expect(result.ts).toBe(fixedTs);
    const parsed = JSON.parse(
      fs.readFileSync(heartbeatFilePath(pidDir(), 3), "utf8"),
    ) as { ts: string; workerIndex: number; pid: number };
    expect(parsed).toEqual({ ts: fixedTs, workerIndex: 3, pid: 99999 });
  });

  it("repeated writes overwrite via atomicWriteFileSync (no torn JSON)", () => {
    for (let i = 0; i < 10; i++) {
      runTeamHeartbeat({
        sessionId: SESSION_ID,
        workerIndex: 1,
        cwd: tmp,
        now: () => `2026-05-25T00:00:${String(i).padStart(2, "0")}.000Z`,
        pid: 100 + i,
      });
    }
    const parsed = JSON.parse(
      fs.readFileSync(heartbeatFilePath(pidDir(), 1), "utf8"),
    ) as { ts: string; pid: number };
    expect(parsed.ts).toBe("2026-05-25T00:00:09.000Z");
    expect(parsed.pid).toBe(109);
  });

  it("creates pidDir if absent", () => {
    runTeamHeartbeat({
      sessionId: SESSION_ID,
      workerIndex: 1,
      cwd: tmp,
      now: () => "2026-05-25T00:00:00.000Z",
      pid: 1,
    });
    expect(fs.existsSync(pidDir())).toBe(true);
  });
});

// ─── argv validation ──────────────────────────────────────────────────────────

describe("runTeamHeartbeat — argv validation", () => {
  it("exit 2 on path-traversal sessionId", () => {
    const result = runTeamHeartbeat({
      sessionId: "../escape",
      workerIndex: 1,
      cwd: tmp,
      now: () => "2026-05-25T00:00:00.000Z",
      pid: 1,
    });
    expect(result.exitCode).toBe(2);
  });

  it("exit 2 on negative workerIndex", () => {
    const result = runTeamHeartbeat({
      sessionId: SESSION_ID,
      workerIndex: -1,
      cwd: tmp,
      now: () => "2026-05-25T00:00:00.000Z",
      pid: 1,
    });
    expect(result.exitCode).toBe(2);
  });

  it("exit 2 on non-integer workerIndex", () => {
    const result = runTeamHeartbeat({
      sessionId: SESSION_ID,
      workerIndex: 1.5,
      cwd: tmp,
      now: () => "2026-05-25T00:00:00.000Z",
      pid: 1,
    });
    expect(result.exitCode).toBe(2);
  });
});

// ─── watchdog integration: heartbeat-primary path ────────────────────────────

describe("runTeamWatchdog — heartbeat-primary path (ADR §3)", () => {
  it("fresh heartbeat (<= 90s old) → not stuck", () => {
    writePidFile(1, process.pid);
    runTeamHeartbeat({
      sessionId: SESSION_ID,
      workerIndex: 1,
      cwd: tmp,
      // Heartbeat ts very recent.
      now: () => new Date().toISOString(),
      pid: process.pid,
    });
    const report = runTeamWatchdog({
      sessionId: SESSION_ID,
      cwd: tmp,
      silent: true,
    });
    const worker = report.workers.find((w) => w.index === 1);
    expect(worker?.stuck).toBe(false);
  });

  it("stale heartbeat (>90s old) → stuck", () => {
    writePidFile(1, process.pid);
    const oldTs = new Date(Date.now() - 200_000).toISOString();
    runTeamHeartbeat({
      sessionId: SESSION_ID,
      workerIndex: 1,
      cwd: tmp,
      now: () => oldTs,
      pid: process.pid,
    });
    const report = runTeamWatchdog({
      sessionId: SESSION_ID,
      cwd: tmp,
      silent: true,
    });
    const worker = report.workers.find((w) => w.index === 1);
    expect(worker?.stuck).toBe(true);
    expect(worker?.markerWritten).toBe(true);
  });

  it("heartbeat wins over shard-mtime when both signals present", () => {
    writePidFile(1, process.pid);
    // Shard mtime is fresh but heartbeat is stale → watchdog must use heartbeat.
    const shardPath = path.join(pidDir(), "worker-1-shard.json");
    fs.writeFileSync(shardPath, JSON.stringify({ ok: true }));
    const oldTs = new Date(Date.now() - 200_000).toISOString();
    runTeamHeartbeat({
      sessionId: SESSION_ID,
      workerIndex: 1,
      cwd: tmp,
      now: () => oldTs,
      pid: process.pid,
    });
    const report = runTeamWatchdog({
      sessionId: SESSION_ID,
      cwd: tmp,
      silent: true,
    });
    expect(report.workers.find((w) => w.index === 1)?.stuck).toBe(true);
  });
});

// ─── watchdog: fallback path (heartbeat absent) ───────────────────────────────

describe("runTeamWatchdog — shard-mtime fallback path (ADR §3 + §4)", () => {
  it("absent heartbeat → falls back to shard-mtime check (back-compat)", () => {
    writePidFile(1, process.pid);
    const shardPath = path.join(pidDir(), "worker-1-shard.json");
    fs.writeFileSync(shardPath, JSON.stringify({ ok: true }));
    // No heartbeat written → falls back to shard-mtime.
    const report = runTeamWatchdog({
      sessionId: SESSION_ID,
      cwd: tmp,
      // timeoutMs default 600_000; shard just written; not stuck.
      silent: true,
    });
    expect(report.workers.find((w) => w.index === 1)?.stuck).toBe(false);
  });

  it("heartbeat-absent observability: emits warning when worker pidfile age > 2× interval", () => {
    writePidFile(1, process.pid);
    const shardPath = path.join(pidDir(), "worker-1-shard.json");
    fs.writeFileSync(shardPath, "{}");
    // Backdate the pidfile mtime by 90s (>= 2× 30s interval).
    const ninetySecondsAgo = new Date(Date.now() - 90_000);
    fs.utimesSync(
      path.join(pidDir(), "worker-1.pid"),
      ninetySecondsAgo,
      ninetySecondsAgo,
    );

    const report = runTeamWatchdog({
      sessionId: SESSION_ID,
      cwd: tmp,
      silent: true,
    });
    expect(
      report.logLines.some((l) =>
        l.includes("not heartbeating") && l.includes("worker-1"),
      ),
    ).toBe(true);
  });

  it("no warning when pidfile is fresh (< 2× interval)", () => {
    writePidFile(1, process.pid);
    fs.writeFileSync(path.join(pidDir(), "worker-1-shard.json"), "{}");
    const report = runTeamWatchdog({
      sessionId: SESSION_ID,
      cwd: tmp,
      silent: true,
    });
    expect(report.logLines.some((l) => l.includes("not heartbeating"))).toBe(false);
  });

  it("corrupt heartbeat.json → falls back to shard-mtime + warning logged", () => {
    writePidFile(1, process.pid);
    fs.writeFileSync(path.join(pidDir(), "worker-1-shard.json"), "{}");
    fs.writeFileSync(
      path.join(pidDir(), "worker-1-heartbeat.json"),
      "{not valid",
      "utf8",
    );
    const report = runTeamWatchdog({
      sessionId: SESSION_ID,
      cwd: tmp,
      silent: true,
    });
    expect(
      report.logLines.some((l) =>
        l.includes("heartbeat.json present but unparseable"),
      ),
    ).toBe(true);
  });
});

// ─── NTFS quantum simulation ──────────────────────────────────────────────────

describe("ADR §5 NTFS quantum: JSON-ts side-steps mtime race", () => {
  it("two heartbeat writes 5ms apart both observable via ts field", () => {
    writePidFile(1, process.pid);
    const ts1 = "2026-05-25T00:00:00.000Z";
    runTeamHeartbeat({
      sessionId: SESSION_ID,
      workerIndex: 1,
      cwd: tmp,
      now: () => ts1,
      pid: process.pid,
    });
    let first = JSON.parse(
      fs.readFileSync(heartbeatFilePath(pidDir(), 1), "utf8"),
    ) as { ts: string };
    expect(first.ts).toBe(ts1);

    const ts2 = "2026-05-25T00:00:00.005Z";
    runTeamHeartbeat({
      sessionId: SESSION_ID,
      workerIndex: 1,
      cwd: tmp,
      now: () => ts2,
      pid: process.pid,
    });
    let second = JSON.parse(
      fs.readFileSync(heartbeatFilePath(pidDir(), 1), "utf8"),
    ) as { ts: string };
    expect(second.ts).toBe(ts2);
    // Both timestamps preserved EVEN if NTFS mtime collapses them.
    expect(first.ts).not.toBe(second.ts);
  });
});

// ─── CLI wrapper ──────────────────────────────────────────────────────────────

describe("runTeamHeartbeatCli", () => {
  it("returns 0 on valid argv + writes heartbeat.json", () => {
    const out: string[] = [];
    const code = runTeamHeartbeatCli(SESSION_ID, "2", {
      cwd: tmp,
      log: (l) => out.push(l),
      errLog: () => {},
    });
    expect(code).toBe(0);
    expect(out.some((l) => l.includes("wrote"))).toBe(true);
    expect(fs.existsSync(heartbeatFilePath(pidDir(), 2))).toBe(true);
  });

  it("returns 2 on invalid sessionId", () => {
    const err: string[] = [];
    const code = runTeamHeartbeatCli("../escape", "1", {
      cwd: tmp,
      log: () => {},
      errLog: (l) => err.push(l),
    });
    expect(code).toBe(2);
    expect(err.join("\n")).toMatch(/unsafe/);
  });

  it("returns 2 on non-integer workerIndex", () => {
    const err: string[] = [];
    const code = runTeamHeartbeatCli(SESSION_ID, "abc", {
      cwd: tmp,
      log: () => {},
      errLog: (l) => err.push(l),
    });
    expect(code).toBe(2);
    expect(err.join("\n")).toMatch(/non-negative integer/);
  });
});
