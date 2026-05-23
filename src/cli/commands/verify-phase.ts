// `omcp verify-phase <phase-id>` — automate the team+critic verification
// protocol defined in docs/workflows/team-critic-verification.md.
//
// Step summary:
//   1. Read .omcp/state/verification/<phase-id>-submission.md (exit 2 if absent).
//   2. Spawn architect agent (copilot -p) with review prompt; capture stdout.
//   3. Spawn critic agent (independent session id); same shape.
//   4. Parse verdicts via detectVerdict().
//   5. Both APPROVE → write record, exit 0.
//      Either REJECT → write escalation record, exit 1.
//      Otherwise loop (max maxIterations); after maxIterations → exit 1.

import { type SpawnSyncReturns, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { assertSafeSlug } from "../../runtime/safe-slug.js";
import { atomicWriteFileSync } from "../../runtime/atomic-write.js";
import { detectVerdict } from "../../lib/ralph-state.js";

export interface VerifyPhaseOptions {
  phaseId: string;
  maxIterations?: number;
  /** Test hook — defaults to real spawnSync against `copilot`. */
  spawn?: (
    bin: string,
    args: string[],
  ) => Pick<SpawnSyncReturns<Buffer>, "status" | "stdout" | "stderr">;
  /** Test hook — override cwd used for state files. */
  cwd?: string;
  /** Test hook — injectable submission reader. */
  readSubmission?: (path: string) => string | null;
}

export interface VerifyPhaseResult {
  exitCode: number;
  iterations: number;
  architectVerdict?: string | null;
  criticVerdict?: string | null;
  recordPath?: string;
}

function verificationDir(cwd: string): string {
  return join(cwd, ".omcp", "state", "verification");
}

function submissionPath(cwd: string, phaseId: string): string {
  return join(verificationDir(cwd), `${phaseId}-submission.md`);
}

function makeRunId(): string {
  return `run-${Date.now()}-${Math.floor(Math.random() * 0xffff).toString(16).padStart(4, "0")}`;
}

const ARCHITECT_PROMPT_TEMPLATE = (submission: string) =>
  `You are an architect reviewer performing an independent code-review pass.\n\nReview the following executor submission against its stated acceptance criteria.\nReturn exactly one of these verdicts on its own line: APPROVE, ITERATE, or REJECT.\nFor ITERATE/REJECT include a numbered list of required changes.\nFor APPROVE include a one-paragraph rationale.\n\n---\n${submission}\n---`;

const CRITIC_PROMPT_TEMPLATE = (submission: string) =>
  `You are an independent critic reviewer performing a cross-check.\n\nReview the following executor submission for principle-option consistency,\nfair alternatives, risk mitigation, and concrete verification steps.\nReturn exactly one of these verdicts on its own line: APPROVE, ITERATE, or REJECT.\nThe critic is NOT required to agree with the architect.\n\n---\n${submission}\n---`;

export function runVerifyPhase(opts: VerifyPhaseOptions): VerifyPhaseResult {
  const cwd = opts.cwd ?? process.cwd();
  const maxIterations = opts.maxIterations ?? 5;

  // Validate phase-id via assertSafeSlug (invariant 1).
  let phaseId: string;
  try {
    phaseId = assertSafeSlug(opts.phaseId, "phase-id");
  } catch (err) {
    console.error(`omcp verify-phase: ${(err as Error).message}`);
    return { exitCode: 2, iterations: 0 };
  }

  const doSpawn =
    opts.spawn ??
    ((bin: string, args: string[]) =>
      spawnSync(bin, args, { encoding: "buffer", shell: false }));

  const doReadSubmission =
    opts.readSubmission ??
    ((p: string): string | null => {
      if (!existsSync(p)) return null;
      return readFileSync(p, "utf8");
    });

  const verDir = verificationDir(cwd);

  for (let iteration = 1; iteration <= maxIterations; iteration++) {
    // Re-read submission on each cycle (protocol Step 5 says re-read each cycle).
    const subPath = submissionPath(cwd, phaseId);
    const submission = doReadSubmission(subPath);
    if (submission === null) {
      console.error(
        `omcp verify-phase: submission file not found: ${subPath}`,
      );
      return { exitCode: 2, iterations: iteration - 1 };
    }

    // Spawn architect with a fresh session (no --resume / --inject).
    const architectArgs = ["-p", ARCHITECT_PROMPT_TEMPLATE(submission), "--allow-all-tools"];
    const architectResult = doSpawn("copilot", architectArgs);
    const architectStdout =
      architectResult.stdout instanceof Buffer
        ? architectResult.stdout.toString("utf8")
        : String(architectResult.stdout ?? "");
    const architectVerdict = detectVerdict(architectStdout);

    // Spawn critic with an independent session id (never injected into architect's session).
    const criticArgs = ["-p", CRITIC_PROMPT_TEMPLATE(submission), "--allow-all-tools"];
    const criticResult = doSpawn("copilot", criticArgs);
    const criticStdout =
      criticResult.stdout instanceof Buffer
        ? criticResult.stdout.toString("utf8")
        : String(criticResult.stdout ?? "");
    const criticVerdict = detectVerdict(criticStdout);

    const isReject =
      architectVerdict === "REJECT" || criticVerdict === "REJECT";
    const isBothApprove =
      architectVerdict === "APPROVE" && criticVerdict === "APPROVE";

    if (isBothApprove) {
      // Write pass record (invariant 2: atomicWriteFileSync).
      const runId = makeRunId();
      assertSafeSlug(runId, "run-id"); // invariant 1 on run-id
      try {
        mkdirSync(verDir, { recursive: true });
      } catch {
        // best-effort
      }
      const recordPath = join(verDir, `${phaseId}-${runId}.json`);
      atomicWriteFileSync(
        recordPath,
        JSON.stringify(
          {
            phaseId,
            runId,
            iteration,
            architectVerdict,
            criticVerdict,
            outcome: "PASS",
            t: new Date().toISOString(),
          },
          null,
          2,
        ),
      );
      return {
        exitCode: 0,
        iterations: iteration,
        architectVerdict,
        criticVerdict,
        recordPath,
      };
    }

    if (isReject || iteration === maxIterations) {
      // Write escalation record.
      const runId = "escalation";
      try {
        mkdirSync(verDir, { recursive: true });
      } catch {
        // best-effort
      }
      const recordPath = join(verDir, `${phaseId}-${runId}.json`);
      atomicWriteFileSync(
        recordPath,
        JSON.stringify(
          {
            phaseId,
            runId,
            iteration,
            architectVerdict,
            criticVerdict,
            outcome: isReject ? "REJECT" : "MAX_ITERATIONS",
            t: new Date().toISOString(),
          },
          null,
          2,
        ),
      );
      console.error(
        `omcp verify-phase: escalating after ${iteration} iteration(s) — ` +
          `architect=${architectVerdict ?? "null"} critic=${criticVerdict ?? "null"}`,
      );
      return {
        exitCode: 1,
        iterations: iteration,
        architectVerdict,
        criticVerdict,
        recordPath,
      };
    }

    // ITERATE: loop continues.
  }

  // Should not reach here — loop exits via return above.
  return { exitCode: 1, iterations: maxIterations };
}
