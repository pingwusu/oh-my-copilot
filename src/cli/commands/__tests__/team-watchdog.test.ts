// Tests for runTeamWatchdog (Phase L2.8).
// Uses the `now` injection hook so tests are deterministic (no real wall-clock).
// process.kill is spied on per-test to control pid-alive checks.

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  runTeamWatchdog,
} from "../team.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "omcp-watchdog-test-"));
}

/**
 * Create a minimal pidDir under <cwd>/.omcp/state/team/<sessionId>/ and
 * write worker-K.pid + optionally worker-K-shard.json with a controlled mtime.
 */
function seedWorker(opts: {
  cwd: string;
  sessionId: string;
  index: number;
  pid: number;
  shardMtimeMs?: number;
  pidMtimeMs?: number;
}): { pidDir: string; pidFile: string; shardFile: string | null } {
  const pidDir = path.join(
    opts.cwd,
    ".omcp",
    "state",
    "team",
    opts.sessionId,
  );
  fs.mkdirSync(pidDir, { recursive: true });

  const pidFile = path.join(pidDir, `worker-${opts.index}.pid`);
  fs.writeFileSync(pidFile, String(opts.pid), "utf8");

  // Adjust pidfile mtime if requested.
  if (opts.pidMtimeMs !== undefined) {
    const t = new Date(opts.pidMtimeMs);
    fs.utimesSync(pidFile, t, t);
  }

  let shardFile: string | null = null;
  if (opts.shardMtimeMs !== undefined) {
    shardFile = path.join(pidDir, `worker-${opts.index}-shard.json`);
    fs.writeFileSync(shardFile, JSON.stringify({ worker: opts.index }), "utf8");
    const t = new Date(opts.shardMtimeMs);
    fs.utimesSync(shardFile, t, t);
  }

  return { pidDir, pidFile, shardFile };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("runTeamWatchdog", () => {
  let cwd: string;
  let killSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    cwd = tempDir();
    // Default: all pids alive (process.kill(pid, 0) succeeds without throwing).
    killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
  });

  afterEach(() => {
    killSpy.mockRestore();
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  // AC2.8-1: Worker within timeout — no warning, no marker.
  it("does not flag a worker whose shard mtime is within timeout", () => {
    const now = 1_000_000;
    const timeoutMs = 600_000;
    const shardMtimeMs = now - 100_000; // well within timeout

    seedWorker({
      cwd,
      sessionId: "sess-ok",
      index: 0,
      pid: 12345,
      shardMtimeMs,
    });

    const report = runTeamWatchdog({
      sessionId: "sess-ok",
      timeoutMs,
      now: () => now,
      silent: true,
      cwd,
    });

    expect(report.workers).toHaveLength(1);
    const w = report.workers[0];
    expect(w.stuck).toBe(false);
    expect(w.dead).toBe(false);
    expect(w.markerWritten).toBe(false);
    expect(report.logLines).toHaveLength(0);

    // No marker file on disk.
    const markerFile = path.join(
      cwd,
      ".omcp",
      "state",
      "team",
      "sess-ok",
      "worker-0-reassign-needed.json",
    );
    expect(fs.existsSync(markerFile)).toBe(false);
  });

  // AC2.8-2: Worker over timeout — warning + marker file written.
  it("flags a stuck worker and writes reassign marker when shard mtime exceeds timeout", () => {
    const now = 1_000_000;
    const timeoutMs = 600_000;
    const shardMtimeMs = now - 700_000; // older than timeout

    seedWorker({
      cwd,
      sessionId: "sess-stuck",
      index: 1,
      pid: 99999,
      shardMtimeMs,
    });

    const report = runTeamWatchdog({
      sessionId: "sess-stuck",
      timeoutMs,
      now: () => now,
      silent: true,
      cwd,
    });

    expect(report.workers).toHaveLength(1);
    const w = report.workers[0];
    expect(w.stuck).toBe(true);
    expect(w.dead).toBe(false);
    expect(w.markerWritten).toBe(true);
    expect(report.logLines).toHaveLength(1);
    expect(report.logLines[0]).toContain("worker-1");
    expect(report.logLines[0]).toContain("reassign needed");

    // Marker file must exist and have correct JSON shape.
    const markerFile = path.join(
      cwd,
      ".omcp",
      "state",
      "team",
      "sess-stuck",
      "worker-1-reassign-needed.json",
    );
    expect(fs.existsSync(markerFile)).toBe(true);
    const marker = JSON.parse(fs.readFileSync(markerFile, "utf8")) as {
      worker: number;
      pid: number;
      detected_at: string;
      shard_mtime_ms: number;
      timeout_ms: number;
    };
    expect(marker.worker).toBe(1);
    expect(marker.pid).toBe(99999);
    expect(typeof marker.detected_at).toBe("string");
    expect(marker.shard_mtime_ms).toBe(shardMtimeMs);
    expect(marker.timeout_ms).toBe(timeoutMs);
  });

  // AC2.8-3: Dead worker — skipped silently, no marker.
  it("skips a dead worker (pid not alive) without emitting a warning or marker", () => {
    const now = 1_000_000;
    const timeoutMs = 600_000;
    const shardMtimeMs = now - 700_000; // would be stuck if alive

    seedWorker({
      cwd,
      sessionId: "sess-dead",
      index: 2,
      pid: 77777,
      shardMtimeMs,
    });

    // Mock process.kill to throw ESRCH (pid not found).
    killSpy.mockImplementation(() => {
      const err = new Error("kill ESRCH") as NodeJS.ErrnoException;
      err.code = "ESRCH";
      throw err;
    });

    const report = runTeamWatchdog({
      sessionId: "sess-dead",
      timeoutMs,
      now: () => now,
      silent: true,
      cwd,
    });

    expect(report.workers).toHaveLength(1);
    const w = report.workers[0];
    expect(w.dead).toBe(true);
    expect(w.stuck).toBe(false);
    expect(w.markerWritten).toBe(false);
    expect(report.logLines).toHaveLength(0);

    // No marker file on disk.
    const markerFile = path.join(
      cwd,
      ".omcp",
      "state",
      "team",
      "sess-dead",
      "worker-2-reassign-needed.json",
    );
    expect(fs.existsSync(markerFile)).toBe(false);
  });

  // Edge case: session directory does not exist — returns empty workers.
  it("returns empty workers when session pidDir does not exist", () => {
    const report = runTeamWatchdog({
      sessionId: "no-such-session",
      timeoutMs: 600_000,
      now: () => 1_000_000,
      silent: true,
      cwd,
    });

    expect(report.workers).toHaveLength(0);
    expect(report.logLines).toHaveLength(0);
  });
});
