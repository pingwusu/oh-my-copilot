/**
 * RP-09 drift-prevention test for skills/ralph-experiment/SKILL.md.
 *
 * Asserts the SKILL.md exists AND contains the load-bearing sections:
 *   - <Experiment_Notebook_Schema> block with `.omcp/experiment-notebook.json` path
 *   - KEEP / DISCARD decision matrix
 *   - Telemetry call referencing `omcp skill-invocation-emit --skill ralph-experiment`
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
  "ralph-experiment",
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

describe("ralph-experiment SKILL.md presence + drift-prevention", () => {
  it("SKILL.md exists at skills/ralph-experiment/SKILL.md", () => {
    expect(existsSync(SKILL_PATH)).toBe(true);
  });

  it("contains <Experiment_Notebook_Schema> with .omcp/experiment-notebook.json path", () => {
    const body = readFileSync(SKILL_PATH, "utf8");
    expect(body).toMatch(/<Experiment_Notebook_Schema>/);
    expect(body).toMatch(/\.omcp\/experiment-notebook\.json/);
  });

  it("documents the KEEP / DISCARD decision matrix", () => {
    const body = readFileSync(SKILL_PATH, "utf8");
    expect(body).toMatch(/\*\*KEEP\*\*/);
    expect(body).toMatch(/\*\*DISCARD\*\*/);
  });

  it("invokes omcp skill-invocation-emit --skill ralph-experiment", () => {
    const body = readFileSync(SKILL_PATH, "utf8");
    expect(body).toMatch(
      /omcp skill-invocation-emit --skill ralph-experiment/,
    );
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
    expect(offenders).toEqual([]);
  });
});
