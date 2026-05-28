/**
 * RP-07 drift-prevention test for skills/deep-review/SKILL.md.
 *
 * Asserts the SKILL.md exists AND contains the load-bearing sections:
 *   - 4-pass structure (security, correctness, architecture, docs+tests)
 *   - Parallel dispatch prose (all four passes dispatched without waiting)
 *   - Telemetry invocations referencing `omcp skill-invocation-emit --skill deep-review`
 *   - Consolidation phase (de-duplicate + verdict assignment)
 *   - No banned tokens (Invariant 7 sweep — mirrors verify-catalog.ts BANNED_TOKENS)
 *
 * Fails loudly when any of the above goes missing in a future SKILL.md edit.
 * ADR-RP-07: deep-review = formal PR/branch-scoped; critique = pre-push unpushed-commit-only.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect } from "vitest";

const SKILL_PATH = join(
  __dirname,
  "..",
  "..",
  "skills",
  "deep-review",
  "SKILL.md",
);

const MIRROR_PATH = join(
  __dirname,
  "..",
  "..",
  "plugins",
  "oh-my-copilot",
  "skills",
  "deep-review",
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

describe("deep-review SKILL.md presence + drift-prevention (RP-07)", () => {
  it("SKILL.md exists at skills/deep-review/SKILL.md", () => {
    expect(existsSync(SKILL_PATH)).toBe(true);
  });

  it("mirror exists at plugins/oh-my-copilot/skills/deep-review/SKILL.md", () => {
    expect(existsSync(MIRROR_PATH)).toBe(true);
  });

  it("documents the 4-pass structure: security, correctness, architecture, docs+tests", () => {
    const body = readFileSync(SKILL_PATH, "utf8");
    // Each pass must be named
    expect(body).toMatch(/security/i);
    expect(body).toMatch(/correctness/i);
    expect(body).toMatch(/architecture/i);
    // docs+tests pass (various spellings tolerated)
    expect(body).toMatch(/docs.*tests|tests.*docs/i);
  });

  it("references parallel dispatch of all four specialist agents", () => {
    const body = readFileSync(SKILL_PATH, "utf8");
    // Must mention that passes run in parallel / simultaneously
    expect(body).toMatch(/parallel|simultaneously/i);
    // Must reference the four agent roles used in dispatch
    expect(body).toMatch(/security-reviewer/);
    expect(body).toMatch(/code-reviewer/);
    expect(body).toMatch(/architect/);
    // critic in review mode
    expect(body).toMatch(/critic.*--mode[=\s]review|--mode[=\s]review.*critic/i);
  });

  it("contains a consolidation phase that de-duplicates and assigns a verdict", () => {
    const body = readFileSync(SKILL_PATH, "utf8");
    expect(body).toMatch(/[Cc]onsolidat/);
    expect(body).toMatch(/de-duplicate|deduplicate/i);
    // Verdict keywords
    expect(body).toMatch(/APPROVE/);
    expect(body).toMatch(/REQUEST CHANGES/);
  });

  it("invokes omcp skill-invocation-emit --skill deep-review for all three events", () => {
    const body = readFileSync(SKILL_PATH, "utf8");
    expect(body).toMatch(/omcp skill-invocation-emit --skill deep-review/);
    expect(body).toMatch(/--event started/);
    expect(body).toMatch(/--event completed/);
    expect(body).toMatch(/--event failed/);
  });

  it("cross-links critique skill with scope distinction", () => {
    const body = readFileSync(SKILL_PATH, "utf8");
    // Must mention critique and distinguish it from deep-review
    expect(body).toMatch(/critique/i);
    // The canonical distinction: critique = pre-push; deep-review = PR/branch-scoped
    expect(body).toMatch(/pre-push|before.*push|unpushed/i);
  });

  it("contains zero banned tokens (Invariant 7)", () => {
    const body = readFileSync(SKILL_PATH, "utf8");
    const offenders = BANNED_TOKENS.filter((tok) => body.includes(tok));
    if (offenders.length > 0) {
      console.error(
        "Banned tokens found in skills/deep-review/SKILL.md (Invariant 7):\n" +
          offenders.map((t) => `  "${t}"`).join("\n"),
      );
    }
    expect(offenders).toEqual([]);
  });

  it("mirror file matches source file byte-for-byte", () => {
    const source = readFileSync(SKILL_PATH, "utf8");
    const mirror = readFileSync(MIRROR_PATH, "utf8");
    expect(mirror).toBe(source);
  });
});
