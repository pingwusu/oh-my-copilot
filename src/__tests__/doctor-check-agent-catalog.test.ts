/**
 * Deterministic tests for US-1.9-T2-DOCTOR-check-agent-catalog.
 * (Invariant 8: CLI registration)
 *
 * Verifies all 19 agents in agents/*.md are registered in the plugin catalog.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  analyzeAgentCatalogFromDir,
  probeAgentCatalog,
  runDoctor,
} from "../cli/commands/doctor.js";

const EXPECTED_AGENT_COUNT = 19;

const ALL_19_AGENTS = [
  "analyst.md",
  "architect.md",
  "code-reviewer.md",
  "code-simplifier.md",
  "critic.md",
  "debugger.md",
  "designer.md",
  "document-specialist.md",
  "executor.md",
  "explore.md",
  "git-master.md",
  "planner.md",
  "qa-tester.md",
  "scientist.md",
  "security-reviewer.md",
  "test-engineer.md",
  "tracer.md",
  "verifier.md",
  "writer.md",
];

describe("analyzeAgentCatalogFromDir (pure)", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "omcp-agent-catalog-"));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("returns ok when exactly 19 agents are present", () => {
    const agentsDir = join(tmp, "agents");
    mkdirSync(agentsDir);
    for (const f of ALL_19_AGENTS) writeFileSync(join(agentsDir, f), `# ${f}`);
    const result = analyzeAgentCatalogFromDir(agentsDir);
    expect(result.level).toBe("ok");
    expect(result.detail).toContain(`${EXPECTED_AGENT_COUNT}/${EXPECTED_AGENT_COUNT}`);
  });

  it("returns warn when fewer than 19 agents are present", () => {
    const agentsDir = join(tmp, "agents");
    mkdirSync(agentsDir);
    // Write only 15
    for (const f of ALL_19_AGENTS.slice(0, 15)) writeFileSync(join(agentsDir, f), `# ${f}`);
    const result = analyzeAgentCatalogFromDir(agentsDir);
    expect(result.level).toBe("warn");
    expect(result.detail).toContain("15/19");
    expect(result.detail).toContain("4 missing");
    expect(result.detail).toContain("omcp setup");
  });

  it("returns ok when more than 19 agents present (extra agents allowed)", () => {
    const agentsDir = join(tmp, "agents");
    mkdirSync(agentsDir);
    for (const f of ALL_19_AGENTS) writeFileSync(join(agentsDir, f), `# ${f}`);
    writeFileSync(join(agentsDir, "extra-agent.md"), "# extra");
    const result = analyzeAgentCatalogFromDir(agentsDir);
    expect(result.level).toBe("ok");
    expect(result.detail).toContain("20 agents");
  });

  it("returns warn when no agents present", () => {
    const agentsDir = join(tmp, "agents");
    mkdirSync(agentsDir);
    const result = analyzeAgentCatalogFromDir(agentsDir);
    expect(result.level).toBe("warn");
    expect(result.detail).toContain("0/19");
  });

  it("ignores non-.md files when counting agents", () => {
    const agentsDir = join(tmp, "agents");
    mkdirSync(agentsDir);
    for (const f of ALL_19_AGENTS) writeFileSync(join(agentsDir, f), `# ${f}`);
    writeFileSync(join(agentsDir, "README.txt"), "ignore me");
    writeFileSync(join(agentsDir, "catalog.json"), "{}");
    const result = analyzeAgentCatalogFromDir(agentsDir);
    expect(result.level).toBe("ok");
    expect(result.detail).toContain(`${EXPECTED_AGENT_COUNT}/${EXPECTED_AGENT_COUNT}`);
  });
});

describe("probeAgentCatalog (filesystem)", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "omcp-probe-agent-"));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("returns warn when agents/ directory does not exist", () => {
    const result = probeAgentCatalog(join(tmp, "plugin-dir"));
    expect(result.level).toBe("warn");
    expect(result.detail).toContain("agents/ directory not found");
    expect(result.detail).toContain("omcp setup");
  });

  it("returns ok when all 19 agents present in plugin dir", () => {
    const pluginDir = join(tmp, "plugin");
    const agentsDir = join(pluginDir, "agents");
    mkdirSync(agentsDir, { recursive: true });
    for (const f of ALL_19_AGENTS) writeFileSync(join(agentsDir, f), `# ${f}`);
    const result = probeAgentCatalog(pluginDir);
    expect(result.level).toBe("ok");
  });

  it("returns warn when only partial agents present", () => {
    const pluginDir = join(tmp, "plugin");
    const agentsDir = join(pluginDir, "agents");
    mkdirSync(agentsDir, { recursive: true });
    for (const f of ALL_19_AGENTS.slice(0, 10)) writeFileSync(join(agentsDir, f), `# ${f}`);
    const result = probeAgentCatalog(pluginDir);
    expect(result.level).toBe("warn");
    expect(result.detail).toContain("10/19");
  });
});

describe("runDoctor: agent catalog check wired", () => {
  let tmp: string;
  let prevHome: string | undefined;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "omcp-doctor-agentcat-"));
    prevHome = process.env.OMCP_HOME;
    process.env.OMCP_HOME = tmp;
  });

  afterEach(() => {
    if (prevHome === undefined) delete process.env.OMCP_HOME;
    else process.env.OMCP_HOME = prevHome;
    rmSync(tmp, { recursive: true, force: true });
  });

  it("runDoctor surfaces 'agent catalog' check (absent plugin dir → warn)", () => {
    const checks = runDoctor();
    // There are two checks named "agent catalog" — the tier-1 existence check
    // and the tier-2 full-count check (probeAgentCatalog). Find the one from probeAgentCatalog.
    const catalogChecks = checks.filter((c) => c.name === "agent catalog");
    expect(catalogChecks.length).toBeGreaterThanOrEqual(1);
    // With no plugin dir, at least one should be warn
    const hasWarn = catalogChecks.some((c) => c.level === "warn");
    expect(hasWarn).toBe(true);
  });

  it("runDoctor surfaces 'agent catalog' ok when all 19 agents present", () => {
    const pluginDir = join(
      tmp,
      "installed-plugins",
      "oh-my-copilot",
      "oh-my-copilot",
    );
    const agentsDir = join(pluginDir, "agents");
    mkdirSync(agentsDir, { recursive: true });
    // Also create manifest so tier-1 check passes
    mkdirSync(join(pluginDir, ".claude-plugin"), { recursive: true });
    writeFileSync(
      join(pluginDir, ".claude-plugin", "plugin.json"),
      JSON.stringify({ version: "1.0.0" }),
    );
    for (const f of ALL_19_AGENTS) writeFileSync(join(agentsDir, f), `# ${f}`);
    const checks = runDoctor();
    const catalogChecks = checks.filter((c) => c.name === "agent catalog");
    // The probeAgentCatalog check should be ok
    const okCheck = catalogChecks.find((c) => c.level === "ok");
    expect(okCheck).toBeDefined();
  });
});
