# Plan: complete-omcp-orchestrate-ralph-ralplan — RALPLAN-DR deliberate mode (CONSENSUS-APPROVED)

**Status:** Planner iter-1 -> Architect iter-1 ITERATE (7 blocking issues) -> Planner iter-2 -> Architect iter-2 **APPROVE** -> Critic iter-1 **APPROVE**. Consensus reached 2026-05-24.

**Consensus signatures (this session):**
- Architect iter-2 verdict: APPROVE — all 7 ITERATE changes resolved with file:line evidence; no new issues; citation accuracy clean.
- Critic iter-1 verdict: APPROVE — all 8 quality gates PASS; all 3 open-question resolution paths adequate; 4 non-blocking documentation notes (3 corrected inline in this iter-2-final, 1 deferred to executor commit-time).

**Inline corrections after Critic APPROVE (iter-2-final):**
- L2.5a Change 1 summary corrected: `'initializing'` → `'executing'` (was internal contradiction with implementation step + test #4; `'executing'` is correct because `runTeam()` writes state after parse, before spawn).
- L3.3 persistent-mode acknowledgment expanded to all 3 call sites (lines 122-123, 133, 143) — previously omitted line 133 (pre-existing architectApproved branch).
- Off-by-one cosmetic line numbers (`MergeHookOptions` 220-226 vs actual 219-226; `mergeCopilotHooks` timeout 292-295 vs actual 291-294) — executor will correct during L1.1 file reads.
**Context root:** `C:\Users\runjiashi\oh-my-copilot-r2`, HEAD `f21bf04` (v1.0.0 just cut)
**Test baseline:** 979 passing, 2 skipped, 3 failing (pre-existing), 1 EPERM error (unchanged since v0.4.0)
**Build:** tsc clean
**Source spec:** `.omc/specs/deep-dive-complete-omcp-orchestrate-ralph-ralplan.md`
**Source trace:** `.omc/specs/deep-dive-trace-complete-omcp-orchestrate-ralph-ralplan.md`
**Reference plan format:** `docs/plans/v1.0.0-runtime-verify-ralplan.md`

---

## Iter-2 Changes (addressing all 7 Architect iter-1 blocking issues)

### Change 1 — Fix TeamPhase enum citation (Issue #1)

Iter-1 claimed to port `TeamPhase` from omc's `src/team/phase-controller.ts:3-9` but invented different values (`'team-plan' | 'team-prd' | 'team-exec' | 'team-verify' | 'team-fix'`). The actual omc enum is `'initializing' | 'planning' | 'executing' | 'fixing' | 'completed' | 'failed'` (6 values). **Iter-2 uses omc's actual 6-value enum verbatim.** All references to the invented values have been replaced. L2.5a now writes `current_phase: 'executing'` at spawn time (not `'team-plan'` and not `'initializing'`). Rationale: `runTeam()` writes state after parsing the spec and just before spawning the workers — by that moment initialization is complete and execution is starting. The implementation step (L2.5a step 2) and unit test #4 both enforce `'executing'`.

### Change 2 — Split L2.5 into L2.5a (in-scope) + L2.5b (deferred) (Issue #2)

Iter-1's L2.5 claimed crash-restart resume from `current_phase: 'team-exec'`. omcp's `runTeam` (`team.ts:63`) is fire-and-forget with no orchestration loop to resume into. **Iter-2 splits:**
- **L2.5a (v1.1.0):** Schema extension only. Add `current_phase` and `stage_history` as optional fields on `TeamState` (`src/runtime/mode-state.ts:54-58`). Write `current_phase: 'executing'` at spawn time. Forward-compat schema. Tests: field written, field readable, missing-field backward compat. NO crash-restart resume claim.
- **L2.5b (v1.2.0, deferred):** Implement actual phase-transition orchestrator with crash-restart resume. Listed in ADR Follow-ups.

### Change 3 — Add Stop-hook regression test to L1.1 (Issue #3)

Iter-1's L1.1 test plan (8 tests) did not include a test that the Stop hook command format continues to dispatch correctly under the new format. **Iter-2 adds test #9:** "Stop event's emitted command shape matches the format applied to all other events (consistency check)." L1.2 smoke also explicitly verifies Stop hook still exits 0.

### Change 4 — Specify smoke gate criteria for Phase Z (Issue #4)

Iter-1's Phase Z had no explicit HARD/SOFT gate classification for its 5 live smokes. **Iter-2 adds a gate table to Phase Z preconditions** with HARD/SOFT classification and 1-sentence justification for each.

### Change 5 — Fix constants.ts line number (Issue #5)

Iter-1 cited `MAX_WARNINGS = 3` at `constants.ts:32`. Verified: actual location is **line 33**. All references updated to `constants.ts:33`.

### Change 6 — Acknowledge persistent-mode/index.ts clearRalphState calls in L3.3 (Issue #6)

Iter-1's L3.3 only addressed the unconditional `clearRalphState` in `mode.ts:171-173` but did not mention two other call sites in `persistent-mode/index.ts`. **Iter-2 adds an explicit paragraph to L3.3** documenting that `src/hooks/persistent-mode/index.ts:122-123` (architectApproved branch) and `:143` (allComplete branch) are the CORRECT conditional paths and are intentionally NOT modified.

### Change 7 — Concrete integration test commitments (Issue #7)

Iter-1's Integration layer table had descriptions but no file names, test counts, or phase assignments. **Iter-2 assigns concrete integration tests:**
- L2.1: >=3 integration tests in `src/__tests__/ralplan-handoff.integration.test.ts`
- L2.5a: >=2 integration tests in `src/__tests__/team-stage-state.integration.test.ts`
- L3.3: >=3 integration tests in `src/__tests__/ralph-state-crash-recovery.integration.test.ts`

### Non-blocking notes addressed

- L3.2 per-N-iter re-arm backoff: noted as v1.2.0 follow-up in ADR.
- L1.0 probe adaptation rule: 1-sentence rule added to Principle 2.

---

## RALPLAN-DR Summary (deliberate mode)

### Principles (5)

1. **Layer isolation** -- L1 (hook dispatch), L2 (multi-agent), L3 (long-running) are orthogonal failure domains. Each layer is fixed, tested, and smoke-verified independently before the next layer begins. L1 must land before L2 smoke can run cleanly; L3 state changes do not require L2 to be complete.
2. **Probe before patch** -- Every layer starts with a diagnostic commit (no code change, only investigation artifact) that confirms the root cause matches the trace hypothesis. If the probe invalidates the hypothesis, the plan adapts before writing code. **Adaptation rule:** if the probe invalidates the eval_stdin hypothesis (e.g., the real cause is PATH resolution or Copilot version-specific dispatch), the L1.1 fix scope is rewritten to target the actual cause before proceeding -- L1.1 is NOT attempted with the original hypothesis.
3. **TDD or no merge** -- Tests are written before implementation in every code-change phase. The test count floor per phase is a hard lower bound; under-counting means the phase is incomplete.
4. **omc patterns, omcp rewrite** -- Port structural patterns (stage-transition state, shutdown ack, watchdog, phase controller) from omc at `C:\Users\runjiashi\.claude\plugins\cache\omc\oh-my-claudecode\4.9.3\` but rewrite for Copilot's tool surface. Never blind-copy.
5. **Commit hygiene is the deliverable** -- One logical change per commit, omc-style trailers (Constraint / Rejected / Confidence / Scope-risk / Directive / Not-tested). The audit trail must survive independent review.

### Decision Drivers (top 3)

1. **Why do 12 of 13 hook events fail with `node:internal/main/eval_stdin` while Stop succeeds?** -- Answering this reveals whether the fix is in the hook command format emitted by `omcpHookCommand()` at `src/runtime/copilot-config.ts:228`, in the Copilot dispatch path, or both. The L1 probe (Phase L1.0) answers this.
2. **Does live Copilot stdout emit the verdict keyword on its own line, or wrapped in reasoning?** -- Determines whether `detectVerdict()` at `src/lib/ralph-state.ts:456` works as-is or needs a prompt-template sentinel fix. The L2 smoke (Phase L2.4) answers this.
3. **Does Copilot `--autopilot` honor `{kind: "advise"}` hook responses?** -- Determines whether preemptive-compaction at `src/hooks/preemptive-compaction/index.ts:280-283` can ever work mid-ralph-loop. The L3 smoke (Phase L3.6) answers this.

### Viable Options (>=2)

| ID | Approach | Pros | Cons | Verdict |
|----|----------|------|------|---------|
| **V-A** | **L1 -> L2 -> L3 sequential, each layer probe+fix+smoke (RECOMMENDED).** Respects dependency chain (L1 clean hooks needed for L2/L3 smoke). Each layer's smoke validates the previous layer's fix. Version bump at end. | Maximizes signal per commit. Each smoke catches regressions from the prior layer. Clean audit trail. | Slower total wall-clock if layers have no real dependency (but they do -- L2/L3 smokes need clean hooks). |
| V-B | **L1+L3 in parallel, L2 after both.** L1 and L3 have minimal code overlap. | Saves wall-clock if two executors available. | L3 smoke (30-iteration ralph) needs clean hooks (L1) to run without noise. Parallel execution risks merge conflicts in `mode.ts` (touched by both L2 and L3). **REJECTED: false parallelism -- L3 smoke depends on L1 fix.** |
| V-C | **L1 fix only, defer L2+L3 to v1.2.** Minimum scope. | Ships the hook noise fix fast. | **REJECTED: user explicitly scoped all 3 layers** ("重点是 ralph, ralplan, team, 主要是长时间运行以及 team 多 agent 分工"). Deferring L2+L3 violates the stated goal. |
| V-D | **L1+L2+L3 plus daemon mode + modifiedArgs surgeon.** Maximum scope. | Most complete. | **REJECTED: daemon mode and surgeon mode are explicit non-goals** in the spec (lines 31-34). Scope creep. |

**Recommendation: V-A.** Sequential layered execution with probe-first discipline.

---

## Pre-mortem (3 scenarios -- deliberate mode required)

### Scenario 1 -- L1 hook-format fix does not generalize

**Cause:** The probe reveals that the `node:internal/main/eval_stdin` error only appears for a subset of the 13 events (e.g., only events where Copilot passes a large JSON payload on stdin, not all events uniformly). The fix applied in Phase L1.1 changes the command format but only tests against the events that were failing, missing a variant that fails differently.

**Detection signal:** Phase L1.2 re-smoke still shows "code 1" errors in `~/.copilot/logs/process-*.log` for events NOT included in the L1.0 probe (e.g., `PreCompact` or `PermissionRequest` which fire rarely and were not in the original 64-error set).

**Mitigation:**
- L1.0 probe MUST enumerate which of the 13 events appear in the failure log, not just sample PostToolUse. Grep all `process-*.log` for every event name.
- L1.1 test suite covers ALL 13 events (not a subset) generating the hook command form. The test asserts format consistency across all 13.
- L1.2 re-smoke runs `omcp ralph` with a PRD that exercises at least PreToolUse, PostToolUse, Stop, SessionStart, SessionEnd, and PreCompact -- covering both high-frequency and low-frequency events.
- If a subset still fails: the L1.2 smoke artifact documents the residual set and a follow-up phase is inserted before L2.

### Scenario 2 -- Live Copilot smoke for ralplan/team/verify-phase fails for environmental reasons

**Cause:** Copilot CLI 1.0.52-4 has an undocumented interaction with the omcp plugin configuration (e.g., `enabledPlugins` must be `true` for hooks to dispatch even though hooks are in settings.json; or `--autopilot` + `--allow-all-tools` flags interfere with each other in a version-specific way). The code is correct but the environment rejects it.

**Detection signal:** Phase L2.3 or L2.4 smoke produces `copilot -p` exit code != 0 with stderr mentioning plugin, authentication, or flag errors -- not omcp code errors.

**Mitigation:**
- Every smoke phase starts with a pre-flight checklist: `copilot --version` (confirm 1.0.52-4), `jq .enabledPlugins ~/.copilot/settings.json` (confirm omcp plugin state), and a bare `copilot -p "echo hello" --allow-all-tools` sanity check (confirm Copilot can run at all).
- If the pre-flight passes but the mode-specific smoke fails: capture full Copilot stderr + stdout, write diagnostic to the smoke artifact, and degrade the phase to "documented-gap-with-proposed-fix" rather than blocking all subsequent phases.
- Environmental failures do NOT block L3 phases (which are code-level, not Copilot-integration-level).

### Scenario 3 -- 30-iteration ralph smoke reveals a core ralph regression

**Cause:** Phase L3.6's synthetic 30-story PRD smoke completes 25 iterations, then ralph-state.json shows `iteration: 25` but `active: false` -- the conditional `clearRalphState` from Phase L3.3 incorrectly triggers because an intermediate exit code 0 + `allComplete: false` hits a logic branch that was not covered by unit tests.

**Detection signal:** L3.6 smoke artifact shows iteration counter stopped advancing before all 30 stories are `passes: true`. The ralph-state.json snapshot mid-smoke shows `active: false` while PRD has pending stories.

**Mitigation:**
- Phase L3.3 tests MUST include a scenario: "copilot exits 0 but PRD has incomplete stories -> ralph-state preserved" (not just the happy path "exit 0 + allComplete -> clear" and the crash path "exit != 0 -> preserve").
- L3.6 smoke captures ralph-state.json at 3 checkpoints: iteration 1, iteration 15, iteration 30 (or final). If iteration stops advancing, the checkpoint reveals the regression point.
- If a core ralph regression is found: triage by (a) writing a failing test that captures the regression, (b) fixing the regression in a separate commit BEFORE continuing L3.6, (c) re-running L3.6 from scratch. Do NOT attempt to patch mid-smoke.
- The 979-test baseline is re-run after every L3 code phase to confirm no regression in existing ralph tests.

---

## Execution Plan (commit-by-commit)

### Layer 1 -- Hook dispatch

---

#### Phase L1.0: Probe -- diagnose Stop vs other events dispatch format

**Title:** `docs(probe): L1 hook dispatch format -- Stop vs 12 failing events`

**Files touched:**
- `docs/probes/L1-hook-dispatch-format.md` (NEW -- diagnostic artifact)

**Implementation steps:**
1. Read `~/.copilot/settings.json` and extract the `hooks.Stop` entry vs `hooks.PostToolUse` entry. Compare the `command` field structure -- specifically whether Copilot rewrites the command before dispatching (e.g., wrapping in `cmd /d /c` or piping differently for Stop vs other events).
2. Manually reproduce the failing dispatch from a clean PowerShell shell:
   ```powershell
   '{"hook_event_name":"PostToolUse","session_id":"test","cwd":"./"}' | omcp hook fire PostToolUse --json
   ```
   Record exit code. If exit 1 with `eval_stdin` stack, the bug is in how Copilot invokes the command, not in omcp's code.
3. Test the alternative form: `'{"hook_event_name":"PostToolUse",...}' | node "C:\Users\runjiashi\oh-my-copilot-r2\dist\cli\omcp.js" hook fire PostToolUse --json` -- if this succeeds while the `omcp` form fails, the issue is in the shim/PATH resolution, not the command parsing.
4. Check whether Node 24 + `--experimental-strip-types` (which Copilot may pass) causes JSON piped to stdin to be parsed as TypeScript source. This would explain the `eval_stdin` frame.
5. Document findings in `docs/probes/L1-hook-dispatch-format.md`: which events fail, exact command forms, root cause confirmed or invalidated.

**Test plan:** No code tests (investigation commit). The artifact IS the deliverable.

**Acceptance criteria closed:** None directly; this phase informs L1.1's fix scope.

**Commit-message draft:**
```
docs(probe): L1 hook dispatch format -- Stop vs 12 failing events

Investigation-only commit. Captures diagnostic evidence for the
node:internal/main/eval_stdin SyntaxError that causes 12 of 13
hook events to exit 1 during Copilot dispatch.

Constraint: No code changes in this commit
Confidence: high
Scope-risk: narrow
```

---

#### Phase L1.1: Fix hook command format for all 13 events

**Title:** `fix(hooks): hook command format compatible with Copilot dispatch on Windows + Node 24`

**Files touched:**
- `src/runtime/copilot-config.ts:228-231` -- `omcpHookCommand()` function
- `src/runtime/copilot-config.ts:292-295` -- `mergeCopilotHooks()` timeout override
- `src/__tests__/copilot-config.hook-command-format.test.ts` (NEW)

**Implementation steps:**
1. Based on L1.0 probe findings, modify `omcpHookCommand()` at `src/runtime/copilot-config.ts:228` to emit the command form that Copilot correctly dispatches for ALL events (not just Stop). The most likely fix based on the trace: Copilot's hook executor for non-Stop events pipes the JSON payload to the command via stdin AND passes the command to Node's eval-stdin mode. If so, the fix is to change the command form so it is not ambiguously parseable as TypeScript (e.g., wrap in explicit `node --input-type=json` or change to a script-file invocation rather than a bare `omcp` command).
2. If the probe reveals Copilot dispatches Stop differently (e.g., using `cmd /d /c` wrapping), apply the same dispatch form to the `command` field for all 13 events.
3. Ensure `resolveDefaultOmcpBin()` at line 272 returns a form compatible with the fix (the absolute-path `node "..."` fallback from v1.0.0's Phase B may need adjustment if the fix involves changing from a bare command to a script invocation).

**Test plan (>=9 tests, TDD):** [CHANGED: was >=8 in iter-1; added test #9 per Issue #3]
- `src/__tests__/copilot-config.hook-command-format.test.ts`:
  1. All 13 events produce identical command format (no event-specific special-casing)
  2. Command form does NOT trigger Node eval-stdin mode when piped JSON on stdin
  3. Command form works with `omcp` on PATH (short form)
  4. Command form works with absolute-path fallback (`node "..."` form)
  5. `__omcp: true` marker present on all generated entries
  6. Timeout field present on all generated entries
  7. Existing non-omcp hooks preserved after merge (regression guard)
  8. `mergeCopilotHooks` with explicit `omcpBin` override bypasses auto-detection (test isolation preserved)
  9. **[NEW] Stop event's emitted command shape matches the format applied to all other events (consistency check -- Stop hook regression guard)** [Issue #3]

**Acceptance criteria closed:** AC1.1 (all 13 events exit 0 with valid JSON stdout)

**Commit-message draft:**
```
fix(hooks): hook command format compatible with Copilot dispatch on Windows + Node 24

Copilot 1.0.52-4 dispatches non-Stop hook commands through Node's
eval-stdin mode on Windows, causing JSON payloads piped on stdin to
be parsed as TypeScript source (SyntaxError: Unexpected token ':').
Change the command format emitted by omcpHookCommand() so all 13
events use a form that Copilot dispatches correctly.

Constraint: Must work with both omcp-on-PATH and absolute-path fallback
Rejected: Per-event command format | complexity; Stop's working form should generalize
Confidence: high (after L1.0 probe confirmation)
Scope-risk: moderate (touches all hook wiring; 9 tests cover regressions)
Not-tested: Copilot versions other than 1.0.52-4
```

---

#### Phase L1.2: Live re-smoke confirms zero hook errors

**Title:** `docs(smoke): L1 hook dispatch re-smoke -- zero PostToolUse errors`

**Files touched:**
- `docs/smoke/L1-hook-dispatch-resmoke.md` (NEW -- smoke artifact)

**Implementation steps:**
1. Pre-flight: `omcp setup` to regenerate `~/.copilot/settings.json` with the new command format from L1.1. Verify all 13 events have the updated `command` field.
2. Run `omcp ralph --prd .omcp/prd.json "implement the stories"` using the same 2-story PRD from the v1.0.0 Phase A smoke.
3. Post-run: grep `~/.copilot/logs/process-*.log` for `Hook command failed with code 1` entries. Count must be 0 for omcp-originated hooks.
4. **[NEW] Explicitly verify Stop hook still exits 0** -- grep logs for Stop event dispatch and confirm exit code 0. [Issue #3]
5. Write smoke artifact with: run metadata, pre-flight settings.json hook block, post-run log grep results, Stop hook verification, verdict (PASS/FAIL).

**Test plan:** No code tests. Smoke artifact is the deliverable.

**Acceptance criteria closed:** AC1.2 (no `eval_stdin` SyntaxError in logs), AC1.3 (Phase A re-run zero errors), AC-S1 (Phase A re-run PASS)

**Commit-message draft:**
```
docs(smoke): L1 hook dispatch re-smoke -- zero PostToolUse errors

Phase A re-run with the fixed hook command format from L1.1.
Zero 'Hook command failed with code 1' entries in Copilot logs.
Stop hook verified still exits 0 under new format.

Constraint: Smoke only -- no code changes
Confidence: high
Scope-risk: narrow
```

---

### Layer 2 -- Multi-agent layer

---

#### Phase L2.1: Fix ralplan -> ralph handoff

**Title:** `fix(ralplan): enable planContent population and handoff flag`

**Files touched:**
- `src/cli/commands/mode.ts:178-186` -- ralplan block after copilot exit
- `src/ralplan/index.ts:131-177` -- `registerRalplan()` already supports `handOffToRalph` and `planContent`
- `src/cli/commands/__tests__/mode-ralplan-handoff.test.ts` (NEW)
- `src/__tests__/ralplan-handoff.integration.test.ts` (NEW) [Issue #7]

**Implementation steps:**
1. At `src/cli/commands/mode.ts:178-186`, the current code hardcodes `planContent: ""` and `handOffToRalph: false`. The fix:
   - Read the boulder state file that the ralplan skill writes during its Copilot session. The skill outputs the consensus plan to `.omcp/plans/<slug>.md` via the boulder state. After copilot exits, read `readBoulderState()` from `src/lib/boulder-state.ts` to get the `activePlan` path, then read that file's content as `planContent`.
   - Accept a `--handoff` CLI flag on `omcp ralplan`. When present, set `handOffToRalph: true` in the `registerRalplan()` call.
   - When `handOffToRalph: true` AND `planContent` is non-empty, automatically invoke `runMode({ mode: "ralph", task: "Execute plan: <planPath>", prdPath: <derived-from-boulder> })` after `registerRalplan()` returns.
2. The `registerRalplan()` function at `src/ralplan/index.ts:131` already handles both `planContent` and `handOffToRalph` correctly -- it writes the plan file atomically, registers boulder state, and optionally writes ralplan mode-state. The fix is entirely in `mode.ts`'s calling code.

**Test plan (>=6 unit tests, TDD):**
- `src/cli/commands/__tests__/mode-ralplan-handoff.test.ts`:
  1. Without `--handoff`: `registerRalplan` called with `handOffToRalph: false` (current behavior preserved)
  2. With `--handoff` + boulder state has activePlan with content: `planContent` populated from disk, `handOffToRalph: true`
  3. With `--handoff` + boulder state absent (skill did not write): `planContent` stays empty, warning logged, no ralph spawn
  4. With `--handoff` + planContent non-empty: `runMode("ralph", ...)` called with correct task string
  5. Without `--handoff` + planContent non-empty: `runMode("ralph")` NOT called
  6. `registerRalplan` called with populated `sessionId` (not empty)

**Integration tests (>=3, assigned to this phase):** [Issue #7]
- `src/__tests__/ralplan-handoff.integration.test.ts`:
  1. Handoff flag default (off): `registerRalplan` receives `handOffToRalph: false`, no ralph mode-state written
  2. Handoff flag on + empty plan content (rejected): warning logged, no ralph spawn, no ralph mode-state written
  3. Handoff flag on + populated plan: `registerRalplan` succeeds, boulder state shows non-empty `planContent`, ralph mode-state written with correct task

**Acceptance criteria closed:** AC2.1 (non-empty planContent), AC2.2 (handoff triggers ralph)

**Commit-message draft:**
```
fix(ralplan): enable planContent population and handoff flag

mode.ts:179 hardcoded planContent:"" and handOffToRalph:false,
breaking the ralplan->ralph chain. Now reads boulder state after
copilot exit to populate planContent, and accepts --handoff flag
to auto-trigger ralph execution.

Constraint: registerRalplan() already supports both fields; fix is in the caller
Rejected: Always handoff | user may want to review plan before execution
Confidence: high
Scope-risk: moderate (touches mode.ts post-copilot-exit path)
Not-tested: Live Copilot producing boulder state (covered by L2.3 smoke)
```

---

#### Phase L2.2: Add --timeout to verify-phase

**Title:** `feat(verify-phase): --timeout option with spawn timeout threading`

**Files touched:**
- `src/cli/commands/verify-phase.ts:60-77` -- `runVerifyPhase()` function + `VerifyPhaseOptions` interface
- `src/cli/commands/verify-phase.ts:73-76` -- default `doSpawn` wrapping
- `src/cli/omcp.ts` -- verify-phase command registration (add `--timeout` option)
- `src/cli/commands/__tests__/verify-phase-timeout.test.ts` (NEW)

**Implementation steps:**
1. Add `timeout?: number` field to `VerifyPhaseOptions` interface at `src/cli/commands/verify-phase.ts:20-32`. Default: 600 (seconds, = 10 minutes).
2. Modify the default `doSpawn` lambda at line 73-76: pass `{ timeout: opts.timeout * 1000 }` to `spawnSync()`. Currently the call at line 76 is `spawnSync(bin, args, { encoding: "buffer", shell: false })` -- add `timeout` to this options object.
3. Handle the timeout case: when `spawnSync` returns with `signal === 'SIGTERM'` (timeout-killed), treat as verdict `null` (same as "no verdict found" -- triggers ITERATE or escalation at max iterations).
4. Register `--timeout <seconds>` option on the `verify-phase` Commander command in `src/cli/omcp.ts`.

**Test plan (>=5 tests, TDD):**
- `src/cli/commands/__tests__/verify-phase-timeout.test.ts`:
  1. Default timeout is 600s when not specified
  2. Custom timeout threads through to spawn options
  3. Spawn that exceeds timeout returns signal SIGTERM -> verdict treated as null -> ITERATE
  4. Spawn that completes within timeout -> normal verdict parsing
  5. Timeout of 0 means no timeout (passthrough to spawnSync behavior)

**Acceptance criteria closed:** AC2.3 (--timeout option, default 600s, tested with mock hang)

**Commit-message draft:**
```
feat(verify-phase): --timeout option with spawn timeout threading

spawnSync at verify-phase.ts:76 had no timeout, allowing a hanging
Copilot subprocess to block verify-phase forever. Add configurable
--timeout (default 600s) threaded through to spawnSync({timeout}).

Constraint: Must not change existing DI spawn interface for non-timeout tests
Rejected: Process.kill-based timeout | spawnSync's built-in timeout is sufficient
Confidence: high
Scope-risk: narrow
```

---

#### Phase L2.3: Live smoke for omcp ralplan

**Title:** `docs(smoke): L2 ralplan handoff smoke`

**Files touched:**
- `docs/smoke/L2-ralplan-handoff-smoke.md` (NEW)

**Implementation steps:**
1. Write a minimal 1-story spec to `.omcp/ralplan-smoke-spec.md`.
2. Run `omcp ralplan "implement <spec>"` (WITHOUT `--handoff` first) -- verify boulder state written with non-empty `planContent`.
3. Run `omcp ralplan --handoff "implement <spec>"` -- verify ralph auto-starts and picks up the boulder plan.
4. Capture: boulder-state.json contents, plan file contents, ralph-state.json after ralph starts.
5. Write smoke artifact.

**Test plan:** No code tests. Smoke artifact is the deliverable.

**Acceptance criteria closed:** AC-S2 (ralplan handoff smoke)

**Commit-message draft:**
```
docs(smoke): L2 ralplan handoff smoke

Verified omcp ralplan writes non-empty planContent to boulder state
and --handoff flag auto-triggers omcp ralph.

Constraint: Smoke only -- no code changes
Confidence: medium (depends on Copilot producing plan output)
Scope-risk: narrow
```

---

#### Phase L2.4: Live smoke for verify-phase against real Copilot

**Title:** `docs(smoke): L2 verify-phase live Copilot smoke`

**Files touched:**
- `docs/smoke/L2-verify-phase-live-smoke.md` (NEW)

**Implementation steps:**
1. Write a known submission to `.omcp/state/verification/smoke-1-submission.md` with clear acceptance criteria (trivially passing).
2. Run `omcp verify-phase smoke-1 --timeout 120`.
3. Capture raw stdout from both architect and critic Copilot runs.
4. Verify `detectVerdict()` matches the stdout -- OR document the format gap (e.g., "Copilot wraps verdict in reasoning paragraph; verdict keyword is not on its own line").
5. If format gap found: propose a prompt-template fix (add `<verdict>APPROVE</verdict>` sentinel instruction to architect/critic prompt templates at `src/cli/commands/verify-phase.ts:54-58`) as a follow-up phase. Do NOT attempt the fix in this smoke phase.

**Test plan:** No code tests. Smoke artifact is the deliverable.

**Acceptance criteria closed:** AC-S4 (verify-phase live smoke), AC2.4 (exercised against live Copilot)

**Commit-message draft:**
```
docs(smoke): L2 verify-phase live Copilot smoke

Exercised omcp verify-phase smoke-1 against live Copilot.
Documents verdict format match/gap for detectVerdict().

Constraint: Smoke only -- no code changes
Confidence: medium (environmental dependency)
Scope-risk: narrow
```

---

#### Phase L2.5a: Stage-transition state schema for team (schema only, no resume) [CHANGED: was L2.5 with resume claim]

**Title:** `feat(team): stage-transition state schema (forward-compat, no orchestration loop)`

**Files touched:**
- `src/cli/commands/team.ts:63-113` -- `runTeam()` function (write initial phase at spawn)
- `src/runtime/mode-state.ts:54-58` -- extend `TeamState` interface with optional `current_phase` and `stage_history`
- `src/cli/commands/__tests__/team-stage-state.test.ts` (NEW)
- `src/__tests__/team-stage-state.integration.test.ts` (NEW) [Issue #7]

**Implementation steps:**
1. Extend `TeamState` interface at `src/runtime/mode-state.ts:54` to add:
   ```typescript
   current_phase?: TeamPhase;
   stage_history?: Array<{ from: string; to: string; at: string; reason?: string }>;
   ```
   Where `TeamPhase` is omc's actual 6-value enum ported verbatim from `src/team/phase-controller.ts:3-9`:
   ```typescript
   export type TeamPhase =
     | 'initializing'
     | 'planning'
     | 'executing'
     | 'fixing'
     | 'completed'
     | 'failed';
   ```
   Reference: omc's `TeamPhaseState` at `src/team/types.ts:457-463` and `TeamPhase` at `src/team/phase-controller.ts:3-9`. [FIXED: Issue #1 -- uses omc's actual enum values verbatim, not the invented `team-*` prefixed values from iter-1]
2. In `runTeam()` at `src/cli/commands/team.ts:63`, write initial `TeamState` with `current_phase: 'executing'` via `writeModeState("team", ...)` using `atomicWriteFileSync` (invariant 2). The value is `'executing'` (not `'initializing'`) because `runTeam()` has already parsed the spec and is about to spawn workers -- the initialization phase is complete by the time state is written. [FIXED: Issue #2 -- writes omc's actual enum value]
3. Both `current_phase` and `stage_history` are **optional** fields on `TeamState`. This means existing v1.0.0 state files that lack these fields remain parseable (backward compat). New state files include them.
4. **No crash-restart resume is implemented in this phase.** omcp's `runTeam` (`team.ts:63`) is fire-and-forget: spawn N detached workers and return. There is no team-level orchestration loop to "resume into." The schema fields are forward-compatible groundwork for the future phase controller (L2.5b, deferred to v1.2.0). [FIXED: Issue #2 -- removed the false resume claim]

**Test plan (>=4 unit tests, TDD):** [CHANGED: was >=6 with resume tests; reduced to match actual scope]
- `src/cli/commands/__tests__/team-stage-state.test.ts`:
  1. `runTeam` writes TeamState with `current_phase: 'executing'`
  2. `current_phase` and `stage_history` fields are present in written state
  3. State written via `atomicWriteFileSync` (not bare writeFileSync)
  4. `TeamPhase` type accepts all 6 omc values: `'initializing' | 'planning' | 'executing' | 'fixing' | 'completed' | 'failed'`

**Integration tests (>=2, assigned to this phase):** [Issue #7]
- `src/__tests__/team-stage-state.integration.test.ts`:
  1. Stage field written on spawn: `runTeam` produces state file with `current_phase: 'executing'` readable via `readModeState("team")`
  2. Missing-field backward compat: a v1.0.0 state file (no `current_phase`, no `stage_history`) is readable by `readModeState("team")` without error; `current_phase` is `undefined`

**Acceptance criteria closed:** AC2.5 (stage field written and readable; backward compat preserved). Note: AC2.5's "crash + restart" sub-criterion is deferred to L2.5b (v1.2.0).

**Commit-message draft:**
```
feat(team): stage-transition state schema (forward-compat, no orchestration loop)

Extend TeamState with optional current_phase (omc's 6-value TeamPhase
enum: initializing|planning|executing|fixing|completed|failed) and
stage_history. Written at spawn time as 'executing'. Schema only --
no phase-transition orchestrator or crash-restart resume (deferred
to v1.2.0 L2.5b).

Constraint: atomicWriteFileSync for all state writes (invariant 2)
Constraint: Optional fields for backward compat with v1.0.0 state files
Rejected: Invented 'team-*' prefixed values | omc's actual enum ported verbatim
Rejected: Crash-restart resume | runTeam is fire-and-forget; no orchestration loop to resume into
Confidence: high
Scope-risk: narrow (schema extension only)
Directive: L2.5b (v1.2.0) must implement the phase controller before resume is claimed
```

---

#### Phase L2.6: Worker pidfile atomicity

**Title:** `fix(team): atomicWriteFileSync for worker pidfiles (lift invariant 2 carve-out)`

**Files touched:**
- `src/cli/commands/team.ts:103` -- `writeFileSync` -> `atomicWriteFileSync`
- `src/cli/commands/team.ts:20-21` -- import adjustment (remove `writeFileSync` from fs import if no longer needed)
- `docs/architecture/invariants.md:50-56` -- remove pidfile carve-out
- `src/cli/commands/__tests__/team-pidfile-atomic.test.ts` (NEW)

**Implementation steps:**
1. At `src/cli/commands/team.ts:103`, change `writeFileSync(join(pidDir, `worker-${i + 1}.pid`), String(child.pid))` to `atomicWriteFileSync(join(pidDir, `worker-${i + 1}.pid`), String(child.pid))`.
2. Update the import at line 20-21: `writeFileSync` is still used by no other code in this file after the change (check grep). If not needed, remove from the `fs` import destructuring.
3. Update `docs/architecture/invariants.md:50-56` to remove the `team.ts:99` pidfile carve-out paragraph (or replace with a note that the carve-out was lifted in this commit).

**Test plan (>=2 tests, TDD):**
- `src/cli/commands/__tests__/team-pidfile-atomic.test.ts`:
  1. Pidfile write uses `atomicWriteFileSync` (mock/spy check)
  2. Pidfile content is the stringified PID (regression guard)

**Acceptance criteria closed:** AC2.6 (atomicWriteFileSync on pidfiles, carve-out lifted)

**Commit-message draft:**
```
fix(team): atomicWriteFileSync for worker pidfiles (lift invariant 2 carve-out)

team.ts:103 used bare writeFileSync for pidfiles, documented as a
carve-out in invariants.md. Lift the carve-out: pidfiles now use
atomicWriteFileSync for consistency with invariant 2.

Constraint: invariant 2 requires atomicWriteFileSync for all state writes
Rejected: Keep carve-out | pidfiles ARE state; torn writes create orphan workers
Confidence: high
Scope-risk: narrow (1 line change + doc update)
```

---

#### Phase L2.7: Shutdown ack protocol for team

**Title:** `feat(team): shutdown_request state marker + 30s wait + SIGTERM fallback`

**Files touched:**
- `src/cli/commands/team.ts:126-183` -- `stopTeam()` function rework
- `src/cli/commands/team.ts` -- new `requestShutdown()` helper
- `src/cli/commands/__tests__/team-shutdown-ack.test.ts` (NEW)

**Implementation steps:**
1. Add a `requestShutdown(sessionId)` function that writes a `shutdown_request.json` marker to `.omcp/state/team/<sessionId>/` via `atomicWriteFileSync`. Contents: `{ requestId: uuid, reason: string, timestamp: ISO }`. Reference: omc's `ShutdownSignal` at `src/team/types.ts:75-79`.
2. Modify `stopTeam()` at line 126: instead of immediately SIGTERMing all workers, first call `requestShutdown()`, then poll for `shutdown_response.json` (written by workers who detect the marker) for up to 30s. Workers that acknowledge within the window are counted as clean; workers that do not acknowledge after 30s get SIGTERM.
3. Workers detect the shutdown request by checking for the marker file in their poll loop (this is a behavioral contract -- the worker-side implementation is in the Copilot skill, not in omcp's TypeScript; the plan documents the protocol and tests the orchestrator side).

**Test plan (>=5 tests, TDD):**
- `src/cli/commands/__tests__/team-shutdown-ack.test.ts`:
  1. `requestShutdown` writes `shutdown_request.json` with correct schema via `atomicWriteFileSync`
  2. Worker responds within 30s: `stopTeam` reads `shutdown_response.json`, does NOT SIGTERM
  3. Worker does not respond within 30s: `stopTeam` falls back to SIGTERM (existing `killProcess` path)
  4. Multiple workers: some ack, some don't -- ack'd workers not killed, non-ack'd workers killed
  5. `shutdown_request.json` cleaned up after stop completes

**Acceptance criteria closed:** AC2.7 (shutdown_request + 30s wait + SIGTERM fallback)

**Commit-message draft:**
```
feat(team): shutdown_request state marker + 30s wait + SIGTERM fallback

Port omc's graceful shutdown protocol. stopTeam() now writes
shutdown_request.json and waits up to 30s for worker acknowledgment
before falling back to SIGTERM.

Constraint: atomicWriteFileSync for state writes (invariant 2)
Rejected: Immediate SIGTERM only | workers may lose in-progress work
Rejected: Infinite wait | bounded at 30s to prevent hang
Confidence: high
Scope-risk: moderate (reworks stopTeam flow)
Directive: Worker-side detection is a skill-layer contract, not enforced here
Not-tested: Real worker processes acknowledging (covered by L2.9 smoke)
```

---

#### Phase L2.8: Stuck-worker watchdog

**Title:** `feat(team): stuck-worker watchdog -- 10min in_progress timeout`

**Files touched:**
- `src/cli/commands/team.ts` -- new `checkStuckWorkers()` function
- `src/runtime/mode-state.ts:54-58` -- extend `TeamState.workers` with `last_shard_write_at` field
- `src/cli/commands/__tests__/team-watchdog.test.ts` (NEW)

**Implementation steps:**
1. Add a `checkStuckWorkers(sessionId, opts?)` function that reads per-worker shard state (`src/lib/team-shard-state.ts`) and compares the last modification time of each worker's shard file against the current wall-clock.
2. If a worker's shard file has not been modified for >10 minutes AND its status is `in_progress`, emit a warning to stderr and return the stuck worker identifiers.
3. The caller (team lead orchestration or a periodic check) can use this to offer reassignment or escalation. Reference: omc's `runtime-watchdog-retry.test.ts` at `src/team/__tests__/`.
4. Extend `TeamState.workers` array entries with an optional `last_shard_write_at?: string` field for persistence.

**Test plan (>=4 tests, TDD):**
- `src/cli/commands/__tests__/team-watchdog.test.ts`:
  1. Worker with shard write <10min ago: not flagged as stuck
  2. Worker with shard write >10min ago + status `in_progress`: flagged as stuck
  3. Worker with shard write >10min ago + status `completed`: NOT flagged (already done)
  4. Multiple workers: only the stuck ones returned

**Acceptance criteria closed:** AC2.8 (stuck-worker detection + warning)

**Commit-message draft:**
```
feat(team): stuck-worker watchdog -- 10min in_progress timeout

Detect workers stuck in in_progress for >10min with no shard write.
Logs warning and returns stuck worker IDs for reassignment.
Reference: omc's runtime-watchdog-retry pattern.

Constraint: Detection only -- does not auto-kill (caller decides)
Rejected: Auto-reassign on timeout | too aggressive for v1.1; offer-only
Confidence: high
Scope-risk: narrow (new function, no existing code modified)
Not-tested: Real concurrent workers hitting timeout (covered by L2.9 smoke)
```

---

#### Phase L2.9: Live smoke for omcp team with N=4

**Title:** `docs(smoke): L2 team 4:executor smoke -- shard files + merge`

**Files touched:**
- `docs/smoke/L2-team-4-executor-smoke.md` (NEW)

**Implementation steps:**
1. Write a 4-story PRD to `.omcp/prd.json` with trivial stories.
2. Run `omcp team 4:executor "implement the PRD stories"`.
3. Verify: 4 shard files written to `.omcp/state/team/<sessionId>/`.
4. Run `omcp team merge-shards <team-name>` -- verify reconciled PRD shows all stories `passes: true`.
5. Verify stage-transition state: TeamState shows `current_phase: 'executing'` (the value written at spawn by L2.5a).
6. Capture: shard file contents, merge report, TeamState snapshots.
7. **If environmental issues prevent 4 workers, degrade to 2 workers** (see Phase Z SOFT gate). [Issue #4]

**Test plan:** No code tests. Smoke artifact is the deliverable.

**Acceptance criteria closed:** AC-S3 (team multi-agent smoke), AC2.5 (stage field verified in smoke)

**Commit-message draft:**
```
docs(smoke): L2 team 4:executor smoke -- shard files + merge

4-worker team run with shard-write and merge-shards verification.
Stage-transition state observed: current_phase='executing' at spawn.

Constraint: Smoke only -- no code changes
Confidence: medium (environmental dependency)
Scope-risk: narrow
```

---

### Layer 3 -- Long-running resilience

---

#### Phase L3.1: progress.txt rolling-tail cap

**Title:** `feat(ralph-state): progress.txt rolling-tail cap (configurable, default 64KB)`

**Files touched:**
- `src/lib/ralph-state.ts:329-351` -- `appendProgressNote()` function
- `src/lib/ralph-state.ts:312-320` -- `readProgressNotes()` function
- `src/lib/ralph-state.ts:403-421` -- `getRalphContext()` function (inject only tail)
- `src/lib/ralph-state.ts` -- new `PROGRESS_MAX_BYTES` constant (default 65536)
- `src/lib/__tests__/ralph-state-progress-cap.test.ts` (NEW)

**Implementation steps:**
1. Add a `PROGRESS_MAX_BYTES` constant (default 65536 = 64KB) at the top of `ralph-state.ts`. Allow override via `process.env.OMCP_PROGRESS_MAX_BYTES`.
2. In `appendProgressNote()` at line 329: after constructing `next` (the new full content), if `Buffer.byteLength(next, 'utf-8') > PROGRESS_MAX_BYTES`, truncate by dropping the oldest entries (everything before the first `##` header that keeps the file under the cap). Write the truncated content.
3. In `getRalphContext()` at line 403: the function already reads the full progress file. No change needed if `appendProgressNote` enforces the cap. But add a defensive tail-only read: if the file is somehow larger than `PROGRESS_MAX_BYTES` (e.g., external writes), only inject the last `PROGRESS_MAX_BYTES` bytes.

**Test plan (>=5 tests, TDD):**
- `src/lib/__tests__/ralph-state-progress-cap.test.ts`:
  1. Append below cap: full content preserved
  2. Append pushes over cap: oldest entries truncated, newest preserved, file stays under cap
  3. Truncation boundary respects `##` header lines (does not cut mid-entry)
  4. `getRalphContext` with oversized file: only tail injected
  5. Custom cap via env var `OMCP_PROGRESS_MAX_BYTES` honored

**Acceptance criteria closed:** AC3.1 (configurable size cap, rolling tail, tests)

**Commit-message draft:**
```
feat(ralph-state): progress.txt rolling-tail cap (configurable, default 64KB)

appendProgressNote now enforces a rolling cap: when progress.txt
exceeds PROGRESS_MAX_BYTES (default 64KB), oldest entries are
truncated. getRalphContext injects only the tail.

Constraint: Truncation boundary respects ## header lines (no mid-entry cuts)
Rejected: Ring-buffer in JSON | progress.txt is human-readable plain text
Confidence: high
Scope-risk: narrow (3 functions in ralph-state.ts)
Not-tested: Concurrent writers (omcp hooks are sequential per-event)
```

---

#### Phase L3.2: Preemptive-compaction rework -- remove permanent silencing

**Title:** `fix(preemptive-compaction): replace MAX_WARNINGS permanent silence with per-N-iter re-arm`

**Files touched:**
- `src/hooks/preemptive-compaction/constants.ts:33` -- `MAX_WARNINGS = 3` -> remove or repurpose [FIXED: was `:32` in iter-1; actual line is 33 per Issue #5]
- `src/hooks/preemptive-compaction/index.ts:206-232` -- `shouldShowWarning()` rework
- `src/hooks/preemptive-compaction/index.ts:246-284` -- `runContextCheck()` rework (add prompt-history estimate)
- `src/hooks/preemptive-compaction/types.ts` -- update `PreemptiveCompactionConfig` with new fields
- `src/hooks/preemptive-compaction/__tests__/preemptive-compaction-rearm.test.ts` (NEW)

**Implementation steps:**
1. The current `shouldShowWarning()` at `index.ts:206` permanently silences warnings after `MAX_WARNINGS = 3` firings (at `constants.ts:33` [FIXED]: `if (state.warningCount >= maxWarnings) return false`). For long-running ralph loops, this means compaction advice stops after iteration ~3 and never returns, even as context grows past critical.
2. Replace the permanent cap with a **per-N-iterations re-arm**: reset `warningCount` to 0 every N ralph iterations (configurable, default N=5). Read the current ralph iteration from `readRalphState()` and compare against a `lastRearmIteration` field added to the persisted session state.
3. Expand the token estimator at `runContextCheck()` line 246: currently `state.estimatedTokens` only counts `LARGE_OUTPUT_TOOLS` outputs (line 289-296). Add an estimate for prompt-history size by reading `readProgressNotes()` byte count + `readRalphState()` to estimate accumulated context. This makes the threshold check aware of the growing prompt injection from `getRalphContext()`.
4. Update `PreemptiveCompactionConfig` type to include `rearmEveryNIterations?: number` (default 5).

**Test plan (>=6 tests, TDD):**
- `src/hooks/preemptive-compaction/__tests__/preemptive-compaction-rearm.test.ts`:
  1. Warning count resets after N iterations (re-arm fires)
  2. Warning count does NOT reset before N iterations
  3. Token estimator includes progress.txt size in threshold calculation
  4. Token estimator includes ralph-state context size estimate
  5. Re-arm with custom N via config (e.g., rearmEveryNIterations=3)
  6. Backward compat: config without `rearmEveryNIterations` defaults to 5

**Acceptance criteria closed:** AC3.2 (MAX_WARNINGS silencing replaced, token estimator expanded)

**Commit-message draft:**
```
fix(preemptive-compaction): replace MAX_WARNINGS permanent silence with per-N-iter re-arm

MAX_WARNINGS=3 (constants.ts:33) permanently silenced compaction
advice after 3 firings, making it inert mid-long-run. Replace with
per-N-iterations re-arm (default N=5). Also expand token estimator
to count progress.txt and ralph-state context size, not just
LARGE_OUTPUT_TOOLS.

Constraint: Must not break existing cooldown behavior (COMPACTION_COOLDOWN_MS)
Rejected: Remove all rate limiting | would spam every PostToolUse
Confidence: high
Scope-risk: moderate (touches compaction threshold logic)
Not-tested: Real Copilot honoring advise responses in --autopilot mode (L3.6 smoke)
```

---

#### Phase L3.3: Conditional clearRalphState for crash recovery

**Title:** `fix(mode): conditional clearRalphState -- preserve state on crash`

**Files touched:**
- `src/cli/commands/mode.ts:170-174` -- ralph-specific exit handler
- `src/lib/ralph-state.ts:265-279` -- `getPrdStatus()` (read-only, used for allComplete check)
- `src/cli/commands/__tests__/mode-ralph-recovery.test.ts` (NEW)
- `src/__tests__/ralph-state-crash-recovery.integration.test.ts` (NEW) [Issue #7]

**Implementation steps:**
1. At `src/cli/commands/mode.ts:171-173`, the current code is:
   ```typescript
   if (opts.mode === "ralph") {
     clearRalphState();
   }
   ```
   Replace with conditional logic:
   ```typescript
   if (opts.mode === "ralph") {
     const exitCode = result.status ?? 1;
     const state = readRalphState();
     const prdStatus = getPrdCompletionStatus();
     const shouldClear = exitCode === 0 && (prdStatus.allComplete || state?.architectApproved === true);
     if (shouldClear) {
       clearRalphState();
     } else {
       // Preserve state for resume -- log the reason
       console.error(`omcp: ralph-state preserved (exit=${exitCode}, allComplete=${prdStatus.allComplete}). Resume with 'omcp ralph'.`);
     }
   }
   ```
2. This means: clear ralph-state ONLY when copilot exits 0 AND (all PRD stories complete OR architect approved). Any other exit (crash, SIGTERM, non-zero exit) preserves state for resume.
3. **Note: `src/hooks/persistent-mode/index.ts:122-123` (architectApproved branch) and `:143` (allComplete branch) also call `clearRalphState`. These are the CORRECT conditional paths -- they fire only on legitimate completion signals (architect approval detected in Stop hook context, or all PRD stories passing). L3.3 does NOT modify them; this is intentional. Only the unconditional call in `mode.ts:171-173` is the bug being fixed.** [ADDED: Issue #6 -- explicit acknowledgment of persistent-mode call sites]

**Test plan (>=5 unit tests, TDD):**
- `src/cli/commands/__tests__/mode-ralph-recovery.test.ts`:
  1. Exit 0 + allComplete: ralph-state cleared
  2. Exit 0 + architectApproved: ralph-state cleared
  3. Exit 0 + NOT allComplete + NOT approved: ralph-state preserved (the mid-loop clean-exit case)
  4. Exit 1 (crash): ralph-state preserved
  5. Exit SIGTERM (signal kill): ralph-state preserved

**Integration tests (>=3, assigned to this phase):** [Issue #7]
- `src/__tests__/ralph-state-crash-recovery.integration.test.ts`:
  1. Exit 0 + allComplete = clear: write ralph-state + PRD with all stories passing, simulate exit 0 through mode handler, verify ralph-state file deleted
  2. Exit 0 + incomplete = keep: write ralph-state + PRD with pending stories, simulate exit 0, verify ralph-state file still exists with iteration counter preserved
  3. Non-zero exit = keep: write ralph-state, simulate exit 1, verify ralph-state file still exists with iteration counter preserved

**Acceptance criteria closed:** AC3.3 (conditional clearRalphState, both branches tested)

**Commit-message draft:**
```
fix(mode): conditional clearRalphState -- preserve state on crash

clearRalphState() was called unconditionally on any copilot exit,
losing iteration counter on crashes. Now: clear only when exit 0
AND (allComplete OR architectApproved). Crashes preserve state
for resume.

persistent-mode/index.ts:122-123 (architectApproved branch — freshly detected), :133 (architectApproved branch — pre-existing state already set), and :143 (allComplete branch) also call clearRalphState
but only on legitimate completion signals -- intentionally not modified.

Constraint: readRalphState/getPrdCompletionStatus are read-only calls; no side effects
Rejected: Always preserve | completed runs would leave stale state blocking restart
Confidence: high
Scope-risk: moderate (changes ralph exit behavior)
Directive: Must not introduce a window where both ralph-state AND mode-state are stale
Not-tested: Race between clearRalphState and clearModeState (sequential in mode.ts)
```

---

#### Phase L3.4: Stale mode-state auto-detect with --resume

**Title:** `feat(mode): stale mode-state detection + omcp ralph --resume`

**Files touched:**
- `src/cli/commands/mode.ts:85-100` -- `canStartMode` handling block
- `src/runtime/mode-state.ts:144-157` -- `canStartMode()` function (add age check)
- `src/cli/commands/__tests__/mode-stale-resume.test.ts` (NEW)

**Implementation steps:**
1. In `canStartMode()` at `src/runtime/mode-state.ts:144`: when a conflicting active mode is found, also check the `started_at` timestamp. If `Date.now() - Date.parse(state.started_at) > 60 * 60 * 1000` (1 hour), mark the conflict as `stale: true` in the return value.
2. In `src/cli/commands/mode.ts:85-100`: when `canStartMode` returns `{ ok: false, stale: true }`, log a message suggesting `omcp ralph --resume` or `omcp cancel`.
3. Add `--resume` flag to ralph mode command. When present AND stale mode-state detected: auto-clear the stale mode-state, read the preserved ralph-state (from L3.3), and restart from the last iteration.

**Test plan (>=4 tests, TDD):**
- `src/cli/commands/__tests__/mode-stale-resume.test.ts`:
  1. Mode-state <60min old: `canStartMode` returns `{ ok: false, stale: false }` (existing behavior)
  2. Mode-state >60min old: `canStartMode` returns `{ ok: false, stale: true }`
  3. `--resume` with stale state: auto-clears mode-state, reads ralph-state, starts from preserved iteration
  4. `--resume` without stale state (fresh conflict): rejects with clear error

**Acceptance criteria closed:** AC3.4 (stale detection + --resume flag)

**Commit-message draft:**
```
feat(mode): stale mode-state detection + omcp ralph --resume

canStartMode now detects stale active mode-state (>60min) and
suggests --resume. The --resume flag auto-clears stale state and
restarts ralph from the preserved iteration.

Constraint: Never auto-clear fresh (<60min) state -- only stale
Rejected: Auto-clear all stale state without flag | too aggressive; --resume is explicit
Confidence: high
Scope-risk: moderate (modifies canStartMode return shape)
```

---

#### Phase L3.5: Per-event hook timeouts in copilot-config.ts

**Title:** `feat(hooks): per-event configurable hook timeouts`

**Files touched:**
- `src/runtime/copilot-config.ts:220-226` -- `MergeHookOptions` interface
- `src/runtime/copilot-config.ts:292-295` -- `mergeCopilotHooks()` timeout assignment
- `src/runtime/copilot-config.ts:310-320` -- per-event timeout lookup in the loop
- `src/__tests__/copilot-config.per-event-timeout.test.ts` (NEW)

**Implementation steps:**
1. Add `perEventTimeout?: Partial<Record<string, number>>` to `MergeHookOptions` at line 220-226. This allows callers to specify per-event timeout overrides (e.g., `{ Stop: 30, PreCompact: 30 }`).
2. In `mergeCopilotHooks()` at line 310-320, when building the hook entry for each event, use `perEventTimeout?.[event] ?? opts.timeoutSec ?? 5` as the timeout value.
3. Update the default call in `applyOmcpHookWiring()` at line 363-368 to pass `perEventTimeout: { Stop: 30, PreCompact: 30 }` so orchestration-critical events get more budget (cold-start ~840ms + complex hook logic).

**Test plan (>=4 tests, TDD):**
- `src/__tests__/copilot-config.per-event-timeout.test.ts`:
  1. Events without override use default timeout (5s)
  2. Stop event with override uses 30s
  3. PreCompact event with override uses 30s
  4. Custom perEventTimeout map overrides specific events, preserves default for others

**Acceptance criteria closed:** AC3.5 (per-event configurable timeouts, 30s for Stop + PreCompact)

**Commit-message draft:**
```
feat(hooks): per-event configurable hook timeouts

Default 5s preserved for most events. Stop and PreCompact raised
to 30s to accommodate cold-start (~840ms) + complex hook logic.
perEventTimeout map on MergeHookOptions allows per-event overrides.

Constraint: Default 5s for non-orchestration events preserved (backward compat)
Rejected: Global 30s for all events | wasteful; most events are lightweight
Confidence: high
Scope-risk: narrow (additive option, no existing behavior changed without explicit override)
```

---

#### Phase L3.6: 30-iteration ralph smoke

**Title:** `docs(smoke): L3 30-iteration ralph smoke -- long-running resilience`

**Files touched:**
- `docs/smoke/L3-30-iteration-ralph-smoke.md` (NEW)
- `.omcp/prd-30-stories.json` (NEW -- synthetic 30-story PRD)

**Implementation steps:**
1. Write `.omcp/prd-30-stories.json` with 30 trivial stories (each story: "create file `.omcp-smoke/story-N.txt` with content 'story N complete'").
2. Run `omcp ralph --prd .omcp/prd-30-stories.json "implement all 30 stories"`.
3. Capture checkpoints at iteration 1, 10, 20, 30:
   - `ralph-state.json` (iteration counter advancing, active=true)
   - `progress.txt` size (must stay under 64KB cap)
   - Copilot log grep for compaction hook firings (must fire at least once past iteration 10 -- verifying re-arm works)
   - No `eval_stdin` errors in logs (L1 fix holds)
4. End-state verification:
   - All 30 stories `passes: true`
   - `ralph-state.json` cleared (allComplete + exit 0)
   - `progress.txt` within cap
5. **If Copilot rate-limits, degrade to 10 iterations** (see Phase Z SOFT gate). [Issue #4]
6. Write smoke artifact.

**Test plan:** No code tests. Smoke artifact is the deliverable.

**Acceptance criteria closed:** AC-S5 (30-iteration smoke), AC3.1 (progress.txt within cap observed), AC3.2 (compaction not silenced observed)

**Commit-message draft:**
```
docs(smoke): L3 30-iteration ralph smoke -- long-running resilience

30-story synthetic PRD driven through full ralph loop.
Progress.txt stays within 64KB cap, compaction re-arm fires,
no state corruption across 30 iterations.

Constraint: Smoke only -- no code changes
Confidence: medium (30 iterations of live Copilot)
Scope-risk: narrow
```

---

### Hygiene / Release

---

#### Phase H.1: cli-wiring-invariants extension (if needed)

**Title:** `test(invariants): cli-wiring-invariants covers new CLI verbs`

**Files touched:**
- `src/__tests__/cli-wiring-invariants.test.ts` -- extend if new verbs added

**Implementation steps:**
1. Review whether any new CLI verbs were added that need coverage in the invariants test (e.g., `--resume` flag on ralph, `--handoff` flag on ralplan, `--timeout` on verify-phase).
2. If the invariants test at `src/__tests__/cli-wiring-invariants.test.ts` needs extension, add the checks.
3. If no new manifests gain version fields, this phase is a no-op (commit skipped).

**Test plan:** Extension of existing tests only.

**Acceptance criteria closed:** AC-H1 (no regressions)

---

#### Phase Z: Version bump + release

**Title:** `chore(release): v1.1.0 -- orchestrate-complete (L1+L2+L3)`

**Smoke gate table (HARD vs SOFT):** [ADDED: Issue #4]

| Smoke | Gate | Justification |
|-------|------|---------------|
| L1.2 (hook re-smoke) | **HARD** | L1's primary deliverable is hook noise elimination; if hook errors remain, v1.1.0's core promise is unmet. |
| L2.3 (ralplan handoff smoke) | **HARD** | L2.1's primary user-facing deliverable is the ralplan->ralph chain; shipping with a broken handoff defeats the purpose of L2. |
| L2.4 (verify-phase live smoke) | **SOFT** | If Copilot stdout format prevents `detectVerdict` from matching, document the gap + propose a prompt-template fix in v1.2.0; v1.1.0 ships the timeout + DI-mock coverage anyway. |
| L2.9 (team multi-agent smoke) | **SOFT** | Team is the most exploratory layer; document gap + follow-up if environmental issues prevent clean completion. Worker count may be reduced from 4 to 2 if environmental. |
| L3.6 (30-iteration ralph smoke) | **SOFT** | Synthetic, evidence-only. v1.1.0 can cut with reduced iteration count (10 instead of 30) if Copilot rate-limits. |

**Precondition:** All HARD gates PASS. All SOFT gates either PASS or have documented gap + proposed fix in follow-ups.

**Files touched:**
- `package.json` -- version `1.0.0` -> `1.1.0`
- `.claude-plugin/plugin.json` -- same bump
- `.agents/plugins/marketplace.json` -- same bump in `plugins[0].version`
- `plugins/oh-my-copilot/.claude-plugin/plugin.json` -- same bump
- `CHANGELOG.md` -- prepend `## [1.1.0]` section
- `HANDOFF.md` -- update to v1.1.0 shipped state

**Implementation steps:**
1. Bump all 4 version-carrier manifests from `1.0.0` to `1.1.0`.
2. Prepend `CHANGELOG.md` with `## [1.1.0] -- 2026-05-XX` section summarizing:
   - L1: Hook dispatch format fix (zero errors in re-smoke)
   - L2: ralplan handoff, verify-phase timeout, team stage state (schema only), pidfile atomicity, shutdown ack, stuck-worker watchdog
   - L3: progress.txt cap, compaction re-arm, crash recovery, stale-state resume, per-event hook timeouts
3. Update `HANDOFF.md`: mark v1.1.0 shipped, list remaining follow-ups (daemon mode, surgeon mode, L2.5b phase controller, any detected-but-deferred gaps from smokes).
4. Final `npx vitest run` -- must be >=979 + delta from new tests, 0 new failures.
5. Final `npm run build` -- tsc clean.
6. `git tag v1.1.0`.

**Acceptance criteria closed:** AC-H2 (build clean), AC-H3 (4-manifest sync), AC-H4 (HANDOFF updated), AC-H5 (CHANGELOG prepended)

**Commit-message draft:**
```
chore(release): v1.1.0 -- orchestrate-complete (L1+L2+L3)

L1: Hook dispatch format fix (zero eval_stdin errors).
L2: ralplan handoff, verify-phase timeout, team stage/shutdown/watchdog.
L3: progress.txt cap, compaction re-arm, crash recovery, stale resume.

Constraint: 4-manifest version sync (invariant 3)
Confidence: high
Scope-risk: narrow (manifest bump only)
```

---

## Expanded Test Plan (deliberate mode -- required)

### Unit layer

| Phase | New tests | Coverage |
|-------|-----------|----------|
| L1.1 | >=9 | All 13 events command format, __omcp marker, timeout, merge preservation, **Stop consistency** [+1 from iter-1] |
| L2.1 | >=6 | ralplan handoff flag, planContent population, auto-ralph-spawn |
| L2.2 | >=5 | verify-phase timeout threading, SIGTERM handling |
| L2.5a | >=4 | Team stage schema, phase field write, atomicWriteFileSync, TeamPhase type coverage [CHANGED: was >=6 with resume tests] |
| L2.6 | >=2 | Pidfile atomicity |
| L2.7 | >=5 | Shutdown request/response protocol, timeout fallback |
| L2.8 | >=4 | Stuck-worker detection at 10min boundary |
| L3.1 | >=5 | progress.txt cap, truncation boundary, tail-only injection |
| L3.2 | >=6 | Compaction re-arm, token estimator expansion |
| L3.3 | >=5 | Conditional clearRalphState (5 exit scenarios) |
| L3.4 | >=4 | Stale mode-state detection, --resume flag |
| L3.5 | >=4 | Per-event timeout overrides |
| **Total** | **>=59** | **All new code paths covered** |

### Integration layer [CHANGED: Issue #7 -- concrete file names, test counts, phase assignments]

| Phase | File | Tests | What it covers |
|-------|------|-------|----------------|
| L2.1 | `src/__tests__/ralplan-handoff.integration.test.ts` | >=3 | Handoff flag default (off); handoff flag on + empty plan content (rejected); handoff flag on + populated plan (succeeds, boulder state shows non-empty planContent) |
| L2.5a | `src/__tests__/team-stage-state.integration.test.ts` | >=2 | Stage field written on spawn (readable via readModeState); missing-field backward compat with v1.0.0 state files |
| L3.3 | `src/__tests__/ralph-state-crash-recovery.integration.test.ts` | >=3 | Exit 0 + allComplete = clear; exit 0 + incomplete = keep; non-zero exit = keep |
| **Total** | **3 files** | **>=8** | **Cross-module state contracts** |

### E2E layer

| Test | What it covers |
|------|----------------|
| Existing `ralph-loop-e2e.test.ts` | 3 scenarios (no changes, regression guard) |
| L1.2 smoke artifact | Real Copilot dispatch, zero hook errors, Stop hook verified |
| L2.3 smoke artifact | Real Copilot ralplan -> ralph handoff |
| L2.4 smoke artifact | Real Copilot verify-phase verdict parsing |
| L2.9 smoke artifact | Real 4-worker team shard + merge (or 2-worker degraded) |
| L3.6 smoke artifact | Real 30-iteration ralph long-run (or 10-iteration degraded) |

### Observability layer

| Artifact | Structure |
|----------|-----------|
| `docs/probes/L1-hook-dispatch-format.md` | Command form comparison, reproduction steps, root cause |
| `docs/smoke/L1-hook-dispatch-resmoke.md` | Pre-flight, run metadata, log grep, Stop verification, verdict |
| `docs/smoke/L2-ralplan-handoff-smoke.md` | Boulder state dump, plan file content, ralph-state snapshot |
| `docs/smoke/L2-verify-phase-live-smoke.md` | Raw stdout captures, detectVerdict match/gap |
| `docs/smoke/L2-team-4-executor-smoke.md` | Shard files, merge report, TeamState snapshots |
| `docs/smoke/L3-30-iteration-ralph-smoke.md` | 4 checkpoints (iter 1/10/20/30), progress.txt size, compaction firings |

All smoke artifacts follow the v1.0.0 precedent format: run metadata table, pre-flight state, mid-run checkpoints, end-state verification, verdict.

---

## Architecture Decision Record (ADR)

**Decision:** Fix all three orthogonal layers (L1 hook dispatch, L2 multi-agent, L3 long-running resilience) in a sequential probe-first pipeline, cutting v1.1.0 when all HARD smoke gates pass and all SOFT gates either pass or have documented gaps with proposed fixes.

**Drivers:**
1. User explicitly scoped all 3 layers as in-scope ("ralph, ralplan, team, 长时间运行, team 多 agent 分工, 之前出现的问题也一并修上").
2. L2/L3 smoke gates depend on L1 clean hooks -- sequential execution is the natural dependency order.
3. The trace identified 3 independent failure domains, each with its own root cause and fix -- they are not alternative explanations but additive requirements.

**Alternatives considered:**
- **V-B (parallel L1+L3):** Rejected -- L3 smoke needs clean hooks from L1; false parallelism wastes time on a blocked smoke.
- **V-C (L1 only, defer L2+L3):** Rejected -- violates user's explicit scope. Would leave the broken ralplan handoff and missing crash recovery in production.
- **V-D (L1+L2+L3 + daemon + surgeon):** Rejected -- daemon mode and modifiedArgs surgeon are explicit non-goals (spec lines 31-34). Scope creep.

**Why chosen:**
- V-A matches the user's stated scope exactly.
- Sequential execution respects the L1->L2->L3 dependency chain.
- Probe-first discipline catches hypothesis invalidation early (L1.0 probe before L1.1 fix).
- Each smoke gate provides evidence that the prior layer's fix holds under real conditions.
- The plan produces >=59 new unit tests + >=8 integration tests + 6 smoke artifacts -- sufficient evidence for v1.1.0 cut.
- HARD/SOFT gate classification prevents environmental issues from blocking the entire release while still requiring core deliverables to pass.

**Consequences:**
- Total wall-clock will be significant (5 live Copilot smokes, each requiring manual observation).
- Each smoke may surface environmental issues that require unplanned triage (pre-mortem scenarios cover the 3 most likely).
- The `TeamState` interface change (L2.5a) is a minor schema evolution -- existing state files are forward-compatible (new fields are optional). No crash-restart resume is implemented; the schema is groundwork for the future phase controller.
- `clearRalphState` behavior change (L3.3) is a **behavioral break** for the edge case where ralph exits 0 without allComplete -- previously state was always cleared, now it is preserved. This is the correct behavior but callers that relied on unconditional clearing will need adjustment. The two call sites in `persistent-mode/index.ts` (lines 122-123 and 143) are intentionally not modified -- they already fire conditionally on legitimate completion signals.

**Follow-ups (post-v1.1.0):**
1. Daemon mode (orchestrator-v1 Option O-B) -- if cold-start measurements from L3.5 per-event timeouts prove 5s is too tight even with 30s for Stop/PreCompact.
2. modifiedArgs surgeon mode (Phase 7) -- gated on TUI smoke PASS (now available since v1.0.0).
3. `detectVerdict` sentinel protocol upgrade -- if L2.4 smoke reveals format gap, implement `<verdict>APPROVE</verdict>` prompt-template fix.
4. Worker-side shutdown ack implementation -- L2.7 documents the protocol; workers need to poll for `shutdown_request.json` in their skill loop.
5. **L2.5b: Phase-transition orchestrator with crash-restart resume** -- implement actual team-level orchestration loop that can resume from `current_phase` after crash. Requires refactoring `runTeam` from fire-and-forget to a supervised loop. [ADDED: Issue #2 deferred scope]
6. **L3.2 re-arm backoff** -- if advise proves ineffective after multiple re-arms, implement exponential backoff on compaction warnings rather than continuing at fixed N-iteration intervals. [ADDED: Architect non-blocking note]
7. `npm pack && npm install -g <.tgz>` CI gate -- carried forward from v1.0.0 ADR follow-ups.
8. OMC upstream `$CLAUDE_PLUGIN_ROOT` patch -- separate repo, separate session.
