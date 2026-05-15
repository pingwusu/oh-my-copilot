import { describe, it, expect } from "vitest";
import { parseInterval, runLoop } from "../cli/commands/loop.js";

describe("parseInterval", () => {
  it("ms", () => expect(parseInterval("250ms")).toBe(250));
  it("seconds", () => expect(parseInterval("30s")).toBe(30_000));
  it("minutes", () => expect(parseInterval("5m")).toBe(300_000));
  it("hours", () => expect(parseInterval("2h")).toBe(7_200_000));
  it("default unit is seconds", () => expect(parseInterval("3")).toBe(3000));
  it("rejects garbage", () => {
    expect(() => parseInterval("forever")).toThrow();
    expect(() => parseInterval("5d")).toThrow();
  });
});

describe("runLoop with maxIterations", () => {
  it("stops at max iterations", async () => {
    const iters: number[] = [];
    await runLoop({
      interval: "1ms",
      cmd: [process.execPath, "-e", "process.exit(0)"],
      maxIterations: 3,
      onIteration: (n) => iters.push(n),
    });
    expect(iters).toEqual([1, 2, 3]);
  }, 5000);
});
