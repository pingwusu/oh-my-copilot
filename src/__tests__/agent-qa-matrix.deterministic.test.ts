// Story A: US-1.8-T4-AGENT-matrix
// 19-agent QA matrix — deterministic checks per agent:
//   1. YAML frontmatter has model.claude AND model.gpt (non-empty)
//   2. Prompt body contains zero banned tokens (Invariant 7)
//   3. Agent is registered in loadAgentCatalog

import { join } from "node:path";
import { readFileSync, existsSync } from "node:fs";
import { describe, it, expect } from "vitest";
import { loadAgentCatalog } from "../runtime/agent-models.js";

const AGENTS_DIR = join(__dirname, "..", "..", "agents");

// Invariant 7 — Claude-only tool names must not appear in shipped prompts.
// Per CLAUDE.md "Tooling differences" and verify-catalog.ts BANNED_TOKENS.
const BANNED_TOKENS = [
  "Task tool",
  "EnterPlanMode",
  "ExitPlanMode",
  "TaskCreate",
  "TaskList",
  "TaskGet",
];

const AGENT_NAMES = [
  "analyst",
  "architect",
  "code-reviewer",
  "code-simplifier",
  "critic",
  "debugger",
  "designer",
  "document-specialist",
  "executor",
  "explore",
  "git-master",
  "planner",
  "qa-tester",
  "scientist",
  "security-reviewer",
  "test-engineer",
  "tracer",
  "verifier",
  "writer",
] as const;

// Parse nested YAML block:
//   model:
//     claude: <value>
//     gpt: <value>
function parseDualModelFromFrontmatter(text: string): { claude?: string; gpt?: string } | null {
  if (!text.startsWith("---")) return null;
  const end = text.indexOf("\n---", 3);
  if (end === -1) return null;
  const block = text.slice(3, end);
  const lines = block.split(/\r?\n/);
  let inModel = false;
  let claude: string | undefined;
  let gpt: string | undefined;
  for (const line of lines) {
    if (/^model:\s*$/.test(line)) { inModel = true; continue; }
    if (inModel) {
      const m = line.match(/^\s+(claude|gpt):\s*(.+)$/);
      if (m) {
        if (m[1] === "claude") claude = m[2].trim();
        else gpt = m[2].trim();
      } else if (!/^\s/.test(line) && line.trim() !== "") {
        inModel = false;
      }
    }
  }
  if (claude !== undefined || gpt !== undefined) return { claude, gpt };
  return null;
}

function getBody(text: string): string {
  const end = text.indexOf("\n---", 3);
  if (end === -1) return text;
  return text.slice(end + 4);
}

const catalog = loadAgentCatalog(AGENTS_DIR);

describe("19-agent QA matrix (Invariant 7 — no banned tokens)", () => {
  it.each(AGENT_NAMES)("%s: frontmatter model.claude + model.gpt present and non-empty", (name) => {
    const filePath = join(AGENTS_DIR, `${name}.md`);
    expect(existsSync(filePath), `agents/${name}.md must exist`).toBe(true);
    const text = readFileSync(filePath, "utf8");
    const dual = parseDualModelFromFrontmatter(text);
    expect(dual, `${name}: model block must be present`).not.toBeNull();
    expect(dual!.claude, `${name}: model.claude must be non-empty`).toBeTruthy();
    expect(dual!.gpt, `${name}: model.gpt must be non-empty`).toBeTruthy();
  });

  it.each(AGENT_NAMES)("%s: prompt body contains no banned tokens (Invariant 7)", (name) => {
    const filePath = join(AGENTS_DIR, `${name}.md`);
    expect(existsSync(filePath), `agents/${name}.md must exist`).toBe(true);
    const text = readFileSync(filePath, "utf8");
    const body = getBody(text);
    for (const token of BANNED_TOKENS) {
      expect(body.includes(token), `${name}: body must not contain banned token "${token}"`).toBe(false);
    }
  });

  it.each(AGENT_NAMES)("%s: registered in loadAgentCatalog", (name) => {
    expect(catalog.has(name), `${name}: must be present in loadAgentCatalog`).toBe(true);
  });
});
