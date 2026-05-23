# Team + Critic Verification Protocol

This document codifies the 5-step recurring verification protocol used after every execution
phase in omcp's orchestrator workflow. It is referenced by `docs/plans/orchestrator-v1-ralplan.md`
Phase 5 and is the acceptance criterion for the `critic-verify-loop` skill (Phase 4).

The protocol runs in independent context — neither the architect nor the critic agent inherits
the executor's session memory. This is the core invariant: fresh eyes catch drift and
rationalization that the implementing agent cannot see.

---

## Step 1: Executor Diff and Acceptance Criteria

The phase executor (the agent or worker that implemented the phase) produces:

1. A **git diff** (or equivalent file-level changeset) covering all files modified during the phase.
2. A **list of acceptance criteria** drawn verbatim from the PRD / plan section for that phase.
3. A brief **evidence map** linking each criterion to the specific commit, file, or test that
   satisfies it.

The executor writes these three artefacts to a single submission block and posts them to the
verification channel (team message, shared notepad, or `.omcp/state/verification/<phase-id>-submission.md`).
The submission must be self-contained: the reviewing agents must not need to ask follow-up questions
to perform their review.

**What counts as a complete submission:**

- Diff includes every file changed (no cherry-picking).
- Every criterion in the PRD section is addressed — explicitly marked PASS, PARTIAL, or NOT-MET.
- NOT-MET items include a brief explanation of why and what the proposed resolution is.

---

## Step 2: Architect Review

A **fresh architect agent** (new session, no prior conversation memory of this phase) receives the
submission from Step 1 and reviews it against the acceptance criteria.

The architect returns one of three verdicts:

| Verdict | Meaning |
|---------|---------|
| `APPROVE` | All criteria met; diff is consistent with the stated design; no blocking issues. |
| `ITERATE` | One or more criteria not met, or diff introduces a design inconsistency. Specific edits required (enumerated). |
| `REJECT` | Fundamental misalignment with the plan's principles or a critical invariant violation. Cannot be resolved by a minor revision. |

The architect's output must include:

- The verdict keyword on its own line.
- For ITERATE/REJECT: a numbered list of required changes with file/line references where applicable.
- For APPROVE: a one-paragraph rationale confirming the key design properties hold.

**Fresh-context requirement:** the architect must not be the same agent instance that executed the
phase. Spawn a new `copilot -p` session or equivalent isolated context. The `omcp verify <phase-id>`
CLI verb (see placeholder below) automates this spawn.

---

## Step 3: Critic Cross-Check

A **fresh critic agent** (independent context, also no prior session memory) receives both the
executor's submission (Step 1) and the architect's review (Step 2).

The critic checks for:

1. **Principle–option consistency** — does the diff actually implement the chosen option (e.g., Option A
   vs Option B) rather than a hybrid that was explicitly rejected?
2. **Fair alternatives** — did the architect's ITERATE/REJECT correctly identify alternatives, or did
   it dismiss viable approaches without justification?
3. **Risk mitigation** — are the pre-mortem risks from the plan addressed, or at minimum acknowledged?
4. **Concrete verification steps** — are the acceptance criteria testable (passing tests, observable
   probe output), or are they aspirational assertions that cannot be falsified?

The critic returns the same three verdicts (`APPROVE` / `ITERATE` / `REJECT`) with the same output
format as the architect. The critic is NOT required to agree with the architect — divergence is
useful signal.

---

## Step 4: Phase Pass Condition

A phase **passes** when **both** the architect (Step 2) and the critic (Step 3) return `APPROVE`.

Partial approval is not a pass:

| Architect | Critic | Outcome |
|-----------|--------|---------|
| APPROVE | APPROVE | **Phase passes** — proceed to next phase |
| APPROVE | ITERATE | Phase does not pass — executor revises per critic's list |
| ITERATE | APPROVE | Phase does not pass — executor revises per architect's list |
| ITERATE | ITERATE | Phase does not pass — executor revises against merged objection list |
| REJECT (either) | any | Stop — escalate to user (see Step 5) |

When both return APPROVE, the executor writes a `.omcp/state/verification/<phase-id>-<run-id>.json`
record (via `atomicWriteFileSync`, path via `assertSafeSlug`) and the phase is closed.

---

## Step 5: Iterate or Reject Loop

If either reviewer returns `ITERATE`, the executor revises the implementation and re-submits
(back to Step 1). The loop counter increments on each re-submission.

**Maximum iterations: 5.** If the phase has not passed by iteration 5, the protocol terminates
with a REJECT and escalates to the user. The executor must NOT silently continue past 5 iterations
or attempt to satisfy the criteria by weakening them.

**Loop behaviour:**

```
iteration 1 → submit → architect + critic review → ITERATE
iteration 2 → revise + submit → architect + critic review → ITERATE
...
iteration 5 → revise + submit → architect + critic review → still not APPROVE → ESCALATE
```

On escalation the executor writes a `.omcp/state/verification/<phase-id>-escalation.json` record
containing: the iteration count, the last pair of verdicts, and the unresolved objection list.
The user decides whether to descope, accept partial completion, or restart the phase.

**Exit codes for `omcp verify <phase-id>` (future CLI verb — see placeholder below):**

| Code | Meaning |
|------|---------|
| 0 | Both APPROVE — phase passed |
| 1 | REJECT after 5 iterations — escalated |
| 2 | Invocation error (bad phase-id, missing submission file, etc.) |

---

## Phase 1.5 Closure Examples (3 Parallel Tracks)

The following examples are drawn from the Phase 1.5 parallel research closure that preceded
orchestrator-v1 execution. They illustrate how the protocol applies to concrete, bounded tasks.

### Track A — Hook spawn mechanism trace

**Executor submission:** diff of `.omc/research/phase-1.5-trace-A.md` + evidence map showing
bundle grep results for the `VKi` binary resolver, `Xer` hook executor, and `spawn()` call site.

**Architect verdict:** APPROVE. Rationale: the trace correctly identified `pwsh.exe -nop -nol -c`
as the dispatch form on win32; the stdin-pipe evidence matches Copilot 1.0.52-4 observed behaviour;
no contradictory evidence in the diff.

**Critic verdict:** APPROVE. All four criteria (binary path, spawn args, stdin handling, `_vsCodeCompat`
effect) mapped to evidence. No cherry-picked lines — the full surrounding context was included.

**Outcome:** Phase 1.5 Track A passed on iteration 1.

---

### Track B — Hook spawn mechanism trace (parallel verifier)

**Executor submission:** diff of `.omc/research/phase-1.5-trace-B.md` + evidence map. Track B
independently reproduced Track A's findings using a different grep strategy (pattern-based vs.
line-range extraction) and confirmed: `VKi("pwsh")` returns `"pwsh.exe"` on win32; `Xer` calls
`spawn(binary, ["-nop","-nol","-c", cmd], {cwd, env, timeout})`; no `shell:true`.

**Architect verdict:** APPROVE. The two independent traces agree on all four observable facts;
the discrepancy in function naming (`m2` vs `Xer`) was correctly attributed to minifier aliasing.

**Critic verdict:** APPROVE. Divergent naming noted and explained; both traces arrive at the
same behavioural conclusion; risk of false agreement mitigated by the independent grep methodology.

**Outcome:** Phase 1.5 Track B passed on iteration 1. Dual-trace confirmation elevates confidence
from single-trace finding to reproduced result.

---

### Track C — OMC hook command template root-cause

**Executor submission:** diff of `.omc/research/phase-1.5-trace-C.md` + evidence map tracing
`omc/hooks/hooks.json:8` Bash-style `"$CLAUDE_PLUGIN_ROOT"/scripts/run.cjs` through PowerShell 7's
string interpolation rules to the `SyntaxError: Unexpected token ':'` symptom.

**Architect verdict (initial):** ITERATE. Required edit: add explicit PowerShell test showing the
`$var/suffix` vs `"$env:VAR/suffix"` difference; the current evidence cited the symptom but did
not demonstrate the fix path.

**Critic verdict (initial):** ITERATE (independent). Cross-check found the alternatives section
weak — the doc claimed "only fix is env-var form" without showing the absolute-path alternative
that is equally valid for omcp's own wiring.

**Executor revision (iteration 2):** added PowerShell demonstration and absolute-path alternative
to the evidence map.

**Architect verdict (iteration 2):** APPROVE.

**Critic verdict (iteration 2):** APPROVE. Both fixes documented; pre-mortem risk (PATH resolution
failure) addressed via the absolute-path fallback.

**Outcome:** Phase 1.5 Track C passed on iteration 2. The ITERATE-then-APPROVE cycle is the
expected happy path for tasks with an initially incomplete evidence map.

---

## Future CLI Verb Placeholder: `omcp verify <phase-id>`

The `omcp verify <phase-id>` command is the automated form of this protocol. It is planned for
Phase 4 of orchestrator-v1 (`critic-verify-loop` skill) and is **not yet implemented**.

When implemented, it will:

1. Read the submission from `.omcp/state/verification/<phase-id>-submission.md`.
2. Spawn a fresh `copilot -p` session with the architect review prompt.
3. Parse the architect's verdict using `detectArchitectApproval` / `detectArchitectRejection`
   from `src/lib/ralph-state.ts`.
4. Spawn a second fresh session for the critic cross-check.
5. Apply the Step 4 pass condition and loop per Step 5.
6. Write the result to `.omcp/state/verification/<phase-id>-<run-id>.json`.
7. Exit with code 0 (pass), 1 (reject after 5 iterations), or 2 (invocation error).

The verb will be registered in `src/cli/omcp.ts` per invariant 8 (CLI registration), dispatching
to `src/cli/commands/critic-verify-loop.ts`.

Until this verb exists, the protocol is run manually by the team lead posting the submission to
fresh agent contexts and collecting verdicts by message.
