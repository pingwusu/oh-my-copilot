// `omcp team-ack <session-id> <worker-index>` — worker-side shutdown ack writer.
//
// Workers call this verb when they detect `.omcp/state/team/<sessionId>/shutdown-request.json`
// and are ready to exit. Writing the ack file unblocks the orchestrator's
// shutdownTeam() wait loop so it can skip the SIGTERM fallback for this worker.
//
// Idempotent: calling twice overwrites the ack with a fresh timestamp. This is
// intentional — a re-spawned or retrying worker can safely re-ack.

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { atomicWriteFileSync } from "../../runtime/atomic-write.js";
import { assertSafeSlug, UnsafeSlugError } from "../../runtime/safe-slug.js";

export interface TeamAckOptions {
  sessionId: string;
  workerIndex: number;
  /** Override working directory (default: process.cwd()). Test hook. */
  cwd?: string;
}

export interface TeamAckResult {
  ackFile: string;
  ackedAt: string;
}

/**
 * Write the worker-K-ack.json file for a team session, signalling to the
 * orchestrator that this worker has completed graceful shutdown.
 *
 * Throws with exit code 2 semantics on invalid input — callers (the CLI
 * action) should catch and set process.exitCode = 2.
 */
export function runTeamAck(opts: TeamAckOptions): TeamAckResult {
  const { sessionId, workerIndex } = opts;
  const cwd = opts.cwd ?? process.cwd();

  // Defense-in-depth (Critic iter-1 of v1.2): even though runTeamAckCli already
  // validates sessionId, programmatic callers that skip the CLI wrapper must
  // not be able to slip a path-traversal slug through.
  assertSafeSlug(sessionId, "session-id");
  if (!Number.isInteger(workerIndex) || workerIndex < 0) {
    throw new Error(
      `runTeamAck: workerIndex must be a non-negative integer (got: ${workerIndex})`,
    );
  }

  const ackDir = join(cwd, ".omcp", "state", "team", sessionId);
  mkdirSync(ackDir, { recursive: true });

  const ackedAt = new Date().toISOString();
  const ackFile = join(ackDir, `worker-${workerIndex}-ack.json`);
  atomicWriteFileSync(
    ackFile,
    JSON.stringify({ workerIndex, ackedAt }, null, 2),
  );

  return { ackFile, ackedAt };
}

/**
 * Parse and validate CLI args for `omcp team-ack <session-id> <worker-index>`.
 * Returns exit code 2 + prints error on invalid input.
 * Returns 0 on success.
 */
export function runTeamAckCli(
  sessionId: string,
  workerIndexStr: string,
  opts: { cwd?: string } = {},
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

  try {
    const result = runTeamAck({ sessionId, workerIndex, cwd: opts.cwd });
    console.log(`omcp team-ack: wrote ${result.ackFile}`);
    console.log(`  ackedAt: ${result.ackedAt}`);
    return 0;
  } catch (err) {
    console.error(`omcp team-ack: ${(err as Error).message}`);
    return 1;
  }
}
