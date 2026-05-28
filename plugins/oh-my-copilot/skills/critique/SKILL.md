---
name: critique
description: Pre-push diff gate — dispatches critic in mode:critique for a 5-step Devil's Advocate review of unpushed commits before they leave the branch
level: 3
model:
  claude: claude-opus-4.7
  gpt: gpt-5.4
triggers:
  - "critique"
  - "review before push"
  - "pre-push gate"
  - "pre-push review"
  - "critique my diff"
  - "critique my commit"
---

<!--
  ADR-RP-06: PORT-ROBIN (justified divergence)
  omc oh-my-claudecode@4.9.3 has no `critique` skill (verified — none of 32 omc skills match).
  This is a Robin-extension filling a genuine load-bearing capability gap that omc also lacks.
  Divergence justified: pre-push commit gating prevents broken code from reaching remote branches
  and is architecturally distinct from omc's ralplan/ralph consensus loop.

  Cross-link to deep-review:
    critique    = unpushed-commit-scoped only (N..HEAD or --cached diff)
    deep-review = PR/branch-scoped (multi-pass orchestration across a full branch)
  Do NOT use critique for PR-level review; do NOT use deep-review as a pre-push gate.

  This skill dispatches `oh-my-copilot:critic` with `mode: critique` — the extended critic
  from RP-05 (commit 465b415). A separate devils-advocate agent was considered and rejected:
  omc has no such agent; omc's built-in Devil's Advocate at Phase 2 Step 7 confirms
  extend-not-split is the omc-aligned shape (RP-05-revised, v3/v4 consensus).
-->

<Purpose>
Critique is a pre-push diff gate for unpushed commits. It dispatches the `critic` agent in
`mode: critique` to run a structured 5-step review anchored on the question:
"Should this diff be pushed as-is, or does it need changes first?"

Critique operates on the narrowest possible scope — only the unpushed commits on the
current branch (or the staged diff). It is not a full code review; it is a focused gate
that catches regressions, invariant violations, missing tests, and debug artifacts before
they leave the branch.

This is the omcp / GitHub Copilot CLI port of the upstream Robin `critique` pattern.
It uses Copilot's slash + agent dispatch surface, not Claude-Code-only tool envelopes.
</Purpose>

<Use_When>
- You are about to push commits and want a Devil's Advocate review first
- You say "critique", "pre-push review", "review before push", "critique my diff/commit"
- You want a BLOCK / APPROVE-WITH-NOTES / APPROVE verdict on unpushed work
- The diff is commit-scoped (1–N unpushed commits on the current branch)
- You want invariant checks (banned tokens, mirror sync, 4-manifest sync) verified before push
</Use_When>

<Do_Not_Use_When>
- The scope is a full PR or multi-commit branch comparison — use `/oh-my-copilot:deep-review` instead
  (deep-review = PR/branch-scoped 4-pass orchestration; critique = unpushed-commit-scoped only)
- You want a plan / ralplan reviewed for quality — use `/oh-my-copilot:ralplan` or the `critic` agent directly
- You want an architectural analysis — use the `architect` agent via `/fleet architect`
- The branch has already been pushed and you want post-push review — use `/oh-my-copilot:deep-review`
- There are no unpushed commits (`git status` shows nothing to push)
</Do_Not_Use_When>

<Why_This_Exists>
Pre-push gates prevent the most expensive class of bug: the one that reaches the remote.
Without a structured gate, developers catch only the issues visible in a quick self-review.
The 5-step protocol (orientation → Devil's Advocate → pre-mortem → gap check → verdict)
reliably surfaces three classes of issue that self-review misses:

1. Regression paths — code that works locally but breaks an existing behavior
2. Invariant violations — the 9 project invariants (safe-slug, atomicWrite, 4-manifest sync,
   valid events, subagentStart, escapeRegExp, no banned tokens, CLI registration, pidfile+stop-verb)
3. Gap artifacts — missing tests for new branches, unsynced mirrors, debug code left in

The `critic` agent in `mode: critique` runs the `<Critique_Mode_Protocol>` section (added in
RP-05, commit 465b415) which mirrors omc critic Phase 2 Step 7 Devil's Advocate pattern,
anchored on diff review rather than plan review.

Telemetry via `omcp skill-invocation-emit` answers PM-1 at v2.4 review: "is this skill used?"
</Why_This_Exists>

<Execution_Policy>
- Always collect the diff FIRST before dispatching the critic
- Default diff scope: all unpushed commits on current branch (`git log @{u}..HEAD` / `git diff @{u}`)
- If upstream is not configured, fall back to `git diff HEAD~1..HEAD` (last commit only); warn the user
- Pass the diff plus optional context (PR description, linked plan section) to the critic
- Dispatch critic with `[mode: critique]` prefix so the Critique_Mode_Protocol activates
- Telemetry: emit at lifecycle points (started / completed / failed) — best-effort, never block on failure
- Critic is read-only: it returns a verdict; it does NOT modify files
- After BLOCK verdict: show exactly what must change, then stop — do not push
- After APPROVE-WITH-NOTES: show advisory notes, push is the user's call
- After APPROVE: confirm clean, user may push
</Execution_Policy>

<Steps>

## Step 1: Collect Diff

Determine the diff scope from user args or auto-detect:

**Auto-detect scope (default)**:
```bash
# Check if upstream is configured
git rev-parse --abbrev-ref --symbolic-full-name @{u} 2>/dev/null
```

If upstream exists:
```bash
# All unpushed commits
git log --oneline @{u}..HEAD
git diff @{u}..HEAD
```

If no upstream (fresh branch):
```bash
# Fall back to last commit; warn user that upstream is not configured
git diff HEAD~1..HEAD
# Warn: "No upstream configured — reviewing last commit only. Run `git push -u origin <branch>` after."
```

If user passed `--staged` or `--cached`:
```bash
git diff --cached
```

If user passed explicit range (e.g., `HEAD~3..HEAD`):
```bash
git diff HEAD~3..HEAD
```

Collect also:
- `git log --oneline <scope>` for commit summary context
- Optional: PR description or plan section if user provides it

If the diff is empty (nothing to review), report "No unpushed changes found — nothing to critique" and stop.

**Emit telemetry (started)**:
```
omcp skill-invocation-emit --skill critique --event started \
  --detail '{"scope":"<scope>","commitCount":<N>}'
```
Non-zero exit from this verb is observability-only — never block on telemetry failure.

## Step 2: Dispatch Critic (mode: critique)

Dispatch the `critic` agent with `[mode: critique]` to activate the Critique_Mode_Protocol:

```
/fleet critic --name critique-gate --model {claude=opus,gpt=gpt-5.4} \
  --prompt "[mode: critique]

Diff scope: <scope> (<N> commits, <net LoC> lines)

--- DIFF ---
<diff output>
--- END DIFF ---

Commit context:
<git log --oneline output>

<optional: PR description or plan section>

Apply the Critique_Mode_Protocol (5 steps):
  1. Diff Orientation — files changed, net LoC, additive vs behavioral
  2. Devil's Advocate — for each logical chunk: strongest argument against pushing it
  3. Quick Pre-Mortem — 3 concrete failure scenarios
  4. Gap Check — missing tests, mirror sync, invariants
  5. Verdict — BLOCK / APPROVE-WITH-NOTES / APPROVE with justification

Invariants to check (docs/architecture/invariants.md):
  safe-slug, atomicWrite, 4-manifest sync, valid events, subagentStart,
  escapeRegExp, no banned tokens (Invariant 7), CLI registration, pidfile+stop-verb"
```

Wait for critic output.

## Step 3: Parse Verdict

Extract verdict line from critic output:

- `**VERDICT: BLOCK**` → proceed to Step 4a
- `**VERDICT: APPROVE-WITH-NOTES**` → proceed to Step 4b
- `**VERDICT: APPROVE**` → proceed to Step 4c

If critic output is malformed or missing a verdict line, treat as BLOCK and report the parse failure.

## Step 4a: BLOCK — Stop Push

Present the full critic output to the user with emphasis on blocking findings.

Summary format:
```
=== CRITIQUE VERDICT: BLOCK ===

Blocking findings (must fix before push):
<list of CRITICAL/unmitigated MAJOR findings from critic output>

Pre-Mortem scenarios present in diff:
<unmitigated scenarios from critic output>

Gap check failures:
<missing tests / mirror sync issues / invariant violations>

Do NOT push until the above are resolved. Fix, re-commit, then run /oh-my-copilot:critique again.
```

**Emit telemetry (failed)**:
```
omcp skill-invocation-emit --skill critique --event failed \
  --detail '{"verdict":"BLOCK","blockingCount":<N>}'
```

Stop. Do not proceed with push.

## Step 4b: APPROVE-WITH-NOTES — Advisory

Present the full critic output to the user.

Summary format:
```
=== CRITIQUE VERDICT: APPROVE-WITH-NOTES ===

Advisory notes (push is your call):
<list of MINOR findings / mitigated MAJORs from critic output>

No blocking issues found. You may push, but review the notes above first.
```

**Emit telemetry (completed)**:
```
omcp skill-invocation-emit --skill critique --event completed \
  --detail '{"verdict":"APPROVE-WITH-NOTES","noteCount":<N>}'
```

## Step 4c: APPROVE — Clean

Present the verdict to the user.

```
=== CRITIQUE VERDICT: APPROVE ===

No findings above MINOR threshold. Diff is clean — safe to push.
```

**Emit telemetry (completed)**:
```
omcp skill-invocation-emit --skill critique --event completed \
  --detail '{"verdict":"APPROVE"}'
```

</Steps>

<Telemetry>
Every critique session emits telemetry to `.omcp/state/skill-invocations.jsonl`:

1. **At Step 1 (after diff collected)**: `--event started` with `{scope, commitCount}` detail.
2. **At Step 4b or 4c (approve paths)**: `--event completed` with `{verdict, noteCount?}` detail.
3. **At Step 4a (block path)**: `--event failed` with `{verdict:"BLOCK", blockingCount}` detail.

All telemetry calls use:
```
omcp skill-invocation-emit --skill critique --event <started|completed|failed> [--detail <json>]
```

Telemetry is best-effort. Non-zero exit from the verb MUST NOT halt the gate — the critic's
verdict owns the push decision; the verb only owns the side-channel.

The aggregate log answers PM-1: "is this skill being used?" v2.4 review queries the file
for adoption signal. Per ADR-RP-skill-telemetry, the log schema is additive and X1-compatible.
</Telemetry>

<Verdict_Reference>
| Verdict | Meaning | Action |
|---|---|---|
| **BLOCK** | One or more CRITICAL findings, or an unmitigated MAJOR (regression, broken invariant, debug code) | Must fix before push |
| **APPROVE-WITH-NOTES** | Only MINOR findings or MAJORs with documented mitigations | Safe to push; notes are advisory |
| **APPROVE** | No findings above MINOR threshold | Push is clean |

A BLOCK verdict means the critic found at least one of:
- A regression path (new code breaks existing behavior at a file:line)
- A broken invariant from `docs/architecture/invariants.md`
- Debug artifacts left in (`console.log`, `TODO`, `HACK`, `debugger`)
- Missing test for a new conditional branch
- Mirror out of sync (agents/ not reflected in plugins/oh-my-copilot/agents/)
- Banned token present (Invariant 7 — see docs/architecture/invariants.md for the full list)
</Verdict_Reference>

<Examples>
<Good>
User: "critique my last 2 commits before I push"

Skill collects: `git diff HEAD~2..HEAD` (2 commits, +45/-12 lines)
Skill emits: `omcp skill-invocation-emit --skill critique --event started --detail '{"scope":"HEAD~2..HEAD","commitCount":2}'`
Skill dispatches critic with [mode: critique] prefix.
Critic runs 5-step protocol. Finds: MINOR — one `console.log` left in a test helper.
Verdict: APPROVE-WITH-NOTES.
Skill presents advisory note. User removes the log, re-commits, re-runs critique.
Second run: APPROVE. User pushes.
Skill emits: `omcp skill-invocation-emit --skill critique --event completed --detail '{"verdict":"APPROVE"}'`

Why good: Catches the debug artifact before push, clean loop, telemetry emitted at both start and end.
</Good>

<Good>
User: "critique" (no args — auto-detect unpushed commits)

Skill detects 1 unpushed commit via `git diff @{u}..HEAD`.
Critic finds: CRITICAL — new CLI command added but not registered in `src/cli/index.ts`
(Invariant 8: CLI registration). Verdict: BLOCK.
Skill presents blocking finding with file:line. User fixes, re-commits.
Skill emits: `omcp skill-invocation-emit --skill critique --event failed --detail '{"verdict":"BLOCK","blockingCount":1}'`

Why good: Catches invariant violation before it pollutes remote, exact fix provided.
</Good>

<Bad>
Using critique for a full PR with 40 commits across 3 feature branches.
Use `/oh-my-copilot:deep-review` instead — critique is unpushed-commit-scoped only;
deep-review is PR/branch-scoped with 4-pass orchestration.
</Bad>
</Examples>

<Final_Checklist>
- [ ] Diff collected and scope confirmed (unpushed commits or --cached or explicit range)
- [ ] Telemetry `started` event emitted before critic dispatch
- [ ] Critic dispatched with `[mode: critique]` prefix
- [ ] Verdict parsed: BLOCK / APPROVE-WITH-NOTES / APPROVE
- [ ] BLOCK: blocking findings presented; user told exactly what to fix; push NOT allowed
- [ ] APPROVE-WITH-NOTES: advisory notes presented; push is user's call
- [ ] APPROVE: clean confirmation presented
- [ ] Telemetry `completed` (approve paths) or `failed` (block path) event emitted
- [ ] No files modified by this skill (critic is read-only; only the user modifies code)
</Final_Checklist>
