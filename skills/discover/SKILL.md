---
name: discover
description: 6-parallel-agent greenfield codebase discovery — surfaces a ranked work-item backlog in .omcp/discover/backlog.md
argument-hint: "<repo path or exploration target>"
triggers:
  - "discover"
  - "explore codebase"
  - "what should we work on"
  - "greenfield scan"
  - "backlog discovery"
  - "what needs fixing"
  - "audit codebase"
level: 3
model:
  claude: claude-opus-4.7
  gpt: gpt-5.4
---

<Purpose>
Discover orchestrates 6 parallel scan agents to systematically explore an unknown or partially-known codebase and produce a ranked backlog of work items the user can pull directly into `/oh-my-copilot:ralph`, `/oh-my-copilot:team`, or `/oh-my-copilot:deep-dive`.

Each agent specialises in a distinct lens (security, architecture, code quality, causation, data/science, documentation). Their findings are collected as JSONL, deduplicated, and prioritised into `.omcp/discover/backlog.md` — a single source of truth the user can triage.

**Relationship to deep-dive**: deep-dive = targeted causal investigation of a known problem. discover = greenfield exploration of an unknown codebase to surface the problems worth investigating. Use discover first when you do not yet know what the problems are; use deep-dive once you have picked a specific problem to diagnose.
</Purpose>

<Use_When>
- User opens a codebase they have not worked in before and wants a prioritised to-do list
- User says "discover", "what should we work on", "audit the codebase", "greenfield scan"
- User wants an independent multi-lens review rather than a single-expert opinion
- Onboarding to a legacy or inherited project — generate a backlog before touching anything
- Pre-sprint scoping — surface hidden work before committing to estimates
</Use_When>

<Do_Not_Use_When>
- User already knows what the problem is — use `/oh-my-copilot:deep-dive` to investigate it
- User has a spec and wants execution — use `/oh-my-copilot:ralph` or `/oh-my-copilot:autopilot`
- User wants a single focused review — use `/oh-my-copilot:code-review` or `/oh-my-copilot:deep-review`
- The codebase is trivially small (< 5 files) — a single executor pass is faster
</Do_Not_Use_When>

<Why_This_Exists>
Single-agent codebase reviews are incomplete by construction: a security agent misses architecture smells; an architecture agent misses data-science anti-patterns; a documentation agent misses runtime correctness hazards. Discover runs all six lenses in parallel and merges their findings, so no class of problem goes undetected by design. omc canonical does not have an equivalent skill; this is a PORT-ROBIN-justified extension (F24) — the 6-lens parallel discovery pattern fills a genuine load-bearing gap that omc also lacks. See ADR-RP-08 for the divergence rationale.
</Why_This_Exists>

<Execution_Policy>
- Phase 1 (init): resolve scope, generate slug, initialise state
- Phase 2 (scan): 6 agents run in parallel via `/fleet`; collect findings as JSONL
- Phase 3 (consolidation): deduplicate + prioritise findings; write backlog
- Phase 4 (handoff): present backlog to user; offer downstream skill routing
- Emit telemetry at scan start, on consolidation complete, and on any hard failure
- Sequential fallback: if `/fleet` parallel dispatch is unavailable, run agents serially; output structure is identical
- Never execute changes — discover is read-only; all writes are to `.omcp/discover/`
</Execution_Policy>

<Steps>

## Phase 1: Initialize

1. **Parse the target** from `{{ARGUMENTS}}`. If empty, default to the current working directory.
2. **Generate slug**: kebab-case from the target path basename or first 4 words of ARGUMENTS, lowercased, special characters stripped. Example: `"my-api-service"` or `what-should-we-work`.
3. **Confirm scope with the user** (one question):

   > **Starting codebase discovery.** I will run 6 parallel scan agents across the following target:
   >
   > **Target:** `{target}`
   > **Output:** `.omcp/discover/backlog.md`
   >
   > Proceed, or would you like to narrow the scope (e.g., a specific subdirectory)?

   Accept "proceed" / "yes" / Enter as confirmation. If the user narrows scope, update `target` and re-confirm once.

4. **Initialise state** via omcp state persistence tools (mode `discover`):

```json
{
  "active": true,
  "current_phase": "scan",
  "state": {
    "slug": "<kebab-slug>",
    "target": "<resolved target path>",
    "scan_results_path": ".omcp/discover/scan-{slug}.jsonl",
    "backlog_path": ".omcp/discover/backlog.md",
    "agent_statuses": {
      "security-reviewer": "pending",
      "architect": "pending",
      "code-reviewer": "pending",
      "tracer": "pending",
      "scientist": "pending",
      "document-specialist": "pending"
    },
    "findings_count": 0
  }
}
```

5. **Emit start telemetry**:
   ```
   omcp skill-invocation-emit --skill discover --event started \
     --detail '{"slug":"<slug>","target":"<target>"}'
   ```
   Non-zero exit from this verb is observability-only — never block the scan on a telemetry failure.

## Phase 2: Parallel Scan

Dispatch 6 agents concurrently via `/fleet`. Each agent scans `{target}` through its specialist lens and emits findings as JSONL lines to its designated stream.

### Agent Roster and Lens Assignments

**Agent 1 — security-reviewer** (`/fleet security-reviewer`)
- Lens: trust boundaries, injection risks, secrets exposure, authentication gaps, dependency vulnerabilities
- Key questions: Are inputs validated? Are secrets hardcoded? Are dependencies pinned and audited? Is auth enforced consistently?

**Agent 2 — architect** (`/fleet architect`)
- Lens: structural coupling, circular dependencies, God objects, missing abstractions, boundary violations, scalability ceilings
- Key questions: Are responsibilities separated? Are dependencies directional? Are there hidden bottlenecks? Does the structure match the stated domain?

**Agent 3 — code-reviewer** (`/fleet code-reviewer`)
- Lens: code quality, dead code, duplicated logic, naming, complexity, test coverage gaps, error handling
- Key questions: Are there untested paths? Are errors silently swallowed? Is there duplicated logic that should be extracted?

**Agent 4 — tracer** (`/fleet tracer`)
- Lens: runtime causation chains, implicit state mutations, side effects, race conditions, retry storms, observability gaps
- Key questions: Are there untracked side effects? Where can state diverge silently? What is unobservable at runtime?

**Agent 5 — scientist** (`/fleet scientist`)
- Lens: data flows, schema assumptions, statistical anti-patterns, measurement validity, unvalidated hypotheses in the code
- Key questions: Are data contracts enforced? Are there implicit type coercions? Are metrics meaningful? Are thresholds justified?

**Agent 6 — document-specialist** (`/fleet document-specialist`)
- Lens: documentation completeness, stale/contradictory docs, missing API contracts, onboarding friction, undocumented invariants
- Key questions: Can a new contributor understand how to run and change this system? Are contracts documented? Are breaking changes captured?

### Agent Output Contract

Each agent MUST emit findings as JSONL lines (one JSON object per line) to stdout:

```json
{"agent":"<agent-name>","severity":"critical|high|medium|low","category":"<lens-category>","title":"<short title>","detail":"<1-3 sentence explanation>","location":"<file:line or component or 'global'>","effort":"xs|s|m|l|xl","tags":["<tag1>","<tag2>"]}
```

Field semantics:
- `severity`: `critical` = blocks production safety/security; `high` = blocks maintainability; `medium` = quality debt; `low` = nice-to-have
- `effort`: xs = < 30 min; s = < 2 h; m = < 1 day; l = < 1 week; xl = > 1 week
- `location`: specific file path + line range when known; component name or `"global"` otherwise
- `tags`: free-form labels for grouping (e.g., `["auth","input-validation"]`)

Agents MAY emit 0 findings if their lens finds nothing actionable. They MUST NOT emit findings outside their assigned lens.

### Dispatch

```
/fleet security-reviewer   --name scan-sec   --model {claude=sonnet,gpt=gpt-5.2} \
  --prompt "Scan {target} through the security lens. Emit findings as JSONL per the output contract. Limit: 20 findings max."

/fleet architect           --name scan-arch  --model {claude=opus,gpt=gpt-5.4} \
  --prompt "Scan {target} through the architecture lens. Emit findings as JSONL per the output contract. Limit: 20 findings max."

/fleet code-reviewer       --name scan-code  --model {claude=opus,gpt=gpt-5.4} \
  --prompt "Scan {target} through the code-quality lens. Emit findings as JSONL per the output contract. Limit: 20 findings max."

/fleet tracer              --name scan-trace --model {claude=sonnet,gpt=gpt-5.2} \
  --prompt "Scan {target} through the runtime-causation lens. Emit findings as JSONL per the output contract. Limit: 20 findings max."

/fleet scientist           --name scan-sci   --model {claude=sonnet,gpt=gpt-5.2} \
  --prompt "Scan {target} through the data-and-measurement lens. Emit findings as JSONL per the output contract. Limit: 20 findings max."

/fleet document-specialist --name scan-docs  --model {claude=sonnet,gpt=gpt-5.2} \
  --prompt "Scan {target} through the documentation lens. Emit findings as JSONL per the output contract. Limit: 20 findings max."
```

**Sequential fallback**: If `/fleet` parallel dispatch is unavailable, run each agent serially in the order above. State tracks `agent_statuses` so a partial run can be resumed.

After all 6 agents complete (or all complete that are available for sequential runs), collect all JSONL output into `.omcp/discover/scan-{slug}.jsonl` (one line per finding, appended in agent order). Update `agent_statuses` in state to `"complete"` or `"failed"` per agent. Update `findings_count` in state.

## Phase 3: Consolidation

Read `.omcp/discover/scan-{slug}.jsonl` and produce `.omcp/discover/backlog.md`.

### Deduplication Rules

1. Two findings are **duplicates** if they share the same `location` AND their `title` strings share ≥ 60% word overlap (Jaccard similarity or equivalent heuristic).
2. When deduplicating, KEEP the finding from the higher-authority agent (severity order: critical > high > medium > low; then agent authority order: security-reviewer > architect > code-reviewer > tracer > scientist > document-specialist).
3. Record the duplicate source agents in the retained finding's `agents` field (array).

### Priority Score

For each (deduplicated) finding, compute a priority score:

```
priority = severity_weight × effort_multiplier
```

Where:
- `severity_weight`: critical=100, high=40, medium=15, low=5
- `effort_multiplier`: xs=2.0, s=1.5, m=1.0, l=0.7, xl=0.4

Higher score = higher priority. This rewards high-severity, low-effort items (quick wins at the top).

### Backlog Format

Write to `.omcp/discover/backlog.md`:

```markdown
# Discovery Backlog — {slug}

**Target**: `{target}`
**Scanned**: {ISO timestamp}
**Agents**: security-reviewer, architect, code-reviewer, tracer, scientist, document-specialist
**Findings**: {total_before_dedup} raw → {total_after_dedup} deduplicated

---

## Critical ({n} items)

### [{priority_rank}] {title}
- **Agent(s)**: {agent(s) that flagged this}
- **Location**: `{location}`
- **Severity**: critical | **Effort**: {effort}
- **Detail**: {detail}
- **Tags**: {tags}
- **Suggested skill**: `/oh-my-copilot:{ralph|deep-dive|team}` — {one-line rationale}

[repeat for each critical finding, sorted by priority score descending]

---

## High ({n} items)

[same structure]

---

## Medium ({n} items)

[same structure]

---

## Low ({n} items)

[same structure]

---

## Agent Coverage Summary

| Agent | Findings (raw) | Findings (kept) | Status |
|---|---|---|---|
| security-reviewer | {n} | {n} | complete/failed/skipped |
| architect | {n} | {n} | ... |
| code-reviewer | {n} | {n} | ... |
| tracer | {n} | {n} | ... |
| scientist | {n} | {n} | ... |
| document-specialist | {n} | {n} | ... |

---

## Suggested First Pull

Pick the top 3 items by priority score and suggest the best downstream skill for each:
- Item with `effort=xs|s` and `severity=critical|high` → `/oh-my-copilot:ralph` (fast execution)
- Item requiring investigation before implementation → `/oh-my-copilot:deep-dive` (causal investigation)
- Item spanning 3+ components → `/oh-my-copilot:team` (parallel execution)
```

**Suggested skill** heuristic (per finding):
- `severity=critical` AND `effort=xs|s` → `/oh-my-copilot:ralph`
- `severity=critical|high` AND `effort=m|l|xl` → `/oh-my-copilot:deep-dive` (investigate first)
- Any finding with 3+ distinct `location` files touched → `/oh-my-copilot:team`
- Default for well-understood medium/low items → `/oh-my-copilot:ralph`

After writing `backlog.md`, update state: `current_phase: "handoff"`. Emit consolidation telemetry:
```
omcp skill-invocation-emit --skill discover --event completed \
  --detail '{"slug":"<slug>","findings_raw":<n>,"findings_deduped":<n>,"backlog_path":".omcp/discover/backlog.md"}'
```

## Phase 4: Handoff

Present the backlog summary to the user:

> **Discovery complete.** Found {total_after_dedup} work items ({n_critical} critical, {n_high} high, {n_medium} medium, {n_low} low).
>
> Backlog written to: `.omcp/discover/backlog.md`
>
> **Suggested first pull** (top 3 by priority):
> 1. [{rank}] {title} — `{suggested_skill}`
> 2. [{rank}] {title} — `{suggested_skill}`
> 3. [{rank}] {title} — `{suggested_skill}`
>
> How would you like to proceed?

**Options** (ask the user directly, one question):

1. **Pull top item into ralph** — execute the highest-priority item now
   - Action: Invoke `/oh-my-copilot:ralph` with the top-priority finding as the task definition

2. **Investigate top critical item with deep-dive**
   - Action: Invoke `/oh-my-copilot:deep-dive` with the critical finding's `detail` as the problem statement

3. **Run the full backlog with team** — parallel execution across all critical + high items
   - Action: Invoke `/oh-my-copilot:team` with the backlog path as the shared task list

4. **Review backlog only** — no execution, just return the path
   - Action: Output `.omcp/discover/backlog.md` path and exit cleanly

5. **Re-run with narrower scope** — repeat Phase 1 with a subdirectory target
   - Action: Return to Phase 1 with updated target

**IMPORTANT:** On execution selection, MUST invoke the chosen skill via the `/oh-my-copilot:<name>` slash invocation. Do NOT implement directly. Discover is a read-only discovery pipeline, not an execution agent.

</Steps>

<Telemetry>
Every discover session emits at minimum two telemetry events to the GLOBAL skill-invocation log at `.omcp/state/skill-invocations.jsonl`:

1. **At Phase 1 step 5 (setup)**: `--event started` with `{slug, target}` detail.
2. **At Phase 3 end (consolidation)**: `--event completed` with `{slug, findings_raw, findings_deduped, backlog_path}` detail.
3. **On hard failure** (all 6 agents fail, or consolidation throws): `--event failed` with `{slug, reason}` detail.

All telemetry calls go through:
```
omcp skill-invocation-emit --skill discover --event <started|completed|failed> [--detail <json>]
```

Telemetry is best-effort. A non-zero exit from the verb MUST NOT halt the scan — the scan owns the discovery; the verb only owns the side-channel. The aggregate log answers PM-1: "is this skill being used?" v2.4 review queries the file for adoption signal.
</Telemetry>

<Agent_Output_Schema>
```json
{
  "agent": "security-reviewer|architect|code-reviewer|tracer|scientist|document-specialist",
  "severity": "critical|high|medium|low",
  "category": "string — lens-specific category label",
  "title": "string — short imperative title (≤ 10 words)",
  "detail": "string — 1-3 sentences explaining the issue and risk",
  "location": "string — file:line-range or component name or 'global'",
  "effort": "xs|s|m|l|xl",
  "tags": ["string"]
}
```

**Effort key**: xs = < 30 min; s = < 2 h; m = < 1 day; l = < 1 week; xl = > 1 week.

**Category examples by agent**:
- security-reviewer: `injection`, `secrets-exposure`, `auth-gap`, `dependency-vuln`, `trust-boundary`
- architect: `circular-dependency`, `god-object`, `boundary-violation`, `missing-abstraction`, `scalability-ceiling`
- code-reviewer: `dead-code`, `duplicated-logic`, `test-gap`, `error-swallowed`, `naming`, `complexity`
- tracer: `implicit-mutation`, `race-condition`, `retry-storm`, `observability-gap`, `side-effect`
- scientist: `schema-assumption`, `type-coercion`, `invalid-metric`, `unjustified-threshold`, `data-contract`
- document-specialist: `missing-contract`, `stale-doc`, `onboarding-gap`, `undocumented-invariant`, `broken-example`
</Agent_Output_Schema>

<Examples>
<Good>
Greenfield discovery of an inherited API service:
```
User: /oh-my-copilot:discover "src/api-service"

[Phase 1] Scope confirmed: src/api-service
[Phase 2] 6 agents dispatched in parallel via /fleet.
  security-reviewer: 8 findings (2 critical — hardcoded JWT secret, missing input validation on /upload)
  architect:         5 findings (1 critical — circular dep between auth and user modules)
  code-reviewer:     12 findings (0 critical, 4 high — 3 untested error paths, 1 God class)
  tracer:            6 findings (1 high — retry storm on DB reconnect)
  scientist:         3 findings (0 critical — 1 implicit int→string coercion in metrics)
  document-specialist: 4 findings (0 critical — missing API contract for /upload)
[Phase 3] 38 raw → 31 deduplicated (7 duplicates merged).
  backlog.md written. Suggested first pull: hardcoded JWT secret (critical, xs, ralph).
[Phase 4] User selects "Pull top item into ralph".
  → /oh-my-copilot:ralph invoked with "Remove hardcoded JWT secret at src/api-service/auth.ts:42"
```
Why good: Parallel agents surface distinct issue classes. Deduplication merges overlapping findings. Handoff routes directly to the appropriate downstream skill.
</Good>

<Good>
Sequential fallback when /fleet is unavailable:
```
[Phase 2] /fleet unavailable. Running agents serially:
  1/6 security-reviewer ... 6 findings
  2/6 architect ...         4 findings
  3/6 code-reviewer ...     9 findings
  4/6 tracer ...            2 findings
  5/6 scientist ...         1 finding
  6/6 document-specialist . 3 findings
[Phase 3] 25 raw → 22 deduplicated.
```
Why good: Sequential fallback preserves the full output structure. The user gets the same backlog regardless of dispatch availability.
</Good>

<Bad>
Discover used instead of deep-dive:
```
User: /oh-my-copilot:discover "Why is the auth token expiring early?"
```
Why bad: User already knows the problem — this is a causal investigation, not greenfield exploration. Use `/oh-my-copilot:deep-dive` instead. Discover will surface generic security findings but won't answer the specific causal question.
</Bad>

<Bad>
Agents executing changes:
```
[Phase 2] security-reviewer found hardcoded secret at auth.ts:42.
  → Auto-applied fix: replaced secret with env var read.
```
Why bad: Discover is read-only. Agents scan and emit findings; they MUST NOT write to production files. All writes are to `.omcp/discover/`. Execution belongs in Phase 4 via a downstream skill.
</Bad>
</Examples>

<Escalation_And_Stop_Conditions>
- **All 6 agents fail**: emit `--event failed` telemetry, report which agents failed, offer to retry with a narrower target or sequential mode
- **Partial agent failure (1-5 agents fail)**: continue consolidation with available findings; mark failed agents as `"failed"` in the Agent Coverage Summary; warn the user that coverage is incomplete
- **Empty target** (no files found): abort early, ask the user to confirm the target path exists
- **User says "stop", "cancel", "abort"**: persist current state, write partial backlog if ≥ 1 agent has completed, exit cleanly
- **Backlog write fails** (disk full, permission error): report error, print the consolidated findings directly to chat as a fallback
- **Context compaction**: all artifact paths are persisted in state — resume by reading state (mode `discover`), not conversation history
</Escalation_And_Stop_Conditions>

<Final_Checklist>
- [ ] Phase 1 confirms scope with the user before dispatching agents
- [ ] Phase 1 emits `--event started` telemetry
- [ ] Phase 2 dispatches exactly 6 agents: security-reviewer, architect, code-reviewer, tracer, scientist, document-specialist
- [ ] Phase 2 has a documented sequential fallback when `/fleet` is unavailable
- [ ] Each agent emits findings as JSONL with all required fields (agent, severity, category, title, detail, location, effort, tags)
- [ ] Phase 3 deduplicates findings using location + title overlap rule
- [ ] Phase 3 computes priority score (severity_weight × effort_multiplier) and sorts by score descending
- [ ] Phase 3 writes `.omcp/discover/backlog.md` with Critical/High/Medium/Low sections + Agent Coverage Summary + Suggested First Pull
- [ ] Phase 3 emits `--event completed` telemetry
- [ ] Phase 4 presents top 3 items and asks user how to proceed (one question)
- [ ] Phase 4 routes to downstream skill via `/oh-my-copilot:<name>` slash invocation — never executes directly
- [ ] Hard failures emit `--event failed` telemetry
- [ ] All writes go to `.omcp/discover/`; no production files are modified
- [ ] State persists slug, target, scan_results_path, backlog_path, agent_statuses for resume resilience
</Final_Checklist>

<Advanced>
## Configuration

Optional settings in `~/.copilot/settings.json` (user-level) or `./.copilot/settings.json` (project-level, overrides user):

```json
{
  "omcp": {
    "discover": {
      "maxFindingsPerAgent": 20,
      "deduplicationThreshold": 0.6,
      "sequentialFallback": true,
      "defaultSeverityFloor": "low"
    }
  }
}
```

- `maxFindingsPerAgent`: cap per agent (default 20); reduces noise for large codebases
- `deduplicationThreshold`: Jaccard word-overlap threshold for duplicate detection (default 0.6)
- `sequentialFallback`: whether to fall back to serial execution when `/fleet` is unavailable (default true)
- `defaultSeverityFloor`: minimum severity to include in backlog (default `"low"` = all findings)

## Resume

If interrupted, run `/oh-my-copilot:discover` again. The skill reads state from the omcp state store (mode `discover`) and checks `state.slug` to resume from the last completed phase. Artifact paths (`scan_results_path`, `backlog_path`) are reconstructed from state, not conversation history.

## Relationship to Other Skills

| Scenario | Use |
|----------|-----|
| Unknown codebase, need a work queue | `/oh-my-copilot:discover` (this skill) |
| Known problem, need root-cause analysis | `/oh-my-copilot:deep-dive` |
| Have a spec, need to execute | `/oh-my-copilot:ralph` or `/oh-my-copilot:autopilot` |
| Iterative optimisation toward a metric | `/oh-my-copilot:ralph-experiment` |
| 4-pass code quality review | `/oh-my-copilot:deep-review` |

Discover is an exploration orchestrator — it does not replace deep-dive (targeted causal investigation), deep-review (quality review of existing code), or ralph (execution).

## ADR Reference

This skill is PORT-ROBIN-justified (F24) per the RP arc plan. omc canonical (oh-my-claudecode 4.9.3) does not have a discover equivalent. The 6-lens parallel discovery pattern fills a genuine load-bearing gap: single-agent reviews are incomplete by construction. ADR-RP-08 records the omc-divergence justification.
</Advanced>
