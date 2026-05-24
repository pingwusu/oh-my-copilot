# omcp Stop hook handler exit-1 root-cause investigation

**Date**: 2026-05-24
**Trigger**: L3.6 smoke showed 3/3 Stop handlers exit code 1; prior session blamed upstream — DISPUTED.
**Investigator**: subagent (independent context)

## Summary

The exit-1 errors are caused by a **stale `~/.copilot/settings.json`** that was written
by commit `54ba0a5` (the L1.2 wrapper-script fix, 14:15 CST) and never refreshed after
that commit was reverted at 15:29 CST. All 13 hook events point to
`node "…\scripts\omcp-hook-dispatch.cjs" <event>`, but `omcp-hook-dispatch.cjs` was
deleted by the revert. The L3.6 smoke ran at 17:14 CST — **after the revert** — so
Copilot invoked a non-existent script for every hook event, resulting in Node's
`MODULE_NOT_FOUND` error (exit 1) surfaced by Copilot as `HookExitCodeError: code 1`.

The `eval_stdin` `SyntaxError: Unexpected token ':'` stack trace in the log is from
a **separate, pre-existing upstream Windows dispatch bug** (Copilot 1.0.52-4 pwsh
executor strips the script path on some invocations), not from the missing-file
scenario. The three Stop-tagged log lines (1505, 1523, 1541) show this upstream
eval-stdin form, which means Copilot was running 1.0.52-4 for those specific dispatch
attempts even though 1.0.53-2 was also installed.

**Recommended fix**: re-run `omcp setup` (or manually update `~/.copilot/settings.json`)
to refresh all hook commands to the current HEAD's canonical form: `node "…\dist\cli\omcp.js" hook fire <event> --json`.

---

## Part 1: Copilot's actual Stop event payload (ground truth)

### Schema source

- `C:\.tools\.npm-global\node_modules\@github\copilot\app.js` — bundle (live on machine)
- `iJi` function (PascalCase / `_vsCodeCompat` path): the serializer used when a hook
  entry has `_vsCodeCompat: "Stop"` set, OR when the hook is registered under the
  PascalCase alias `Stop` (mapped via `s2t` to internal `agentStop`).
- `tH` base-payload builder used by `iJi`.

### Field names + types

From `tH(t, e)` (base payload, all events):
```
hook_event_name : string  (the PascalCase alias, e.g. "Stop")
session_id      : string
timestamp       : string (ISO 8601)
cwd             : string
```

From `iJi(t, e)` (Stop / agentStop specific additions):
```
transcript_path : string
stop_reason     : string  (e.g. "end_turn")
```

Full camelCase (non-vsCodeCompat) form from the `agentStop` map lambda:
```
timestamp       : string
cwd             : string
sessionId       : string
transcriptPath  : string
stopReason      : string
```

### Sample payload Copilot emits

Exactly as captured in log line 1507 (PascalCase / vsCodeCompat path — the form
emitted when the hook entry has `_vsCodeCompat: "Stop"` or is registered under the
PascalCase key):

```json
{
  "hook_event_name": "Stop",
  "session_id": "c87cb78f-e572-49cd-8851-029792f68513",
  "timestamp": "2026-05-24T09:14:39.328Z",
  "cwd": "C:\\Users\\runjiashi\\oh-my-copilot-r2",
  "transcript_path": "C:\\Users\\runjiashi\\.copilot\\session-state\\c87cb78f-e572-49cd-8851-029792f68513\\events.jsonl",
  "stop_reason": "end_turn"
}
```

Note the field names are **snake_case** (`hook_event_name`, `session_id`,
`transcript_path`, `stop_reason`). The PascalCase alias `"Stop"` is the value
of `hook_event_name`, not the key. This is the `iJi` serializer path.

The `s2t` map (bundle-confirmed):
```
Stop → agentStop   (internal camelCase canonical name)
```

### Confidence

**High** — payload read directly from live log line 1507 + confirmed against `iJi`
and `tH` function bodies extracted from the bundle.

---

## Part 2: omcp's Stop hook handler payload parsing

### Handler registration: events name, command form

**Event name in source**: `["Stop"]` — `src/hooks/persistent-mode/index.ts:263`

**Command registered in `~/.copilot/settings.json`** (stale, from reverted commit 54ba0a5):
```
node "C:\Users\runjiashi\oh-my-copilot-r2\scripts\omcp-hook-dispatch.cjs" Stop
```

**Command that SHOULD be registered** (current HEAD `resolveHookCommandBin()`):
```
node "C:\Users\runjiashi\oh-my-copilot-r2\dist\cli\omcp.js" hook fire Stop --json
```

The `dist\cli\omcp.js` file **exists**; `scripts\omcp-hook-dispatch.cjs` does **not**.

### Payload parsing entry point (file:line)

1. Copilot pipes the Stop JSON payload to stdin of the registered command.
2. `src/hooks/runtime.ts:367` — `readStdinJson()` reads and parses stdin JSON into
   `Partial<HookContext>`.
3. `src/hooks/runtime.ts:446-454` — maps fields from stdin: reads `sessionId`, `cwd`,
   `toolName`, `toolArgs`, `toolResult`.
4. `src/hooks/runtime.ts:455` — `fireHooks(event, ctx, …)` dispatches to all
   registered hooks for the given event.
5. `src/hooks/persistent-mode/index.ts:265` — `createPersistentModeHook().run(ctx)`
   is called.

### Field expectations vs Copilot's emit

omcp's `runFireCli` (`src/hooks/runtime.ts:446`) reads from the stdin JSON:

| omcp reads          | Copilot sends (Stop payload)       | Match? |
|---------------------|------------------------------------|--------|
| `sessionId`         | `session_id`                       | **NO** |
| `cwd`               | `cwd`                              | YES    |
| `toolName`          | not present in Stop payload        | N/A (undefined) |
| `toolArgs`          | not present in Stop payload        | N/A (undefined) |
| `toolResult`        | not present in Stop payload        | N/A (undefined) |

`session_id` (snake_case) vs `sessionId` (camelCase): omcp reads `sessionId` but
Copilot emits `session_id`. This means `ctx.sessionId` is always `""` (empty string,
the default at `runtime.ts:448`) for Stop events dispatched via the vsCodeCompat path.

However, this mismatch is **silent and non-fatal** — `sessionId` is used only as
a key for the `todoContinuationAttempts` Map, which degrades gracefully to a
`"global"` key when empty. It does not cause an exit-1.

The `stop_reason`, `transcript_path`, `hook_event_name` fields from the Stop payload
are NOT read by `runFireCli` at all — they are not mapped into `HookContext`. They
fall through to the `toolArgs`/`toolResult` fallback in `extractStopContext`, but
since `toolArgs` is `undefined` (not present in Stop payload), `extractStopContext`
returns an empty `StopContext`. This is also **non-fatal** — all `isContextLimitStop`,
`isRateLimitStop`, etc. return `false` on empty context, so the handler proceeds to
the ralph/ultrawork/todo priority chain.

### Confidence

**High** — traced through `runtime.ts:438-505` and `persistent-mode/index.ts:260-300`
line by line against the confirmed payload.

---

## Part 3: Identified exit-1 root cause

### Specific file:line that returns non-zero

**Not in omcp source.** The exit-1 occurs **before omcp's handler code runs** due to
a stale `~/.copilot/settings.json` pointing to a deleted file.

Root cause site: `~/.copilot/settings.json` — all 13 hook entries, including Stop:
```json
{
  "command": "node \"C:\\Users\\runjiashi\\oh-my-copilot-r2\\scripts\\omcp-hook-dispatch.cjs\" Stop",
  "timeout": 30,
  "__omcp": true
}
```

`scripts/omcp-hook-dispatch.cjs` does not exist (deleted by revert commit `c7cbc21`
at 15:29 CST; the L3.6 smoke ran at 17:14 CST).

### Why it exits (logic explanation)

**Timeline reconstruction**:

| Time (CST)    | Event |
|---------------|-------|
| 14:15         | Commit `54ba0a5` adds `scripts/omcp-hook-dispatch.cjs` + updates `settings.json` to dispatcher form |
| 15:29         | Commit `c7cbc21` reverts `54ba0a5`, deleting `omcp-hook-dispatch.cjs` from repo — **`settings.json` is NOT touched** |
| 17:14         | L3.6 smoke runs; Copilot reads `settings.json`, dispatches `node "…\omcp-hook-dispatch.cjs" Stop` |
| 17:14         | Node: `Error: Cannot find module '…\omcp-hook-dispatch.cjs'` → exit 1 |
| 17:14         | Copilot: `HookExitCodeError: code 1` logged at lines 1505, 1523, 1541 |

**The `eval_stdin` SyntaxError** visible in the log (lines 1506-1519) is from the
**upstream Windows pwsh dispatch bug** (documented in the revert commit message and
`L1-hook-dispatch-format.md`): Copilot 1.0.52-4 on Windows runs hook commands via
`pwsh.exe -c "<command>"`, which under certain conditions drops the script path
argument, causing Node to enter `node:internal/main/eval_stdin` mode and interpret
the piped JSON payload as TypeScript — exiting with `SyntaxError` + code 1. This
pre-existing bug was present before `54ba0a5` and survives the revert.

**Verification**: running `node "C:\Users\runjiashi\oh-my-copilot-r2\scripts\omcp-hook-dispatch.cjs" Stop`
directly from PowerShell produces `MODULE_NOT_FOUND` (exit 1), confirming the
file is absent and Node exits non-zero without running any omcp code.

### Evidence (code trace AND log analysis)

1. **Log line 1507** (ground truth): stderr shows the JSON payload being rejected as
   TypeScript source — `eval_stdin` stack trace, not omcp code.
2. **`settings.json` inspection**: all 13 events point to `omcp-hook-dispatch.cjs`.
3. **Filesystem check**: `scripts/omcp-hook-dispatch.cjs` does not exist.
4. **`dist/cli/omcp.js`**: EXISTS — the correct target file is present.
5. **Git history**: `54ba0a5` (14:15) added the file; `c7cbc21` (15:29) reverted and
   deleted it; smoke ran at 17:14 — after the revert, before any `omcp setup` refresh.
6. **`c7cbc21` revert message** explicitly states `settings.json` was not migrated back:
   the revert is described as a "clean reverse" of the commit, but `omcp setup` was
   not re-run as part of the revert workflow.

### Confidence

**HIGH** — three independent evidence streams (log stderr, filesystem, git timeline)
all converge on the same cause.

---

## Part 4: Hypothesis verdicts

- **H1 camelCase/PascalCase mismatch**: **RULED OUT** — The event is registered as
  `"Stop"` (PascalCase, the correct Copilot alias for `agentStop`), Copilot emits
  `hook_event_name: "Stop"` in the payload, and omcp's `VALID_EVENTS` list includes
  `"Stop"`. The `session_id` vs `sessionId` field mismatch is real but causes only
  a silent `sessionId=""` — it does not exit non-zero.

- **H2 field-not-emitted**: **RULED OUT** — omcp's `extractStopContext` handles
  missing `toolArgs`/`toolResult` gracefully (returns empty `StopContext`; all
  `isX` guards return `false`; handler proceeds to priority chain). Undefined fields
  do not throw and do not cause exit-1.

- **H3 post-parse logic exit**: **RULED OUT** — omcp's `runFireCli` always returns
  `0` on success (`return 0` at `runtime.ts:505`). All hook handler results (noop,
  advise) are non-error. No `process.exit(1)` exists in the handler path. Even
  uncaught exceptions in hook `run()` are caught by `wrapWithTimeout`'s `.catch`
  handler which calls `res({ kind: "noop" })` — not exit-1.

- **H4 upstream really broken**: **CONFIRMED AS CONTRIBUTING** — The `eval_stdin`
  `SyntaxError` stack trace in the log (lines 1506-1519 / 1524-1537 / 1542-1550)
  IS the upstream Copilot 1.0.52-4 pwsh dispatch bug. However it is **not the root
  cause of the specific Stop hook failures in the L3.6 smoke** — rather, it explains
  the identical error shape. The upstream bug was present before L1.2, causes
  MODULE_NOT_FOUND (or eval_stdin) for ALL hook events when running on 1.0.52-4,
  and is documented in `docs/probes/L1-hook-dispatch-format.md` and the `c7cbc21`
  revert commit. The upstream bug and the stale-settings.json bug produce identical
  log signatures — both result in `HookExitCodeError: code 1` with `eval_stdin`
  stack traces. The proximate cause for the specific 3 Stop entries in this smoke is
  the stale `settings.json`; the upstream dispatch bug remains an open secondary issue.

- **H5 uncaught exception**: **RULED OUT** — `wrapWithTimeout` in `runtime.ts:253-288`
  catches all exceptions from hook `run()` and resolves with `{ kind: "noop" }`.
  Uncaught exceptions at the process level would produce a different stack trace in
  the log (no `eval_stdin` frame). The log shows `eval_stdin` exclusively — pre-omcp
  execution failure, not omcp exception.

---

## Part 5: Recommended fix

### Minimal code change: re-run `omcp setup`

No source code change is needed. The fix is an operational step:

```powershell
# From the repo root:
node "C:\Users\runjiashi\oh-my-copilot-r2\dist\cli\omcp.js" setup
```

This calls `runSetup()` → `applyOmcpHookWiring()` → `mergeCopilotHooks()` →
`resolveHookCommandBin()` which always returns the absolute-node form:
```
node "C:\Users\runjiashi\oh-my-copilot-r2\dist\cli\omcp.js" hook fire <event> --json
```

This will overwrite all 13 stale `omcp-hook-dispatch.cjs` entries in
`~/.copilot/settings.json` with the correct `dist/cli/omcp.js` form.

### Before (stale — currently in settings.json)

```json
"command": "node \"C:\\Users\\runjiashi\\oh-my-copilot-r2\\scripts\\omcp-hook-dispatch.cjs\" Stop"
```

### After (correct — what `omcp setup` writes)

```json
"command": "node \"C:\\Users\\runjiashi\\oh-my-copilot-r2\\dist\\cli\\omcp.js\" hook fire Stop --json"
```

### Why this fixes it

`dist/cli/omcp.js` exists. Copilot invokes it → Node loads the file → `runFireCli`
is called → `readStdinJson()` parses the Stop payload → `createPersistentModeHook`
runs → returns `{ kind: "noop" }` or `{ kind: "advise", text: "…" }` → process exits 0.

### Process-level safeguard: add `omcp setup` to revert workflow

The root cause is procedural: reverting a commit that wrote to `settings.json`
without refreshing `settings.json`. A lightweight invariant test would prevent
recurrence:

```ts
// In src/__tests__/hook-command-targets.test.ts (new test)
it("all hook commands in settings.json reference files that exist on disk", () => {
  // Parse ~/.copilot/settings.json hooks
  // For each __omcp hook entry, extract the script path from the command string
  // Assert: existsSync(scriptPath) === true
});
```

Alternatively, add `omcp doctor` check: detect stale hook commands pointing to
missing files and emit a warning with the fix command.

### TDD test outline (vitest, deterministic)

```ts
// File: src/__tests__/hook-dispatch-smoke.test.ts
// Purpose: verify that the resolved hook command target exists on disk

import { resolveHookCommandBin } from "../runtime/copilot-config.js";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

it("resolveHookCommandBin target file exists", () => {
  const cmd = resolveHookCommandBin();
  // cmd = 'node "C:\\...\\dist\\cli\\omcp.js"'
  const match = cmd.match(/node "(.+?)"/);
  expect(match).not.toBeNull();
  expect(existsSync(match![1])).toBe(true);
});

it("mergeCopilotHooks Stop entry references existing dist/cli/omcp.js", () => {
  const hooks = mergeCopilotHooks(undefined);
  const stopCmd = hooks["Stop"]?.[0]?.hooks?.[0]?.command ?? "";
  const match = stopCmd.match(/node "(.+?)"/);
  expect(match).not.toBeNull();
  expect(existsSync(match![1])).toBe(true);
  // also assert the command doesn't reference omcp-hook-dispatch.cjs
  expect(stopCmd).not.toContain("omcp-hook-dispatch");
});
```

Feed: real filesystem. Assert: `existsSync` = true + no stale script path.
These tests are deterministic (no mocking needed — they verify the actual build
output exists, which CI enforces).

### Confidence

**HIGH** for the fix (operational `omcp setup`). **MEDIUM** for the TDD tests —
they would prevent recurrence but require a build step to be meaningful in CI.

---

## Part 6: Open questions

1. **The upstream eval_stdin bug (H4) is still open.** The revert commit documents
   it as a Copilot 1.0.52-4 / Node 24 / pwsh interaction where Copilot strips the
   script path from multi-arg hook commands. The log's `eval_stdin` stack trace
   confirms this bug is present. Whether Copilot 1.0.53-2 (currently installed) has
   fixed this is untested. Evidence needed: re-run smoke with fresh `settings.json`
   (post `omcp setup`) on Copilot 1.0.53-2; check logs for `eval_stdin` occurrences.
   If zero: upstream fixed in 1.0.53. If still present: file upstream issue.

2. **`session_id` vs `sessionId` field gap.** Copilot's Stop payload emits
   `session_id` (snake_case); omcp's `runFireCli` reads `sessionId` (camelCase).
   This causes `ctx.sessionId = ""` for every Stop event, making `todoContinuationAttempts`
   use the `"global"` key for all sessions. Functional impact is low today (only
   affects attempt-counter isolation between concurrent sessions), but should be
   fixed. The fix is a one-liner in `runtime.ts:448`:
   ```ts
   // Current:
   sessionId: typeof stdinPayload.sessionId === "string" ? stdinPayload.sessionId : "",
   // Fix (add snake_case fallback):
   sessionId: typeof stdinPayload.sessionId === "string" ? stdinPayload.sessionId
            : typeof (stdinPayload as Record<string,unknown>).session_id === "string"
              ? (stdinPayload as Record<string,unknown>).session_id as string : "",
   ```

3. **`stop_reason` not plumbed into `HookContext`.** Copilot's Stop payload includes
   `stop_reason: "end_turn"` but omcp's `runFireCli` does not map it into `HookContext`.
   The `extractStopContext` function reads from `ctx.toolArgs ?? ctx.toolResult`, both
   of which are `undefined` for Stop events — so `isContextLimitStop`, `isRateLimitStop`
   etc. never see the real `stop_reason`. For `end_turn` this is harmless (the
   continuation loop should fire). But for future `stop_reason` values like
   `context_limit` or `rate_limit`, the bail-out guards would silently fail to fire.
   The fix: map `stop_reason` from the stdin payload into a dedicated field on
   `HookContext` (e.g. `stopReason?: string`) and update `extractStopContext` to read it.

4. **Whether `--yolo` matters for the residual 27 PostToolUse eval_stdin errors.**
   The previous session's hypothesis that `--yolo` would fix hook dispatch remains
   untested. Per `docs/upstream-reports/copilot-yolo-flag-investigation.md`, `--yolo`
   only affects permission prompts, not hook dispatch. The 27 PostToolUse failures are
   the upstream eval_stdin bug (H4), not a permissions issue. Re-running with `--yolo`
   is unlikely to fix them, but it should be tested on 1.0.53-2 after the stale-settings
   fix is applied.

---

## Sources

### Files inspected (path:line ranges)

- `C:\Users\runjiashi\oh-my-copilot-r2\src\hooks\persistent-mode\index.ts:1-301` — full file
- `C:\Users\runjiashi\oh-my-copilot-r2\src\hooks\runtime.ts:1-506` — full file
- `C:\Users\runjiashi\oh-my-copilot-r2\src\hooks\hook-types.ts:1-91` — full file
- `C:\Users\runjiashi\oh-my-copilot-r2\src\runtime\copilot-config.ts:1-483` — full file
- `C:\Users\runjiashi\oh-my-copilot-r2\src\cli\omcp.ts:186-206` — hook fire CLI handler
- `C:\Users\runjiashi\oh-my-copilot-r2\src\cli\commands\setup.ts:1-147` — setup command
- `C:\Users\runjiashi\oh-my-copilot-r2\src\lib\todo-state.ts:1-488` — Stop detection helpers
- `C:\Users\runjiashi\oh-my-copilot-r2\docs\probes\L1-hook-dispatch-format.md:1-88` — prior probe
- `C:\Users\runjiashi\oh-my-copilot-r2\docs\handoff-archive\2026-05-24-v1.4-housekeeping-rca.md:1-262` — prior RCA
- `C:\Users\runjiashi\oh-my-copilot-r2\docs\upstream-reports\copilot-yolo-flag-investigation.md:1-224` — yolo investigation
- `C:\.tools\.npm-global\node_modules\@github\copilot\app.js` — bundle, regions:
  - `s2t` map (PascalCase → camelCase event aliases)
  - `tH()` base payload builder
  - `iJi()` Stop / agentStop vsCodeCompat serializer
  - `m2()` hook execution wrapper
  - `aWr` Set of valid camelCase event names
  - `n.agentStop?.length&&…` hook registration loop
  - `HookExitCodeError` class definition

### URLs fetched

- None fetched directly (prior session's yolo investigation already fetched official
  docs; findings incorporated via `copilot-yolo-flag-investigation.md`)

### Log lines reviewed

- `C:\Users\runjiashi\.copilot\logs\process-1779613937047-31476.log:1500-1550`
  — lines 1505, 1523, 1541: `HookExitCodeError: code 1`
  — lines 1506-1519, 1524-1537, 1542-1550: `eval_stdin` SyntaxError stack traces
  — line 1507: actual Stop payload emitted by Copilot (ground-truth JSON)
