import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "fs";
import { join } from "path";

const DOC_PATH = join(process.cwd(), "docs/workflows/team-critic-verification.md");

const MANDATORY_HEADINGS = [
  "## Step 1: Executor Diff and Acceptance Criteria",
  "## Step 2: Architect Review",
  "## Step 3: Critic Cross-Check",
  "## Step 4: Phase Pass Condition",
  "## Step 5: Iterate or Reject Loop",
];

describe("docs/workflows/team-critic-verification.md", () => {
  it("file exists", () => {
    expect(existsSync(DOC_PATH)).toBe(true);
  });

  it("contains all 5 mandatory section headings", () => {
    const content = readFileSync(DOC_PATH, "utf8");
    for (const heading of MANDATORY_HEADINGS) {
      expect(content).toContain(heading);
    }
  });

  it("step 1 heading present", () => {
    const content = readFileSync(DOC_PATH, "utf8");
    expect(content).toContain(MANDATORY_HEADINGS[0]);
  });

  it("step 2 heading present", () => {
    const content = readFileSync(DOC_PATH, "utf8");
    expect(content).toContain(MANDATORY_HEADINGS[1]);
  });

  it("step 3 heading present", () => {
    const content = readFileSync(DOC_PATH, "utf8");
    expect(content).toContain(MANDATORY_HEADINGS[2]);
  });

  it("step 4 heading present", () => {
    const content = readFileSync(DOC_PATH, "utf8");
    expect(content).toContain(MANDATORY_HEADINGS[3]);
  });

  it("step 5 heading present", () => {
    const content = readFileSync(DOC_PATH, "utf8");
    expect(content).toContain(MANDATORY_HEADINGS[4]);
  });

  it("documents APPROVE/ITERATE/REJECT verdicts", () => {
    const content = readFileSync(DOC_PATH, "utf8");
    expect(content).toContain("APPROVE");
    expect(content).toContain("ITERATE");
    expect(content).toContain("REJECT");
  });

  it("documents maximum 5 iterations", () => {
    const content = readFileSync(DOC_PATH, "utf8");
    expect(content).toContain("5");
  });

  it("references omcp verify CLI verb placeholder", () => {
    const content = readFileSync(DOC_PATH, "utf8");
    expect(content).toContain("omcp verify <phase-id>");
  });

  it("includes Phase 1.5 closure examples (3 tracks)", () => {
    const content = readFileSync(DOC_PATH, "utf8");
    expect(content).toContain("Track A");
    expect(content).toContain("Track B");
    expect(content).toContain("Track C");
  });

  it("references atomicWriteFileSync for state persistence", () => {
    const content = readFileSync(DOC_PATH, "utf8");
    expect(content).toContain("atomicWriteFileSync");
  });

  it("references assertSafeSlug for path safety", () => {
    const content = readFileSync(DOC_PATH, "utf8");
    expect(content).toContain("assertSafeSlug");
  });

  it("headings appear in correct order", () => {
    const content = readFileSync(DOC_PATH, "utf8");
    const positions = MANDATORY_HEADINGS.map((h) => content.indexOf(h));
    for (let i = 1; i < positions.length; i++) {
      expect(positions[i]).toBeGreaterThan(positions[i - 1]);
    }
  });
});
