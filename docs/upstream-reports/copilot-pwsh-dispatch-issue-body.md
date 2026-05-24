## Environment

- **OS**: Windows 11 Enterprise (10.0.26200)
- **GitHub Copilot CLI**: 1.0.53-2 (also reproduced on 1.0.52-4)
- **Copilot embedded Node**: v24.16.0 (per `Starting Copilot CLI` log)
- **Hook subprocess Node**: v24.14.1 (system `node.exe` from `C:\Program Files\nodejs`)
- **PowerShell**: 7.6.2 (`pwsh.exe`)

## Reproduction

Register a hook entry in `~/.copilot/settings.json` using the canonical absolute-node form (as recommended in the docs):

```json
"Stop": [{
  "matcher": "*",
  "hooks": [{
    "type": "command",
    "command": "node \"C:\\path\\to\\handler.js\" hook fire Stop --json",
    "timeout": 30
  }]
}]
```

Where `handler.js` is a Node script that reads JSON from stdin and exits 0. Trigger any agent turn that produces a Stop event (e.g., `copilot --autopilot --yolo --max-autopilot-continues 5 -p "any task"`).

## Expected

The hook command runs; Node loads `handler.js`, reads JSON on stdin, exits 0. The hook config is correct per [the docs](https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-hooks-reference).

## Actual

Hook fails with `HookExitCodeError: code 1`. Stderr shows the JSON payload being parsed as TypeScript:

```
[stdin]:1
{"hook_event_name":"Stop","session_id":"...","stop_reason":"end_turn"}
                  ^
SyntaxError: Unexpected token ':'
    at makeContextifyScript (node:internal/vm:194:14)
    at evalTypeScript (node:internal/process/execution:260:22)
    at node:internal/main/eval_stdin:51:5
```

The frame `node:internal/main/eval_stdin` proves the child Node process was **invoked without a script-path argument**, so it treated the piped JSON as TypeScript source under Node 24's `--experimental-strip-types`-default mode. This happens despite the settings.json command string containing a properly double-quoted absolute path.

## Root cause analysis (Copilot bundle inspection)

`@github/copilot/app.js` `Xer` function (~offset 4319300) spawns hook commands via:

```js
spawn('pwsh.exe', ['-nop','-nol','-c', commandString], {input: jsonPayload})
```

The `command` field from settings.json becomes `commandString`. The bug is reproducible only in the live Copilot session, **not** when the same spawn is run from a normal Node shell with identical args + env.

I ran a 4-script bench harness with 8 command-form variants × 7 env-variant tests × NODE_OPTIONS / `windowsVerbatimArguments` / pwsh-version permutations — **all bench reproductions PASSED with exit 0**, including the exact `spawnSync(['pwsh.exe', '-nop','-nol','-c', cmd], {input: payload})` shape `Xer` uses (with `Qj`-equivalent env stripping).

The bench-vs-live gap is itself diagnostic: something specific to Copilot's embedded Node v24.16.0 SEA runtime spawning a Node v24.14.1 child via `pwsh.exe` drops the inner double-quoted script path token. This may be a CreateProcess argument-quoting boundary specific to the SEA→pwsh→Node chain, or a Node 24.16.0 spawn-arg regression, or both.

Bench matrix (representative — all PASSED with exit 0 in bench, all FAIL in live Copilot session):

| Variant | Form / Condition | Bench result |
|---|---|---|
| T1 | `pwsh -nop -nol -c 'node "abs-path" hook fire Stop --json'` + stdin JSON | 0 |
| T2 | Same, repeated | 0 |
| T5 | Direct `node abs-path hook fire Stop --json` (no pwsh) | 0 |
| T6 | `pwsh -c "& node 'abs-path' ..."` single-quote | 0 |
| T7 | `.cmd` batch file via `pwsh -c "& path.cmd"` | 0 |
| T8 | `pwsh -c "echo '$payload' \| node ..."` | 0 |
| Env A | Full env | 0 |
| Env D | Minimal env + abs node path | 0 |
| Env G | `NODE_OPTIONS=--experimental-strip-types` | 0 |
| WVA-T | `windowsVerbatimArguments: true` | 0 |
| WVA-F | `windowsVerbatimArguments: false` | 0 |
| Repro | `node` (no args) with JSON stdin | 1 (eval_stdin — confirms mechanism but not cause) |

Bench reproduction scripts can be provided on request; happy to share via gist or attach to this issue.

## Impact

- **All 13 hook event types fail on Windows** for any hook command using the `node "<abs-path>" ...` form (the canonical form per the docs)
- Reproduced across Copilot 1.0.52-4 and 1.0.53-2 with identical signatures
- Affects: `PostToolUse`, `PreToolUse`, `UserPromptSubmit`, `SessionStart`, `SessionEnd`, `Stop`, `SubagentStop`, `subagentStart`, `PreCompact`, `PermissionRequest`, `Notification`, `PostToolUseFailure`, `ErrorOccurred`

## Suggested fix

Use array-form spawn for hook commands when the `command` field is set: parse the command string into argv tokens via the standard Win32 rules, then spawn the executable directly (no `pwsh -c` wrapper).

The `pwsh -c` wrapper is only needed when the user wrote shell-syntax (pipes, env substitution, etc.) — for the common `node "<path>" arg1 arg2 ...` form it adds a fragility layer that triggers this bug.

Alternative: add a `script-file` / `argv-array` dispatch mode to the hook schema that uses `spawn(executable, args[])` directly, bypassing pwsh entirely.

## Related issues

- #2540 — plugin preToolUse hooks don't fire (symptom-adjacent)
- #2585 — preToolUse hook doesn't pass additionalContext
- #3063 — hook async property silently ignored
- #1680 — pwsh.exe hardcoded
- #2355 — pwsh.exe ENOENT

## Note

This report comes from investigation work in an internal multi-agent orchestration layer over Copilot CLI. We've shipped a workaround that detects this failure pattern in users' logs and warns them, but the underlying dispatch reliability has to be fixed upstream. Happy to share the full investigation report + bench scripts privately if useful for triage.
