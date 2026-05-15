// smoke-e2e.ts — runs the actual `omcp` CLI binary against a sandboxed
// OMCP_HOME and asserts non-zero coverage. Used in CI and locally.

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = join(import.meta.dirname ?? __dirname, "..", "..");
const CLI = join(ROOT, "dist", "cli", "omcp.js");

function run(
  args: string[],
  env: NodeJS.ProcessEnv,
  input?: string,
): { code: number; stdout: string; stderr: string } {
  const r = spawnSync(process.execPath, [CLI, ...args], {
    env: { ...process.env, ...env },
    encoding: "utf8",
    input,
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

  // hook fire path — should exit 0 and emit JSON when --json is passed.
  const hookSandbox = mkdtempSync(join(tmpdir(), "omcp-smoke-hook-"));
  mkdirSync(join(hookSandbox, ".omcp", "hooks"), { recursive: true });
  writeFileSync(
    join(hookSandbox, ".omcp", "hooks", "PreToolUse-test.mjs"),
    [
      "export default {",
      '  name: "smoke-pre-test",',
      '  events: ["PreToolUse"],',
      '  async run() { return { kind: "advise", text: "smoke-ok" }; }',
      "};",
    ].join("\n"),
    "utf8",
  );
  const hookEnv = { ...env, OMCP_PLUGIN_ROOT: join(hookSandbox, "_no_plugin_") };
  const hookFire = spawnSync(
    process.execPath,
    [CLI, "hook", "fire", "PreToolUse", "--json"],
    {
      env: { ...process.env, ...hookEnv },
      cwd: hookSandbox,
      encoding: "utf8",
      input: JSON.stringify({ sessionId: "s1", cwd: hookSandbox }),
    },
  );
  assert(hookFire.status === 0, "omcp hook fire PreToolUse --json exits 0");
  assert(
    hookFire.stdout.includes("smoke-pre-test") &&
      hookFire.stdout.includes("smoke-ok"),
    "hook fire JSON contains repo-local hook result",
  );
  // Validate JSON shape.
  try {
    const parsed = JSON.parse(hookFire.stdout.trim()) as {
      event: string;
      results: Array<{ hook: string; result: { kind: string } }>;
    };
    assert(parsed.event === "PreToolUse", "hook fire JSON event field correct");
    assert(
      Array.isArray(parsed.results) && parsed.results.length >= 1,
      "hook fire JSON results array non-empty",
    );
  } catch (err) {
    assert(false, `hook fire JSON parses: ${(err as Error).message}`);
  }

  // hud — must print a single line and exit 0 even with no state.
  const hud = run(["hud"], env);
  assert(hud.code === 0, "omcp hud exits 0");
  assert(hud.stdout.split("\n").filter((l) => l.length > 0).length === 1, "omcp hud prints a single line");
  assert(hud.stdout.startsWith("omcp"), "omcp hud line starts with 'omcp'");

  console.log("\nsmoke-e2e: all assertions passed");
}

main();
