import { describe, it, expect } from "vitest";
import { resolveFamily, pickModel } from "../runtime/model-routing.js";

describe("resolveFamily", () => {
  const empty: NodeJS.ProcessEnv = {};

  it("returns explicit override when given", () => {
    expect(resolveFamily("gpt", empty, undefined)).toBe("gpt");
    expect(resolveFamily("claude", empty, undefined)).toBe("claude");
  });

  it("treats 'auto' override as no-override", () => {
    expect(resolveFamily("auto", { OMCP_MODEL_FAMILY: "gpt" }, undefined)).toBe("gpt");
  });

  it("respects OMCP_MODEL_FAMILY env var", () => {
    expect(resolveFamily(undefined, { OMCP_MODEL_FAMILY: "gpt" }, undefined)).toBe("gpt");
    expect(resolveFamily(undefined, { OMCP_MODEL_FAMILY: "CLAUDE" }, undefined)).toBe("claude");
  });

  it("infers family from Copilot config model prefix", () => {
    expect(resolveFamily(undefined, empty, "claude-opus-4.7")).toBe("claude");
    expect(resolveFamily(undefined, empty, "gpt-5.2-codex")).toBe("gpt");
  });

  it("defaults to claude when nothing else applies", () => {
    expect(resolveFamily(undefined, empty, undefined)).toBe("claude");
  });
});

describe("pickModel", () => {
  const dual = { claude: "claude-opus-4.7", gpt: "gpt-5.4" };

  it("returns the family-specific model", () => {
    expect(pickModel(dual, "claude")).toBe("claude-opus-4.7");
    expect(pickModel(dual, "gpt")).toBe("gpt-5.4");
  });
});
