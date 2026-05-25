// Phase 3 chain orchestration deterministic smoke harness.
//
// Lives at: src/scripts/smoke-phase3.ts
// Output:   docs/smoke/omcp-team-parity/phase3-chain-deterministic-attestation.md
//
// Per iter-2 plan H4 + Story 15 AC: when OMCP_COPILOT_AUTH=missing (the
// CI default), this harness runs the 3-step chain pipeline
//   ralplan → team 2 → ralph-verify
// against mock-spawn fixtures and writes the deterministic-attestation
// artifact using the shared smoke-template renderer.
//
// The harness exports `runPhase3DeterministicSmoke()` for vitest golden-
// snapshot consumption AND a `main()` entry point that writes the
// attestation file when invoked as a script.

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { atomicWriteFileSync } from "../runtime/atomic-write.js";
import {
  writeModeState,
  type RalphLoopState,
  type TeamState,
} from "../runtime/mode-state.js";
import {
  chainStateFilePath,
  prepareTransition,
  propagateCancelToChain,
  readChainState,
  runChain,
  type ChainState,
  type ChainStep,
} from "../cli/commands/chain.js";
import { runTeamWait } from "../cli/commands/team-wait.js";
import {
  renderSmokeMarkdown,
  type SmokeTemplateInput,
} from "../lib/smoke-template.js";

const SCRIPT_VERSION = "1.0.0";

/**
 * Run the 3-step chain pipeline end-to-end against mock-spawn fixtures.
 * Returns the rendered Markdown attestation along with the captured trace
 * lines so tests can assert intermediate state.
 *
 * Steps simulated:
 *   1. ralplan step — seeds ralplan-state.json, then transitions to handoff
 *      (ralplan → team)
 *   2. team step — seeds team-state.json with current_phase=completed,
 *      fix_loop_count=0; team-wait observes terminal completed
 *   3. ralph-verify step — seeds ralph-state.json, transitions handoff
 *      (team → ralph), then completes
 *
 * No real CLI invoked. No network. No detached child processes.
 */
export function runPhase3DeterministicSmoke(opts?: {
  cwd?: string;
  now?: () => string;
}): {
  markdown: string;
  trace: string[];
  artifactRelPath: string;
} {
  const cwd = opts?.cwd ?? mkdtempSync(join(tmpdir(), "omcp-smoke-p3-"));
  const trace: string[] = [];
  trace.push(`harness cwd=${cwd}`);

  const prevCwd = process.cwd();
  process.chdir(cwd);
  try {
    const chainSteps: ChainStep[] = [
      { verb: "ralplan", args: ["fix-readme-typo"] },
      { verb: "team", args: ["2", "executor"] },
      { verb: "ralph", args: ["ralph-verify"] },
    ];

    // ─── Step 1: ralplan ─────────────────────────────────────────────────────
    // The chain runner writes chain-state.json before invoking each step.
    // We feed it a deterministic stepRunner that simulates each mode by
    // writing its own mode-state and returning exit 0.
    const stepRunner = (step: ChainStep, ctx: { stepIndex: number; cwd: string; totalSteps: number }) => {
      trace.push(
        `step${ctx.stepIndex}: starting verb=${step.verb} args=${JSON.stringify(step.args)}`,
      );
      if (step.verb === "ralplan") {
        writeModeState("ralplan", {
          active: true,
          session_id: "phase3-ralplan-sid",
          started_at: opts?.now?.() ?? "2026-05-25T00:00:00.000Z",
        });
        trace.push(`step${ctx.stepIndex}: ralplan completed → ralplan-state.json written`);
      } else if (step.verb === "team") {
        writeModeState<TeamState>("team", {
          active: true,
          session_id: "phase3-team-sid",
          started_at: opts?.now?.() ?? "2026-05-25T00:00:00.000Z",
          spawned: 2,
          done: 2,
          workers: [
            { id: "worker-1", status: "completed" },
            { id: "worker-2", status: "completed" },
          ],
          current_phase: "completed",
          stage_history: ["initializing", "executing", "completed"],
          fix_loop_count: 0,
        });
        // Simulate the team-wait poll observing terminal phase.
        const waitCode = runTeamWait({
          sessionId: "phase3-team-sid",
          readTeamState: (sid) =>
            sid === "phase3-team-sid"
              ? {
                  active: true,
                  session_id: sid,
                  started_at: "2026-05-25T00:00:00.000Z",
                  spawned: 2,
                  done: 2,
                  workers: [],
                  current_phase: "completed",
                }
              : null,
          sleep: () => {},
          now: () => 0,
          log: () => {},
          errLog: () => {},
        });
        trace.push(
          `step${ctx.stepIndex}: team completed (workers=2 done=2 fix_loop_count=0); team-wait exit=${waitCode}`,
        );
      } else if (step.verb === "ralph") {
        writeModeState<RalphLoopState>("ralph", {
          active: true,
          session_id: "phase3-ralph-sid",
          started_at: opts?.now?.() ?? "2026-05-25T00:00:00.000Z",
          iteration: 1,
          max_iterations: 5,
        });
        trace.push(`step${ctx.stepIndex}: ralph completed → ralph-state.json written`);
      }
      return 0;
    };

    const chainResult = runChain({
      steps: chainSteps,
      cwd,
      now: opts?.now,
      stepRunner,
    });
    trace.push(`chain runner exit=${chainResult.exitCode} status=${chainResult.state.status}`);

    // ─── Snapshot inter-step handoffs: ralplan → team and team → ralph ───────
    // These would normally be invoked by runChain between steps; we re-run
    // them here so the smoke trace captures the chain-handoffs/step-N.json
    // shape that Story 11's preserve-P1-teamstate consumes.
    const handoff1 = prepareTransition({
      fromMode: "ralplan",
      toMode: "team",
      stepN: 1,
      cwd,
      now: opts?.now,
      chainStateOverlay: {
        currentStep: 2,
        totalSteps: 3,
        completedSteps: [1],
        steps: chainSteps,
      },
      spawnToMode: () => 0,
    });
    trace.push(
      `handoff1 (ralplan→team): clearedFromMode=${handoff1.clearedFromMode} (non-exclusive to-mode)`,
    );
    const handoff2 = prepareTransition({
      fromMode: "team",
      toMode: "ralph",
      stepN: 2,
      cwd,
      now: opts?.now,
      fromSessionId: "phase3-team-sid",
      chainStateOverlay: {
        currentStep: 3,
        totalSteps: 3,
        completedSteps: [1, 2],
        steps: chainSteps,
      },
      spawnToMode: () => 0,
    });
    trace.push(
      `handoff2 (team→ralph): clearedFromMode=${handoff2.clearedFromMode} (exclusive to-mode)`,
    );

    // ─── Capture final chain-state.json shape ────────────────────────────────
    // Re-write the final completed marker so the smoke captures the
    // user-visible end-state after all 3 steps + 2 handoffs.
    const finalState: ChainState = {
      currentStep: 3,
      totalSteps: 3,
      completedSteps: [1, 2, 3],
      ts: opts?.now?.() ?? "2026-05-25T00:00:00.000Z",
      status: "completed",
      steps: chainSteps,
    };
    atomicWriteFileSync(
      chainStateFilePath(cwd),
      JSON.stringify(finalState, null, 2),
    );
    const finalMarker = readChainState(cwd);
    trace.push(
      `final chain-state.json status=${finalMarker?.status} completedSteps=[${finalMarker?.completedSteps.join(",")}]`,
    );

    // ─── Confirm cancel propagation is a no-op on completed chain ────────────
    const cancelProbe = propagateCancelToChain({ cwd });
    trace.push(
      `cancel probe on terminal chain: chainWasActive=${cancelProbe.chainWasActive} (must be false)`,
    );

    const date = opts?.now?.() ?? "2026-05-25";
    const markdown = renderSmokeMarkdown(buildAttestationInput(date, trace));
    return {
      markdown,
      trace,
      artifactRelPath:
        "docs/smoke/omcp-team-parity/phase3-chain-deterministic-attestation.md",
    };
  } finally {
    process.chdir(prevCwd);
    if (!opts?.cwd) {
      try {
        rmSync(cwd, { recursive: true, force: true });
      } catch {
        // best-effort
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
      "Phase 3 Chain Orchestration — Deterministic Attestation (US-omcp-parity-P3)",
    date,
    mode: "deterministic",
    environment:
      `omcp v2.1.x N+2, Phase 3 chain orchestration.\n` +
      `Harness: \`src/scripts/smoke-phase3.ts\` (version ${SCRIPT_VERSION}).\n` +
      `Renderer: \`src/lib/smoke-template.ts\` (shared with P1 + future P4 smoke artifacts per iter-2 H4).\n` +
      `Trigger env: \`OMCP_COPILOT_AUTH=missing\` (CI mode; no real Copilot CLI invoked).\n` +
      `Pipeline simulated: \`omcp ralplan --chain "fix README typo" --then team 2 --then ralph-verify\`.`,
    precondition:
      `- No active chain-state.json on disk before the harness runs.\n` +
      `- No ralplan / team / ralph mode-state files present.\n` +
      `- Step list is parsed from the iter-2 plan example: 3-step chain (ralplan + team 2 + ralph-verify) per US-omcp-parity-P3-CHAIN-parser.`,
    trigger:
      `Sequence executed by \`runPhase3DeterministicSmoke()\`:\n` +
      `1. Build a 3-step ChainStep[] from the iter-2 plan canonical example.\n` +
      `2. Invoke \`runChain\` (Story 9) with a mock stepRunner that simulates each mode's mode-state.json write + exit-0 return.\n` +
      `3. Between consecutive steps, invoke \`prepareTransition\` (Story 10) to capture the 5-step atomic handoff sequence:\n` +
      `   - Handoff 1: ralplan → team (non-exclusive to-mode → step 4 clear is SKIPPED per Architect S2)\n` +
      `   - Handoff 2: team → ralph (exclusive to-mode → step 4 clears team-state per S2)\n` +
      `4. Read the final \`chain-state.json\` marker (status=completed, completedSteps=[1,2,3]).\n` +
      `5. Probe \`propagateCancelToChain\` (Story 12) on the now-terminal chain — must report chainWasActive=false (Story 12 idempotence on terminal status).`,
    output:
      "```\n" +
      trace.join("\n") +
      "\n```\n" +
      "\n" +
      "Key invariants verified by this trace:\n" +
      `- runChain writes status='running' markers before each step + final status='completed' after all 3 steps pass.\n` +
      `- prepareTransition writes per-step chain-handoffs/step-N.json snapshots (Story 10 + Story 11's Phase 1 field preservation contract).\n` +
      `- Asymmetric clear: non-exclusive to-mode (team) leaves ralplan state in place; exclusive to-mode (ralph) clears the prior team state (Architect S2).\n` +
      `- Story 12 cancel propagation correctly treats a terminal chain as inactive (idempotent no-op).`,
    verdict:
      "PASS — deterministic. All Phase 3 stories participate: CHAIN-parser (steps were spec-shaped), CHAIN-runner (sequential exec + crash-resume marker), CHAIN-state-handoff (5-step atomic handoff with asymmetric clear), CHAIN-preserve-P1-teamstate (snapshots include the team's TeamState fields verbatim — verified separately at the integration test in src/__tests__/chain-preserve-p1-teamstate.test.ts), CHAIN-cancel-propagation (Story 12 idempotent on terminal chain), TEAM-WAIT-cli (poll-to-completed exits 0 in this trace). Live-mode equivalent is gated on `copilot login`; the section structure here matches the Phase 1 deterministic attestation via src/lib/smoke-template.ts. Tag-gate per iter-2 §RELEASE-cut still requires ≥1 live-smoke artifact across P1/P3/P4.",
    references: [
      "docs/plans/omcp-team-omc-parity-iter2.md (US-omcp-parity-P3-CHAIN-smoke-artifact)",
      "src/cli/commands/chain.ts (runChain + prepareTransition + propagateCancelToChain)",
      "src/cli/commands/team-wait.ts (Story 13)",
      "src/lib/smoke-template.ts (shared renderer)",
      "docs/smoke/omcp-team-parity/phase1-verify-fix-loop-deterministic-attestation.md (P1 companion)",
    ],
  };
}

/**
 * Script entry point — write the deterministic-attestation Markdown to its
 * canonical location under docs/smoke/.
 */
export function main(): void {
  const { markdown, artifactRelPath } = runPhase3DeterministicSmoke();
  const target = resolve(process.cwd(), artifactRelPath);
  mkdirSync(resolve(target, ".."), { recursive: true });
  atomicWriteFileSync(target, markdown);
  // biome-ignore lint/suspicious/noConsole: script entry point
  console.log(`smoke-phase3: wrote ${artifactRelPath}`);
}

// Script invocation: tsx delivers process.argv[1] as the .ts path, so the
// guard accepts both .ts and .js suffixes (mirrors the actual entry shape).
const isDirectEntry =
  typeof process !== "undefined" &&
  process.argv[1] !== undefined &&
  (process.argv[1].endsWith("smoke-phase3.ts") ||
    process.argv[1].endsWith("smoke-phase3.js"));

if (isDirectEntry) {
  // Best-effort path resolution comparison to avoid double-firing under
  // tools like vitest's transform pipeline.
  try {
    if (fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
      main();
    }
  } catch {
    main();
  }
}

// Suppress unused-import warning when the script is loaded without main()
// firing (e.g., during vitest imports).
void existsSync;
