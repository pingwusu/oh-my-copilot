# Spec: complete-omcp-orchestrate-ralph-ralplan

**Source**: deep-dive trace output (`.omc/specs/deep-dive-trace-complete-omcp-orchestrate-ralph-ralplan.md`)
**User intent**: "将 omcp 先完成一个 orchestrate，类似 omc 一样，其中重点是 ralph，ralplan，team，主要是长时间运行以及 team 多 agent 分工，之前出现的问题也一并修上"
**Scope decision**: All 3 layers (L1 hook dispatch + L2 multi-agent + L3 long-running resilience).
**Process decision**: Skip Socratic interview; trace findings are concrete enough to crystallize directly.

## Goal

Make omcp's orchestrator **production-ready for long-running multi-agent workflows**, matching the quality bar omc establishes. Specifically:

1. `omcp ralph` runs cleanly for 30+ iterations / hours of wall clock without state corruption, context exhaustion, or hook noise.
2. `omcp ralplan` actually drives a real Copilot session through Planner/Architect/Critic consensus AND hands off the resulting plan to `omcp ralph` automatically (current handoff is broken).
3. `omcp team` dispatches N concurrent workers with stage-transition state, shutdown acknowledgment, and stuck-worker watchdog (matching omc's team skill).
4. `omcp verify-phase` works against live Copilot subprocesses (currently only DI-mock tested) with timeout protection.
5. All 13 hook events fire cleanly on Windows + Node 24 (currently 12 fail with Node's TS-eval-stdin SyntaxError).
6. Crash recovery: a killed `omcp ralph` resumes from its last iteration on next invocation (currently ralph-state cleared unconditionally on any exit).

## Constraints (non-negotiable)

- **Invariants preserved**: assertSafeSlug, atomicWriteFileSync, 4-manifest version sync, escapeRegExp before RegExp, no banned tokens, CLI registration, pidfile+stop-verb.
- **No emojis** in shipped code/comments.
- **omc-style commit trailers**: Constraint / Rejected / Confidence / Scope-risk / Directive / Not-tested.
- **One logical change per commit** (phase = commit boundary).
- **Tests must lead implementation** (TDD pattern, per `superpowers:test-driven-development` and the project's existing convention).
- **No backward-compat shims** for renames; cut clean.
- **Reference omc patterns but rewrite** (CLAUDE.md mandates this; Copilot tool surface differs).

## Non-goals (out of scope for this milestone)

- Daemon mode (Option O-B of orchestrator-v1) — deferred to v2.0 unless cold-start measurement proves unacceptable for the target workload.
- modifiedArgs surgeon mode (Phase 7 of orchestrator-v1) — gated separately on live TUI smoke, deferred to v2.0.
- omx `/goal` parity — separate scope.
- OMC upstream `$CLAUDE_PLUGIN_ROOT` patch — different repo.

## Acceptance criteria (testable)

### L1 — Hook dispatch on Windows + Node 24
- AC1.1: `omcp hook fire <event> --json` invoked the way Copilot 1.0.52-4 dispatches it on Windows exits 0 with valid JSON stdout for ALL 13 events (currently 12 fail).
- AC1.2: The `node:internal/main/eval_stdin` SyntaxError pattern does NOT appear in `~/.copilot/logs/process-*.log` during a fresh `omcp ralph` smoke (currently 64+ such errors per ~2min run).
- AC1.3: Phase A smoke re-run produces zero hook-executor errors attributable to omcp.

### L2 — Multi-agent layer
- AC2.1: `omcp ralplan "<task>"` drives a real Copilot session, produces a consensus plan in `.omcp/state/boulder/<slug>.json`, AND writes a non-empty `planContent` (currently hardcoded empty at `mode.ts:179`).
- AC2.2: `omcp ralplan` with `--handoff` flag (or equivalent) automatically triggers `omcp ralph` against the boulder plan — verified via a live smoke artifact.
- AC2.3: `omcp verify-phase <phase-id>` has a `--timeout <seconds>` option (default 600s = 10min) so a hanging Copilot does NOT hang the parent process. Tested with a mock spawn that hangs.
- AC2.4: `omcp verify-phase` exercised against live Copilot in a smoke run (with a known short submission), captures raw stdout, validates that `detectVerdict` matches OR diagnoses the format gap and proposes a sentinel-tag prompt template fix.
- AC2.5: `omcp team N:executor "task"` writes per-worker `stage` field (omc-style: `team-plan`, `team-prd`, `team-exec`, `team-verify`, `team-fix`) and a `current_phase` field on the team session record. Test verifies stage transitions across crash + restart.
- AC2.6: Worker pidfile write uses `atomicWriteFileSync` (currently bare `writeFileSync` at `team.ts:103` — documented carve-out, lift it).
- AC2.7: `stopTeam` sends a shutdown_request via a state-file marker (omc-style) and waits up to 30s for `shutdown_response` before SIGTERM. Test covers normal shutdown + timeout fallback.
- AC2.8: Stuck-worker watchdog: if a worker stays in `in_progress` >10min wall-clock with no shard write, the orchestrator logs a warning AND offers to reassign (or escalate). Test covers detection.

### L3 — Long-running resilience
- AC3.1: `progress.txt` has a configurable size cap (default 64KB); when exceeded, the oldest entries are truncated (rolling tail). `getRalphContext` injects only the tail. Tests cover the cap.
- AC3.2: preemptive-compaction hook removes the `MAX_WARNINGS = 3` permanent silencing OR replaces it with a per-N-iterations re-arm. Token estimator also accounts for accumulated prompt-history size estimate (read from ralph-state + progress.txt). Tests cover the new threshold logic.
- AC3.3: ralph-state crash recovery: `clearRalphState` on copilot exit is conditional on (a) exit code 0 AND (b) ralph state shows `allComplete:true` OR `architectApproved:true`. Any other exit leaves ralph-state intact for resume. Tests cover both branches.
- AC3.4: Stale mode-state auto-detection: if `canStartMode` finds a stale active mode-state older than 60min, log a warning and offer auto-clear (`omcp ralph --resume` clears + restarts; `omcp ralph` without flag asks for `omcp cancel`). Test covers detection.
- AC3.5: Hook timeout configurable per-event (default 5s preserved for non-orchestration events; raise to 30s for `Stop` + `PreCompact` which run more logic). Tests cover the per-event override.

### Live smoke (gated on AC1+AC2+AC3 unit-test pass)
- AC-S1: Phase A smoke (the v1.0.0 PRD) re-run — must pass with zero PostToolUse "code 1" log entries.
- AC-S2: New "ralplan handoff smoke" — write a 1-story PRD spec, run `omcp ralplan "implement <spec>"`, verify boulder state written with `planContent != ""`, then run `omcp ralph` and watch it pick up the boulder plan.
- AC-S3: New "team multi-agent smoke" — write a 4-story PRD, run `omcp team 4:executor "<task>"`, verify 4 shard files written, `omcp team-merge-shards` reconciles into the canonical PRD, all stories `passes:true` at end.
- AC-S4: New "verify-phase live smoke" — write a known submission, run `omcp verify-phase smoke-1` against live Copilot, verify both architect+critic produce a parseable verdict OR document the format gap for a follow-up prompt-template fix.
- AC-S5: New "30-iteration ralph smoke" — synthetic 30-story PRD with trivial stories, confirm ralph completes 30 iterations without ralph-state corruption, without compaction-hook going silent, with progress.txt within cap.

### Project hygiene
- AC-H1: All new tests pass; no regressions (979 baseline preserved + delta from new tests).
- AC-H2: `npm run build` clean.
- AC-H3: 4-manifest version sync maintained (Phase Z bump to v1.1.0 OR v1.2.0 depending on scope decision).
- AC-H4: HANDOFF.md updated.
- AC-H5: CHANGELOG.md prepended with the release section.

## Trace Findings (carry-forward to plan)

(See `.omc/specs/deep-dive-trace-complete-omcp-orchestrate-ralph-ralplan.md` for the full artifact.)

Most likely cause: omcp at v1.0.0 has THREE independent layers of incompleteness:
1. **L1**: Copilot 1.0.52-4 + Node 24 interaction on Windows causes hook stdin to be parsed as TypeScript (eval_stdin mode). Fix: change hook command format in `setup.ts`'s hook-wiring.
2. **L2**: Three discrete bugs/gaps in the multi-agent layer (handoff hardwired off, verify-phase no timeout, detectVerdict never live-tested) plus structural gaps vs omc (no stage state, no shutdown ack, no watchdog).
3. **L3**: Four compounding gaps for long-running (progress.txt unbounded, compaction silenced after 3 warnings, no crash recovery, hook timeout too tight).

Per-lane critical unknowns to resolve during execution (NOT gating plan creation):
- L1-U: Why does Stop hook succeed when 12 other events fail with `eval_stdin`? (Probe in setup phase reveals fix mechanics.)
- L2-U: Does live Copilot output the verdict keyword on its own line in stdout? (Verify-phase live smoke answers this.)
- L3-U: Does Copilot in `--autopilot` mode honor `{kind: "advise"}` hook responses? (Long-running smoke answers this.)

## Technical context

- Repo: `C:\Users\runjiashi\oh-my-copilot-r2`, HEAD `f21bf04` (v1.0.0 just cut).
- Test count baseline: 979 passing, 2 skipped, 1 baseline EPERM unchanged since v0.4.0.
- Build: tsc clean.
- Reference: omc at `C:\Users\runjiashi\.claude\plugins\cache\omc\oh-my-claudecode\4.9.3\` (read-only).
- Critical files (will be touched):
  - `src/cli/commands/setup.ts` — hook-wiring format (L1)
  - `src/cli/commands/mode.ts:170-185` — ralplan handoff + crash recovery (L2 + L3)
  - `src/cli/commands/verify-phase.ts` — timeout option (L2)
  - `src/cli/commands/team.ts` — pidfile atomicity + stage state + watchdog (L2 + L3)
  - `src/lib/ralph-state.ts` — progress.txt cap + crash-recovery branches (L3)
  - `src/hooks/preemptive-compaction/*` — MAX_WARNINGS rework + token-estimator expansion (L3)
  - `src/runtime/copilot-config.ts` — per-event hook timeouts (L3)

## Ontology

| Term | Meaning |
|------|---------|
| L1 | Layer 1 — Hook dispatch (the Node-24 eval-stdin issue) |
| L2 | Layer 2 — Multi-agent dispatch (ralplan handoff, verify-phase timeout, team coordination) |
| L3 | Layer 3 — Long-running resilience (progress.txt, compaction, crash recovery) |
| AC | Acceptance criterion |
| AC-S | Acceptance criterion — live Smoke |
| AC-H | Acceptance criterion — project Hygiene |
| Phase A smoke | The v1.0.0 live Copilot smoke artifact at `docs/smoke/orchestrator-v1-real-copilot-smoke.md` |
| eval_stdin | Node 24's TypeScript strip mode that parses stdin as source code |
| Boulder state | ralplan's hand-off state file at `.omcp/state/boulder/<slug>.json` |
| Stage state | omc's per-worker `current_phase` field tracking pipeline position |
| Shutdown ack | omc's `shutdown_request` / `shutdown_response` protocol between lead and workers |
