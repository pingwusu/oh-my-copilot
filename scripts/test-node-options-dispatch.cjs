// Test whether NODE_OPTIONS set in the environment triggers eval_stdin mode
// Focus: reproduce the exact condition that causes Node to enter eval_stdin
// when invoked via pwsh -c "node abs-path hook fire Stop --json"

const { spawnSync } = require('child_process');
const path = require('path');

const omcpPath = path.resolve(__dirname, '..', 'dist', 'cli', 'omcp.js');
const payload = JSON.stringify({
  hook_event_name: 'Stop',
  session_id: 'test-123',
  timestamp: '2026-05-24T10:00:00.000Z',
  cwd: 'C:\\Temp',
  transcript_path: 'C:\\Temp\\events.jsonl',
  stop_reason: 'end_turn'
});

const cmd = `node "${omcpPath}" hook fire Stop --json`;

function test(label, extraEnv) {
  const env = { ...process.env, ...extraEnv };
  const r = spawnSync('pwsh.exe', ['-nop', '-nol', '-c', cmd], {
    input: payload,
    timeout: 8000,
    encoding: 'utf8',
    env
  });
  const stderr = (r.stderr || '').slice(0, 300);
  const isEvalStdin = stderr.includes('eval_stdin');
  const isPass = r.status === 0;
  let diagnosis = isPass ? 'PASS' :
    isEvalStdin ? 'FAIL(eval_stdin_BUG_REPRODUCED)' :
    `FAIL(exit=${r.status}) ${stderr.split('\n')[0].slice(0,80)}`;
  console.log(`[${(isPass?'PASS':'FAIL').padEnd(6)}] ${label}`);
  if (!isPass) {
    console.log(`       diagnosis: ${diagnosis}`);
    if (isEvalStdin) console.log(`       EVAL_STDIN BUG REPRODUCED`);
    console.log(`       stderr[0]: ${stderr.split('\n')[0]}`);
  }
  return { status: r.status, isEvalStdin };
}

console.log(`omcpPath: ${omcpPath}`);
console.log(`cmd: ${cmd}`);
console.log('');

// Baseline
test('BASELINE: no extra env', {});

// Test NODE_OPTIONS variants that could be set by Copilot's embedded Node.js
// Node 24 propagates certain flags via NODE_OPTIONS to children
test('NODE_OPTIONS=--experimental-strip-types', {
  NODE_OPTIONS: '--experimental-strip-types'
});
test('NODE_OPTIONS=--experimental-transform-types', {
  NODE_OPTIONS: '--experimental-transform-types'
});
test('NODE_OPTIONS=--strip-types', {
  NODE_OPTIONS: '--strip-types'
});
test('NODE_OPTIONS=--input-type=module', {
  NODE_OPTIONS: '--input-type=module'
});
test('NODE_OPTIONS=--input-type=commonjs', {
  NODE_OPTIONS: '--input-type=commonjs'
});

// What if Copilot's embedded Node (v24.16.0) propagates TypeScript stripping?
// Node 24.16.0 added --strip-types as stable. Check if it propagates.
test('NODE_OPTIONS=--strip-types --no-warnings', {
  NODE_OPTIONS: '--strip-types --no-warnings'
});

// Test with FORCE_COLOR or other env vars that might affect behavior
test('NO_COLOR=1', { NO_COLOR: '1' });
test('FORCE_COLOR=0', { FORCE_COLOR: '0' });

// What if the copilot native process sets execArgv that get passed?
// Simulate: copilot.exe runs with --strip-types in execArgv
// Node propagates execArgv in NODE_OPTIONS for some cases
// Actually: Node does NOT propagate execArgv to children via NODE_OPTIONS
// UNLESS using permission model. Strip-types is not a permission flag.
// But check: does copilot.exe set NODE_OPTIONS explicitly?

// The real question: what is different in the live session?
// Hypothesis: Copilot's internal child_process spawn uses a different spawn
// mechanism than what we're testing. Specifically, in the live session
// the hook is called from the copilot.exe embedded Node runtime (v24.16.0),
// which may have different spawn behavior than system Node v24.14.1.

// Test: what node version does the hook subprocess actually get?
const checkNodeVer = spawnSync('pwsh.exe', ['-nop', '-nol', '-c', 'node --version'], {
  env: process.env, timeout: 5000, encoding: 'utf8'
});
console.log('\nNode version in pwsh child:', checkNodeVer.stdout.trim());

// Test direct reproduction: does the eval_stdin error appear when
// Node is invoked with NO positional arguments but stdin piped?
const r2 = spawnSync('node', [], {
  input: payload,
  timeout: 3000,
  encoding: 'utf8',
  env: process.env
});
console.log('\nDirect "node" with JSON stdin (no args):');
console.log('  exit:', r2.status, '| eval_stdin:', (r2.stderr||'').includes('eval_stdin'));
console.log('  stderr[0]:', (r2.stderr||'').split('\n').find(l => l.includes('SyntaxError') || l.includes('eval_stdin')) || '(none)');

// Test: pwsh -c with NO quotes around path (to see if quote stripping occurs)
const cmdNoQuote = `node ${omcpPath} hook fire Stop --json`;
const r3 = spawnSync('pwsh.exe', ['-nop', '-nol', '-c', cmdNoQuote], {
  input: payload, timeout: 8000, encoding: 'utf8',
  env: process.env
});
console.log('\nTest: no quotes around path:');
console.log('  exit:', r3.status, '| eval_stdin:', (r3.stderr||'').includes('eval_stdin'));
console.log('  stderr[0]:', (r3.stderr||'').split('\n')[0]);

console.log('\nDone.');
