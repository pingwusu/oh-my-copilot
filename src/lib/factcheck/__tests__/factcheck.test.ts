/**
 * Factcheck Guard Tests — omcp port
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir, homedir } from "node:os";
import { runChecks } from "../index.js";
import type { FactcheckPolicy } from "../types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function defaultPolicy(): FactcheckPolicy {
  return {
    enabled: true,
    mode: "quick",
    strict_project_patterns: [],
    forbidden_path_prefixes: [join(homedir(), ".copilot/plugins/cache/omcp/")],
    forbidden_path_substrings: ["/.omcp/", ".omcp-config.json"],
    readonly_command_prefixes: [
      "ls ",
      "cat ",
      "find ",
      "grep ",
      "head ",
      "tail ",
      "stat ",
      "echo ",
      "wc ",
    ],
    warn_on_cwd_mismatch: true,
    enforce_cwd_parity_in_quick: false,
    warn_on_unverified_gates: true,
    warn_on_unverified_gates_when_no_source_files: false,
  };
}

function baseClaims(): Record<string, unknown> {
  return {
    schema_version: "1.0",
    run_id: "abc123",
    ts: "2026-02-28T20:00:00+00:00",
    cwd: "/tmp/original",
    mode: "declared",
    files_modified: [],
    files_created: [],
    artifacts_expected: [],
    gates: {
      selftest_ran: false,
      goldens_ran: false,
      sentinel_stop_smoke_ran: false,
      shadow_leak_check_ran: false,
    },
    commands_executed: [],
    models_used: [],
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Factcheck Guard", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "omcp-factcheck-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  // PASS path
  it("PASS: all gates true, matching cwd, no paths", () => {
    const policy = defaultPolicy();
    const claims = baseClaims();
    claims.gates = {
      selftest_ran: true,
      goldens_ran: true,
      sentinel_stop_smoke_ran: true,
      shadow_leak_check_ran: true,
    };
    claims.cwd = tempDir;

    const result = runChecks(claims, "strict", policy, tempDir);

    expect(result.verdict).toBe("PASS");
    expect(result.mismatches).toHaveLength(0);
  });

  // PASS path — quick mode ignores cwd mismatch and ignores false gates with no source files
  it("PASS: quick mode ignores cwd mismatch and false gates when no source files", () => {
    const policy = defaultPolicy();
    const claims = baseClaims();

    const result = runChecks(claims, "quick", policy, join(tempDir, "other"));

    expect(result.verdict).toBe("PASS");
    expect(result.mismatches.every((m) => m.check !== "argv_parity")).toBe(true);
  });

  // WARN path — declared mode warns on false gates when source files exist
  it("WARN: declared mode warns on false gates when source files exist", () => {
    const policy = defaultPolicy();
    const claims = baseClaims();
    // Create a real file so "file not found" doesn't fire
    const srcFile = join(tempDir, "src.ts");
    writeFileSync(srcFile, "export const x = 1;");
    claims.files_modified = [srcFile];
    claims.cwd = "/tmp/original";

    const result = runChecks(claims, "declared", policy, "/tmp/original");

    expect(result.verdict).toBe("WARN");
    expect(
      result.mismatches.some((m) => m.check === "B" && m.severity === "WARN"),
    ).toBe(true);
  });

  // WARN path — manual mode also warns on false gates when source files exist
  it("WARN: manual mode warns on false gates when source files exist", () => {
    const policy = defaultPolicy();
    const claims = baseClaims();
    const srcFile = join(tempDir, "main.ts");
    writeFileSync(srcFile, "export const y = 2;");
    claims.files_created = [srcFile];
    claims.cwd = "/tmp/original";

    const result = runChecks(claims, "manual", policy, "/tmp/original");

    expect(result.verdict).toBe("WARN");
    expect(
      result.mismatches.some((m) => m.check === "B" && m.severity === "WARN"),
    ).toBe(true);
  });

  // FAIL path — strict mode fails on false gates
  it("FAIL: strict mode fails on false gates", () => {
    const policy = defaultPolicy();
    const claims = baseClaims();
    claims.cwd = tempDir;

    const result = runChecks(claims, "strict", policy, tempDir);

    expect(result.verdict).toBe("FAIL");
    expect(result.mismatches.some((m) => m.check === "B")).toBe(true);
  });

  // FAIL path — strict mode also fails on cwd mismatch
  it("FAIL: strict mode fails on cwd mismatch", () => {
    const policy = defaultPolicy();
    const claims = baseClaims();
    claims.gates = {
      selftest_ran: true,
      goldens_ran: true,
      sentinel_stop_smoke_ran: true,
      shadow_leak_check_ran: true,
    };
    claims.cwd = join(tempDir, "subdir-a");

    const result = runChecks(claims, "strict", policy, join(tempDir, "subdir-b"));

    expect(result.verdict).toBe("FAIL");
    expect(result.mismatches.some((m) => m.check === "argv_parity")).toBe(true);
  });

  // FAIL path — missing required fields
  it("FAIL: missing required fields", () => {
    const policy = defaultPolicy();
    const claims = { schema_version: "1.0" }; // Missing almost everything

    const result = runChecks(claims, "quick", policy, tempDir);

    expect(result.verdict).toBe("FAIL");
    expect(result.mismatches.some((m) => m.check === "A")).toBe(true);
  });

  // FAIL path — missing required gates
  it("FAIL: missing required gates", () => {
    const policy = defaultPolicy();
    const claims = baseClaims();
    claims.gates = {}; // No gates present at all

    const result = runChecks(claims, "strict", policy, tempDir);

    expect(result.verdict).toBe("FAIL");
    expect(
      result.mismatches.some(
        (m) => m.check === "A" && m.detail.includes("Missing required gates"),
      ),
    ).toBe(true);
  });

  // Forbidden path prefix
  it("FAIL: forbidden path prefix blocks the run", () => {
    const policy = defaultPolicy();
    const claims = baseClaims();
    claims.files_created = [
      join(homedir(), ".copilot/plugins/cache/omcp/touched.txt"),
    ];

    const result = runChecks(claims, "declared", policy, "/tmp/original");

    expect(result.verdict).toBe("FAIL");
    expect(result.mismatches.some((m) => m.check === "H")).toBe(true);
  });

  // Forbidden path substring
  it("FAIL: forbidden path substring blocks the run", () => {
    const policy = defaultPolicy();
    const claims = baseClaims();
    claims.files_modified = ["/workspace/.omcp/state.json"];

    const result = runChecks(claims, "declared", policy, "/tmp/original");

    expect(result.verdict).toBe("FAIL");
    expect(result.mismatches.some((m) => m.check === "H")).toBe(true);
  });

  // Forbidden mutating command
  it("FAIL: forbidden mutating command", () => {
    const policy = defaultPolicy();
    const claims = baseClaims();
    const forbiddenPath = join(homedir(), ".copilot/plugins/cache/omcp/");
    claims.commands_executed = [`rm -rf ${forbiddenPath}data`];

    const result = runChecks(claims, "quick", policy, tempDir);

    expect(result.verdict).toBe("FAIL");
    expect(
      result.mismatches.some(
        (m) => m.check === "H" && m.detail.includes("Forbidden mutating command"),
      ),
    ).toBe(true);
  });

  // Readonly command in forbidden path is allowed
  it("PASS: readonly command in forbidden path is allowed", () => {
    const policy = defaultPolicy();
    const claims = baseClaims();
    const forbiddenPath = join(homedir(), ".copilot/plugins/cache/omcp/");
    claims.commands_executed = [
      `ls ${forbiddenPath}`,
      `cat ${forbiddenPath}file.txt`,
    ];

    const result = runChecks(claims, "quick", policy, tempDir);

    expect(
      result.mismatches.every((m) => !m.detail.includes("Forbidden mutating command")),
    ).toBe(true);
  });

  // Declared mode: no gate warn when no source files (note emitted instead)
  it("PASS: declared mode no gate warn when no source files", () => {
    const policy = defaultPolicy();
    const claims = baseClaims();

    const result = runChecks(claims, "declared", policy, "/tmp/original");

    expect(result.verdict).toBe("PASS");
    expect(result.notes.join(" ")).toContain("No source files declared");
  });

  // Sanitization edge case: null/undefined array fields produce empty arrays gracefully
  it("PASS: null/undefined array fields treated as empty without throwing", () => {
    const policy = defaultPolicy();
    const claims: Record<string, unknown> = {
      schema_version: "1.0",
      run_id: "xyz",
      ts: "2026-01-01T00:00:00Z",
      cwd: tempDir,
      mode: "quick",
      files_modified: undefined, // undefined — treated as empty via ?? []
      files_created: null,       // null — treated as empty via ?? []
      artifacts_expected: [],
      gates: {
        selftest_ran: true,
        goldens_ran: true,
        sentinel_stop_smoke_ran: true,
        shadow_leak_check_ran: true,
      },
      commands_executed: undefined,
      models_used: null,
    };

    // Should not throw — undefined/null fields are coerced to [] by the ?? [] fallback
    expect(() => runChecks(claims, "quick", policy, tempDir)).not.toThrow();
    const result = runChecks(claims, "quick", policy, tempDir);
    expect(result.verdict).toBe("PASS");
    expect(result.claims_evidence.source_files).toBe(0);
    expect(result.claims_evidence.commands_count).toBe(0);
    expect(result.claims_evidence.models_count).toBe(0);
  });
});
