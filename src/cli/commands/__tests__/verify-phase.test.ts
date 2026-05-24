// Tests for `omcp verify-phase` — dependency-injection pattern (no vi.mock).
// All spawn calls are injected via the `spawn` option on VerifyPhaseOptions.

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

import { detectVerdict } from "../../../lib/ralph-state.js";
import { runVerifyPhase } from "../verify-phase.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeDir(): string {
  return mkdtempSync(join(tmpdir(), "omcp-verify-phase-"));
}

function writeSubmission(dir: string, phaseId: string, content = "# Submission\n\nAll criteria met."): void {
  const verDir = join(dir, ".omcp", "state", "verification");
  mkdirSync(verDir, { recursive: true });
  writeFileSync(join(verDir, `${phaseId}-submission.md`), content, "utf8");
}

/** Build a mock spawn that returns the given stdout for every call. */
function mockSpawn(stdout: string) {
  return vi.fn((_bin: string, _args: string[]) => ({
    status: 0,
    stdout: Buffer.from(stdout, "utf8"),
    stderr: Buffer.from("", "utf8"),
  }));
}

/** Build a mock spawn that alternates between two stdout values per call index. */
function mockSpawnSequence(responses: string[]) {
  let call = 0;
  return vi.fn((_bin: string, _args: string[]) => {
    const stdout = responses[call] ?? responses[responses.length - 1];
    call++;
    return {
      status: 0,
      stdout: Buffer.from(stdout, "utf8"),
      stderr: Buffer.from("", "utf8"),
    };
  });
}

// ---------------------------------------------------------------------------
// detectVerdict unit tests (pure function, no I/O)
// ---------------------------------------------------------------------------

describe("detectVerdict", () => {
  it("returns APPROVE for a bare keyword line", () => {
    expect(detectVerdict("APPROVE")).toBe("APPROVE");
  });

  it("returns ITERATE for a bare keyword line", () => {
    expect(detectVerdict("ITERATE")).toBe("ITERATE");
  });

  it("returns REJECT for a bare keyword line", () => {
    expect(detectVerdict("REJECT")).toBe("REJECT");
  });

  it("is case-insensitive", () => {
    expect(detectVerdict("approve")).toBe("APPROVE");
    expect(detectVerdict("Iterate")).toBe("ITERATE");
    expect(detectVerdict("reject")).toBe("REJECT");
  });

  it("tolerates leading/trailing whitespace", () => {
    expect(detectVerdict("   APPROVE   ")).toBe("APPROVE");
  });

  it("tolerates markdown bold wrapper **APPROVE**", () => {
    expect(detectVerdict("**APPROVE**")).toBe("APPROVE");
  });

  it("does NOT match inline occurrence 'I would APPROVE this if X'", () => {
    expect(detectVerdict("I would APPROVE this if X")).toBeNull();
  });

  it("does NOT match inline occurrence 'REJECT the alternative approach'", () => {
    expect(detectVerdict("REJECT the alternative approach")).toBeNull();
  });

  it("returns null for ambiguous line with two verdict keywords", () => {
    // A line that has both APPROVE and ITERATE is ambiguous.
    expect(detectVerdict("APPROVE or ITERATE")).toBeNull();
  });

  it("finds verdict keyword buried in multi-line text", () => {
    const text = "Some analysis here.\n\nAPPROVE\n\nRationale follows.";
    expect(detectVerdict(text)).toBe("APPROVE");
  });
});

// ---------------------------------------------------------------------------
// runVerifyPhase integration tests
// ---------------------------------------------------------------------------

describe("runVerifyPhase", () => {
  let dir: string;
  let errs: string[];
  let errSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    dir = makeDir();
    errs = [];
    errSpy = vi.spyOn(console, "error").mockImplementation((...a) => {
      errs.push(a.map(String).join(" "));
    });
  });

  afterEach(() => {
    errSpy.mockRestore();
    rmSync(dir, { recursive: true, force: true });
  });

  // ── exit code 2: invocation errors ────────────────────────────────────────

  it("returns exit 2 when submission file is absent", () => {
    const spawn = mockSpawn("APPROVE");
    const r = runVerifyPhase({ phaseId: "missing-phase", cwd: dir, spawn });
    expect(r.exitCode).toBe(2);
    expect(errs.join("\n")).toContain("submission file not found");
    expect(spawn).not.toHaveBeenCalled();
  });

  it("returns exit 2 and stderr message for path-traversal phase-id", () => {
    const spawn = mockSpawn("APPROVE");
    const r = runVerifyPhase({ phaseId: "../etc", cwd: dir, spawn });
    expect(r.exitCode).toBe(2);
    expect(errs.join("\n")).toContain("unsafe");
    expect(spawn).not.toHaveBeenCalled();
  });

  // ── exit code 0: both APPROVE ──────────────────────────────────────────────

  it("returns exit 0 when both architect and critic APPROVE on iteration 1", () => {
    writeSubmission(dir, "smoke-test");
    const spawn = mockSpawn("\nAPPROVE\n");
    const r = runVerifyPhase({ phaseId: "smoke-test", maxIterations: 2, cwd: dir, spawn });
    expect(r.exitCode).toBe(0);
    expect(r.iterations).toBe(1);
    expect(r.architectVerdict).toBe("APPROVE");
    expect(r.criticVerdict).toBe("APPROVE");
  });

  it("writes a record file via atomicWriteFileSync on pass", () => {
    writeSubmission(dir, "smoke-test");
    const spawn = mockSpawn("\nAPPROVE\n");
    const r = runVerifyPhase({ phaseId: "smoke-test", maxIterations: 2, cwd: dir, spawn });
    expect(r.exitCode).toBe(0);
    expect(r.recordPath).toBeDefined();
    // File must exist and contain valid JSON with outcome=PASS.
    const recordPath = r.recordPath as string;
    expect(existsSync(recordPath)).toBe(true);
    const rec = JSON.parse(readFileSync(recordPath, "utf8"));
    expect(rec.outcome).toBe("PASS");
    expect(rec.phaseId).toBe("smoke-test");
  });

  it("spawns copilot twice per iteration (architect + critic in separate calls)", () => {
    writeSubmission(dir, "spawn-count");
    const spawn = mockSpawn("\nAPPROVE\n");
    runVerifyPhase({ phaseId: "spawn-count", maxIterations: 1, cwd: dir, spawn });
    // Two calls on first APPROVE iteration.
    expect(spawn).toHaveBeenCalledTimes(2);
  });

  it("each spawn call uses copilot -p (fresh session, no --inject)", () => {
    writeSubmission(dir, "session-check");
    const spawn = mockSpawn("\nAPPROVE\n");
    runVerifyPhase({ phaseId: "session-check", maxIterations: 1, cwd: dir, spawn });
    for (const call of spawn.mock.calls) {
      expect(call[0]).toBe("copilot");
      expect(call[1][0]).toBe("-p");
      // No --resume/--inject flag.
      expect(call[1].join(" ")).not.toContain("--resume");
      expect(call[1].join(" ")).not.toContain("--inject");
    }
  });

  // ── ITERATE then APPROVE ───────────────────────────────────────────────────

  it("loops on ITERATE and exits 0 when both APPROVE on iteration 2", () => {
    writeSubmission(dir, "loop-test");
    // iteration 1: architect=ITERATE, critic=ITERATE
    // iteration 2: architect=APPROVE, critic=APPROVE
    const spawn = mockSpawnSequence([
      "\nITERATE\n",
      "\nITERATE\n",
      "\nAPPROVE\n",
      "\nAPPROVE\n",
    ]);
    const r = runVerifyPhase({ phaseId: "loop-test", maxIterations: 5, cwd: dir, spawn });
    expect(r.exitCode).toBe(0);
    expect(r.iterations).toBe(2);
    expect(spawn).toHaveBeenCalledTimes(4);
  });

  // ── exit code 1: max iterations exhausted ─────────────────────────────────

  it("returns exit 1 after 5 ITERATE cycles without APPROVE", () => {
    writeSubmission(dir, "max-iter");
    const spawn = mockSpawn("\nITERATE\n");
    const r = runVerifyPhase({ phaseId: "max-iter", maxIterations: 5, cwd: dir, spawn });
    expect(r.exitCode).toBe(1);
    expect(r.iterations).toBe(5);
    // Architect+critic per iteration = 10 total spawn calls.
    expect(spawn).toHaveBeenCalledTimes(10);
  });

  // ── exit code 1: REJECT ────────────────────────────────────────────────────

  it("returns exit 1 immediately when architect returns REJECT", () => {
    writeSubmission(dir, "reject-test");
    // Architect REJECT, critic ITERATE (either REJECT triggers escalation).
    const spawn = mockSpawnSequence(["\nREJECT\n", "\nITERATE\n"]);
    const r = runVerifyPhase({ phaseId: "reject-test", maxIterations: 5, cwd: dir, spawn });
    expect(r.exitCode).toBe(1);
    expect(r.iterations).toBe(1);
    expect(r.architectVerdict).toBe("REJECT");
  });

  it("writes escalation record on REJECT", () => {
    writeSubmission(dir, "reject-record");
    const spawn = mockSpawn("\nREJECT\n");
    const r = runVerifyPhase({ phaseId: "reject-record", maxIterations: 5, cwd: dir, spawn });
    expect(r.exitCode).toBe(1);
    expect(r.recordPath).toBeDefined();
    const rejectPath = r.recordPath as string;
    expect(existsSync(rejectPath)).toBe(true);
    const rec = JSON.parse(readFileSync(rejectPath, "utf8"));
    expect(rec.outcome).toBe("REJECT");
  });

  // ── timeout option ─────────────────────────────────────────────────────────

  it("defaults timeout to 600 when not provided (spawn receives no extra timeout arg via injection)", () => {
    // When timeout is omitted, runVerifyPhase should still work correctly —
    // the default of 600 is applied inside the real-spawnSync path, but the
    // injected spawn is called with the same signature regardless.
    writeSubmission(dir, "timeout-default");
    const spawn = mockSpawn("\nAPPROVE\n");
    const r = runVerifyPhase({ phaseId: "timeout-default", cwd: dir, spawn });
    // Default behaviour: both APPROVE → exit 0.
    expect(r.exitCode).toBe(0);
    expect(r.iterations).toBe(1);
  });

  it("accepts an explicit timeout option without affecting pass/fail outcome", () => {
    writeSubmission(dir, "timeout-explicit");
    const spawn = mockSpawn("\nAPPROVE\n");
    const r = runVerifyPhase({ phaseId: "timeout-explicit", timeout: 30, cwd: dir, spawn });
    expect(r.exitCode).toBe(0);
    expect(r.iterations).toBe(1);
  });

  it("treats a timed-out architect spawn (status=null, signal=SIGTERM) as ITERATE, not a crash", () => {
    writeSubmission(dir, "timeout-architect");
    // First two calls simulate architect timeout then critic ITERATE (both → no verdict → ITERATE loop).
    // Subsequent calls: APPROVE + APPROVE to exit cleanly within maxIterations.
    let call = 0;
    const spawn = vi.fn((_bin: string, _args: string[]) => {
      call++;
      if (call === 1) {
        // Architect on iteration 1: timed out.
        return { status: null as null, stdout: Buffer.from("", "utf8"), stderr: Buffer.from("", "utf8"), signal: "SIGTERM" as NodeJS.Signals };
      }
      if (call === 2) {
        // Critic on iteration 1: normal ITERATE.
        return { status: 0, stdout: Buffer.from("\nITERATE\n", "utf8"), stderr: Buffer.from("", "utf8"), signal: null };
      }
      // Iteration 2: both APPROVE.
      return { status: 0, stdout: Buffer.from("\nAPPROVE\n", "utf8"), stderr: Buffer.from("", "utf8"), signal: null };
    });
    const r = runVerifyPhase({ phaseId: "timeout-architect", timeout: 5, maxIterations: 3, cwd: dir, spawn });
    // Should survive the timeout and eventually reach APPROVE.
    expect(r.exitCode).toBe(0);
    expect(r.iterations).toBe(2);
    // Timeout warning must appear in stderr.
    expect(errs.join("\n")).toContain("timed out");
  });

  it("treats a timed-out critic spawn (status=null, signal=SIGTERM) as ITERATE, not a crash", () => {
    writeSubmission(dir, "timeout-critic");
    let call = 0;
    const spawn = vi.fn((_bin: string, _args: string[]) => {
      call++;
      if (call === 1) {
        // Architect on iteration 1: normal APPROVE.
        return { status: 0, stdout: Buffer.from("\nAPPROVE\n", "utf8"), stderr: Buffer.from("", "utf8"), signal: null };
      }
      if (call === 2) {
        // Critic on iteration 1: timed out.
        return { status: null as null, stdout: Buffer.from("", "utf8"), stderr: Buffer.from("", "utf8"), signal: "SIGTERM" as NodeJS.Signals };
      }
      // Iteration 2: both APPROVE.
      return { status: 0, stdout: Buffer.from("\nAPPROVE\n", "utf8"), stderr: Buffer.from("", "utf8"), signal: null };
    });
    const r = runVerifyPhase({ phaseId: "timeout-critic", timeout: 5, maxIterations: 3, cwd: dir, spawn });
    expect(r.exitCode).toBe(0);
    expect(r.iterations).toBe(2);
    expect(errs.join("\n")).toContain("timed out");
  });
});
