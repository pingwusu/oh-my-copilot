import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  createAutoRecoveryAdvisorHook,
  readLastLines,
  detectRecurrence,
  DEFAULT_WINDOW,
  DEFAULT_RECURRENCE_THRESHOLD,
} from "../index.js";
import type { HookContext } from "../../hook-types.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "omcp-recovery-test-"));
}

function errorsFilePath(cwd: string): string {
  return path.join(cwd, ".omcp", "state", "errors.jsonl");
}

function writeErrorLines(cwd: string, messages: string[]): void {
  const file = errorsFilePath(cwd);
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const content = messages
    .map((m) => JSON.stringify({ errorMessage: m, sessionId: "s1", ts: new Date().toISOString() }))
    .join("\n") + "\n";
  fs.writeFileSync(file, content, "utf-8");
}

function makeCtx(cwd: string): HookContext {
  return {
    event: "ErrorOccurred",
    sessionId: "test-session",
    cwd,
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("auto-recovery-advisor", () => {
  let cwd: string;

  beforeEach(() => {
    cwd = makeTempDir();
    // Clear env overrides
    delete process.env.OMCP_RECOVERY_WINDOW;
    delete process.env.OMCP_RECOVERY_RECURRENCE_THRESHOLD;
  });

  afterEach(() => {
    fs.rmSync(cwd, { recursive: true, force: true });
    delete process.env.OMCP_RECOVERY_WINDOW;
    delete process.env.OMCP_RECOVERY_RECURRENCE_THRESHOLD;
  });

  // ── 1. 20 distinct errors → noop ─────────────────────────────────────────

  it("returns noop when all 20 errors are distinct", async () => {
    const messages = Array.from({ length: 20 }, (_, i) => `Unique error ${i}`);
    writeErrorLines(cwd, messages);

    const hook = createAutoRecoveryAdvisorHook();
    const result = await hook.run(makeCtx(cwd));
    expect(result).toEqual({ kind: "noop" });
  });

  // ── 2. Same error 3 times → advise with message text ────────────────────

  it("returns advise when the same error appears 3 times", async () => {
    const messages = [
      "Unrelated error A",
      "ENOENT: no such file or directory",
      "Unrelated error B",
      "ENOENT: no such file or directory",
      "Unrelated error C",
      "ENOENT: no such file or directory",
    ];
    writeErrorLines(cwd, messages);

    const hook = createAutoRecoveryAdvisorHook();
    const result = await hook.run(makeCtx(cwd));
    expect(result.kind).toBe("advise");
    if (result.kind === "advise") {
      expect(result.text).toContain("ENOENT: no such file or directory");
      expect(result.text).toContain("3");
    }
  });

  // ── 3. Same error 2 times (under threshold) → noop ──────────────────────

  it("returns noop when the same error appears only 2 times (below threshold 3)", async () => {
    const messages = [
      "TypeError: Cannot read property",
      "Other error",
      "TypeError: Cannot read property",
    ];
    writeErrorLines(cwd, messages);

    const hook = createAutoRecoveryAdvisorHook();
    const result = await hook.run(makeCtx(cwd));
    expect(result).toEqual({ kind: "noop" });
  });

  // ── 4. Different patterns interleaved — only threshold-met triggers ──────

  it("only triggers advise for the error that meets the threshold", async () => {
    const messages = [
      "Error Alpha",
      "Error Beta",
      "Error Alpha",
      "Error Gamma",
      "Error Beta",
      "Error Alpha", // Alpha appears 3 times → threshold met
    ];
    writeErrorLines(cwd, messages);

    const hook = createAutoRecoveryAdvisorHook();
    const result = await hook.run(makeCtx(cwd));
    expect(result.kind).toBe("advise");
    if (result.kind === "advise") {
      expect(result.text).toContain("Error Alpha");
      expect(result.text).not.toContain("Error Beta");
    }
  });

  // ── 5. Errors file doesn't exist → noop ──────────────────────────────────

  it("returns noop gracefully when errors.jsonl does not exist", async () => {
    // Do not create errors.jsonl
    const hook = createAutoRecoveryAdvisorHook();
    const result = await hook.run(makeCtx(cwd));
    expect(result).toEqual({ kind: "noop" });
  });

  // ── 6. Env override for recurrence threshold ─────────────────────────────

  it("respects OMCP_RECOVERY_RECURRENCE_THRESHOLD env var", async () => {
    process.env.OMCP_RECOVERY_RECURRENCE_THRESHOLD = "2";

    const messages = [
      "Repeated error X",
      "Repeated error X",
    ];
    writeErrorLines(cwd, messages);

    const hook = createAutoRecoveryAdvisorHook();
    const result = await hook.run(makeCtx(cwd));
    expect(result.kind).toBe("advise");
    if (result.kind === "advise") {
      expect(result.text).toContain("Repeated error X");
    }
  });

  // ── 7. readLastLines unit test ───────────────────────────────────────────

  it("readLastLines returns empty array for non-existent file", () => {
    const result = readLastLines("/nonexistent/path/errors.jsonl", 10);
    expect(result).toEqual([]);
  });

  // ── 8. detectRecurrence unit test ────────────────────────────────────────

  it("detectRecurrence correctly identifies recurring pattern", () => {
    const lines = [
      JSON.stringify({ errorMessage: "Error X" }),
      JSON.stringify({ errorMessage: "Error Y" }),
      JSON.stringify({ errorMessage: "Error X" }),
      JSON.stringify({ errorMessage: "Error X" }),
    ];
    const result = detectRecurrence(lines, 3);
    expect(result.found).toBe(true);
    expect(result.pattern).toContain("Error X");
    expect(result.count).toBe(3);
  });

  // ── 9. Subscribes to correct event ───────────────────────────────────────

  it("subscribes to ErrorOccurred event", () => {
    const hook = createAutoRecoveryAdvisorHook();
    expect(hook.events).toContain("ErrorOccurred");
    expect(hook.name).toBe("auto-recovery-advisor");
  });
});
