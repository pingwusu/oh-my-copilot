/**
 * Sentinel Readiness Gate Tests — omcp port
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  mkdirSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  checkSentinelReadiness,
  waitForSentinelReadiness,
} from "../sentinel-gate.js";

function writeJsonl(path: string, rows: Record<string, unknown>[]): void {
  const content = rows.map((row) => JSON.stringify(row)).join("\n") + "\n";
  writeFileSync(path, content, "utf-8");
}

function writeGuardsConfig(
  tempDir: string,
  config: Record<string, unknown>,
): void {
  mkdirSync(join(tempDir, ".omcp"), { recursive: true });
  writeFileSync(
    join(tempDir, ".omcp", "guards.jsonc"),
    JSON.stringify(config),
    "utf-8",
  );
}

describe("Sentinel readiness gate", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "omcp-sentinel-gate-"));
    // Pin guard thresholds in test-local workspace config for deterministic behavior.
    writeGuardsConfig(tempDir, {
      factcheck: {
        enabled: true,
        mode: "strict",
      },
      sentinel: {
        enabled: true,
        readiness: {
          min_pass_rate: 0.6,
          max_timeout_rate: 0.1,
          max_warn_plus_fail_rate: 0.4,
          min_reason_coverage_rate: 0.95,
        },
      },
    });
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  // factcheck PASS → ready: true
  it("factcheck PASS: all checks pass with healthy log", () => {
    const logPath = join(tempDir, "sentinel_stop.jsonl");
    writeJsonl(logPath, [
      { verdict: "PASS", reason: "ok-1", runtime: { timed_out: false } },
      { verdict: "PASS", reason: "ok-2", runtime: { timed_out: false } },
      { verdict: "PASS", reason: "ok-3", runtime: { timed_out: false } },
      { verdict: "PASS", reason: "ok-4", runtime: { timed_out: false } },
      { verdict: "PASS", reason: "ok-5", runtime: { timed_out: false } },
    ]);

    const result = checkSentinelReadiness({ logPath, workspace: tempDir });

    expect(result.ready).toBe(true);
    expect(result.blockers).toEqual([]);
    expect(result.skipped).toBe(false);
  });

  // factcheck FAIL → ready: false + blockers populated
  it("factcheck FAIL: invalid claims produce blockers", () => {
    const result = checkSentinelReadiness({
      claims: { schema_version: "1.0" },
      workspace: tempDir,
    });

    expect(result.ready).toBe(false);
    expect(result.skipped).toBe(false);
    expect(result.blockers.some((b) => b.startsWith("[factcheck]"))).toBe(true);
  });

  // disabled gate → skipped: true, ready: true
  it("disabled gate: skipped is true and ready is true", () => {
    const result = checkSentinelReadiness({ enabled: false });

    expect(result).toEqual({
      ready: true,
      blockers: [],
      skipped: true,
    });
  });

  // fail-closed: enabled but no logPath/claims → ready: false
  it("fail-closed: enabled but no logPath or claims → ready: false", () => {
    const result = checkSentinelReadiness({ workspace: tempDir });

    expect(result.ready).toBe(false);
    expect(result.skipped).toBe(true);
    expect(result.blockers.length).toBeGreaterThan(0);
    expect(result.blockers[0]).toContain("no logPath or claims provided");
  });

  // fail-closed: explicit enabled:true with no inputs
  it("fail-closed: explicit enabled:true with no inputs → cannot verify readiness", () => {
    const result = checkSentinelReadiness({ enabled: true });

    expect(result.ready).toBe(false);
    expect(result.skipped).toBe(true);
    expect(result.blockers.some((b) => b.includes("cannot verify readiness"))).toBe(
      true,
    );
  });

  // sentinel log stats fail thresholds → ready: false with pass_rate blocker
  it("sentinel stats fail: too many failures block readiness", () => {
    const logPath = join(tempDir, "sentinel_stop.jsonl");
    writeJsonl(logPath, [
      { verdict: "FAIL", runtime: { timed_out: true }, reason: "timeout" },
      { verdict: "WARN", runtime: { global_timeout: true }, reason: "" },
      { verdict: "WARN", reason: "no_parseable_verdicts" },
      { verdict: "FAIL", reason: "required_models_unavailable" },
      { verdict: "PASS", reason: "ok" },
    ]);

    const result = checkSentinelReadiness({ logPath, workspace: tempDir });

    expect(result.ready).toBe(false);
    expect(result.skipped).toBe(false);
    expect(result.blockers.length).toBeGreaterThan(0);
    expect(result.blockers.some((b) => b.includes("pass_rate"))).toBe(true);
  });

  // dedup blockers: same blocker text from multiple sources → single entry
  it("dedup blockers: same blocker text appears only once", () => {
    // Use both logPath with bad stats AND claims that will fail — both may produce
    // pass_rate blocker. Verify deduplication via Set.
    const logPath = join(tempDir, "sentinel_stop.jsonl");
    writeJsonl(logPath, [
      // 0 PASSes → pass_rate 0.000 < 0.60
      { verdict: "FAIL", reason: "err1" },
      { verdict: "FAIL", reason: "err2" },
    ]);

    const result = checkSentinelReadiness({ logPath, workspace: tempDir });

    // Verify no duplicate entries
    const uniqueBlockers = [...new Set(result.blockers)];
    expect(result.blockers).toEqual(uniqueBlockers);
  });

  // sanitization: object passed where array expected — does not throw
  it("sanitization: object passed where array expected does not throw", () => {
    const result = checkSentinelReadiness({
      claims: {
        files_modified: {} as unknown as string[],
        files_created: "not-an-array" as unknown as string[],
      },
      workspace: tempDir,
    });

    expect(result.ready).toBe(false);
    expect(result.skipped).toBe(false);
    // Has blockers (from factcheck) but did NOT throw
    expect(result.blockers.length).toBeGreaterThan(0);
  });

  // disabled via workspace config
  it("disabled via workspace guards config: skips and returns ready:true", () => {
    writeGuardsConfig(tempDir, {
      sentinel: { enabled: false },
    });

    const result = checkSentinelReadiness({ workspace: tempDir });

    expect(result).toEqual({
      ready: true,
      blockers: [],
      skipped: true,
    });
  });

  // waitForSentinelReadiness timeout path → timedOut: true
  it("waitForSentinelReadiness: times out when readiness never arrives", async () => {
    const logPath = join(tempDir, "sentinel_stop.jsonl");
    // No file written — log is empty → 0 runs → pass_rate 0 < 0.60

    const result = await waitForSentinelReadiness({
      logPath,
      workspace: tempDir,
      timeoutMs: 120,
      pollIntervalMs: 50,
    });

    expect(result.ready).toBe(false);
    expect(result.timedOut).toBe(true);
    expect(result.blockers.some((b) => b.includes("timed out"))).toBe(true);
  });

  // waitForSentinelReadiness succeeds when log becomes healthy during wait
  it("waitForSentinelReadiness: succeeds when log becomes healthy mid-wait", async () => {
    const logPath = join(tempDir, "sentinel_stop.jsonl");

    setTimeout(() => {
      writeJsonl(logPath, [
        { verdict: "PASS", reason: "ok-1", runtime: { timed_out: false } },
        { verdict: "PASS", reason: "ok-2", runtime: { timed_out: false } },
        { verdict: "PASS", reason: "ok-3", runtime: { timed_out: false } },
        { verdict: "PASS", reason: "ok-4", runtime: { timed_out: false } },
        { verdict: "PASS", reason: "ok-5", runtime: { timed_out: false } },
      ]);
    }, 60);

    const result = await waitForSentinelReadiness({
      logPath,
      workspace: tempDir,
      timeoutMs: 800,
      pollIntervalMs: 40,
    });

    expect(result.ready).toBe(true);
    expect(result.timedOut).toBe(false);
    expect(result.blockers).toEqual([]);
  });
});
