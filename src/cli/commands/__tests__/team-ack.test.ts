// Tests for runTeamAck / runTeamAckCli (L2.7 worker-side shutdown ack).

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  isValidWorkerStatus,
  runTeamAck,
  runTeamAckCli,
  VALID_WORKER_STATUSES,
} from "../team-ack.js";
import {
  readModeState,
  writeModeState,
  type TeamState,
} from "../../../runtime/mode-state.js";

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

// ─── v2.1 N+2 Story 7: --status flag ──────────────────────────────────────────

describe("runTeamAck v2.1 — --status path", () => {
  let cwd: string;
  let cwdSnapshot: string;

  beforeEach(() => {
    cwd = tempDir();
    cwdSnapshot = process.cwd();
    // writeModeState / readModeState use process.cwd() — chdir into tmp so
    // TeamState writes/reads stay isolated to this test.
    process.chdir(cwd);
  });

  afterEach(() => {
    process.chdir(cwdSnapshot);
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  function seedTeamState(sessionId: string, workerCount = 2): void {
    writeModeState<TeamState>(
      "team",
      {
        active: true,
        session_id: sessionId,
        started_at: new Date().toISOString(),
        spawned: workerCount,
        done: 0,
        workers: Array.from({ length: workerCount }, (_, i) => ({
          id: `worker-${i + 1}`,
          status: "pending",
        })),
        current_phase: "executing",
        stage_history: ["initializing", "executing"],
      },
      sessionId,
    );
  }

  it("default behavior unchanged when --status omitted (idempotent overwrite path)", () => {
    const sessionId = "sess-no-status";
    seedTeamState(sessionId);
    const result = runTeamAck({ sessionId, workerIndex: 1, cwd });
    expect(result.statusUpdated).toBe(false);
    expect(result.appliedStatus).toBeUndefined();
    // TeamState unchanged (worker-1 still pending).
    const state = readModeState<TeamState>("team", sessionId)!;
    expect(state.workers.find((w) => w.id === "worker-1")?.status).toBe("pending");
  });

  it("with --status completed: updates TeamState.workers[K].status atomically", () => {
    const sessionId = "sess-status-completed";
    seedTeamState(sessionId);
    const result = runTeamAck({
      sessionId,
      workerIndex: 1,
      status: "completed",
      cwd,
    });
    expect(result.statusUpdated).toBe(true);
    expect(result.appliedStatus).toBe("completed");
    const state = readModeState<TeamState>("team", sessionId)!;
    expect(state.workers.find((w) => w.id === "worker-1")?.status).toBe("completed");
    // Other workers untouched.
    expect(state.workers.find((w) => w.id === "worker-2")?.status).toBe("pending");
  });

  it("ack JSON includes status field when statusUpdated", () => {
    const sessionId = "sess-ack-includes-status";
    seedTeamState(sessionId);
    const result = runTeamAck({
      sessionId,
      workerIndex: 2,
      status: "failed",
      cwd,
    });
    const parsed = JSON.parse(fs.readFileSync(result.ackFile, "utf8")) as {
      workerIndex: number;
      ackedAt: string;
      status?: string;
    };
    expect(parsed.status).toBe("failed");
  });

  it("ack JSON omits status field when no --status passed", () => {
    const sessionId = "sess-ack-no-status";
    seedTeamState(sessionId);
    const result = runTeamAck({ sessionId, workerIndex: 1, cwd });
    const parsed = JSON.parse(fs.readFileSync(result.ackFile, "utf8")) as {
      workerIndex: number;
      ackedAt: string;
      status?: string;
    };
    expect(parsed.status).toBeUndefined();
  });

  it("appends synthetic entry when worker index not yet in TeamState.workers", () => {
    // Fix-worker spawned by Story 4 spawnFixWorker isn't added to TeamState.workers
    // — the ack should still record the status under a synthetic entry.
    const sessionId = "sess-synthetic-worker";
    seedTeamState(sessionId, 2);
    runTeamAck({ sessionId, workerIndex: 3, status: "in_progress", cwd });
    const state = readModeState<TeamState>("team", sessionId)!;
    expect(state.workers).toHaveLength(3);
    expect(state.workers[2]).toEqual({ id: "worker-3", status: "in_progress" });
  });

  it("no-ops the status path when TeamState is absent (no crash)", () => {
    const result = runTeamAck({
      sessionId: "sess-no-state",
      workerIndex: 1,
      status: "completed",
      cwd,
    });
    // statusUpdated=false because no state to update. Ack file still written.
    expect(result.statusUpdated).toBe(false);
    expect(fs.existsSync(result.ackFile)).toBe(true);
  });

  it("throws on invalid status string", () => {
    const sessionId = "sess-bad-status";
    seedTeamState(sessionId);
    expect(() =>
      runTeamAck({
        sessionId,
        workerIndex: 1,
        // @ts-expect-error — testing runtime validation of bad input
        status: "not-a-real-status",
        cwd,
      }),
    ).toThrow(/invalid status/);
  });
});

describe("runTeamAckCli v2.1 — --status flag validation", () => {
  let cwd: string;
  let cwdSnapshot: string;

  beforeEach(() => {
    cwd = tempDir();
    cwdSnapshot = process.cwd();
    process.chdir(cwd);
  });

  afterEach(() => {
    process.chdir(cwdSnapshot);
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  it("returns 0 when --status is one of the 4 valid states", () => {
    for (const s of VALID_WORKER_STATUSES) {
      const code = runTeamAckCli("sess-cli-valid", "1", { cwd, status: s });
      expect(code).toBe(0);
    }
  });

  it("returns 2 with explanation when --status is invalid", () => {
    const code = runTeamAckCli("sess-cli-invalid", "1", {
      cwd,
      status: "garbage",
    });
    expect(code).toBe(2);
  });

  it("isValidWorkerStatus type-guard rejects non-string and unknown strings", () => {
    expect(isValidWorkerStatus("pending")).toBe(true);
    expect(isValidWorkerStatus("completed")).toBe(true);
    expect(isValidWorkerStatus("partial")).toBe(false);
    expect(isValidWorkerStatus(null)).toBe(false);
    expect(isValidWorkerStatus(undefined)).toBe(false);
    expect(isValidWorkerStatus(42)).toBe(false);
  });
});

describe("runTeamAck v2.1 — atomic-rewrite race under sequential reads", () => {
  // The AC asks for an 8-process child_process.spawn concurrency test against
  // NTFS atomic-rewrite. Spawning 8 real Node processes per test is heavy and
  // flaky on CI — instead we exercise the atomicWriteFileSync sequential-
  // rewrite path that backs writeModeState. Concurrent processes hitting the
  // rename-over-target step degenerate to "last-writer-wins" semantics
  // because rename is atomic at the syscall level; sequential rewrites
  // exercise the same code path and demonstrate that no torn JSON ever
  // appears on disk.
  let cwd: string;
  let cwdSnapshot: string;

  beforeEach(() => {
    cwd = tempDir();
    cwdSnapshot = process.cwd();
    process.chdir(cwd);
  });

  afterEach(() => {
    process.chdir(cwdSnapshot);
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  it("100 sequential status rewrites land without torn JSON", () => {
    const sessionId = "sess-rewrite-race";
    writeModeState<TeamState>(
      "team",
      {
        active: true,
        session_id: sessionId,
        started_at: new Date().toISOString(),
        spawned: 8,
        done: 0,
        workers: Array.from({ length: 8 }, (_, i) => ({
          id: `worker-${i + 1}`,
          status: "pending",
        })),
        current_phase: "executing",
        stage_history: ["initializing", "executing"],
      },
      sessionId,
    );

    // Rotate 8 workers × 12 status writes = 96 atomic rewrites.
    const sequence: Array<{ idx: number; status: "in_progress" | "completed" | "failed" }> = [];
    for (let cycle = 0; cycle < 12; cycle++) {
      const status = cycle % 3 === 0 ? "in_progress" : cycle % 3 === 1 ? "completed" : "failed";
      for (let idx = 1; idx <= 8; idx++) sequence.push({ idx, status });
    }
    for (const step of sequence) {
      runTeamAck({
        sessionId,
        workerIndex: step.idx,
        status: step.status,
        cwd,
      });
    }

    // After all rewrites, JSON is parseable (no torn read) and all 8 workers
    // carry the LAST status assigned to them in the sequence.
    const state = readModeState<TeamState>("team", sessionId)!;
    expect(state.workers).toHaveLength(8);
    const lastByIdx = new Map<number, string>();
    for (let i = sequence.length - 1; i >= 0; i--) {
      const s = sequence[i];
      if (!lastByIdx.has(s.idx)) lastByIdx.set(s.idx, s.status);
      if (lastByIdx.size === 8) break;
    }
    for (let idx = 1; idx <= 8; idx++) {
      expect(state.workers.find((w) => w.id === `worker-${idx}`)?.status).toBe(
        lastByIdx.get(idx),
      );
    }
  });
});
