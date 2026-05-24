// Test hook dispatch forms — run with: node scripts/test-hook-dispatch.js
// Tests the exact command forms that Copilot uses on Windows

const { spawnSync } = require('child_process');
const path = require('path');

const omcpPath = path.join(__dirname, '..', 'dist', 'cli', 'omcp.js');
const payload = JSON.stringify({
  hook_event_name: 'Stop',
  session_id: 'test-123',
  timestamp: '2026-05-24T10:00:00.000Z',
  cwd: 'C:\\Temp',
  transcript_path: 'C:\\Temp\\events.jsonl',
  stop_reason: 'end_turn'
});

function run(label, exe, args, input) {
  const r = spawnSync(exe, args, {
    input,
    timeout: 8000,
    encoding: 'utf8'
  });
  const stderrSnip = (r.stderr || '').slice(0, 400);
  const stdoutSnip = (r.stdout || '').slice(0, 200);
  const isEvalStdin = stderrSnip.includes('eval_stdin');
  const isMissing  = stderrSnip.includes('Cannot find module');
  const status = r.status;
  console.log('=== ' + label + ' ===');
  console.log('exe:', exe, '| args[0..2]:', args.slice(0, 3).join(' '));
  console.log('exit:', status, '| eval_stdin_bug:', isEvalStdin, '| missing_module:', isMissing);
  if (stderrSnip) console.log('stderr:', stderrSnip.split('\n')[0]);
  if (stdoutSnip) console.log('stdout:', stdoutSnip.slice(0, 80));
  console.log();
  return { status, isEvalStdin, isMissing, stderr: stderrSnip, stdout: stdoutSnip };
}

const results = [];

// --------------------------------------------------------------------------
// Test 1: Exact current form — Copilot A1e transform produces:
//   command = "node \"abs-path\" hook fire Stop --json"
//   → A1e sets powershell = command
//   → Xer on win32 picks powershell, spawns: pwsh.exe -nop -nol -c <command>
// --------------------------------------------------------------------------
const cmd1 = `node "${omcpPath}" hook fire Stop --json`;
console.log('CMD1:', cmd1);
results.push({ label: 'T1 current (node abs-path via pwsh -c)', ...run(
  'T1: node abs-path via pwsh.exe -nop -nol -c',
  'pwsh.exe',
  ['-nop', '-nol', '-c', cmd1],
  payload
)});

// --------------------------------------------------------------------------
// Test 2: powershell-only field (no bash) — same string, same path through Xer
// No change to the pwsh -c invocation; tests if omitting bash field matters.
// (Spoiler: A1e sets both bash and powershell when command is set, but
//  even powershell-only still goes through pwsh -c on win32.)
// --------------------------------------------------------------------------
results.push({ label: 'T2 same via pwsh -c (confirm path)', ...run(
  'T2: same cmd via pwsh.exe -nop -nol -c',
  'pwsh.exe',
  ['-nop', '-nol', '-c', cmd1],
  payload
)});

// --------------------------------------------------------------------------
// Test 3: cmd /c wrapper
// If settings.json uses: cmd /c "node \"abs-path\" hook fire Stop --json"
// → A1e sets bash=powershell=that string
// → Xer on win32 runs: pwsh.exe -nop -nol -c "cmd /c \"node ...\""
// This is double-wrapped — probably worse, but let's test pwsh calling cmd directly.
// --------------------------------------------------------------------------
const cmd3 = `cmd /c "node \\"${omcpPath}\\" hook fire Stop --json"`;
results.push({ label: 'T3 cmd /c wrapper via pwsh -c', ...run(
  'T3: cmd /c wrapper via pwsh -c',
  'pwsh.exe',
  ['-nop', '-nol', '-c', cmd3],
  payload
)});

// --------------------------------------------------------------------------
// Test 4: pwsh -File wrapper — use a .ps1 that reads stdin and pipes to node
// The settings.json powershell field would be set to the ps1 invocation.
// But Xer always uses -c, never -File. So -File is not achievable via 'command'.
// Test directly to confirm it would work if Copilot supported it.
// --------------------------------------------------------------------------
const wrapperPs1 = path.join(__dirname, 'hook-stop-wrapper.ps1');
const fs = require('fs');
fs.writeFileSync(wrapperPs1, `$j = $input | Out-String\n$j | & node "${omcpPath}" hook fire Stop --json\n`);
results.push({ label: 'T4 pwsh -File wrapper (not achievable via command field)', ...run(
  'T4: pwsh.exe -nop -nol -File wrapper.ps1',
  'pwsh.exe',
  ['-nop', '-nol', '-File', wrapperPs1],
  payload
)});

// --------------------------------------------------------------------------
// Test 5: node directly (no pwsh layer) — baseline
// This tests whether omcp.js itself handles the payload correctly.
// --------------------------------------------------------------------------
results.push({ label: 'T5 node directly (baseline, no pwsh)', ...run(
  'T5: node directly (baseline)',
  'node',
  [omcpPath, 'hook', 'fire', 'Stop', '--json'],
  payload
)});

// --------------------------------------------------------------------------
// Test 6: pwsh -c with single-quoted path (use & operator)
// In pwsh, & is call operator. Single quotes avoid escape issues.
// But path has no spaces so single quotes work.
// --------------------------------------------------------------------------
const cmd6 = `& node '${omcpPath}' hook fire Stop --json`;
results.push({ label: 'T6 pwsh -c with & call operator + single quotes', ...run(
  'T6: pwsh -c "& node \'path\' ..."',
  'pwsh.exe',
  ['-nop', '-nol', '-c', cmd6],
  payload
)});

// --------------------------------------------------------------------------
// Test 7: Write a .cmd batch file and use that as the command
// settings.json: "C:\...\hook-stop.cmd"  (no args needed)
// Copilot A1e sets powershell=bash=".cmd path"
// Xer on win32: pwsh.exe -nop -nol -c "C:\...\hook-stop.cmd"
// pwsh treats a .cmd as a command name — it should invoke cmd.exe for it.
// --------------------------------------------------------------------------
const wrapperCmd = path.join(__dirname, 'hook-stop.cmd');
fs.writeFileSync(wrapperCmd,
  `@echo off\r\n` +
  `node "${omcpPath}" hook fire Stop --json\r\n`
);
const cmd7 = `& "${wrapperCmd}"`;
results.push({ label: 'T7 .cmd batch file via pwsh -c & "path.cmd"', ...run(
  'T7: pwsh -c "& path.cmd" stdin piped',
  'pwsh.exe',
  ['-nop', '-nol', '-c', cmd7],
  payload
)});

// --------------------------------------------------------------------------
// Test 8: Use Start-Process in pwsh to invoke node — stdin via here-string
// This is what a powershell-native command field could use.
// --------------------------------------------------------------------------
const psPayload = payload.replace(/'/g, "''");
const cmd8 = `echo '${psPayload}' | node "${omcpPath}" hook fire Stop --json`;
results.push({ label: 'T8 pwsh -c with echo pipe (avoids stdin pipe from Copilot)', ...run(
  'T8: pwsh -c "echo payload | node ..."',
  'pwsh.exe',
  ['-nop', '-nol', '-c', cmd8],
  payload
)});

// --------------------------------------------------------------------------
// Summary
// --------------------------------------------------------------------------
console.log('========== SUMMARY ==========');
for (const r of results) {
  const verdict = r.status === 0 ? 'PASS' : (r.isEvalStdin ? 'FAIL(eval_stdin)' : 'FAIL(other)');
  console.log(`${verdict.padEnd(20)} | ${r.label}`);
}
