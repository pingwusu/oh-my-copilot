# Deep Dive Trace: complete-omcp-orchestrate-ralph-ralplan

**Date**: 2026-05-24 early-morning
**HEAD**: f21bf04 (v1.0.0 just cut)
**User intent**: Complete omcp orchestrate (mirror omc) — long-running + multi-agent (ralph/ralplan/team), fix prior bugs.

## Observed Result

omcp shipped v1.0.0 with orchestrator-v1 verified end-to-end on Phase A smoke. However:

- Phase A smoke logged 64 PostToolUse "code 1" errors that did NOT block orchestration but ARE noise
- `omcp ralplan` has 39 tests + boulder registration code but has **never been driven against live Copilot**
- `omcp team` shard-merge has unit tests but **never been exercised with N real concurrent workers**
- `omcp verify-phase` exists with 20 tests but **only DI-mock — never against live Copilot subprocesses**
- Long-running viability (50+ iterations, hours of wall-clock) is unverified
- omc has structural patterns (stage-transition state, shutdown ack, watchdog) that omcp lacks

## Ranked Hypotheses

| Rank | Hypothesis | Confidence | Evidence Strength | Why it leads |
|------|-----------|------------|-------------------|--------------|
| 1 | **Hook dispatch on Windows triggers Node 24 TypeScript eval-stdin → JSON parsed as TS source → SyntaxError → exit 1 BEFORE omcp is reached** (Lane 1) | High | Strong (primary log stack trace) | Smoking-gun log artifact: `[stdin]:1 {...}: SyntaxError: Unexpected token ':'` with frame `node:internal/main/eval_stdin`. Reproducible from settings.json content. |
| 2 | **Multi-agent layer has structural gaps vs omc**: ralplan→ralph handoff hardwired `handOffToRalph:false` + empty `planContent` (broken chain); `verify-phase` uses blocking `spawnSync` with no timeout (can hang forever); `detectVerdict` line-only match never tested against live Copilot stdout (Lane 2) | Medium-High | Strong code reads | Each gap confirmed by direct file:line citation. Three independent bugs / gaps that each break a critical chain. |
| 3 | **Long-running infrastructure has 4 compounding gaps**: progress.txt unbounded growth injected into every prompt; preemptive-compaction is advisory-only + 3-warning cap + token-blind to prompt history; crash recovery NOT implemented (unconditional clearRalphState); cold-start ~840ms × 5s hook timeout leaves only ~4s real budget (Lane 3) | Medium-High | Strong code reads + measurement | Cold-start measured 741-843ms. All 4 gaps confirmed by code reads. Compounds at 30+ iterations. |

## Evidence Summary by Hypothesis

### Hypothesis 1 — Hook dispatch (Lane 1)
- **Smoking gun log artifact** at `~/.copilot/logs/process-1779562636520-15460.log:351-365`:
  ```
  [stdin]:1
  {"hook_event_name":"PostToolUse", ...}
                    ^
  SyntaxError: Unexpected token ':'
      at node:internal/main/eval_stdin:51:5
  ```
- Same stack trace appears for `UserPromptSubmit`, `SessionStart`, `PostToolUse` — rules out per-event omcp bug.
- `runFireCli` (`src/hooks/runtime.ts:438`) never returns 1 — only 0 or 2 — confirming the exit is happening BEFORE omcp's code runs.
- Stop hook (orchestration-critical) does NOT appear in the failure pattern, supporting the hypothesis that Stop uses a different Copilot dispatch path.
- Hook command in `~/.copilot/settings.json`: `"omcp hook fire <event> --json"` (bare shell command).

### Hypothesis 2 — Multi-agent layer (Lane 2)
- **ralplan→ralph handoff disabled**: `src/cli/commands/mode.ts:179-185` hardcodes `handOffToRalph: false, planContent: ""`. Boulder is registered but plan file is empty.
- **verify-phase has no timeout**: `src/cli/commands/verify-phase.ts:74-76` calls `spawnSync("copilot", args, ...)` without `timeout` option. A hanging Copilot hangs the verify-phase process forever.
- **detectVerdict requires verdict-on-its-own-line**: never tested against real Copilot stdout. If Copilot wraps verdict in reasoning, detectVerdict returns null and loops to max iterations every time.
- **"Concurrent" shard test is actually sequential**: `team-shard.test.ts:112-141` runs 4 serial `writeShardState` calls on a single thread — no real concurrent OS-process collision testing.
- **No stage-transition state, no shutdown ack, no stuck-worker watchdog** — all present in omc, missing in omcp.

### Hypothesis 3 — Long-running infrastructure (Lane 3)
- **progress.txt unbounded growth**: `appendProgressNote` (`src/lib/ralph-state.ts:329-351`) rewrites entire file every iteration. `getRalphContext` (lines 403-421) injects the whole file into every prompt.
- **preemptive-compaction inert mid-run**: `MAX_WARNINGS = 3` (constants.ts:32) silences hook permanently after 3 fires. Token estimator only counts `LARGE_OUTPUT_TOOLS` outputs — blind to prompt history + ralph context.
- **Crash recovery missing**: `src/cli/commands/mode.ts:170-172` calls `clearRalphState()` unconditionally on copilot exit (any exit code). A killed `omcp ralph` loses iteration counter forever.
- **Stale mode-state blocks restart**: `canStartMode` rejects new ralph if previous run left mode-state. User must run `omcp cancel` manually.
- **Cold-start cost**: 741-843ms per Node invocation (measured). 5s hook timeout → only ~4s real budget. Under disk pressure could hit timeout → contributes to "code 1" via timeout path.

## Evidence Against / Missing Evidence

- **H1 counter**: The orchestration loop DID complete in Phase A despite 64 PostToolUse errors. This proves Stop hooks worked, but it does NOT prove PostToolUse hooks are healthy — they failed but Copilot tolerated the failures.
- **H1 unknown**: Why does Stop hook succeed when 12 other events fail? Different dispatch path? Different command form in settings.json? Not yet verified.
- **H2 counter**: shard-write itself IS race-safe (per-worker distinct filenames + atomicWriteFileSync). Only the merge orchestration is sequential and fire-and-forget.
- **H3 counter**: atomicWriteFileSync implementation is solid (write+fsync+rename). PRD file IS separately persisted and stories `passes:true` survive a crash. ralph-state.json itself is crash-tolerant (JSON.parse wrapped in try/catch).

## Per-Lane Critical Unknowns

- **Lane 1**: Why does Stop hook succeed when 12 other event hooks fail with `node:internal/main/eval_stdin`? Does Stop use a different command form in `~/.copilot/settings.json`, a different Copilot dispatch path, or both? (Resolving this answers the fix scope.)
- **Lane 2**: Does live `copilot -p` output the verdict keyword (APPROVE/ITERATE/REJECT) on its own line in stdout? Or does Copilot wrap it in reasoning, making detectVerdict's line-only match always return null? (Determines whether verify-phase needs a strictness change or a prompt-template change.)
- **Lane 3**: Does Copilot in `--autopilot` mode actually honor `{kind: "advise"}` hook responses by surfacing the text to the model? Or does autopilot suppress hook output? (Determines whether preemptive-compaction can ever work as designed.)

## Rebuttal Round

- **Best rebuttal to H1 (Node eval-stdin)**: "Maybe Copilot is invoking node with a flag like `--input-type=module` only for some events, and the Stop event happens to be one Copilot dispatches differently."
- **Why H1 still leads**: The log stack trace is unambiguous — `node:internal/main/eval_stdin` is a specific Node internal that only activates in eval-from-stdin mode. The rebuttal would need a different stack frame; this exact frame appears in 64 failure instances.
- **Best rebuttal to H2 (multi-agent gaps)**: "The user can manually handle these gaps; orchestrator-v1 worked end-to-end in Phase A smoke." 
- **Why H2 still leads**: Phase A smoke only used ralph (which works). It did NOT exercise ralplan handoff, team workers, or verify-phase live. Each of those paths is broken in a way that's testable but not yet tested.
- **Best rebuttal to H3 (long-running gaps)**: "Phase A smoke completed in 1m47s; long runs may never be needed."
- **Why H3 still leads**: User explicitly stated "长时间运行" as a priority. 1m47s is not a long run; the gaps don't manifest at 2 iterations.

## Convergence / Separation Notes

The three hypotheses do NOT converge to a single root cause. They are three independent layers, each with its own failure mode:

- **Layer 1 (hook dispatch)** = environmental/integration issue (Node 24 + Copilot 1.0.52-4 interaction). Fixable in omcp via hook command format change in setup.ts.
- **Layer 2 (multi-agent)** = code-level bugs/gaps. Fixable in omcp via several discrete patches (handoff flag, timeout, omc-style stage state, watchdog).
- **Layer 3 (long-running resilience)** = design-level gaps. Fixable in omcp via crash recovery, progress.txt cap, compaction-hook redesign.

Completing orchestrate (the user's stated goal) requires fixing all three layers. They are NOT alternative explanations — they are three independent things to repair.

## Most Likely Explanation

omcp at v1.0.0 is "verified working for the happy path of one specific scenario (ralph with a 2-story PRD)" but has **three orthogonal layers of incompleteness** that prevent it from being a production-grade orchestrator:

1. The hook layer's dispatch breaks on Windows + Node 24 for 12 of 13 events (loud but non-fatal noise; orchestration succeeds anyway because Stop hook works).
2. The multi-agent layer has critical chain breaks (ralplan→ralph handoff disabled, verify-phase can hang, never tested live).
3. The long-running layer is brittle (no crash recovery, unbounded progress growth, compaction goes silent after 3 firings).

To "complete orchestrate like omc," all three layers need work — not because they're alternatives, but because they're sequential prerequisites for "production-ready long-running multi-agent."

## Critical Unknown (synthesized)

The single most important fact to resolve next: **why does the Stop hook succeed when the other 12 events fail with `node:internal/main/eval_stdin`?** Answering this would simultaneously (a) explain why orchestration worked in Phase A despite hook noise, (b) point to the exact fix for the other 12 events (whatever Stop is doing differently is the right pattern), and (c) reveal whether the fix is in the hook command format (cheap), the Copilot version (out of scope), or the way omcp registers hooks in settings.json (medium).

## Recommended Discriminating Probe

```powershell
# 1. Read the actual Stop hook entry in settings.json — compare format to PostToolUse:
node -e "const s=JSON.parse(require('fs').readFileSync('C:/Users/runjiashi/.copilot/settings.json','utf8')); console.log('Stop:', JSON.stringify(s.hooks.Stop, null, 2)); console.log('PostToolUse:', JSON.stringify(s.hooks.PostToolUse, null, 2));"

# 2. Reproduce the failing hook dispatch manually with the exact form Copilot uses:
$json = '{"hook_event_name":"PostToolUse","session_id":"test","cwd":"./","tool_name":"Edit","tool_input":{},"tool_result":{}}'
$json | omcp hook fire PostToolUse --json
echo "EXIT=$LASTEXITCODE"

# 3. If (2) reproduces the eval_stdin error, test the alternate command form:
$json | node 'C:\Users\runjiashi\oh-my-copilot-r2\dist\cli\omcp.js' hook fire PostToolUse --json
echo "EXIT=$LASTEXITCODE"
```

If Step 1 reveals Stop uses a different command format (e.g. wraps in `cmd /d /c` or uses an absolute node path), the fix is to apply the same format to all 13 events in `src/cli/commands/setup.ts`'s hook-wiring logic. Cost: a 10-line change + test. Impact: clears the 64 errors per Phase A smoke + makes all 13 hook advise/modify-args paths work.
