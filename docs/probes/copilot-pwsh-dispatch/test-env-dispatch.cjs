// Test hook dispatch with different environment configurations
// to reproduce/isolate the eval_stdin bug seen in live Copilot sessions

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
console.log('Command:', cmd);
console.log('omcpPath exists:', require('fs').existsSync(omcpPath));
console.log('');

function test(label, opts) {
  const r = spawnSync('pwsh.exe', ['-nop', '-nol', '-c', cmd], {
    input: payload,
    timeout: 8000,
    encoding: 'utf8',
    ...opts
  });
  const stderr = (r.stderr || '').slice(0, 200);
  const isEvalStdin = stderr.includes('eval_stdin');
  const isMissing = stderr.includes('Cannot find module');
  const isNotRecognized = stderr.includes('not recognized');
  let diagnosis = 'UNKNOWN';
  if (r.status === 0) diagnosis = 'PASS';
  else if (isEvalStdin) diagnosis = 'FAIL(eval_stdin_bug)';
  else if (isMissing) diagnosis = 'FAIL(module_not_found)';
  else if (isNotRecognized) diagnosis = 'FAIL(node_not_on_path)';
  else diagnosis = `FAIL(exit=${r.status})`;

  console.log(`[${diagnosis.padEnd(28)}] ${label}`);
  if (r.status !== 0) {
    console.log('  stderr:', stderr.split('\n')[0]);
  }
  return { status: r.status, isEvalStdin, isMissing, isNotRecognized, stderr };
}

// -----------------------------------------------------------------------
// A: Full env (what our working spawnSync test used earlier)
// -----------------------------------------------------------------------
test('A: Full env (process.env)', { env: process.env });

// -----------------------------------------------------------------------
// B: Minimal env — only what Copilot's Qj proxy would pass
// (PATH + SystemRoot + USERPROFILE + TEMP for pwsh to work)
// -----------------------------------------------------------------------
const minEnv = {
  COPILOT_CLI: '1',
  POWERSHELL_UPDATECHECK: 'Off',
  PATH: process.env.PATH,
  SystemRoot: process.env.SystemRoot,
  SystemDrive: process.env.SystemDrive,
  USERPROFILE: process.env.USERPROFILE,
  LOCALAPPDATA: process.env.LOCALAPPDATA,
  APPDATA: process.env.APPDATA,
  TEMP: process.env.TEMP,
  TMP: process.env.TMP,
  HOMEDRIVE: process.env.HOMEDRIVE,
  HOMEPATH: process.env.HOMEPATH,
  COMPUTERNAME: process.env.COMPUTERNAME,
  USERNAME: process.env.USERNAME,
  OS: process.env.OS,
  PROCESSOR_ARCHITECTURE: process.env.PROCESSOR_ARCHITECTURE,
  PSModulePath: process.env.PSModulePath,
  NODE_ENV: 'production',
};
test('B: Minimal env (Copilot-like)', { env: minEnv });

// -----------------------------------------------------------------------
// C: Minimal env WITHOUT PSModulePath (to see if pwsh startup breaks)
// -----------------------------------------------------------------------
const minEnvNoPs = { ...minEnv };
delete minEnvNoPs.PSModulePath;
test('C: Minimal env without PSModulePath', { env: minEnvNoPs });

// -----------------------------------------------------------------------
// D: Minimal env with absolute node path in command
// -----------------------------------------------------------------------
// Find the system node path
const { execFileSync } = require('child_process');
let nodePath = 'node';
try {
  nodePath = execFileSync('where', ['node'], { encoding: 'utf8' }).split('\n')[0].trim();
} catch(e) {}
console.log('\nSystem node path:', nodePath);
const cmdAbsNode = `& "${nodePath}" "${omcpPath}" hook fire Stop --json`;
const r4 = spawnSync('pwsh.exe', ['-nop', '-nol', '-c', cmdAbsNode], {
  input: payload, timeout: 8000, encoding: 'utf8',
  env: minEnv
});
const d4 = (r4.status === 0) ? 'PASS' : (r4.stderr||'').includes('eval_stdin') ? 'FAIL(eval_stdin_bug)' : `FAIL(${r4.status})`;
console.log(`[${ d4.padEnd(28)}] D: Minimal env + abs node path + & call operator`);
if (r4.status !== 0) console.log('  stderr:', (r4.stderr||'').split('\n')[0]);

// -----------------------------------------------------------------------
// E: Direct node invocation (no pwsh layer) with minimal env
// -----------------------------------------------------------------------
const r5 = spawnSync(nodePath, [omcpPath, 'hook', 'fire', 'Stop', '--json'], {
  input: payload, timeout: 8000, encoding: 'utf8',
  env: minEnv
});
const d5 = r5.status === 0 ? 'PASS' : `FAIL(${r5.status})`;
console.log(`[${ d5.padEnd(28)}] E: Direct node (no pwsh), minimal env`);
if (r5.status !== 0) console.log('  stderr:', (r5.stderr||'').split('\n')[0]);

// -----------------------------------------------------------------------
// F: Test what happens when NODE_OPTIONS contains --input-type=module
//    (could be set by some Node version managers or Copilot itself)
// -----------------------------------------------------------------------
const envWithNodeOpts = { ...minEnv, NODE_OPTIONS: '--input-type=module' };
test('F: With NODE_OPTIONS=--input-type=module', { env: envWithNodeOpts });

// -----------------------------------------------------------------------
// G: Test with NODE_OPTIONS containing experimental-strip-types
//    (Node 24 default behavior flag)
// -----------------------------------------------------------------------
const envStripTypes = { ...minEnv, NODE_OPTIONS: '--experimental-strip-types' };
test('G: With NODE_OPTIONS=--experimental-strip-types', { env: envStripTypes });

console.log('\nDone.');
