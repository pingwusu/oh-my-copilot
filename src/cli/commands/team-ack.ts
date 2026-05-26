// `omcp team-ack <session-id> <worker-index>` — worker-side shutdown ack writer.
//
// Workers call this verb when they detect `.omcp/state/team/<sessionId>/shutdown-request.json`
// and are ready to exit. Writing the ack file unblocks the orchestrator's
// shutdownTeam() wait loop so it can skip the SIGTERM fallback for this worker.
//
// Idempotent: calling twice overwrites the ack with a fresh timestamp. This is
// intentional — a re-spawned or retrying worker can safely re-ack.
//
// v2.1 N+2 Story 7 (US-omcp-parity-P2.5-ACK-status-flag): when --status is
// passed, runTeamAck additionally updates TeamState.workers[K].status before
// writing the ack JSON. Valid states: pending | in_progress | completed |
// failed. Default behavior (no --status) preserved verbatim.

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { atomicWriteFileSync } from "../../runtime/atomic-write.js";
import { assertSafeSlug, UnsafeSlugError } from "../../runtime/safe-slug.js";
import {
  readModeState,
  writeModeState,
  type TeamState,
} from "../../runtime/mode-state.js";
import { PRODUCER_FORK_ID } from "./team-outbox.js";

/** UUIDv4 format guard (RG-01) — duplicated from team-outbox to avoid cycle. */
const UUID_V4_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type WorkerStatus = "pending" | "in_progress" | "completed" | "failed";

export const VALID_WORKER_STATUSES: readonly WorkerStatus[] = [
  "pending",
  "in_progress",
  "completed",
  "failed",
];

export function isValidWorkerStatus(value: unknown): value is WorkerStatus {
  return (
    typeof value === "string" &&
    (VALID_WORKER_STATUSES as readonly string[]).includes(value)
  );
}

export interface TeamAckOptions {
  sessionId: string;
  workerIndex: number;
  /** Optional v2.1 status update for TeamState.workers[K].status. */
  status?: WorkerStatus;
  /** Override working directory (default: process.cwd()). Test hook. */
  cwd?: string;
  /**
   * Optional UUIDv4 receipt id — the request_id this ack is responding to.
   * Set by workers acknowledging a receipt-tracked outbox message so the
   * dispatching leader's team-wait-receipt can match on the (request_id,
   * producer_fork) pair. RG-01 / ADR-RG-01.
   */
  requestId?: string;
}

export interface TeamAckResult {
  ackFile: string;
  ackedAt: string;
  /** True when a TeamState.workers[K].status update was applied. */
  statusUpdated: boolean;
  /** Final status value after the call (only populated when statusUpdated). */
  appliedStatus?: WorkerStatus;
}

/**
 * Write the worker-K-ack.json file for a team session, signalling to the
 * orchestrator that this worker has completed graceful shutdown.
 *
 * When `status` is passed, additionally rewrites TeamState.workers[K].status
 * atomically BEFORE the ack file is written. The status update path goes
 * through writeModeState (Invariant 2 atomicWriteFileSync) so concurrent
 * worker-side calls are safe against torn JSON. The 8-process concurrency
 * test in src/__tests__/team-ack-status-concurrency.test.ts covers the
 * worst-case NTFS rewrite race.
 *
 * Throws with exit code 2 semantics on invalid input — callers (the CLI
 * action) should catch and set process.exitCode = 2.
 */
export function runTeamAck(opts: TeamAckOptions): TeamAckResult {
  const { sessionId, workerIndex, status, requestId } = opts;
  const cwd = opts.cwd ?? process.cwd();

  // RG-01: validate optional UUIDv4 request_id. Defense-in-depth — CLI
  // wrapper validates too, but programmatic callers can skip that path.
  if (requestId !== undefined && !UUID_V4_RE.test(requestId)) {
    throw new Error(
      `runTeamAck: requestId must be UUIDv4 (got: ${JSON.stringify(requestId)})`,
    );
  }

  // Defense-in-depth (Critic iter-1 of v1.2): even though runTeamAckCli already
  // validates sessionId, programmatic callers that skip the CLI wrapper must
  // not be able to slip a path-traversal slug through.
  assertSafeSlug(sessionId, "session-id");
  if (!Number.isInteger(workerIndex) || workerIndex < 0) {
    throw new Error(
      `runTeamAck: workerIndex must be a non-negative integer (got: ${workerIndex})`,
    );
  }

  // v2.1 N+2 Story 7: validate + apply status update first. Validation runs
  // before any file write so a malformed value cannot leave partial state.
  let statusUpdated = false;
  let appliedStatus: WorkerStatus | undefined;
  if (status !== undefined) {
    if (!isValidWorkerStatus(status)) {
      throw new Error(
        `runTeamAck: invalid status ${JSON.stringify(status)} (allowed: ${VALID_WORKER_STATUSES.join(", ")})`,
      );
    }
    // Apply through writeModeState so the rewrite is atomic (Invariant 2)
    // and concurrent worker calls race safely on the rename-over-target step.
    const state = readModeState<TeamState>("team", sessionId);
    if (state !== null) {
      const workers = Array.isArray(state.workers) ? [...state.workers] : [];
      // Match by 1-based worker id ("worker-K") OR by index position fallback.
      const targetId = `worker-${workerIndex}`;
      const idx = workers.findIndex((w) => w.id === targetId);
      if (idx >= 0) {
        workers[idx] = { ...workers[idx], status };
      } else {
        // Worker entry didn't exist (e.g., manually-spawned fix worker added
        // via Story 4 spawnFixWorker, which doesn't extend TeamState.workers).
        // Append a synthetic entry so the status is recorded.
        workers.push({ id: targetId, status });
      }
      writeModeState<TeamState>("team", { ...state, workers }, sessionId);
      statusUpdated = true;
      appliedStatus = status;
    }
  }

  const ackDir = join(cwd, ".omcp", "state", "team", sessionId);
  mkdirSync(ackDir, { recursive: true });

  const ackedAt = new Date().toISOString();
  const ackFile = join(ackDir, `worker-${workerIndex}-ack.json`);
  atomicWriteFileSync(
    ackFile,
    JSON.stringify(
      {
        workerIndex,
        ackedAt,
        ...(statusUpdated ? { status: appliedStatus } : {}),
        // RG-01: when a request_id was supplied, embed it + the
        // producer_fork stamp so leader-side team-wait-receipt can match.
        ...(requestId ? { request_id: requestId, producer_fork: PRODUCER_FORK_ID } : {}),
      },
      null,
      2,
    ),
  );

  return {
    ackFile,
    ackedAt,
    statusUpdated,
    appliedStatus,
  };
}

/**
 * Parse and validate CLI args for `omcp team-ack <session-id> <worker-index>
 * [--status <state>]`. Returns exit code 2 + prints error on invalid input.
 * Returns 0 on success.
 *
 * v2.1 N+2 Story 7: `--status <state>` is optional. When passed, the value
 * must be one of pending|in_progress|completed|failed; otherwise → exit 2.
 */
export function runTeamAckCli(
  sessionId: string,
  workerIndexStr: string,
  opts: { cwd?: string; status?: string; requestId?: string } = {},
): number {
  // Validate session-id.
  try {
    assertSafeSlug(sessionId, "session-id");
  } catch (err) {
    if (err instanceof UnsafeSlugError) {
      console.error(`omcp team-ack: ${err.message}`);
    } else {
      console.error(`omcp team-ack: invalid session-id`);
    }
    return 2;
  }

  // Validate worker-index: must be a non-negative integer string.
  const workerIndex = Number.parseInt(workerIndexStr, 10);
  if (
    !Number.isFinite(workerIndex) ||
    workerIndex < 0 ||
    String(workerIndex) !== workerIndexStr.trim()
  ) {
    console.error(
      `omcp team-ack: worker-index must be a non-negative integer (got: ${JSON.stringify(workerIndexStr)})`,
    );
    return 2;
  }

  // Validate --status if passed.
  let status: WorkerStatus | undefined;
  if (opts.status !== undefined) {
    if (!isValidWorkerStatus(opts.status)) {
      console.error(
        `omcp team-ack: --status must be one of ${VALID_WORKER_STATUSES.join(", ")} (got: ${JSON.stringify(opts.status)})`,
      );
      return 2;
    }
    status = opts.status;
  }

  // RG-01: validate optional --request-id (UUIDv4) at CLI boundary.
  if (opts.requestId !== undefined && !UUID_V4_RE.test(opts.requestId)) {
    console.error(
      `omcp team-ack: --request-id must be UUIDv4 (got: ${JSON.stringify(opts.requestId)})`,
    );
    return 2;
  }

  try {
    const result = runTeamAck({
      sessionId,
      workerIndex,
      status,
      cwd: opts.cwd,
      requestId: opts.requestId,
    });
    console.log(`omcp team-ack: wrote ${result.ackFile}`);
    console.log(`  ackedAt: ${result.ackedAt}`);
    if (result.statusUpdated) {
      console.log(`  status: ${result.appliedStatus}`);
    }
    return 0;
  } catch (err) {
    console.error(`omcp team-ack: ${(err as Error).message}`);
    return 1;
  }
}
