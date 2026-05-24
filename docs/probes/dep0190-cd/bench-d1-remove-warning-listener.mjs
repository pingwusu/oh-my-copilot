/**
 * DIRECTION D1 bench: process.removeAllListeners('warning') to suppress DEP0190
 *
 * The DEP0190 warning is emitted on the parent process 'warning' event.
 * If we remove all warning listeners (or add a no-op one that swallows it)
 * BEFORE spawning npm, the warning won't propagate to stderr.
 *
 * Strategy tested here:
 *   process.removeAllListeners('warning')   -- removes Node's built-in printer
 *   (optionally re-add a filtered listener that drops DEP0190 only)
 *
 * Run: node docs/probes/dep0190-cd/bench-d1-remove-warning-listener.mjs
 */

import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// --- D1 suppression: remove the default warning printer, add filtered re-printer ---
// Node's built-in warning printer is a 'warning' listener on process.
// Removing all and re-adding a filter means DEP0190 is silently dropped,
// but all other warnings are still printed.
process.removeAllListeners("warning");
let dep0190Suppressed = 0;
process.on("warning", (w) => {
  if (w.code === "DEP0190" || String(w.message).includes("DEP0190")) {
    dep0190Suppressed++;
    // intentionally silenced — do NOT forward to stderr
    return;
  }
  // Re-print all non-DEP0190 warnings as Node normally would
  process.stderr.write(`[WARNING] ${w.name}: ${w.message}\n`);
});

const workdir = mkdtempSync(join(tmpdir(), "bench-d1-"));
writeFileSync(join(workdir, "package.json"), JSON.stringify({ name: "bench-d1", version: "1.0.0", private: true, dependencies: {} }, null, 2));

console.log("[BENCH-D1] workdir:", workdir);
console.log("[BENCH-D1] using spawnSync('npm', [...], { shell: true }) with removeAllListeners('warning')");

// Use the same spawnSync+shell:true that v1.5 uses (to provoke DEP0190)
const result = spawnSync(
  "npm",
  ["install", "--omit=dev", "--ignore-scripts", "--prefer-offline", "--no-audit", "--no-fund"],
  {
    cwd: workdir,
    stdio: "pipe",   // pipe so we can see if DEP0190 leaks to stderr
    shell: true,
  }
);

const stdout = result.stdout?.toString().trim() ?? "";
const stderr = result.stderr?.toString().trim() ?? "";

console.log("[BENCH-D1] exit status:", result.status);
if (stdout) console.log("[BENCH-D1] stdout:", stdout);
if (stderr) console.log("[BENCH-D1] stderr (first 400 chars):", stderr.slice(0, 400));

// Check if DEP0190 leaked to stderr of the child (child is npm, not this process — unlikely)
const dep0190InChildStderr = stderr.includes("DEP0190");

// Give event loop a tick
await new Promise((r) => setImmediate(r));

console.log("[BENCH-D1] DEP0190 caught by our listener (suppressed):", dep0190Suppressed);
console.log("[BENCH-D1] DEP0190 in child stderr:", dep0190InChildStderr);

const works = result.status === 0;
const dep0190Gone = !dep0190InChildStderr && dep0190Suppressed === 0;

// Note: DEP0190 fires on THIS process (parent), so if dep0190Suppressed > 0, it was caught and swallowed.
// If dep0190Suppressed === 0, it either never fired or was handled elsewhere.
console.log("[BENCH-D1] RESULT:", works && dep0190Gone
  ? "PASS (works, DEP0190 not visible)"
  : works && dep0190Suppressed > 0
  ? "PARTIAL-SUPPRESS (works, DEP0190 caught+swallowed by listener)"
  : works
  ? "PARTIAL (works, DEP0190 status unclear)"
  : "FAIL (npm errored)");

rmSync(workdir, { recursive: true, force: true });
process.exit(result.status ?? 1);
