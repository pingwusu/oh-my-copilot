// Tests for runTeamAck / runTeamAckCli (L2.7 worker-side shutdown ack).

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { runTeamAck, runTeamAckCli } from "../team-ack.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "omcp-team-ack-test-"));
}

function ackFilePath(cwd: string, sessionId: string, workerIndex: number): string {
  return path.join(cwd, ".omcp", "state", "team", sessionId, `worker-${workerIndex}-ack.json`);
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("runTeamAck", () => {
  let cwd: string;

  beforeEach(() => {
    cwd = tempDir();
  });

  afterEach(() => {
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  // AC-1: Happy path — writes ack file with correct JSON shape.
  it("writes worker-K-ack.json with correct workerIndex and ackedAt fields", () => {
    const sessionId = "test-session-001";
    const workerIndex = 3;

    const result = runTeamAck({ sessionId, workerIndex, cwd });

    expect(result.ackFile).toBe(ackFilePath(cwd, sessionId, workerIndex));
    expect(result.ackedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/); // ISO string

    expect(fs.existsSync(result.ackFile)).toBe(true);
    const parsed = JSON.parse(fs.readFileSync(result.ackFile, "utf8")) as {
      workerIndex: number;
      ackedAt: string;
    };
    expect(parsed.workerIndex).toBe(workerIndex);
    expect(parsed.ackedAt).toBe(result.ackedAt);
  });

  // AC-5: Idempotent — calling twice succeeds, second overwrites with new timestamp.
  it("is idempotent: second call overwrites the ack file with a fresh timestamp", () => {
    const sessionId = "idempotent-session";
    const workerIndex = 1;

    const r1 = runTeamAck({ sessionId, workerIndex, cwd });
    // Small delay to ensure timestamp differs (ISO strings include ms).
    const before = Date.now();
    while (Date.now() === before) { /* spin until ms ticks */ }
    const r2 = runTeamAck({ sessionId, workerIndex, cwd });

    expect(fs.existsSync(r2.ackFile)).toBe(true);
    const parsed = JSON.parse(fs.readFileSync(r2.ackFile, "utf8")) as {
      workerIndex: number;
      ackedAt: string;
    };
    expect(parsed.workerIndex).toBe(workerIndex);
    // Both calls succeed; second timestamp is >= first.
    expect(new Date(r2.ackedAt).getTime()).toBeGreaterThanOrEqual(
      new Date(r1.ackedAt).getTime(),
    );
  });

  // AC-6 (Bonus): Directory created if missing.
  it("creates the ack directory if it does not exist yet", () => {
    const sessionId = "new-session-dir";
    const workerIndex = 0;
    const dirPath = path.join(cwd, ".omcp", "state", "team", sessionId);

    expect(fs.existsSync(dirPath)).toBe(false);

    runTeamAck({ sessionId, workerIndex, cwd });

    expect(fs.existsSync(dirPath)).toBe(true);
    expect(fs.existsSync(ackFilePath(cwd, sessionId, workerIndex))).toBe(true);
  });
});

describe("runTeamAckCli", () => {
  let cwd: string;

  beforeEach(() => {
    cwd = tempDir();
  });

  afterEach(() => {
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  // AC-1 (CLI): Happy path — returns 0 and writes ack file.
  it("returns 0 on valid session-id and worker-index, writes ack file", () => {
    const code = runTeamAckCli("valid-session-1", "2", { cwd });
    expect(code).toBe(0);
    expect(fs.existsSync(ackFilePath(cwd, "valid-session-1", 2))).toBe(true);
  });

  // AC-2: assertSafeSlug rejects path-traversal session-id → exit 2.
  it("returns 2 and does not write file when session-id contains path traversal", () => {
    const code = runTeamAckCli("../escape", "1", { cwd });
    expect(code).toBe(2);
    // No directory should have been created under cwd for this bad slug.
    const dir = path.join(cwd, ".omcp", "state", "team");
    expect(fs.existsSync(dir)).toBe(false);
  });

  // AC-3: Non-integer worker-index → exit 2.
  it("returns 2 when worker-index is not an integer string", () => {
    const code = runTeamAckCli("good-session", "abc", { cwd });
    expect(code).toBe(2);
  });

  // AC-4: Negative worker-index → exit 2.
  it("returns 2 when worker-index is negative", () => {
    const code = runTeamAckCli("good-session", "-1", { cwd });
    expect(code).toBe(2);
  });

  // AC-5 (CLI): Idempotent — calling twice, both return 0.
  it("is idempotent: second CLI call returns 0 and overwrites ack file", () => {
    const code1 = runTeamAckCli("idem-session", "0", { cwd });
    const code2 = runTeamAckCli("idem-session", "0", { cwd });
    expect(code1).toBe(0);
    expect(code2).toBe(0);
    expect(fs.existsSync(ackFilePath(cwd, "idem-session", 0))).toBe(true);
  });

  // Extra: float string rejected.
  it("returns 2 when worker-index is a float string", () => {
    const code = runTeamAckCli("good-session", "1.5", { cwd });
    expect(code).toBe(2);
  });
});
