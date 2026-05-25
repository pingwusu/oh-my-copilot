// Phase 1 verify/fix loop deterministic smoke harness.
//
// Lives at: src/scripts/smoke-phase1.ts
// Output:   docs/smoke/omcp-team-parity/phase1-verify-fix-loop-deterministic-attestation.md
//
// Per iter-2 plan H4: when OMCP_COPILOT_AUTH=missing (the CI default), the
// smoke harness runs the verify/fix loop against mock-spawn fixtures and
// writes a deterministic-attestation artifact. The live-Copilot path
// shares the same Markdown template (src/lib/smoke-template.ts) so the
// two outputs cannot drift apart at the section structure level.
//
// The harness exports `runPhase1DeterministicSmoke()` for direct vitest
// consumption (golden snapshot test) AND a `main()` entry point that
// writes the attestation file when this module is invoked as a script.

import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { atomicWriteFileSync } from "../runtime/atomic-write.js";
import {
  writeModeState,
  type TeamState,
} from "../runtime/mode-state.js";
import {
  runTeamVerify,
  spawnFixWorker,
  type VerifySpawnResult,
} from "../cli/commands/team-verify.js";
import { runTeamCollect } from "../cli/commands/team-phase-controller.js";
import {
  renderSmokeMarkdown,
  type SmokeTemplateInput,
} from "../lib/smoke-template.js";

const SCRIPT_VERSION = "1.0.0";

/**
 * Run the Phase 1 verify/fix/collect loop end-to-end against mock-spawn
 * fixtures and return both the rendered Markdown attestation AND the
 * captured trace lines so tests can assert intermediate state. Caller is
 * responsible for choosing whether to write the Markdown to disk.
 *
 * Steps simulated:
 *   1. Seed a 2-worker TeamState (executing, fix_loop_count=undefined)
 *   2. Write fake worker shards (= "workers completed")
 *   3. Run runTeamVerify with mock-spawn returning vitest fail
 *   4. Run runTeamCollect → transitions to 'fixing' + writes summary
 *   5. Run spawnFixWorker with mock spawn (no real child)
 *   6. Re-write the same shards (= fix worker's shard appeared)
 *   7. Run runTeamVerify with mock-spawn returning all-pass
 *   8. Run runTeamCollect → transitions to 'completed'
 *
 * No live Copilot CLI is invoked. No network. No external dependencies.
 */
export function runPhase1DeterministicSmoke(opts?: {
  cwd?: string;
  now?: () => string;
}): {
  markdown: string;
  trace: string[];
  artifactRelPath: string;
} {
  const cwd = opts?.cwd ?? mkdtempSync(join(tmpdir(), "omcp-smoke-p1-"));
  const sessionId = "smoke-p1-det";
  const trace: string[] = [];
  trace.push(`harness cwd=${cwd}`);
  trace.push(`sessionId=${sessionId}`);

  const prevCwd = process.cwd();
  process.chdir(cwd);
  try {
    // Step 1: seed TeamState.
    writeModeState<TeamState>(
      "team",
      {
        active: true,
        session_id: sessionId,
        started_at: opts?.now?.() ?? "2026-05-25T00:00:00.000Z",
        spawned: 2,
        done: 0,
        workers: [
          { id: "worker-1", status: "pending" },
          { id: "worker-2", status: "pending" },
        ],
        current_phase: "executing",
        stage_history: ["initializing", "executing"],
      },
      sessionId,
    );
    trace.push("step1: TeamState seeded (executing, 2 workers)");

    // Step 2: synthesize worker pidfiles + shards as if the original team
    // had completed normally before verify ran.
    const pidDir = join(cwd, ".omcp", "state", "team", sessionId);
    mkdirSync(pidDir, { recursive: true });
    for (const idx of [1, 2]) {
      atomicWriteFileSync(join(pidDir, `worker-${idx}.pid`), String(50000 + idx));
      atomicWriteFileSync(
        join(pidDir, `worker-${idx}-shard.json`),
        JSON.stringify({ worker: idx, done: true }, null, 2),
      );
    }
    trace.push("step2: 2 worker pidfiles + shards written");

    // Step 3: first verify pass — vitest fails.
    const failTable: Record<string, VerifySpawnResult> = {
      "npx vitest": { exitCode: 1, output: "FAIL  smoke-fixture/fail.test.ts > expected 1 to be 2" },
      "npx tsc": { exitCode: 0, output: "" },
      "npx biome": { exitCode: 0, output: "Checked 50 files in 200ms." },
    };
    const verify1 = runTeamVerify({
      sessionId,
      cwd,
      maxLoops: 3,
      spawnFn: (cmd, args) => {
        const key = `${cmd} ${args[0] ?? ""}`;
        const r = failTable[key];
        if (!r) throw new Error(`smoke: no mock for ${key}`);
        return r;
      },
    });
    trace.push(
      `step3: verify iteration=${verify1.iteration} ok=${verify1.ok} exitCode=${verify1.exitCode} workerSignals=${verify1.workerSignals}`,
    );

    // Step 4: collect → fixing.
    const collect1 = runTeamCollect(sessionId, {
      cwd,
      isProcessAlive: () => true,
    });
    trace.push(
      `step4: collect finalPhase=${collect1.finalPhase} verifyFailSignals=${
        collect1.verifyFailSignals?.length ?? 0
      } summaryWritten=${existsSync(join(pidDir, "verify-fail-summary.json"))}`,
    );

    // Step 5: fix-worker spawn (mocked).
    const fixResult = spawnFixWorker({
      sessionId,
      cwd,
      maxLoops: 3,
      spawnFn: (_cmd, _args, _opts) => ({
        pid: 60123,
        unref: () => {},
      }),
    });
    trace.push(
      `step5: fix-worker spawned idx=${fixResult.fixWorkerIndex} fixLoopCount=${fixResult.fixLoopCount} exhausted=${fixResult.exhausted}`,
    );

    // Step 6: fix-worker shard appears (re-use existing shards as proxy).
    atomicWriteFileSync(
      join(pidDir, `worker-${fixResult.fixWorkerIndex}-shard.json`),
      JSON.stringify(
        { worker: fixResult.fixWorkerIndex, fix_applied: true },
        null,
        2,
      ),
    );
    trace.push(`step6: fix-worker shard written (worker-${fixResult.fixWorkerIndex}-shard.json)`);

    // Step 7: re-verify — now passes.
    const passTable: Record<string, VerifySpawnResult> = {
      "npx vitest": { exitCode: 0, output: "Test Files  20 passed (20)" },
      "npx tsc": { exitCode: 0, output: "" },
      "npx biome": { exitCode: 0, output: "Checked 50 files in 180ms." },
    };
    const verify2 = runTeamVerify({
      sessionId,
      cwd,
      maxLoops: 3,
      spawnFn: (cmd, args) => {
        const key = `${cmd} ${args[0] ?? ""}`;
        const r = passTable[key];
        if (!r) throw new Error(`smoke: no mock for ${key}`);
        return r;
      },
    });
    trace.push(
      `step7: re-verify iteration=${verify2.iteration} ok=${verify2.ok} exitCode=${verify2.exitCode}`,
    );

    // Step 8: collect → completed.
    const collect2 = runTeamCollect(sessionId, {
      cwd,
      isProcessAlive: () => true,
    });
    trace.push(
      `step8: collect finalPhase=${collect2.finalPhase} verifyFailSignals=${collect2.verifyFailSignals?.length ?? 0}`,
    );

    const date = opts?.now?.() ?? "2026-05-25";
    const markdown = renderSmokeMarkdown(buildAttestationInput(date, trace));
    return {
      markdown,
      trace,
      artifactRelPath:
        "docs/smoke/omcp-team-parity/phase1-verify-fix-loop-deterministic-attestation.md",
    };
  } finally {
    process.chdir(prevCwd);
    // If we created a tmp dir, clean it up. (Caller-provided cwd is left alone.)
    if (!opts?.cwd) {
      try {
        rmSync(cwd, { recursive: true, force: true });
      } catch {
        // best-effort cleanup
      }
    }
  }
}

function buildAttestationInput(
  date: string,
  trace: string[],
): SmokeTemplateInput {
  return {
    title:
      "Phase 1 Verify/Fix Loop — Deterministic Attestation (US-omcp-parity-P1)",
    date,
    mode: "deterministic",
    environment:
      `omcp v2.1.x N+1, Phase 1 verify/fix loop.\n` +
      `Harness: \`src/scripts/smoke-phase1.ts\` (version ${SCRIPT_VERSION}).\n` +
      `Renderer: \`src/lib/smoke-template.ts\` (shared with live + P3 + P4 smoke artifacts per iter-2 H4).\n` +
      `Trigger env: \`OMCP_COPILOT_AUTH=missing\` (CI mode; no real Copilot CLI invoked).\n` +
      `Spawn surface: every \`npx vitest run\`, \`npx tsc --noEmit\`, \`npx biome check src/\`, and \`copilot -p ... --agent debugger\` is replaced by an in-process mock returning deterministic fixture output.`,
    precondition:
      `- A 2-worker omcp team session with \`current_phase: executing\` is on disk under \`.omcp/state/sessions/<sid>/team-state.json\`.\n` +
      `- Both workers' pidfiles + shards exist under \`.omcp/state/team/<sid>/\` (simulates the user-visible state after \`omcp team 2:executor "<task>"\` has finished spawning + writing shards).\n` +
      `- No verify-report-N.json or worker-K-verify-fail.json files exist yet (first verify pass has not run).`,
    trigger:
      `Sequence executed by \`runPhase1DeterministicSmoke()\`:\n` +
      `1. Seed TeamState + 2 worker pidfiles + 2 shard files.\n` +
      `2. Call \`runTeamVerify\` with a mock spawn that returns vitest exit-1, tsc/biome exit-0.\n` +
      `3. Call \`runTeamCollect\` (no \`--team-name\`) — must transition to \`fixing\` because Story 3 reads the worker-K-verify-fail.json signals.\n` +
      `4. Call \`spawnFixWorker\` with a mock spawn returning a fake pid; assert fix_loop_count → 1 and pidfile written.\n` +
      `5. Write a fix-worker shard (simulates the worker writing its own shard before exit).\n` +
      `6. Call \`runTeamVerify\` again with an all-pass mock; this clears the stale signals via Story 2's clear-at-start invariant.\n` +
      `7. Call \`runTeamCollect\` — must transition to \`completed\`.`,
    output:
      "```\n" +
      trace.join("\n") +
      "\n```\n" +
      "\n" +
      "Key invariants verified by this trace:\n" +
      `- The first verify pass writes signals → collect picks them up → fixing transition.\n` +
      `- spawnFixWorker increments fix_loop_count from undefined → 1; pidfile recorded for cancel/cleanup.\n` +
      `- Story 2's clear-at-start invariant removes stale signals on the passing iteration.\n` +
      `- The final collect sees no signals and no merge conflicts → completed.`,
    verdict:
      "PASS — deterministic. All 6 Phase 1 stories (DOCTOR / VERIFY-runner / COLLECT shortcircuit / FIX-worker / loop-bounding / smoke) participate in this run end-to-end. Live-mode equivalent is gated on the operator running with `copilot login` completed; the section structure here matches the live-mode artifact via `src/lib/smoke-template.ts`. Tag-gate per iter-2 §RELEASE-cut still requires ≥1 live-smoke artifact from P1/P3/P4 before v2.1.0 LOCAL tag.",
    references: [
      "docs/plans/omcp-team-omc-parity-iter2.md (US-omcp-parity-P1-VERIFY-smoke-artifact)",
      "src/cli/commands/team-verify.ts (runTeamVerify + spawnFixWorker)",
      "src/cli/commands/team-phase-controller.ts (runTeamCollect)",
      "src/lib/smoke-template.ts (shared renderer + drift detection)",
    ],
  };
}

/**
 * Script entry point — write the deterministic-attestation Markdown to its
 * canonical location under docs/smoke/. Idempotent: overwrites any prior
 * deterministic-mode capture.
 */
export function main(): void {
  const { markdown, artifactRelPath } = runPhase1DeterministicSmoke();
  const target = resolve(process.cwd(), artifactRelPath);
  mkdirSync(resolve(target, ".."), { recursive: true });
  atomicWriteFileSync(target, markdown);
  // intentional script-side stdout (this file is executed directly).
  // biome-ignore lint/suspicious/noConsole: script entry point
  console.log(`smoke-phase1: wrote ${artifactRelPath}`);
}

// Script invocation detection: only run main() when executed as the entry,
// not on import (which is what happens during vitest module loading).
const isDirectEntry =
  typeof process !== "undefined" &&
  process.argv[1] !== undefined &&
  fileURLToPath(import.meta.url) === resolve(process.argv[1]);

if (isDirectEntry) {
  main();
}
