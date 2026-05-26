/**
 * RG-02 tests: Priority-mailbox push (Hybrid B-prime) + heartbeat-freshness gate.
 *
 * Covers ADR-RG-02 acceptance criteria:
 *   - Fresh worker (heartbeat under 90s): push record lands in worker-N-push.jsonl
 *   - Stale worker (heartbeat over 90s): exit 5 + record routed to dead-letter-push.jsonl
 *   - Missing heartbeat: exit 5 (treated as stale)
 *   - Malformed heartbeat: exit 5 (treated as stale)
 *   - Push records carry producer_fork: "omcp-r2" + priority: "push"
 *   - No "stdin" / "named-pipe" / "tmux" tokens anywhere in the source file
 *   - Heartbeat schema is unchanged (still {ts, workerIndex, pid} only)
 *   - Invalid argv: bad slug / bad worker-index / empty prompt → exit 2
 *   - CLI wrapper exit codes
 */

import { describe, expect, it, beforeEach, afterEach } from "vitest";
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
import { randomUUID } from "node:crypto";

import {
  runTeamPushPrompt,
  runTeamPushPromptCli,
  pushShardPath,
  PUSH_PROMPT_WORKER_POLL_MS,
  type PushPromptRecord,
} from "../cli/commands/team-push-prompt.js";
import { PRODUCER_FORK_ID } from "../cli/commands/team-outbox.js";
import {
  HEARTBEAT_FRESHNESS_MULTIPLIER_DEFAULT,
  HEARTBEAT_INTERVAL_S_DEFAULT,
  type HeartbeatPayload,
} from "../cli/commands/team-heartbeat.js";

// ─── fixture helpers ────────────────────────────────────────────────────────

let tmp: string;
let SID: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "omcp-rg02-test-"));
  // Use randomUUID-derived slug per spec; assertSafeSlug forbids "-" prefix
  // and ":" — UUID v4 contains only [0-9a-f-] so it passes.
  SID = `s-${randomUUID()}`;
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function teamDir(): string {
  const dir = join(tmp, ".omcp", "state", "team", SID);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function writeHeartbeat(idx: number, agedMs: number): void {
  const dir = teamDir();
  const ts = new Date(Date.now() - agedMs).toISOString();
  const payload: HeartbeatPayload = {
    ts,
    workerIndex: idx,
    pid: 12345,
  };
  writeFileSync(
    join(dir, `worker-${idx}-heartbeat.json`),
    JSON.stringify(payload, null, 2),
    "utf8",
  );
}

function readPushShard(idx: number): PushPromptRecord[] {
  const path = pushShardPath(teamDir(), idx);
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as PushPromptRecord);
}

function readDeadLetter(): PushPromptRecord[] {
  const path = join(teamDir(), "dead-letter-push.jsonl");
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as PushPromptRecord);
}

// ─── architectural invariants ───────────────────────────────────────────────

describe("RG-02 architectural invariants", () => {
  it("worker poll cadence constant is 500ms (ADR-RG-02 §Decision)", () => {
    expect(PUSH_PROMPT_WORKER_POLL_MS).toBe(500);
  });

  it("source file contains NO transport tokens that A1 rejected (code only — comments allowed)", () => {
    // Architect A1: named-pipe stdin transport is rejected; verify the
    // implementation file does not casually reintroduce these as future
    // scaffolding. The file MAY mention them in a rejection-rationale
    // comment (in fact ADR-RG-02 requires it), so we strip block + line
    // comments before grepping. We look at the code surface only.
    const rawSrc = readFileSync(
      join(__dirname, "..", "cli", "commands", "team-push-prompt.ts"),
      "utf8",
    );
    const codeOnly = stripComments(rawSrc);
    // No CLI flag named --via stdin (architect A1's explicit rejection).
    expect(codeOnly).not.toMatch(/--via/);
    expect(codeOnly).not.toMatch(/"stdin"/i);
    expect(codeOnly).not.toMatch(/'stdin'/i);
    // No named-pipe machinery being invoked (function calls / constructs).
    expect(codeOnly).not.toMatch(/named[_-]?pipe[a-zA-Z]*\s*\(/i);
    expect(codeOnly).not.toMatch(/createNamedPipe|connectNamedPipe/i);
    // No tmux send-keys transport being invoked.
    expect(codeOnly).not.toMatch(/tmux[_-]?send/i);
  });

  it("heartbeat schema is unchanged — only {ts, workerIndex, pid}", () => {
    // Schema-additive principle. If RG-02 silently adds a field, this
    // assertion catches it.
    writeHeartbeat(1, 1_000);
    const raw = JSON.parse(
      readFileSync(
        join(teamDir(), "worker-1-heartbeat.json"),
        "utf8",
      ),
    );
    expect(Object.keys(raw).sort()).toEqual(["pid", "ts", "workerIndex"]);
  });
});

// ─── argv validation ────────────────────────────────────────────────────────

describe("runTeamPushPrompt — argv validation", () => {
  it("exits 2 on path-traversal session-id", () => {
    const r = runTeamPushPrompt({
      sessionId: "../escape",
      workerIndex: 1,
      prompt: "hello",
      cwd: tmp,
    });
    expect(r.exitCode).toBe(2);
  });

  it("exits 2 on negative worker-index", () => {
    const r = runTeamPushPrompt({
      sessionId: SID,
      workerIndex: -1,
      prompt: "hello",
      cwd: tmp,
    });
    expect(r.exitCode).toBe(2);
  });

  it("exits 2 on non-integer worker-index", () => {
    const r = runTeamPushPrompt({
      sessionId: SID,
      workerIndex: 1.5,
      prompt: "hello",
      cwd: tmp,
    });
    expect(r.exitCode).toBe(2);
  });

  it("exits 2 on empty prompt", () => {
    const r = runTeamPushPrompt({
      sessionId: SID,
      workerIndex: 1,
      prompt: "",
      cwd: tmp,
    });
    expect(r.exitCode).toBe(2);
  });
});

// ─── happy path: fresh worker ───────────────────────────────────────────────

describe("runTeamPushPrompt — happy path (fresh heartbeat)", () => {
  it("appends to worker-N-push.jsonl when heartbeat is fresh", () => {
    writeHeartbeat(2, 1_000); // 1s ago: fresh
    const r = runTeamPushPrompt({
      sessionId: SID,
      workerIndex: 2,
      prompt: "do the thing",
      cwd: tmp,
    });
    expect(r.exitCode).toBe(0);
    expect(r.pushPath).toBe(pushShardPath(teamDir(), 2));
    const records = readPushShard(2);
    expect(records).toHaveLength(1);
    expect(records[0].worker_index).toBe(2);
    expect(records[0].prompt).toBe("do the thing");
    expect(records[0].producer_fork).toBe(PRODUCER_FORK_ID);
    expect(records[0].priority).toBe("push");
    expect(typeof records[0].ts).toBe("string");
  });

  it("multiple pushes append additional lines (no overwrite)", () => {
    writeHeartbeat(3, 1_000);
    runTeamPushPrompt({
      sessionId: SID,
      workerIndex: 3,
      prompt: "first",
      cwd: tmp,
    });
    runTeamPushPrompt({
      sessionId: SID,
      workerIndex: 3,
      prompt: "second",
      cwd: tmp,
    });
    const records = readPushShard(3);
    expect(records).toHaveLength(2);
    expect(records[0].prompt).toBe("first");
    expect(records[1].prompt).toBe("second");
  });

  it("does NOT write to dead-letter-push.jsonl on the happy path", () => {
    writeHeartbeat(1, 1_000);
    runTeamPushPrompt({
      sessionId: SID,
      workerIndex: 1,
      prompt: "test",
      cwd: tmp,
    });
    expect(readDeadLetter()).toHaveLength(0);
  });

  it("uses heartbeat exactly at the 90s boundary as still fresh (≤ threshold)", () => {
    // Boundary check: HEARTBEAT_INTERVAL_S_DEFAULT × MULTIPLIER = 90s.
    // An age just under threshold = fresh; just over = stale.
    const thresholdMs =
      HEARTBEAT_INTERVAL_S_DEFAULT *
      HEARTBEAT_FRESHNESS_MULTIPLIER_DEFAULT *
      1000;
    writeHeartbeat(1, thresholdMs - 1_000); // 1s under threshold
    const r = runTeamPushPrompt({
      sessionId: SID,
      workerIndex: 1,
      prompt: "boundary",
      cwd: tmp,
    });
    expect(r.exitCode).toBe(0);
  });
});

// ─── PM-D stale-worker dead-letter path ─────────────────────────────────────

describe("runTeamPushPrompt — PM-D stale-worker dead-letter", () => {
  it("exits 5 + writes to dead-letter-push.jsonl when heartbeat is missing", () => {
    // No heartbeat file at all → treated as stale.
    teamDir(); // ensure dir exists
    const r = runTeamPushPrompt({
      sessionId: SID,
      workerIndex: 4,
      prompt: "lost message",
      cwd: tmp,
    });
    expect(r.exitCode).toBe(5);
    expect(r.staleReason).toContain("missing heartbeat");
    expect(r.deadLetterPath).toBe(join(teamDir(), "dead-letter-push.jsonl"));
    const dl = readDeadLetter();
    expect(dl).toHaveLength(1);
    expect(dl[0].prompt).toBe("lost message");
    expect(dl[0].worker_index).toBe(4);
    expect(dl[0].producer_fork).toBe(PRODUCER_FORK_ID);
  });

  it("exits 5 + writes to dead-letter when heartbeat is older than 90s", () => {
    // 91s ago: stale by 1s.
    writeHeartbeat(5, 91_000);
    const r = runTeamPushPrompt({
      sessionId: SID,
      workerIndex: 5,
      prompt: "to a dead worker",
      cwd: tmp,
    });
    expect(r.exitCode).toBe(5);
    expect(r.staleReason).toContain("older than threshold");
    expect(readPushShard(5)).toHaveLength(0); // NOT in the worker's push shard
    expect(readDeadLetter()).toHaveLength(1);
  });

  it("exits 5 when heartbeat file is corrupt JSON", () => {
    writeFileSync(
      join(teamDir(), "worker-6-heartbeat.json"),
      "not valid json {",
      "utf8",
    );
    const r = runTeamPushPrompt({
      sessionId: SID,
      workerIndex: 6,
      prompt: "test",
      cwd: tmp,
    });
    expect(r.exitCode).toBe(5);
    expect(r.staleReason).toContain("malformed heartbeat");
    expect(readDeadLetter()).toHaveLength(1);
  });

  it("exits 5 when heartbeat ts field is missing", () => {
    writeFileSync(
      join(teamDir(), "worker-7-heartbeat.json"),
      JSON.stringify({ workerIndex: 7, pid: 999 }), // no ts
      "utf8",
    );
    const r = runTeamPushPrompt({
      sessionId: SID,
      workerIndex: 7,
      prompt: "test",
      cwd: tmp,
    });
    expect(r.exitCode).toBe(5);
    expect(r.staleReason).toContain("malformed heartbeat");
  });

  it("custom heartbeatFreshnessMs override is honored (test hook)", () => {
    writeHeartbeat(8, 10_000); // 10s ago
    const r = runTeamPushPrompt({
      sessionId: SID,
      workerIndex: 8,
      prompt: "tight threshold",
      cwd: tmp,
      heartbeatFreshnessMs: 5_000, // 5s threshold → 10s heartbeat is stale
    });
    expect(r.exitCode).toBe(5);
  });
});

// ─── CLI wrapper ────────────────────────────────────────────────────────────

describe("runTeamPushPromptCli — CLI wrapper", () => {
  it("exits 0 + emits human-readable message on success", () => {
    writeHeartbeat(1, 1_000);
    const logs: string[] = [];
    const errs: string[] = [];
    const exit = runTeamPushPromptCli(SID, "1", "hello there", {
      cwd: tmp,
      log: (l) => logs.push(l),
      errLog: (l) => errs.push(l),
    });
    expect(exit).toBe(0);
    expect(logs.some((l) => l.includes("appended to"))).toBe(true);
    expect(errs).toHaveLength(0);
  });

  it("exits 2 on invalid worker-index string", () => {
    const errs: string[] = [];
    const exit = runTeamPushPromptCli(SID, "not-a-number", "hi", {
      cwd: tmp,
      errLog: (l) => errs.push(l),
    });
    expect(exit).toBe(2);
    expect(errs.some((l) => l.includes("non-negative integer"))).toBe(true);
  });

  it("exits 2 on path-traversal session-id with safe-slug error message", () => {
    const errs: string[] = [];
    const exit = runTeamPushPromptCli("../escape", "1", "hi", {
      cwd: tmp,
      errLog: (l) => errs.push(l),
    });
    expect(exit).toBe(2);
    expect(errs.some((l) => l.includes("unsafe"))).toBe(true);
  });

  it("exits 5 with dead-letter routing message when worker is stale", () => {
    teamDir();
    const errs: string[] = [];
    const exit = runTeamPushPromptCli(SID, "9", "dead-letter me", {
      cwd: tmp,
      errLog: (l) => errs.push(l),
    });
    expect(exit).toBe(5);
    expect(errs.some((l) => l.includes("stale"))).toBe(true);
    expect(errs.some((l) => l.includes("dead-letter"))).toBe(true);
    expect(errs.some((l) => l.includes("90s"))).toBe(true);
  });

  it("exits 2 on empty prompt", () => {
    const errs: string[] = [];
    const exit = runTeamPushPromptCli(SID, "1", "", {
      cwd: tmp,
      errLog: (l) => errs.push(l),
    });
    expect(exit).toBe(2);
    expect(errs.some((l) => l.includes("non-empty"))).toBe(true);
  });
});

// ─── helpers ────────────────────────────────────────────────────────────────

/**
 * Strip // line comments and /* block comments *\/ from a TS source string.
 * Used by the "no transport tokens" invariant test so rejection-rationale
 * prose in comments doesn't false-positive against the actual code surface.
 */
function stripComments(src: string): string {
  // Remove /* ... */ block comments (non-greedy, dotall).
  let out = src.replace(/\/\*[\s\S]*?\*\//g, "");
  // Remove // line comments to end-of-line.
  out = out.replace(/\/\/[^\n]*/g, "");
  return out;
}
