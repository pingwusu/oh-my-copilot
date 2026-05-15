// sync-plugin-mirror.ts — keeps plugins/oh-my-copilot/ as a byte-identical
// mirror of repo-root source-of-truth (agents/, skills/, prompts/, templates/,
// .claude-plugin/, .mcp.json, AGENTS.md).
//
// Modes:
//   default  — write mirror
//   --check  — exit 1 if mirror drifts from source
//   --clean  — delete the mirror first
//
// The mirror exists for plugin marketplaces that install from a subdirectory
// of the repo. The CLI install path (`omcp setup`) does NOT use the mirror —
// it copies directly from repo root.

import { cpSync, existsSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = join(import.meta.dirname ?? __dirname, "..", "..");
const MIRROR = join(ROOT, "plugins", "oh-my-copilot");

const DIR_SOURCES = [
  "agents",
  "skills",
  "prompts",
  "templates",
  "hooks",
  "dist",
  ".claude-plugin",
];
const FILE_SOURCES = [".mcp.json", "AGENTS.md", "CLAUDE.md", "README.md"];

interface DriftReport {
  added: string[];
  removed: string[];
  changed: string[];
}

export function sync(opts: { check?: boolean; clean?: boolean } = {}): DriftReport {
  if (opts.clean && existsSync(MIRROR)) {
    rmSync(MIRROR, { recursive: true, force: true });
  }

  if (opts.check) {
    return diff();
  }

  for (const d of DIR_SOURCES) {
    const src = join(ROOT, d);
    if (!existsSync(src)) continue;
    cpSync(src, join(MIRROR, d), { recursive: true, force: true });
  }
  for (const f of FILE_SOURCES) {
    const src = join(ROOT, f);
    if (!existsSync(src)) continue;
    cpSync(src, join(MIRROR, f), { force: true });
  }
  return { added: [], removed: [], changed: [] };
}

function walk(root: string): Map<string, string> {
  const out = new Map<string, string>();
  function visit(p: string) {
    const st = statSync(p);
    if (st.isDirectory()) {
      for (const entry of readdirSync(p)) visit(join(p, entry));
      return;
    }
    out.set(relative(root, p).replace(/\\/g, "/"), readFileSync(p).toString("hex"));
  }
  if (existsSync(root)) visit(root);
  return out;
}

function diff(): DriftReport {
  const sourceFiles = new Map<string, string>();
  for (const d of DIR_SOURCES) {
    const w = walk(join(ROOT, d));
    for (const [k, v] of w) sourceFiles.set(`${d}/${k}`, v);
  }
  for (const f of FILE_SOURCES) {
    const p = join(ROOT, f);
    if (existsSync(p)) sourceFiles.set(f, readFileSync(p).toString("hex"));
  }

  const mirrorFiles = new Map<string, string>();
  for (const d of DIR_SOURCES) {
    const w = walk(join(MIRROR, d));
    for (const [k, v] of w) mirrorFiles.set(`${d}/${k}`, v);
  }
  for (const f of FILE_SOURCES) {
    const p = join(MIRROR, f);
    if (existsSync(p)) mirrorFiles.set(f, readFileSync(p).toString("hex"));
  }

  const added: string[] = [];
  const removed: string[] = [];
  const changed: string[] = [];
  for (const [key, hash] of sourceFiles) {
    if (!mirrorFiles.has(key)) added.push(key);
    else if (mirrorFiles.get(key) !== hash) changed.push(key);
  }
  for (const key of mirrorFiles.keys()) {
    if (!sourceFiles.has(key)) removed.push(key);
  }
  return { added, removed, changed };
}

function main() {
  const argv = process.argv.slice(2);
  const check = argv.includes("--check");
  const clean = argv.includes("--clean");
  if (check) {
    const drift = sync({ check: true });
    const total = drift.added.length + drift.removed.length + drift.changed.length;
    if (total === 0) {
      console.log("sync-plugin-mirror: mirror in sync with source");
      return;
    }
    console.error(`sync-plugin-mirror: ${total} drift entries`);
    for (const a of drift.added) console.error(`  + ${a}`);
    for (const r of drift.removed) console.error(`  - ${r}`);
    for (const c of drift.changed) console.error(`  ~ ${c}`);
    process.exit(1);
  }
  sync({ clean });
  console.log(`sync-plugin-mirror: mirror written to ${MIRROR}`);
}

const isMain =
  process.argv[1] && process.argv[1].endsWith("sync-plugin-mirror.js");
if (isMain) main();
