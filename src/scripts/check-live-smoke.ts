// release-time live-smoke gate. Story 20 / US-omcp-parity-RELEASE-cut.
//
// Per iter-2 plan §RELEASE-cut tag-gate (S4): the v2.1.0 LOCAL tag may
// be cut ONLY when ≥1 of the 3 smoke artifact paths
//   docs/smoke/omcp-team-parity/phase1-verify-fix-loop.md
//   docs/smoke/omcp-team-parity/phase3-chain.md
//   docs/smoke/omcp-team-parity/phase4-integration.md
// (note: WITHOUT the `-deterministic-attestation` suffix — those are
// the live-mode capture filenames) exists AND carries the canonical
// live-Copilot Mode marker (`**Mode**: live (real Copilot CLI)`).
//
// The deterministic-attestation files (with the `-deterministic-attestation`
// suffix) are NOT counted toward the tag gate — they're the CI fallback.
//
// Exit codes when run as a script:
//   0 — tag gate satisfied (≥1 live-mode artifact present)
//   1 — tag gate blocked (zero live-mode artifacts; explicit message)

import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const LIVE_MODE_MARKER = "**Mode**: live (real Copilot CLI)";

export interface SmokeArtifactStatus {
  /** Relative path under cwd. */
  path: string;
  /** Phase identifier (1 / 3 / 4). */
  phase: 1 | 3 | 4;
  /**
   * "live" — file exists and contains the live-mode marker.
   * "deterministic" — file exists but is the deterministic-attestation.
   * "missing" — neither the live nor the deterministic file exists.
   */
  status: "live" | "deterministic" | "missing";
}

export interface CheckLiveSmokeResult {
  liveCount: number;
  deterministicCount: number;
  missingCount: number;
  artifacts: SmokeArtifactStatus[];
  /** True iff at least one phase has a live-mode artifact. */
  tagGateSatisfied: boolean;
}

interface SmokeFileSpec {
  phase: 1 | 3 | 4;
  live: string;
  deterministic: string;
}

const SMOKE_PATHS: readonly SmokeFileSpec[] = [
  {
    phase: 1,
    live: "docs/smoke/omcp-team-parity/phase1-verify-fix-loop.md",
    deterministic:
      "docs/smoke/omcp-team-parity/phase1-verify-fix-loop-deterministic-attestation.md",
  },
  {
    phase: 3,
    live: "docs/smoke/omcp-team-parity/phase3-chain.md",
    deterministic:
      "docs/smoke/omcp-team-parity/phase3-chain-deterministic-attestation.md",
  },
  {
    phase: 4,
    live: "docs/smoke/omcp-team-parity/phase4-integration.md",
    deterministic:
      "docs/smoke/omcp-team-parity/phase4-integration-deterministic-attestation.md",
  },
];

/**
 * Compute the smoke-artifact tag-gate state for the current cwd.
 *
 * For each of the 3 phases (P1/P3/P4), look for the LIVE file first; if
 * present and it carries the canonical live-mode marker line, that phase
 * counts as `live`. Otherwise, if the deterministic-attestation exists,
 * the phase counts as `deterministic`. If neither exists, the phase is
 * `missing` — a v2.1.0 release without ANY artifact (live or
 * deterministic) is structurally invalid; the tag-gate enforces ≥1 live
 * but the deterministic count surfaces in the result for downstream
 * status reporting.
 */
export function checkLiveSmoke(opts: { cwd?: string } = {}): CheckLiveSmokeResult {
  const cwd = opts.cwd ?? process.cwd();
  const artifacts: SmokeArtifactStatus[] = [];
  for (const spec of SMOKE_PATHS) {
    const livePath = join(cwd, spec.live);
    if (existsSync(livePath)) {
      const body = readFileSync(livePath, "utf8");
      if (body.includes(LIVE_MODE_MARKER)) {
        artifacts.push({ path: spec.live, phase: spec.phase, status: "live" });
        continue;
      }
      // Live file exists but doesn't carry the marker — treat as
      // deterministic (defensive: an operator manually editing the file
      // and forgetting the marker shouldn't accidentally unlock the gate).
    }
    const detPath = join(cwd, spec.deterministic);
    if (existsSync(detPath)) {
      artifacts.push({
        path: spec.deterministic,
        phase: spec.phase,
        status: "deterministic",
      });
      continue;
    }
    artifacts.push({
      path: spec.live,
      phase: spec.phase,
      status: "missing",
    });
  }
  const liveCount = artifacts.filter((a) => a.status === "live").length;
  const deterministicCount = artifacts.filter(
    (a) => a.status === "deterministic",
  ).length;
  const missingCount = artifacts.filter((a) => a.status === "missing").length;
  return {
    liveCount,
    deterministicCount,
    missingCount,
    artifacts,
    tagGateSatisfied: liveCount >= 1,
  };
}

/**
 * Format a human-readable report. Used by the script entry point + the
 * release.ts wiring (Story 20) to surface the gate state to the operator.
 */
export function formatLiveSmokeReport(result: CheckLiveSmokeResult): string {
  const lines: string[] = [];
  lines.push("check-live-smoke: scanning v2.1 omcp-team-parity smoke artifacts");
  for (const a of result.artifacts) {
    const mark = a.status === "live" ? "OK  " : a.status === "deterministic" ? "DET " : "MISS";
    lines.push(`  [${mark}] phase${a.phase}  ${a.path}`);
  }
  lines.push(`  live=${result.liveCount}  deterministic=${result.deterministicCount}  missing=${result.missingCount}`);
  if (result.tagGateSatisfied) {
    lines.push(
      `  tag-gate: SATISFIED (${result.liveCount} live-smoke artifact${
        result.liveCount === 1 ? "" : "s"
      })`,
    );
  } else {
    lines.push(
      `  tag-gate: BLOCKED — v2.1.0 LOCAL tag blocked: ≥1 live-smoke required — capture P1, P3, or P4 with real Copilot CLI auth`,
    );
  }
  return lines.join("\n");
}

function main(): void {
  const result = checkLiveSmoke();
  // biome-ignore lint/suspicious/noConsole: script entry point
  console.log(formatLiveSmokeReport(result));
  if (!result.tagGateSatisfied) {
    process.exit(1);
  }
}

const isDirectEntry =
  typeof process !== "undefined" &&
  process.argv[1] !== undefined &&
  (process.argv[1].endsWith("check-live-smoke.ts") ||
    process.argv[1].endsWith("check-live-smoke.js"));

if (isDirectEntry) {
  try {
    if (fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
      main();
    }
  } catch {
    main();
  }
}
