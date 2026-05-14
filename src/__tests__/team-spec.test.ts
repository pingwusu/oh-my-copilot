import { describe, it, expect } from "vitest";
import { parseTeamSpec } from "../cli/commands/team.js";

describe("parseTeamSpec", () => {
  it("parses N:agent form", () => {
    expect(parseTeamSpec("4:executor")).toEqual({ count: 4, agent: "executor" });
  });

  it("parses N-only form", () => {
    expect(parseTeamSpec("3")).toEqual({ count: 3, agent: undefined });
  });

  it("rejects non-positive counts", () => {
    expect(() => parseTeamSpec("0:executor")).toThrow();
    expect(() => parseTeamSpec("-2:executor")).toThrow();
    expect(() => parseTeamSpec("abc")).toThrow();
  });

  it("rejects agent with disallowed chars", () => {
    expect(() => parseTeamSpec("2:bad agent")).toThrow();
    expect(() => parseTeamSpec("2:bad/agent")).toThrow();
  });

  it("accepts agent slug variants", () => {
    expect(parseTeamSpec("2:code-reviewer")).toEqual({ count: 2, agent: "code-reviewer" });
    expect(parseTeamSpec("2:git_master")).toEqual({ count: 2, agent: "git_master" });
  });
});
