#!/usr/bin/env node
// omcp code-intelligence MCP server — ported from omx's code-intel-server.
// Provides LSP-like diagnostics, symbol search, AST pattern matching, hover,
// and reference search via pragmatic CLI wrappers (tsc, ast-grep/sg, grep).
//
// Tools exposed (17):
//   - lsp_diagnostics           : tsc --noEmit per file
//   - lsp_diagnostics_directory : tsc --noEmit per project
//   - lsp_document_symbols      : regex-based symbol outline
//   - lsp_workspace_symbols     : symbol name search across files
//   - lsp_hover                 : regex-based hover approximation
//   - lsp_find_references       : grep-based reference search
//   - lsp_servers               : binary availability report
//   - ast_grep_search           : ast-grep --pattern (JSON)
//   - ast_grep_replace          : ast-grep --rewrite (dryRun safe)
//   - lsp_goto_definition       : grep-based definition finder
//   - lsp_prepare_rename        : word-under-cursor extraction
//   - lsp_rename                : word-boundary replace (file or workspace)
//   - lsp_code_actions          : stub (placeholder)
//   - lsp_code_action_resolve   : stub (placeholder)
//   - deepinit_manifest         : recursive directory manifest
//   - load_omcp_skills_local    : read .omcp/skills/ local skills
//   - load_omcp_skills_global   : read ~/.copilot/skills/ global skills
//   - list_omcp_skills          : list skills/ from omcp installation
//
// Binary detection: tries `sg`, then `ast-grep`, then `npx @ast-grep/cli`.
// All CLI calls use Node's child_process; no new npm deps required.

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { runMcpServer } from "./server-runtime.js";

const execFileAsync = promisify(execFile);

// ── Exec helper ─────────────────────────────────────────────────────────────

type ExecResult = { stdout: string; stderr: string };
type ExecRunner = (
  cmd: string,
  args: string[],
  options?: { cwd?: string; timeout?: number },
) => Promise<ExecResult>;

async function exec(
  cmd: string,
  args: string[],
  options: { cwd?: string; timeout?: number } = {},
): Promise<ExecResult> {
  try {
    return await execFileAsync(cmd, args, {
      cwd: options.cwd,
      timeout: options.timeout ?? 30_000,
      maxBuffer: 10 * 1024 * 1024,
    });
  } catch (err: unknown) {
    const e = err as { stdout?: string; stderr?: string; code?: number };
    // tsc returns exit code 2 for type errors but stdout still has the output
    if (e.stdout !== undefined) {
      return { stdout: e.stdout || "", stderr: e.stderr || "" };
    }
    throw err;
  }
}

// ── Diagnostics (tsc --noEmit wrapper) ──────────────────────────────────────

interface Diagnostic {
  file: string;
  line: number;
  character: number;
  severity: "error" | "warning";
  code: string;
  message: string;
}

function parseTscOutput(output: string, projectDir: string): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  // tsc format: src/foo.ts(10,5): error TS2304: Cannot find name 'x'.
  const re = /^(.+?)\((\d+),(\d+)\):\s+(error|warning)\s+(TS\d+):\s+(.+)$/gm;
  let match: RegExpExecArray | null;
  while ((match = re.exec(output)) !== null) {
    diagnostics.push({
      file: join(projectDir, match[1]),
      line: parseInt(match[2], 10),
      character: parseInt(match[3], 10),
      severity: match[4] as "error" | "warning",
      code: match[5],
      message: match[6],
    });
  }
  return diagnostics;
}

async function findTsconfig(dir: string): Promise<string | null> {
  const candidates = ["tsconfig.json", "tsconfig.build.json"];
  for (const c of candidates) {
    if (existsSync(join(dir, c))) return join(dir, c);
  }
  return null;
}

export async function runTscDiagnostics(
  target: string,
  projectDir: string,
  _severity?: string,
  runCommand: ExecRunner = exec,
): Promise<{ diagnostics: Diagnostic[]; command: string }> {
  const tsconfig = await findTsconfig(projectDir);
  if (!tsconfig) {
    return { diagnostics: [], command: "tsc skipped: no tsconfig found" };
  }

  const args = ["--noEmit", "--pretty", "false"];
  args.push("--project", tsconfig);

  const { stdout, stderr } = await runCommand("npx", ["tsc", ...args], {
    cwd: projectDir,
    timeout: 60_000,
  });
  const output = stdout + "\n" + stderr;
  let diagnostics = parseTscOutput(output, projectDir);

  // Filter to specific file if target is a file (not directory)
  if (target && !target.endsWith("/") && existsSync(target)) {
    diagnostics = diagnostics.filter(
      (d) => d.file === target || d.file.endsWith("/" + basename(target)),
    );
  }

  return { diagnostics, command: `npx tsc ${args.join(" ")}` };
}

// ── Symbol extraction (regex-based) ─────────────────────────────────────────

interface DocumentSymbol {
  name: string;
  kind: string;
  line: number;
  character: number;
  endLine?: number;
}

const SYMBOL_PATTERNS: Array<{ kind: string; re: RegExp }> = [
  // TypeScript/JavaScript
  { kind: "function", re: /^(?:export\s+)?(?:async\s+)?function\s+(\w+)/m },
  { kind: "class", re: /^(?:export\s+)?(?:abstract\s+)?class\s+(\w+)/m },
  { kind: "interface", re: /^(?:export\s+)?interface\s+(\w+)/m },
  { kind: "type", re: /^(?:export\s+)?type\s+(\w+)\s*=/m },
  { kind: "enum", re: /^(?:export\s+)?(?:const\s+)?enum\s+(\w+)/m },
  { kind: "variable", re: /^(?:export\s+)?(?:const|let|var)\s+(\w+)\s*[=:]/m },
  { kind: "method", re: /^\s+(?:async\s+)?(\w+)\s*\([^)]*\)\s*(?::\s*\w+)?\s*\{/m },
  { kind: "property", re: /^\s+(?:readonly\s+)?(\w+)\s*[?:].*[;,]$/m },
  // Python
  { kind: "function", re: /^(?:async\s+)?def\s+(\w+)/m },
  { kind: "class", re: /^class\s+(\w+)/m },
  // Go
  { kind: "function", re: /^func\s+(?:\(\w+\s+\*?\w+\)\s+)?(\w+)/m },
  { kind: "type", re: /^type\s+(\w+)\s+(?:struct|interface)/m },
  // Rust
  { kind: "function", re: /^(?:pub\s+)?(?:async\s+)?fn\s+(\w+)/m },
  { kind: "struct", re: /^(?:pub\s+)?struct\s+(\w+)/m },
  { kind: "enum", re: /^(?:pub\s+)?enum\s+(\w+)/m },
  { kind: "trait", re: /^(?:pub\s+)?trait\s+(\w+)/m },
  { kind: "impl", re: /^impl(?:<[^>]+>)?\s+(\w+)/m },
];

function extractSymbols(content: string): DocumentSymbol[] {
  const symbols: DocumentSymbol[] = [];
  const lines = content.split("\n");
  const seen = new Set<string>();

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    for (const { kind, re } of SYMBOL_PATTERNS) {
      const match = line.match(re);
      if (match && match[1]) {
        const key = `${kind}:${match[1]}:${i}`;
        if (!seen.has(key)) {
          seen.add(key);
          symbols.push({
            name: match[1],
            kind,
            line: i + 1,
            character: line.indexOf(match[1]),
          });
        }
      }
    }
  }
  return symbols;
}

// ── AST-grep wrapper ────────────────────────────────────────────────────────

async function findSgBinary(): Promise<string | null> {
  for (const bin of ["sg", "ast-grep"]) {
    try {
      const finder = process.platform === "win32" ? "where" : "which";
      await execFileAsync(finder, [bin]);
      return bin;
    } catch (err) {
      process.stderr.write(`[code-intel-server] sg probe failed: ${err}\n`);
    }
  }
  // Try npx
  try {
    await execFileAsync("npx", ["@ast-grep/cli", "--version"], { timeout: 15_000 });
    return "npx-ast-grep";
  } catch (err) {
    process.stderr.write(`[code-intel-server] npx ast-grep probe failed: ${err}\n`);
  }
  return null;
}

interface AstGrepRunOptions {
  path?: string;
  maxResults?: number;
  context?: number;
  replacement?: string;
  dryRun?: boolean;
}

export function buildAstGrepRunArgs(
  pattern: string,
  language: string,
  options: AstGrepRunOptions,
): string[] {
  const args: string[] = ["run", "--pattern", pattern, "--lang", language];

  if (options.replacement) {
    args.push("--rewrite", options.replacement);
    if (!options.dryRun) {
      args.push("--update-all");
    }
  } else {
    args.push("--json");
  }

  if (options.path) {
    args.push(options.path);
  }

  return args;
}

async function runAstGrep(
  pattern: string,
  language: string,
  options: AstGrepRunOptions,
): Promise<{ matches: unknown[]; command: string }> {
  const sg = await findSgBinary();
  if (!sg) {
    return {
      matches: [],
      command: "ast-grep not installed. Install: npm i -g @ast-grep/cli",
    };
  }

  const args: string[] = [];
  const cmd = sg === "npx-ast-grep" ? "npx" : sg;
  if (sg === "npx-ast-grep") {
    args.push("--yes", "@ast-grep/cli");
  }

  args.push(...buildAstGrepRunArgs(pattern, language, options));

  try {
    const { stdout } = await exec(cmd, args, { timeout: 30_000 });
    try {
      const results = JSON.parse(stdout);
      const matches = Array.isArray(results) ? results : [results];
      return {
        matches: options.maxResults ? matches.slice(0, options.maxResults) : matches,
        command: `${cmd} ${args.join(" ")}`,
      };
    } catch (err) {
      process.stderr.write(`[code-intel-server] ast-grep JSON parse failed: ${err}\n`);
      // Non-JSON output (rewrite mode)
      return { matches: [{ output: stdout }], command: `${cmd} ${args.join(" ")}` };
    }
  } catch (err) {
    return {
      matches: [],
      command: `${cmd} ${args.join(" ")} (failed: ${(err as Error).message})`,
    };
  }
}

// ── Workspace symbol search ─────────────────────────────────────────────────

const CODE_EXTENSIONS = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".py", ".go", ".rs", ".java",
  ".c", ".cpp", ".h", ".cs", ".rb", ".swift", ".kt", ".scala",
  ".vue", ".svelte",
]);

async function searchWorkspaceSymbols(
  query: string,
  dir: string,
  maxResults = 50,
): Promise<Array<DocumentSymbol & { file: string }>> {
  const results: Array<DocumentSymbol & { file: string }> = [];

  async function walk(d: string, depth: number): Promise<void> {
    if (depth > 6 || results.length >= maxResults) return;
    const entries = await readdir(d, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (results.length >= maxResults) break;
      const full = join(d, entry.name);
      if (entry.isDirectory()) {
        if (
          entry.name.startsWith(".") ||
          entry.name === "node_modules" ||
          entry.name === "dist" ||
          entry.name === "__pycache__"
        ) continue;
        await walk(full, depth + 1);
      } else if (entry.isFile() && CODE_EXTENSIONS.has(extname(entry.name))) {
        try {
          const content = await readFile(full, "utf-8");
          const symbols = extractSymbols(content);
          for (const sym of symbols) {
            if (sym.name.toLowerCase().includes(query.toLowerCase())) {
              results.push({ ...sym, file: relative(dir, full) });
            }
          }
        } catch (err) {
          process.stderr.write(`[code-intel-server] read failed: ${err}\n`);
        }
      }
    }
  }

  await walk(dir, 0);
  return results.slice(0, maxResults);
}

// ── Tool handlers ───────────────────────────────────────────────────────────

function findProjectRoot(start: string): string {
  let dir = start;
  for (let i = 0; i < 10; i++) {
    if (
      existsSync(join(dir, "tsconfig.json")) ||
      existsSync(join(dir, "package.json")) ||
      existsSync(join(dir, ".git"))
    ) return dir;
    const parent = join(dir, "..");
    if (parent === dir) break;
    dir = parent;
  }
  return start;
}

async function handleLspDiagnostics(args: Record<string, unknown>): Promise<unknown> {
  const file = args.file as string | undefined;
  if (!file) return { error: "file is required" };
  const projectDir = findProjectRoot(join(file, ".."));
  const result = await runTscDiagnostics(file, projectDir, args.severity as string);
  return {
    file,
    diagnosticCount: result.diagnostics.length,
    diagnostics: result.diagnostics,
    command: result.command,
  };
}

async function handleLspDiagnosticsDirectory(args: Record<string, unknown>): Promise<unknown> {
  const dir = args.directory as string | undefined;
  if (!dir) return { error: "directory is required" };
  const result = await runTscDiagnostics("", dir, args.severity as string);
  const byFile: Record<string, Diagnostic[]> = {};
  for (const d of result.diagnostics) {
    const rel = relative(dir, d.file);
    if (!byFile[rel]) byFile[rel] = [];
    byFile[rel].push(d);
  }
  return {
    directory: dir,
    totalErrors: result.diagnostics.filter((d) => d.severity === "error").length,
    totalWarnings: result.diagnostics.filter((d) => d.severity === "warning").length,
    fileCount: Object.keys(byFile).length,
    diagnosticsByFile: byFile,
    command: result.command,
  };
}

async function handleLspDocumentSymbols(args: Record<string, unknown>): Promise<unknown> {
  const file = args.file as string | undefined;
  if (!file) return { error: "file is required" };
  if (!existsSync(file)) return { error: `File not found: ${file}` };
  const content = await readFile(file, "utf-8");
  const symbols = extractSymbols(content);
  return { file, symbolCount: symbols.length, symbols };
}

async function handleLspWorkspaceSymbols(args: Record<string, unknown>): Promise<unknown> {
  const query = args.query as string | undefined;
  const file = args.file as string | undefined;
  if (!query) return { error: "query is required" };
  const dir = findProjectRoot(file ? join(file, "..") : process.cwd());
  const symbols = await searchWorkspaceSymbols(query, dir);
  return { query, resultCount: symbols.length, symbols };
}

async function handleLspHover(args: Record<string, unknown>): Promise<unknown> {
  const file = args.file as string | undefined;
  const line = args.line as number | undefined;
  const char = (args.character as number | undefined) ?? 0;
  if (!file || !line) return { error: "file and line are required" };
  if (!existsSync(file)) return { error: `File not found: ${file}` };
  const content = await readFile(file, "utf-8");
  const lines = content.split("\n");
  const targetLine = lines[line - 1] || "";
  let start = char;
  let end = char;
  while (start > 0 && /\w/.test(targetLine[start - 1])) start--;
  while (end < targetLine.length && /\w/.test(targetLine[end])) end++;
  const word = targetLine.slice(start, end);
  const symbols = extractSymbols(content);
  const match = symbols.find((s) => s.name === word);
  return {
    file,
    position: { line, character: char },
    word,
    lineContent: targetLine.trim(),
    localDefinition: match ?? null,
    note: "Regex-based approximation. For full LSP hover, install a language server. TODO(M5): wire to a real LSP backend.",
  };
}

async function handleLspFindReferences(args: Record<string, unknown>): Promise<unknown> {
  const file = args.file as string | undefined;
  const line = args.line as number | undefined;
  const char = (args.character as number | undefined) ?? 0;
  const includeDeclaration = args.includeDeclaration as boolean | undefined;
  const effectiveIncludeDeclaration = includeDeclaration !== false;
  if (!file || !line) return { error: "file and line are required" };
  const content = await readFile(file, "utf-8");
  const lines = content.split("\n");
  const targetLine = lines[line - 1] || "";
  let start = char;
  let end = char;
  while (start > 0 && /\w/.test(targetLine[start - 1])) start--;
  while (end < targetLine.length && /\w/.test(targetLine[end])) end++;
  const symbol = targetLine.slice(start, end);
  if (!symbol) return { error: "Could not identify symbol at position" };

  const dir = findProjectRoot(join(file, ".."));
  try {
    const { stdout } = await exec(
      "grep",
      [
        "-rn",
        "--include=*.ts",
        "--include=*.tsx",
        "--include=*.js",
        "--include=*.jsx",
        "--include=*.py",
        "--include=*.go",
        "--include=*.rs",
        "-w",
        symbol,
        dir,
      ],
      { timeout: 15_000 },
    );
    const refs = stdout
      .split("\n")
      .filter(Boolean)
      .map((row) => {
        const m = row.match(/^(.+?):(\d+):(.+)$/);
        if (!m) return null;
        return { file: m[1], line: parseInt(m[2], 10), content: m[3].trim() };
      })
      .filter((entry): entry is { file: string; line: number; content: string } => entry !== null);

    const declarationLines = new Set(
      extractSymbols(content)
        .filter((s) => s.name === symbol)
        .map((s) => s.line),
    );
    const normalizedTargetFile = resolve(file);
    const filteredRefs = effectiveIncludeDeclaration
      ? refs
      : refs.filter((ref) => {
          if (resolve(ref.file) !== normalizedTargetFile) return true;
          return !declarationLines.has(ref.line);
        });

    return {
      symbol,
      includeDeclaration: effectiveIncludeDeclaration,
      referenceCount: filteredRefs.length,
      references: filteredRefs.slice(0, 100),
    };
  } catch (err) {
    process.stderr.write(`[code-intel-server] grep failed: ${err}\n`);
    return {
      symbol,
      includeDeclaration: effectiveIncludeDeclaration,
      referenceCount: 0,
      references: [],
      note: "grep search returned no results (may be unavailable on this platform).",
    };
  }
}

async function handleLspServers(): Promise<unknown> {
  const checks: Record<string, { available: boolean; version?: string; note?: string }> = {};
  try {
    const { stdout } = await exec("npx", ["tsc", "--version"], { timeout: 10_000 });
    checks["typescript"] = { available: true, version: stdout.trim() };
  } catch (err) {
    process.stderr.write(`[code-intel-server] tsc probe failed: ${err}\n`);
    checks["typescript"] = { available: false, note: "Install: npm i -D typescript" };
  }
  const sg = await findSgBinary();
  if (sg) {
    checks["ast-grep"] = { available: true, version: sg };
  } else {
    checks["ast-grep"] = { available: false, note: "Install: npm i -g @ast-grep/cli" };
  }
  try {
    await exec("grep", ["--version"]);
    checks["grep"] = { available: true };
  } catch (err) {
    process.stderr.write(`[code-intel-server] grep probe failed: ${err}\n`);
    checks["grep"] = { available: false };
  }
  return { servers: checks };
}

async function handleAstGrepSearch(args: Record<string, unknown>): Promise<unknown> {
  const pattern = args.pattern as string | undefined;
  const language = args.language as string | undefined;
  if (!pattern || !language) return { error: "pattern and language are required" };
  return runAstGrep(pattern, language, {
    path: args.path as string | undefined,
    maxResults: args.maxResults as number | undefined,
    context: args.context as number | undefined,
  });
}

async function handleAstGrepReplace(args: Record<string, unknown>): Promise<unknown> {
  const pattern = args.pattern as string | undefined;
  const replacement = args.replacement as string | undefined;
  const language = args.language as string | undefined;
  if (!pattern || !replacement || !language) {
    return { error: "pattern, replacement, and language are required" };
  }
  const dryRun = args.dryRun !== false; // default true
  const result = await runAstGrep(pattern, language, {
    path: args.path as string | undefined,
    replacement,
    dryRun,
  });
  return { ...result, dryRun };
}

// ── New tools (DD9 parity additions) ────────────────────────────────────────

// Definition patterns used by lsp_goto_definition
const DEFINITION_PATTERNS: Array<{ kind: string; re: (name: string) => RegExp }> = [
  { kind: "function",  re: (n) => new RegExp(`(?:export\\s+)?(?:async\\s+)?function\\s+${n}\\b`) },
  { kind: "class",     re: (n) => new RegExp(`(?:export\\s+)?(?:abstract\\s+)?class\\s+${n}\\b`) },
  { kind: "interface", re: (n) => new RegExp(`(?:export\\s+)?interface\\s+${n}\\b`) },
  { kind: "type",      re: (n) => new RegExp(`(?:export\\s+)?type\\s+${n}\\s*=`) },
  { kind: "const",     re: (n) => new RegExp(`(?:export\\s+)?const\\s+${n}\\s*[=:]`) },
  { kind: "export",    re: (n) => new RegExp(`export\\s+.*\\b${n}\\b`) },
  // Python / Go / Rust
  { kind: "function",  re: (n) => new RegExp(`(?:async\\s+)?def\\s+${n}\\b`) },
  { kind: "function",  re: (n) => new RegExp(`func\\s+(?:\\(\\w+\\s+\\*?\\w+\\)\\s+)?${n}\\b`) },
  { kind: "function",  re: (n) => new RegExp(`(?:pub\\s+)?(?:async\\s+)?fn\\s+${n}\\b`) },
  { kind: "struct",    re: (n) => new RegExp(`(?:pub\\s+)?struct\\s+${n}\\b`) },
];

async function handleLspGotoDefinition(args: Record<string, unknown>): Promise<unknown> {
  const file = args.file as string | undefined;
  const symbol = args.symbol as string | undefined;
  if (!file || !symbol) return { error: "file and symbol are required" };
  // DD10 Critic-B P1 fix: escape regex metacharacters in symbol — without
  // this, `symbol: ".*"` matches every line and `symbol: "(a+)+$"` triggers
  // ReDoS. Same escape pattern used in handleLspRename below.
  const symbolStr: string = symbol.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  // Search workspace rooted at project root; fall back to file's directory
  const dir = findProjectRoot(existsSync(file) ? join(file, "..") : file);
  const results: Array<{ file: string; line: number; column: number; kind: string }> = [];

  async function walk(d: string, depth: number): Promise<void> {
    if (depth > 6 || results.length >= 20) return;
    const entries = await readdir(d, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (results.length >= 20) break;
      const full = join(d, entry.name);
      if (entry.isDirectory()) {
        if (
          entry.name.startsWith(".") ||
          entry.name === "node_modules" ||
          entry.name === "dist" ||
          entry.name === "__pycache__"
        ) continue;
        await walk(full, depth + 1);
      } else if (entry.isFile() && CODE_EXTENSIONS.has(extname(entry.name))) {
        try {
          const content = await readFile(full, "utf-8");
          const lines = content.split("\n");
          for (let i = 0; i < lines.length; i++) {
            for (const pat of DEFINITION_PATTERNS) {
              if (pat.re(symbolStr).test(lines[i])) {
                const col = lines[i].search(new RegExp(`\\b${symbolStr}\\b`));
                results.push({ file: full, line: i + 1, column: col >= 0 ? col : 0, kind: pat.kind });
                break;
              }
            }
          }
        } catch (err) {
          process.stderr.write(`[code-intel-server] goto-def read failed: ${err}\n`);
        }
      }
    }
  }

  await walk(dir, 0);
  return { symbol, resultCount: results.length, definitions: results };
}

async function handleLspPrepareRename(args: Record<string, unknown>): Promise<unknown> {
  const file = args.file as string | undefined;
  const line = args.line as number | undefined;
  const character = args.character as number | undefined;
  if (!file || line === undefined || character === undefined) {
    return { error: "file, line, and character are required" };
  }
  if (!existsSync(file)) return { error: `File not found: ${file}` };

  const content = await readFile(file, "utf-8");
  const lines = content.split("\n");
  const targetLine = lines[line - 1] ?? "";
  const IDENT_RE = /[A-Za-z_$][A-Za-z0-9_$]*/g;
  let match: RegExpExecArray | null;
  while ((match = IDENT_RE.exec(targetLine)) !== null) {
    const start = match.index;
    const end = start + match[0].length;
    if (character >= start && character <= end) {
      return {
        range: { start: { line: line - 1, character: start }, end: { line: line - 1, character: end } },
        placeholder: match[0],
      };
    }
  }
  return null;
}

async function handleLspRename(args: Record<string, unknown>): Promise<unknown> {
  const file = args.file as string | undefined;
  const oldName = args.oldName as string | undefined;
  const newName = args.newName as string | undefined;
  const scope = (args.scope as string | undefined) ?? "file";
  if (!file || !oldName || !newName) return { error: "file, oldName, and newName are required" };

  const wordRe = new RegExp(`\\b${oldName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "g");
  const TS_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".py"]);
  const newNameStr: string = newName;

  async function replaceInFile(targetFile: string): Promise<number> {
    try {
      const original = await readFile(targetFile, "utf-8");
      const updated = original.replace(wordRe, newNameStr);
      if (updated === original) return 0;
      await writeFile(targetFile, updated, "utf-8");
      const count = (original.match(wordRe) ?? []).length;
      return count;
    } catch (err) {
      process.stderr.write(`[code-intel-server] rename write failed for ${targetFile}: ${err}\n`);
      return 0;
    }
  }

  const filesChanged: string[] = [];
  let totalReplacements = 0;

  if (scope === "workspace") {
    const dir = findProjectRoot(existsSync(file) ? join(file, "..") : file);
    async function walk(d: string, depth: number): Promise<void> {
      if (depth > 6) return;
      const entries = await readdir(d, { withFileTypes: true }).catch(() => []);
      for (const entry of entries) {
        const full = join(d, entry.name);
        if (entry.isDirectory()) {
          if (
            entry.name.startsWith(".") ||
            entry.name === "node_modules" ||
            entry.name === "dist" ||
            entry.name === "__pycache__"
          ) continue;
          await walk(full, depth + 1);
        } else if (entry.isFile() && TS_EXTENSIONS.has(extname(entry.name))) {
          const count = await replaceInFile(full);
          if (count > 0) { filesChanged.push(full); totalReplacements += count; }
        }
      }
    }
    await walk(dir, 0);
  } else {
    // scope === "file" (default)
    if (!existsSync(file)) return { error: `File not found: ${file}` };
    const count = await replaceInFile(file);
    if (count > 0) { filesChanged.push(file); totalReplacements += count; }
  }

  return { filesChanged, replacements: totalReplacements };
}

// Placeholder — real code-action analysis requires a language server.
// TODO(M5): wire to a real LSP backend for actual code action suggestions.
async function handleLspCodeActions(args: Record<string, unknown>): Promise<unknown> {
  void args; // placeholder: real impl requires a language server
  return { actions: [] };
}

// Placeholder — resolves an action by returning it unchanged.
// TODO(M5): wire to a real LSP backend for code action resolution.
async function handleLspCodeActionResolve(args: Record<string, unknown>): Promise<unknown> {
  return args.action ?? null;
}

async function handleDeepInitManifest(args: Record<string, unknown>): Promise<unknown> {
  const root = args.root as string | undefined;
  const depthLimit = (args.depth as number | undefined) ?? 3;
  if (!root) return { error: "root is required" };
  if (!existsSync(root)) return { error: `Directory not found: ${root}` };
  const rootStr: string = root;

  const byExtension: Record<string, number> = {};
  const dirFileCounts: Map<string, number> = new Map();
  let totalFiles = 0;
  let totalDirs = 0;

  async function walk(d: string, depth: number): Promise<void> {
    if (depth > depthLimit) return;
    const entries = await readdir(d, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const full = join(d, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name === ".git" || entry.name === "dist") continue;
        totalDirs++;
        await walk(full, depth + 1);
      } else if (entry.isFile()) {
        totalFiles++;
        const ext = extname(entry.name) || "(no ext)";
        byExtension[ext] = (byExtension[ext] ?? 0) + 1;
        // Track counts for top-level dirs (depth 1 relative to root)
        if (depth >= 1) {
          const relParts = relative(rootStr, full).split(/[\\/]/);
          if (relParts.length >= 1) {
            const topDir = join(rootStr, relParts[0]);
            dirFileCounts.set(topDir, (dirFileCounts.get(topDir) ?? 0) + 1);
          }
        }
      }
    }
  }

  await walk(rootStr, 0);

  const topDirs = Array.from(dirFileCounts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([p, files]) => ({ path: relative(rootStr, p), files }));

  return { files: totalFiles, dirs: totalDirs, byExtension, topDirs };
}

async function handleLoadOmcpSkillsLocal(_args: Record<string, unknown>): Promise<unknown> {
  const skillsDir = join(process.cwd(), ".omcp", "skills");
  if (!existsSync(skillsDir)) {
    return { skills: [] };
  }
  try {
    const entries = await readdir(skillsDir, { withFileTypes: true });
    const skills = entries
      .filter((e) => e.isFile() || e.isDirectory())
      .map((e) => ({ name: basename(e.name, extname(e.name)), path: join(skillsDir, e.name) }));
    return { skills };
  } catch (err) {
    process.stderr.write(`[code-intel-server] load-omcp-skills-local failed: ${err}\n`);
    return { skills: [] };
  }
}

async function handleLoadOmcpSkillsGlobal(_args: Record<string, unknown>): Promise<unknown> {
  // DD10 Critic-A P1 fix: omc has 3 skills tools (local/global/list);
  // DD9 shipped only 2. Global skills live at ~/.copilot/skills/ —
  // mirrors omc's ~/.claude/skills/ convention.
  const home = process.env.HOME ?? process.env.USERPROFILE ?? "";
  if (!home) return { skills: [] };
  const skillsDir = join(home, ".copilot", "skills");
  if (!existsSync(skillsDir)) {
    return { skills: [] };
  }
  try {
    const entries = await readdir(skillsDir, { withFileTypes: true });
    const skills = entries
      .filter((e) => e.isFile() || e.isDirectory())
      .map((e) => ({ name: basename(e.name, extname(e.name)), path: join(skillsDir, e.name) }));
    return { skills };
  } catch (err) {
    process.stderr.write(`[code-intel-server] load-omcp-skills-global failed: ${err}\n`);
    return { skills: [] };
  }
}

async function handleListOmcpSkills(_args: Record<string, unknown>): Promise<unknown> {
  // Locate the skills/ directory relative to this server file
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = dirname(__filename);
  // dist/mcp/code-intel-server.js → ../../skills/
  const skillsDir = resolve(__dirname, "..", "..", "skills");

  if (!existsSync(skillsDir)) {
    return { skills: [], note: `skills dir not found at ${skillsDir}` };
  }

  try {
    const entries = await readdir(skillsDir, { withFileTypes: true });
    const skills: Array<{ name: string; description: string }> = [];

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const skillMd = join(skillsDir, entry.name, "SKILL.md");
      if (!existsSync(skillMd)) continue;
      try {
        const content = await readFile(skillMd, "utf-8");
        // Parse YAML frontmatter description field
        const fmMatch = content.match(/^---\s*\n([\s\S]*?)\n---/);
        let description = "";
        if (fmMatch) {
          const descMatch = fmMatch[1].match(/^description:\s*(.+)$/m);
          if (descMatch) description = descMatch[1].trim();
        }
        skills.push({ name: entry.name, description });
      } catch (err) {
        process.stderr.write(`[code-intel-server] read SKILL.md failed for ${entry.name}: ${err}\n`);
      }
    }

    return { skills };
  } catch (err) {
    process.stderr.write(`[code-intel-server] list-omcp-skills failed: ${err}\n`);
    return { skills: [] };
  }
}

// ── MCP server entry ────────────────────────────────────────────────────────
//
// Mirrors omx's `new Server({ name: 'omx-code-intel', version: '0.1.0' })`
// shape via `runMcpServer`, which constructs the SDK Server underneath.

const LANG_ENUM = [
  "javascript", "typescript", "tsx", "python", "ruby", "go", "rust",
  "java", "kotlin", "swift", "c", "cpp", "csharp", "html", "css", "json", "yaml",
] as const;

runMcpServer({
  name: "omcp-code-intel",
  version: "0.1.0",
  tools: [
    {
      name: "lsp_diagnostics",
      description: "Get diagnostics (errors, warnings) for a file. Uses tsc --noEmit for TypeScript projects.",
      inputSchema: {
        type: "object",
        properties: {
          file: { type: "string", description: "Path to the source file" },
          severity: { type: "string", enum: ["error", "warning", "info", "hint"] },
        },
        required: ["file"],
      },
      handler: handleLspDiagnostics,
    },
    {
      name: "lsp_diagnostics_directory",
      description: "Run project-level diagnostics on a directory using tsc --noEmit. Returns all errors across the project.",
      inputSchema: {
        type: "object",
        properties: {
          directory: { type: "string", description: "Project directory to check" },
          strategy: { type: "string", enum: ["tsc", "auto"], description: "Diagnostic strategy (default: auto)" },
        },
        required: ["directory"],
      },
      handler: handleLspDiagnosticsDirectory,
    },
    {
      name: "lsp_document_symbols",
      description: "Get a hierarchical outline of all symbols in a file (functions, classes, variables, etc.).",
      inputSchema: {
        type: "object",
        properties: { file: { type: "string", description: "Path to the source file" } },
        required: ["file"],
      },
      handler: handleLspDocumentSymbols,
    },
    {
      name: "lsp_workspace_symbols",
      description: "Search for symbols (functions, classes, etc.) across the workspace by name.",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "Symbol name or pattern to search" },
          file: { type: "string", description: "Any file in the workspace (used to determine project root)" },
        },
        required: ["query"],
      },
      handler: handleLspWorkspaceSymbols,
    },
    {
      name: "lsp_hover",
      description: "Get type information and documentation at a specific position (regex-based approximation).",
      inputSchema: {
        type: "object",
        properties: {
          file: { type: "string", description: "Path to the source file" },
          line: { type: "integer", description: "Line number (1-indexed)" },
          character: { type: "integer", description: "Character position (0-indexed)" },
        },
        required: ["file", "line", "character"],
      },
      handler: handleLspHover,
    },
    {
      name: "lsp_find_references",
      description: "Find all references to a symbol across the codebase using grep-based search.",
      inputSchema: {
        type: "object",
        properties: {
          file: { type: "string", description: "Path to the source file" },
          line: { type: "integer", description: "Line number (1-indexed)" },
          character: { type: "integer", description: "Character position (0-indexed)" },
          includeDeclaration: { type: "boolean" },
        },
        required: ["file", "line", "character"],
      },
      handler: handleLspFindReferences,
    },
    {
      name: "lsp_servers",
      description: "List available diagnostic backends and their installation status.",
      inputSchema: { type: "object", properties: {} },
      handler: handleLspServers,
    },
    {
      name: "ast_grep_search",
      description: "Search for code patterns using AST matching. Uses meta-variables: $NAME (single node), $$$ARGS (multiple nodes). Example: 'function $NAME($$$ARGS)' finds all function declarations.",
      inputSchema: {
        type: "object",
        properties: {
          pattern: { type: "string", description: "AST pattern with meta-variables ($VAR, $$$VARS)" },
          language: { type: "string", enum: [...LANG_ENUM] },
          path: { type: "string", description: "Directory or file to search in" },
          maxResults: { type: "integer" },
          context: { type: "integer" },
        },
        required: ["pattern", "language"],
      },
      handler: handleAstGrepSearch,
    },
    {
      name: "ast_grep_replace",
      description: "Replace code patterns using AST matching. Use meta-variables in both pattern and replacement. IMPORTANT: dryRun=true (default) only previews changes. Set dryRun=false to apply.",
      inputSchema: {
        type: "object",
        properties: {
          pattern: { type: "string", description: "Pattern to match" },
          replacement: { type: "string", description: "Replacement pattern (use same meta-variables)" },
          language: { type: "string", enum: [...LANG_ENUM] },
          path: { type: "string" },
          dryRun: { type: "boolean", description: "Preview only (default: true)" },
        },
        required: ["pattern", "replacement", "language"],
      },
      handler: handleAstGrepReplace,
    },
    {
      name: "lsp_goto_definition",
      description: "Find the definition of a symbol across the workspace using grep-based pattern matching.",
      inputSchema: {
        type: "object",
        properties: {
          file: { type: "string", description: "Any file in the workspace (used to determine project root)" },
          symbol: { type: "string", description: "Symbol name to find definition for" },
        },
        required: ["file", "symbol"],
      },
      handler: handleLspGotoDefinition,
    },
    {
      name: "lsp_prepare_rename",
      description: "Extract the word (identifier) under a given cursor position to prepare for rename.",
      inputSchema: {
        type: "object",
        properties: {
          file: { type: "string", description: "Path to the source file" },
          line: { type: "integer", description: "Line number (1-indexed)" },
          character: { type: "integer", description: "Character position (0-indexed)" },
        },
        required: ["file", "line", "character"],
      },
      handler: handleLspPrepareRename,
    },
    {
      name: "lsp_rename",
      description: "Rename a symbol across a file or the entire workspace using word-boundary replacement. Does NOT use shell sed — pure Node fs read+write.",
      inputSchema: {
        type: "object",
        properties: {
          file: { type: "string", description: "Path to the source file (anchor for workspace root)" },
          oldName: { type: "string", description: "Current symbol name" },
          newName: { type: "string", description: "New symbol name" },
          scope: { type: "string", enum: ["file", "workspace"], description: "Scope of rename (default: file)" },
        },
        required: ["file", "oldName", "newName"],
      },
      handler: handleLspRename,
    },
    {
      name: "lsp_code_actions",
      description: "Get available code actions for a range (placeholder — returns empty list; full impl requires a language server).",
      inputSchema: {
        type: "object",
        properties: {
          file: { type: "string", description: "Path to the source file" },
          range: { type: "object", description: "Range in the file" },
        },
        required: ["file"],
      },
      handler: handleLspCodeActions,
    },
    {
      name: "lsp_code_action_resolve",
      description: "Resolve additional details for a code action (placeholder — returns action unchanged; full impl requires a language server).",
      inputSchema: {
        type: "object",
        properties: {
          action: { type: "object", description: "Code action to resolve" },
        },
        required: ["action"],
      },
      handler: handleLspCodeActionResolve,
    },
    {
      name: "deepinit_manifest",
      description: "Recursively scan a directory and produce a manifest with file/dir counts, extension breakdown, and top directories.",
      inputSchema: {
        type: "object",
        properties: {
          root: { type: "string", description: "Directory to scan" },
          depth: { type: "integer", description: "Maximum scan depth (default: 3)" },
        },
        required: ["root"],
      },
      handler: handleDeepInitManifest,
    },
    {
      name: "load_omcp_skills_global",
      description: "Read skills from the user's global ~/.copilot/skills/ directory.",
      inputSchema: { type: "object", properties: {} },
      handler: handleLoadOmcpSkillsGlobal,
    },
    {
      name: "load_omcp_skills_local",
      description: "Load locally defined skills from .omcp/skills/ in the current workspace.",
      inputSchema: {
        type: "object",
        properties: {},
      },
      handler: handleLoadOmcpSkillsLocal,
    },
    {
      name: "list_omcp_skills",
      description: "List all built-in omcp skills from the installation's skills/ directory, including their descriptions from SKILL.md frontmatter.",
      inputSchema: {
        type: "object",
        properties: {},
      },
      handler: handleListOmcpSkills,
    },
  ],
}).catch((err) => {
  console.error(err);
  process.exit(1);
});
