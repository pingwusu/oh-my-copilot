import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  createAuditLoggerHook,
  clampArgs,
  maybeRotate,
  ROTATION_BYTES,
  MAX_ARGS_LEN,
} from "../index.js";
import type { HookContext } from "../../hook-types.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

let _counter = 0;

function uniqueSession(label = "al"): string {
  return `${label}-${Date.now()}-${++_counter}`;
}

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "omcp-al-test-"));
}

function makeCtx(
  sessionId: string,
  cwd: string,
  overrides: Partial<HookContext> = {},
): HookContext {
  return {
    event: "PreToolUse",
    sessionId,
    cwd,
    toolName: "bash",
    toolArgs: { cmd: "ls" },
    ...overrides,
  };
}

function readLines(filePath: string): string[] {
  return fs
    .readFileSync(filePath, "utf-8")
    .split("\n")
    .filter((l) => l.trim().length > 0);
}

// ─── clampArgs ────────────────────────────────────────────────────────────────

describe("clampArgs", () => {
  it("returns full JSON when under MAX_ARGS_LEN", () => {
    const result = clampArgs({ a: 1 });
    expect(result).toBe('{"a":1}');
    expect(result.length).toBeLessThanOrEqual(MAX_ARGS_LEN);
  });

  it("clamps and appends [...truncated] when over MAX_ARGS_LEN", () => {
    const bigObj = { key: "x".repeat(MAX_ARGS_LEN + 500) };
    const result = clampArgs(bigObj);
    expect(result.endsWith("[...truncated]")).toBe(true);
    expect(result.length).toBe(MAX_ARGS_LEN + "[...truncated]".length);
  });

  it("handles undefined args", () => {
    expect(clampArgs(undefined)).toBe("undefined");
  });
});

// ─── maybeRotate ──────────────────────────────────────────────────────────────

describe("maybeRotate", () => {
  let cwd: string;

  beforeEach(() => {
    cwd = tempDir();
  });

  afterEach(() => {
    try {
      fs.rmSync(cwd, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it("does nothing when file does not exist", () => {
    // Should not throw
    expect(() => maybeRotate(path.join(cwd, "nonexistent.jsonl"))).not.toThrow();
  });

  it("does nothing when file is under ROTATION_BYTES", () => {
    const file = path.join(cwd, "small.jsonl");
    fs.writeFileSync(file, "small content\n");
    maybeRotate(file);
    expect(fs.existsSync(file)).toBe(true);
  });

  it("renames file when at or over ROTATION_BYTES", () => {
    const file = path.join(cwd, "big.jsonl");
    // Write exactly ROTATION_BYTES of data
    const buf = Buffer.alloc(ROTATION_BYTES, "x");
    fs.writeFileSync(file, buf);
    maybeRotate(file);
    // Original file should be gone
    expect(fs.existsSync(file)).toBe(false);
    // A rotated file with timestamp suffix should exist
    const files = fs.readdirSync(cwd);
    const rotated = files.filter((f) => f.startsWith("big.") && f.endsWith(".jsonl"));
    expect(rotated.length).toBe(1);
  });
});

// ─── createAuditLoggerHook ────────────────────────────────────────────────────

describe("createAuditLoggerHook", () => {
  let cwd: string;

  beforeEach(() => {
    cwd = tempDir();
  });

  afterEach(() => {
    try {
      fs.rmSync(cwd, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it("subscribes to PreToolUse, PostToolUse, PostToolUseFailure", () => {
    const hook = createAuditLoggerHook();
    expect(hook.events).toContain("PreToolUse");
    expect(hook.events).toContain("PostToolUse");
    expect(hook.events).toContain("PostToolUseFailure");
    expect(hook.name).toBe("audit-logger");
  });

  it("PreToolUse fire appends 1 JSON line", async () => {
    const hook = createAuditLoggerHook();
    const sessionId = uniqueSession();
    const result = await hook.run(makeCtx(sessionId, cwd));
    expect(result).toEqual({ kind: "noop" });

    const filePath = path.join(cwd, ".omcp", "state", "audit", `${sessionId}.jsonl`);
    expect(fs.existsSync(filePath)).toBe(true);
    const lines = readLines(filePath);
    expect(lines).toHaveLength(1);
    const record = JSON.parse(lines[0]) as {
      ts: string;
      event: string;
      toolName: string;
      toolArgs: string;
      toolResultPresence: string;
    };
    expect(record.event).toBe("PreToolUse");
    expect(record.toolName).toBe("bash");
    expect(record.ts).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("3 fires across different events produce 3 parseable lines", async () => {
    const hook = createAuditLoggerHook();
    const sessionId = uniqueSession();

    await hook.run(makeCtx(sessionId, cwd, { event: "PreToolUse" }));
    await hook.run(makeCtx(sessionId, cwd, { event: "PostToolUse", toolResult: "ok" }));
    await hook.run(makeCtx(sessionId, cwd, { event: "PostToolUseFailure" }));

    const filePath = path.join(cwd, ".omcp", "state", "audit", `${sessionId}.jsonl`);
    const lines = readLines(filePath);
    expect(lines).toHaveLength(3);
    const events = lines.map((l) => (JSON.parse(l) as { event: string }).event);
    expect(events).toContain("PreToolUse");
    expect(events).toContain("PostToolUse");
    expect(events).toContain("PostToolUseFailure");
  });

  it("toolArgs > MAX_ARGS_LEN is clamped with [...truncated] suffix", async () => {
    const hook = createAuditLoggerHook();
    const sessionId = uniqueSession();
    const bigArgs = { key: "x".repeat(MAX_ARGS_LEN + 500) };

    await hook.run(makeCtx(sessionId, cwd, { toolArgs: bigArgs }));

    const filePath = path.join(cwd, ".omcp", "state", "audit", `${sessionId}.jsonl`);
    const lines = readLines(filePath);
    const record = JSON.parse(lines[0]) as { toolArgs: string };
    expect(record.toolArgs.endsWith("[...truncated]")).toBe(true);
    // Should NOT exceed MAX_ARGS_LEN + marker length
    expect(record.toolArgs.length).toBe(MAX_ARGS_LEN + "[...truncated]".length);
  });

  it("toolResult is NOT logged — only its presence is recorded", async () => {
    const hook = createAuditLoggerHook();
    const sessionId = uniqueSession();
    const secretResult = "SECRET_VALUE_12345";

    await hook.run(makeCtx(sessionId, cwd, { event: "PostToolUse", toolResult: secretResult }));

    const filePath = path.join(cwd, ".omcp", "state", "audit", `${sessionId}.jsonl`);
    const raw = fs.readFileSync(filePath, "utf-8");
    // The actual result value must NOT appear in the file
    expect(raw).not.toContain("SECRET_VALUE_12345");
    // But presence indicator must be recorded
    const record = JSON.parse(readLines(filePath)[0]) as { toolResultPresence: string };
    expect(record.toolResultPresence).toBe("present");
  });

  it("absent toolResult is logged as 'absent'", async () => {
    const hook = createAuditLoggerHook();
    const sessionId = uniqueSession();

    await hook.run(makeCtx(sessionId, cwd, { event: "PreToolUse" }));

    const filePath = path.join(cwd, ".omcp", "state", "audit", `${sessionId}.jsonl`);
    const record = JSON.parse(readLines(filePath)[0]) as { toolResultPresence: string };
    expect(record.toolResultPresence).toBe("absent");
  });

  it("rotates file when it exceeds ROTATION_BYTES and starts a fresh file", async () => {
    const hook = createAuditLoggerHook();
    const sessionId = uniqueSession();

    // Pre-create the audit file at exactly ROTATION_BYTES so the next append triggers rotation
    const dir = path.join(cwd, ".omcp", "state", "audit");
    fs.mkdirSync(dir, { recursive: true });
    const filePath = path.join(dir, `${sessionId}.jsonl`);
    const buf = Buffer.alloc(ROTATION_BYTES, "x");
    fs.writeFileSync(filePath, buf);

    await hook.run(makeCtx(sessionId, cwd, { event: "PreToolUse" }));

    // The original file should be renamed (rotated away) — the rotated copy
    // has a numeric timestamp between the sessionId and ".jsonl"
    const files = fs.readdirSync(dir);
    const rotated = files.filter((f) => {
      // matches "{sessionId}.{digits}.jsonl" — the rotation rename pattern
      return new RegExp(`^${sessionId}\\.\\d+\\.jsonl$`).test(f);
    });
    expect(rotated.length).toBe(1);

    // A fresh file must exist with the new line
    expect(fs.existsSync(filePath)).toBe(true);
    const lines = readLines(filePath);
    expect(lines).toHaveLength(1);
  });

  it("isolates audit files per session", async () => {
    const hook = createAuditLoggerHook();
    const sessionA = uniqueSession("alA");
    const sessionB = uniqueSession("alB");

    await hook.run(makeCtx(sessionA, cwd));
    await hook.run(makeCtx(sessionB, cwd));
    await hook.run(makeCtx(sessionB, cwd));

    const fileA = path.join(cwd, ".omcp", "state", "audit", `${sessionA}.jsonl`);
    const fileB = path.join(cwd, ".omcp", "state", "audit", `${sessionB}.jsonl`);

    expect(readLines(fileA)).toHaveLength(1);
    expect(readLines(fileB)).toHaveLength(2);
  });

  it("always returns noop (observational hook)", async () => {
    const hook = createAuditLoggerHook();
    const sessionId = uniqueSession();
    for (const event of ["PreToolUse", "PostToolUse", "PostToolUseFailure"] as const) {
      const result = await hook.run(makeCtx(sessionId, cwd, { event }));
      expect(result).toEqual({ kind: "noop" });
    }
  });
});
