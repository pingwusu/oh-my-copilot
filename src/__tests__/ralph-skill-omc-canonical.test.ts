// Drift-prevention: assert skills/ralph/SKILL.md retains the 3 omc-canonical flags.
// These flags are present at lines 43, 45, 47 (verified by Architect/Critic iter-2 grep).
// If a future edit removes any of them this test fails loudly.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

const SKILL_PATH = resolve(__dirname, "..", "..", "skills", "ralph", "SKILL.md");

describe("ralph SKILL.md drift prevention vs omc canonical", () => {
  let body: string;

  beforeAll(() => {
    body = readFileSync(SKILL_PATH, "utf8");
  });

  it("contains --no-prd flag opt-out section (omc canonical line ~43)", () => {
    expect(body, "omc canonical --no-prd flag is missing from skills/ralph/SKILL.md").toMatch(
      /--no-prd/,
    );
    expect(body, "omc canonical Opt-out: --no-prd pattern is missing from skills/ralph/SKILL.md").toMatch(
      /Opt-out:.*--no-prd/i,
    );
  });

  it("contains --no-deslop flag opt-out section (omc canonical line ~45)", () => {
    expect(body, "omc canonical --no-deslop flag is missing from skills/ralph/SKILL.md").toMatch(
      /--no-deslop/,
    );
    expect(
      body,
      "omc canonical Deslop opt-out: --no-deslop pattern is missing from skills/ralph/SKILL.md",
    ).toMatch(/Deslop opt-out:.*--no-deslop/i);
  });

  it("contains --critic={architect|critic|codex} reviewer selection (omc canonical line ~47)", () => {
    expect(body, "--critic=architect missing from skills/ralph/SKILL.md").toMatch(
      /--critic=architect/,
    );
    expect(body, "--critic=critic missing from skills/ralph/SKILL.md").toMatch(/--critic=critic/);
    expect(body, "--critic=codex missing from skills/ralph/SKILL.md").toMatch(/--critic=codex/);
    expect(body, "Reviewer selection section missing from skills/ralph/SKILL.md").toMatch(
      /Reviewer selection/i,
    );
  });
});
