/**
 * Story 6: end-to-end deterministic Phase 1 verify/fix loop smoke harness.
 *
 * runPhase1DeterministicSmoke() simulates the full verify → fixing →
 * fix-spawn → re-verify → completed cycle using injected mock spawns and
 * an isolated tmp cwd. The deterministic-attestation Markdown is rendered
 * via the shared smoke-template renderer so the section structure cannot
 * drift away from the live-mode artifact (pre-mortem scenario 3).
 *
 * Vitest assertions check both the trace contents (each step landed) AND
 * the rendered Markdown's canonical section structure.
 */

import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { runPhase1DeterministicSmoke } from "../scripts/smoke-phase1.js";
import {
  extractSmokeSectionHeaders,
  smokeHeadersMatchCanonical,
  SMOKE_SECTION_HEADERS,
} from "../lib/smoke-template.js";

describe("runPhase1DeterministicSmoke — end-to-end trace", () => {
  it("emits one trace line per pipeline step in order", () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "omcp-smoke-test-"));
    try {
      const { trace } = runPhase1DeterministicSmoke({ cwd });
      // Expect step markers step1..step8 in order, each on its own line.
      const stepNumbers = trace
        .map((l) => {
          const m = /^step(\d+):/.exec(l);
          return m ? Number(m[1]) : null;
        })
        .filter((n): n is number => n !== null);
      expect(stepNumbers).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("first verify pass reports ok=false (vitest fails)", () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "omcp-smoke-test-"));
    try {
      const { trace } = runPhase1DeterministicSmoke({ cwd });
      const step3 = trace.find((l) => l.startsWith("step3:"));
      expect(step3).toBeDefined();
      expect(step3!).toContain("ok=false");
      expect(step3!).toContain("workerSignals=2");
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("collect transitions to fixing after verify-fail signals", () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "omcp-smoke-test-"));
    try {
      const { trace } = runPhase1DeterministicSmoke({ cwd });
      const step4 = trace.find((l) => l.startsWith("step4:"));
      expect(step4!).toContain("finalPhase=fixing");
      expect(step4!).toContain("summaryWritten=true");
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("fix-worker is spawned with fix_loop_count=1 and not exhausted", () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "omcp-smoke-test-"));
    try {
      const { trace } = runPhase1DeterministicSmoke({ cwd });
      const step5 = trace.find((l) => l.startsWith("step5:"));
      expect(step5!).toContain("fixLoopCount=1");
      expect(step5!).toContain("exhausted=false");
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("re-verify is ok=true and final collect lands on completed", () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "omcp-smoke-test-"));
    try {
      const { trace } = runPhase1DeterministicSmoke({ cwd });
      const step7 = trace.find((l) => l.startsWith("step7:"));
      const step8 = trace.find((l) => l.startsWith("step8:"));
      expect(step7!).toContain("ok=true");
      expect(step8!).toContain("finalPhase=completed");
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });
});

describe("runPhase1DeterministicSmoke — rendered Markdown", () => {
  it("renders all 5 canonical sections in order plus a References appendix", () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "omcp-smoke-test-"));
    try {
      const { markdown } = runPhase1DeterministicSmoke({ cwd });
      const headers = extractSmokeSectionHeaders(markdown);
      expect(smokeHeadersMatchCanonical(headers)).toBe(true);
      // The harness always emits a References appendix.
      expect(headers[headers.length - 1]).toBe("References");
      expect(headers.slice(0, 5)).toEqual([...SMOKE_SECTION_HEADERS]);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("title identifies the Phase 1 deterministic attestation", () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "omcp-smoke-test-"));
    try {
      const { markdown } = runPhase1DeterministicSmoke({ cwd });
      const firstLine = markdown.split("\n")[0];
      expect(firstLine).toMatch(/^# Phase 1/);
      expect(firstLine).toContain("Deterministic Attestation");
      expect(firstLine).toContain("US-omcp-parity-P1");
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("mode line says deterministic + cites iter-2 H4", () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "omcp-smoke-test-"));
    try {
      const { markdown } = runPhase1DeterministicSmoke({ cwd });
      expect(markdown).toContain("**Mode**: deterministic (mock-spawn fallback per iter-2 H4)");
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("artifact path is the iter-2 plan's canonical location", () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "omcp-smoke-test-"));
    try {
      const { artifactRelPath } = runPhase1DeterministicSmoke({ cwd });
      expect(artifactRelPath).toBe(
        "docs/smoke/omcp-team-parity/phase1-verify-fix-loop-deterministic-attestation.md",
      );
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("Output section embeds the trace lines (key invariant evidence)", () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "omcp-smoke-test-"));
    try {
      const { markdown, trace } = runPhase1DeterministicSmoke({ cwd });
      // Find the Output section body — between '## Output' and the next '## ...'.
      const outputMatch = markdown.match(/## Output\n\n([\s\S]*?)\n\n## /);
      expect(outputMatch).toBeTruthy();
      const outputBody = outputMatch![1];
      for (const line of trace) {
        expect(outputBody).toContain(line);
      }
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });
});

describe("runPhase1DeterministicSmoke — deterministic output", () => {
  it("two runs with the same `now` produce byte-identical Markdown bodies (except non-time fields)", () => {
    const cwd1 = fs.mkdtempSync(path.join(os.tmpdir(), "omcp-smoke-test-"));
    const cwd2 = fs.mkdtempSync(path.join(os.tmpdir(), "omcp-smoke-test-"));
    try {
      const fixedNow = () => "2026-05-25";
      const r1 = runPhase1DeterministicSmoke({ cwd: cwd1, now: fixedNow });
      const r2 = runPhase1DeterministicSmoke({ cwd: cwd2, now: fixedNow });

      // Trace lines include a cwd path (different per tmp dir) — strip those
      // for comparison.
      const normalize = (md: string) =>
        md.replace(/harness cwd=[^\n]+/g, "harness cwd=<tmp>");

      expect(normalize(r1.markdown)).toBe(normalize(r2.markdown));
    } finally {
      fs.rmSync(cwd1, { recursive: true, force: true });
      fs.rmSync(cwd2, { recursive: true, force: true });
    }
  });
});
