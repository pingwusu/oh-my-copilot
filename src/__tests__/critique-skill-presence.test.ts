/**
 * RP-06 drift-prevention test for skills/critique/SKILL.md.
 *
 * Asserts the SKILL.md exists AND contains the load-bearing sections:
 *   - mode:critique invocation dispatched via [mode: critique] prefix
 *   - Telemetry calls with omcp skill-invocation-emit --skill critique
 *   - All three event values (started|completed|failed)
 *   - BLOCK verdict documented
 *   - APPROVE-WITH-NOTES and APPROVE verdicts documented
 *   - Do_Not_Use_When cross-link to deep-review (critique = commit-scoped only)
 *   - No banned tokens (Invariant 7 sweep — mirrors verify-catalog.ts BANNED_TOKENS)
 *
 * Fails loudly when any of the above goes missing in a future SKILL.md edit.
 * ADR-RP-06: PORT-ROBIN (justified divergence) — omc lacks this skill;
 * divergence justified as load-bearing pre-push gate capability gap.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect } from "vitest";

const SKILL_PATH = join(
  __dirname,
  "..",
  "..",
  "skills",
  "critique",
  "SKILL.md",
);

const MIRROR_PATH = join(
  __dirname,
  "..",
  "..",
  "plugins",
  "oh-my-copilot",
  "skills",
  "critique",
  "SKILL.md",
);

// Invariant 7 — same list as verify-catalog.ts BANNED_TOKENS.
const BANNED_TOKENS = [
  "TodoWrite",
  "AskUserQuestion",
  "Task(subagent_type=",
  "/oh-my-claudecode:",
  ".omc/",
  "EnterPlanMode",
  "ExitPlanMode",
  "ToolSearch",
  "<remember>",
  "<remember priority>",
  'Skill("oh-my-copilot:',
  '"subagent_type":',
];

describe("critique SKILL.md presence + drift-prevention (RP-06)", () => {
  it("SKILL.md exists at skills/critique/SKILL.md", () => {
    expect(
      existsSync(SKILL_PATH),
      "skills/critique/SKILL.md must exist — RP-06 skill file is missing",
    ).toBe(true);
  });

  it("mirror exists at plugins/oh-my-copilot/skills/critique/SKILL.md", () => {
    expect(
      existsSync(MIRROR_PATH),
      "plugins/oh-my-copilot/skills/critique/SKILL.md must exist — mirror is out of sync",
    ).toBe(true);
  });

  it("dispatches critic with [mode: critique] to activate Critique_Mode_Protocol", () => {
    const body = readFileSync(SKILL_PATH, "utf8");
    expect(
      body,
      "[mode: critique] dispatch prefix missing from skills/critique/SKILL.md",
    ).toMatch(/\[mode: critique\]/);
  });

  it("invokes omcp skill-invocation-emit --skill critique (telemetry)", () => {
    const body = readFileSync(SKILL_PATH, "utf8");
    expect(
      body,
      "omcp skill-invocation-emit --skill critique missing from skills/critique/SKILL.md",
    ).toMatch(/omcp skill-invocation-emit --skill critique/);
  });

  it("references all three telemetry event values (started|completed|failed)", () => {
    const body = readFileSync(SKILL_PATH, "utf8");
    expect(body, "--event started missing from skills/critique/SKILL.md").toMatch(/--event started/);
    expect(body, "--event completed missing from skills/critique/SKILL.md").toMatch(
      /--event completed/,
    );
    expect(body, "--event failed missing from skills/critique/SKILL.md").toMatch(/--event failed/);
  });

  it("documents BLOCK verdict (pre-push gate core)", () => {
    const body = readFileSync(SKILL_PATH, "utf8");
    expect(
      body,
      "BLOCK verdict missing from skills/critique/SKILL.md — pre-push gate requires BLOCK outcome",
    ).toMatch(/\*\*BLOCK\*\*|VERDICT: BLOCK/);
  });

  it("documents APPROVE-WITH-NOTES and APPROVE verdicts", () => {
    const body = readFileSync(SKILL_PATH, "utf8");
    expect(body, "APPROVE-WITH-NOTES verdict missing from skills/critique/SKILL.md").toMatch(
      /APPROVE-WITH-NOTES/,
    );
    expect(body, "APPROVE verdict missing from skills/critique/SKILL.md").toMatch(/\bAPPROVE\b/);
  });

  it("cross-links to deep-review in Do_Not_Use_When (critique = commit-scoped only)", () => {
    const body = readFileSync(SKILL_PATH, "utf8");
    expect(
      body,
      "deep-review cross-link missing from Do_Not_Use_When — critique must be scoped to unpushed commits only",
    ).toMatch(/deep-review/);
  });

  it("contains zero banned tokens (Invariant 7)", () => {
    const body = readFileSync(SKILL_PATH, "utf8");
    const offenders = BANNED_TOKENS.filter((tok) => body.includes(tok));
    expect(
      offenders,
      `skills/critique/SKILL.md contains banned tokens (Invariant 7): ${offenders.join(", ")}`,
    ).toEqual([]);
  });

  it("mirror content matches source (mirror sync invariant)", () => {
    const source = readFileSync(SKILL_PATH, "utf8");
    const mirror = readFileSync(MIRROR_PATH, "utf8");
    expect(
      mirror,
      "plugins/oh-my-copilot/skills/critique/SKILL.md is out of sync with skills/critique/SKILL.md",
    ).toBe(source);
  });
});
