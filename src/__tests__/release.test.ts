import { describe, it, expect } from "vitest";
import { release } from "../scripts/release.js";

describe("release", () => {
  it("dry-run reports next version without writing", () => {
    const r = release(["--dry-run", "patch"]);
    expect(r.dryRun).toBe(true);
    expect(r.from).toMatch(/^\d+\.\d+\.\d+$/);
    expect(r.to).toMatch(/^\d+\.\d+\.\d+$/);
    expect(r.touched).toContain("package.json");
    expect(r.touched).toContain(".claude-plugin/plugin.json");
    expect(r.touched).toContain(".agents/plugins/marketplace.json");
    expect(r.touched).toContain("CHANGELOG.md");
    expect(r.tag).toMatch(/^v\d+\.\d+\.\d+$/);
  });

  it("dry-run with explicit semver target", () => {
    const r = release(["--dry-run", "9.9.9"]);
    expect(r.to).toBe("9.9.9");
    expect(r.tag).toBe("v9.9.9");
  });

  it("invalid semver rejected", () => {
    expect(() => release(["--dry-run", "1.2"])).toThrow(/semver/);
  });

  it("kinds bump correctly from current", () => {
    const patch = release(["--dry-run", "patch"]);
    const minor = release(["--dry-run", "minor"]);
    const major = release(["--dry-run", "major"]);
    expect(patch.to).not.toBe(minor.to);
    expect(minor.to).not.toBe(major.to);
  });
});
