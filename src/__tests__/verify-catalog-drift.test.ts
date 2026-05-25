// Story B: US-1.8-T4-VERIFY-CATALOG-drift-guard
// Deterministic drift detection tests for checkAgentDrift.
//
// Invariant 3 (4-manifest sync): agents/ filesystem and catalog manifest must
// stay in sync. Any agent .md without a catalog entry — or any catalog entry
// without a .md — is drift and must be flagged.

import { join } from "node:path";
import { describe, it, expect } from "vitest";
import { checkAgentDrift } from "../scripts/verify-catalog.js";
import { loadAgentCatalog } from "../runtime/agent-models.js";

const AGENTS_DIR = join(__dirname, "..", "..", "agents");

describe("verify-catalog drift guard (Invariant 3 — 4-manifest sync)", () => {
  it("real agents/ and loadAgentCatalog are in sync — zero drift", () => {
    const catalog = loadAgentCatalog(AGENTS_DIR);
    const catalogNames = new Set(catalog.keys());
    const findings = checkAgentDrift(AGENTS_DIR, catalogNames);
    if (findings.length > 0) {
      console.error(
        "Drift findings:\n" + findings.map((f) => `  ${f.file}: ${f.issue}`).join("\n"),
      );
    }
    expect(findings).toEqual([]);
  });

  it("phantom agent in filesystem but absent from catalog is flagged as drift", () => {
    // Simulate: catalog knows only known agents; a phantom agent exists in agents/ dir
    // but is NOT in the catalog manifest.
    // We test this without actually writing a file — by passing a catalog that lacks
    // one of the real agents (simulate the catalog being stale/missing an entry).
    const catalog = loadAgentCatalog(AGENTS_DIR);
    const catalogNames = new Set(catalog.keys());

    // Remove "executor" from catalog to simulate it being absent from manifest
    // while the file agents/executor.md still exists on disk.
    catalogNames.delete("executor");

    const findings = checkAgentDrift(AGENTS_DIR, catalogNames);
    const executorDrift = findings.filter(
      (f) => f.file.includes("executor") && f.issue.includes("missing from catalog manifest"),
    );
    expect(executorDrift.length).toBeGreaterThanOrEqual(1);
  });

  it("extra catalog entry with no corresponding .md file is flagged as drift", () => {
    // Simulate: catalog has a phantom-agent entry but agents/phantom-agent.md does not exist.
    const catalog = loadAgentCatalog(AGENTS_DIR);
    const catalogNames = new Set(catalog.keys());

    // Inject a phantom entry that has no .md on disk
    catalogNames.add("phantom-agent");

    const findings = checkAgentDrift(AGENTS_DIR, catalogNames);
    const phantomDrift = findings.filter(
      (f) => f.file.includes("phantom-agent") && f.issue.includes("has no agents/"),
    );
    expect(phantomDrift.length).toBeGreaterThanOrEqual(1);
  });
});
