import { describe, expect, it } from "vitest";
import { validateMemoryWrite } from "../mcp/memory-validation.js";

describe("validateMemoryWrite", () => {
  it("accepts plain primitives, arrays, and shallow objects", () => {
    expect(validateMemoryWrite("a", "hello").ok).toBe(true);
    expect(validateMemoryWrite("a", 42).ok).toBe(true);
    expect(validateMemoryWrite("a", true).ok).toBe(true);
    expect(validateMemoryWrite("a", null).ok).toBe(true);
    expect(validateMemoryWrite("a", [1, "x", false, null]).ok).toBe(true);
    expect(
      validateMemoryWrite("a", { x: 1, y: { z: [1, 2, 3] } }).ok,
    ).toBe(true);
  });

  it("rejects keys with newlines or empty keys", () => {
    expect(validateMemoryWrite("", "v").ok).toBe(false);
    const r = validateMemoryWrite("bad\nkey", "v");
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/newline|null/i);
  });

  it("rejects unsupported value types (undefined, function, symbol, bigint, Date)", () => {
    expect(validateMemoryWrite("k", undefined).ok).toBe(false);
    expect(validateMemoryWrite("k", () => 1).ok).toBe(false);
    expect(validateMemoryWrite("k", Symbol("x")).ok).toBe(false);
    expect(validateMemoryWrite("k", BigInt(1)).ok).toBe(false);
    expect(validateMemoryWrite("k", new Date()).ok).toBe(false);
    expect(validateMemoryWrite("k", new Map()).ok).toBe(false);
  });

  it("rejects non-finite numbers", () => {
    expect(validateMemoryWrite("k", Number.NaN).ok).toBe(false);
    expect(validateMemoryWrite("k", Number.POSITIVE_INFINITY).ok).toBe(false);
    expect(validateMemoryWrite("k", Number.NEGATIVE_INFINITY).ok).toBe(false);
  });

  it("rejects deeply-nested objects (depth > 5)", () => {
    // depth 6 — outermost object is depth 0, nested values increment.
    const deep = {
      a: { b: { c: { d: { e: { f: "too far" } } } } },
    };
    const r = validateMemoryWrite("k", deep);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/nested/i);

    // depth 5 — at the limit, must still pass.
    const ok = { a: { b: { c: { d: { e: "ok" } } } } };
    expect(validateMemoryWrite("k", ok).ok).toBe(true);
  });

  it("rejects values larger than 64KB serialized", () => {
    const big = "x".repeat(65 * 1024);
    const r = validateMemoryWrite("k", big);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/byte/i);
  });
});
