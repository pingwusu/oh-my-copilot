#!/usr/bin/env node
// TUI-mode hook-firing probe helper.
//
// Wires the diagnostic debug-probe into the Copilot CLI hook config so the
// user can interactively verify whether tool events dispatch hooks.
//
// Targets ~/.copilot/settings.json (Copilot's real hook-config surface in
// v1.0.51 — see the SETTINGS_PATH comment below).
//
// Usage (run from anywhere; node finds the absolute paths):
//   node scripts/smoke/wire-probe-for-tui.mjs wire    # backup + inject + clear log
//   # then: open `copilot` (TUI), use a tool (e.g. Read), /quit
//   node scripts/smoke/wire-probe-for-tui.mjs check   # report probe.log contents
//   node scripts/smoke/wire-probe-for-tui.mjs unwire  # restore settings.json from backup
//
// Backup path: ~/.copilot/settings.json.tui-smoketest-backup
// Probe log:   ~/.copilot/omcp-debug-probe.log (and {tmpdir}/omcp-debug-probe.log)

import {
  copyFileSync,
  existsSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const HOME = homedir();
// Copilot CLI v1.0.51 reads hook config from ~/.copilot/settings.json,
// NOT ~/.copilot/config.json. Evidence: 2026-05-23 debug-probe wired into
// config.json never fired; the only hook errors logged were from leftover
// entries in settings.json. Earlier HANDOFF assertions ("hooks don't fire
// in -p mode") were based on wiring the wrong file.
const SETTINGS_PATH = join(HOME, ".copilot", "settings.json");
const BACKUP_PATH = `${SETTINGS_PATH}.tui-smoketest-backup`;
const REPO_ROOT = resolve(import.meta.dirname, "..", "..");
const PROBE = join(REPO_ROOT, "scripts", "smoke", "debug-probe.mjs");
const PROBE_LOG = join(HOME, ".copilot", "omcp-debug-probe.log");

function log(...args) {
  console.error(`[tui-probe] ${args.join(" ")}`);
}

function loadConfig() {
  const raw = readFileSync(SETTINGS_PATH, "utf8");
  const cleaned = raw.replace(/^\s*\/\/[^\n]*$/gm, "");
  return JSON.parse(cleaned);
}

function probeMatcher(probeKind, { emitModifiedResult = false } = {}) {
  const suffix = emitModifiedResult ? " --emit-modifiedresult" : "";
  return {
    matcher: "*",
    hooks: [
      {
        type: "command",
        command: `node "${PROBE}" ${probeKind}${suffix}`,
        timeout: 5,
        __omcpSmoke: true,
      },
    ],
  };
}

function wire() {
  if (existsSync(BACKUP_PATH)) {
    log(
      `backup already exists at ${BACKUP_PATH} — run 'unwire' first or delete it manually if you are sure it is stale`,
    );
    process.exit(2);
  }

  copyFileSync(SETTINGS_PATH, BACKUP_PATH);
  log(`backed up settings.json → ${BACKUP_PATH}`);

  const json = loadConfig();
  const next = { ...json, hooks: { ...(json.hooks ?? {}) } };
  // Asymmetric wiring so a single TUI run yields two data points:
  //   - postToolUse: emit modifiedResult on stdout → tests stdout-schema theory
  //   - preToolUse:  silent (no stdout) → tests pure exit-code path
  next.hooks.postToolUse = [probeMatcher("post-camel", { emitModifiedResult: true })];
  next.hooks.PostToolUse = [probeMatcher("post-pascal", { emitModifiedResult: true })];
  next.hooks.preToolUse = [probeMatcher("pre-camel")];
  next.hooks.PreToolUse = [probeMatcher("pre-pascal")];
  writeFileSync(SETTINGS_PATH, `${JSON.stringify(next, null, 2)}\n`);
  log("wired 4 probe variants (pre* = silent, post* = emit modifiedResult)");

  if (existsSync(PROBE_LOG)) {
    rmSync(PROBE_LOG, { force: true });
    log(`cleared old probe log at ${PROBE_LOG}`);
  } else {
    log(`probe log path: ${PROBE_LOG} (will be created if hooks fire)`);
  }

  console.log("");
  console.log("Next steps:");
  console.log("  1. Open Copilot in TUI mode:  copilot");
  console.log("  2. Have it use a tool, e.g. ask it to Read any file");
  console.log("  3. Quit the TUI (/quit)");
  console.log("  4. node scripts/smoke/wire-probe-for-tui.mjs check");
  console.log("  5. node scripts/smoke/wire-probe-for-tui.mjs unwire  ← do not skip");
}

function check() {
  if (!existsSync(PROBE_LOG)) {
    log(`probe log NOT FOUND at ${PROBE_LOG}`);
    log("verdict: NO_FIRE — Copilot CLI did NOT fire any hook in TUI either");
    console.log("VERDICT=NO_FIRE");
    return;
  }
  const content = readFileSync(PROBE_LOG, "utf8");
  const lines = content.split("\n").filter((l) => l.length > 0);
  log(`probe log has ${lines.length} entr${lines.length === 1 ? "y" : "ies"} at ${PROBE_LOG}`);
  for (const line of lines) console.log(`  ${line}`);
  if (lines.length === 0) {
    log("verdict: NO_FIRE — log file exists but contains no entries");
    console.log("VERDICT=NO_FIRE");
  } else {
    log("verdict: FIRE — TUI mode DOES dispatch hooks");
    console.log("VERDICT=FIRE");
  }
}

function unwire() {
  if (!existsSync(BACKUP_PATH)) {
    log(
      `no backup at ${BACKUP_PATH} — settings.json was not wired by this script (or already unwired)`,
    );
    process.exit(0);
  }
  copyFileSync(BACKUP_PATH, SETTINGS_PATH);
  rmSync(BACKUP_PATH, { force: true });
  log(`restored settings.json from backup and deleted ${BACKUP_PATH}`);
}

const verb = process.argv[2];
switch (verb) {
  case "wire":
    wire();
    break;
  case "check":
    check();
    break;
  case "unwire":
    unwire();
    break;
  default:
    console.error(
      `usage: node ${process.argv[1]} <wire|check|unwire>`,
    );
    process.exit(1);
}
