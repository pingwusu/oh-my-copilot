// Shared Markdown renderer for omcp-team-parity smoke artifacts.
//
// Per iter-2 plan H4 — the same template renders both the live-Copilot
// smoke output AND the deterministic-attestation fallback (when
// OMCP_COPILOT_AUTH=missing). Keeping the section structure centralized
// here prevents the deterministic shape from drifting away from the
// live shape (pre-mortem scenario 3 mitigation).
//
// Required section structure (in this order): Environment, Pre-condition,
// Trigger, Output, Verdict. Stories P1/P3/P4 all consume this renderer
// so a drift-detection vitest can golden-match the headers.

export type SmokeMode = "live" | "deterministic";

export interface SmokeTemplateInput {
  /** Page title — e.g., "Phase 1 Verify/Fix Loop — Deterministic Attestation" */
  title: string;
  /** Capture date, typically ISO-8601 (date or full timestamp). */
  date: string;
  /** Mode: live (real Copilot) or deterministic (mock-spawn fallback). */
  mode: SmokeMode;
  /** Free-form Markdown body for the Environment section. */
  environment: string;
  /** Free-form Markdown body for the Pre-condition section. */
  precondition: string;
  /** Free-form Markdown body for the Trigger section. */
  trigger: string;
  /** Free-form Markdown body for the Output section. */
  output: string;
  /** Free-form Markdown body for the Verdict section. */
  verdict: string;
  /** Optional references rendered as a bulleted list at the bottom. */
  references?: string[];
}

/** Canonical section header order — referenced by drift-detection vitest. */
export const SMOKE_SECTION_HEADERS = [
  "Environment",
  "Pre-condition",
  "Trigger",
  "Output",
  "Verdict",
] as const;

/**
 * Render a smoke artifact as Markdown. Section order is fixed by
 * SMOKE_SECTION_HEADERS; trailing References is optional.
 */
export function renderSmokeMarkdown(input: SmokeTemplateInput): string {
  const lines: string[] = [];
  lines.push(`# ${input.title}`);
  lines.push("");
  lines.push(`**Date**: ${input.date}`);
  lines.push(
    `**Mode**: ${
      input.mode === "live"
        ? "live (real Copilot CLI)"
        : "deterministic (mock-spawn fallback per iter-2 H4)"
    }`,
  );
  lines.push("");

  const sections: Array<[string, string]> = [
    ["Environment", input.environment],
    ["Pre-condition", input.precondition],
    ["Trigger", input.trigger],
    ["Output", input.output],
    ["Verdict", input.verdict],
  ];
  for (const [name, body] of sections) {
    lines.push(`## ${name}`);
    lines.push("");
    lines.push(body.trim());
    lines.push("");
  }

  if (input.references && input.references.length > 0) {
    lines.push("## References");
    lines.push("");
    for (const r of input.references) {
      lines.push(`- ${r}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

/**
 * Extract the H2 (## ...) section headers from a rendered smoke artifact.
 * Used by the drift-detection vitest to assert that live + deterministic
 * artifacts share an identical section structure (the canonical 5 names
 * in the canonical order). The optional `References` trailer is allowed
 * but not required.
 */
export function extractSmokeSectionHeaders(markdown: string): string[] {
  const headers: string[] = [];
  for (const line of markdown.split(/\r?\n/)) {
    const m = /^##\s+(.+?)\s*$/.exec(line);
    if (m) headers.push(m[1]);
  }
  return headers;
}

/**
 * Returns true iff the artifact's H2 headers begin with the canonical
 * five-section sequence. Tolerates a trailing `References` header.
 */
export function smokeHeadersMatchCanonical(headers: string[]): boolean {
  if (headers.length < SMOKE_SECTION_HEADERS.length) return false;
  for (let i = 0; i < SMOKE_SECTION_HEADERS.length; i++) {
    if (headers[i] !== SMOKE_SECTION_HEADERS[i]) return false;
  }
  return true;
}
