/**
 * Story 20 tests for the live-smoke release-time gate.
 *
 * Covers iter-2 plan §RELEASE-cut S4 verbatim: at least one of the 3
 * live-mode artifact paths must exist + carry the canonical Mode marker
 * for the tag gate to open. Deterministic-attestation files (with the
 * `-deterministic-attestation` suffix) never satisfy the gate.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  checkLiveSmoke,
  formatLiveSmokeReport,
  LIVE_MODE_MARKER,
} from "../scripts/check-live-smoke.js";

let tmp: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "omcp-check-live-"));
  fs.mkdirSync(path.join(tmp, "docs", "smoke", "omcp-team-parity"), {
    recursive: true,
  });
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function writeLiveArtifact(phase: 1 | 3 | 4): void {
  const filename = {
    1: "phase1-verify-fix-loop.md",
    3: "phase3-chain.md",
    4: "phase4-integration.md",
  }[phase];
  fs.writeFileSync(
    path.join(tmp, "docs", "smoke", "omcp-team-parity", filename),
    `# Phase ${phase} live attestation\n\n**Date**: 2026-05-25\n${LIVE_MODE_MARKER}\n\nrest of content...\n`,
    "utf8",
  );
}

function writeDetArtifact(phase: 1 | 3 | 4): void {
  const filename = {
    1: "phase1-verify-fix-loop-deterministic-attestation.md",
    3: "phase3-chain-deterministic-attestation.md",
    4: "phase4-integration-deterministic-attestation.md",
  }[phase];
  fs.writeFileSync(
    path.join(tmp, "docs", "smoke", "omcp-team-parity", filename),
    `# Phase ${phase} deterministic attestation\n\n**Date**: 2026-05-25\n**Mode**: deterministic (mock-spawn fallback per iter-2 H4)\n`,
    "utf8",
  );
}

describe("checkLiveSmoke — gate enforcement", () => {
  it("BLOCKED when zero artifacts exist (all 3 missing)", () => {
    const result = checkLiveSmoke({ cwd: tmp });
    expect(result.liveCount).toBe(0);
    expect(result.tagGateSatisfied).toBe(false);
    expect(result.missingCount).toBe(3);
  });

  it("BLOCKED when only deterministic artifacts exist", () => {
    writeDetArtifact(1);
    writeDetArtifact(3);
    writeDetArtifact(4);
    const result = checkLiveSmoke({ cwd: tmp });
    expect(result.liveCount).toBe(0);
    expect(result.deterministicCount).toBe(3);
    expect(result.tagGateSatisfied).toBe(false);
  });

  it("SATISFIED when exactly 1 live artifact (phase 1) is present", () => {
    writeLiveArtifact(1);
    writeDetArtifact(3);
    writeDetArtifact(4);
    const result = checkLiveSmoke({ cwd: tmp });
    expect(result.liveCount).toBe(1);
    expect(result.deterministicCount).toBe(2);
    expect(result.tagGateSatisfied).toBe(true);
  });

  it("SATISFIED when only phase 3 has a live artifact (any one of 3 unlocks)", () => {
    writeDetArtifact(1);
    writeLiveArtifact(3);
    writeDetArtifact(4);
    const result = checkLiveSmoke({ cwd: tmp });
    expect(result.tagGateSatisfied).toBe(true);
    expect(result.liveCount).toBe(1);
  });

  it("SATISFIED when all 3 phases have live artifacts", () => {
    writeLiveArtifact(1);
    writeLiveArtifact(3);
    writeLiveArtifact(4);
    const result = checkLiveSmoke({ cwd: tmp });
    expect(result.liveCount).toBe(3);
    expect(result.deterministicCount).toBe(0);
    expect(result.tagGateSatisfied).toBe(true);
  });
});

describe("checkLiveSmoke — marker validation defensiveness", () => {
  it("a 'live' filename without the Mode marker counts as deterministic-or-missing (not live)", () => {
    // File exists at the live path but doesn't carry the LIVE_MODE_MARKER —
    // an operator edited the file manually and forgot the marker. Defensive
    // policy: this should NOT unlock the gate.
    fs.writeFileSync(
      path.join(
        tmp,
        "docs",
        "smoke",
        "omcp-team-parity",
        "phase1-verify-fix-loop.md",
      ),
      "# Phase 1 live attestation (no marker line!)\n",
      "utf8",
    );
    const result = checkLiveSmoke({ cwd: tmp });
    const phase1 = result.artifacts.find((a) => a.phase === 1);
    // Without the marker AND without a deterministic file, falls through to missing.
    expect(phase1?.status).toBe("missing");
    expect(result.tagGateSatisfied).toBe(false);
  });

  it("if a phase has BOTH live (marker-bearing) AND deterministic, live wins", () => {
    writeLiveArtifact(1);
    writeDetArtifact(1);
    const result = checkLiveSmoke({ cwd: tmp });
    const phase1 = result.artifacts.find((a) => a.phase === 1);
    expect(phase1?.status).toBe("live");
  });

  it("if a phase has live-without-marker AND deterministic, deterministic wins", () => {
    fs.writeFileSync(
      path.join(
        tmp,
        "docs",
        "smoke",
        "omcp-team-parity",
        "phase4-integration.md",
      ),
      "# Phase 4 (no marker)\n",
      "utf8",
    );
    writeDetArtifact(4);
    const result = checkLiveSmoke({ cwd: tmp });
    const phase4 = result.artifacts.find((a) => a.phase === 4);
    expect(phase4?.status).toBe("deterministic");
  });
});

describe("formatLiveSmokeReport", () => {
  it("includes [OK], [DET], [MISS] markers + tag-gate verdict", () => {
    writeLiveArtifact(1);
    writeDetArtifact(3);
    // phase 4 missing
    const result = checkLiveSmoke({ cwd: tmp });
    const report = formatLiveSmokeReport(result);
    expect(report).toMatch(/\[OK  ]\s+phase1/);
    expect(report).toMatch(/\[DET ]\s+phase3/);
    expect(report).toMatch(/\[MISS]\s+phase4/);
    expect(report).toMatch(/tag-gate: SATISFIED/);
  });

  it("BLOCKED report includes the canonical 'capture P1, P3, or P4' message", () => {
    writeDetArtifact(1);
    const result = checkLiveSmoke({ cwd: tmp });
    const report = formatLiveSmokeReport(result);
    expect(report).toContain("BLOCKED");
    expect(report).toContain("capture P1, P3, or P4");
  });
});
