// Test pwsh quoting mechanics to understand why eval_stdin is triggered
// in the live Copilot session but not in bench tests

const { spawnSync } = require('child_process');
const path = require('path');
const omcpPath = path.resolve(__dirname, '..', 'dist', 'cli', 'omcp.js');
const payload = JSON.stringify({
  hook_event_name: 'Stop', session_id: 'x',
  timestamp: '2026-05-24T10:00:00Z',
  cwd: 'C:\\Temp', stop_reason: 'end_turn'
});

function run(label, cmd, input) {
  const r = spawnSync('pwsh.exe', ['-nop', '-nol', '-c', cmd], {
    input: input || '',
    encoding: 'utf8',
    timeout: 6000,
    env: process.env
  });
  const stderr0 = (r.stderr || '').split('\n')[0];
  const isEvalStdin = (r.stderr || '').includes('eval_stdin');
  const pass = r.status === 0;
  console.log(`[${pass ? 'PASS' : isEvalStdin ? 'FAIL(eval_stdin)' : 'FAIL'}] ${label}`);
  if (!pass) console.log(`  stderr: ${stderr0}`);
  if (r.stdout && r.stdout.trim()) console.log(`  stdout: ${r.stdout.trim().slice(0, 80)}`);
  return { pass, isEvalStdin, stdout: r.stdout, stderr: r.stderr };
}

// ---- Baseline: confirm abs-path command works from bench -------------------
run('BASELINE: node abs-path via pwsh -c (double-quote path)',
    `node "${omcpPath}" hook fire Stop --json`, payload);

// ---- What the earlier test showed: -e with JSON chars lost arg[1] ----------
// Command: node -e "console.log(JSON.stringify(process.argv))"
const cmd_json_argv = 'node -e "console.log(JSON.stringify(process.argv))"';
const r_json = spawnSync('pwsh.exe', ['-nop', '-nol', '-c', cmd_json_argv], {
  encoding: 'utf8', timeout: 5000, env: process.env
});
console.log('\nTest: node -e "console.log(JSON.stringify(process.argv))"');
console.log('  stdout:', r_json.stdout.trim());
console.log('  stderr:', r_json.stderr.trim().slice(0, 100));

// ---- Reproduce the exact spawnSync that Node 24.16.0 in copilot.exe would use
// The key question: does Node 24.16.0 quote the -c argument differently?
// Specifically: Node uses the Windows CreateProcess API which has different
// argument escaping rules. Let's test what the actual arg string looks like.

// Node's child_process.spawn on Windows uses the WindowsVerbatimArguments
// option or applies its own escaping. For pwsh.exe, the args array
// ['-nop', '-nol', '-c', commandString] gets assembled into a cmdline.
// The commandString itself contains: node "abs-path" hook fire Stop --json
// Node will escape this for CreateProcess, which means wrapping in quotes
// if it contains spaces, and escaping inner quotes with backslash.
// So the actual CreateProcess cmdline becomes:
//   pwsh.exe -nop -nol -c "node \"abs-path\" hook fire Stop --json"
// Note: the abs-path already has \" from JSON encoding of settings.json.
// When pwsh receives -c with value: node "abs-path" hook fire Stop --json
// (after CreateProcess unescaping) — pwsh should execute it correctly.

// BUT: if Node 24.16.0 changes the Windows arg escaping behavior...
// Let's check if using windowsVerbatimArguments changes behavior:

const { spawn } = require('child_process');
const r_verb = spawnSync('pwsh.exe', ['-nop', '-nol', '-c',
  `node "${omcpPath}" hook fire Stop --json`], {
  input: payload, encoding: 'utf8', timeout: 8000, env: process.env,
  windowsVerbatimArguments: true
});
console.log('\nTest: windowsVerbatimArguments=true');
console.log('  exit:', r_verb.status);
console.log('  stderr:', r_verb.stderr.trim().slice(0, 100));
console.log('  stdout:', r_verb.stdout.trim().slice(0, 60));

// Without verbatim (Node's default escaping):
const r_noVerb = spawnSync('pwsh.exe', ['-nop', '-nol', '-c',
  `node "${omcpPath}" hook fire Stop --json`], {
  input: payload, encoding: 'utf8', timeout: 8000, env: process.env,
  windowsVerbatimArguments: false
});
console.log('\nTest: windowsVerbatimArguments=false (default)');
console.log('  exit:', r_noVerb.status);
console.log('  stderr:', r_noVerb.stderr.trim().slice(0, 100));
console.log('  stdout:', r_noVerb.stdout.trim().slice(0, 60));

// ---- The real test: what does pwsh -c actually receive? -------------------
// Use cmd.exe to echo what pwsh gets as its -c argument
// This tells us if the quoting survives the CreateProcess boundary

// Echo argv via a helper node process
const echoCmd = `node -e "process.stdout.write(JSON.stringify(process.argv))" "${omcpPath}" hook fire Stop --json`;
const r_echo = spawnSync('pwsh.exe', ['-nop', '-nol', '-c', echoCmd], {
  encoding: 'utf8', timeout: 5000, env: process.env
});
console.log('\nTest: echo node argv via node -e (with abs path as arg):');
console.log('  stdout:', r_echo.stdout.trim());
console.log('  stderr:', r_echo.stderr.trim().slice(0, 100));

// ---- Test: does the path ITSELF survive if we print argv[1]? ---------------
const printArgv1 = `node -e "process.stdout.write(process.argv[1] || 'MISSING')" "${omcpPath}"`;
const r_argv1 = spawnSync('pwsh.exe', ['-nop', '-nol', '-c', printArgv1], {
  encoding: 'utf8', timeout: 5000, env: process.env
});
console.log('\nTest: print process.argv[1] (should be abs-path):');
console.log('  stdout:', r_argv1.stdout.trim());
console.log('  stderr:', r_argv1.stderr.trim().slice(0, 100));

// ---- KEY TEST: Simulate copilot.exe's Node 24.16.0 behavior ---------------
// copilot.exe's embedded Node may use a different spawn implementation
// Specifically: the SEA runtime might change how CreateProcess cmdline is built
// One known difference: Node 24.16+ changes Windows argument quoting for paths
// with trailing backslashes. omcpPath ends with .js (no trailing backslash)
// so that shouldn't matter.
//
// Another difference: the Qj() proxy env may cause issues with how
// child_process.spawn serializes the env object via Reflect.ownKeys(proxy).
// If the proxy ownKeys returns keys in a different order or misses system vars,
// the child process might not get PATH.

// Simulate: what if PATH is lowercase 'path' on this system?
console.log('\nActual PATH key case:', Object.keys(process.env).find(k => k.toLowerCase() === 'path'));
console.log('PATH first 80:', (process.env.PATH || process.env.Path || '').slice(0, 80));

console.log('\nDone.');
