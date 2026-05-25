/**
 * Deterministic tests for US-1.9-T2-DOCTOR-json-output.
 *
 * Verifies the --json flag produces machine-readable output with the
 * correct schema: { checks: Array<{ name, level, detail }> }.
 */

import { describe, it, expect } from "vitest";
import {
  formatChecksJson,
  type CheckResult,
} from "../cli/commands/doctor.js";

describe("formatChecksJson", () => {
  it("produces valid JSON string", () => {
    const checks: CheckResult[] = [
      { name: "copilot CLI", level: "ok", detail: "1.0.52" },
      { name: "hook wiring", level: "warn", detail: "not wired" },
      { name: "mcp-config integrity", level: "fail", detail: "parse error" },
    ];
    const json = formatChecksJson(checks);
    expect(() => JSON.parse(json)).not.toThrow();
  });

  it("JSON has top-level checks array", () => {
    const checks: CheckResult[] = [
      { name: "copilot CLI", level: "ok", detail: "1.0.52" },
    ];
    const parsed = JSON.parse(formatChecksJson(checks)) as { checks: CheckResult[] };
    expect(Array.isArray(parsed.checks)).toBe(true);
    expect(parsed.checks).toHaveLength(1);
  });

  it("each check entry has name, level, detail fields", () => {
    const checks: CheckResult[] = [
      { name: "test check", level: "warn", detail: "some detail" },
    ];
    const parsed = JSON.parse(formatChecksJson(checks)) as { checks: CheckResult[] };
    const entry = parsed.checks[0];
    expect(entry).toHaveProperty("name", "test check");
    expect(entry).toHaveProperty("level", "warn");
    expect(entry).toHaveProperty("detail", "some detail");
  });

  it("level values are ok | warn | fail", () => {
    const checks: CheckResult[] = [
      { name: "a", level: "ok", detail: "d" },
      { name: "b", level: "warn", detail: "d" },
      { name: "c", level: "fail", detail: "d" },
    ];
    const parsed = JSON.parse(formatChecksJson(checks)) as { checks: CheckResult[] };
    for (const entry of parsed.checks) {
      expect(["ok", "warn", "fail"]).toContain(entry.level);
    }
  });

  it("preserves all checks in order", () => {
    const checks: CheckResult[] = [
      { name: "first", level: "ok", detail: "d1" },
      { name: "second", level: "warn", detail: "d2" },
      { name: "third", level: "fail", detail: "d3" },
    ];
    const parsed = JSON.parse(formatChecksJson(checks)) as { checks: CheckResult[] };
    expect(parsed.checks[0].name).toBe("first");
    expect(parsed.checks[1].name).toBe("second");
    expect(parsed.checks[2].name).toBe("third");
  });

  it("handles empty checks array", () => {
    const parsed = JSON.parse(formatChecksJson([])) as { checks: CheckResult[] };
    expect(parsed.checks).toHaveLength(0);
  });

  it("output is pretty-printed (has newlines)", () => {
    const checks: CheckResult[] = [
      { name: "test", level: "ok", detail: "ok" },
    ];
    const json = formatChecksJson(checks);
    expect(json).toContain("\n");
  });
});
