/**
 * Unit tests for Story 13 / US-omcp-parity-P3-TEAM-WAIT-cli.
 *
 * Pure-poll tests with injected sleep/now/readTeamState — no real timers,
 * no real filesystem. Covers all 4 exit codes (0 completed, 1 failed,
 * 2 timeout, 3 session-not-found) + precedence chain for the timeout
 * resolver (env > opts > default).
 */

import { describe, expect, it } from "vitest";

import {
  resolveTeamWaitTimeoutMs,
  runTeamWait,
  TEAM_WAIT_DEFAULT_TIMEOUT_MS,
} from "../cli/commands/team-wait.js";
import type { TeamState } from "../runtime/mode-state.js";

function makeTeamState(
  phase: TeamState["current_phase"],
  overrides: Partial<TeamState> = {},
): TeamState {
  return {
    active: true,
    session_id: "test-session",
    started_at: "2026-05-25T00:00:00.000Z",
    spawned: 2,
    done: 0,
    workers: [],
    current_phase: phase,
    stage_history: ["initializing", "executing"],
    ...overrides,
  };
}

/**
 * Build a stub readTeamState that returns the i-th element of `phases`
 * on the i-th call. The last element is repeated for subsequent calls.
 */
function makeReadStub(
  phases: Array<TeamState["current_phase"] | "missing">,
): { fn: (sid: string) => TeamState | null; callCount: () => number } {
  let i = 0;
  return {
    fn: (_sid: string) => {
      const phase = phases[Math.min(i, phases.length - 1)];
      i++;
      if (phase === "missing") return null;
      return makeTeamState(phase);
    },
    callCount: () => i,
  };
}

describe("resolveTeamWaitTimeoutMs — precedence chain", () => {
  it("default when neither env nor opts set", () => {
    expect(resolveTeamWaitTimeoutMs(undefined, {})).toBe(
      TEAM_WAIT_DEFAULT_TIMEOUT_MS,
    );
  });

  it("opts value wins over default", () => {
    expect(resolveTeamWaitTimeoutMs(500_000, {})).toBe(500_000);
  });

  it("env (seconds) wins over opts (ms)", () => {
    expect(
      resolveTeamWaitTimeoutMs(500_000, { OMCP_TEAM_WAIT_TIMEOUT_S: "120" }),
    ).toBe(120_000);
  });

  it("ignores non-positive env values and falls back to opts", () => {
    expect(
      resolveTeamWaitTimeoutMs(60_000, { OMCP_TEAM_WAIT_TIMEOUT_S: "0" }),
    ).toBe(60_000);
    expect(
      resolveTeamWaitTimeoutMs(60_000, { OMCP_TEAM_WAIT_TIMEOUT_S: "-1" }),
    ).toBe(60_000);
    expect(
      resolveTeamWaitTimeoutMs(60_000, { OMCP_TEAM_WAIT_TIMEOUT_S: "not" }),
    ).toBe(60_000);
  });

  it("empty-string env falls back through to opts/default", () => {
    expect(
      resolveTeamWaitTimeoutMs(undefined, { OMCP_TEAM_WAIT_TIMEOUT_S: "" }),
    ).toBe(TEAM_WAIT_DEFAULT_TIMEOUT_MS);
  });
});

describe("runTeamWait — exit code 0 (completed)", () => {
  it("returns 0 immediately when initial phase is already completed", () => {
    const sleepCalls: number[] = [];
    const stub = makeReadStub(["completed"]);
    const code = runTeamWait({
      sessionId: "sess-already-completed",
      readTeamState: stub.fn,
      sleep: (ms) => sleepCalls.push(ms),
      now: () => 0,
      log: () => {},
      errLog: () => {},
    });
    expect(code).toBe(0);
    expect(sleepCalls).toEqual([]); // never slept
    expect(stub.callCount()).toBe(1); // single read
  });

  it("returns 0 after polling through executing → completed", () => {
    const sleepCalls: number[] = [];
    const stub = makeReadStub(["executing", "executing", "completed"]);
    const code = runTeamWait({
      sessionId: "sess-poll-to-completed",
      readTeamState: stub.fn,
      sleep: (ms) => sleepCalls.push(ms),
      now: () => 0,
      log: () => {},
      errLog: () => {},
    });
    expect(code).toBe(0);
    expect(sleepCalls).toEqual([2000, 2000]); // 2 polls' worth of sleep
    expect(stub.callCount()).toBe(3); // 3 reads total
  });
});

describe("runTeamWait — exit code 1 (failed)", () => {
  it("returns 1 when phase transitions to failed", () => {
    const stub = makeReadStub(["executing", "failed"]);
    const code = runTeamWait({
      sessionId: "sess-failed",
      readTeamState: stub.fn,
      sleep: () => {},
      now: () => 0,
      log: () => {},
      errLog: () => {},
    });
    expect(code).toBe(1);
  });
});

describe("runTeamWait — exit code 2 (timeout)", () => {
  it("returns 2 when deadline fires before terminal phase", () => {
    // now() advances by 1000ms per call. Default deadline = 1_800_000ms.
    // To force a timeout in a small number of polls, set opts.timeoutMs=2.
    let t = 0;
    const stub = makeReadStub(["executing", "executing", "executing"]);
    const code = runTeamWait({
      sessionId: "sess-timeout",
      timeoutMs: 2, // 2 ms deadline
      readTeamState: stub.fn,
      sleep: () => {},
      now: () => {
        t += 10; // each call advances 10ms — first call sets baseline, second exceeds 2ms deadline
        return t;
      },
      log: () => {},
      errLog: () => {},
    });
    expect(code).toBe(2);
  });

  it("does NOT timeout if final read returns completed at exactly the deadline", () => {
    // Boundary check: when now() returns deadline-1 and the read shows
    // completed, we should still return 0. The deadline check uses >=.
    let callIdx = 0;
    const stub = makeReadStub(["executing", "completed"]);
    const code = runTeamWait({
      sessionId: "sess-boundary",
      timeoutMs: 100,
      readTeamState: stub.fn,
      sleep: () => {},
      now: () => {
        // Initial baseline = 0; after first sleep, advance to 50 (under deadline);
        // by the time the second read returns completed, we're still under 100.
        const t = callIdx * 50;
        callIdx++;
        return t;
      },
      log: () => {},
      errLog: () => {},
    });
    expect(code).toBe(0);
  });
});

describe("runTeamWait — exit code 3 (session-not-found)", () => {
  it("returns 3 on first read when state file absent", () => {
    const stub = makeReadStub(["missing"]);
    const code = runTeamWait({
      sessionId: "sess-not-found",
      readTeamState: stub.fn,
      sleep: () => {},
      now: () => 0,
      log: () => {},
      errLog: () => {},
    });
    expect(code).toBe(3);
  });

  it("returns 3 when session disappears mid-wait", () => {
    const stub = makeReadStub(["executing", "missing"]);
    const code = runTeamWait({
      sessionId: "sess-vanished",
      readTeamState: stub.fn,
      sleep: () => {},
      now: () => 0,
      log: () => {},
      errLog: () => {},
    });
    expect(code).toBe(3);
  });

  it("returns 3 on invalid session-id (assertSafeSlug rejects)", () => {
    const code = runTeamWait({
      sessionId: "../escape",
      readTeamState: () => null,
      sleep: () => {},
      now: () => 0,
      log: () => {},
      errLog: () => {},
    });
    expect(code).toBe(3);
  });
});

describe("runTeamWait — summary output", () => {
  it("prints session id + initial phase + timeout + final phase + exit code", () => {
    const out: string[] = [];
    const stub = makeReadStub(["executing", "completed"]);
    const code = runTeamWait({
      sessionId: "sess-summary",
      readTeamState: stub.fn,
      sleep: () => {},
      now: () => 0,
      log: (l) => out.push(l),
      errLog: () => {},
    });
    expect(code).toBe(0);
    const summary = out.join("\n");
    expect(summary).toMatch(/session=sess-summary/);
    expect(summary).toMatch(/initial phase:\s+executing/);
    expect(summary).toMatch(/timeout:\s+1800000ms/);
    expect(summary).toMatch(/final phase:\s+completed/);
    expect(summary).toMatch(/exit code:\s+0/);
  });

  it("errLog surfaces 'not found' / 'timed out' / 'disappeared' on the failure paths", () => {
    // not-found
    const errA: string[] = [];
    runTeamWait({
      sessionId: "sess-err-not-found",
      readTeamState: () => null,
      sleep: () => {},
      now: () => 0,
      log: () => {},
      errLog: (l) => errA.push(l),
    });
    expect(errA.some((l) => l.includes("not found"))).toBe(true);

    // timeout
    const errB: string[] = [];
    let t = 0;
    runTeamWait({
      sessionId: "sess-err-timeout",
      timeoutMs: 1,
      readTeamState: makeReadStub(["executing", "executing"]).fn,
      sleep: () => {},
      now: () => {
        t += 5;
        return t;
      },
      log: () => {},
      errLog: (l) => errB.push(l),
    });
    expect(errB.some((l) => l.includes("timed out"))).toBe(true);

    // disappeared
    const errC: string[] = [];
    runTeamWait({
      sessionId: "sess-err-vanish",
      readTeamState: makeReadStub(["executing", "missing"]).fn,
      sleep: () => {},
      now: () => 0,
      log: () => {},
      errLog: (l) => errC.push(l),
    });
    expect(errC.some((l) => l.includes("disappeared"))).toBe(true);
  });
});
