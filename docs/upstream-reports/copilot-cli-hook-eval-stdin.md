## Hook command script-file argument lost during Windows pwsh dispatch (Node 24 eval_stdin)

### Environment

- **OS**: Windows 11 Enterprise (10.0.26200)
- **Node.js**: 24.14.1
- **Copilot CLI**: 1.0.52-4 (also reproduced on 1.0.53-1)
- **Shell**: pwsh.exe (default dispatch environment)

### Reproduction steps

1. Register a hook command in `~/.copilot/settings.json` for any event (example below uses PostToolUse):

```json
{
  "matcher": "*",
  "hooks": [
    {
      "type": "command",
      "command": "node \"C:\\path\\to\\dist\\cli\\omcp.js\" hook fire PostToolUse --json",
      "timeout": 5
    }
  ]
}
```

2. Trigger any agent that performs a tool call (PostToolUse event fires on each tool invocation)
3. Observe process logs: `~/.copilot/logs/process-*.log`

### Expected behavior

The hook command executes as written. The Node.js process receives the script-file argument (`C:\path\to\dist\cli\omcp.js`) and executes the specified script with the JSON payload piped to stdin.

### Actual behavior

For 27+ of 30+ tool calls per session, Node.js is invoked **without the script-file argument**. Node enters `eval_stdin` mode (TypeScript-stripping), treats the piped JSON payload as TypeScript source code, and exits with `SyntaxError: Unexpected token ':'` (code 1).

The hook executor logs report: `Hook command failed with code 1` for each failure.

Stop event hooks registered with the identical command form **do NOT fail** — proving the bug is event-type or dispatch-path specific, not command-format specific.

### Stack trace

Verbatim from `~/.copilot/logs/process-*.log`:

```
2026-05-24T06:15:28.072Z [ERROR] postToolUse hook execution failed: HookExitCodeError: Hook command failed with code 1
Stderr: [stdin]:1
{"hook_event_name":"PostToolUse","session_id":"abc123def456","tool_name":"skill","tool_result":{"text_result_for_llm":"...long output..."},...}
                  ^
Expected ';', '}' or <eof>

SyntaxError: Unexpected token ':'
    at makeContextifyScript (node:internal/vm:194:14)
    at compileScript (node:internal/process/execution:388:10)
    at evalTypeScript (node:internal/process/execution:260:22)
    at node:internal/main/eval_stdin:51:5
    at Module._load (node:internal/modules/cjs_loader:133:8)
    at Function.executeUserCode (node:internal/main/wrapper:27:14)
    at Object.<anonymous> (node:internal/main/wrapper:16:25)
```

The frame `node:internal/main/eval_stdin:51:5` indicates Node was invoked without a script-file argument.

### Investigation evidence

#### Test case 1: Bare CLI name (npm shim layer)

Command registered: `omcp hook fire PostToolUse --json`

Result: All PostToolUse events fail with identical `eval_stdin` stack trace. Stop event with same command succeeds.

#### Test case 2: Absolute-node + multi-argument

Command registered: `node "C:\Users\runjiashi\oh-my-copilot-r2\dist\cli\omcp.js" hook fire PostToolUse --json`

Result: All PostToolUse events still fail with identical `eval_stdin` stack trace. Stop event succeeds.

#### Test case 3: Wrapper-script + single-argument

Command registered: `node "C:\Users\runjiashi\oh-my-copilot-r2\scripts\dispatcher.cjs" PostToolUse`

Result: All PostToolUse events fail with identical `eval_stdin` stack trace. Stop event succeeds.

#### Affected event types (all fail identically)

- PostToolUse (27+ failures per session)
- PreToolUse
- UserPromptSubmit
- SessionStart
- SubagentStop
- subagentStart

#### Unaffected event type

- Stop (0 failures observed across all test scenarios)

### Root cause hypothesis

Copilot CLI's hook executor (approximately `node_modules/@github/copilot/app.js`, line ~1193, the `Xer` class) constructs the pwsh dispatch invocation in a way that loses the multi-token argument list for certain event types. The pwsh command dispatch chain under Node 24 may:

1. Incorrectly parse or truncate the command-line arguments when the JSON payload size exceeds a certain threshold (PostToolUse payloads are consistently large due to `tool_result.text_result_for_llm` field)
2. Use a different code path for "internal" tool events (PostToolUse, PreToolUse) vs file-access events
3. Fail to properly escape or quote the script path when forwarding to pwsh, causing pwsh to interpret it as a separate command token rather than an argument to `node`

The fact that **Stop succeeds** with the identical command form rules out global pwsh quoting issues — it points to event-specific dispatch logic.

### Workaround (applied in oh-my-copilot v1.2.0)

Subscribe the affected hook logic to the `Stop` event instead of (or in addition to) PostToolUse. This reduces per-turn granularity (Stop fires once per ralph iteration instead of per tool call) but eliminates the dispatch bug's impact.

The workaround is functional but incomplete — PostToolUse-specific use cases (per-tool-call auditing, error aggregation, cost tracking, sentinel guards) cannot use this event.

### Impact

- Long-running agent sessions (ralph with 30+ iterations) using PostToolUse hooks for preemptive compaction advisory risk hard context-limit truncation
- All plugins subscribing to PostToolUse events fail to deliver logic
- Error aggregation, cost tracking, and audit hooks for tool invocations do not fire

### Related issues

- oh-my-claudecode (omc) project has a functionally identical Bash-style `$CLAUDE_PLUGIN_ROOT` variable expansion failure under pwsh, indicating a broader Windows-dispatch fragility in Copilot CLI's hook executor
- omcp project investigation: `docs/probes/L1-hook-dispatch-format.md` (root-cause analysis)
- omcp project changelog: v1.1.0 entry documents L1.0–L1.2 investigation and partial fixes

### Recommended next steps

1. Audit the hook executor's pwsh command construction logic, particularly the dispatch path for `PostToolUse` and other non-Stop events
2. Confirm whether the multi-argument form is being correctly forwarded to pwsh (e.g., via `Invoke-Expression`, `Start-Process`, or direct pwsh `-nop -nol -c` with proper escaping)
3. Add Windows + Node 24 integration tests for hook dispatch that validate all event types execute the script with the correct arguments intact
4. Consider always using the absolute-path form `node "<abs-path>" <args>` for all hook commands, mirroring omc's proven-working pattern at `src/hooks/setup/index.ts:166`
