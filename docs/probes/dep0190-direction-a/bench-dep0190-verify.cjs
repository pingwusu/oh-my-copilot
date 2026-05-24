"use strict";
// bench-dep0190-verify.cjs
// Confirms DEP0190 fires when shell:true is used (current v1.5 behavior),
// so we have a before/after for the report.

const { spawnSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const SEP = "─".repeat(60);

function run(label, cmd, args, opts) {
  console.log(`\n${SEP}`);
  console.log(`[${label}] shell=${opts.shell}  cmd=${JSON.stringify(cmd)}`);
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
  if (stdout) console.log(`  stdout : ${stdout.slice(0, 200)}`);
  if (stderr) console.log(`  stderr : ${stderr.slice(0, 800)}`);
  const dep0190 = (stderr).includes("DEP0190");
  console.log(`  DEP0190: ${dep0190 ? "YES - warning present" : "no"}`);
  return r;
}

// ── V1: shell:true with "npm" (v1.5 behavior) ─────────────────────────────
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "dep0190-verify-"));
fs.writeFileSync(path.join(tmpDir, "package.json"), JSON.stringify({
  name: "dep0190-verify",
  version: "1.0.0",
  type: "module",
  private: true,
  dependencies: { "is-odd": "^3.0.1" },
}, null, 2) + "\n", "utf8");

run("V1 shell:true npm install (v1.5 current)", "npm", [
  "install", "--omit=dev", "--ignore-scripts", "--prefer-offline", "--no-audit", "--no-fund"
], { shell: true, cwd: tmpDir, stdio: "pipe" });

try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}

// ── V2: node + npm-cli.js shell:false (Direction A proposed) ──────────────
const nodeDir = path.dirname(process.execPath);
const npmCliJs = path.join(nodeDir, "node_modules", "npm", "bin", "npm-cli.js");

const tmpDir2 = fs.mkdtempSync(path.join(os.tmpdir(), "dep0190-verify2-"));
fs.writeFileSync(path.join(tmpDir2, "package.json"), JSON.stringify({
  name: "dep0190-verify2",
  version: "1.0.0",
  type: "module",
  private: true,
  dependencies: { "is-odd": "^3.0.1" },
}, null, 2) + "\n", "utf8");

run("V2 shell:false node+npm-cli.js install (Direction A)", process.execPath, [
  npmCliJs, "install", "--omit=dev", "--ignore-scripts", "--prefer-offline", "--no-audit", "--no-fund"
], { shell: false, cwd: tmpDir2, stdio: "pipe" });

try { fs.rmSync(tmpDir2, { recursive: true, force: true }); } catch (_) {}

console.log(`\n${SEP}`);
console.log("DONE");
