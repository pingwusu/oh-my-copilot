import { describe, it, expect } from "vitest";
import { runVerify } from "../scripts/verify-catalog.js";

describe("verify-catalog", () => {
  it("all shipped agents and skills pass invariants", () => {
    const findings = runVerify();
    if (findings.length > 0) {
      console.error(
        "Catalog issues:\n" + findings.map((f) => `  ${f.file}: ${f.issue}`).join("\n"),
      );
    }
    expect(findings).toEqual([]);
  });
});
