/**
 * Story 9 / US-EB06-IPC-SMOKE tests.
 *
 * Deterministic golden-snapshot for the Phase 2 IPC mesh smoke harness.
 * Cross-story structural parity asserts P1/P3/P4/IPC attestations share
 * the canonical 5-section structure via the shared smoke-template
 * (drift-detection extends to a 4th consumer).
 */

import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { runIpcDeterministicSmoke } from "../scripts/smoke-ipc.js";
import { runPhase1DeterministicSmoke } from "../scripts/smoke-phase1.js";
import { runPhase3DeterministicSmoke } from "../scripts/smoke-phase3.js";
import { runPhase4DeterministicSmoke } from "../scripts/smoke-phase4.js";
import {
  extractSmokeSectionHeaders,
  smokeHeadersMatchCanonical,
  SMOKE_SECTION_HEADERS,
} from "../lib/smoke-template.js";

describe("runIpcDeterministicSmoke — pipeline trace", () => {
  it("emits all 6 phase markers (A..F)", () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "omcp-smoke-ipc-"));
    try {
      const { trace } = runIpcDeterministicSmoke({ cwd });
      const phaseLetters = trace
        .map((l) => {
          const m = /^phase([A-F]):/.exec(l);
          return m ? m[1] : null;
        })
        .filter((p): p is string => p !== null);
      // Phases A through F (some emit 2 lines).
      expect(phaseLetters).toContain("A");
      expect(phaseLetters).toContain("B");
      expect(phaseLetters).toContain("C");
      expect(phaseLetters).toContain("D");
      expect(phaseLetters).toContain("E");
      expect(phaseLetters).toContain("F");
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("phase A: 4 workers write heartbeat.json + schemas validate", () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "omcp-smoke-ipc-"));
    try {
      const { trace } = runIpcDeterministicSmoke({ cwd });
      const hbWriteLine = trace.find(
        (l) => l.startsWith("phaseA:") && l.includes("wrote heartbeat"),
      );
      const hbValidateLine = trace.find(
        (l) =>
          l.startsWith("phaseA:") && l.includes("schemas validated"),
      );
      expect(hbWriteLine).toContain("4 workers");
      expect(hbValidateLine).toContain("ts, workerIndex, pid");
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("phase C: 4 workers × 3 = 12 outbox entries written", () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "omcp-smoke-ipc-"));
    try {
      const { trace } = runIpcDeterministicSmoke({ cwd });
      const phaseC = trace.find((l) => l.startsWith("phaseC:"));
      expect(phaseC).toContain("12 outbox entries");
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("phase D: 4 consumers each read all 12 outbox lines (48 reader-side observations)", () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "omcp-smoke-ipc-"));
    try {
      const { trace } = runIpcDeterministicSmoke({ cwd });
      const phaseD = trace.find((l) => l.startsWith("phaseD:"));
      // ADR-EB-02 §4: cursors are per-CONSUMER (reader), not per-producer.
      // Each of the 4 consumers reads all 12 outbox entries from byteOffset 0.
      expect(phaseD).toContain("48 entries");
      expect(phaseD).toContain("4 consumers × 12 outbox lines");
      expect(phaseD).toContain("per-consumer cursors");
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("phase E: second-pass cursor read returns 0 new entries (cursors at EOF)", () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "omcp-smoke-ipc-"));
    try {
      const { trace } = runIpcDeterministicSmoke({ cwd });
      const phaseE = trace.find((l) => l.startsWith("phaseE:"));
      expect(phaseE).toContain("0 new entries");
      expect(phaseE).toContain("cursors at EOF");
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("phase F: all 4 outbox-cursor files persisted", () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "omcp-smoke-ipc-"));
    try {
      const { trace } = runIpcDeterministicSmoke({ cwd });
      const phaseF = trace.find((l) => l.startsWith("phaseF:"));
      expect(phaseF).toContain("all 4 outbox-cursor");
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });
});

describe("runIpcDeterministicSmoke — rendered Markdown", () => {
  it("renders all 5 canonical sections + References appendix", () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "omcp-smoke-ipc-"));
    try {
      const { markdown } = runIpcDeterministicSmoke({ cwd });
      const headers = extractSmokeSectionHeaders(markdown);
      expect(smokeHeadersMatchCanonical(headers)).toBe(true);
      expect(headers[headers.length - 1]).toBe("References");
      expect(headers.slice(0, 5)).toEqual([...SMOKE_SECTION_HEADERS]);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("title identifies the Phase 2 IPC mesh deterministic attestation", () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "omcp-smoke-ipc-"));
    try {
      const { markdown } = runIpcDeterministicSmoke({ cwd });
      const firstLine = markdown.split("\n")[0];
      expect(firstLine).toMatch(/Phase 2 IPC Mesh/);
      expect(firstLine).toContain("US-omcp-parity-P2");
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("artifact path is the EB-06 canonical location", () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "omcp-smoke-ipc-"));
    try {
      const { artifactRelPath } = runIpcDeterministicSmoke({ cwd });
      expect(artifactRelPath).toBe(
        "docs/smoke/omcp-team-parity/ipc-mesh-deterministic-attestation.md",
      );
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("Output section embeds every trace line verbatim", () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "omcp-smoke-ipc-"));
    try {
      const { markdown, trace } = runIpcDeterministicSmoke({ cwd });
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

describe("P1 ↔ P3 ↔ P4 ↔ IPC structural parity (drift detection, 4 consumers)", () => {
  it("all four deterministic attestations share identical section header sequence", () => {
    const cwd1 = fs.mkdtempSync(path.join(os.tmpdir(), "omcp-smoke-4parity-p1-"));
    const cwd3 = fs.mkdtempSync(path.join(os.tmpdir(), "omcp-smoke-4parity-p3-"));
    const cwd4 = fs.mkdtempSync(path.join(os.tmpdir(), "omcp-smoke-4parity-p4-"));
    const cwdI = fs.mkdtempSync(path.join(os.tmpdir(), "omcp-smoke-4parity-ipc-"));
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
      const ipcHeaders = extractSmokeSectionHeaders(
        runIpcDeterministicSmoke({ cwd: cwdI }).markdown,
      );
      expect(p3Headers).toEqual(p1Headers);
      expect(p4Headers).toEqual(p1Headers);
      expect(ipcHeaders).toEqual(p1Headers);
    } finally {
      fs.rmSync(cwd1, { recursive: true, force: true });
      fs.rmSync(cwd3, { recursive: true, force: true });
      fs.rmSync(cwd4, { recursive: true, force: true });
      fs.rmSync(cwdI, { recursive: true, force: true });
    }
  });
});

describe("runIpcDeterministicSmoke — deterministic output", () => {
  it("two runs with same `now` produce byte-identical Markdown (cwd-stripped)", () => {
    const cwd1 = fs.mkdtempSync(path.join(os.tmpdir(), "omcp-smoke-ipc-"));
    const cwd2 = fs.mkdtempSync(path.join(os.tmpdir(), "omcp-smoke-ipc-"));
    try {
      const fixedNow = () => "2026-05-25";
      const r1 = runIpcDeterministicSmoke({ cwd: cwd1, now: fixedNow });
      const r2 = runIpcDeterministicSmoke({ cwd: cwd2, now: fixedNow });
      const normalize = (md: string) =>
        md.replace(/harness cwd=[^\n]+/g, "harness cwd=<tmp>");
      expect(normalize(r1.markdown)).toBe(normalize(r2.markdown));
    } finally {
      fs.rmSync(cwd1, { recursive: true, force: true });
      fs.rmSync(cwd2, { recursive: true, force: true });
    }
  });
});
