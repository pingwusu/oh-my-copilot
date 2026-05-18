---
name: omcp-reference
description: OMCP agent catalog, available tools, team pipeline routing, commit protocol, and skills registry. Auto-loads when delegating to agents, using OMCP tools, orchestrating teams, making commits, or invoking skills.
user-invocable: false
---

# OMCP Reference

Use this built-in reference when you need detailed OMCP catalog information that does not need to live in every `AGENTS.md` session.

## Agent Catalog

Prefix: `oh-my-copilot:`. See `agents/*.md` for full prompts.

- `explore` (haiku / gpt-5-mini) — fast codebase search and mapping
- `analyst` (opus / gpt-5.4) — requirements clarity and hidden constraints
- `planner` (opus / gpt-5.4) — sequencing and execution plans
- `architect` (opus / gpt-5.4) — system design, boundaries, and long-horizon tradeoffs
- `debugger` (sonnet / gpt-5.2-codex) — root-cause analysis and failure diagnosis
- `executor` (sonnet / gpt-5.2-codex) — implementation and refactoring
- `verifier` (sonnet / gpt-5.2-codex) — completion evidence and validation
- `tracer` (sonnet / gpt-5.2-codex) — trace gathering and evidence capture
- `security-reviewer` (sonnet / gpt-5.2-codex) — trust boundaries and vulnerabilities
- `code-reviewer` (opus / gpt-5.4) — comprehensive code review
- `test-engineer` (sonnet / gpt-5.2-codex) — testing strategy and regression coverage
- `designer` (sonnet / gpt-5.2-codex) — UX and interaction design
- `writer` (haiku / gpt-5-mini) — documentation and concise content work
- `qa-tester` (sonnet / gpt-5.2-codex) — runtime/manual validation
- `scientist` (sonnet / gpt-5.2-codex) — data analysis and statistical reasoning
- `document-specialist` (sonnet / gpt-5.2-codex) — SDK/API/framework documentation lookup
- `git-master` (sonnet / gpt-5.2-codex) — commit strategy and history hygiene
- `code-simplifier` (opus / gpt-5.4) — behavior-preserving simplification
- `critic` (opus / gpt-5.4) — plan/design challenge and review

## Model Routing

- `haiku` / `gpt-5-mini` — quick lookups, lightweight inspection, narrow docs work
- `sonnet` / `gpt-5.2-codex` — standard implementation, debugging, and review
- `opus` / `gpt-5.4` — architecture, deep analysis, consensus planning, and high-risk review

`OMCP_MODEL_FAMILY` env var (`claude` | `gpt` | `auto`) or `~/.copilot/config.json` `model` field controls which side is used.

## Tools Reference

### External AI / orchestration
- `/fleet executor "task"` (or `/delegate`)
- `omcp team N:codex|gemini "..."`
- `omcp ask <claude|codex|gemini>`
- `/ccg`

### OMCP state
- `state_read`, `state_write`, `state_clear`, `state_list_active`, `state_get_status`
- `mode_write`, `mode_read`, `mode_clear`, `mode_list_active`, `mode_get_status`

### Team runtime
- `/fleet`, `/delegate`, `/tasks` (Copilot CLI surface replaces Claude Code's TeamCreate/Task/SendMessage)

### Notepad
- `notepad_read`, `notepad_write_priority`, `notepad_write_working`, `notepad_write_manual`

### Project memory
- `project_memory_read`, `project_memory_write`, `project_memory_add_note`, `project_memory_add_directive`

### Code intelligence
- LSP: `lsp_hover`, `lsp_goto_definition`, `lsp_find_references`, `lsp_diagnostics`, and related helpers
- AST: `ast_grep_search`, `ast_grep_replace`
- Utility: `python_repl`

## Skills Registry

Invoke built-in workflows via `/oh-my-copilot:<name>`.

### Workflow skills
- `autopilot` — full autonomous execution from idea to working code
- `ralph` — persistence loop until completion with verification
- `ultrawork` — high-throughput parallel execution
- `visual-verdict` — structured visual QA verdicts
- `team` — coordinated team orchestration
- `ccg` — Codex + Gemini + Claude synthesis lane
- `ultraqa` — QA cycle: test, verify, fix, repeat
- `omcp-plan` — planning workflow and `/plan`-safe alias
- `ralplan` — consensus planning workflow
- `sciomc` — science/research workflow
- `external-context` — external docs/research workflow
- `deepinit` — hierarchical AGENTS.md generation
- `deep-interview` — Socratic ambiguity-gated requirements workflow
- `ai-slop-cleaner` — regression-safe cleanup workflow

### Utility skills
- `ask`, `cancel`, `note`, `learner`, `omcp-setup`, `mcp-setup`, `hud`, `omcp-doctor`, `trace`, `release`, `project-session-manager`, `skill`, `writer-memory`, `configure-notifications`

### Keyword triggers kept compact in AGENTS.md
- `"autopilot"→autopilot`
- `"ralph"→ralph`
- `"ulw"→ultrawork`
- `"ccg"→ccg`
- `"ralplan"→ralplan`
- `"deep interview"→deep-interview`
- `"deslop" / "anti-slop"→ai-slop-cleaner`
- `"deep-analyze"→analysis mode`
- `"tdd"→TDD mode`
- `"deepsearch"→codebase search`
- `"ultrathink"→deep reasoning`
- `"cancelomc"→cancel`
- Team orchestration is explicit via `/team`.

## Team Pipeline

Stages: `team-plan` → `team-prd` → `team-exec` → `team-verify` → `team-fix` (loop).

- Use `team-fix` for bounded remediation loops.
- `team ralph` links the team pipeline with Ralph-style sequential verification.
- Prefer team mode when independent parallel lanes justify the coordination overhead.

## Commit Protocol

Use git trailers to preserve decision context in every commit message.

### Format
- Intent line first: why the change was made
- Optional body with context and rationale
- Structured trailers when applicable

### Common trailers
- `Constraint:` active constraint shaping the decision
- `Rejected:` alternative considered | reason for rejection
- `Directive:` forward-looking warning or instruction
- `Confidence:` `high` | `medium` | `low`
- `Scope-risk:` `narrow` | `moderate` | `broad`
- `Not-tested:` known verification gap

### Example
```text
feat(docs): reduce always-loaded OMCP instruction footprint

Move reference-only orchestration content into a native Copilot skill so
session-start guidance stays small while detailed OMCP reference remains available.

Constraint: Preserve AGENTS.md marker-based installation flow
Rejected: Sync all built-in skills in legacy install | broader behavior change than issue requires
Confidence: high
Scope-risk: narrow
Not-tested: End-to-end plugin marketplace install in a fresh Copilot profile
```
