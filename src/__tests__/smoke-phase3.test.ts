/**
 * Story 15 / US-omcp-parity-P3-CHAIN-smoke-artifact tests.
 *
 * Deterministic golden-snapshot for the Phase 3 chain orchestration smoke
 * harness. Mirrors smoke-phase1.test.ts in structure so the canonical
 * section structure stays locked across both stories via the shared
 * smoke-template renderer.
 */

import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { runPhase3DeterministicSmoke } from "../scripts/smoke-phase3.js";
import { runPhase1DeterministicSmoke } from "../scripts/smoke-phase1.js";
import {
  extractSmokeSectionHeaders,
  smokeHeadersMatchCanonical,
  SMOKE_SECTION_HEADERS,
} from "../lib/smoke-template.js";

describe("runPhase3DeterministicSmoke — pipeline trace", () => {
  it("emits step markers for all 3 chain steps in order", () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "omcp-smoke-p3-"));
    try {
      const { trace } = runPhase3DeterministicSmoke({ cwd });
      const stepStarts = trace
        .map((l) => {
          const m = /^step(\d+): starting verb=(\w+)/.exec(l);
          return m ? { idx: Number(m[1]), verb: m[2] } : null;
        })
        .filter((x): x is { idx: number; verb: string } => x !== null);
      expect(stepStarts).toEqual([
        { idx: 1, verb: "ralplan" },
        { idx: 2, verb: "team" },
        { idx: 3, verb: "ralph" },
      ]);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("trace captures both handoffs with the correct asymmetric clear", () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "omcp-smoke-p3-"));
    try {
      const { trace } = runPhase3DeterministicSmoke({ cwd });
      const handoff1 = trace.find((l) => l.startsWith("handoff1"));
      const handoff2 = trace.find((l) => l.startsWith("handoff2"));
      // Handoff 1 (ralplan → team) — non-exclusive to-mode, no clear.
      expect(handoff1).toContain("clearedFromMode=false");
      expect(handoff1).toContain("non-exclusive to-mode");
      // Handoff 2 (team → ralph) — exclusive to-mode, clears prior team state.
      expect(handoff2).toContain("clearedFromMode=true");
      expect(handoff2).toContain("exclusive to-mode");
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("chain reaches status=completed with all 3 steps in completedSteps", () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "omcp-smoke-p3-"));
    try {
      const { trace } = runPhase3DeterministicSmoke({ cwd });
      const finalLine = trace.find((l) =>
        l.startsWith("final chain-state.json"),
      );
      expect(finalLine).toContain("status=completed");
      expect(finalLine).toContain("completedSteps=[1,2,3]");
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("Story 12 cancel propagation is a no-op on the terminal chain", () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "omcp-smoke-p3-"));
    try {
      const { trace } = runPhase3DeterministicSmoke({ cwd });
      const probeLine = trace.find((l) =>
        l.startsWith("cancel probe on terminal chain"),
      );
      expect(probeLine).toContain("chainWasActive=false");
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });
});

describe("runPhase3DeterministicSmoke — rendered Markdown", () => {
  it("renders all 5 canonical sections in order plus References appendix", () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "omcp-smoke-p3-"));
    try {
      const { markdown } = runPhase3DeterministicSmoke({ cwd });
      const headers = extractSmokeSectionHeaders(markdown);
      expect(smokeHeadersMatchCanonical(headers)).toBe(true);
      expect(headers[headers.length - 1]).toBe("References");
      expect(headers.slice(0, 5)).toEqual([...SMOKE_SECTION_HEADERS]);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("title identifies the Phase 3 deterministic attestation", () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "omcp-smoke-p3-"));
    try {
      const { markdown } = runPhase3DeterministicSmoke({ cwd });
      const firstLine = markdown.split("\n")[0];
      expect(firstLine).toMatch(/^# Phase 3/);
      expect(firstLine).toContain("Deterministic Attestation");
      expect(firstLine).toContain("US-omcp-parity-P3");
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("artifact path is the iter-2 plan canonical location", () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "omcp-smoke-p3-"));
    try {
      const { artifactRelPath } = runPhase3DeterministicSmoke({ cwd });
      expect(artifactRelPath).toBe(
        "docs/smoke/omcp-team-parity/phase3-chain-deterministic-attestation.md",
      );
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("section structure matches Phase 1 deterministic attestation (cross-story parity)", () => {
    // Pre-mortem scenario 3 mitigation: P1 and P3 attestations must share
    // the same section structure since they go through the same template.
    const cwdP1 = fs.mkdtempSync(path.join(os.tmpdir(), "omcp-smoke-p3parity-p1-"));
    const cwdP3 = fs.mkdtempSync(path.join(os.tmpdir(), "omcp-smoke-p3parity-p3-"));
    try {
      const p1Headers = extractSmokeSectionHeaders(
        runPhase1DeterministicSmoke({ cwd: cwdP1 }).markdown,
      );
      const p3Headers = extractSmokeSectionHeaders(
        runPhase3DeterministicSmoke({ cwd: cwdP3 }).markdown,
      );
      expect(p3Headers).toEqual(p1Headers);
    } finally {
      fs.rmSync(cwdP1, { recursive: true, force: true });
      fs.rmSync(cwdP3, { recursive: true, force: true });
    }
  });

  it("Output section embeds the trace lines verbatim", () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "omcp-smoke-p3-"));
    try {
      const { markdown, trace } = runPhase3DeterministicSmoke({ cwd });
      const outputMatch = markdown.match(/## Output\n\n([\s\S]*?)\n\n## /);
      expect(outputMatch).toBeTruthy();
      const body = outputMatch![1];
      for (const line of trace) {
        expect(body).toContain(line);
      }
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });
});

describe("runPhase3DeterministicSmoke — deterministic output", () => {
  it("two runs with the same `now` produce byte-identical Markdown (cwd-stripped)", () => {
    const cwd1 = fs.mkdtempSync(path.join(os.tmpdir(), "omcp-smoke-p3-"));
    const cwd2 = fs.mkdtempSync(path.join(os.tmpdir(), "omcp-smoke-p3-"));
    try {
      const fixedNow = () => "2026-05-25";
      const r1 = runPhase3DeterministicSmoke({ cwd: cwd1, now: fixedNow });
      const r2 = runPhase3DeterministicSmoke({ cwd: cwd2, now: fixedNow });
      const normalize = (md: string) =>
        md.replace(/harness cwd=[^\n]+/g, "harness cwd=<tmp>");
      expect(normalize(r1.markdown)).toBe(normalize(r2.markdown));
    } finally {
      fs.rmSync(cwd1, { recursive: true, force: true });
      fs.rmSync(cwd2, { recursive: true, force: true });
    }
  });
});
