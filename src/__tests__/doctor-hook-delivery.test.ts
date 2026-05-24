/**
 * Deterministic tests for the v1.5 `omcp doctor` hook-delivery health probe.
 *
 * The probe detects the upstream Copilot Windows pwsh dispatch bug
 * (documented in docs/upstream-reports/copilot-pwsh-dispatch-v1.5-investigation.md)
 * by scanning the most recent Copilot log for `eval_stdin SyntaxError`
 * signatures.
 *
 * The pure analyzer is tested without filesystem mocking; the probe
 * wrapper is tested against a tmp logs dir.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  utimesSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  analyzeHookDeliveryFromLog,
  probeHookDeliveryHealth,
  readLogTail,
} from "../cli/commands/doctor.js";

// ── analyzeHookDeliveryFromLog (pure) ────────────────────────────────────────

describe("analyzeHookDeliveryFromLog (pure analyzer)", () => {
  it("returns ok when log has no hook errors", () => {
    const content = `2026-05-24T10:50:53.283Z [INFO] Using default model: claude-opus-4.6
2026-05-24T10:50:53.287Z [INFO] Content exclusion service initialized
2026-05-24T10:51:43.870Z [INFO] Hook completed successfully
`;
    const result = analyzeHookDeliveryFromLog(content, "process-clean.log");
    expect(result.level).toBe("ok");
    expect(result.detail).toContain("latest log clean");
    expect(result.detail).toContain("process-clean.log");
  });

  it("warns when log contains eval_stdin upstream-bug signature", () => {
    // Captured from the v1.4 live smoke log:
    // ~/.copilot/logs/process-1779619848009-3792.log
    const content = `2026-05-24T10:51:43.223Z [ERROR] Hook execution failed: HookExitCodeError: Hook command failed with code 1
Stderr: [stdin]:1
{"hook_event_name":"Stop","session_id":"abc","stop_reason":"end_turn"}
                  ^
Expected ';', '}' or <eof>

SyntaxError: Unexpected token ':'
    at makeContextifyScript (node:internal/vm:194:14)
    at evalTypeScript (node:internal/process/execution:260:22)
    at node:internal/main/eval_stdin:51:5
`;
    const result = analyzeHookDeliveryFromLog(content, "process-1779619848009-3792.log");
    expect(result.level).toBe("warn");
    expect(result.detail).toMatch(/eval_stdin failures/);
    expect(result.detail).toContain("upstream Copilot");
    expect(result.detail).toContain("copilot-pwsh-dispatch-v1.5-investigation.md");
    expect(result.detail).toContain("process-1779619848009-3792.log");
  });

  it("counts multiple eval_stdin occurrences correctly", () => {
    const oneError = `[ERROR] HookExitCodeError: code 1
at node:internal/main/eval_stdin:51:5
`;
    const content = oneError.repeat(36);
    const result = analyzeHookDeliveryFromLog(content, "x.log");
    expect(result.level).toBe("warn");
    expect(result.detail).toContain("36 eval_stdin");
  });

  it("warns differently when HookExitCodeError exists WITHOUT eval_stdin (non-upstream cause)", () => {
    // This is the pre-v1.4 stale-settings.json signature OR a handler
    // bug — handler RAN and exited 1 for some reason other than the
    // upstream eval_stdin bug. Different remediation than the upstream
    // case.
    const content = `[ERROR] Hook execution failed: HookExitCodeError: Hook command failed with code 1
Stderr: Error: Cannot find module 'C:\\path\\to\\missing-script.cjs'
`;
    const result = analyzeHookDeliveryFromLog(content, "process-handler-bug.log");
    expect(result.level).toBe("warn");
    expect(result.detail).toContain("HookExitCodeError");
    expect(result.detail).toContain("non-eval_stdin");
    expect(result.detail).not.toContain("upstream Copilot");
  });

  it("eval_stdin takes precedence over plain HookExitCodeError when both present", () => {
    const content = `[ERROR] HookExitCodeError: Hook command failed with code 1
at node:internal/main/eval_stdin:51:5
[ERROR] HookExitCodeError: Hook command failed with code 1
unrelated stderr
`;
    const result = analyzeHookDeliveryFromLog(content, "mixed.log");
    expect(result.level).toBe("warn");
    expect(result.detail).toContain("upstream Copilot");
  });

  it("empty log → ok", () => {
    const result = analyzeHookDeliveryFromLog("", "empty.log");
    expect(result.level).toBe("ok");
  });
});

// ── probeHookDeliveryHealth (filesystem) ─────────────────────────────────────

describe("probeHookDeliveryHealth (filesystem probe)", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "omcp-doctor-hook-"));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("returns ok when logs directory does not exist", () => {
    const result = probeHookDeliveryHealth(join(tmp, "logs-not-here"));
    expect(result.level).toBe("ok");
    expect(result.detail).toContain("no Copilot logs directory yet");
  });

  it("returns ok when logs directory is empty", () => {
    const result = probeHookDeliveryHealth(tmp);
    expect(result.level).toBe("ok");
    expect(result.detail).toContain("no Copilot log files yet");
  });

  it("ignores non-Copilot files (only process-*.log scanned)", () => {
    writeFileSync(join(tmp, "random.txt"), "node:internal/main/eval_stdin");
    writeFileSync(join(tmp, "rotated.gz"), "node:internal/main/eval_stdin");
    const result = probeHookDeliveryHealth(tmp);
    expect(result.level).toBe("ok");
    expect(result.detail).toContain("no Copilot log files");
  });

  it("picks the MOST RECENT log when multiple exist", () => {
    const oldLogPath = join(tmp, "process-old-111.log");
    const newLogPath = join(tmp, "process-new-222.log");
    writeFileSync(
      oldLogPath,
      `[ERROR] HookExitCodeError: code 1
at node:internal/main/eval_stdin:51:5
`,
    );
    writeFileSync(newLogPath, "clean log — no errors\n");
    // Force older mtime on the old log.
    const olderTime = new Date(Date.now() - 60_000);
    utimesSync(oldLogPath, olderTime, olderTime);
    const result = probeHookDeliveryHealth(tmp);
    expect(result.level).toBe("ok");
    expect(result.detail).toContain("process-new-222.log");
  });

  it("warns when the most recent log contains eval_stdin signature", () => {
    writeFileSync(
      join(tmp, "process-bug.log"),
      `[ERROR] HookExitCodeError: code 1
at node:internal/main/eval_stdin:51:5
`,
    );
    const result = probeHookDeliveryHealth(tmp);
    expect(result.level).toBe("warn");
    expect(result.detail).toContain("eval_stdin failures");
    expect(result.detail).toContain("process-bug.log");
  });
});

// ── readLogTail (large-file safety) ──────────────────────────────────────────

describe("readLogTail (bounded log read)", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "omcp-log-tail-"));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("returns full content when file is smaller than the tail window", () => {
    const file = join(tmp, "small.log");
    const content = "tiny log content\nline 2\n";
    writeFileSync(file, content);
    expect(readLogTail(file)).toBe(content);
  });

  it("returns only the trailing 512KB when file exceeds the window", () => {
    // Build a file that is window_size + filler so we can verify the tail
    // contains only the trailing portion. Each row is fixed-width to make
    // counting deterministic.
    const file = join(tmp, "big.log");
    const filler = "A".repeat(1024) + "\n"; // 1025 bytes per row
    const tailMarker = "EVAL_STDIN_TAIL_MARKER";
    // Write ~1 MB of filler, then the tail marker, then more filler so
    // the marker lands inside the last 512KB window.
    const HEAD_SIZE = 768 * 1024; // 768 KB head (outside window)
    const headRows = Math.ceil(HEAD_SIZE / filler.length);
    let body = filler.repeat(headRows);
    body += tailMarker + "\n";
    // Pad after the marker so the marker is in the middle of the tail.
    body += filler.repeat(100); // ~100 KB after marker
    writeFileSync(file, body);

    const tail = readLogTail(file);
    expect(tail.length).toBeLessThanOrEqual(512 * 1024);
    expect(tail).toContain(tailMarker);
    // The first byte of the file ("A" inside filler) should be cut off.
    // (Concretely: the tail should NOT contain ALL the head filler — only
    // the trailing chunk of it.)
    expect(tail.length).toBeLessThan(body.length);
  });

  it("tail-read of a huge log still surfaces a trailing eval_stdin signature", () => {
    const file = join(tmp, "huge.log");
    const filler = "B".repeat(2048) + "\n";
    const errorBlock = `[ERROR] HookExitCodeError: code 1
at node:internal/main/eval_stdin:51:5
`;
    // 1 MB filler + error block at the end (well inside the 512KB window).
    const body = filler.repeat(500) + errorBlock;
    writeFileSync(file, body);

    const tail = readLogTail(file);
    const verdict = analyzeHookDeliveryFromLog(tail, "huge.log");
    expect(verdict.level).toBe("warn");
    expect(verdict.detail).toContain("eval_stdin failures");
  });
});
