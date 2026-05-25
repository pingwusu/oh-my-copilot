/**
 * Unit tests for Story 8 / US-omcp-parity-P3-CHAIN-parser.
 *
 * Pure parser tests — no Node.js child_process, no filesystem, no mocks.
 * Covers:
 *   - Canonical 3-step example from the iter-2 plan
 *   - Empty spec → empty step list (legacy ralplan back-compat)
 *   - Single-step / multi-step / args / no-args
 *   - Malformed input (no leading --then / --then with no verb / --then --then)
 *   - Tokenizer edge cases (whitespace, trailing whitespace, tabs)
 *   - ChainParseError type assertion for catch-side handling in CLI
 */

import { describe, expect, it } from "vitest";

import {
  ChainParseError,
  parseChainArgs,
  parseChainSpec,
  tokenizeChainSpec,
} from "../cli/commands/chain.js";

describe("tokenizeChainSpec", () => {
  it("splits a normal spec on whitespace", () => {
    expect(tokenizeChainSpec("--then team 4 fix-typo --then ralph-verify")).toEqual(
      ["--then", "team", "4", "fix-typo", "--then", "ralph-verify"],
    );
  });

  it("returns empty array for empty string", () => {
    expect(tokenizeChainSpec("")).toEqual([]);
  });

  it("returns empty array for whitespace-only string", () => {
    expect(tokenizeChainSpec("   \t  \n  ")).toEqual([]);
  });

  it("collapses runs of whitespace + tabs + newlines", () => {
    expect(tokenizeChainSpec("  --then   foo\t\tbar  \n  --then baz  ")).toEqual([
      "--then",
      "foo",
      "bar",
      "--then",
      "baz",
    ]);
  });
});

describe("parseChainArgs — canonical iter-2 plan example", () => {
  it("parses '--then team 4 fix-typo --then ralph-verify' into 2 steps", () => {
    const steps = parseChainArgs([
      "--then",
      "team",
      "4",
      "fix-typo",
      "--then",
      "ralph-verify",
    ]);
    expect(steps).toHaveLength(2);
    expect(steps[0]).toEqual({ verb: "team", args: ["4", "fix-typo"] });
    expect(steps[1]).toEqual({ verb: "ralph-verify", args: [] });
  });
});

describe("parseChainArgs — empty + minimal", () => {
  it("returns empty array for empty token list (legacy ralplan back-compat)", () => {
    expect(parseChainArgs([])).toEqual([]);
  });

  it("parses a single step with no args", () => {
    expect(parseChainArgs(["--then", "team-verify"])).toEqual([
      { verb: "team-verify", args: [] },
    ]);
  });

  it("parses a single step with one arg", () => {
    expect(parseChainArgs(["--then", "team", "4"])).toEqual([
      { verb: "team", args: ["4"] },
    ]);
  });

  it("parses three sequential steps", () => {
    const steps = parseChainArgs([
      "--then",
      "ralplan",
      "fix-readme",
      "--then",
      "team",
      "2",
      "executor",
      "--then",
      "ralph-verify",
    ]);
    expect(steps).toHaveLength(3);
    expect(steps[0]).toEqual({ verb: "ralplan", args: ["fix-readme"] });
    expect(steps[1]).toEqual({ verb: "team", args: ["2", "executor"] });
    expect(steps[2]).toEqual({ verb: "ralph-verify", args: [] });
  });
});

describe("parseChainArgs — malformed input rejected", () => {
  it("throws when first token is not --then", () => {
    expect(() => parseChainArgs(["team", "4"])).toThrow(ChainParseError);
    expect(() => parseChainArgs(["team", "4"])).toThrow(/expected '--then'/);
  });

  it("throws when --then has no following verb (end of tokens)", () => {
    expect(() => parseChainArgs(["--then"])).toThrow(ChainParseError);
    expect(() => parseChainArgs(["--then"])).toThrow(/not followed by a verb/);
  });

  it("throws when --then is followed by another --then (empty verb slot)", () => {
    expect(() =>
      parseChainArgs(["--then", "--then", "ralph-verify"]),
    ).toThrow(ChainParseError);
    expect(() =>
      parseChainArgs(["--then", "--then", "ralph-verify"]),
    ).toThrow(/another '--then'/);
  });

  it("throws when --then is followed by an option-like token", () => {
    expect(() =>
      parseChainArgs(["--then", "--family", "claude"]),
    ).toThrow(ChainParseError);
    expect(() =>
      parseChainArgs(["--then", "--family", "claude"]),
    ).toThrow(/option-like token/);
  });

  it("throws when a step's args are followed by a stray token that should have been --then", () => {
    // After parsing "--then team 4", the next token MUST be either nothing
    // (end) or --then (next step). A bare "junk" position can never appear
    // here because the inner while-loop greedily consumes args until --then.
    // So the only way to reach this error is starting with a non--then token.
    expect(() => parseChainArgs(["junk", "--then", "team"])).toThrow(
      /expected '--then'/,
    );
  });
});

describe("parseChainSpec (string convenience wrapper)", () => {
  it("returns [] for empty string", () => {
    expect(parseChainSpec("")).toEqual([]);
  });

  it("returns [] for whitespace-only string", () => {
    expect(parseChainSpec("   ")).toEqual([]);
  });

  it("composes tokenize + parse correctly for the iter-2 plan example", () => {
    expect(parseChainSpec("--then team 4 fix-typo --then ralph-verify")).toEqual([
      { verb: "team", args: ["4", "fix-typo"] },
      { verb: "ralph-verify", args: [] },
    ]);
  });

  it("ChainParseError surfaces from parseChainSpec when input is malformed", () => {
    expect(() => parseChainSpec("garbage in")).toThrow(ChainParseError);
  });
});

describe("ChainParseError class", () => {
  it("is named 'ChainParseError'", () => {
    expect(new ChainParseError("x").name).toBe("ChainParseError");
  });

  it("is instanceof Error and ChainParseError", () => {
    try {
      parseChainArgs(["broken"]);
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(Error);
      expect(err).toBeInstanceOf(ChainParseError);
    }
  });

  it("preserves the error message body", () => {
    try {
      parseChainArgs(["--then"]);
    } catch (err) {
      expect((err as Error).message).toContain("not followed by a verb");
    }
  });
});
