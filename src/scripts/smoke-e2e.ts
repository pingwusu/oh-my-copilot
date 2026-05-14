// smoke-e2e.ts — runs the actual `omcp` CLI binary against a sandboxed
// OMCP_HOME and asserts non-zero coverage. Used in CI and locally.

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = join(import.meta.dirname ?? __dirname, "..", "..");
const CLI = join(ROOT, "dist", "cli", "omcp.js");

function run(args: string[], env: NodeJS.ProcessEnv): { code: number; stdout: string; stderr: string } {
  const r = spawnSync(process.execPath, [CLI, ...args], {
    env: { ...process.env, ...env },
    encoding: "utf8",
  });
  return { code: r.status ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

function assert(cond: boolean, msg: string): void {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    process.exit(1);
  }
  console.log(`OK   ${msg}`);
}

function main() {
  if (!existsSync(CLI)) {
    console.error(`smoke-e2e: ${CLI} missing; run \`npm run build\` first`);
    process.exit(1);
  }

  const sandbox = mkdtempSync(join(tmpdir(), "omcp-smoke-e2e-"));
  const env = { OMCP_HOME: sandbox };

  const version = run(["--version"], env);
  assert(version.code === 0, "omcp --version exits 0");
  assert(/\d+\.\d+\.\d+/.test(version.stdout), "omcp --version prints a semver");

  const help = run(["--help"], env);
  assert(help.code === 0, "omcp --help exits 0");
  assert(help.stdout.includes("setup"), "help mentions setup");
  assert(help.stdout.includes("doctor"), "help mentions doctor");
  assert(help.stdout.includes("ask"), "help mentions ask");
  assert(help.stdout.includes("team"), "help mentions team");

  const setup = run(["setup"], env);
  assert(setup.code === 0, "omcp setup exits 0");
  assert(setup.stdout.includes("complete"), "setup announces completion");

  assert(
    existsSync(join(sandbox, "installed-plugins", "oh-my-copilot", "oh-my-copilot", ".claude-plugin", "plugin.json")),
    "plugin manifest landed in cache",
  );
  assert(
    existsSync(join(sandbox, "marketplaces", "oh-my-copilot.json")),
    "marketplace file written",
  );
  assert(existsSync(join(sandbox, "config.json")), "config.json written");
  assert(existsSync(join(sandbox, "mcp-config.json")), "mcp-config.json written");

  const dryRun = run(["setup", "--dry-run"], { ...env, OMCP_HOME: mkdtempSync(join(tmpdir(), "omcp-smoke-dry-")) });
  assert(dryRun.code === 0, "omcp setup --dry-run exits 0");

  const doctor = run(["doctor"], env);
  // doctor exits 2 if copilot binary missing (which it is in CI for the test
  // sandbox); we accept 0, 1, or 2 here — the assertion is that it prints.
  assert([0, 1, 2].includes(doctor.code), `omcp doctor exits with sane code (got ${doctor.code})`);
  assert(
    doctor.stdout.includes("oh-my-copilot plugin cache"),
    "doctor reports plugin cache check",
  );

  console.log("\nsmoke-e2e: all assertions passed");
}

main();
