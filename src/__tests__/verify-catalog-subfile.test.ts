import { describe, it, expect } from "vitest";
import { runVerify } from "../scripts/verify-catalog.js";

describe("verify-catalog subfile scan regression", () => {
  it("current repo state is clean (19 agents + 33 skills, no subfile token leak)", () => {
    const findings = runVerify();
    if (findings.length > 0) {
      console.error(
        "verify-catalog findings:\n" +
          findings.map((f) => `  ${f.file}: ${f.issue}`).join("\n"),
      );
    }
    expect(findings).toEqual([]);
  });
});
