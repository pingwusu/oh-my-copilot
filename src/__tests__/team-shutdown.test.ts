// Tests for Phase L2.7 — shutdown_request / shutdown_response protocol.

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { shutdownTeam } from "../cli/commands/team.js";

describe("shutdownTeam — shutdown_request / shutdown_response protocol (Phase L2.7)", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "omcp-team-shutdown-"));
    vi.spyOn(process, "cwd").mockReturnValue(tmp);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(tmp, { recursive: true, force: true });
  });

  it("writes shutdown-request.json before waiting for acks", () => {
    const sessionId = "shutdown-test-req";
    const pidDir = join(tmp, ".omcp", "state", "team", sessionId);
    mkdirSync(pidDir, { recursive: true });

    let ticks = 0;
    // Fake now() that advances 1s per call so we hit deadline immediately.
    const start = Date.now();
    const now = () => start + ticks++ * 60000;
    const sleep = (_ms: number) => { /* no-op */ };

    shutdownTeam(sessionId, {
      killProcess: () => { /* no-op */ },
      timeoutMs: 1,
      now,
      sleep,
    });

    const reqFile = join(pidDir, "shutdown-request.json");
    expect(existsSync(reqFile)).toBe(true);
    const raw = readFileSync(reqFile, "utf8");
    const parsed = JSON.parse(raw) as { requested_at: string; sessionId: string };
    expect(parsed.sessionId).toBe(sessionId);
    expect(typeof parsed.requested_at).toBe("string");
  });

  it("normal shutdown: worker writes ack within timeout — acked, not timedOut", () => {
    const sessionId = "shutdown-test-ack";
    const pidDir = join(tmp, ".omcp", "state", "team", sessionId);
    mkdirSync(pidDir, { recursive: true });

    // Write a pidfile so shutdownTeam knows worker-1 exists.
    writeFileSync(join(pidDir, "worker-1.pid"), "9999");

    let callCount = 0;
    const start = Date.now();

    // Simulate: on first call now() returns start (deadline not hit);
    // on second call the ack file gets written (via the sleep hook),
    // then existsSync finds it.
    const sleep = (_ms: number) => {
      // Worker "writes" ack after first sleep tick.
      writeFileSync(
        join(pidDir, "worker-1-ack.json"),
        JSON.stringify({ worker: 1, shutdown_response: "ok" }),
        "utf8",
      );
    };
    const now = () => {
      callCount++;
      // Keep advancing time slowly — deadline is 30s away.
      return start + callCount * 10;
    };

    const report = shutdownTeam(sessionId, {
      killProcess: (_pid) => { /* no-op — worker acked, stopTeam still runs */ },
      timeoutMs: 30000,
      now,
      sleep,
    });

    expect(report.acked).toContain(1);
    expect(report.timedOut).not.toContain(1);
  });

  it("timeout: no ack written — worker falls through to SIGTERM via stopTeam", () => {
    const sessionId = "shutdown-test-timeout";
    const pidDir = join(tmp, ".omcp", "state", "team", sessionId);
    mkdirSync(pidDir, { recursive: true });

    // Write two pidfiles — neither will ack.
    writeFileSync(join(pidDir, "worker-1.pid"), "7771");
    writeFileSync(join(pidDir, "worker-2.pid"), "7772");

    const killed: number[] = [];
    let tick = 0;
    const start = 0;
    // now() immediately jumps past deadline after one call.
    const now = () => {
      tick++;
      return tick === 1 ? start : start + 999999;
    };
    const sleep = (_ms: number) => { /* no-op */ };

    const report = shutdownTeam(sessionId, {
      killProcess: (pid) => killed.push(pid),
      timeoutMs: 1,
      now,
      sleep,
    });

    // Both workers timed out.
    expect(report.timedOut).toEqual(expect.arrayContaining([1, 2]));
    expect(report.acked).toHaveLength(0);
    // stopTeam fallback fired — killed both workers.
    expect(killed.sort((a, b) => a - b)).toEqual([7771, 7772]);
  });

  it("already-stopped worker (pidfile missing) — shutdownTeam just continues, no error thrown", () => {
    const sessionId = "shutdown-test-no-pid";
    // No pidDir at all — worker never started or already cleaned up.

    expect(() => {
      shutdownTeam(sessionId, {
        killProcess: () => { throw new Error("should not be called"); },
        timeoutMs: 1,
        now: () => Date.now() + 999999,
        sleep: (_ms) => { /* no-op */ },
      });
    }).not.toThrow();
  });
});
