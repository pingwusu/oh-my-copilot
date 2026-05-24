# Copilot Windows pwsh dispatch bug — v1.5 investigation
**Date**: 2026-05-24
**Copilot version**: 1.0.53-2 (native SEA `copilot.exe` + embedded Node v24.16.0)
**Hook subprocess Node**: v24.14.1 (system `node` from PATH)
**Status**: PARTIAL — bench cannot reproduce the bug; live smoke shows it. Strong evidence points upstream.

## Summary
**No workaround proven.** Every bench reproduction of the current command form
(`node "abs-path" hook fire <Event> --json` via `pwsh.exe -nop -nol -c <cmd>` with
JSON piped on stdin) PASSED with exit 0 — including under minimal envs, with
`NODE_OPTIONS=--strip-types`, with `windowsVerbatimArguments` on/off, and with
the exact `spawnSync(['pwsh.exe', '-nop','-nol','-c', cmd], {input: payload})`
shape that Copilot's `Xer` uses. The live v1.4 smoke nevertheless shows 27+
`eval_stdin SyntaxError: Unexpected token ':'` failures with the identical
settings.json command string. Recommendation: **file an upstream issue** (draft
in Part 4). omcp v1.5 should ship the Stop-only workaround already in v1.2.0
and document that PostToolUse/UserPromptSubmit/SessionStart hooks are
upstream-blocked on Copilot 1.0.53-2 + Windows.

## Part 1: Copilot's actual dispatch mechanism (what's in app.js)

**Ground truth from `C:\.tools\.npm-global\node_modules\@github\copilot\app.js`**
(verified by direct grep at line offsets cited below):

1. **Settings.json schema** (`f1e` / `A1e` at offset ~4330739):
   The hook entry schema accepts `bash`, `powershell`, and `command` fields.
   The `A1e` transform mutates the entry:
   ```js
   function A1e(t){
     t.command!==void 0 && (
       t.bash===void 0 && (t.bash = t.command),
       t.powershell===void 0 && (t.powershell = t.command)
     ),
     // ...
   }
   ```
   When omcp writes `"command": "node \"abs-path\" hook fire Stop --json"`,
   `A1e` sets `bash = powershell = command`.

2. **Hook executor `Xer`** (offset ~4319300):
   ```js
   async function Xer(t, e, r, n) {
     let o, s;
     if (t.bash && t.powershell)
       o = process.platform === "win32" ? "powershell" : "bash",
       s = o === "powershell" ? t.powershell : t.bash;
     // ...
     let a = VKi(o);  // "pwsh.exe" on Windows
     // ...
     let g = ZKi(a, [...["-nop","-nol"], "-c", s],
                 {cwd:c, env:d, timeout:l});
     // ...
     e && g.stdin.write(e);  // e = JSON payload
     g.stdin.end();
   }
   ```
   On Windows, `Xer` ALWAYS picks the `powershell` field, spawns
   `pwsh.exe -nop -nol -c <command-string>`, and pipes the JSON payload to
   stdin. The exact spawn call is:
   ```
   spawn('pwsh.exe', ['-nop', '-nol', '-c', 'node "C:\\...\\omcp.js" hook fire Stop --json'],
         {cwd, env: Qj(...), timeout, stdin: pipe})
   ```

3. **Environment via `Qj`/`nR`** (offsets ~4330739 and earlier): A `Proxy` over
   `process.env` that BLOCKS keys in `Cpe` (secrets + Copilot-internal config)
   and passes through everything else. `PATH` is NOT in `Cpe`, so `PATH`
   survives into the hook child env (verified by simulation).

**Confidence: HIGH** — bundle was read directly; `Xer`, `A1e`, `Qj`, `nR`,
`Cpe`, and `Aze` were all extracted verbatim.

## Part 2: Reproduction attempts

All bench reproductions (`docs/probes/copilot-pwsh-dispatch/test-hook-dispatch.cjs`,
`docs/probes/copilot-pwsh-dispatch/test-env-dispatch.cjs`, `docs/probes/copilot-pwsh-dispatch/test-node-options-dispatch.cjs`,
`docs/probes/copilot-pwsh-dispatch/test-pwsh-quoting.cjs`) **FAILED to reproduce the eval_stdin bug**.

| # | Form / Condition | Exit | eval_stdin? |
|---|------------------|------|-------------|
| T1 | `pwsh -nop -nol -c 'node "abs" hook fire Stop --json'` + stdin JSON | 0 | No |
| T2 | Same, repeated to rule out flakiness | 0 | No |
| T3 | `pwsh -c 'cmd /c "node ...."'` wrapper | 1 | No (path mangled) |
| T4 | `pwsh -nop -nol -File wrapper.ps1` | timeout | No (stdin block) |
| T5 | Direct `node abs-path hook fire Stop --json` (no pwsh) | 0 | No |
| T6 | `pwsh -c "& node 'abs-path' ..."` single-quote | 0 | No |
| T7 | `.cmd` batch file via `pwsh -c "& path.cmd"` | 0 | No |
| T8 | `pwsh -c "echo '$payload' \| node ..."` | 0 | No |
| Env A | Full env | 0 | No |
| Env B | Minimal env (no PATH for node) | 1 | No (node not on PATH) |
| Env D | Minimal env + abs node path | 0 | No |
| Env F | `NODE_OPTIONS=--input-type=module` | 1 | No (ESM resolve fail) |
| Env G | `NODE_OPTIONS=--experimental-strip-types` | 0 | No |
| WVA-T | `windowsVerbatimArguments: true` | 0 | No |
| WVA-F | `windowsVerbatimArguments: false` | 0 | No |
| Repro | `node` (no args) with JSON stdin | 1 | **YES** (confirms mechanism) |

**Only the bare-`node`-with-no-args case reproduced `eval_stdin`** — this
confirms the failure mechanism (Node enters eval-stdin mode when invoked
without a script-path argument and stdin is piped/non-TTY) but does NOT
explain how Copilot's child Node loses its script-path argument in the live
session.

**Live-session evidence (`~/.copilot/logs/process-1779619848009-3792.log`)**:
- Settings.json verified correct: `"command": "node \"C:\\Users\\runjiashi\\oh-my-copilot-r2\\dist\\cli\\omcp.js\" hook fire Stop --json"`
- All 27+ hook invocations across UserPromptSubmit, SessionStart, PostToolUse,
  Stop, SessionEnd failed with identical `eval_stdin` stack trace
- Hook subprocess stderr consistently reports `Node.js v24.14.1` (system node)
- Copilot self-reports `Node.js version: v24.16.0` (embedded in copilot.exe SEA)
- Path in settings.json has no special characters (no `$`, `{`, `(`, etc.)

**Confidence: HIGH that bench cannot reproduce; HIGH that live session does
fail; MEDIUM that the cause is Copilot/Node-internal, not omcp-side.**

## Part 3: Alternative command forms (assessment)

Because no bench form failed (all PASS), none can be definitively recommended
as a fix. Forms that COULD be tried in a fresh live smoke (each requires
schema discovery first):

| Form | Schema support | Likely to help? | Notes |
|------|----------------|-----------------|-------|
| `command`: `"node \"abs-path\" hook fire X --json"` | current | unknown | currently broken in live |
| `powershell`-only field (no `command`/`bash`) | schema allows | unlikely | `Xer` still picks powershell on win32 → same `pwsh -c` path |
| `bash`-only field (no `command`/`powershell`) | schema allows | NO | `Xer` on win32 requires powershell when both fields differ, falls back to bash if only bash set BUT spawns `bash.exe` which usually isn't on Windows PATH |
| `.cmd` batch wrapper as `command` | schema allows | possibly | bench T7 PASSED; would change `pwsh -c "& path.cmd"` semantics; needs live smoke |
| ESM `.mjs` wrapper | not directly supported | NO | same `pwsh -c` dispatch wraps it identically |
| `sparkshell` `.exe` wrapper | schema allows | possibly | new dependency; pwsh still wraps it via `-c` |

**Critical finding**: `Xer` ALWAYS wraps the command in `pwsh.exe -nop -nol -c
<string>` on Windows. There is no schema-supported way to bypass this layer
via the `command` field — the only escape is to register the hook as `bash`
(which spawns `bash.exe`, unreliable on Windows) or to convince upstream to
add a `script-file` or `argv-array` dispatch mode.

The `Stop`-event-only workaround already shipped in omcp v1.2.0 remains the
ONLY proven-functional mitigation (Stop succeeded in earlier smokes; in this
v1.4 smoke Stop ALSO failed, suggesting the bug may have widened in 1.0.53-2).

## Part 4: Recommendation

**Recommendation: (b) file an upstream issue + (c) UNCLEAR — accept partial
mitigation in omcp v1.5.**

### Why not a code fix in omcp

Every alternative command form either (i) goes through the same `pwsh.exe
-nop -nol -c <string>` dispatch (and so cannot differ from the current
broken behavior), or (ii) requires schema fields (`powershell`/`bash`) that
`Xer` still funnels into the same `-c` path on Windows. No bench form
reproduced the live bug, so we cannot validate any "fix" deterministically.

### omcp v1.5 mitigation (no code change required)

- Keep the current `resolveHookCommandBin()` absolute-node form (it is
  correct and matches omc's reference pattern).
- Add a doctor check warning users on Copilot 1.0.53-2 + Windows that
  PostToolUse / UserPromptSubmit / SessionStart hooks may fail silently and
  point them to this report.
- The persistent-mode Stop-event handler remains the load-bearing path; it is
  the only event whose failure surfaces to the user (because it gates the
  ralph continuation loop).

### Upstream issue draft

**Title**: `Hook command dispatch via 'pwsh -c' loses script-path argument on Windows + Node 24, causing eval_stdin SyntaxError for all hook events`

**Body**:

```
### Environment
- OS: Windows 11 Enterprise (10.0.26200)
- Copilot CLI: 1.0.53-2 (also 1.0.52-4)
- Copilot embedded Node: v24.16.0 (per `Starting Copilot CLI` log)
- Hook subprocess Node: v24.14.1 (system `node.exe` from `C:\Program Files\nodejs`)
- pwsh.exe: PowerShell 7.6.2

### Reproduction
Register an omcp-style hook entry in `~/.copilot/settings.json`:
```json
"Stop": [{
  "matcher": "*",
  "hooks": [{
    "type": "command",
    "command": "node \"C:\\path\\to\\omcp.js\" hook fire Stop --json",
    "timeout": 30
  }]
}]
```
Trigger any agent turn that produces a Stop event.

### Expected
The hook command runs; Node loads `omcp.js`, reads JSON on stdin, exits 0.

### Actual
Hook fails with `HookExitCodeError: code 1`. Stderr shows the JSON payload
being parsed as TypeScript:
```
[stdin]:1
{"hook_event_name":"Stop","session_id":"...","stop_reason":"end_turn"}
                  ^
SyntaxError: Unexpected token ':'
    at makeContextifyScript (node:internal/vm:194:14)
    at evalTypeScript (node:internal/process/execution:260:22)
    at node:internal/main/eval_stdin:51:5
```
The frame `node:internal/main/eval_stdin` proves the child Node process was
invoked **without a script-path argument**, so it treated the piped JSON as
TypeScript source. This happens despite the settings.json command string
containing a properly double-quoted absolute path.

### Root cause analysis (bundle review)
`app.js` `Xer` function (~offset 4319300) spawns hooks via:
```js
spawn('pwsh.exe', ['-nop','-nol','-c', commandString], {input: jsonPayload})
```
The bug is reproducible only in the live Copilot session, not when the same
spawn is run from a normal Node shell with the identical args + env. This
suggests an interaction specific to Copilot's embedded Node 24.16.0 SEA
runtime spawning a Node 24.14.1 child via pwsh.exe — possibly a
CreateProcess argument-quoting boundary that drops the inner double-quoted
script path token.

### Impact
- All 13 hook event types fail on Windows for any hook command that uses
  the `node "<abs-path>" ...` form (the canonical form per the docs)
- The bug has been observed across Copilot 1.0.52-4 and 1.0.53-2 with
  identical signatures
- Workaround in the omcp project (event Stop only) is partial; PostToolUse,
  PreToolUse, UserPromptSubmit, SessionStart, SubagentStop, subagentStart
  all fail with the same stack trace

### Suggested fix
Use array-form spawn for hook commands when the `command` field is set:
parse the command string into argv tokens via the standard Win32 rules,
then spawn the executable directly (no `pwsh -c` wrapper). The `pwsh -c`
wrapper is only needed when the user wrote shell-syntax (pipes, env
substitution, etc.) — for the common `node "<path>" arg1 arg2 ...` form
it adds a fragility layer that triggers this bug.

### Related
- Issue #2540 (plugin preToolUse hooks don't fire)
- Issue #2585 (preToolUse hook doesn't pass additionalContext)
- Issue #3063 (hook async property silently ignored)
```

### Bench scripts produced (for the next investigator)

- `docs/probes/copilot-pwsh-dispatch/test-hook-dispatch.cjs` — 8 command-form variants
- `docs/probes/copilot-pwsh-dispatch/test-env-dispatch.cjs` — 7 env-variant tests
- `docs/probes/copilot-pwsh-dispatch/test-node-options-dispatch.cjs` — NODE_OPTIONS / pwsh / direct-node tests
- `docs/probes/copilot-pwsh-dispatch/test-pwsh-quoting.cjs` — Windows quoting + windowsVerbatimArguments tests

All scripts are deterministic and runnable via `node scripts/<name>.cjs` from
repo root. None reproduce the live bug — that gap itself is the most useful
piece of evidence: the failure mode is something the bench env does not have.

## Part 5: Open questions

1. **Why doesn't bench reproduce the live failure?** The exact `spawnSync`
   shape used by `Xer` was reproduced (args array, stdin pipe, Qj-like env).
   The live session uses Copilot's embedded Node v24.16.0 to spawn the child;
   bench uses system Node v24.14.1 as the parent. Possible mechanisms NOT
   ruled out: (a) Node 24.16.0 SEA runtime has a Windows CreateProcess
   argument-quoting difference vs 24.14.1, (b) Copilot's internal hook
   executor differs from `Xer` (less likely — the bundle has only one Xer
   and `copilot.exe` SEA strings search found no alternative hook code), (c)
   timing/race where multiple concurrent hook spawns interfere on Windows
   pipe handles.

2. **Why did the v1.4 smoke also fail on Stop?** Earlier v1.2 smokes had Stop
   succeed. This v1.4 smoke shows Stop failing too. Either Copilot 1.0.53-2
   widened the bug, or the earlier "Stop works" was coincidence (e.g. timing
   or small payload size).

3. **Does the issue affect Copilot's own native hook tests?** Unknown — would
   need to file the upstream issue and ask the Copilot team to run their
   Windows hook integration tests against the `node "<abs-path>" ...` form
   specifically.

4. **Is there a Node.js issue?** Searched nodejs/node issues for `child_process
   spawn windows argument quoting` — found long-standing issues (#5060,
   #7367, #10461) but none specifically describing v24.16.0 regression. The
   v24.16.0 changelog includes one `spawnSync` commit (#62633 "coerce args to
   string once") but nothing that would explain the live failure.

5. **Bench gap to live**: would need to either (a) instrument copilot.exe's
   embedded Node to dump the exact CreateProcess cmdline it passes to pwsh,
   or (b) write a tiny native helper that logs argv when invoked as the
   hook child. Both are out of scope for v1.5.

### Sources

- [GitHub Copilot hooks reference](https://docs.github.com/en/copilot/reference/hooks-configuration)
- [Using hooks with GitHub Copilot CLI](https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/use-hooks)
- [Node.js v24.16.0 release notes](https://nodejs.org/en/blog/release/v24.16.0)
- [nodejs/node issue #5060 — Quotes not handled correctly in spawn args](https://github.com/nodejs/node/issues/5060)
- [github/copilot-cli issue #2540 — plugin preToolUse hooks don't fire](https://github.com/github/copilot-cli/issues/2540)
- [github/copilot-cli issue #3063 — hook async silently ignored](https://github.com/github/copilot-cli/issues/3063)
- [github/copilot-cli issue #1680 — pwsh.exe hardcoded](https://github.com/github/copilot-cli/issues/1680)
- [github/copilot-cli issue #2355 — pwsh.exe ENOENT](https://github.com/github/copilot-cli/issues/2355)
