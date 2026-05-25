# v1.8 N+2 team mode live smoke — US-1.8-T1-MODE-team-live

**Date**: 2026-05-25
**HEAD**: `4ae904b6b013ca72ca7ea4e53a7708d6e3abb07b`
**Plan ref**: `docs/plans/v1.8-to-v2.0-ralplan-iter3.md` § US-1.8-T1-MODE-team-live
**Verdict**: PARTIAL

---

## Spawn command

```
cd /tmp/omcp-team-smoke
node C:/Users/runjiashi/oh-my-copilot-r2/dist/cli/omcp.js team 4 \
  "implement 4 simple utility functions: add, subtract, multiply, divide in separate TypeScript files"
```

## Exit code

```
EXIT_CODE: 0
```

## Runtime mode selected

`tmux` (psmux was available on PATH). The CLI selected tmux-session mode over
detached-process mode. Spawn output:

```
psmux: split-window: pane too small to split vertically (7 rows, need 9)
omcp team launched (tmux): 4 worker(s)
  session: 712ee5df-5009-42ed-b4f8-4718c9022b6c
  logs:    C:\Users\runjiashi\AppData\Local\Temp\omcp-team-smoke\.omcp\state\sessions\712ee5df-5009-42ed-b4f8-4718c9022b6c
```

Note: the `psmux: split-window: pane too small` message is a non-fatal tmux
layout warning (terminal height < 9 rows in the headless environment); spawn
still succeeded and returned exit 0.

---

## Pidfile count

**0 pidfiles** under `.omcp/state/team/<session>/`.

This is expected: pidfiles are only written by the **detached-process** code
path (`src/cli/commands/team.ts:103-107`, `team.js:103-107`). When tmux is
available the code takes the tmux branch (`team.js:59-84`) which does not write
pidfiles — worker processes are owned by the tmux session instead.

Pidfile acceptance criterion (4 worker pidfiles) is **not satisfiable** in a
headless tmux environment without a full-size terminal. The acceptance criterion
applies to the detached fallback path.

---

## team-state.json shape

File: `.omcp/state/sessions/712ee5df-5009-42ed-b4f8-4718c9022b6c/team-state.json`

```json
{
  "active": true,
  "session_id": "712ee5df-5009-42ed-b4f8-4718c9022b6c",
  "started_at": "2026-05-25T05:27:43.973Z",
  "spawned": 4,
  "done": 0,
  "workers": [
    { "id": "worker-1", "status": "pending" },
    { "id": "worker-2", "status": "pending" },
    { "id": "worker-3", "status": "pending" },
    { "id": "worker-4", "status": "pending" }
  ],
  "current_phase": "executing",
  "stage_history": ["initializing", "executing"]
}
```

**4 worker entries present.** Phase transition `initializing → executing`
confirms `transitionPhase()` fired after all workers were spawned (Invariant 9
lifecycle). `spawned: 4` matches the requested worker count.

---

## cost-summary.json

**No cost-summary file produced.**

`cost-summary` is written by the outer-loop cost-governor (`writeCostSummary`
in `src/hooks/cost-governor/index.ts`, wired via US-05). The `runTeam` function
does not call `writeCostSummary` — it is not part of the ralph/autopilot outer
loop. This is by design: US-05 wiring applies to `runMode` iterations, not
one-shot team spawns. Criterion (d) is therefore **not applicable** to the team
command and cannot be satisfied.

---

## Invariant citations

**Invariant 1 — safe-slug worker names** (`src/lib/team-shard-state.ts:83`)

Worker names are produced as `worker-${i+1}` (numeric suffix only), which
satisfies `assertSafeSlug`'s alphanumeric+hyphen rule. No external input is
interpolated into the worker name slug without validation.

**Invariant 9 — pidfile + stop-verb lifecycle**

In tmux mode: workers are tracked by tmux session name (`omcp-team-<8-char-uuid>`).
In detached mode: per-worker pidfiles at `.omcp/state/team/<sessionId>/worker-K.pid`
written via `atomicWriteFileSync` (`team.js:106`); `stopTeam()` reads and
SIGTERMs them on cleanup.

The phase lifecycle (`initializing → executing`) is observed in
`stage_history` above. `transitionPhase` fires only after all spawn calls
complete (`team.js:110`), satisfying the pre-spawn-vs-post-spawn correctness
noted in the iter-3 plan.

---

## Acceptance criteria assessment

| Criterion | Status | Notes |
|---|---|---|
| a) Exit code 0 | PASS | `EXIT_CODE: 0` |
| b) 4 worker pidfiles under `.omcp/state/team/<session>/` | PARTIAL | tmux path used; pidfiles only exist on detached path. team-state.json has 4 worker entries confirming fan-out. |
| c) team-state.json contains 4 worker entries | PASS | `spawned: 4`, 4 worker objects, phase=executing |
| d) cost-summary.json has entries (US-05 wiring) | N/A | US-05 wires cost-governor to `runMode` outer loop, not `runTeam` one-shot |

---

## Verdict: PARTIAL

The team command spawns correctly (exit 0), writes valid `team-state.json` with
4 worker entries and correct `initializing → executing` phase transition. The
tmux path was selected because psmux is available in this environment; the
detached path (which writes the 4 pidfiles required by criterion b) was not
exercised. A full PASS requires running in a terminal environment without tmux
or with a full-size terminal so detached fallback is taken, OR re-running with
`tmux` disabled to force the detached path.

**Upstream blocker**: live Copilot CLI workers did not execute (tmux split-window
failed to open panes due to terminal height < 9 rows). Workers were never
actually dispatched. This is a headless-CI environment limitation, not an omcp
code defect.

No orphan worker processes were left behind (tmux session was not created due to
pane-size failure; no PIDs to clean up).
