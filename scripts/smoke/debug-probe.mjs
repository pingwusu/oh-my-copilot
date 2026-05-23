#!/usr/bin/env node
// Diagnostic probe — captures the full execution context Copilot CLI hands a
// hook command, then exits 0.
//
// Writes JSONL lines to BOTH:
//   - {os.tmpdir()}/omcp-debug-probe.log     (always writable)
//   - {homedir()}/.copilot/omcp-debug-probe.log (collocated with smoke output)
// so that if homedir resolution is the failure cause we still see something.
//
// Invocation:  node debug-probe.mjs <kind> [--emit-modifiedresult]
//   <kind>                  free-form label (we use pre-camel / post-camel / ...)
//   --emit-modifiedresult   also write the modifiedResult JSON to stdout
//                           (so we can test whether stdout schema is what
//                           causes Copilot to mark the hook failed)
//
// IMPORTANT: this script logs *before* attempting stdin reads. The previous
// version blocked in readFileSync(0) when Copilot doesn't close stdin, which
// caused the hook to time out before ever writing a log entry. Logging
// first guarantees the start-of-execution breadcrumb survives a deadlock.

import { appendFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

const kind = process.argv[2] ?? "unknown";
const emitModifiedResult = process.argv.includes("--emit-modifiedresult");

const candidates = [
  join(tmpdir(), "omcp-debug-probe.log"),
  join(homedir(), ".copilot", "omcp-debug-probe.log"),
];

function writeAll(line) {
  for (const path of candidates) {
    try {
      appendFileSync(path, line);
    } catch {
      // best-effort only — we still want to keep going
    }
  }
}

// ─── Phase 1: log execution context BEFORE any blocking I/O ──────────────
const initialEntry = {
  ts: new Date().toISOString(),
  kind,
  phase: "start",
  emitModifiedResult,
  argv: process.argv,
  cwd: process.cwd(),
  pid: process.pid,
  ppid: process.ppid,
  platform: process.platform,
  nodeVersion: process.version,
  homedir: homedir(),
  env: {
    PATH_head: (process.env.PATH ?? "").slice(0, 200),
    USERPROFILE: process.env.USERPROFILE,
    HOMEDRIVE: process.env.HOMEDRIVE,
    HOMEPATH: process.env.HOMEPATH,
    TEMP: process.env.TEMP,
    TMPDIR: process.env.TMPDIR,
    SHELL: process.env.SHELL,
    keyCount: Object.keys(process.env).length,
  },
};
writeAll(`${JSON.stringify(initialEntry)}\n`);

// ─── Phase 2: emit modifiedResult on stdout (test stdout-schema theory) ──
// Do this BEFORE the stdin read so even if stdin deadlocks, we have proof
// stdout was attempted.
if (emitModifiedResult) {
  try {
    process.stdout.write(
      `${JSON.stringify({
        modifiedResult: "CANARY_REPLACEMENT_PAYLOAD_KESTREL_42",
        __omcpSmoke: true,
      })}\n`,
    );
    writeAll(
      `${JSON.stringify({ ts: new Date().toISOString(), kind, phase: "stdout-written" })}\n`,
    );
  } catch (err) {
    writeAll(
      `${JSON.stringify({ ts: new Date().toISOString(), kind, phase: "stdout-error", error: String(err) })}\n`,
    );
  }
}

// ─── Phase 3: try to drain stdin asynchronously with a hard ceiling ──────
// stream.read() is non-blocking. We collect chunks until either:
//   - 'end' event fires (Copilot closed stdin)
//   - 250ms elapsed (Copilot is keeping stdin open — give up rather than hang)
// Then we log whatever we got and exit.
let stdinBuf = "";
let stdinFinished = false;
let stdinError = null;

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  stdinBuf += chunk;
  if (stdinBuf.length > 8000) stdinBuf = stdinBuf.slice(0, 8000);
});
process.stdin.on("end", () => {
  stdinFinished = true;
});
process.stdin.on("error", (err) => {
  stdinError = String(err);
});

const timer = setTimeout(() => {
  writeAll(
    `${JSON.stringify({
      ts: new Date().toISOString(),
      kind,
      phase: "stdin-timeout",
      stdinFinished,
      stdinError,
      stdinLength: stdinBuf.length,
      stdinHead: stdinBuf.slice(0, 1000),
    })}\n`,
  );
  process.exit(0);
}, 250);

process.stdin.on("end", () => {
  clearTimeout(timer);
  writeAll(
    `${JSON.stringify({
      ts: new Date().toISOString(),
      kind,
      phase: "stdin-end",
      stdinError,
      stdinLength: stdinBuf.length,
      stdinHead: stdinBuf.slice(0, 1000),
    })}\n`,
  );
  process.exit(0);
});
