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
  createErrorAggregatorHook,
  appendErrorRecord,
  buildErrorRecord,
  errorsFilePath,
  maybeRotate,
  ROTATION_BYTES,
} from "../index.js";
import type { HookContext } from "../../hook-types.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "omcp-err-agg-test-"));
}

function makeCtx(
  overrides: Partial<HookContext> & { cwd: string },
): HookContext {
  return {
    event: "ErrorOccurred",
    sessionId: "test-session-1",
    ...overrides,
  };
}

function readLines(cwd: string): string[] {
  const file = errorsFilePath(cwd);
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, "utf-8")
    .split("\n")
    .filter((l) => l.trim().length > 0);
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("error-aggregator", () => {
  let cwd: string;

  beforeEach(() => {
    cwd = makeTempDir();
  });

  afterEach(() => {
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  // ── 1. ErrorOccurred fire → 1 line appended with all fields ─────────────

  it("appends one JSON line per ErrorOccurred fire with all required fields", async () => {
    const hook = createErrorAggregatorHook();
    const ctx = makeCtx({
      cwd,
      sessionId: "session-abc",
      toolName: "bash",
      toolArgs: {
        errorMessage: "Command not found",
        errorStack: "Error: Command not found\n  at run (bash.ts:42)",
      },
    });

    const result = await hook.run(ctx);
    expect(result).toEqual({ kind: "noop" });

    const lines = readLines(cwd);
    expect(lines).toHaveLength(1);

    const record = JSON.parse(lines[0]);
    expect(record.sessionId).toBe("session-abc");
    expect(record.toolName).toBe("bash");
    expect(record.errorMessage).toBe("Command not found");
    expect(record.errorStack).toContain("Command not found");
    expect(typeof record.ts).toBe("string");
    // ts must be a valid ISO8601 date
    expect(() => new Date(record.ts).toISOString()).not.toThrow();
  });

  // ── 2. Missing toolName / errorMessage → fallback strings ───────────────

  it("uses fallback strings when toolName and errorMessage are missing", async () => {
    const hook = createErrorAggregatorHook();
    const ctx = makeCtx({
      cwd,
      sessionId: "session-fallback",
      // no toolName
      toolArgs: {
        // no errorMessage, no errorStack
      },
    });

    await hook.run(ctx);

    const lines = readLines(cwd);
    expect(lines).toHaveLength(1);
    const record = JSON.parse(lines[0]);
    expect(record.toolName).toBeNull();
    expect(record.errorMessage).toBe("(unknown)");
    expect(record.errorStack).toBeNull();
  });

  // ── 3. Rotation at 10 MB ─────────────────────────────────────────────────

  it("rotates errors.jsonl when it exceeds ROTATION_BYTES", () => {
    const file = errorsFilePath(cwd);
    const dir = path.dirname(file);
    fs.mkdirSync(dir, { recursive: true });

    // Write a file that is exactly ROTATION_BYTES in size
    const bigContent = "x".repeat(ROTATION_BYTES);
    fs.writeFileSync(file, bigContent, "utf-8");

    maybeRotate(file);

    // Original file should be gone
    expect(fs.existsSync(file)).toBe(false);

    // A rotated file should exist in the same directory
    const rotated = fs
      .readdirSync(dir)
      .filter((f) => f.startsWith("errors.") && f.endsWith(".jsonl"));
    expect(rotated.length).toBeGreaterThan(0);
  });

  // ── 4. Cross-session aggregation ─────────────────────────────────────────

  it("aggregates errors from multiple sessions into the same file", async () => {
    const hook = createErrorAggregatorHook();

    for (const sessionId of ["session-1", "session-2", "session-3"]) {
      await hook.run(
        makeCtx({
          cwd,
          sessionId,
          toolArgs: { errorMessage: `Error from ${sessionId}` },
        }),
      );
    }

    const lines = readLines(cwd);
    expect(lines).toHaveLength(3);

    const records = lines.map((l) => JSON.parse(l));
    const ids = records.map((r: { sessionId: string }) => r.sessionId);
    expect(ids).toContain("session-1");
    expect(ids).toContain("session-2");
    expect(ids).toContain("session-3");

    // Each record must have its own session ID
    for (const record of records) {
      expect(record.errorMessage).toBe(`Error from ${record.sessionId}`);
    }
  });

  // ── 5. Returns noop ───────────────────────────────────────────────────────

  it("always returns noop (observational hook)", async () => {
    const hook = createErrorAggregatorHook();
    const result = await hook.run(makeCtx({ cwd }));
    expect(result).toEqual({ kind: "noop" });
  });

  // ── 6. Subscribes to ErrorOccurred only ──────────────────────────────────

  it("subscribes to ErrorOccurred event", () => {
    const hook = createErrorAggregatorHook();
    expect(hook.events).toContain("ErrorOccurred");
    expect(hook.name).toBe("error-aggregator");
  });

  // ── 7. null toolArgs handled gracefully ──────────────────────────────────

  it("handles null toolArgs without crashing", async () => {
    const hook = createErrorAggregatorHook();
    const ctx = makeCtx({ cwd, toolArgs: null });
    const result = await hook.run(ctx);
    expect(result).toEqual({ kind: "noop" });

    const lines = readLines(cwd);
    expect(lines).toHaveLength(1);
    const record = JSON.parse(lines[0]);
    expect(record.errorMessage).toBe("(unknown)");
  });
});
