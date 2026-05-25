/**
 * Unit tests for the shared smoke-artifact Markdown renderer.
 *
 * Covers (per iter-2 plan H4 + pre-mortem scenario 3 mitigation):
 *   - Canonical section order: Environment, Pre-condition, Trigger,
 *     Output, Verdict.
 *   - References appendix is optional + rendered when supplied.
 *   - extractSmokeSectionHeaders / smokeHeadersMatchCanonical roundtrip.
 *   - Live vs deterministic mode renders an identical section structure
 *     (drift detection — promotes pre-mortem scenario 3 to a unit test).
 */

import { describe, expect, it } from "vitest";

import {
  extractSmokeSectionHeaders,
  renderSmokeMarkdown,
  smokeHeadersMatchCanonical,
  SMOKE_SECTION_HEADERS,
  type SmokeTemplateInput,
} from "../lib/smoke-template.js";

function baseInput(overrides: Partial<SmokeTemplateInput> = {}): SmokeTemplateInput {
  return {
    title: "Test Smoke Artifact",
    date: "2026-05-25",
    mode: "deterministic",
    environment: "env body",
    precondition: "precondition body",
    trigger: "trigger body",
    output: "output body",
    verdict: "verdict body",
    ...overrides,
  };
}

describe("renderSmokeMarkdown — canonical section structure", () => {
  it("renders all 5 canonical sections in order", () => {
    const md = renderSmokeMarkdown(baseInput());
    const headers = extractSmokeSectionHeaders(md);
    expect(headers).toEqual([...SMOKE_SECTION_HEADERS]);
  });

  it("renders the title as H1", () => {
    const md = renderSmokeMarkdown(baseInput({ title: "Foo Bar" }));
    expect(md.split("\n")[0]).toBe("# Foo Bar");
  });

  it("renders the mode metadata line", () => {
    const live = renderSmokeMarkdown(baseInput({ mode: "live" }));
    const det = renderSmokeMarkdown(baseInput({ mode: "deterministic" }));
    expect(live).toContain("**Mode**: live (real Copilot CLI)");
    expect(det).toContain("**Mode**: deterministic (mock-spawn fallback per iter-2 H4)");
  });

  it("trims whitespace from section bodies", () => {
    const md = renderSmokeMarkdown(
      baseInput({
        environment: "   leading and trailing whitespace   \n",
        verdict: "\n\nVERDICT\n\n",
      }),
    );
    expect(md).toContain("leading and trailing whitespace");
    expect(md).not.toContain("   leading and trailing whitespace");
    expect(md).toContain("\nVERDICT\n");
  });

  it("includes references section only when supplied", () => {
    const without = renderSmokeMarkdown(baseInput({ references: undefined }));
    expect(extractSmokeSectionHeaders(without)).toEqual([...SMOKE_SECTION_HEADERS]);

    const withRefs = renderSmokeMarkdown(
      baseInput({ references: ["docs/foo.md", "src/bar.ts"] }),
    );
    expect(extractSmokeSectionHeaders(withRefs)).toEqual([
      ...SMOKE_SECTION_HEADERS,
      "References",
    ]);
    expect(withRefs).toContain("- docs/foo.md");
    expect(withRefs).toContain("- src/bar.ts");
  });

  it("empty references array does not emit the References header", () => {
    const md = renderSmokeMarkdown(baseInput({ references: [] }));
    expect(extractSmokeSectionHeaders(md)).toEqual([...SMOKE_SECTION_HEADERS]);
  });
});

describe("smokeHeadersMatchCanonical (drift detection)", () => {
  it("returns true for exact canonical sequence", () => {
    expect(smokeHeadersMatchCanonical([...SMOKE_SECTION_HEADERS])).toBe(true);
  });

  it("returns true for canonical + trailing References", () => {
    expect(
      smokeHeadersMatchCanonical([...SMOKE_SECTION_HEADERS, "References"]),
    ).toBe(true);
  });

  it("returns false when a section is missing", () => {
    expect(
      smokeHeadersMatchCanonical(SMOKE_SECTION_HEADERS.slice(1) as string[]),
    ).toBe(false);
  });

  it("returns false when sections are reordered", () => {
    const reordered = [
      "Pre-condition",
      "Environment",
      "Trigger",
      "Output",
      "Verdict",
    ];
    expect(smokeHeadersMatchCanonical(reordered)).toBe(false);
  });

  it("returns false on an empty header list", () => {
    expect(smokeHeadersMatchCanonical([])).toBe(false);
  });
});

describe("live ↔ deterministic structural parity (pre-mortem scenario 3)", () => {
  it("both modes produce identical section header sequence", () => {
    const liveMd = renderSmokeMarkdown(baseInput({ mode: "live" }));
    const detMd = renderSmokeMarkdown(baseInput({ mode: "deterministic" }));
    expect(extractSmokeSectionHeaders(liveMd)).toEqual(
      extractSmokeSectionHeaders(detMd),
    );
  });

  it("both modes pass smokeHeadersMatchCanonical", () => {
    const liveMd = renderSmokeMarkdown(baseInput({ mode: "live" }));
    const detMd = renderSmokeMarkdown(baseInput({ mode: "deterministic" }));
    expect(
      smokeHeadersMatchCanonical(extractSmokeSectionHeaders(liveMd)),
    ).toBe(true);
    expect(
      smokeHeadersMatchCanonical(extractSmokeSectionHeaders(detMd)),
    ).toBe(true);
  });
});

describe("extractSmokeSectionHeaders edge cases", () => {
  it("returns empty array on empty markdown", () => {
    expect(extractSmokeSectionHeaders("")).toEqual([]);
  });

  it("ignores H1 and H3 headers", () => {
    const md = "# H1 header\n## Section A\n### sub\n## Section B\n#### sub2";
    expect(extractSmokeSectionHeaders(md)).toEqual(["Section A", "Section B"]);
  });

  it("strips trailing whitespace from headers", () => {
    const md = "## Trimmed  \n";
    expect(extractSmokeSectionHeaders(md)).toEqual(["Trimmed"]);
  });
});
