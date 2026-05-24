# L1.0 Probe: hook dispatch format root cause

**Date**: 2026-05-24 (post-v1.0.0)
**Goal**: Understand why 12 of 13 hook events failed with "code 1" in Phase A smoke while Stop succeeded.

## Probe findings

### Finding 1 — all 13 hook entries use identical bare command form

`~/.copilot/settings.json` shows all 13 events have the same shape:
```json
{
  "matcher": "*",
  "hooks": [{
    "type": "command",
    "command": "omcp hook fire <event> --json",
    "timeout": 5,
    "__omcp": true
  }]
}
```

Verified across Stop, PostToolUse, UserPromptSubmit, SessionStart, SubagentStop, subagentStart. Stop is NOT special — same command string as the failing events.

### Finding 2 — Phase A log: 42 PostToolUse failures, 0 Stop failures

`~/.copilot/logs/process-1779562636520-15460.log`:
- `42 postToolUse hook execution failed`
- `12 generic "Hook execution failed"` (un-prefixed; likely sessionStart/userPromptSubmit firing very early before session id was logged)
- `0 Stop-tagged failures`

Yet the smoke completed successfully (PRD lifecycle, allComplete, exit 0) — proving Stop hook DID fire and DID run omcp's persistent-mode logic correctly.

### Finding 3 — root cause hypothesis (from Lane 1 trace)

The "code 1" stack trace from the log:
```
[stdin]:1
{"hook_event_name":"PostToolUse", ...}
                  ^
SyntaxError: Unexpected token ':'
    at node:internal/main/eval_stdin:51:5
```

The frame `node:internal/main/eval_stdin` indicates Node was invoked **without a script path**, treating stdin as TypeScript source code. This happens when Copilot's pwsh hook executor dispatches `omcp hook fire ...` in a way that the shim layer (omcp.ps1 or omcp.cmd) fails to properly forward the script path argument to Node.

PostToolUse fails consistently because its JSON payload includes large `tool_result.text_result_for_llm` strings; Stop succeeds (probably) because its much smaller payload doesn't trigger whatever buffer/parse pathway is broken.

### Finding 4 — omc's canonical hook command form

`src/hooks/setup/index.ts:166` (omc reference):
```ts
hook.command = `node "$CLAUDE_PLUGIN_ROOT"/scripts/run.cjs "$CLAUDE_PLUGIN_ROOT"/scripts/${m[1]}${m[2]}`;
```

omc **always** uses the explicit `node <absolute path> args` form. It never uses a bare command name. This bypasses:
- PATH/PATHEXT resolution issues on Windows
- npm-shim layer (`.cmd`, `.ps1`, extensionless wrappers)
- Node's eval-stdin mode (because there's a definite script path argument)
- Cross-platform shim quirks

This is the proven-working pattern. omcp should mirror it.

## Fix mechanics (L1.1)

In `src/runtime/copilot-config.ts`:

1. The existing `resolveDefaultOmcpBin(opts)` already has the "absolute path fallback" path (Phase B work). It returns `node "<absolute-path-to-dist/cli/omcp.js>"` when omcp is NOT on PATH.

2. **Change**: For hook commands specifically, always use the absolute-path form, regardless of PATH availability. The bare `omcp` form is convenient for the user-facing CLI (e.g., `omcp doctor`) but unsafe for Copilot's hook dispatch chain.

3. Concretely: modify `mergeCopilotHooks` (or introduce a hook-specific path resolver) so the hook command is always `node "<abs>" hook fire <event> --json`, bypassing the conditional in `resolveDefaultOmcpBin`.

4. Optional: keep `resolveDefaultOmcpBin` as-is for any non-hook use sites; introduce a new `resolveHookCommandBin()` that always returns the absolute-node form.

## Cited code locations (verified live)

- `~/.copilot/settings.json` PostToolUse entry: bare `omcp hook fire PostToolUse --json`
- `src/runtime/copilot-config.ts:228-231` `omcpHookCommand()` — builds command string
- `src/runtime/copilot-config.ts:241` `mergeCopilotHooks` — calls `resolveDefaultOmcpBin()`
- `src/runtime/copilot-config.ts:272+` `resolveDefaultOmcpBin()` — has both branches (bare + absolute-node)
- omc `src/hooks/setup/index.ts:166` — reference form (always absolute-node)

## Recommended dispatching forward

L1.1 is a 1-line conceptual change (force the absolute-node branch for hooks) + tests covering all 13 events emit the absolute-node form.

L1.2 smoke = re-run Phase A's PRD with the fix applied and confirm 0 hook-executor "code 1" errors in the resulting process log.
