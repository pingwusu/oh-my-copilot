import { join } from "node:path";
import { describe, it, expect } from "vitest";
import {
  loadAgentCatalog,
  readAgentSpec,
  resolveAgentModel,
} from "../runtime/agent-models.js";

const AGENTS_DIR = join(__dirname, "..", "..", "agents");

describe("agent-models", () => {
  it("loads the full catalog", () => {
    const catalog = loadAgentCatalog(AGENTS_DIR);
    expect(catalog.size).toBeGreaterThanOrEqual(19);
    const executor = catalog.get("executor");
    expect(executor).toBeDefined();
    expect(executor!.model.claude).toContain("claude");
    expect(executor!.model.gpt).toContain("gpt");
  });

  it("readAgentSpec parses dual model frontmatter", () => {
    const spec = readAgentSpec(join(AGENTS_DIR, "explore.md"));
    expect(spec).not.toBeNull();
    expect(spec!.name).toBe("explore");
    expect(spec!.model.claude).toBe("claude-haiku-4.5");
    expect(spec!.model.gpt).toBe("gpt-5-mini");
  });

  it("resolveAgentModel: agent + claude override picks agent's claude", () => {
    const catalog = loadAgentCatalog(AGENTS_DIR);
    const r = resolveAgentModel({
      agent: "executor",
      override: "claude",
      env: {},
      catalog,
    });
    expect(r.family).toBe("claude");
    expect(r.model).toMatch(/^claude/);
  });

  it("resolveAgentModel: agent + gpt override picks agent's gpt", () => {
    const catalog = loadAgentCatalog(AGENTS_DIR);
    const r = resolveAgentModel({
      agent: "explore",
      override: "gpt",
      env: {},
      catalog,
    });
    expect(r.family).toBe("gpt");
    expect(r.model).toBe("gpt-5-mini");
  });

  it("resolveAgentModel: no agent → uses fallback", () => {
    const catalog = new Map();
    const r = resolveAgentModel({
      override: "claude",
      env: {},
      catalog,
      fallback: { claude: "claude-opus-4.7", gpt: "gpt-5.4" },
    });
    expect(r.model).toBe("claude-opus-4.7");
  });

  it("resolveAgentModel: env var picks family when no override", () => {
    const catalog = loadAgentCatalog(AGENTS_DIR);
    const r = resolveAgentModel({
      agent: "planner",
      env: { OMCP_MODEL_FAMILY: "gpt" },
      catalog,
    });
    expect(r.family).toBe("gpt");
    expect(r.model).toBe("gpt-5.4");
  });

  it("resolveAgentModel: copilot config model prefix infers family", () => {
    const catalog = loadAgentCatalog(AGENTS_DIR);
    const r = resolveAgentModel({
      agent: "planner",
      env: {},
      copilotConfigModel: "gpt-5.2",
      catalog,
    });
    expect(r.family).toBe("gpt");
    expect(r.model).toBe("gpt-5.4");
  });

  it("unknown agent falls back to default dual", () => {
    const catalog = loadAgentCatalog(AGENTS_DIR);
    const r = resolveAgentModel({
      agent: "no-such-agent",
      override: "claude",
      env: {},
      catalog,
    });
    expect(r.family).toBe("claude");
    expect(r.model).toBe("claude-sonnet-4.6");
  });
});
