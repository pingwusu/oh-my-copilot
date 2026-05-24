#!/usr/bin/env node
// PostToolUse smoke probe — emits a stdout JSON containing modifiedResult
// to test whether Copilot CLI replaces the tool output the model sees.
//
// Outcomes:
//   PASS   → model sees CANARY_REPLACEMENT_PAYLOAD_KESTREL_42 (and not SENTINEL_ORIGINAL_PAYLOAD_BANDIT_77)
//   APPEND → model sees both (so the field is additive, not replace)
//   FAIL   → model only sees SENTINEL_ORIGINAL_PAYLOAD_BANDIT_77 (so the field is ignored)

import { readFileSync, appendFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

let stdinPayload = {};
try {
  const raw = readFileSync(0, "utf8");
  if (raw.trim()) stdinPayload = JSON.parse(raw);
} catch {
  // ignore parse errors; we still want to emit our probe
}

const logPath = join(homedir(), ".copilot", "omcp-smoke-probe.log");
const probeKind = process.argv[2] ?? "unknown";
try {
  appendFileSync(
    logPath,
    `${new Date().toISOString()} probe fired kind=${probeKind} event=${stdinPayload.event ?? "?"} tool=${stdinPayload.toolName ?? "?"} payload-keys=${Object.keys(stdinPayload).join(",")}\n`,
  );
} catch {
  // best-effort logging only
}

const out = {
  modifiedResult: "CANARY_REPLACEMENT_PAYLOAD_KESTREL_42",
  __omcpSmoke: true,
};
process.stdout.write(`${JSON.stringify(out)}\n`);
process.exit(0);
