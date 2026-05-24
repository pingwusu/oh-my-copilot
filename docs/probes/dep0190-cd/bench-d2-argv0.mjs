/**
 * DIRECTION D2 bench: spawnSync("npm", [...], { shell: true, argv0: "npm.cmd" })
 *
 * The argv0 option overrides the value of argv[0] sent to the child process.
 * Hypothesis: Node 24's DEP0190 check inspects the command string to decide
 * whether to emit the warning. If argv0 is set to "npm.cmd", it might satisfy
 * the check and suppress the warning, or it might have no effect at all.
 *
 * Run: node docs/probes/dep0190-cd/bench-d2-argv0.mjs
 */

import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// Capture DEP0190 if it fires on this process
let dep0190Fired = false;
process.on("warning", (w) => {
  if (w.code === "DEP0190" || String(w.message).includes("DEP0190")) {
    dep0190Fired = true;
    console.error("[BENCH-D2] DEP0190 WARNING DETECTED:", w.message);
  }
});

const workdir = mkdtempSync(join(tmpdir(), "bench-d2-"));
writeFileSync(join(workdir, "package.json"), JSON.stringify({ name: "bench-d2", version: "1.0.0", private: true, dependencies: {} }, null, 2));

console.log("[BENCH-D2] workdir:", workdir);
console.log("[BENCH-D2] using spawnSync('npm', [...], { shell: true, argv0: 'npm.cmd' })");

const result = spawnSync(
  "npm",
  ["install", "--omit=dev", "--ignore-scripts", "--prefer-offline", "--no-audit", "--no-fund"],
  {
    cwd: workdir,
    stdio: "pipe",
    shell: true,
    argv0: "npm.cmd",   // D2: override argv[0] — does Node check this?
  }
);

const stdout = result.stdout?.toString().trim() ?? "";
const stderr = result.stderr?.toString().trim() ?? "";

console.log("[BENCH-D2] exit status:", result.status);
if (stdout) console.log("[BENCH-D2] stdout:", stdout);
if (stderr) console.log("[BENCH-D2] stderr (first 400 chars):", stderr.slice(0, 400));

// Give event loop a tick for warning events
await new Promise((r) => setImmediate(r));

console.log("[BENCH-D2] DEP0190 fired:", dep0190Fired);
console.log("[BENCH-D2] RESULT:", result.status === 0 && !dep0190Fired
  ? "PASS (works, no DEP0190)"
  : result.status === 0
  ? "PARTIAL (works but DEP0190 present)"
  : "FAIL (npm errored)");

rmSync(workdir, { recursive: true, force: true });
process.exit(result.status ?? 1);
