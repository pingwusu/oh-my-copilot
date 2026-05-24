#!/usr/bin/env node
// Drives the modifiedResult smoke test end-to-end:
//   1. Snapshot current ~/.copilot/config.json
//   2. Inject a PostToolUse hook that runs probe-modifiedresult.mjs
//   3. Run Copilot CLI non-interactively against a known-content file
//   4. Inspect Copilot's textual response for canary vs original payload
//   5. Restore the original config.json
//   6. Print a verdict line: PASS | APPEND | FAIL | INDETERMINATE

import { readFileSync, writeFileSync, copyFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const HOME = homedir();
const CONFIG_PATH = join(HOME, ".copilot", "config.json");
const BACKUP_PATH = `${CONFIG_PATH}.smoketest-backup`;
const REPO_ROOT = resolve(import.meta.dirname, "..", "..");
const PROBE = join(REPO_ROOT, "scripts", "smoke", "probe-modifiedresult.mjs");
const CANARY_FILE = join(REPO_ROOT, "scripts", "smoke", "canary-original.txt");

const ORIGINAL_SENTINEL = "SENTINEL_ORIGINAL_PAYLOAD_BANDIT_77";
const CANARY_SENTINEL = "CANARY_REPLACEMENT_PAYLOAD_KESTREL_42";

function log(...args) {
  console.error(`[smoke] ${args.join(" ")}`);
}

function loadConfig() {
  const raw = readFileSync(CONFIG_PATH, "utf8");
  // strip // comments minimally
  const cleaned = raw.replace(/^\s*\/\/[^\n]*$/gm, "");
  return { raw, json: JSON.parse(cleaned) };
}

function restoreConfig() {
  if (existsSync(BACKUP_PATH)) {
    copyFileSync(BACKUP_PATH, CONFIG_PATH);
    log("restored config.json from backup");
  }
}

let exitCode = 1;

try {
  const { json } = loadConfig();
  const next = { ...json };
  next.hooks = { ...(json.hooks ?? {}) };
  // Wire BOTH camelCase (canonical per COPILOT_VALID_EVENTS) and PascalCase
  // (alias per Copilot bundle's s2t map) to confirm whether aliases actually
  // resolve at runtime. Also wire a PreToolUse logger so we can verify ANY
  // hook fires for the Read tool.
  const probeMatcher = (probeKind) => ({
    matcher: "*",
    hooks: [
      {
        type: "command",
        command: `node "${PROBE}" ${probeKind}`,
        timeout: 5,
        __omcpSmoke: true,
      },
    ],
  });
  next.hooks.postToolUse = [probeMatcher("post-camel")];
  next.hooks.PostToolUse = [probeMatcher("post-pascal")];
  next.hooks.preToolUse = [probeMatcher("pre-camel")];
  next.hooks.PreToolUse = [probeMatcher("pre-pascal")];
  writeFileSync(CONFIG_PATH, `${JSON.stringify(next, null, 2)}\n`);
  log("wired probe into PostToolUse");

  const prompt =
    `Read the file at "${CANARY_FILE}" and report back the EXACT first line of its content as a quoted string in your response. ` +
    `Do not paraphrase. Reply in 1-2 sentences only.`;

  log("invoking copilot CLI non-interactively (may take a moment)...");
  const copilotBin = "C:\\.tools\\.npm-global\\copilot.cmd";
  // Use shell:true so Windows .cmd shim resolves. Hand-quote the prompt
  // because the shell will re-tokenize. Replace inner double-quotes with
  // single-quotes inside the prompt to avoid breaking quoting.
  const safePrompt = prompt.replace(/"/g, "'");
  const shellCmd = `"${copilotBin}" -p "${safePrompt}" --allow-all-tools --allow-all-paths --no-color`;
  log(`running: ${shellCmd}`);
  const result = spawnSync(shellCmd, {
    encoding: "utf8",
    timeout: 180_000,
    stdio: ["ignore", "pipe", "pipe"],
    shell: true,
    windowsHide: true,
  });
  const stdout = result.stdout ?? "";
  const stderr = result.stderr ?? "";

  log(`copilot exited with code ${result.status}`);
  if (result.error) {
    log(`spawn error: ${result.error.message}`);
  }

  const hasOriginal = stdout.includes(ORIGINAL_SENTINEL);
  const hasCanary = stdout.includes(CANARY_SENTINEL);

  let verdict;
  if (hasCanary && !hasOriginal) verdict = "PASS";
  else if (hasCanary && hasOriginal) verdict = "APPEND";
  else if (!hasCanary && hasOriginal) verdict = "FAIL";
  else verdict = "INDETERMINATE";

  const outputPath = join(REPO_ROOT, "scripts", "smoke", "smoke-output.log");
  writeFileSync(
    outputPath,
    [
      `verdict: ${verdict}`,
      `hasCanary: ${hasCanary}`,
      `hasOriginal: ${hasOriginal}`,
      `exitCode: ${result.status}`,
      `------- stdout -------`,
      stdout,
      `------- stderr -------`,
      stderr,
    ].join("\n"),
  );
  log(`full output captured at ${outputPath}`);

  console.log(`VERDICT=${verdict}`);
  console.log(`hasCanary=${hasCanary} hasOriginal=${hasOriginal}`);
  exitCode = 0;
} catch (err) {
  log("error:", err?.stack ?? String(err));
} finally {
  restoreConfig();
}

process.exit(exitCode);
