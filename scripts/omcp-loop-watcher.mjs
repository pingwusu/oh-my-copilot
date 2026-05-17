#!/usr/bin/env node
// omcp loop watcher — background daemon that polls .omcp/state/loop-queue.json
// for due entries and spawns `copilot -p "<prompt>" --allow-all-tools` for each.
//
// Run via:
//   node scripts/omcp-loop-watcher.mjs           # foreground, prints heartbeats
//   node scripts/omcp-loop-watcher.mjs --quiet   # suppress heartbeats
//
// Honors:
//   OMCP_LOOP_QUEUE  override queue file path
//   OMCP_LOOP_POLL_MS  override poll interval (default 5000)
//   OMCP_DISABLE=1   exit immediately

import { spawn } from "node:child_process";
import {
  existsSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

if (process.env.OMCP_DISABLE === "1" || process.env.DISABLE_OMCP === "1") {
  process.exit(0);
}

const QUEUE =
  process.env.OMCP_LOOP_QUEUE ??
  join(process.cwd(), ".omcp", "state", "loop-queue.json");
const POLL_MS = Number(process.env.OMCP_LOOP_POLL_MS ?? "5000");
const QUIET = process.argv.includes("--quiet");

function load() {
  if (!existsSync(QUEUE)) return { entries: [] };
  try {
    return JSON.parse(readFileSync(QUEUE, "utf8"));
  } catch {
    return { entries: [] };
  }
}

function save(q) {
  const tmp = `${QUEUE}.tmp`;
  writeFileSync(tmp, JSON.stringify(q, null, 2));
  renameSync(tmp, QUEUE);
}

function fireEntry(entry) {
  const args = ["-p", entry.prompt, "--allow-all-tools"];
  const child = spawn("copilot", args, {
    stdio: QUIET ? "ignore" : "inherit",
    shell: false,
    detached: true,
  });
  child.unref();
}

function tick() {
  const now = new Date();
  const q = load();
  let advanced = 0;
  for (const e of q.entries) {
    if (!e.active) continue;
    if (new Date(e.nextFireAt) > now) continue;
    fireEntry(e);
    e.lastFiredAt = now.toISOString();
    e.nextFireAt = new Date(now.getTime() + e.intervalMs).toISOString();
    e.fireCount = (e.fireCount ?? 0) + 1;
    advanced++;
  }
  if (advanced > 0) save(q);
  if (!QUIET) {
    process.stdout.write(
      `omcp-loop-watcher: ${now.toISOString()} | fired=${advanced} | total=${q.entries.length}\n`,
    );
  }
}

let stopping = false;
process.on("SIGINT", () => {
  stopping = true;
});
process.on("SIGTERM", () => {
  stopping = true;
});

if (!existsSync(dirname(QUEUE))) {
  // ensure queue dir exists so first writer doesn't race
  try {
    writeFileSync(QUEUE, JSON.stringify({ entries: [] }, null, 2));
  } catch {
    /* ignore */
  }
}

(async function main() {
  while (!stopping) {
    try {
      tick();
    } catch (err) {
      process.stderr.write(`omcp-loop-watcher: ${err.message}\n`);
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
  process.exit(0);
})();
