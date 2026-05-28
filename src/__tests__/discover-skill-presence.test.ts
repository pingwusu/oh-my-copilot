/**
 * RP-08 drift-prevention test for skills/discover/SKILL.md.
 *
 * Asserts the SKILL.md exists AND contains the load-bearing sections:
 *   - 6 parallel scan agents (security-reviewer, architect, code-reviewer,
 *     tracer, scientist, document-specialist)
 *   - backlog.md output path (.omcp/discover/backlog.md)
 *   - Consolidation phase (deduplication + priority scoring)
 *   - Telemetry calls referencing `omcp skill-invocation-emit --skill discover`
 *   - No banned tokens (Invariant 7 sweep — mirrors verify-catalog.ts BANNED_TOKENS)
 *
 * Fails loudly when any of the above goes missing in a future SKILL.md edit.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect } from "vitest";

const SKILL_PATH = join(
  __dirname,
  "..",
  "..",
  "skills",
  "discover",
  "SKILL.md",
);

const MIRROR_PATH = join(
  __dirname,
  "..",
  "..",
  "plugins",
  "oh-my-copilot",
  "skills",
  "discover",
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

describe("discover SKILL.md presence + drift-prevention (RP-08)", () => {
  it("SKILL.md exists at skills/discover/SKILL.md", () => {
    expect(existsSync(SKILL_PATH)).toBe(true);
  });

  it("plugin mirror exists at plugins/oh-my-copilot/skills/discover/SKILL.md", () => {
    expect(existsSync(MIRROR_PATH)).toBe(true);
  });

  it("documents all 6 parallel scan agents", () => {
    const body = readFileSync(SKILL_PATH, "utf8");
    const requiredAgents = [
      "security-reviewer",
      "architect",
      "code-reviewer",
      "tracer",
      "scientist",
      "document-specialist",
    ];
    for (const agent of requiredAgents) {
      expect(body, `missing agent: ${agent} (RP-08 requires 6 parallel scan agents)`).toMatch(
        new RegExp(agent),
      );
    }
  });

  it("references .omcp/discover/backlog.md as the output path", () => {
    const body = readFileSync(SKILL_PATH, "utf8");
    expect(body).toMatch(/\.omcp\/discover\/backlog\.md/);
  });

  it("contains consolidation phase with deduplication", () => {
    const body = readFileSync(SKILL_PATH, "utf8");
    // Must describe deduplication of findings
    expect(body).toMatch(/[Dd]eduplic/);
    // Must describe priority scoring or ranking
    expect(body).toMatch(/priorit[yi]/i);
  });

  it("invokes omcp skill-invocation-emit --skill discover", () => {
    const body = readFileSync(SKILL_PATH, "utf8");
    expect(body).toMatch(/omcp skill-invocation-emit --skill discover/);
  });

  it("references all three event values (started|completed|failed)", () => {
    const body = readFileSync(SKILL_PATH, "utf8");
    expect(body).toMatch(/--event started/);
    expect(body).toMatch(/--event completed/);
    expect(body).toMatch(/--event failed/);
  });

  it("contains zero banned tokens (Invariant 7)", () => {
    const body = readFileSync(SKILL_PATH, "utf8");
    const offenders = BANNED_TOKENS.filter((tok) => body.includes(tok));
    expect(
      offenders,
      `Banned tokens found in skills/discover/SKILL.md: ${offenders.join(", ")}`,
    ).toEqual([]);
  });
});
