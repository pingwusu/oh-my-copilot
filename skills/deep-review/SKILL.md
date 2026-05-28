---
name: deep-review
description: 4-pass parallel PR/branch review (security, correctness, architecture, docs+tests) with consolidation verdict and actionable findings
level: 4
model:
  claude: claude-opus-4.7
  gpt: gpt-5.4
triggers:
  - "deep review"
  - "deep-review"
  - "review this PR"
  - "review this branch"
  - "review my changes"
  - "full code review"
  - "4-pass review"
---

<Purpose>
Deep-Review orchestrates a structured 4-pass review of a PR or branch diff by
dispatching specialist agents in parallel, then consolidating their findings
into a single actionable verdict. Unlike `critique` (which reviews unpushed
local commits before push), `deep-review` targets an already-named PR or
branch-scoped diff and delivers a formal review packet suitable for sharing
with collaborators.

This is the omcp / GitHub Copilot CLI port of Robin Norberg's `deep-review`
pattern. It uses Copilot slash + agent dispatch (`/fleet`, `/delegate`), not
Claude-Code-only tool envelopes. PORT-ROBIN-justified per ADR-RP-07:
4-pass orchestration capability gap that omc canonical also lacks.
</Purpose>

<Cross_Link>
- **`/oh-my-copilot:critique`** — pre-push review of unpushed local commits.
  Use `critique` before you push; use `deep-review` after a PR exists or when
  you want a formal branch-scoped review packet.
- **`/oh-my-copilot:deep-dive`** — root-cause investigation + requirements
  crystallisation. Use `deep-dive` when you need to understand WHY something
  works before reviewing HOW it is implemented.
- **`/oh-my-copilot:ralplan`** — consensus planning. Use after `deep-review`
  surfaces architectural findings that require a new plan.
</Cross_Link>

<Use_When>
- User says "review this PR", "deep review", "review my branch", "full code review"
- A PR number, branch name, or explicit diff range is provided
- Stakeholders need a formal written review (not just a local pre-push check)
- The change touches security-sensitive code (auth, crypto, permissions, data)
- The change is architecturally significant (new patterns, large surface area)
- Multiple concern dimensions (security + correctness + architecture + tests)
  need parallel coverage without one domain drowning out another
</Use_When>

<Do_Not_Use_When>
- User wants a quick sanity check on uncommitted work — use `/oh-my-copilot:critique`
- User has not pushed yet and is not ready for a formal review
- The diff is trivially small (1-2 lines) — inline response is sufficient
- User explicitly says "skip the review" or "just merge"
</Do_Not_Use_When>

<Why_This_Exists>
Code reviews fail when a single reviewer must context-switch between four
distinct concern dimensions: security vulnerabilities, logical correctness,
architectural coherence, and test/doc coverage. Each dimension requires a
different mental model. Serialising them through one reviewer produces shallow
coverage on at least two dimensions.

Deep-Review parallelises the four passes so each specialist agent can focus
entirely on its domain. The consolidation phase then synthesises findings into
a single verdict, de-duplicates overlapping issues, and surfaces a ranked
action list. The result is a review that is simultaneously broader and deeper
than a single-pass review.

The validation step ensures that every finding is testable and actionable —
no vague "this could be better" comments make it into the output.
</Why_This_Exists>

<Execution_Policy>
- Parse the target (PR number, branch name, or diff range) in Phase 1 before
  dispatching any agents — never dispatch without a concrete diff anchor
- All four specialist agents run in parallel (Phase 2); do not wait for one
  to finish before starting another
- The consolidation agent (Phase 3) runs only after ALL four parallel agents
  return — it must see the full picture
- The validation step (Phase 4) must confirm every finding is testable and
  actionable before including it in the final verdict
- Telemetry is best-effort: a non-zero exit from `omcp skill-invocation-emit`
  MUST NOT block review progress
- Always respect `OMCP_MODEL_FAMILY` routing when spawning agents
</Execution_Policy>

<Skill_vs_Agent>
- **`deep-review` skill** (this file) = the orchestrator. Owns all 4 phases;
  dispatches agents; owns the final verdict.
- **`security-reviewer` agent** (`/fleet security-reviewer`) = Pass 1. Looks
  for injection, auth bypass, secret leakage, privilege escalation, unsafe
  deserialization, path traversal.
- **`code-reviewer` agent** (`/fleet code-reviewer`) = Pass 2. Looks for
  logic errors, off-by-ones, null dereferences, race conditions, incorrect
  error handling.
- **`architect` agent** (`/fleet architect`) = Pass 3. Looks for layering
  violations, coupling, naming inconsistency, missing abstraction, pattern
  drift from existing codebase conventions.
- **`critic` agent** (`/fleet critic --mode=review`) = Pass 4. Looks for
  missing tests, missing docs, untested branches, stale comments, misleading
  variable names.
- This skill MUST NOT itself read source code line-by-line; it delegates
  reading to the specialist agents and operates on their structured reports.
</Skill_vs_Agent>

<Steps>

## Phase 1: SETUP — parse target + emit start telemetry

Parse the user's invocation to extract:
- **Target**: One of:
  - PR number: `--pr 123` or bare `#123`
  - Branch name: `--branch feature/foo` or bare `feature/foo`
  - Diff range: `--range main..HEAD` or bare `main..HEAD`
  - Default (no arg): current branch vs default branch (`git diff $(git merge-base HEAD origin/main) HEAD`)
- **Scope** (optional, `--scope <path-glob>`): restrict diff to a subtree
- **Focus** (optional, `--focus security|correctness|architecture|docs`):
  skip the other passes and run only the named pass

Resolve the concrete diff:
```bash
# For PR number (requires gh CLI):
gh pr diff {pr_number} > .omcp/deep-review-diff.patch

# For branch or range:
git diff {range} > .omcp/deep-review-diff.patch

# Apply scope filter if --scope provided:
git diff {range} -- {scope_glob} > .omcp/deep-review-diff.patch
```

If the diff is empty, output "Nothing to review — diff is empty." and exit.

Emit start telemetry:
```
omcp skill-invocation-emit --skill deep-review --event started \
  --detail '{"target":"<target>","scope":"<scope|all>","focus":"<focus|all>"}'
```

## Phase 2: PARALLEL DISPATCH — 4 specialist agents

Spawn all four agents simultaneously. Do NOT wait for one before starting the
next. Pass each agent the resolved diff (`.omcp/deep-review-diff.patch`) and
the full context of the files changed.

### Pass 1 — Security (`/fleet security-reviewer`)
```
/fleet security-reviewer --name sr-pass1 \
  --model {claude=opus,gpt=gpt-5.4} \
  --prompt "Review the attached diff for security vulnerabilities.
            Diff: .omcp/deep-review-diff.patch
            Report format:
              FINDING: <title>
              SEVERITY: critical|high|medium|low|info
              FILE: <path>:<line>
              DESCRIPTION: <what and why>
              RECOMMENDATION: <specific fix>
            If no findings in your domain, output: PASS: no security findings."
```

Security pass covers: injection (SQL/command/path), authentication bypass,
authorization flaws, secret or credential leakage, unsafe deserialization,
prototype pollution, integer overflow/underflow, TOCTOU races, missing input
validation on trust boundaries.

### Pass 2 — Correctness (`/fleet code-reviewer`)
```
/fleet code-reviewer --name cr-pass2 \
  --model {claude=sonnet,gpt=gpt-5.2} \
  --prompt "Review the attached diff for correctness bugs.
            Diff: .omcp/deep-review-diff.patch
            Report format:
              FINDING: <title>
              SEVERITY: critical|high|medium|low|info
              FILE: <path>:<line>
              DESCRIPTION: <what and why>
              RECOMMENDATION: <specific fix>
            If no findings in your domain, output: PASS: no correctness findings."
```

Correctness pass covers: off-by-one errors, null/undefined dereferences, race
conditions, incorrect error propagation, wrong type coercions, unreachable
branches that should be reachable, broken invariants, incorrect algorithm
termination conditions.

### Pass 3 — Architecture (`/fleet architect`)
```
/fleet architect --name ar-pass3 \
  --model {claude=opus,gpt=gpt-5.4} \
  --prompt "Review the attached diff for architectural concerns.
            Diff: .omcp/deep-review-diff.patch
            Report format:
              FINDING: <title>
              SEVERITY: high|medium|low|info
              FILE: <path>:<line>
              DESCRIPTION: <what and why>
              RECOMMENDATION: <specific fix>
            If no findings in your domain, output: PASS: no architectural findings."
```

Architecture pass covers: layering violations (business logic in I/O layer),
excessive coupling, missing or premature abstraction, naming inconsistency,
pattern drift from existing codebase conventions, circular dependencies,
premature generalisation, God-object accumulation.

### Pass 4 — Docs + Tests (`/fleet critic --mode=review`)
```
/fleet critic --name dt-pass4 --mode review \
  --model {claude=sonnet,gpt=gpt-5.2} \
  --prompt "Review the attached diff for test and documentation gaps.
            Diff: .omcp/deep-review-diff.patch
            Report format:
              FINDING: <title>
              SEVERITY: high|medium|low|info
              FILE: <path>:<line>
              DESCRIPTION: <what and why>
              RECOMMENDATION: <specific fix>
            If no findings in your domain, output: PASS: no docs/tests findings."
```

Docs + Tests pass covers: missing unit tests for new code paths, missing
integration tests for changed interfaces, untested error branches, stale
inline comments, missing JSDoc/docstring for exported symbols, misleading
variable/function names, missing README updates for user-facing changes.

## Phase 3: CONSOLIDATION — synthesise into single verdict

After ALL four passes return, synthesise findings:

1. **De-duplicate**: merge findings that describe the same issue from multiple
   passes. Keep the highest severity rating. Note which passes flagged it.

2. **Cross-pass correlation**: identify findings where a correctness bug is
   also a security bug, or where an architecture concern explains a test gap.
   Surface these as "compound findings."

3. **Rank by severity × exploitability**: critical > high > medium > low > info.
   Within the same severity level, security findings rank before correctness,
   correctness before architecture, architecture before docs/tests.

4. **Verdict assignment**: one of:
   - **APPROVE** — zero critical/high findings; medium/low findings are
     advisory only
   - **APPROVE WITH NOTES** — zero critical findings; one or more high
     findings that are non-blocking with stated rationale
   - **REQUEST CHANGES** — one or more critical or blocking-high findings
     that must be resolved before merge
   - **BLOCKED** — diff is not reviewable (empty, corrupt, missing context);
     return reason and exit

5. **Summary section**: 2-4 sentences on the overall quality of the change,
   highlighting what was done well alongside what needs attention.

## Phase 4: VALIDATION — ensure findings are testable + actionable

Before emitting the final report, validate every finding in the consolidated
list against the following checklist. Silently drop any finding that fails
two or more checks (log the drop reason in the raw report).

Validation checklist (per finding):
- [ ] Has a specific FILE:LINE reference (not just "somewhere in the code")
- [ ] Has a concrete RECOMMENDATION (not "consider improving this")
- [ ] Is falsifiable: a developer can write a test or diff that proves the
      finding is resolved
- [ ] Is not a style preference without a stated convention source
- [ ] Does not duplicate a finding already in the list

If more than 50% of a pass's findings are dropped in validation, re-spawn
that specialist agent with an explicit "be more specific" prompt and repeat
Phase 2 for that pass only. Do not re-run the full parallel batch.

## Phase 5: REPORT + TELEMETRY

Output the final review report in the following structure:

```
=== Deep-Review Report ===
Target:  {target}
Verdict: {APPROVE | APPROVE WITH NOTES | REQUEST CHANGES | BLOCKED}
Passes:  security ✓ | correctness ✓ | architecture ✓ | docs+tests ✓

Summary:
{2-4 sentence overall assessment}

--- Findings ({N} total: {C} critical, {H} high, {M} medium, {L} low) ---

[{SEVERITY}] {FINDING TITLE}
  Pass(es): {security|correctness|architecture|docs+tests}
  File:     {path}:{line}
  Detail:   {description}
  Fix:      {recommendation}

... (remaining findings ranked by severity) ...

--- What Was Done Well ---
{1-3 bullet points on positive aspects of the change}

--- Raw Agent Reports ---
<security-reviewer-pass1>
{full raw output from Pass 1}
</security-reviewer-pass1>
<code-reviewer-pass2>
{full raw output from Pass 2}
</code-reviewer-pass2>
<architect-pass3>
{full raw output from Pass 3}
</architect-pass3>
<critic-pass4>
{full raw output from Pass 4}
</critic-pass4>
```

Emit completion telemetry:
```
omcp skill-invocation-emit --skill deep-review --event completed \
  --detail '{"target":"<target>","verdict":"<verdict>","findings":{"critical":<C>,"high":<H>,"medium":<M>,"low":<L>}}'
```

On any unrecoverable failure (diff resolution failed, all agents failed):
```
omcp skill-invocation-emit --skill deep-review --event failed \
  --detail '{"target":"<target>","reason":"<short error summary>"}'
```

Telemetry is best-effort — non-zero exit MUST NOT suppress the report.

</Steps>

<Telemetry>
Every deep-review session emits to `.omcp/state/skill-invocations.jsonl`:

1. **Phase 1 (after diff resolved)**: `--event started` with
   `{target, scope, focus}` detail.
2. **Phase 5 (after report output)**: `--event completed` with
   `{target, verdict, findings:{critical,high,medium,low}}` detail.
3. **On unrecoverable failure**: `--event failed` with
   `{target, reason}` detail.

All calls use the canonical verb signature:
```
omcp skill-invocation-emit --skill deep-review --event <started|completed|failed> [--detail <json>]
```

Telemetry is best-effort. A non-zero exit from the verb MUST NOT halt or
suppress review output — the review owns the diff analysis; the verb owns
only the observability side-channel.

The aggregate log answers PM-1: "is this skill being used?" v2.4 review
queries the file for adoption signal.
</Telemetry>

<Validation_Rules>
A finding is **actionable** when all of the following are true:
1. It cites a specific `FILE:LINE` (or at minimum a specific function name
   when line numbers are unavailable in the diff context)
2. Its RECOMMENDATION contains at least one concrete verb describing what to
   change (e.g., "add bounds check", "rotate secret", "extract to interface")
3. It is falsifiable — the developer can write a test or produce a diff that
   demonstrates the finding is resolved
4. It is not a pure style preference without citing a project convention source
   (e.g., "this project's eslint config", "CLAUDE.md naming rule")

A finding that fails two or more of the above is silently dropped from the
consolidated report. The raw pass output is always preserved in the "Raw
Agent Reports" section regardless of validation outcome.
</Validation_Rules>

<Examples>
<Good>
Parallel dispatch producing a compound finding:

```
Pass 1 (security): FINDING: Missing HMAC verification on webhook payload
  SEVERITY: high
  FILE: src/webhooks/handler.ts:42
  DESCRIPTION: The handler reads req.body directly without verifying the
    X-Hub-Signature-256 header. An attacker can forge arbitrary webhook events.
  RECOMMENDATION: Add HMAC-SHA256 verification using the webhook secret before
    processing the body. See GitHub docs on verifying webhooks.

Pass 2 (correctness): FINDING: Webhook handler executes side effects before validation
  SEVERITY: high
  FILE: src/webhooks/handler.ts:38-55
  DESCRIPTION: Database writes on line 50 execute before any payload schema
    check. Malformed payloads will cause partial writes.
  RECOMMENDATION: Move all schema validation to the top of the handler before
    any database interaction.

Consolidation: COMPOUND FINDING — both passes flag src/webhooks/handler.ts.
  Merged into single [HIGH] "Webhook handler lacks validation + HMAC check"
  with both recommendations combined.
```
Why good: Parallel passes surface both a security and a correctness dimension
of the same bug. Consolidation merges them into one compound finding instead
of listing duplicates.
</Good>

<Good>
Validation dropping a vague finding:

```
Pass 3 (architecture) raw output:
  FINDING: Could use better naming
  SEVERITY: low
  FILE: src/utils.ts (no line)
  DESCRIPTION: Some names could be clearer.
  RECOMMENDATION: Consider improving names.

Validation: DROPPED — fails "specific FILE:LINE" and "concrete RECOMMENDATION"
  checks (2 of 4 failures). Preserved in raw report; excluded from ranked list.
```
Why good: The validation step filters noise. The raw report retains the
full pass output for transparency, but the verdict list only contains
findings that a developer can act on.
</Good>

<Bad>
Waiting for passes serially:

```
// WRONG: waiting for security-reviewer to finish before spawning code-reviewer
await /fleet security-reviewer ...
await /fleet code-reviewer ...    // should be parallel
await /fleet architect ...        // should be parallel
await /fleet critic --mode review // should be parallel
```
Why bad: Serial dispatch defeats the purpose. A 4-minute review becomes 16
minutes. All four agents must be spawned without waiting for predecessors.
</Bad>

<Bad>
Skipping validation:

```
Consolidation output: 23 findings (including 14 that are vague style comments)
→ Emitting all 23 in the report without validation pass
```
Why bad: Reviewers lose trust when the report contains noise. The validation
step exists specifically to drop untestable, unactionable findings before
the report reaches any human reader.
</Bad>
</Examples>

<Escalation_And_Stop_Conditions>
- If diff resolution fails (gh/git error): emit `--event failed` telemetry,
  output the error message, and exit — do not proceed to dispatch
- If fewer than 2 of 4 passes return findings (agent failures): re-spawn the
  failed agents once; if they fail again, note in the report which passes
  could not complete and proceed with available findings
- If all 4 passes return `PASS: no findings`: verdict is **APPROVE** with
  summary "All four review passes found no issues."
- If the diff exceeds 5,000 lines: warn the user that large diffs reduce
  review quality; suggest scoping with `--scope` to review subsystems
  separately
- If `--focus` is specified: run only the named pass; skip the other three;
  consolidation step is trivial (single-pass report); validation still runs
</Escalation_And_Stop_Conditions>

<Final_Checklist>
- [ ] Diff resolved and non-empty before dispatching agents
- [ ] All four passes (or named focus pass) dispatched and returned
- [ ] Consolidation de-duplicated and ranked findings
- [ ] Validation step run — untestable/unactionable findings dropped
- [ ] Verdict assigned (APPROVE / APPROVE WITH NOTES / REQUEST CHANGES / BLOCKED)
- [ ] Raw agent reports preserved in final output
- [ ] At least one `started` and one `completed` or `failed` telemetry event
      written to `.omcp/state/skill-invocations.jsonl`
- [ ] No banned tokens present in this file (Invariant 7)
</Final_Checklist>
