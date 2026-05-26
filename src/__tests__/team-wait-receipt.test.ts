/**
 * RG-01 tests: dispatch_request_id + ack with receipt + idempotent consumption.
 *
 * Covers ADR-RG-01 acceptance criteria:
 *   - Leader writes outbox with request_id → worker writes ack with matching
 *     request_id → team-wait-receipt exits 0
 *   - Missing receipt → exits 3 (timeout)
 *   - SIGTERM-then-retry finds receipt in consumed-receipts.jsonl + exits 0
 *     without polling (PM-F idempotency)
 *   - Outbox records without request_id still parse (backwards-compat)
 *   - Stale ack (older than timeout × 2) is ignored + logged
 *   - Cross-fork attribution: foreign producer_fork is ignored + logged
 *   - Missing producer_fork is ignored + logged
 *   - Invalid UUIDv4 → exit 2
 *   - Invalid session-id slug → exit 2
 */

import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import {
  runTeamWaitReceipt,
  runTeamWaitReceiptCli,
  TEAM_WAIT_RECEIPT_DEFAULT_POLL_MS,
  TEAM_WAIT_RECEIPT_DEFAULT_TIMEOUT_MS,
  TEAM_WAIT_RECEIPT_STALE_TTL_MULTIPLIER,
} from "../cli/commands/team-wait-receipt.js";
import { PRODUCER_FORK_ID, isValidUuidV4 } from "../cli/commands/team-outbox.js";

const SID = "rg01-test-sid";

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "omcp-rg01-test-"));
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function ackPath(idx: number): string {
  return join(tmp, ".omcp", "state", "team", SID, `worker-${idx}-ack.json`);
}

function writeAck(idx: number, body: Record<string, unknown>): void {
  const dir = join(tmp, ".omcp", "state", "team", SID);
  mkdirSync(dir, { recursive: true });
  writeFileSync(ackPath(idx), JSON.stringify(body, null, 2), "utf8");
}

function consumedReceiptsPath(): string {
  return join(tmp, ".omcp", "state", "team", SID, "consumed-receipts.jsonl");
}

// ─── default-export sanity ──────────────────────────────────────────────────

describe("RG-01 defaults align with team-wait's existing constants", () => {
  it("default poll = 2000ms (matches TEAM_WAIT_POLL_INTERVAL_MS)", () => {
    expect(TEAM_WAIT_RECEIPT_DEFAULT_POLL_MS).toBe(2_000);
  });

  it("default timeout = 1,800,000ms (matches TEAM_WAIT_DEFAULT_TIMEOUT_MS)", () => {
    expect(TEAM_WAIT_RECEIPT_DEFAULT_TIMEOUT_MS).toBe(1_800_000);
  });

  it("stale-ack TTL multiplier = 2× timeout", () => {
    expect(TEAM_WAIT_RECEIPT_STALE_TTL_MULTIPLIER).toBe(2);
  });

  it("PRODUCER_FORK_ID = 'omcp-r2'", () => {
    expect(PRODUCER_FORK_ID).toBe("omcp-r2");
  });
});

// ─── UUIDv4 format guard ────────────────────────────────────────────────────

describe("isValidUuidV4 format guard", () => {
  it("accepts a real UUIDv4 from crypto.randomUUID", () => {
    expect(isValidUuidV4(randomUUID())).toBe(true);
  });

  it("rejects v3/v5/non-v4 UUIDs (the version nibble is wrong)", () => {
    expect(isValidUuidV4("01234567-89ab-1def-8123-0123456789ab")).toBe(false); // v1
    expect(isValidUuidV4("01234567-89ab-3def-8123-0123456789ab")).toBe(false); // v3
    expect(isValidUuidV4("01234567-89ab-5def-8123-0123456789ab")).toBe(false); // v5
  });

  it("rejects malformed inputs", () => {
    expect(isValidUuidV4("not-a-uuid")).toBe(false);
    expect(isValidUuidV4("")).toBe(false);
    expect(isValidUuidV4(undefined)).toBe(false);
    expect(isValidUuidV4(123)).toBe(false);
  });
});

// ─── argv validation ────────────────────────────────────────────────────────

describe("runTeamWaitReceipt — argv validation", () => {
  it("exits 2 on invalid session-id slug (path-traversal)", () => {
    const r = runTeamWaitReceipt({
      sessionId: "../escape",
      requestId: randomUUID(),
      cwd: tmp,
    });
    expect(r.exitCode).toBe(2);
  });

  it("exits 2 on non-UUIDv4 request-id", () => {
    const r = runTeamWaitReceipt({
      sessionId: SID,
      requestId: "not-a-uuid",
      cwd: tmp,
    });
    expect(r.exitCode).toBe(2);
  });

  it("exits 2 on non-positive timeoutMs", () => {
    const r = runTeamWaitReceipt({
      sessionId: SID,
      requestId: randomUUID(),
      cwd: tmp,
      timeoutMs: 0,
    });
    expect(r.exitCode).toBe(2);
  });

  it("exits 2 on non-positive pollMs", () => {
    const r = runTeamWaitReceipt({
      sessionId: SID,
      requestId: randomUUID(),
      cwd: tmp,
      pollMs: -100,
    });
    expect(r.exitCode).toBe(2);
  });
});

// ─── happy path: match an ack ───────────────────────────────────────────────

describe("runTeamWaitReceipt — happy path", () => {
  it("exits 0 when worker-N-ack.json has matching request_id + producer_fork", () => {
    const reqId = randomUUID();
    writeAck(1, {
      workerIndex: 1,
      ackedAt: new Date().toISOString(),
      request_id: reqId,
      producer_fork: PRODUCER_FORK_ID,
    });
    const r = runTeamWaitReceipt({
      sessionId: SID,
      requestId: reqId,
      cwd: tmp,
      pollMs: 10,
      timeoutMs: 100,
    });
    expect(r.exitCode).toBe(0);
    expect(r.fromConsumedCache).toBe(false);
    expect(r.ackFile).toBe(ackPath(1));
    expect(r.ambiguousAttribution).toHaveLength(0);
  });

  it("writes the matched receipt to consumed-receipts.jsonl", () => {
    const reqId = randomUUID();
    writeAck(2, {
      workerIndex: 2,
      ackedAt: new Date().toISOString(),
      request_id: reqId,
      producer_fork: PRODUCER_FORK_ID,
    });
    runTeamWaitReceipt({
      sessionId: SID,
      requestId: reqId,
      cwd: tmp,
      pollMs: 10,
      timeoutMs: 100,
    });
    const consumed = readFileSync(consumedReceiptsPath(), "utf8");
    const lines = consumed.trim().split("\n");
    expect(lines).toHaveLength(1);
    const record = JSON.parse(lines[0]);
    expect(record.request_id).toBe(reqId);
    expect(record.producer_fork).toBe(PRODUCER_FORK_ID);
    expect(record.ackFile).toBe(ackPath(2));
    expect(typeof record.consumedAt).toBe("string");
  });
});

// ─── PM-F: idempotent SIGTERM-then-retry ────────────────────────────────────

describe("runTeamWaitReceipt — PM-F idempotent re-invocation", () => {
  it("returns 0 + fromConsumedCache=true when request_id already in consumed-receipts.jsonl", () => {
    const reqId = randomUUID();
    // Simulate prior wait that observed + recorded the receipt before SIGTERM.
    const dir = join(tmp, ".omcp", "state", "team", SID);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      consumedReceiptsPath(),
      `${JSON.stringify({
        request_id: reqId,
        producer_fork: PRODUCER_FORK_ID,
        ackFile: "/dev/null/synthetic-prior-ack",
        consumedAt: new Date().toISOString(),
      })}\n`,
      "utf8",
    );
    // Even with NO worker ack files present, the retry call exits 0 from cache.
    const r = runTeamWaitReceipt({
      sessionId: SID,
      requestId: reqId,
      cwd: tmp,
      pollMs: 10,
      timeoutMs: 100,
    });
    expect(r.exitCode).toBe(0);
    expect(r.fromConsumedCache).toBe(true);
    expect(r.ackFile).toBe("/dev/null/synthetic-prior-ack");
    expect(r.polls).toBe(0);
  });

  it("ignores foreign-fork records in consumed-receipts.jsonl (cross-fork safety)", () => {
    const reqId = randomUUID();
    const dir = join(tmp, ".omcp", "state", "team", SID);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      consumedReceiptsPath(),
      `${JSON.stringify({
        request_id: reqId,
        producer_fork: "robinnorberg-omcp",
        ackFile: "/foreign-ack",
        consumedAt: new Date().toISOString(),
      })}\n`,
      "utf8",
    );
    const r = runTeamWaitReceipt({
      sessionId: SID,
      requestId: reqId,
      cwd: tmp,
      pollMs: 5,
      timeoutMs: 50,
    });
    expect(r.exitCode).toBe(3); // timeout — foreign fork ignored
    expect(r.fromConsumedCache).toBe(false);
  });

  it("tolerates malformed lines in consumed-receipts.jsonl (skip + continue)", () => {
    const reqId = randomUUID();
    const dir = join(tmp, ".omcp", "state", "team", SID);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      consumedReceiptsPath(),
      `not valid json\n` +
        `${JSON.stringify({
          request_id: reqId,
          producer_fork: PRODUCER_FORK_ID,
          ackFile: "/synthetic-ack",
          consumedAt: new Date().toISOString(),
        })}\n` +
        `another bad line\n`,
      "utf8",
    );
    const r = runTeamWaitReceipt({
      sessionId: SID,
      requestId: reqId,
      cwd: tmp,
      pollMs: 5,
      timeoutMs: 50,
    });
    expect(r.exitCode).toBe(0);
    expect(r.fromConsumedCache).toBe(true);
  });
});

// ─── timeout path ───────────────────────────────────────────────────────────

describe("runTeamWaitReceipt — timeout", () => {
  it("exits 3 when no matching ack appears within timeout", () => {
    const reqId = randomUUID();
    const r = runTeamWaitReceipt({
      sessionId: SID,
      requestId: reqId,
      cwd: tmp,
      pollMs: 5,
      timeoutMs: 30,
    });
    expect(r.exitCode).toBe(3);
    expect(r.elapsedMs).toBeGreaterThanOrEqual(30);
    expect(r.polls).toBeGreaterThanOrEqual(1);
  });

  it("exits 3 when an ack exists but request_id mismatches", () => {
    const otherId = randomUUID();
    writeAck(1, {
      workerIndex: 1,
      ackedAt: new Date().toISOString(),
      request_id: otherId,
      producer_fork: PRODUCER_FORK_ID,
    });
    const r = runTeamWaitReceipt({
      sessionId: SID,
      requestId: randomUUID(),
      cwd: tmp,
      pollMs: 5,
      timeoutMs: 30,
    });
    expect(r.exitCode).toBe(3);
  });
});

// ─── cross-fork ambiguous-attribution ───────────────────────────────────────

describe("runTeamWaitReceipt — cross-fork attribution (C1 / ADR-RG-01)", () => {
  it("ignores ack with matching request_id but missing producer_fork; logs event", () => {
    const reqId = randomUUID();
    writeAck(1, {
      workerIndex: 1,
      ackedAt: new Date().toISOString(),
      request_id: reqId,
      // producer_fork omitted on purpose
    });
    const r = runTeamWaitReceipt({
      sessionId: SID,
      requestId: reqId,
      cwd: tmp,
      pollMs: 5,
      timeoutMs: 30,
    });
    expect(r.exitCode).toBe(3); // ignored → timeout
    // ambiguous attribution accumulated each poll; assert non-empty + correct reason
    expect(r.ambiguousAttribution.length).toBeGreaterThan(0);
    expect(r.ambiguousAttribution[0].reason).toContain("missing producer_fork");
  });

  it("ignores ack with matching request_id but foreign producer_fork; logs event", () => {
    const reqId = randomUUID();
    writeAck(1, {
      workerIndex: 1,
      ackedAt: new Date().toISOString(),
      request_id: reqId,
      producer_fork: "robinnorberg-omcp",
    });
    const r = runTeamWaitReceipt({
      sessionId: SID,
      requestId: reqId,
      cwd: tmp,
      pollMs: 5,
      timeoutMs: 30,
    });
    expect(r.exitCode).toBe(3);
    expect(r.ambiguousAttribution.length).toBeGreaterThan(0);
    expect(r.ambiguousAttribution[0].reason).toContain("foreign producer_fork");
  });
});

// ─── stale-ack TTL ──────────────────────────────────────────────────────────

describe("runTeamWaitReceipt — stale-ack TTL", () => {
  it("ignores acks older than timeout × stale-multiplier; logs event", () => {
    const reqId = randomUUID();
    // Forge a "long-ago" ack by setting ackedAt to 1 day ago.
    const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    writeAck(1, {
      workerIndex: 1,
      ackedAt: oneDayAgo,
      request_id: reqId,
      producer_fork: PRODUCER_FORK_ID,
    });
    const r = runTeamWaitReceipt({
      sessionId: SID,
      requestId: reqId,
      cwd: tmp,
      pollMs: 5,
      timeoutMs: 30, // stale-ttl = 60ms — far less than 1 day
    });
    expect(r.exitCode).toBe(3); // ignored → timeout
    const stale = r.ambiguousAttribution.find((a) => a.reason.includes("stale"));
    expect(stale).toBeDefined();
  });
});

// ─── CLI wrapper ────────────────────────────────────────────────────────────

describe("runTeamWaitReceiptCli — CLI wrapper", () => {
  it("returns 0 on cache hit + emits human-readable message", () => {
    const reqId = randomUUID();
    const dir = join(tmp, ".omcp", "state", "team", SID);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      consumedReceiptsPath(),
      `${JSON.stringify({
        request_id: reqId,
        producer_fork: PRODUCER_FORK_ID,
        ackFile: "/cached-ack",
        consumedAt: new Date().toISOString(),
      })}\n`,
      "utf8",
    );
    const logs: string[] = [];
    const errs: string[] = [];
    const exit = runTeamWaitReceiptCli(SID, reqId, {
      cwd: tmp,
      pollMs: 5,
      timeoutMs: 50,
      log: (l) => logs.push(l),
      errLog: (l) => errs.push(l),
    });
    expect(exit).toBe(0);
    expect(logs.some((l) => l.includes("already consumed"))).toBe(true);
    expect(errs).toHaveLength(0);
  });

  it("returns 2 on malformed UUIDv4 + emits human-readable error", () => {
    const errs: string[] = [];
    const exit = runTeamWaitReceiptCli(SID, "not-a-uuid", {
      cwd: tmp,
      errLog: (l) => errs.push(l),
    });
    expect(exit).toBe(2);
    expect(errs.some((l) => l.includes("must be UUIDv4"))).toBe(true);
  });

  it("returns 3 on timeout + emits human-readable error", () => {
    const errs: string[] = [];
    const exit = runTeamWaitReceiptCli(SID, randomUUID(), {
      cwd: tmp,
      pollMs: 5,
      timeoutMs: 30,
      errLog: (l) => errs.push(l),
    });
    expect(exit).toBe(3);
    expect(errs.some((l) => l.includes("timeout"))).toBe(true);
  });
});

// ─── ensures consumed-receipts dir is created when missing ──────────────────

describe("runTeamWaitReceipt — directory lifecycle", () => {
  it("creates the team dir + consumed-receipts.jsonl on first successful match", () => {
    const reqId = randomUUID();
    writeAck(1, {
      workerIndex: 1,
      ackedAt: new Date().toISOString(),
      request_id: reqId,
      producer_fork: PRODUCER_FORK_ID,
    });
    runTeamWaitReceipt({
      sessionId: SID,
      requestId: reqId,
      cwd: tmp,
      pollMs: 5,
      timeoutMs: 50,
    });
    expect(existsSync(consumedReceiptsPath())).toBe(true);
  });
});
