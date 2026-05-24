"use strict";
// bench.cjs — DEP0190 Direction A: where-npm + spawn-direct probe
// Run: node docs/probes/dep0190-direction-a/bench.cjs
//
// Tests:
//   T1  where.exe npm   → picks npm.cmd absolute path
//   T2  spawnSync(npmCmd, ['--version'], {shell:false})   [EINVAL expected for .cmd]
//   T3  spawnSync('cmd.exe', ['/c', npmCmd, '--version'], {shell:false})
//   T4  resolve node_modules/npm/bin/npm-cli.js → spawnSync(node, [npmCliJs, '--version'])
//   T5  same node + npm-cli.js but running 'install' in a temp dir (full exercise)
//   T6  DEP0190 presence check: capture stderr of T3 and T4 for the warning string

const { spawnSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const SEP = "─".repeat(60);

function run(label, cmd, args, opts) {
  console.log(`\n${SEP}`);
  console.log(`[${label}] cmd=${JSON.stringify(cmd)} args=${JSON.stringify(args)}`);
  console.log(`        shell=${opts.shell ?? false}  cwd=${opts.cwd ?? process.cwd()}`);
  const r = spawnSync(cmd, args, {
    encoding: "utf8",
    timeout: 30000,
    env: process.env,
    ...opts,
  });
  console.log(`  status : ${r.status}`);
  console.log(`  error  : ${r.error ? r.error.message : "none"}`);
  const stdout = (r.stdout || "").trim();
  const stderr = (r.stderr || "").trim();
  if (stdout) console.log(`  stdout : ${stdout.slice(0, 300)}`);
  if (stderr) console.log(`  stderr : ${stderr.slice(0, 800)}`);
  const dep0190 = (stderr + (r.stderr || "")).includes("DEP0190");
  console.log(`  DEP0190: ${dep0190 ? "YES ⚠" : "no"}`);
  return r;
}

// ── T1: where.exe resolution ───────────────────────────────────────────────
console.log(`\n${SEP}`);
console.log("[T1] where.exe npm");
const whereR = spawnSync("where.exe", ["npm"], { encoding: "utf8", shell: false });
const npmPaths = (whereR.stdout || "").trim().split(/\r?\n/).map(p => p.trim()).filter(Boolean);
console.log("  paths:", npmPaths);
const npmCmdPath = npmPaths.find(p => /\.cmd$/i.test(p)) || npmPaths[0] || "";
console.log("  chosen (.cmd preferred):", npmCmdPath);

// ── T2: spawnSync(npm.cmd, shell:false) — expected EINVAL ─────────────────
run("T2 npm.cmd shell:false", npmCmdPath, ["--version"], { shell: false });

// ── T3: cmd.exe /c <npm.cmd> --version, shell:false ───────────────────────
const cmdExe = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "cmd.exe");
run("T3 cmd.exe /c npm.cmd", cmdExe, ["/c", npmCmdPath, "--version"], { shell: false });

// ── T4: resolve node_modules/npm/bin/npm-cli.js, spawn node directly ──────
// npm ships a bundled CLI; node.exe + npm-cli.js avoids .cmd entirely
let npmCliJs = "";
try {
  // resolve from where node.exe lives → sibling node_modules/npm
  const nodeDir = path.dirname(process.execPath);
  const candidate = path.join(nodeDir, "node_modules", "npm", "bin", "npm-cli.js");
  if (fs.existsSync(candidate)) {
    npmCliJs = candidate;
    console.log(`\n${SEP}`);
    console.log(`[T4-find] npm-cli.js found at: ${npmCliJs}`);
  } else {
    console.log(`\n${SEP}`);
    console.log(`[T4-find] npm-cli.js NOT found at ${candidate}`);
  }
} catch (e) {
  console.log("[T4-find] error:", e.message);
}

if (npmCliJs) {
  run("T4 node npm-cli.js --version", process.execPath, [npmCliJs, "--version"], { shell: false });
}

// ── T5: full npm install test in a temp dir using node + npm-cli.js ────────
if (npmCliJs) {
  console.log(`\n${SEP}`);
  console.log("[T5] Full npm install via node + npm-cli.js in temp dir");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "dep0190-probe-"));
  console.log("  tmpDir:", tmpDir);
  // write minimal package.json
  fs.writeFileSync(path.join(tmpDir, "package.json"), JSON.stringify({
    name: "dep0190-probe-runtime",
    version: "1.0.0",
    type: "module",
    private: true,
    dependencies: { "is-odd": "^3.0.1" },
  }, null, 2) + "\n", "utf8");

  const installArgs = [
    npmCliJs,
    "install",
    "--omit=dev",
    "--ignore-scripts",
    "--prefer-offline",
    "--no-audit",
    "--no-fund",
  ];
  run("T5 node npm-cli.js install", process.execPath, installArgs, {
    shell: false,
    cwd: tmpDir,
    stdio: "pipe",
  });

  // cleanup
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
} else {
  console.log("\n[T5] SKIPPED — npm-cli.js not found");
}

// ── T6: cmd.exe /c npm install in temp dir — DEP0190 check ────────────────
console.log(`\n${SEP}`);
console.log("[T6] cmd.exe /c npm.cmd install in temp dir (current shell:true behavior equivalent)");
const tmpDir2 = fs.mkdtempSync(path.join(os.tmpdir(), "dep0190-probe2-"));
fs.writeFileSync(path.join(tmpDir2, "package.json"), JSON.stringify({
  name: "dep0190-probe2-runtime",
  version: "1.0.0",
  type: "module",
  private: true,
  dependencies: { "is-odd": "^3.0.1" },
}, null, 2) + "\n", "utf8");

run("T6 cmd.exe /c npm.cmd install", cmdExe, ["/c", npmCmdPath, "install",
  "--omit=dev", "--ignore-scripts", "--prefer-offline", "--no-audit", "--no-fund"],
  { shell: false, cwd: tmpDir2, stdio: "pipe" });

try { fs.rmSync(tmpDir2, { recursive: true, force: true }); } catch (_) {}

console.log(`\n${SEP}`);
console.log("DONE");
