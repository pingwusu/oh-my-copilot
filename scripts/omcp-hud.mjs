#!/usr/bin/env node
// omcp HUD — single-line status output for terminal status bars. ESM, no deps.
//
// Sources (all graceful — missing files mean blank fields):
//   - process.env.OMCP_PLUGIN_ROOT or ~/.copilot/installed-plugins/oh-my-copilot/oh-my-copilot
//   - process.env.OMCP_MODEL_FAMILY or ~/.copilot/config.json `model`
//   - ${cwd}/.omcp/state/mode.json   { modes: ["ralph", "autopilot", ...] }
//   - ${cwd}/.omcp/state/ralph.json  { iter, max }
//   - ${cwd}/.omcp/state/team.json   { agentsDone, spawned }
//   - ${cwd}/.omcp/notepad.md        (first non-empty line, truncated to 60 chars)
//
// Output format (single line):
//   omcp · {model_family} · {active_modes} · {iter}/{max} · {agents_done}/{spawned} · {note}
//
// Any error -> prints "omcp · (status unavailable)" and exits 0.

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const NOTE_MAX = 60;

function readJsonSafe(path) {
  try {
    if (!existsSync(path)) return null;
    const raw = readFileSync(path, "utf8");
    if (!raw.trim()) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function detectPluginRoot(env) {
  const fromEnv = env.OMCP_PLUGIN_ROOT;
  if (fromEnv && fromEnv.length > 0) return fromEnv;
  return join(
    homedir(),
    ".copilot",
    "installed-plugins",
    "oh-my-copilot",
    "oh-my-copilot",
  );
}

function detectModelFamily(env) {
  const fromEnv = (env.OMCP_MODEL_FAMILY ?? "").toLowerCase();
  if (fromEnv === "claude" || fromEnv === "gpt") return fromEnv;
  const copilotHome = env.OMCP_HOME ?? join(homedir(), ".copilot");
  const cfg = readJsonSafe(join(copilotHome, "config.json"));
  const model = cfg && typeof cfg.model === "string" ? cfg.model : null;
  if (model) {
    const lower = model.toLowerCase();
    if (lower.startsWith("claude")) return "claude";
    if (lower.startsWith("gpt")) return "gpt";
  }
  return "claude";
}

function readModes(cwd) {
  const data = readJsonSafe(join(cwd, ".omcp", "state", "mode.json"));
  if (!data || !Array.isArray(data.modes)) return "";
  return data.modes
    .filter((m) => typeof m === "string" && m.trim())
    .join(",");
}

function readRalph(cwd) {
  const data = readJsonSafe(join(cwd, ".omcp", "state", "ralph.json"));
  if (!data) return "";
  const iter = Number.isFinite(data.iter) ? data.iter : null;
  const max = Number.isFinite(data.max) ? data.max : null;
  if (iter === null && max === null) return "";
  return `${iter ?? ""}/${max ?? ""}`;
}

function readTeam(cwd) {
  const data = readJsonSafe(join(cwd, ".omcp", "state", "team.json"));
  if (!data) return "";
  const done = Number.isFinite(data.agentsDone) ? data.agentsDone : null;
  const spawned = Number.isFinite(data.spawned) ? data.spawned : null;
  if (done === null && spawned === null) return "";
  return `${done ?? ""}/${spawned ?? ""}`;
}

function readNote(cwd) {
  try {
    const file = join(cwd, ".omcp", "notepad.md");
    if (!existsSync(file)) return "";
    const raw = readFileSync(file, "utf8");
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      // Strip markdown bullets/heading markers for display.
      const cleaned = trimmed.replace(/^([#>*\-]+\s+)+/, "").trim();
      if (!cleaned) continue;
      if (cleaned.length > NOTE_MAX) {
        return `${cleaned.slice(0, NOTE_MAX - 1)}…`;
      }
      return cleaned;
    }
    return "";
  } catch {
    return "";
  }
}

function buildLine({ family, modes, ralph, team, note }) {
  const parts = ["omcp", family, modes, ralph, team, note];
  return parts.join(" · ");
}

function main() {
  try {
    const env = process.env;
    const cwd = process.cwd();
    // pluginRoot is computed for future-use HUD extensions (skill lookups);
    // we only need its presence semantically.
    void detectPluginRoot(env);
    const family = detectModelFamily(env);
    const modes = readModes(cwd);
    const ralph = readRalph(cwd);
    const team = readTeam(cwd);
    const note = readNote(cwd);
    process.stdout.write(`${buildLine({ family, modes, ralph, team, note })}\n`);
    process.exit(0);
  } catch {
    process.stdout.write("omcp · (status unavailable)\n");
    process.exit(0);
  }
}

main();
