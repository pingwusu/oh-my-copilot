// Deterministic routing tests for OMCP_MODEL_FAMILY env var.
// Tests 3 routing modes (claude, gpt, auto) using resolveAgentModel
// without spawning any real Copilot process.
//
// US-1.8-T4-ROUTING-live-spawn-test

import { join } from "node:path";
import { describe, it, expect } from "vitest";
import {
  loadAgentCatalog,
  resolveAgentModel,
  type AgentSpec,
} from "../runtime/agent-models.js";

const AGENTS_DIR = join(__dirname, "..", "..", "agents");

// ── helpers ──────────────────────────────────────────────────────────────────

function makeCatalog(claude: string, gpt: string): Map<string, AgentSpec> {
  const catalog = new Map<string, AgentSpec>();
  catalog.set("executor", {
    name: "executor",
    model: { claude, gpt },
  });
  return catalog;
}

// ── OMCP_MODEL_FAMILY=claude ──────────────────────────────────────────────────

describe("OMCP_MODEL_FAMILY=claude routing", () => {
  const env: NodeJS.ProcessEnv = { OMCP_MODEL_FAMILY: "claude" };

  it("resolves executor to claude family when env=claude", () => {
    const catalog = makeCatalog("claude-sonnet-4.6", "gpt-5.2-codex");
    const result = resolveAgentModel({ agent: "executor", env, catalog });
    expect(result.family).toBe("claude");
    expect(result.model).toBe("claude-sonnet-4.6");
  });

  it("model string starts with 'claude'", () => {
    const catalog = makeCatalog("claude-opus-4.7", "gpt-5.4");
    const result = resolveAgentModel({ agent: "executor", env, catalog });
    expect(result.model).toMatch(/^claude/);
  });

  it("unknown agent uses FALLBACK_DUAL claude side", () => {
    const catalog = new Map<string, AgentSpec>();
    const result = resolveAgentModel({ agent: "no-such-agent", env, catalog });
    expect(result.family).toBe("claude");
    expect(result.model).toMatch(/^claude/);
  });

  it("explicit override=claude supersedes any env value", () => {
    const envGpt: NodeJS.ProcessEnv = { OMCP_MODEL_FAMILY: "gpt" };
    const catalog = makeCatalog("claude-haiku-4.5", "gpt-5-mini");
    const result = resolveAgentModel({
      agent: "executor",
      override: "claude",
      env: envGpt,
      catalog,
    });
    expect(result.family).toBe("claude");
    expect(result.model).toBe("claude-haiku-4.5");
  });
});

// ── OMCP_MODEL_FAMILY=gpt ─────────────────────────────────────────────────────

describe("OMCP_MODEL_FAMILY=gpt routing", () => {
  const env: NodeJS.ProcessEnv = { OMCP_MODEL_FAMILY: "gpt" };

  it("resolves executor to gpt family when env=gpt", () => {
    const catalog = makeCatalog("claude-sonnet-4.6", "gpt-5.2-codex");
    const result = resolveAgentModel({ agent: "executor", env, catalog });
    expect(result.family).toBe("gpt");
    expect(result.model).toBe("gpt-5.2-codex");
  });

  it("model string starts with 'gpt'", () => {
    const catalog = makeCatalog("claude-opus-4.7", "gpt-5.4");
    const result = resolveAgentModel({ agent: "executor", env, catalog });
    expect(result.model).toMatch(/^gpt/);
  });

  it("unknown agent uses FALLBACK_DUAL gpt side", () => {
    const catalog = new Map<string, AgentSpec>();
    const result = resolveAgentModel({ agent: "no-such-agent", env, catalog });
    expect(result.family).toBe("gpt");
    expect(result.model).toMatch(/^gpt/);
  });

  it("case-insensitive: OMCP_MODEL_FAMILY=GPT resolves to gpt", () => {
    const envUpper: NodeJS.ProcessEnv = { OMCP_MODEL_FAMILY: "GPT" };
    const catalog = makeCatalog("claude-sonnet-4.6", "gpt-5.2-codex");
    const result = resolveAgentModel({ agent: "executor", env: envUpper, catalog });
    expect(result.family).toBe("gpt");
    expect(result.model).toBe("gpt-5.2-codex");
  });
});

// ── OMCP_MODEL_FAMILY=auto (fallback logic) ───────────────────────────────────

describe("OMCP_MODEL_FAMILY=auto routing", () => {
  it("auto with no copilotConfigModel falls back to DEFAULT_FAMILY (claude)", () => {
    const env: NodeJS.ProcessEnv = { OMCP_MODEL_FAMILY: "auto" };
    const catalog = makeCatalog("claude-sonnet-4.6", "gpt-5.2-codex");
    const result = resolveAgentModel({ agent: "executor", env, catalog });
    // DEFAULT_FAMILY is "claude" — auto defers to env then config then default
    expect(result.family).toBe("claude");
    expect(result.model).toBe("claude-sonnet-4.6");
  });

  it("auto defers to copilotConfigModel prefix 'gpt-*'", () => {
    const env: NodeJS.ProcessEnv = { OMCP_MODEL_FAMILY: "auto" };
    const catalog = makeCatalog("claude-sonnet-4.6", "gpt-5.2-codex");
    const result = resolveAgentModel({
      agent: "executor",
      env,
      copilotConfigModel: "gpt-5.2",
      catalog,
    });
    expect(result.family).toBe("gpt");
    expect(result.model).toBe("gpt-5.2-codex");
  });

  it("auto defers to copilotConfigModel prefix 'claude-*'", () => {
    const env: NodeJS.ProcessEnv = { OMCP_MODEL_FAMILY: "auto" };
    const catalog = makeCatalog("claude-haiku-4.5", "gpt-5-mini");
    const result = resolveAgentModel({
      agent: "executor",
      env,
      copilotConfigModel: "claude-opus-4.7",
      catalog,
    });
    expect(result.family).toBe("claude");
    expect(result.model).toBe("claude-haiku-4.5");
  });

  it("override=auto treated same as no override", () => {
    const env: NodeJS.ProcessEnv = {};
    const catalog = makeCatalog("claude-sonnet-4.6", "gpt-5.4");
    const result = resolveAgentModel({
      agent: "executor",
      override: "auto",
      env,
      catalog,
    });
    // No env var, no copilotConfigModel → DEFAULT_FAMILY=claude
    expect(result.family).toBe("claude");
  });
});

// ── missing OMCP_MODEL_FAMILY (defaults) ──────────────────────────────────────

describe("missing OMCP_MODEL_FAMILY (default behavior)", () => {
  const env: NodeJS.ProcessEnv = {};

  it("defaults to claude when OMCP_MODEL_FAMILY is not set", () => {
    const catalog = makeCatalog("claude-sonnet-4.6", "gpt-5.2-codex");
    const result = resolveAgentModel({ agent: "executor", env, catalog });
    expect(result.family).toBe("claude");
    expect(result.model).toBe("claude-sonnet-4.6");
  });

  it("defaults to claude when OMCP_MODEL_FAMILY is empty string", () => {
    const envEmpty: NodeJS.ProcessEnv = { OMCP_MODEL_FAMILY: "" };
    const catalog = makeCatalog("claude-sonnet-4.6", "gpt-5.2-codex");
    const result = resolveAgentModel({ agent: "executor", env: envEmpty, catalog });
    expect(result.family).toBe("claude");
  });

  it("defaults to claude when no agent specified and no env var", () => {
    const catalog = new Map<string, AgentSpec>();
    const result = resolveAgentModel({
      env,
      catalog,
      fallback: { claude: "claude-opus-4.7", gpt: "gpt-5.4" },
    });
    expect(result.family).toBe("claude");
    expect(result.model).toBe("claude-opus-4.7");
  });
});

// ── live agent catalog integration (reads real agents/ dir) ───────────────────

describe("live catalog: executor agent routing by OMCP_MODEL_FAMILY", () => {
  it("OMCP_MODEL_FAMILY=claude resolves real executor.md claude model", () => {
    const catalog = loadAgentCatalog(AGENTS_DIR);
    const env: NodeJS.ProcessEnv = { OMCP_MODEL_FAMILY: "claude" };
    const result = resolveAgentModel({ agent: "executor", env, catalog });
    expect(result.family).toBe("claude");
    expect(result.model).toMatch(/^claude/);
  });

  it("OMCP_MODEL_FAMILY=gpt resolves real executor.md gpt model", () => {
    const catalog = loadAgentCatalog(AGENTS_DIR);
    const env: NodeJS.ProcessEnv = { OMCP_MODEL_FAMILY: "gpt" };
    const result = resolveAgentModel({ agent: "executor", env, catalog });
    expect(result.family).toBe("gpt");
    expect(result.model).toMatch(/^gpt/);
  });

  it("auto with no config resolves to default claude family from real catalog", () => {
    const catalog = loadAgentCatalog(AGENTS_DIR);
    const env: NodeJS.ProcessEnv = { OMCP_MODEL_FAMILY: "auto" };
    const result = resolveAgentModel({ agent: "executor", env, catalog });
    expect(result.family).toBe("claude");
    expect(result.model).toMatch(/^claude/);
  });
});
