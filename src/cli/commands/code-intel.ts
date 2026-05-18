// `omcp code-intel <subcommand>` — CLI surface for the code-intel MCP tools.
// Mirrors omx's `omx code-intel` verb (mcpParityCommand / loadCodeIntelDescriptor).
//
// Subcommands (tool names as subcommands):
//   lsp_diagnostics           <file> [--severity=error|warning]
//   lsp_diagnostics_directory <dir>  [--severity=error|warning]
//   lsp_document_symbols      <file>
//   lsp_workspace_symbols     <query> [--file=<any-file-in-project>]
//   lsp_hover                 <file> <line> <character>
//   lsp_find_references       <file> <line> <character> [--include-declaration]
//   lsp_servers
//   ast_grep_search           <pattern> <language> [--path=<dir>] [--max-results=N]
//   ast_grep_replace          <pattern> <replacement> <language> [--path=<dir>] [--dry-run=true|false]
//
// All output is JSON. Errors print to stderr; process.exitCode = 2 on bad usage.

import {
  runTscDiagnostics,
  buildAstGrepRunArgs,
} from "../../mcp/code-intel-server.js";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { extname, join, relative, resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// ── Helpers (mirrors code-intel-server internals) ────────────────────────────

async function exec(
  cmd: string,
  args: string[],
  options: { cwd?: string; timeout?: number } = {},
): Promise<{ stdout: string; stderr: string }> {
  try {
    return await execFileAsync(cmd, args, {
      cwd: options.cwd,
      timeout: options.timeout ?? 30_000,
      maxBuffer: 10 * 1024 * 1024,
    });
  } catch (err: unknown) {
    const e = err as { stdout?: string; stderr?: string };
    if (e.stdout !== undefined) {
      return { stdout: e.stdout || "", stderr: e.stderr || "" };
    }
    throw err;
  }
}

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

const SYMBOL_PATTERNS: Array<{ kind: string; re: RegExp }> = [
  { kind: "function", re: /^(?:export\s+)?(?:async\s+)?function\s+(\w+)/m },
  { kind: "class", re: /^(?:export\s+)?(?:abstract\s+)?class\s+(\w+)/m },
  { kind: "interface", re: /^(?:export\s+)?interface\s+(\w+)/m },
  { kind: "type", re: /^(?:export\s+)?type\s+(\w+)\s*=/m },
  { kind: "enum", re: /^(?:export\s+)?(?:const\s+)?enum\s+(\w+)/m },
  { kind: "variable", re: /^(?:export\s+)?(?:const|let|var)\s+(\w+)\s*[=:]/m },
  { kind: "method", re: /^\s+(?:async\s+)?(\w+)\s*\([^)]*\)\s*(?::\s*\w+)?\s*\{/m },
  { kind: "property", re: /^\s+(?:readonly\s+)?(\w+)\s*[?:].*[;,]$/m },
  { kind: "function", re: /^(?:async\s+)?def\s+(\w+)/m },
  { kind: "class", re: /^class\s+(\w+)/m },
  { kind: "function", re: /^func\s+(?:\(\w+\s+\*?\w+\)\s+)?(\w+)/m },
  { kind: "type", re: /^type\s+(\w+)\s+(?:struct|interface)/m },
  { kind: "function", re: /^(?:pub\s+)?(?:async\s+)?fn\s+(\w+)/m },
  { kind: "struct", re: /^(?:pub\s+)?struct\s+(\w+)/m },
  { kind: "enum", re: /^(?:pub\s+)?enum\s+(\w+)/m },
  { kind: "trait", re: /^(?:pub\s+)?trait\s+(\w+)/m },
  { kind: "impl", re: /^impl(?:<[^>]+>)?\s+(\w+)/m },
];

interface DocumentSymbol {
  name: string;
  kind: string;
  line: number;
  character: number;
}

function extractSymbols(content: string): DocumentSymbol[] {
  const symbols: DocumentSymbol[] = [];
  const lines = content.split("\n");
  const seen = new Set<string>();
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    for (const { kind, re } of SYMBOL_PATTERNS) {
      const match = line.match(re);
      if (match?.[1]) {
        const key = `${kind}:${match[1]}:${i}`;
        if (!seen.has(key)) {
          seen.add(key);
          symbols.push({ name: match[1], kind, line: i + 1, character: line.indexOf(match[1]) });
        }
      }
    }
  }
  return symbols;
}

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
        if (entry.name.startsWith(".") || entry.name === "node_modules" || entry.name === "dist" || entry.name === "__pycache__") continue;
        await walk(full, depth + 1);
      } else if (entry.isFile() && CODE_EXTENSIONS.has(extname(entry.name))) {
        try {
          const content = await readFile(full, "utf-8");
          for (const sym of extractSymbols(content)) {
            if (sym.name.toLowerCase().includes(query.toLowerCase())) {
              results.push({ ...sym, file: relative(dir, full) });
            }
          }
        } catch {
          // skip unreadable files
        }
      }
    }
  }
  await walk(dir, 0);
  return results.slice(0, maxResults);
}

async function findSgBinary(): Promise<string | null> {
  for (const bin of ["sg", "ast-grep"]) {
    try {
      const finder = process.platform === "win32" ? "where" : "which";
      await execFileAsync(finder, [bin]);
      return bin;
    } catch { /* continue */ }
  }
  try {
    await execFileAsync("npx", ["@ast-grep/cli", "--version"], { timeout: 15_000 });
    return "npx-ast-grep";
  } catch { /* unavailable */ }
  return null;
}

// ── Subcommand implementations ───────────────────────────────────────────────

async function cmdLspDiagnostics(args: string[]): Promise<void> {
  const file = args.find((a) => !a.startsWith("--"));
  if (!file) {
    console.error("omcp code-intel lsp_diagnostics: <file> is required");
    process.exitCode = 2;
    return;
  }
  const severityArg = args.find((a) => a.startsWith("--severity="));
  const severity = severityArg ? severityArg.slice("--severity=".length) : undefined;
  const projectDir = findProjectRoot(resolve(file, ".."));
  const result = await runTscDiagnostics(resolve(file), projectDir, severity);
  console.log(JSON.stringify({ file, diagnosticCount: result.diagnostics.length, diagnostics: result.diagnostics, command: result.command }, null, 2));
}

async function cmdLspDiagnosticsDirectory(args: string[]): Promise<void> {
  const dir = args.find((a) => !a.startsWith("--"));
  if (!dir) {
    console.error("omcp code-intel lsp_diagnostics_directory: <directory> is required");
    process.exitCode = 2;
    return;
  }
  const severityArg = args.find((a) => a.startsWith("--severity="));
  const severity = severityArg ? severityArg.slice("--severity=".length) : undefined;
  const absDir = resolve(dir);
  const result = await runTscDiagnostics("", absDir, severity);
  const byFile: Record<string, unknown[]> = {};
  for (const d of result.diagnostics) {
    const rel = relative(absDir, d.file);
    if (!byFile[rel]) byFile[rel] = [];
    byFile[rel].push(d);
  }
  console.log(JSON.stringify({
    directory: absDir,
    totalErrors: result.diagnostics.filter((d) => d.severity === "error").length,
    totalWarnings: result.diagnostics.filter((d) => d.severity === "warning").length,
    fileCount: Object.keys(byFile).length,
    diagnosticsByFile: byFile,
    command: result.command,
  }, null, 2));
}

async function cmdLspDocumentSymbols(args: string[]): Promise<void> {
  const file = args.find((a) => !a.startsWith("--"));
  if (!file) {
    console.error("omcp code-intel lsp_document_symbols: <file> is required");
    process.exitCode = 2;
    return;
  }
  const absFile = resolve(file);
  if (!existsSync(absFile)) {
    console.error(`omcp code-intel lsp_document_symbols: file not found: ${absFile}`);
    process.exitCode = 2;
    return;
  }
  const content = await readFile(absFile, "utf-8");
  const symbols = extractSymbols(content);
  console.log(JSON.stringify({ file: absFile, symbolCount: symbols.length, symbols }, null, 2));
}

async function cmdLspWorkspaceSymbols(args: string[]): Promise<void> {
  const query = args.find((a) => !a.startsWith("--"));
  if (!query) {
    console.error("omcp code-intel lsp_workspace_symbols: <query> is required");
    process.exitCode = 2;
    return;
  }
  const fileArg = args.find((a) => a.startsWith("--file="));
  const anchorFile = fileArg ? fileArg.slice("--file=".length) : undefined;
  const dir = findProjectRoot(anchorFile ? resolve(anchorFile, "..") : process.cwd());
  const symbols = await searchWorkspaceSymbols(query, dir);
  console.log(JSON.stringify({ query, resultCount: symbols.length, symbols }, null, 2));
}

async function cmdLspHover(args: string[]): Promise<void> {
  const positional = args.filter((a) => !a.startsWith("--"));
  const [file, lineStr, charStr] = positional;
  if (!file || !lineStr || !charStr) {
    console.error("omcp code-intel lsp_hover: <file> <line> <character> are required");
    process.exitCode = 2;
    return;
  }
  const absFile = resolve(file);
  const line = parseInt(lineStr, 10);
  const char = parseInt(charStr, 10);
  if (!existsSync(absFile)) {
    console.error(`omcp code-intel lsp_hover: file not found: ${absFile}`);
    process.exitCode = 2;
    return;
  }
  const content = await readFile(absFile, "utf-8");
  const lines = content.split("\n");
  const targetLine = lines[line - 1] || "";
  let start = char;
  let end = char;
  while (start > 0 && /\w/.test(targetLine[start - 1])) start--;
  while (end < targetLine.length && /\w/.test(targetLine[end])) end++;
  const word = targetLine.slice(start, end);
  const symbols = extractSymbols(content);
  const match = symbols.find((s) => s.name === word);
  console.log(JSON.stringify({
    file: absFile,
    position: { line, character: char },
    word,
    lineContent: targetLine.trim(),
    localDefinition: match ?? null,
    note: "Regex-based approximation.",
  }, null, 2));
}

async function cmdLspFindReferences(args: string[]): Promise<void> {
  const positional = args.filter((a) => !a.startsWith("--"));
  const [file, lineStr, charStr] = positional;
  if (!file || !lineStr || !charStr) {
    console.error("omcp code-intel lsp_find_references: <file> <line> <character> are required");
    process.exitCode = 2;
    return;
  }
  const absFile = resolve(file);
  const line = parseInt(lineStr, 10);
  const char = parseInt(charStr, 10);
  const includeDeclaration = !args.includes("--no-include-declaration");
  const content = await readFile(absFile, "utf-8");
  const lines = content.split("\n");
  const targetLine = lines[line - 1] || "";
  let start = char;
  let end = char;
  while (start > 0 && /\w/.test(targetLine[start - 1])) start--;
  while (end < targetLine.length && /\w/.test(targetLine[end])) end++;
  const symbol = targetLine.slice(start, end);
  if (!symbol) {
    console.error("omcp code-intel lsp_find_references: could not identify symbol at position");
    process.exitCode = 2;
    return;
  }
  const dir = findProjectRoot(resolve(absFile, ".."));
  try {
    const { stdout } = await exec(
      "grep",
      ["-rn", "--include=*.ts", "--include=*.tsx", "--include=*.js", "--include=*.jsx", "--include=*.py", "--include=*.go", "--include=*.rs", "-w", symbol, dir],
      { timeout: 15_000 },
    );
    const refs = stdout.split("\n").filter(Boolean).map((row) => {
      const m = row.match(/^(.+?):(\d+):(.+)$/);
      if (!m) return null;
      return { file: m[1], line: parseInt(m[2], 10), content: m[3].trim() };
    }).filter((e): e is { file: string; line: number; content: string } => e !== null);

    const declarationLines = new Set(
      extractSymbols(content).filter((s) => s.name === symbol).map((s) => s.line),
    );
    const filtered = includeDeclaration
      ? refs
      : refs.filter((ref) => {
          if (resolve(ref.file) !== absFile) return true;
          return !declarationLines.has(ref.line);
        });
    console.log(JSON.stringify({ symbol, includeDeclaration, referenceCount: filtered.length, references: filtered.slice(0, 100) }, null, 2));
  } catch {
    console.log(JSON.stringify({ symbol, includeDeclaration, referenceCount: 0, references: [], note: "grep unavailable on this platform." }, null, 2));
  }
}

async function cmdLspServers(): Promise<void> {
  const checks: Record<string, { available: boolean; version?: string; note?: string }> = {};
  try {
    const { stdout } = await exec("npx", ["tsc", "--version"], { timeout: 10_000 });
    checks["typescript"] = { available: true, version: stdout.trim() };
  } catch {
    checks["typescript"] = { available: false, note: "Install: npm i -D typescript" };
  }
  const sg = await findSgBinary();
  checks["ast-grep"] = sg ? { available: true, version: sg } : { available: false, note: "Install: npm i -g @ast-grep/cli" };
  try {
    await exec("grep", ["--version"]);
    checks["grep"] = { available: true };
  } catch {
    checks["grep"] = { available: false };
  }
  console.log(JSON.stringify({ servers: checks }, null, 2));
}

async function cmdAstGrepSearch(args: string[]): Promise<void> {
  const positional = args.filter((a) => !a.startsWith("--"));
  const [pattern, language] = positional;
  if (!pattern || !language) {
    console.error("omcp code-intel ast_grep_search: <pattern> <language> are required");
    process.exitCode = 2;
    return;
  }
  const pathArg = args.find((a) => a.startsWith("--path="));
  const maxArg = args.find((a) => a.startsWith("--max-results="));
  const path = pathArg ? pathArg.slice("--path=".length) : undefined;
  const maxResults = maxArg ? parseInt(maxArg.slice("--max-results=".length), 10) : undefined;

  const sg = await findSgBinary();
  if (!sg) {
    console.log(JSON.stringify({ matches: [], command: "ast-grep not installed. Install: npm i -g @ast-grep/cli" }, null, 2));
    return;
  }
  const cmd = sg === "npx-ast-grep" ? "npx" : sg;
  const cmdArgs: string[] = sg === "npx-ast-grep" ? ["--yes", "@ast-grep/cli"] : [];
  cmdArgs.push(...buildAstGrepRunArgs(pattern, language, { path }));

  try {
    const { stdout } = await exec(cmd, cmdArgs, { timeout: 30_000 });
    try {
      const parsed = JSON.parse(stdout);
      const matches = Array.isArray(parsed) ? parsed : [parsed];
      const limited = maxResults ? matches.slice(0, maxResults) : matches;
      console.log(JSON.stringify({ matches: limited, command: `${cmd} ${cmdArgs.join(" ")}` }, null, 2));
    } catch {
      console.log(JSON.stringify({ matches: [{ output: stdout }], command: `${cmd} ${cmdArgs.join(" ")}` }, null, 2));
    }
  } catch (err) {
    console.log(JSON.stringify({ matches: [], command: `${cmd} ${cmdArgs.join(" ")} (failed: ${(err as Error).message})` }, null, 2));
  }
}

async function cmdAstGrepReplace(args: string[]): Promise<void> {
  const positional = args.filter((a) => !a.startsWith("--"));
  const [pattern, replacement, language] = positional;
  if (!pattern || !replacement || !language) {
    console.error("omcp code-intel ast_grep_replace: <pattern> <replacement> <language> are required");
    process.exitCode = 2;
    return;
  }
  const pathArg = args.find((a) => a.startsWith("--path="));
  const dryRunArg = args.find((a) => a.startsWith("--dry-run="));
  const path = pathArg ? pathArg.slice("--path=".length) : undefined;
  const dryRun = dryRunArg ? dryRunArg.slice("--dry-run=".length) !== "false" : true;

  const sg = await findSgBinary();
  if (!sg) {
    console.log(JSON.stringify({ matches: [], dryRun, command: "ast-grep not installed. Install: npm i -g @ast-grep/cli" }, null, 2));
    return;
  }
  const cmd = sg === "npx-ast-grep" ? "npx" : sg;
  const cmdArgs: string[] = sg === "npx-ast-grep" ? ["--yes", "@ast-grep/cli"] : [];
  cmdArgs.push(...buildAstGrepRunArgs(pattern, language, { path, replacement, dryRun }));

  try {
    const { stdout } = await exec(cmd, cmdArgs, { timeout: 30_000 });
    try {
      const parsed = JSON.parse(stdout);
      const matches = Array.isArray(parsed) ? parsed : [parsed];
      console.log(JSON.stringify({ matches, dryRun, command: `${cmd} ${cmdArgs.join(" ")}` }, null, 2));
    } catch {
      console.log(JSON.stringify({ matches: [{ output: stdout }], dryRun, command: `${cmd} ${cmdArgs.join(" ")}` }, null, 2));
    }
  } catch (err) {
    console.log(JSON.stringify({ matches: [], dryRun, command: `${cmd} ${cmdArgs.join(" ")} (failed: ${(err as Error).message})` }, null, 2));
  }
}

// ── Dispatch ─────────────────────────────────────────────────────────────────

const HELP = [
  "Usage: omcp code-intel <subcommand> [args]",
  "",
  "Subcommands:",
  "  lsp_diagnostics           <file> [--severity=error|warning]",
  "  lsp_diagnostics_directory <dir>  [--severity=error|warning]",
  "  lsp_document_symbols      <file>",
  "  lsp_workspace_symbols     <query> [--file=<anchor-file>]",
  "  lsp_hover                 <file> <line> <character>",
  "  lsp_find_references       <file> <line> <character> [--no-include-declaration]",
  "  lsp_servers",
  "  ast_grep_search           <pattern> <language> [--path=<dir>] [--max-results=N]",
  "  ast_grep_replace          <pattern> <replacement> <language> [--path=<dir>] [--dry-run=false]",
].join("\n");

export async function runCodeIntelCommand(args: string[]): Promise<void> {
  const [sub, ...rest] = args;

  switch (sub) {
    case "lsp_diagnostics":
      await cmdLspDiagnostics(rest);
      return;
    case "lsp_diagnostics_directory":
      await cmdLspDiagnosticsDirectory(rest);
      return;
    case "lsp_document_symbols":
      await cmdLspDocumentSymbols(rest);
      return;
    case "lsp_workspace_symbols":
      await cmdLspWorkspaceSymbols(rest);
      return;
    case "lsp_hover":
      await cmdLspHover(rest);
      return;
    case "lsp_find_references":
      await cmdLspFindReferences(rest);
      return;
    case "lsp_servers":
      await cmdLspServers();
      return;
    case "ast_grep_search":
      await cmdAstGrepSearch(rest);
      return;
    case "ast_grep_replace":
      await cmdAstGrepReplace(rest);
      return;
    default: {
      console.log(HELP);
      if (sub && sub !== "--help" && sub !== "-h" && sub !== "help") {
        console.error(`\nomcp code-intel: unknown subcommand '${sub}'`);
        process.exitCode = 2;
      }
    }
  }
}
