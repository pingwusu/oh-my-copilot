/**
 * Story 17 / US-omcp-parity-P4-INTEGRATION-smoke tests.
 *
 * Deterministic golden-snapshot for the full-stack integration smoke that
 * exercises every v2.1 N+1 + N+2 surface in a single trace. Cross-story
 * structural parity asserts P1/P3/P4 attestations share canonical section
 * order via the shared smoke-template.
 */

import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { runPhase4DeterministicSmoke } from "../scripts/smoke-phase4.js";
import { runPhase1DeterministicSmoke } from "../scripts/smoke-phase1.js";
import { runPhase3DeterministicSmoke } from "../scripts/smoke-phase3.js";
import {
  extractSmokeSectionHeaders,
  smokeHeadersMatchCanonical,
  SMOKE_SECTION_HEADERS,
} from "../lib/smoke-template.js";

describe("runPhase4DeterministicSmoke — integration trace", () => {
  it("emits all 10 phase markers (A..J) in order", () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "omcp-smoke-p4-"));
    try {
      const { trace } = runPhase4DeterministicSmoke({ cwd });
      const phaseLetters = trace
        .map((l) => {
          const m = /^phase([A-J]):/.exec(l);
          return m ? m[1] : null;
        })
        .filter((p): p is string => p !== null);
      expect(phaseLetters).toEqual([
        "A",
        "B",
        "C",
        "D",
        "E",
        "F",
        "F", // phase F emits two lines (collect + TeamState inspection)
        "G",
        "H",
        "H", // phase H emits two lines (handoff + P1 metadata)
        "I",
        "J",
      ]);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("phase B writes 4 verify-fail signals on the first verify pass", () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "omcp-smoke-p4-"));
    try {
      const { trace } = runPhase4DeterministicSmoke({ cwd });
      const phaseB = trace.find((l) => l.startsWith("phaseB:"));
      expect(phaseB).toContain("ok=false");
      expect(phaseB).toContain("workerSignals=4");
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("phase C collect transitions to fixing with 4 signals", () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "omcp-smoke-p4-"));
    try {
      const { trace } = runPhase4DeterministicSmoke({ cwd });
      const phaseC = trace.find((l) => l.startsWith("phaseC:"));
      expect(phaseC).toContain("finalPhase=fixing");
      expect(phaseC).toContain("verifyFailSignals=4");
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("phase D spawnFixWorker increments fix_loop_count to 1 without exhausting the bound", () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "omcp-smoke-p4-"));
    try {
      const { trace } = runPhase4DeterministicSmoke({ cwd });
      const phaseD = trace.find((l) => l.startsWith("phaseD:"));
      expect(phaseD).toContain("fixLoopCount=1");
      expect(phaseD).toContain("exhausted=false");
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("phase E + F verify converges and TeamState carries fix_loop_count=1", () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "omcp-smoke-p4-"));
    try {
      const { trace } = runPhase4DeterministicSmoke({ cwd });
      const phaseE = trace.find((l) => l.startsWith("phaseE:"));
      expect(phaseE).toContain("ok=true");
      expect(phaseE).toContain("workerSignals=0");
      const phaseFTeam = trace.find(
        (l) => l.startsWith("phaseF:") && l.includes("TeamState"),
      );
      expect(phaseFTeam).toContain("fix_loop_count=1");
      expect(phaseFTeam).toContain("current_phase=completed");
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("phase G all 4 workers ack with --status completed", () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "omcp-smoke-p4-"));
    try {
      const { trace } = runPhase4DeterministicSmoke({ cwd });
      const phaseG = trace.find((l) => l.startsWith("phaseG:"));
      expect(phaseG).toContain("4/4 workers ack'd");
      expect(phaseG).toContain("--status completed");
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("phase H handoff preserves Phase 1 metadata (team_completed=true + fix_loop_count=1)", () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "omcp-smoke-p4-"));
    try {
      const { trace } = runPhase4DeterministicSmoke({ cwd });
      const phaseHMd = trace.find(
        (l) => l.startsWith("phaseH:") && l.includes("P1 metadata"),
      );
      expect(phaseHMd).toContain("fix_loop_count=1");
      expect(phaseHMd).toContain("team_completed=true");
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("phase J chain marker reaches completed status with both steps", () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "omcp-smoke-p4-"));
    try {
      const { trace } = runPhase4DeterministicSmoke({ cwd });
      const phaseJ = trace.find((l) => l.startsWith("phaseJ:"));
      expect(phaseJ).toContain("status=completed");
      expect(phaseJ).toContain("completedSteps=[1,2]");
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });
});

describe("runPhase4DeterministicSmoke — rendered Markdown", () => {
  it("renders all 5 canonical sections + References", () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "omcp-smoke-p4-"));
    try {
      const { markdown } = runPhase4DeterministicSmoke({ cwd });
      const headers = extractSmokeSectionHeaders(markdown);
      expect(smokeHeadersMatchCanonical(headers)).toBe(true);
      expect(headers[headers.length - 1]).toBe("References");
      expect(headers.slice(0, 5)).toEqual([...SMOKE_SECTION_HEADERS]);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("title identifies the Phase 4 deterministic attestation", () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "omcp-smoke-p4-"));
    try {
      const { markdown } = runPhase4DeterministicSmoke({ cwd });
      expect(markdown.split("\n")[0]).toMatch(
        /^# Phase 4 Full-Stack Integration/,
      );
      expect(markdown).toContain("US-omcp-parity-P4");
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("artifact path is the iter-2 plan canonical location", () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "omcp-smoke-p4-"));
    try {
      const { artifactRelPath } = runPhase4DeterministicSmoke({ cwd });
      expect(artifactRelPath).toBe(
        "docs/smoke/omcp-team-parity/phase4-integration-deterministic-attestation.md",
      );
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("Output section embeds every trace line verbatim", () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "omcp-smoke-p4-"));
    try {
      const { markdown, trace } = runPhase4DeterministicSmoke({ cwd });
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

describe("Phase 1 ↔ Phase 3 ↔ Phase 4 structural parity (pre-mortem scenario 3)", () => {
  it("all three deterministic attestations share identical section header sequence", () => {
    const cwd1 = fs.mkdtempSync(path.join(os.tmpdir(), "omcp-smoke-parity-p1-"));
    const cwd3 = fs.mkdtempSync(path.join(os.tmpdir(), "omcp-smoke-parity-p3-"));
    const cwd4 = fs.mkdtempSync(path.join(os.tmpdir(), "omcp-smoke-parity-p4-"));
    try {
      const p1Headers = extractSmokeSectionHeaders(
        runPhase1DeterministicSmoke({ cwd: cwd1 }).markdown,
      );
      const p3Headers = extractSmokeSectionHeaders(
        runPhase3DeterministicSmoke({ cwd: cwd3 }).markdown,
      );
      const p4Headers = extractSmokeSectionHeaders(
        runPhase4DeterministicSmoke({ cwd: cwd4 }).markdown,
      );
      expect(p3Headers).toEqual(p1Headers);
      expect(p4Headers).toEqual(p1Headers);
    } finally {
      fs.rmSync(cwd1, { recursive: true, force: true });
      fs.rmSync(cwd3, { recursive: true, force: true });
      fs.rmSync(cwd4, { recursive: true, force: true });
    }
  });
});

describe("runPhase4DeterministicSmoke — deterministic output", () => {
  it("two runs with the same `now` produce byte-identical Markdown (cwd-stripped)", () => {
    const cwd1 = fs.mkdtempSync(path.join(os.tmpdir(), "omcp-smoke-p4-"));
    const cwd2 = fs.mkdtempSync(path.join(os.tmpdir(), "omcp-smoke-p4-"));
    try {
      const fixedNow = () => "2026-05-25";
      const r1 = runPhase4DeterministicSmoke({ cwd: cwd1, now: fixedNow });
      const r2 = runPhase4DeterministicSmoke({ cwd: cwd2, now: fixedNow });
      const normalize = (md: string) =>
        md.replace(/harness cwd=[^\n]+/g, "harness cwd=<tmp>");
      expect(normalize(r1.markdown)).toBe(normalize(r2.markdown));
    } finally {
      fs.rmSync(cwd1, { recursive: true, force: true });
      fs.rmSync(cwd2, { recursive: true, force: true });
    }
  });
});
