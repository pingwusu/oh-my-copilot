// verify-catalog.ts — single source of truth invariants for agents/ + skills/.
//
// Checks every .md / SKILL.md:
//   1. has YAML frontmatter delimited by `---`
//   2. has `name:` matching the filename slug
//   3. has `description:` (non-empty)
//   4. if `model:` is present, it is a dual map { claude, gpt } with non-empty values
//   5. body contains no banned Claude-only tokens (those the manual rewrite was
//      supposed to scrub)
//
// Exits 0 on clean, prints findings + exits 1 on failure.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname ?? __dirname, "..", "..");
const AGENTS_DIR = join(ROOT, "agents");
const SKILLS_DIR = join(ROOT, "skills");

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
  // Claude-only Skill tool — Copilot uses /oh-my-copilot:<name> slash instead
  'Skill("oh-my-copilot:',
  // Claude-only subagent dispatch envelope — Copilot uses `/fleet <agent>` slash
  '"subagent_type":',
];

interface Finding {
  file: string;
  issue: string;
}

interface Frontmatter {
  raw: string;
  name?: string;
  description?: string;
  model?: { claude?: string; gpt?: string } | string;
}

function parseFrontmatter(text: string): Frontmatter | null {
  if (!text.startsWith("---")) return null;
  const end = text.indexOf("\n---", 3);
  if (end === -1) return null;
  const block = text.slice(3, end).trim();

  // Minimal YAML: name:, description:, model: (either inline or nested two-line block)
  const out: Frontmatter = { raw: block };
  const lines = block.split(/\r?\n/);
  let inModel = false;
  const model: { claude?: string; gpt?: string } = {};
  for (const line of lines) {
    if (inModel) {
      const m = line.match(/^\s+(claude|gpt):\s*(.+)$/);
      if (m) {
        model[m[1] as "claude" | "gpt"] = m[2].trim();
        continue;
      }
      if (!/^\s/.test(line) && line.trim() !== "") inModel = false;
    }
    const nameMatch = line.match(/^name:\s*(.+)$/);
    if (nameMatch) out.name = nameMatch[1].trim();
    const descMatch = line.match(/^description:\s*(.+)$/);
    if (descMatch) out.description = descMatch[1].trim();
    if (/^model:\s*$/.test(line)) {
      inModel = true;
    } else {
      const inlineModel = line.match(/^model:\s*(.+)$/);
      if (inlineModel) out.model = inlineModel[1].trim();
    }
  }
  if (Object.keys(model).length > 0) out.model = model;
  return out;
}

function checkFile(file: string, expectedName: string): Finding[] {
  const findings: Finding[] = [];
  const text = readFileSync(file, "utf8");
  const fm = parseFrontmatter(text);

  if (!fm) {
    findings.push({ file, issue: "missing or unparseable frontmatter" });
    return findings;
  }
  if (!fm.name) findings.push({ file, issue: "frontmatter missing `name:`" });
  else if (fm.name !== expectedName) {
    findings.push({
      file,
      issue: `frontmatter name (${fm.name}) does not match filename (${expectedName})`,
    });
  }
  if (!fm.description) {
    findings.push({ file, issue: "frontmatter missing `description:`" });
  }

  if (fm.model !== undefined) {
    if (typeof fm.model === "string") {
      findings.push({
        file,
        issue: "`model:` must be a dual map { claude, gpt }, not a single string",
      });
    } else {
      if (!fm.model.claude) {
        findings.push({ file, issue: "`model.claude` missing" });
      }
      if (!fm.model.gpt) {
        findings.push({ file, issue: "`model.gpt` missing" });
      }
    }
  }

  const body = text.slice(text.indexOf("\n---", 3) + 4);
  for (const token of BANNED_TOKENS) {
    if (body.includes(token)) {
      findings.push({ file, issue: `body contains banned token: ${token}` });
    }
  }
  return findings;
}

function collectAgents(): { file: string; name: string }[] {
  return readdirSync(AGENTS_DIR)
    .filter((f) => f.endsWith(".md"))
    .map((f) => ({
      file: join(AGENTS_DIR, f),
      name: f.replace(/\.md$/, ""),
    }));
}

function collectSkills(): { file: string; name: string }[] {
  if (!statSyncSafe(SKILLS_DIR)) return [];
  const out: { file: string; name: string }[] = [];
  for (const entry of readdirSync(SKILLS_DIR)) {
    const skillDir = join(SKILLS_DIR, entry);
    const st = statSyncSafe(skillDir);
    if (!st || !st.isDirectory()) continue;
    const skillFile = join(skillDir, "SKILL.md");
    if (statSyncSafe(skillFile)) out.push({ file: skillFile, name: entry });
  }
  return out;
}

/** Walk every .md file under skills/ (including subfiles) for banned-token scan. */
function collectAllSkillMarkdowns(): string[] {
  if (!statSyncSafe(SKILLS_DIR)) return [];
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const p = join(dir, entry);
      const st = statSyncSafe(p);
      if (!st) continue;
      if (st.isDirectory()) {
        walk(p);
        continue;
      }
      if (entry.toLowerCase().endsWith(".md")) out.push(p);
    }
  };
  walk(SKILLS_DIR);
  return out;
}

function scanSubfileTokens(file: string): Finding[] {
  const text = readFileSync(file, "utf8");
  const findings: Finding[] = [];
  for (const token of BANNED_TOKENS) {
    if (text.includes(token)) {
      findings.push({ file, issue: `subfile contains banned token: ${token}` });
    }
  }
  return findings;
}

function statSyncSafe(p: string): ReturnType<typeof statSync> | null {
  try {
    return statSync(p);
  } catch {
    return null;
  }
}

export function runVerify(): Finding[] {
  const findings: Finding[] = [];
  for (const a of collectAgents()) findings.push(...checkFile(a.file, a.name));
  for (const s of collectSkills()) findings.push(...checkFile(s.file, s.name));
  // Skill subfiles: only token-scan, not frontmatter check.
  const skillTopFiles = new Set(collectSkills().map((s) => s.file));
  for (const path of collectAllSkillMarkdowns()) {
    if (skillTopFiles.has(path)) continue;
    findings.push(...scanSubfileTokens(path));
  }
  return findings;
}

function main() {
  const findings = runVerify();
  if (findings.length === 0) {
    const agentCount = collectAgents().length;
    const skillCount = collectSkills().length;
    console.log(
      `verify-catalog: clean (${agentCount} agents, ${skillCount} skills)`,
    );
    return;
  }
  console.error(`verify-catalog: ${findings.length} issue(s)`);
  for (const f of findings) {
    console.error(`  ${f.file}: ${f.issue}`);
  }
  process.exit(1);
}

const isMain =
  process.argv[1] && process.argv[1].endsWith("verify-catalog.js");
if (isMain) main();
