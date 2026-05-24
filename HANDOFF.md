# omcp 续接 handoff

**Updated**: 2026-05-25 early-morning (v1.6.0 cut — mode.ts outer-loop for ralph iteration advance, LIVE-VERIFIED past gate)
**Repo**: `C:\Users\runjiashi\oh-my-copilot-r2` (the **r2**, not the parallel `oh-my-copilot/`)
**Latest commit**: see `git log -1` — Phase Z v1.6.0 release commit
**Version**: **v1.6.0** (outer-loop ralph; cut this session atop v1.5.0; FIRST tag since v1.3 with live iteration-advance proven)
**Tests**: 1167 passing, 0 failed, 2 skipped (+11 from v1.5.0 baseline 1156, +188 from v1.0.0 baseline 979), 1 pre-existing Windows worker-fork EPERM baseline unchanged since v0.4.0
**Build**: `npm run build` clean (tsc no diagnostics)

---

## v1.6.0 deliverables (this session)

User critique driving v1.6: "为什么一直在叠加版本号，而不是在某一个版本
解决遇到的问题" — why keep stacking version numbers instead of solving
the problem in one version. v1.3 L3.6 smoke first surfaced
"iteration counter stuck at 1"; v1.4 + v1.5 shipped tags without fixing
it. v1.6 ships the actual fix and **gates the tag on live verification**
that the iteration counter advances past 1.

2 commits + tag atop v1.5.0 (a7b2ffc):

| Commit | Phase | Title |
|---|---|---|
| `8152969` | docs | docs(upstream): v1.6 path A + B artifacts — upstream issue body draft + sparkshell deferred |
| `a06e3b8` | feat | feat(mode): v1.6 outer-loop for ralph iteration advance (zero Stop-hook dependency) |
| (this) | Z | chore(release): v1.6.0 |

Tag gate result (see `docs/smoke/v1.6-outer-loop-smoke.md`): live smoke
on Copilot 1.0.53-2 Windows with 3-story PRD + `--max-iterations 2`
produced final `ralph-state.json` with **`iteration: 2`** — the first
time live since v1.3 that the counter is observably > 1.

### Approach decided this session (all-paths)

After v1.5 cut, user requested 3 parallel paths (Path A: file upstream
issue; Path B: sparkshell .exe wrapper; Path C: mode.ts outer-loop):
- **Path A**: blocked at EMU auth layer; issue body draft ready in
  docs/upstream-reports/copilot-pwsh-dispatch-issue-body.md
- **Path B**: deferred to vN+1+ (no sparkshell crate, no Rust toolchain,
  hypothesis unverifiable since bench can't reproduce live failure)
- **Path C**: implemented + live-verified — this is what makes v1.6
  the real fix

### team+critic per fix (same standard as v1.1-v1.5)

- Architect APPROVE-WITH-FINDINGS on the WIP outer-loop. Found:
  - C1: existing crash-recovery test 2 fails (expected single-spawn
    semantics, broke under multi-iteration default)
  - M3: clearModeState inside loop violated mutual-exclusion invariant
  - A1: no input validation on maxOuterIterations <= 0
- Critic REVISE on the WIP outer-loop. Same findings + recommended
  - M4: test 4 doesn't assert final state after max-exhaustion
  - M1 + M2: stall detection + continuation context missing (deferred
    to v1.7)
- All blocking findings addressed in a06e3b8 before tag.

### Architecture summary

Pre-v1.6: `omcp ralph` spawned `copilot --autopilot --yolo` ONCE; relied
on Copilot's Stop event firing into omcp's hook handler to increment
the iteration counter. Upstream Copilot Windows pwsh dispatch bug
prevented the hook from ever executing live (eval_stdin SyntaxError x36
in the v1.4 smoke). Iteration counter stuck at 1 across 3 releases.

v1.6: `mode.ts` wraps the spawn in a while-loop:
```
while (iteration ≤ maxOuter) {
  writeRalphState({iteration, outerLoopOwned: true, ...})
  spawnSyncCrossPlatform("copilot", args)
  if non-zero exit → restore preSpawn + break
  if PRD allComplete → break
  if architectApproved → break
  iteration++
}
```

The Stop hook code path is preserved for the day upstream fixes the
dispatch bug; `outerLoopOwned: true` tells `checkRalph` to defer
(return noop) so the iteration counter doesn't double-advance when
both paths are operational.

## v1.5.0 deliverables (history)

5 commits atop v1.4.0:

| Commit | Phase | Title |
|---|---|---|
| `6d4590b` | docs | docs(smoke): v1.4 iteration live smoke + v1.5 input evidence |
| `3572efa` | fix | fix(setup): write minimal runtime package.json + npm install MCP deps in plugin install dir |
| `91b36ce` | feat | feat(doctor): detect upstream Copilot Windows pwsh dispatch bug + bench evidence |
| `53ab66c` | fix | fix(doctor, setup): audit-driven follow-up — bounded log read + bench-script relocation |
| `ffff6af` | chore | chore(gitignore): ignore .omcp-smoke/ working dir |
| (this) | Z | chore(release): v1.5.0 |

The v1.4 post-cut live smoke at `C:\Users\runjiashi\Temp\omcp-v14-smoke`
surfaced two issues that v1.4's deterministic vitest suite could not
catch: MCP server load failures (`@modelcontextprotocol/sdk` MODULE_NOT_FOUND)
and the upstream Copilot Windows pwsh dispatch bug (eval_stdin
SyntaxError across all 13 hook events). v1.5 fixes the MCP issue
end-to-end and adds detection for the upstream issue. The upstream
issue cannot be worked around from omcp's side — bench reproductions
across 8 command-form variants × 7 env-variant tests + NODE_OPTIONS
permutations all PASS in isolation while the live session continues
to fail. This bench-vs-live gap points to a Copilot embedded Node
v24.16.0 SEA boundary that needs an upstream fix.

team+critic verification per fix (same standard as v1.1/v1.2/v1.3/v1.4):
- Architect + Critic independent reviews of 3572efa (setup MCP deps)
  and 91b36ce (doctor probe) — both APPROVE-WITH-RESERVATIONS,
  converging on 2 items: (I-1) probeHookDeliveryHealth was reading
  the entire log via readFileSync; (I-2) bench scripts in scripts/
  were being shipped via SOURCE_ROOTS + package.json#files.
- 53ab66c addresses both: readLogTail tails the last 512 KB via
  openSync+readSync seek; bench scripts moved to
  docs/probes/copilot-pwsh-dispatch/ (not in SOURCE_ROOTS, not in
  package.json#files).
- Pre-tag test-engineer audit on the full v1.5 changeset before the
  release commit.

Live re-smoke verification (same 2-story PRD as v1.4 smoke):
- ralph exit 0, files written, PRD passes:true, ralph-state cleared
- `omcp setup` "added 95 packages in 7s"; `@modelcontextprotocol/sdk`
  resolvable at plugin install path
- `omcp doctor` emits WARN "eval_stdin failures in process-*.log —
  upstream Copilot Windows pwsh dispatch bug" with link to
  investigation doc
- Stop hook handler still does not execute under upstream bug — but
  end-to-end ralph behavior is correct because mode.ts post-spawn
  re-read (v1.4 Fix A) handles cleanup independently of Stop hook

## v1.4.0 deliverables (history)

8 commits + operational settings.json refresh atop v1.3.0:

| Commit | Phase | Title |
|---|---|---|
| `3175be5` | A/B-fix | fix(mode): post-spawn state re-read closes housekeeping bug (Fix A + B, v1.4 RCA) |
| `2612092` | docs | docs(upstream): close Lane 3 — Copilot flag investigation refutes upstream-broken claim |
| `c0733e1` | docs | docs(handoff): archive 2026-05-24 v1.4 housekeeping RCA |
| `3451a48` | feat | feat(mode): pass --yolo for looping modes (canonical Copilot invocation per official docs) |
| `515b98f` | refactor | refactor(mode): remove dead postRunRalph branch from ralph clean-exit path |
| `e8d24d7` | fix | fix(hooks): accept Copilot snake_case Stop payload + plumb raw payload via HookContext |
| `5fac994` | fix | fix(hooks): audit-driven hook hardening — todo-continuation snake_case + extracted buildHookContextFromPayload |
| (this) | Z | chore(release): v1.4.0 |

Plus operational fix (not a commit): re-ran `omcp setup` to refresh
`~/.copilot/settings.json` from the stale `scripts/omcp-hook-dispatch.cjs`
form (left over from the L1.2 revert at `c7cbc21` that deleted the
wrapper script but did not re-run setup) to the canonical
`dist/cli/omcp.js hook fire <event> --json` form. This is the proximate
cause of the v1.3.0 L3.6 smoke's "3/3 Stop handlers exit code 1" — the
handlers were invoking a deleted file.

Three independent root causes were identified by the v1.4 RCA, all
present in v1.3.0, each fixed with deterministic vitest coverage:

1. **mode.ts pre-spawn snapshot bug** (`3175be5`) — `prdStatusSnapshot`
   captured before spawn was used post-exit to decide ralph-state
   clearing. For first-run PRDs the snapshot's `allComplete` was always
   false → `shouldClear=false` → state restored to spawn-time
   `iteration:1`. Fix: split snapshot semantics (pre-spawn for crash
   recovery only; clean exit re-reads `getPrdCompletionStatus()` post-
   spawn). Test 5 (deterministic) reproduces the bug and verifies the
   fix.

2. **Stop hook payload-shape gap** (`e8d24d7`) — Copilot 1.0.53+ emits
   Stop fields in snake_case (`session_id`, `stop_reason`,
   `transcript_path`), but omcp read only `sessionId` (camelCase) and
   `extractStopContext` read `ctx.toolArgs ?? ctx.toolResult` which
   Copilot doesn't populate for Stop. Fix: `HookContext.payload?:
   Record<string, unknown>` carries the raw stdin payload;
   `extractStopContext` reads from `ctx.payload` first. 5 deterministic
   tests cover Stop → ralph iteration-advance (end_turn → advance,
   context_limit_exceeded → bail-out, PRD-complete → clear).

3. **Stale settings.json** (operational, no commit) — `~/.copilot/
   settings.json` pointed to a deleted dispatcher script. Re-ran `omcp
   setup` to refresh all 13 hook entries to `dist/cli/omcp.js hook fire
   <event> --json`.

Plus two non-RCA cleanups:

- **`--yolo` arg** (`3451a48`) — the canonical Copilot non-interactive
  invocation per official docs is `copilot --autopilot --yolo
  --max-autopilot-continues N -p "..."`. omcp previously pushed only
  `--autopilot`. Adding `--yolo` matches docs and prevents mid-loop
  permission prompts from stalling unattended runs. Per the
  investigation doc (`copilot-yolo-flag-investigation.md`), `--yolo`
  has no hook-dispatch effect — purely a permission preset.

- **dead `postRunRalph` cleanup** (`515b98f`) — architect + critic
  independently found that `clearModeState("ralph")` wipes the file
  BEFORE the post-spawn re-read in 3175be5, making `postRunRalph`
  always null. Removed the dead references; `shouldClear` simplifies
  to two clauses.

team+critic verification applied per fix (same standard as v1.1/v1.2/v1.3),
plus an extra multi-agent release-readiness audit before tag:
- 3175be5 (post-spawn re-read): Architect APPROVE + Critic APPROVE; both
  flagged the dead `postRunRalph` branch as Important-not-blocker —
  addressed in `515b98f`.
- --yolo + dead-code + Stop-payload fix: deterministic vitest serves
  as the primary verification; architect+critic deferred where the
  change is mechanical or matches an already verified design.
- Pre-tag audit (5fac994 driver): Architect + Critic + Test-engineer
  in independent contexts each audited the full src/hooks/** for
  v1.4.0 release readiness. All three converged on (a) todo-continuation
  bug + (b) untestable runFireCli ctx-building. Both addressed in
  5fac994 with 5 + 16 new deterministic tests. 1133 total tests
  passing.
- All commits use omc-style trailers (Constraint / Rejected /
  Confidence / Scope-risk).

## v1.3.0 deliverables (history)

5 commits + 1 inline Critic-fix + 1 release commit + 1 smoke doc atop v1.2.0:

| Commit | Phase | Title |
|---|---|---|
| `2f6eff6` | HUD | feat(hud): wire columns 3-5 from ralph/mode/team state files |
| `8aef816` | L2.7-ack-skill | feat(team): propagate OMCP_TEAM_* env to workers + skill-side ack protocol |
| `dc0486e` | L2.5b-ext | feat(team): fixing-phase incoming edge via shard-merge conflict detection |
| `a028753` | hygiene | fix(team-collect): catch mergeShards errors + wire --team-name CLI option |
| `docs/smoke/L3.6-long-run-ralph-smoke.md` | L3.6 | smoke artifact (orchestration PASS / housekeeping PARTIAL) |
| (this) | Z | chore(release): v1.3.0 |

team+critic verification applied per phase (same standard as v1.1, v1.2):
- Architect APPROVE all 3 Wave A commits (2f6eff6, 8aef816, dc0486e)
- Critic APPROVE all 3 with 1 MINOR + 1 architectural concern (mergeShards exception
  + CLI verb missing `--team-name`) — addressed inline in `a028753`.
- No Architect-Critic disagreement → no tie-breaker needed.
- L3.6 smoke conducted post-Wave-A as release-verify.

## Forward plan: v1.7 → v2.0

The canonical forward plan lives in
**[docs/architecture/v1.7-to-v2.0-roadmap.md](docs/architecture/v1.7-to-v2.0-roadmap.md)**.

That doc consolidates:
- Per-version scope (v1.7, v1.8, v1.9, v2.0)
- Tag gates per version (live-evidence-based, no version bumping for
  upstream-blocked items)
- Operating principles user codified 2026-05-25
  (no kicking-the-can; multi-direction team for stuck problems;
  deterministic vitest primary, smoke as cross-check)
- Decisions locked 2026-05-25:
  - Cross-platform deferred to post-v2.0 (v2.0 = Windows-first)
  - sparkshell .exe wrapper builds in v1.9 regardless of upstream fix
    status (两条腿走路)
  - Upstream pwsh dispatch issue filing handled by user, not omcp
    track

HANDOFF and CHANGELOG remain retrospective (per-version deliverable
snapshots); the roadmap is the only doc to update when planning
the next milestone.

Per-version sections below (`## vN.0 deliverables (history)`) stay
as point-in-time records of what each release shipped.

---

## v1.2.0 deliverables (this session)

4 commits + 1 hygiene patch atop v1.1.0:

| Commit | Phase | Title |
|---|---|---|
| `113df30` | L1.3 | feat(compaction): Stop-side advise delivery — upstream-bug workaround |
| `c50ccf7` | L2.7-ack | feat(team): omcp team-ack CLI verb for worker-side shutdown protocol |
| `fb67cf2` | L2.5b | feat(team): phase-transition controller with crash-restart detection |
| `eaddb4c` | hygiene | fix(team): defense-in-depth assertSafeSlug + integer guard in runTeamAck (Critic iter-1) |
| (this)   | Z | chore(release): v1.2.0 |

Plus `docs/upstream-reports/copilot-cli-hook-eval-stdin.md` (new) — drafted GitHub issue body for upstream Copilot CLI hook-dispatch bug (no commit, user files the actual issue).

team+critic verification was applied per phase per "执行标准跟之前一样" directive:
- Architect APPROVE all 3 (113df30, c50ccf7, fb67cf2)
- Critic APPROVE all 3 with 1 MINOR finding on c50ccf7 (defense-in-depth gap in runTeamAck) — fixed in `eaddb4c` before release.
- No disagreement → no tie-breaker needed.

---

## v1.1.0 deliverables (this session)

orchestrator-complete: L1 hook-dispatch fix + L2 multi-agent layer (ralph, ralplan, team, verify-phase) + L3 long-running resilience. 20 phases across the plan; 14 commits this session atop v1.0.0.

| Commit | Phase | Title |
|---|---|---|
| `bcb5065` | L1.0+L1.1 | fix(hooks): omc-style absolute-node form for all hook commands |
| `51c501b` + `76cf826` | L2.2 | feat(cli): omcp verify-phase --timeout option (+ ITERATE fix) |
| `2fb9307` | L2.5a | feat(team): TeamPhase stage state schema on TeamState |
| `a53205d` | L2.6 | fix(team): atomicWriteFileSync on worker pidfile |
| `c6d39c3` | L2.7 | feat(team): shutdown_request / shutdown_response protocol |
| `e8a950a` | L2.8 | feat(team): stuck-worker watchdog with reassign marker |
| `7389594` + `252c66a` | L3.1 | feat(ralph-state): rolling-tail cap on progress.txt (+ defensive-read fix) |
| `ed990c4` | L3.2 | feat(compaction): per-N-iter re-arm + prompt-history-aware token estimate |
| `25dce51` | L3.5 | feat(hooks): per-event hook timeout — 30s for Stop/PreCompact |
| `ccba99b` | L3.3 | fix(mode): conditional clearRalphState — preserve on incomplete/non-zero exit |
| `26e7dbd` | L3.4 | feat(ralph): stale mode-state auto-detect + --resume flag |
| `7c1fb2e` | hygiene | test(regression): align pre-existing tests with Wave A/C contract updates |
| (this) | Z | chore(release): v1.1.0 — orchestrate-complete (L1+L2+L3) |

Deep-dive plan + trace at:
- `docs/plans/complete-omcp-orchestrate-ralplan.md` (Architect+Critic APPROVE)
- `docs/specs/complete-omcp-orchestrate-spec.md`
- `docs/specs/complete-omcp-orchestrate-trace.md`
- `docs/probes/L1-hook-dispatch-format.md`

## Live smoke status (release-verify pending)

The 4 live Copilot smokes from the plan's Phase Z gate table are **deferred to a separate release-verify session**, NOT to v1.2.0 — they're 1.1.0-rc validation work, not new feature work. Each smoke is environment-dependent (Copilot CLI auth, network, rate limits) and runs 5-30min of wall clock.

| Smoke | Gate | Code coverage | Live status |
|---|---|---|---|
| L1.2 hook re-smoke | HARD | ✓ unit | **PARTIAL** — 42→27 errors; orchestration loop completes; residual 27 traces to opaque Copilot pwsh dispatch (v1.2.0 RCA) |
| L2.3 ralplan handoff | HARD | ✓ 4 integration tests | **DEFERRED** — needs live run with --handoff against real Copilot |
| L2.4 verify-phase | SOFT | ✓ 25 DI-mock tests | **DEFERRED** — needs known submission + real architect/critic spawn |
| L2.9 team multi-agent | SOFT | ✓ per-worker tests | **DEFERRED** — needs 4-worker concurrent run + merge |
| L3.6 30-iter ralph | SOFT | ✓ unit + integration | **DEFERRED** — synthetic 30-story PRD, ~30min live ralph |

## Post-v1.1.0 investigation (this session, after tag)

After tagging v1.1.0 (`8338dae`), 3 commits landed during follow-up investigation:

| Commit | What | Verdict |
|---|---|---|
| `54ba0a5` | L1.2 wrapper-script fix attempt (`scripts/omcp-hook-dispatch.cjs` + single-arg `node "<abs>/dispatcher.cjs" <event>` hook command form) | Architect+Critic APPROVE'd implementation. Live smoke produced same 27 errors. |
| `6fbb48b` | **REVERT** of L1.2 wrapper attempt | No measurable benefit per live smoke; reverted per YAGNI. |
| `bb229cd` | Hermetic test isolation in `preemptive-compaction.test.ts` (clears `.omcp/state/ralph-state.json` + `progress.txt` in beforeEach) | Caught a flake L3.2 introduced; alignment commit `7c1fb2e` missed it because it only surfaces after live ralph state pollutes cwd. |

### Live smoke results post-v1.1.0

| Smoke | Result |
|---|---|
| **L2.3 ralplan→ralph handoff** | **PASS** ✓ — pre-populated boulder + ran `omcp ralph` "if there's an active boulder plan, execute it" → ralph picked up the plan, wrote `.omcp-smoke/handoff-result.txt` with exact expected content, exit 0 |
| **L1.2 deep re-smoke (wrapper-script form)** | PARTIAL — 27 PostToolUse errors persisted (same as L1.1). Confirmed upstream Copilot CLI bug regardless of command-form. Tested against Copilot 1.0.53-1, same behavior. |

### Definitive L1 upstream-bug RCA

**Root cause confirmed**: Copilot CLI on Windows (1.0.52-4 + 1.0.53-1 tested) dispatches hooks via `pwsh.exe -nop -nol -c "<command>"` with JSON piped to pwsh stdin. For some events (PostToolUse + UserPromptSubmit + SessionStart most reliably), the dispatch chain invokes `node` WITHOUT the script-file argument. Node 24's TypeScript-strip-mode then treats stdin as TS source code and SyntaxError-exits.

Tried 3 command forms in settings.json, all produce the SAME error pattern:
- bare `omcp hook fire <event> --json` (v1.0.0)
- absolute-node `node "<abs>" hook fire <event> --json` (v1.1.0 L1.1 — best so far at 42→27 errors)
- wrapper `node "<abs>/dispatcher.cjs" <event>` (L1.2 attempted, reverted — 27 errors)

This is exactly the class of upstream bug omc documented (`$CLAUDE_PLUGIN_ROOT` not expanding under pwsh). omcp cannot fix from its side; **needs upstream Copilot CLI fix OR a fundamentally different dispatch path**.

---

## v1.2.0 follow-ups (carry forward, prioritized)

### Tier 1 — high user-facing value

1. **L1.3 — Stop-side compaction-advice delivery (upstream-bug workaround)**.
   The `preemptive-compaction` hook currently subscribes to PostToolUse + PreCompact. PostToolUse delivery is broken by the upstream bug (the L1.2 RCA), so the 85%-context advisory + `/compact` recommendation never reaches Copilot. **Stop hook works perfectly** (smoke 0 failures). Move the threshold-check + advise emission to ALSO fire on the Stop event (per-turn granularity instead of per-tool). Combined with L3.2's `estimatePromptHistoryTokens` (reads ralph-state.json + progress.txt independently of hook delivery), this completely routes around the upstream bug for compaction.
   - Why high-value: directly restores omcp's long-running stability (30+ iter ralph workflows). Without this, sessions risk hitting hard context limits and either truncating silently or stalling.
   - Estimated cost: 1-2 hours. Edit `preemptive-compaction/index.ts` to add Stop to its subscriptions, move threshold-check into Stop branch, update tests, run smoke.
   - Acceptance: `omcp ralph` with 30+ iter PRD shows advise text injected at correct iteration; user sees auto-`/compact` in Copilot.

2. **L1 upstream bug report** — file an issue against Copilot CLI repo with the eval_stdin stack trace + the 3 command-form reproductions. Worth doing even if no immediate response — establishes paper trail.

### Tier 2 — feature completion from v1.1 plan

3. **L2.5b — team phase controller** (omc-style). v1.1.0 has `current_phase` + `stage_history` schema (L2.5a) but no transition logic. Add the orchestrator that drives plan → exec → verify → fix transitions with crash-restart resume. Deferred per Critic iter-1 of the v1.1 plan.

4. **L2.4 prompt-template fix if needed** — IF live verify-phase smoke (deferred) shows Copilot wraps verdict in reasoning block, switch `detectVerdict` from line-only to sentinel-tag (`<verdict>APPROVE</verdict>`).

5. **Worker-side shutdown ack writer** — L2.7 implements orchestrator-side request + wait + SIGTERM-fallback. Worker-side ack write (in Copilot skill prompts) is still pending. Belongs in `skills/ralph/SKILL.md` (or similar) instructions.

### Tier 3 — release-verify smokes (deferred from v1.1)

6. **L2.4 live verify-phase smoke** — run against real Copilot sub-processes with a known submission, capture raw stdout, validate detectVerdict matches.

7. **L2.9 live team multi-agent smoke** — 4-worker concurrent PRD, verify shard-merge reconciles, all stories complete.

8. **L3.6 live 30-iteration ralph smoke** — synthetic PRD, verify progress.txt cap activates, compaction re-arm fires, crash recovery doesn't mis-fire. Most directly affected by L1.3 if/when that's implemented.

### Tier 4 — infrastructure

9. **`npm pack && npm install -g <.tgz>` CI gate** — closes the npm-link-vs-real-install fidelity gap surfaced in v1.0.0's Architect iter-2.

10. **Daemon mode (Option O-B)** + **modifiedArgs surgeon (Phase 7)** — original orchestrator-v1 deferrals; gated on real-user demand.

---

## TL;DR — what landed in v1.0.0

orchestrator-v1 is no longer just "code-complete"; it is **runtime-verified
end-to-end** against a real Copilot CLI session. The proof artifact is at
`docs/smoke/orchestrator-v1-real-copilot-smoke.md`.

This session executed the consensus-approved Phase A → Z plan at
`docs/plans/v1.0.0-runtime-verify-ralplan.md` (commit `695d3e3`,
Architect+Critic both APPROVE). Phase A's smoke run surfaced two
Windows-specific bootstrap bugs that were TDD-fixed before the loop
could complete; Phases B/C/E1/E2 closed the deferred pre-mortems and
small tails the orchestrator-v1 plan had carried over. Phase Z bumped
all 4 version manifests, prepended CHANGELOG.md, and cut v1.0.0.

### Commits this session

| Phase | Status | Commit | Title |
|---|---|---|---|
| Consensus | ✓ | `695d3e3` | docs(plan): v1.0.0 runtime-verify ralplan — consensus-approved |
| A.0 (bootstrap bug) | ✓ | `5ab4f90` | fix(cli): isDirectInvocation tolerates npm-link symlinks |
| A.1 (bootstrap bug) | ✓ | `7eb1f14` | fix(spawn): cross-platform copilot spawn handles Windows .cmd shims |
| A (smoke) | ✓ | `2c50b40` | docs(smoke): orchestrator-v1 real Copilot ralph-loop PASS |
| B (pre-mortem #1) | ✓ | `1955233` | feat(setup): emit absolute-path hook command when omcp not on PATH |
| C (verify-phase) | ✓ | `8b7850b` | feat(cli): omcp verify-phase &lt;phase-id&gt; — automate team+critic protocol |
| E1 (4-manifest test) | ✓ | `71f2069` | test(invariants): cli-wiring-invariants checks all 4 manifests |
| E2 (escapeRegExp retrofit) | ✓ | `58321da` | fix(session): escapeRegExp on query input + invariants.md doc accuracy |
| Z (release) | ✓ | (this commit) | chore(release): v1.0.0 — orchestrator-v1 verified end-to-end |

### Verified at v1.0.0

- `npm link` makes `omcp --version` print `1.0.0` from a fresh shell
- `omcp setup` writes 13 hook events into `~/.copilot/settings.json` with `__omcp:true` markers
- `omcp ralph --prd .omcp/prd.json "..."` drives a real Copilot session: PRD stories transition `passes:false → passes:true`, allComplete short-circuits the loop, ralph-state cleared on exit
- 4 version-carrier manifests in lockstep (CI enforced via `cli-wiring-invariants.test.ts`)
- `omcp verify-phase --help` shows the new team+critic protocol verb; legacy `omcp verify` mode-launcher still works (no collision)
- `omcp` PATH fallback emits `node "<absolute-path>"` form when not on PATH (pre-mortem #1 closed)
- `omcp session <query>` uses `escapeRegExp` on user input (invariant 6 compliance)

### What is NOT verified at v1.0.0 — follow-ups for v1.1

1. **PostToolUse hook executor noise** — Phase A smoke logged 64
   `Hook command failed with code 1` entries from Copilot's hook
   executor. The orchestration loop completed in spite of them
   (PRD lifecycle, allComplete, exit 0 all worked), but the
   underlying hook-fire path needs RCA. Flagged in the smoke
   artifact's Follow-ups section.
2. **Real team-shard merge smoke** — orchestrator-v1 plan Phase 3.T3
   shipped the merge code + 10 unit tests, but a live `omcp team`
   smoke against concurrent workers writing shard state has not
   been driven. Should be on v1.1 path.
3. **Daemon mode (Option O-B of orchestrator-v1)** — explicitly
   deferred to v1.1+; only build if users demand it.
4. **modifiedArgs surgeon mode (Phase 7)** — was gated on TUI smoke
   PASS — now we have that gate; can be picked up in v1.1.
5. **OMC upstream `$CLAUDE_PLUGIN_ROOT` patch** — separate repo,
   separate session.
6. **`omcp verify-phase` real end-to-end test** — Phase C tests use
   DI mock spawn; a live exercise against actual architect/critic
   sub-Copilot processes is a v1.1 hardening.
7. **`npm pack && npm install -g <.tgz>` CI gate** — closes the
   npm-link-vs-real-install fidelity gap flagged by Architect
   iter-2 of the v1.0.0 ralplan.

---

## What was shipped this session (28 commits between `e014e35` and `3d2ed79`)

| Phase | Status | Final commits |
|---|---|---|
| v0.12.0 Branch B — escapeRegExp + 4 `omcp state` sub-actions | ✓ | `cfb8d96` → `a5af910` |
| **Retraction** — v0.12.0 wrongly blamed Copilot; real cause documented | ✓ | `3e3058a` |
| Consensus plan — orchestrator-v1 (4 planner + 2 architect + 2 critic iters) | ✓ | `b66792f` |
| **Phase 1** — hook target file `config.json` → `settings.json`; `applyOmcpRuntimeWiring` split; doctor migration | ✓ | `c1d205f` |
| **Phase 1.5** — Hook-crash root-cause closure (3 parallel investigation tracks) | ✓ | `ac55a47` |
| **Phase 2** — N+2 hook ports (persistent-mode, todo-continuation, omc-orchestrator); v0.13.0 release | ✓ | `2dcf27d`, `10dd450`, `3ee9d3e` |
| **Phase 3** — ralph state-machine wiring; ralplan→boulder; team shard-merge; invariants.md | ✓ | `2feb588`, `4a4b7bb`, `f8521bc`, `9c6fccb`, `05df369` |
| **Phase 4** — critic-verify loop (detectArchitectApproval + incrementRalphIteration + allComplete noop exit + e2e test) | ✓ | `b026438`, `e612847`, `4924fb8`, `fca6546` |
| **Phase 5** — team+critic verification protocol doc + 14 guard tests | ✓ | `1a4dc3a` |
| Final HANDOFF closure | ✓ | `3d2ed79` |

For the complete prior-state narrative (v0.11.0 baseline, v3 hooks-parity plan, Phase 1 smoke verdict, Hook Architecture re-verdict, Phase 2 deferred-hooks scope), see [`docs/handoff-archive/2026-05-23-orchestrator-v1.md`](docs/handoff-archive/2026-05-23-orchestrator-v1.md).

---

## What the next session MUST verify (the open work)

These items are NOT done. They are the difference between "code-complete orchestrator" (where we are) and "verified-working orchestrator" (where we want to be):

1. **Real Copilot runtime smoke for the ralph loop.**
   - Pre-condition: ensure `omcp` is on PATH (or `omcp setup` was run so `~/.copilot/settings.json` has absolute-path hook commands wired)
   - Action: in a fresh shell, run `omcp ralph --prd .omcp/prd.json "tiny task"` against a hand-crafted 2-story PRD
   - Expected: ralph-state written → Copilot session starts → tool use → Stop event → persistent-mode hook fires → advise injected → next iteration → ... → PRD allComplete → ralph-state cleared → exit
   - Verify by: tailing `~/.copilot/logs/process-*.log` for 0 hook errors, inspecting `.omcp/state/ralph-state.json` mid-run, confirming clean exit
   - **The Phase 4 e2e test uses mock spawnSync — it proves the LOGIC, not the Copilot integration. This smoke is the missing piece.**

2. **Resolve OMC plugin hook interference.**
   - OMC's `installed-plugins/omc/oh-my-claudecode/hooks/hooks.json` line 8 still uses Bash-style `$CLAUDE_PLUGIN_ROOT`
   - This crashes every Copilot hook fire and pollutes the process log
   - omcp itself is clean (uses `omcp hook fire <event> --json` — shell-safe), but OMC's crashes will appear alongside omcp's clean fires
   - Options: (a) disable OMC plugin during smoke (`enabledPlugins[oh-my-claudecode@omc] = false`); (b) file an upstream PR fixing OMC's hooks.json; (c) accept OMC noise in the log and only check omcp's specific hook output
   - Recommended: (a) for the smoke run, (b) as a separate upstream contribution later

3. **`omcp` on PATH pre-mortem validation.**
   - orchestrator-v1 pre-mortem #1 says if `omcp` is not on PATH, hook command `omcp hook fire <event> --json` fails with exit 127 → Node falls back to stdin → same SyntaxError pattern
   - Mitigation idea in plan: emit absolute path to `dist/cli/omcp.js` as fallback in setup.ts
   - **Not implemented yet.** Test scenario: temporarily remove `omcp` from PATH, run `omcp setup`, verify hook command was emitted with absolute path

4. **Implement `omcp verify <phase-id>` CLI verb (Phase 4 placeholder).**
   - Phase 5 doc `docs/workflows/team-critic-verification.md` documents this verb as a placeholder
   - Not built. The verification protocol is currently driven manually (orchestrator dispatches architect + critic via Agent tool)
   - Building this would let `omcp verify <phase-id>` spawn architect + critic subprocesses in fresh contexts and return exit code based on consensus

5. **Real team-shard-merge smoke.**
   - `omcp team` still uses the original detached spawner; the shard-write happens via `writeShardState` from `src/lib/team-shard-state.ts` but workers don't yet auto-write shards
   - Verify by: write a tiny PRD with 4 stories, hand-spawn 4 worker processes (or simulate by direct writeShardState calls), run `omcp team-merge-shards <team-name>`, inspect `.omcp/state/team-shards/merge-report.json`

### Smaller follow-ups (lower priority)

- `src/__tests__/cli-wiring-invariants.test.ts:155` checks only 3 of 4 manifests — Critic iter-2 finding, never fixed
- `src/cli/commands/session.ts:32` has bare `new RegExp(query)` without `escapeRegExp` — Critic iter-2 minor
- Daemon mode (Option B of orchestrator-v1) — deferred to v1.1+; only build if users demand it
- omx parity gap — separate `/goal`, not in scope of orchestrator-v1

---

## How to write the next-session prompt

A copy-paste prompt for the next session is at:
**[`docs/prompts/next-session-verify-orchestrator.md`](docs/prompts/next-session-verify-orchestrator.md)**

It contains the verbatim text to paste into a fresh Copilot/Claude session, plus context about why each verification matters.

---

## Critical invariants (carry forward — also at docs/architecture/invariants.md)

1. **`assertSafeSlug`** for path inputs (`src/runtime/safe-slug.ts`)
2. **`atomicWriteFileSync`** for state JSON writes — no bare `writeFileSync` for state JSON (carve-outs documented for `team.ts:99` pidfile + `hermes-bridge.ts:223` log init)
3. **4 manifests sync on version bump** + `CHANGELOG.md` (`package.json` + `.agents/plugins/marketplace.json` + `.claude-plugin/plugin.json` + `plugins/oh-my-copilot/.claude-plugin/plugin.json`)
4. **Hook event names** in `COPILOT_VALID_EVENTS` (`src/runtime/copilot-config.ts`)
5. **`subagentStart`** is camelCase only
6. **`escapeRegExp`** before `new RegExp(userInput)` (`src/runtime/escape-regexp.ts`)
7. **No OAuth/API tokens** in tracked files (incident `a90e831`, redacted `029f6ae`)
8. **New CLI commands registered** in `src/cli/omcp.ts`
9. **Detached children** must write pidfile + have a `stop` verb

---

## Working environment quick-ref

- **Build**: `npm run build` (tsc only; clean before this session)
- **Tests**: `npx vitest run` — 916 passing, 2 skipped, 0 failed, 1 file-level worker-fork EPERM baseline (unchanged since v0.4.0)
- **CHANGELOG**: prepend to `CHANGELOG.md` (Keep-a-Changelog format)
- **Commit trailers**: project uses omc-style (Constraint/Rejected/Confidence/Scope-risk/Directive/Not-tested)
- **omc reference (read-only)**: `C:\Users\runjiashi\.claude\plugins\cache\omc\oh-my-claudecode\4.9.3\`
- **omx reference (read-only)**: `C:\Users\runjiashi\_refs\oh-my-codex\`
- **Copilot CLI binary**: `C:\.tools\.npm-global\copilot.cmd` (currently v1.0.52-4 — still has the `$CLAUDE_PLUGIN_ROOT` upstream bug in OMC's hooks.json, NOT in omcp's hook command)
- **Copilot CLI bundle (for grep)**: `/c/.tools/.npm-global/node_modules/@github/copilot/app.js` (hook executor `Xer` at line 1193, spawns `pwsh.exe -nop -nol -c <cmd>` + JSON to stdin)

---

## User emphasis (carry forward)

> "着重要点 ralph ralplan 以及 team 这些可以长时间运行并且多角色 agent，用于防止 llm 自视甚高以及幻觉，还有可以 long running"
>
> "针对核心功能的缺乏，补齐，采用 team 和 critic 模式"
>
> "完成所有原定计划"

orchestrator-v1's structural shape now satisfies all three. Runtime verification is the last open question.
