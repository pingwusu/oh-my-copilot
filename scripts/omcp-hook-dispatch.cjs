#!/usr/bin/env node
// omcp-hook-dispatch.cjs — single-arg wrapper for Copilot hook dispatch on Windows.
//
// Problem: Copilot 1.0.52-4 on Windows dispatches hook commands via
//   pwsh.exe -nop -nol -c "<command>"
// with the JSON payload piped to pwsh's stdin. When the command is a
// multi-arg string like:
//   node "C:\...\dist\cli\omcp.js" hook fire PostToolUse --json
// pwsh's -c argument parser can corrupt the argument list on pathological
// inputs (large JSON payloads, embedded quotes in tool_result.text_result_for_llm),
// causing Node to enter eval-stdin mode and interpret the piped JSON as
// TypeScript source — exiting with SyntaxError + code 1.
//
// Fix: Copilot dispatches this single-arg form:
//   node "<abs>/scripts/omcp-hook-dispatch.cjs" <event>
// This wrapper receives the event name as argv[2] and re-dispatches to omcp.js
// via Node's native child_process.spawnSync — which handles argument quoting
// internally without going through any shell. stdin/stdout/stderr are inherited
// so Copilot's JSON pipe flows through unchanged.

'use strict';

const { spawnSync } = require('node:child_process');
const path = require('node:path');

const event = process.argv[2];
if (!event) {
  process.stderr.write('omcp-hook-dispatch: missing event name (argv[2])\n');
  process.exit(2);
}

const omcpJs = path.resolve(__dirname, '..', 'dist', 'cli', 'omcp.js');
const result = spawnSync(
  process.execPath,
  [omcpJs, 'hook', 'fire', event, '--json'],
  { stdio: ['inherit', 'inherit', 'inherit'] },
);

process.exit(result.status ?? 1);
