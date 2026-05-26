# Phase 4 Integration via `omcp team` — Live Attestation

**Date**: 2026-05-26
**Mode**: live (real Copilot CLI)

## Environment

omcp v2.2.x — multi-worker live e2e through the production `omcp team` verb.
Harness: `scripts/run-live-e2e-team-via-cli.mjs` (operator-driven).
Trigger: `node dist/cli/omcp.js team 2:executor "<task>"` in scratch cwd `C:\Users\RUNJIA~1\AppData\Local\Temp\omcp-live-e2e-cli-1K4LFJ`.
Spawn path: r2-local v2.2 dist `runTeam` → detached `spawn(node, [npm-shim-script, ...])` via `resolveNpmShimScript` helper (bypasses cmd.exe wrapper) + stdio redirected to per-worker log files (replaces `stdio: "ignore"` which caused Copilot CLI to fail silently on Windows under detached + /dev/null stdio).
Copilot CLI: GitHub Copilot CLI 1.0.55-0.

## Pre-condition

- Fresh scratch dir at C:\Users\RUNJIA~1\AppData\Local\Temp\omcp-live-e2e-cli-1K4LFJ (mkdtempSync per-run).
- Copilot CLI authenticated under current user.
- r2 dist/cli/omcp.js built at 2026-05-26T03:09:27.746Z (carries the team.ts detached-spawn fix + resolveNpmShimScript helper).
- omcp wrapper staged in scratch + prepended to worker PATH so workers can call `omcp team-ack <sid> <idx> --status completed` (v2.2 ack-with-status path).

## Trigger

Phase A. Spawn `omcp team 2:executor "<task>"` via the production code path. team.ts now uses the npm-shim resolver to spawn `node <npm-loader.js>` directly + redirects stdout/stderr to per-worker log files.
Phase B. Poll `.omcp/state/team/<sid>/` for ack JSONs + scratch for evidence files every 10s. Per-worker budget: workers should complete the trivial task (write file + ack) in ~30-60s. Total budget: 5 min.
Phase C. Capture all artifacts: ack JSONs, pidfiles, evidence files, per-worker logs.
Phase D. Call `runTeamCollect(SID)` to merge shards + transition phase. Verify every worker's status field in TeamState transitions from 'pending' to 'completed' via the --status flag.

## Output

```
harness scratch=C:\Users\RUNJIA~1\AppData\Local\Temp\omcp-live-e2e-cli-1K4LFJ
worker count=2
OMCP_CLI=C:\Users\runjiashi\oh-my-copilot-r2\dist\cli\omcp.js
host=CPC-runji-25LFF
start=2026-05-26T03:17:25.825Z
spawn mode: `omcp team` direct (production code path)
phaseA: omcp team launched (stdout=omcp team launched (detached): 2 worker(s) |   session: 6c5efa36-c332-4907-b84a-26037680795f |   logs:    C:\Users\RUNJIA~1\AppData\Local\Temp\omcp-live-e2e-cli-1K4LFJ\.omcp\state\sessions\6c5efa36-c332-4907-b84a-26037680795f)
phaseA: session id=6c5efa36-c332-4907-b84a-26037680795f
phaseB: polling started at t+0s
phaseB: all acks+evidence present at t+30s; phase=executing
phaseC: capture summary
  ack files: 2/2
  pidfiles: 2/2
  evidence files: 2/2
  worker logs (from team.ts log redirection fix): 2/2
  worker-1-ack.json: {"workerIndex":1,"ackedAt":"2026-05-26T03:17:53.388Z","status":"completed"}
  worker-2-ack.json: {"workerIndex":2,"ackedAt":"2026-05-26T03:17:53.436Z","status":"completed"}
phaseD: pre-collect SIGTERM sent to 2 worker pid(s); 2s settle
phaseD: runTeamCollect finalPhase='failed'; allShardsPresent=false; hasDeadWithoutShard=true
phaseD: final worker statuses: worker-1=completed,worker-2=completed
phaseD: all workers status=completed via --status flag: true
verdict-gates: spawn=true(2/2) evidence=true(2/2) acks=true(2/2) workerLogs=true(2/2) terminalPhase=true(failed) statusUpdated=true
overall: PASS
```

Key invariants verified by this trace:
- team.ts detached-spawn fix: 2/2 workers spawn + complete via the production `omcp team` verb (vs prior silent-fail behavior with detached + stdio:"ignore" + .cmd wrapper).
- Per-worker log capture: 2/2 log files in `.omcp/state/sessions/<sid>/` populated with real Copilot stdout (replaces /dev/null stdio).
- v2.2 ack-with-status flag: all workers' status transitioned to 'completed' via --status completed; v2.2 N+2 (Story 7) atomic worker status update exercised live.
- resolveNpmShimScript helper: parses copilot.cmd to extract the underlying `@github/copilot/npm-loader.js` path; unit-tested in `src/__tests__/resolve-executable.test.ts`.

## Verdict

PASS — live e2e via production code path. All 2 real Copilot CLI workers spawned through the v2.2 `omcp team` verb, produced evidence files, acked with --status completed, and the runTeamCollect transition + worker status updates landed correctly. This validates BOTH the team.ts detached-spawn fix AND the v2.2 ack-with-status path simultaneously.

## References

- src/cli/commands/team.ts (team.ts detached-spawn fix)
- src/runtime/resolve-executable.ts (resolveNpmShimScript helper)
- src/__tests__/resolve-executable.test.ts (helper unit tests)
- src/cli/commands/team-ack.ts (--status flag wiring)
- docs/smoke/omcp-team-parity/phase4-integration.md (parallel-spawn variant)
- docs/smoke/omcp-team-parity/ipc-mesh.md (IPC mesh live smoke)
