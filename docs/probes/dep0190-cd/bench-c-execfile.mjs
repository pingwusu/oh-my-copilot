/**
 * DIRECTION C bench: execFile alternatives to spawnSync(shell:true)
 *
 * Node 24 DEP0190 fires when spawnSync/spawn is called with shell:true on Windows.
 * execFile() bypasses the shell entirely. However, .cmd files are Windows batch
 * scripts and CANNOT be execFile'd directly (EINVAL on Windows). Two working
 * sub-variants are tested:
 *
 *   C1: execFileSync("npm.cmd", [...], { shell: false })
 *       => FAILS: EINVAL — .cmd files require a shell on Windows
 *
 *   C2: execFileSync("cmd.exe", ["/c", "npm.cmd", ...], { shell: false })
 *       => PASS: cmd.exe IS an executable; /c npm.cmd invokes the shim via
 *          cmd.exe internals, not Node's shell:true path. DEP0190 NOT fired.
 *
 *   C3: execFileSync(process.execPath, [npm-cli.js, ...], { shell: false })
 *       => PASS: bypasses the .cmd shim entirely, runs npm as a pure JS script
 *          under the current node binary. DEP0190 NOT fired.
 *
 * Run: node docs/probes/dep0190-cd/bench-c-execfile.mjs
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { existsSync } from "node:fs";

function makeWorkdir(tag) {
  const d = mkdtempSync(join(tmpdir(), `bench-c-${tag}-`));
  writeFileSync(join(d, "package.json"), JSON.stringify(
    { name: `bench-c-${tag}`, version: "1.0.0", private: true, dependencies: {} }, null, 2
  ));
  return d;
}

// ── C1: direct execFile on npm.cmd (expected EINVAL) ───────────────────────
{
  let dep0190 = false;
  const h = (w) => { if (w.code === "DEP0190" || String(w.message).includes("DEP0190")) dep0190 = true; };
  process.on("warning", h);
  const wd = makeWorkdir("c1");
  try {
    execFileSync("C:\\Program Files\\nodejs\\npm.cmd",
      ["install", "--omit=dev", "--ignore-scripts", "--prefer-offline", "--no-audit", "--no-fund"],
      { cwd: wd, stdio: "pipe", shell: false });
    console.log("[C1] npm.cmd direct execFile: SUCCESS (unexpected)");
  } catch (e) {
    console.log(`[C1] npm.cmd direct execFile: FAIL as expected — ${e.code ?? e.message}`);
  }
  await new Promise((r) => setImmediate(r));
  console.log("[C1] DEP0190 fired:", dep0190);
  process.off("warning", h);
  rmSync(wd, { recursive: true, force: true });
}

// ── C2: execFile("cmd.exe", ["/c", "npm.cmd", ...], shell:false) ───────────
{
  let dep0190 = false;
  const h = (w) => { if (w.code === "DEP0190" || String(w.message).includes("DEP0190")) dep0190 = true; };
  process.on("warning", h);
  const wd = makeWorkdir("c2");
  try {
    const out = execFileSync("cmd.exe",
      ["/c", "npm.cmd", "install", "--omit=dev", "--ignore-scripts", "--prefer-offline", "--no-audit", "--no-fund"],
      { cwd: wd, stdio: "pipe", shell: false });
    console.log("[C2] cmd.exe /c npm.cmd: SUCCESS:", out.toString().trim());
  } catch (e) {
    console.error("[C2] cmd.exe /c npm.cmd: FAIL:", e.message);
    if (e.stderr) console.error("[C2] stderr:", e.stderr.toString().trim().slice(0, 300));
  }
  await new Promise((r) => setImmediate(r));
  console.log("[C2] DEP0190 fired:", dep0190);
  console.log("[C2] RESULT:", !dep0190 ? "PASS (works, no DEP0190)" : "PARTIAL (works but DEP0190 present)");
  process.off("warning", h);
  rmSync(wd, { recursive: true, force: true });
}

// ── C3: execFile(node, [npm-cli.js, ...], shell:false) ────────────────────
{
  const npmCliJs = "C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js";
  let dep0190 = false;
  const h = (w) => { if (w.code === "DEP0190" || String(w.message).includes("DEP0190")) dep0190 = true; };
  process.on("warning", h);
  const wd = makeWorkdir("c3");
  if (existsSync(npmCliJs)) {
    try {
      const out = execFileSync(process.execPath,
        [npmCliJs, "install", "--omit=dev", "--ignore-scripts", "--prefer-offline", "--no-audit", "--no-fund"],
        { cwd: wd, stdio: "pipe", shell: false });
      console.log("[C3] node npm-cli.js: SUCCESS:", out.toString().trim());
    } catch (e) {
      console.error("[C3] node npm-cli.js: FAIL:", e.message);
      if (e.stderr) console.error("[C3] stderr:", e.stderr.toString().trim().slice(0, 300));
    }
  } else {
    console.log("[C3] SKIP: npm-cli.js not found at", npmCliJs);
  }
  await new Promise((r) => setImmediate(r));
  console.log("[C3] DEP0190 fired:", dep0190);
  console.log("[C3] RESULT:", !dep0190 ? "PASS (works, no DEP0190)" : "PARTIAL (works but DEP0190 present)");
  process.off("warning", h);
  rmSync(wd, { recursive: true, force: true });
}
