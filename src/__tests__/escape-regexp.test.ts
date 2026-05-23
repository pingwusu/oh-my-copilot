import { describe, expect, it } from "vitest";
import { escapeRegExp } from "../runtime/escape-regexp.js";

describe("escapeRegExp", () => {
  it("leaves plain strings unchanged (no-op)", () => {
    expect(escapeRegExp("hello")).toBe("hello");
    expect(escapeRegExp("abc123_XYZ-9")).toBe("abc123_XYZ-9");
  });

  it("escapes every regex metachar", () => {
    expect(escapeRegExp(".")).toBe("\\.");
    expect(escapeRegExp("*")).toBe("\\*");
    expect(escapeRegExp("+")).toBe("\\+");
    expect(escapeRegExp("?")).toBe("\\?");
    expect(escapeRegExp("^")).toBe("\\^");
    expect(escapeRegExp("$")).toBe("\\$");
    expect(escapeRegExp("{")).toBe("\\{");
    expect(escapeRegExp("}")).toBe("\\}");
    expect(escapeRegExp("(")).toBe("\\(");
    expect(escapeRegExp(")")).toBe("\\)");
    expect(escapeRegExp("|")).toBe("\\|");
    expect(escapeRegExp("[")).toBe("\\[");
    expect(escapeRegExp("]")).toBe("\\]");
    expect(escapeRegExp("\\")).toBe("\\\\");
  });

  it("escapes metachars mixed with plain text", () => {
    expect(escapeRegExp("a.b")).toBe("a\\.b");
    expect(escapeRegExp("hello (world)?")).toBe("hello \\(world\\)\\?");
    expect(escapeRegExp("$100 + tax")).toBe("\\$100 \\+ tax");
  });

  it("returns empty string for empty input", () => {
    expect(escapeRegExp("")).toBe("");
  });

  it("produces a pattern that matches the literal string when used in new RegExp", () => {
    const literal = "a.b*c?";
    const re = new RegExp(escapeRegExp(literal));
    expect(re.test("a.b*c?")).toBe(true);
    expect(re.test("aXbXcX")).toBe(false);
  });
});
