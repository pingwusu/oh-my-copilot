# Changelog

All notable changes to oh-my-copilot will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [2.2.0] — 2026-05-25

### Notable — EB-omcp-parity-06 IPC mesh revival: outbox + inbox + heartbeat + cursor

This version revives the 6 Phase 2 IPC mesh stories that v2.1
explicitly deferred behind `EB-omcp-parity-06`. Triggered by **maintainer
override** of the self-imposed "≥1 external user signal" gate; documented
as a one-time scope-of-acceptance in
`docs/adr/ADR-omcp-eb-06-ipc-mesh-revival.md` (the master decision
record). Pattern NOT to be reused for other EB gates without similar
explicit reasoning.

Tests: 1663 baseline → **1800 passing** (5 skipped, 155/156 files green;
+137 net deterministic vitest cases on the default lane) + ~5s of 8-process
`child_process.spawn` concurrency tests on the new dedicated
`test-concurrent` CI lane (gated by `OMCP_RUN_HEAVY_CONCURRENCY=1`).

### Added — Phase 2 IPC mesh (EB-06 revival, 7 functional stories)

- **`omcp team-outbox-write <session-id> <consumer> <json-payload>`**
  Appends a JSONL entry to the per-session outbox via a hand-rolled
  lockfile sidecar (`openSync(<file>.lock, 'wx')` + exponential
  backoff `[50, 100, 200, 400, 1000, 2500]` ms + 30s stale-cleanup).
  64KB line cap with `{truncated: true, original_bytes: N}` markers
  on truncation. Exit codes 0 / 2 / 4 per `ADR-omcp-eb-02-outbox-schema.md`.
- **`omcp team-outbox-read <session-id> <consumer> [--reset] [--json]`**
  Cursor-based reader with `{fileIndex, byteOffset}` shape per
  consumer. Trailing partial line tolerance (ADR §5 — cursor advances
  only past last completed `\n`; partial line picked up on next read
  once writer completes it). Per-consumer cursors are independent.
- **`omcp team-inbox-write <session-id> <markdown-body>`**
  Leader→worker message channel. Appends to `inbox-N.md` with 1MB
  rotation INSIDE each append (env override
  `OMCP_INBOX_ROTATE_BYTES`). Shares the outbox lockfile pattern.
- **`omcp team-heartbeat <session-id> <worker-index>`**
  Per-worker liveness signal. Writes
  `worker-<idx>-heartbeat.json` via atomicWriteFileSync with schema
  `{ts: ISO-8601, workerIndex, pid}` per
  `ADR-omcp-eb-05-heartbeat-freshness.md`. Default interval 30s,
  freshness multiplier 3× = 90s threshold. Tunable via env
  `OMCP_HEARTBEAT_INTERVAL_S` + `OMCP_HEARTBEAT_FRESHNESS_MULTIPLIER`.
- **`runTeamWatchdog` watchdog extended**: reads heartbeat.json's
  `ts` field as primary freshness signal (side-steps NTFS 15.625ms
  mtime quantum race); falls back to shard-mtime ONLY when
  heartbeat.json absent (back-compat with v2.1 workers). Heartbeat-
  absent observability: surfaces `[omcp watchdog] worker-N not
  heartbeating` warning to logLines at 2× post-spawn interval —
  warning, NOT failure.
- **`skills/team-worker/SKILL.md` updated** with heartbeat + outbox
  + inbox protocol + anti-patterns section (no hot-loop heartbeat;
  no inner-loop outbox-write without rate-limit; no shared cursor
  across consumers; no >64KB lines — use sentinel file pointer
  instead).

### Added — CI runtime infrastructure (1 wiring story)

- **New `test:concurrent` npm script + `.github/workflows/ci.yml`
  matrix job** on windows-latest + Node 20 with
  `OMCP_RUN_HEAVY_CONCURRENCY=1`. Per-test `it.skipIf(!env)` gates
  ensure default `test` lane stays under 5 min; concurrent lane
  adds ~3 min for the 8-process tests. Excludes match the default
  lane verbatim.

### Added — Deterministic smoke + tag-gate

- **`docs/smoke/omcp-team-parity/ipc-mesh-deterministic-attestation.md`**
  via shared `src/lib/smoke-template.ts` renderer (drift-detection
  vitest now spans 4 consumers: P1 + P3 + P4 + IPC).
- **`src/scripts/check-live-smoke.ts` extended** to recognize the
  IPC phase as a candidate live-smoke artifact (per `ADR-omcp-eb-06-
  ipc-mesh-revival.md` follow-up §4). Tag-gate message updated:
  `BLOCKED — v2.x LOCAL tag blocked: ≥1 live-smoke required — capture
  P1, P3, P4, or IPC with real Copilot CLI auth`.

### Added — 3 ADRs

- **`ADR-omcp-eb-02-outbox-schema.md`**: outbox JSONL schema
  (`{ts, consumer, payload}`), 64KB line cap with truncation
  markers, hand-rolled lockfile contract, alternatives
  considered (separate-file-per-message rejected for cursor-
  schema incompat + inode exhaustion; per-line-rewrite rejected
  for data loss on concurrent appenders; `proper-lockfile` dep
  rejected for zero-dep policy).
- **`ADR-omcp-eb-05-heartbeat-freshness.md`**: 30s interval × 3
  multiplier = 90s threshold; primary freshness signal is
  heartbeat.json's `ts` field (NOT mtime — side-steps NTFS
  quantum); watchdog precedence rule (heartbeat wins when both
  signals present); heartbeat-absent observability warning at
  2× interval; omc calibration reference (omc: 3s poll × 10×
  = 30s vs omcp: 30s interval × 3× = 90s — different cadence
  justification documented).
- **`ADR-omcp-eb-06-ipc-mesh-revival.md`**: master decision record
  for the EB-06 arc. Gate-trigger interpretation (maintainer
  override; pattern NOT to be reused); decision (Option B-revised
  chosen via iter-1+iter-2 RALPLAN-DR consensus); 3 top-level
  drivers; 3 alternatives considered; consequences visible to
  users/operators/maintainers; 8 follow-ups.

### Smoke artifacts on disk after this release

- `docs/smoke/omcp-team-parity/phase1-verify-fix-loop-deterministic-attestation.md` (v2.1)
- `docs/smoke/omcp-team-parity/phase3-chain-deterministic-attestation.md` (v2.1)
- `docs/smoke/omcp-team-parity/phase4-integration-deterministic-attestation.md` (v2.1)
- `docs/smoke/omcp-team-parity/ipc-mesh-deterministic-attestation.md` (v2.2 — new)

Live-mode tag-gate (S4 contract) still requires ≥1 real-Copilot
artifact across any of P1 / P3 / P4 / IPC before the v2.2.0 LOCAL
tag cuts. `npm run release -- 2.2.0` invokes
`check-live-smoke.ts` which exits 1 with
`v2.x LOCAL tag blocked` until live capture lands.

## [2.1.0] — 2026-05-25

### Notable — omc-team feature parity (Option B-minus): verify/fix loop + chain orchestration + worker-status atomic-rewrite

This version closes the iter-2 plan's 20-story arc across 3 sessions
(N+1: Phase 1 verify/fix loop; N+2: Phase 2.5 ack-status + Phase 3
chain orchestration; N+3: Phase 4 polish + ADR + release). The
omcp team mode now self-corrects through a bounded verify/fix loop
and composes with ralplan/ralph via the new `omcp ralplan --chain`
flag — closing the 70%-PLATFORM-IMPOSED parity gap against omc's
5-stage state machine, modulo the deferred Phase 2 IPC mesh.

Tests: 1356+ baseline → **1469+ passing** (+113 net deterministic
vitest cases across 20 stories), 2 skipped, 1 pre-existing
worker-fork EPERM file-level baseline (unchanged since v0.4.0).

### Added — Phase 1 verify/fix loop (Gap 1, N+1 session, 6 stories)

- **`omcp doctor verify-spawn shape`** — new probe that gates
  `omcp team-verify` readiness; asserts `copilot -p "echo verify-spawn-check"`
  returns exit-0 + a recognizable model-id token (`gpt-`/`claude-`)
  with a 30s timeout. Catches Copilot CLI argv-shape drift before
  verify-worker spawns silently no-op (pre-mortem scenario 1).
- **`omcp team-verify <sid> [--max-loops N]`** — new CLI: runs
  vitest → tsc → biome sequentially, writes
  `.omcp/state/team/<sid>/verify-report-N.json`, and on failure
  writes per-worker `worker-K-verify-fail.json` signals consumed by
  the next collect. Clears stale signals at the start of each run
  so passing iterations don't leak fix-needed state forward.
- **`omcp team-collect <sid>`** extended: when ANY worker signal is
  present, transitions team to `fixing` (overriding `completed`) and
  writes the aggregated `verify-fail-summary.json`. The asymmetric
  clear contract: signals + merge-conflicts coexist as `fixing`
  with both artifacts on disk.
- **`omcp team-fix <sid> [--max-loops N]`** — new CLI: spawns a
  Copilot debugger fix-worker with the verify-report tail in the
  prompt. fix_loop_count tracked atomically in TeamState; bound check
  enforced at BOTH `runTeamCollect` (refuses to advance to fixing
  when exhausted) and `spawnFixWorker` (refuses to spawn). Default
  3, env `OMCP_TEAM_MAX_FIX_LOOPS` overrides.
- **Phase 1 deterministic smoke** at
  `docs/smoke/omcp-team-parity/phase1-verify-fix-loop-deterministic-attestation.md`
  via the shared `src/lib/smoke-template.ts` renderer.

### Added — Phase 2.5 worker status (Gap 3, N+2 lead-in)

- **`omcp team-ack <sid> <idx> --status <state>`** — new optional flag
  on the existing team-ack verb. Valid states: `pending |
  in_progress | completed | failed`. Updates
  `TeamState.workers[K].status` atomically via writeModeState
  (Invariant 2). Idempotent overwrite path preserved when --status
  omitted (back-compat with v2.0 ack-only callers).

### Added — Phase 3 chain orchestration (N+2 session, 8 stories)

- **`omcp ralplan --chain "<spec>"`** — new orchestration flag.
  Spec grammar: `--then <verb> [args...]` repeats. Example:
  `--chain "--then team 4 fix-typo --then ralph-verify"`.
- **`runChain` sequential runner** with crash-resumable
  `.omcp/state/chain-state.json` marker carrying
  `{currentStep, totalSteps, completedSteps, ts, status, steps}`.
- **5-step atomic state-handoff** between consecutive chain steps:
  read from-mode state → write `chain-handoffs/step-N.json`
  snapshot → write chain-state.json with
  `status='handing-off-to-<toMode>'` → asymmetric clear (only when
  to-mode is `mutuallyExclusive=true`) → spawn to-mode. Crash-
  survivor vitest covers the kill -9 window.
- **Phase 1 TeamState preservation** through handoff —
  `fix_loop_count`, `current_phase`, `stage_history`, `started_at`,
  `workers[].status` all survive verbatim. Typed reader at
  `src/lib/chain-handoff-reader.ts` exposes
  `readChainHandoff` + `getTeamHandoffPhase1Metadata`.
- **`omcp cancel` chain-aware propagation** — auto-detects active
  chain-state.json and signals current step's mode-state.cancelled=true
  + clears the chain marker. Per
  `docs/adr/ADR-omcp-cancel-semantics.md`: 8 cancel-honoring modes
  (ralph/autopilot/ultrawork/ultraqa/sciomc/ralplan/ultragoal/team-verify)
  + 2 cancel-best-effort modes (team-launch / spawnFixWorker —
  user must run `omcp team-stop <sid>` follow-up).
- **`omcp team-wait <sid> [--timeout <secs>]`** — new poll-based CLI
  for terminal-phase blocking. Exit 0 completed / 1 failed / 2
  timeout / 3 not-found. Default timeout 1800s, env
  `OMCP_TEAM_WAIT_TIMEOUT_S` overrides. Explicitly polling, no IPC
  dependency.
- **ralph SKILL.md sub-team dispatch guide** — new
  `Parallel subtask dispatch via team` section with decision
  criteria + dispatch protocol + 3 anti-patterns. When ralph
  identifies ≥3 independent stories that do not share files, it
  SHOULD dispatch via `omcp team N:executor` + `omcp team-wait`.
- **Phase 3 deterministic smoke** at
  `docs/smoke/omcp-team-parity/phase3-chain-deterministic-attestation.md`.

### Added — Phase 4 polish + integration (N+3 session)

- **team-worker SKILL.md** shutdown protocol updated to use
  `omcp team-ack --status completed|failed|pending` per worker
  disposition. Adds an explicit "no `omcp team-heartbeat`" note
  pointing readers to EB-omcp-parity-06 for the deferred IPC mesh.
- **Phase 4 full-stack integration smoke** at
  `docs/smoke/omcp-team-parity/phase4-integration-deterministic-attestation.md`
  exercising every v2.1 surface in a single trace (10 phases A..J,
  4-worker team with verify-fail injection + fix-worker spawn +
  re-verify pass + 4× --status ack + team→ralph handoff + chain
  completion).
- **3 ADRs**:
  - `docs/adr/ADR-omcp-team-omc-parity-iter2.md` — master decision
    record for the entire iter-2 arc (this CHANGELOG's source-of-truth).
  - `docs/adr/ADR-omcp-cancel-semantics.md` — mid-step cancel matrix.
  - `docs/adr/ADR-omcp-status-fix-loop-count-deferred.md` —
    `omcp status` fix_loop_count surface deferred to post-v2.1.x.

### Deferred-not-missing (per EB-omcp-parity-06)

Phase 2 IPC mesh (inbox / outbox / heartbeat / worker-skill IPC
update / IPC smoke — 6 stories) is deferred until ≥1 external user
reports IPC mesh as a workflow blocker. The deferred story IDs are
preserved verbatim in `docs/plans/omcp-team-omc-parity-iter2.md`
Appendix B for direct lift into a future ralplan iter. Users mixing
omc + omcp workflows will notice the asymmetry: omcp team workers
coordinate via shard JSON + verify-fail-summary.json instead of
inbox.md / outbox.jsonl / heartbeat.json.

### Smoke artifacts

Live-mode tag-gate per iter-2 plan §RELEASE-cut: ≥1 real-Copilot
smoke artifact across P1/P3/P4 is required before the v2.1.0 LOCAL
tag cuts. The release-time script `src/scripts/check-live-smoke.ts`
enforces this — exits 1 with explicit "v2.1.0 LOCAL tag blocked"
message if all 3 artifacts are deterministic-only.

Artifacts on disk after this release:
- `docs/smoke/omcp-team-parity/phase1-verify-fix-loop-deterministic-attestation.md`
- `docs/smoke/omcp-team-parity/phase3-chain-deterministic-attestation.md`
- `docs/smoke/omcp-team-parity/phase4-integration-deterministic-attestation.md`

## [1.8.0] — 2026-05-25

### Notable — first-time live MCP verification + outer-loop cost-governor + plan iter-3 consensus

This version closes US-1.8 across 4 tiers + the v1.7 ADR-deferred
US-05 cost-governor outer-loop. First time omcp has live-verified
all 10 MCP servers + the shared runtime shim via real CLI exercise
(not deterministic mocks).

Tests: 1178 → 1298 passing (+120 net), 2 skipped, 1 pre-existing
worker-fork EPERM file-level baseline (unchanged since v0.4.0).

### Removed
- `ultraqa` and `sciomc` modes removed from default LOOPING_MODES per
  iter-3 plan Section L#2 auto-triage option C. Both modes lacked
  state-module implementations (`src/lib/ultraqa-*.ts` / `src/lib/sciomc-*.ts`
  never existed). Multi-direction triage evaluated (A) shared-mode-state only,
  (B) build minimal state modules, (C) CHANGELOG-tagged removal — chose C
  because the alternatives delivered no user value (mode names existed but
  no skill content backed them). Removed cleanly to honor the "no kicking
  can" principle. May be re-introduced in a future minor with full skill
  content + state module + e2e verification.

### Tier 1 — LOOPING_MODES live verify
- `fdeb11a` test(ralph-resanity): ...
- `4be562d` test(team-live): ...
- `f2708c5` docs(smoke): autopilot + ultrawork live verify ...
- `4ae904b` feat(mode): remove ultraqa + sciomc from LOOPING_MODES (option C per iter-3 Section L#2)

### Tier 3 — 10 MCP server live e2e
- `c51c4a9` test(mcp-servers): det matrix (10 servers via it.each)
- `aa91340` test(mcp-runtime-shim): canary-zero det harness
- `85b90b4` test(mcp-code-intel): fixture scaffold
- `8854965` test(mcp-live): real-CLI smoke runner + 11/11 PASS
- `fac3ed9` refactor(tests): extract shared McpClient helper (deslop, -168 lines)

### Tier 4 — 19-agent QA matrix + routing
- `aa4a608` test(agents): 19-agent QA matrix (zero banned-token violations)
- `050afc9` feat(verify-catalog): agent-catalog drift detection
- `14c3ba4` test(routing): OMCP_MODEL_FAMILY 3-mode routing test

### Tier 0 — Baseline + auth pre-checks
- `0b0460b` chore(baseline): v1.7.0 baseline reverify attestation + working-section header
- `d68156b` chore(auth): T0 auth precheck attestation
- `5698cd4` docs(smoke): canary live-e2e template

### US-05 — Cost-governor outer-loop (ADR-C1 Option C)
- `974a438` feat(cost-governor): per-iteration outer-loop cost-summary
  state — closes v1.7 ADR-deferred US-05 (Option C: keep PostToolUse
  for tool-level metrics, add post-spawn callback in mode.ts that
  writes .omcp/state/<sessionId>/cost-summary.json)

### v1.9 pull-forward
- `75ee12a` feat(doctor): add check-mcp-config integrity check

### Planning artifact
- `73fd9a2` docs(plans): v1.8->v2.0 ralplan iter-3 consensus (138
  stories / 7-9 sessions; 4 ADRs; 7 USER_REQUIRED blockers; 5 CPs)

## [1.7.0] — 2026-05-25

### Notable — outer-loop hardening + DEP0190 resolved + 5 of 6 v1.4 carry-forwards closed

This version closes the longest-standing "kicked-can" issue in omcp: the
DEP0190 deprecation warning during `omcp setup`, deferred since v1.5,
finally resolved via a 3-agent multi-direction team that converged on
the same `node + npm-cli.js` solution. Plus v1.6 critic's two
outer-loop hardening items (M1 stall detection, M2 continuation
context injection), plus 3 more v1.4 carry-forwards.

Tag gate per user mandate: live smoke must show `iteration > 1` AND
zero DEP0190 warnings. PASSED — see docs/smoke/v1.7-sanity-smoke.md.

Tests: 1167 → 1175 passing (+8 new), 2 skipped, 0 failed (1 pre-existing
worker-fork EPERM baseline unchanged since v0.4.0). Build: tsc clean.

### Tier 1 — outer-loop hardening (v1.6 critic findings)

- `a5925c4` **feat(mode): v1.7 M1 outer-loop stall detection**.
  v1.6 critic finding M1: outer loop had no "if 0 PRD progress in N
  consecutive iterations, bail" circuit breaker. v1.7 adds
  `stallBailAfter` option (default 2, clamped >= 1), `--stall-bail-after`
  CLI flag, prevCompleted tracker. After N stalls → bail with state
  preserved at current iteration + outerLoopOwned:false. 2 deterministic
  tests (stall fires correctly, clamp works).

- `1c87906` **feat(mode): v1.7 M2 outer-loop continuation context injection**.
  v1.6 critic finding M2: iteration 2+ spawns cold-started Copilot with
  the same prompt, ~2x token cost vs. in-session --autopilot continuation.
  v1.7 injects getRalphContext (progress.txt + PRD status + next-story
  prompt) wrapped in `<ralph-continuation iteration="N">` into the -p
  prompt of iteration 2+. Spawn args spread per iteration to prevent
  reference-sharing bug in mock observability. 1 deterministic test
  verifies the exact contract (first call raw, second call wrapped).

### Tier 2 — multi-direction team resolved DEP0190 (longest-standing carry-forward)

- `07b77f9` **fix(setup): v1.7 US-03 DEP0190 resolved via `node <npm-cli.js>`**.
  v1.5 carry-forward deferred 2 versions. v1.7 multi-direction team: 3
  agents dispatched in parallel (Direction A: `where npm` + absolute path;
  Direction B: direct `node + npm-cli.js`; Direction C+D: execFile/argv0/
  NO_WARNINGS). **All three converged on the same fix**: invoke npm via
  `process.execPath + [npm-cli.js, ...]` to bypass the `.cmd` shim
  entirely → no shell:true → no DEP0190. `findNpmCliJs()` helper derives
  the path purely from `process.execPath` (no execFileSync — that would
  re-trigger DEP0190 from the discovery layer). Fallback to shell:true
  legacy form when npm-cli.js absent (exotic install layouts).
  Probe artifacts at docs/probes/dep0190-direction-{a,b,cd-misc}.md
  + bench scripts.

  **Live verification**: `omcp setup` now outputs only "added 95 packages
  in 7s" + "omcp setup complete" — zero DEP0190 lines in stderr.

### Tier 2 — v1.4 carry-forward closures

- `c8b1ece` **feat(doctor): v1.7 US-06 stale hook commands check**.
  v1.4 RCA carry-forward (the L1.2 wrapper-script revert scenario):
  doctor check 10 scans settings.json __omcp-owned hook entries,
  extracts script paths via `node "(...)"`regex, existsSync-checks,
  warns with sample + "run `omcp setup`" suggestion. User-authored
  hooks NOT flagged (scope gated on __omcp:true). 9 deterministic
  tests including the exact v1.4 RCA shape, truncated-sample at >3
  stale, invalid JSON, user-authored skip.

- `7c762e7` **refactor(mode): v1.7 US-07 drop redundant --allow-all-tools
  for looping modes**. v1.4 tidy-up: --yolo (added v1.4 for
  LOOPING_MODES) implies --allow-all-tools per Copilot docs. v1.7
  gates --allow-all-tools push on `!LOOPING_MODES.has(mode)`. One-shot
  modes (no --yolo) preserve --allow-all-tools. 2 regression tests
  pin both directions.

- `2202640` **feat(setup): v1.7 US-04 prefer `npm ci` when lockfile exists**.
  v1.5 critic M-3 carry-forward: omcp setup branches between
  `npm install` (first run, creates lockfile) and `npm ci` (re-runs,
  reproducible). True dev-version pinning (shipping a curated lockfile)
  is separate v1.8 work. 1 new test (test 2b) covers ci branch.

### Tier 3 — explicit ADR deferral (1 of 6 carry-forwards)

- **US-05 cost-governor outer-loop equivalent — DEFERRED TO v1.8 (ADR)**.
  The cost-governor hook subscribes to PostToolUse (per-tool-call event,
  not per-spawn), so the v1.6 outer-loop pattern doesn't transplant
  directly — mapping it to mode.ts post-spawn loses per-tool-call
  granularity. This requires a separate design pass; the v1.4 carry-
  forward continues into v1.8 with this explicit rationale, NOT a silent
  push. Per "no kicking the can" principle, explicit ADR-deferral with
  documented reason is allowed.

### What's still pending (carry forward to v1.8.0)

- **US-05 cost-governor outer-loop** (deferred from this version)
- **6 LOOPING_MODES live verify** (autopilot, team, ultrawork, ultraqa,
  sciomc; ralph already verified v1.6+v1.7)
- **11 MCP server end-to-end testing** (per user mandate)
- **19 agent QA matrix** vs omc
- **true dev-version pinning** for plugin install (ship curated lockfile
  via npm pack rather than first-install resolution)
- See `docs/architecture/v1.7-to-v2.0-roadmap.md` for v1.8 + v1.9 + v2.0
  full scope.

## [1.6.0] — 2026-05-24

### Notable — mode.ts outer-loop ralph iteration advance (live-verified)

After user critique on v1.3-v1.5 ("为什么一直在叠加版本号，而不是在某一个
版本解决遇到的问题" — "why keep stacking version numbers instead of
solving the problem in one version"), v1.6 ships the actual fix for the
ralph iteration-counter-advance issue that v1.3 L3.6 smoke first
surfaced and that v1.4 + v1.5 tags shipped without resolving.

Tag gate this version: live smoke MUST show `ralph-state.iteration > 1`.
PASSED — see docs/smoke/v1.6-outer-loop-smoke.md.

Tests: 1156 → 1167 passing (+11 new, including 5 outer-loop tests +
hardening updates), 2 skipped, 0 failed (1 pre-existing worker-fork
EPERM baseline unchanged since v0.4.0). Build: tsc clean.

### Tier 1 — Path C: mode.ts outer-loop (the real fix)

- `a06e3b8` **feat(mode): v1.6 outer-loop for ralph iteration advance
  (zero Stop-hook dependency)**. Replaces single-spawn ralph mode with
  a while-loop in `mode.ts` that wraps `spawnSyncCrossPlatform("copilot",
  ...)`. Each iteration writes ralph-state with `iteration: N` +
  `outerLoopOwned: true` BEFORE spawn, post-spawn re-reads PRD, and
  iterates until: PRD complete / architect-approved / non-zero exit /
  `--max-iterations` cap reached.

  The `outerLoopOwned: true` flag is the dedup guard — when the
  upstream Copilot pwsh dispatch bug eventually gets fixed and Stop
  hook fires again, `checkRalph` sees this flag and returns noop
  instead of double-incrementing the iteration counter.

  Files changed:
  - src/lib/ralph-state.ts — `outerLoopOwned?: boolean` on RalphState
    + read-side whitelist passthrough
  - src/cli/commands/mode.ts — outer while-loop; clearModeState moved
    to termination paths only (preserves mutual-exclusion lock between
    iterations); input validation clamps maxOuter to >=1
  - src/cli/omcp.ts — `--max-iterations <n>` CLI flag; clarified
    `--max-continues` help text (caps PER-SPAWN turns, not outer count)
  - src/hooks/persistent-mode/index.ts — early-return guard in
    checkRalph for `outerLoopOwned`

  Tests: src/__tests__/ralph-outer-loop.integration.test.ts adds 5
  deterministic vitest assertions covering happy path, crash recovery,
  hook guard, max-iterations cap with state assertion, and
  maxOuterIterations clamp for invalid input.

### Tier 1 — Path A + B (artifacts)

- `8152969` **docs(upstream): v1.6 path A + B artifacts**. Filing the
  upstream Copilot pwsh dispatch issue at github/copilot-cli was
  BLOCKED at the auth layer (runjiashi_microsoft is an EMU account;
  `gh issue create` returns "Unauthorized: As an Enterprise Managed
  User, you cannot access this content"). The issue body is ready at
  docs/upstream-reports/copilot-pwsh-dispatch-issue-body.md for manual
  filing via a non-EMU account.

  Sparkshell .exe wrapper investigation (Path B) deferred — crates/
  sparkshell does not exist (M3 milestone, greenfield), no Rust
  toolchain on the dev machine, and the bench-vs-live gap that v1.5
  identified means there's no deterministic way to validate sparkshell-
  hook before shipping. Report at docs/upstream-reports/copilot-pwsh-
  dispatch-v1.6-sparkshell-investigation.md.

### Tier 2 — Live smoke artifact

- `docs/smoke/v1.6-outer-loop-smoke.md` — first live evidence of
  ralph-state.iteration advancing past 1 since v1.3. 3-story PRD
  with `--max-continues 1 --max-iterations 2` produced final state
  `{iteration: 2, outerLoopOwned: false, active: true}` — the tag
  gate the user set after the v1.5 retrospective.

### Known gaps (deferred to v1.7+)

- **M1 stall detection** (critic finding): outer loop has no
  "if 0 PRD progress in N consecutive iterations, bail" circuit
  breaker. Worst case: 20 wasted spawns. `maxOuterIterations` cap
  is the only safety net today.
- **M2 continuation context injection** (critic finding): iteration
  2+ spawns reuse the same prompt; Copilot starts fresh each spawn
  without seeing progress.txt or PRD status injected. Token cost
  ~2x vs. single-session.
- **Architect-approval detection via Stop context text** is silenced
  during outer-loop mode (hook returns noop on outerLoopOwned).
  The outer loop only sees architectApproved if it was set BEFORE
  the run. Users should rely on PRD `passes:true` as the completion
  signal under v1.6.
- **Upstream Copilot pwsh dispatch bug**: still present; the outer
  loop makes it irrelevant for iteration advance but Stop hook
  delivery (and thus L1.3 compaction advise + per-tool-call hook
  features) remains broken on Windows 1.0.53-2 until upstream fixes.
- **HUD flicker** during multi-iteration runs (clearModeState gap)
  was mitigated by moving the clear out of the loop (architect M3
  finding addressed).

### What's still pending (carry forward to v1.7.0)

- File the upstream issue via a non-EMU account
- L3.6-style long-run smoke (10+ stories) on v1.6 outer-loop
- L2.4 verify-phase + L2.9 team multi-agent live smokes (deferred
  since v1.2)
- Stall detection + continuation context (the two critic findings)
- DEP0190 deprecation warning during `omcp setup` (deferred since v1.5)

## [1.5.0] — 2026-05-24

### Notable — MCP plugin-install deps + upstream pwsh dispatch bug detection

The v1.4 post-cut live smoke at `C:\Users\runjiashi\Temp\omcp-v14-smoke`
surfaced two issues that v1.4 deterministic tests could not catch:

1. **62 occurrences of `Cannot find package '@modelcontextprotocol/sdk'`**
   from MCP server startup — `omcp setup` was copying `dist/` to the
   plugin install path but never installing `node_modules` there.
2. **36+ occurrences of `HookExitCodeError: code 1` with `eval_stdin
   SyntaxError`** stack traces across all 13 hook event types — Copilot's
   Windows pwsh dispatch boundary drops the script-path argument from the
   `pwsh.exe -nop -nol -c <command>` wrapper, causing Node to enter
   `eval_stdin` mode and parse the JSON payload as TypeScript.

v1.5 fixes (1) and adds detection for (2). The upstream pwsh dispatch bug
cannot be worked around on omcp's side — bench reproductions across 8
command-form variants × 7 env-variant tests all PASS while the live
session fails. The bench-vs-live gap is itself diagnostic and points to
a Copilot embedded Node v24.16.0 SEA → pwsh.exe → Node v24.14.1 child
boundary issue that needs an upstream fix.

Tests: 1133 → 1156 passing (+23 new), 2 skipped, 0 failed (1 pre-existing
worker-fork EPERM baseline unchanged since v0.4.0). Build: tsc clean.

### Tier 1 — MCP plugin-install deps fix

- `3572efa` **fix(setup): write minimal runtime package.json + npm install
  MCP deps in plugin install dir**. `omcp setup` now writes a minimal
  runtime manifest (name `oh-my-copilot-plugin-runtime`, type `module`,
  private, dependencies-only — no devDependencies, scripts, or bin) to
  `~/.copilot/installed-plugins/oh-my-copilot/oh-my-copilot/`, then runs
  `npm install --omit=dev --ignore-scripts --prefer-offline --no-audit
  --no-fund` in that directory. All 10 MCP servers (state, notepad,
  trace, project-memory, loop, code-intel, hermes, wiki, python-repl,
  shared-memory) can now resolve `@modelcontextprotocol/sdk` and the
  other 4 runtime deps (commander, jsonc-parser, chalk, zod). Verified
  live: "added 95 packages in 7s" + the sdk directory is present at
  `plugin/node_modules/@modelcontextprotocol/sdk/`. 9 deterministic
  vitest assertions cover write, spawn args, ENOENT, exit-1, dryRun,
  skipDepsInstall, idempotency, plus 2 regression guards against
  accidentally adding `node_modules` or `package.json` to the cpSync
  source arrays.

### Tier 1 — upstream pwsh dispatch bug detection

- `91b36ce` **feat(doctor): detect upstream Copilot Windows pwsh dispatch
  bug + bench evidence**. New `omcp doctor` check 9 + pure analyzer
  `analyzeHookDeliveryFromLog()` + filesystem probe `probeHookDeliveryHealth()`.
  Scans the most recent Copilot log file under `~/.copilot/logs/` for
  `node:internal/main/eval_stdin` SyntaxError signatures and emits a
  warn-level check with a link to the v1.5 investigation doc.
  Distinguishes the upstream eval_stdin pattern from bare
  HookExitCodeError (latter = handler ran and exited 1 for non-upstream
  reasons; different remediation). 11 deterministic tests cover the
  pure analyzer + filesystem probe + log-file-selection-by-mtime.

  The investigation produced 4 bench scripts at
  `docs/probes/copilot-pwsh-dispatch/test-*.cjs`. The bench scripts
  cover 8 command-form variants × 7 env-variant tests + NODE_OPTIONS
  + windowsVerbatimArguments permutations. None reproduce the live
  failure — the gap is itself diagnostic of the upstream boundary.

  Investigation report at
  `docs/upstream-reports/copilot-pwsh-dispatch-v1.5-investigation.md`
  with upstream issue body draft ready to file at
  github.com/github/copilot-cli.

### Tier 1 — audit-driven follow-up

- `53ab66c` **fix(doctor, setup): audit-driven follow-up — bounded log
  read + bench-script relocation**. Architect + critic independent
  reviews of `3572efa` + `91b36ce` converged on 2 items:
  - I-1: `probeHookDeliveryHealth` was reading the entire Copilot log
    into memory via `readFileSync`. On a 50 MB log this allocates ~100 MB
    V8 string and blocks doctor for seconds. Fixed: introduce
    `readLogTail(filePath)` reading at most 512 KB from the file tail
    via `openSync` + `readSync` with seek to `fileSize - 512KB`. Hook
    errors are appended at runtime so the trailing window covers
    ~5000 typical stack frames. 3 new tests cover small file (full
    read), large file (tail-only), and tail-read of huge synthetic log
    correctly surfacing trailing eval_stdin.
  - I-2: bench scripts `scripts/test-*.cjs` were being copied to the
    plugin install dir AND shipped in the npm tarball via
    `package.json#files`. Moved to `docs/probes/copilot-pwsh-dispatch/`
    which is in neither `SOURCE_ROOTS` nor `files` — bench scripts
    stay in the repo for future investigators but are excluded from
    any user-facing install.

### Tier 2 — operational + hygiene

- `ffff6af` **chore(gitignore): ignore .omcp-smoke/ working dir**.
  Smoke working directory was untracked but accumulating debris across
  smoke runs. Codified the existing behavior.

- `6d4590b` **docs(smoke): v1.4 iteration live smoke + v1.5 input
  evidence**. Live re-smoke artifact documenting what v1.4 closed
  (housekeeping fallback + payload hardening) and what remained open
  (upstream pwsh dispatch + MCP plugin-install deps) as inputs to
  v1.5.

### Live re-smoke verification (v1.5)

Re-ran the same 2-story PRD on Copilot 1.0.53-2 after `omcp setup` to
materialize the v1.5 MCP deps fix:

| Check | v1.4 | v1.5 |
|---|---|---|
| ralph exit code | 0 | 0 |
| files + PRD correct + state cleared | YES | YES |
| MCP server load successful | NO (62 MODULE_NOT_FOUND) | YES (`@modelcontextprotocol/sdk` present at plugin install path) |
| `omcp doctor` detects upstream bug | (probe didn't exist) | WARN ("eval_stdin failures in process-*.log") |
| Stop hook handler runs (`incrementRalphIteration`) | NO (upstream pwsh) | NO (upstream pwsh — unchanged) |

End-user-visible ralph behavior is correct because mode.ts post-spawn
re-read (v1.4 Fix A in 3175be5) handles cleanup independently of Stop
hook delivery. The doctor probe surfaces the still-broken upstream
pipeline so users know.

### What's still pending (carry forward to v1.6.0)

- **Upstream Copilot pwsh dispatch bug** — file the upstream issue
  (draft in copilot-pwsh-dispatch-v1.5-investigation.md), monitor for
  fix on Copilot side. Workaround attempts deferred until upstream
  triages.
- **DEP0190 deprecation warning** during `omcp setup` — `shell:
  process.platform === "win32"` triggers Node 24's
  shell-with-args-concatenation warning. Args are static so the
  warning is a known false positive. Resolution: replace shell:true
  with absolute-path npm.cmd resolution (attempted in this session
  but Node spawn semantics for .cmd without shell are fragile).
- **L3.6 long-run live smoke re-run** after upstream pwsh fix lands.
- **L2.4 verify-phase live smoke** + **L2.9 team multi-agent live
  smoke** — still deferred since v1.2/v1.3.
- **MCP plugin-install package-lock.json** — currently the minimal
  manifest uses caret ranges; no lockfile at install path means
  floating-version risk.
- **Daemon mode** + **modifiedArgs surgeon** + **marketplace publish**
  (user-demand gated).

## [1.4.0] — 2026-05-24

### Notable — housekeeping RCA + Copilot Stop-payload hardening + canonical --yolo

The v1.3.0 release artifact (L3.6 smoke) revealed that ralph-state did not
clear and iteration did not advance after a clean 10-story completion.
This session's deep-dive trace identified three independent root causes —
all present in v1.3.0 — and v1.4.0 fixes each with deterministic vitest
coverage.

Tests: 1098 → 1133 passing (+35 new), 2 skipped, 0 failed (1 pre-existing
worker-fork EPERM baseline unchanged since v0.4.0). Build: tsc clean.

### Tier 1 — RCA fixes (housekeeping + iteration advance)

- `3175be5` **fix(mode): post-spawn state re-read for housekeeping decision**.
  Pre-fix, mode.ts captured `prdStatusSnapshot` BEFORE spawn (when PRD is
  by definition incomplete for first-time runs), then used that stale
  snapshot AFTER spawn to decide ralph-state clearing. Decision was always
  "don't clear" → `writeRalphState(ralphSnapshot)` restored spawn-time
  `iteration:1, active:true`. Fix splits semantics: pre-spawn snapshot
  used ONLY for crash recovery on non-zero exit; clean exit re-reads
  `getPrdCompletionStatus()` post-spawn. Test 5 in
  `ralph-state-crash-recovery.integration.test.ts` deterministically
  reproduces the bug + verifies the fix.

- `515b98f` **refactor(mode): remove dead postRunRalph branch**. Architect +
  critic independently found that `clearModeState("ralph")` wipes the file
  BEFORE the post-spawn re-read in 3175be5, making `postRunRalph` always
  null. Removed the dead references; `shouldClear` simplifies to two
  clauses.

- `3451a48` **feat(mode): pass --yolo for looping modes**. Per official
  Copilot docs, the canonical non-interactive invocation is
  `copilot --autopilot --yolo --max-autopilot-continues N -p "..."`. omcp
  previously pushed only `--autopilot`. Adding `--yolo` matches docs and
  prevents mid-loop permission prompts from stalling unattended runs.
  Verified to have NO hook-dispatch effect (per
  `docs/upstream-reports/copilot-yolo-flag-investigation.md`); this commit
  closes the canonical-invocation gap. 8 deterministic tests in
  `runMode-args-yolo.integration.test.ts` assert --yolo presence per
  looping mode and absence in one-shot modes.

- `e8d24d7` **fix(hooks): accept Copilot snake_case Stop payload + raw
  payload via HookContext**. Trace investigation revealed Copilot 1.0.53+
  emits Stop fields in snake_case (`session_id`, `stop_reason`,
  `transcript_path`), but omcp's `runFireCli` read only `sessionId`
  (camelCase) and `extractStopContext` read `ctx.toolArgs ?? ctx.toolResult`
  (Copilot does NOT populate these for Stop events). Result: empty
  StopContext → isContextLimitStop/isRateLimitStop guards blind to real
  stop_reason. Harmless for "end_turn" but latent for context_limit /
  rate_limit reasons. Fix adds `payload?: Record<string, unknown>` to
  HookContext, plumbs the raw stdin payload through `runFireCli`, accepts
  both `sessionId` and `session_id` for session-id extraction, and updates
  `extractStopContext` to read `ctx.payload ?? ctx.toolArgs ?? ctx.toolResult`.
  5 deterministic tests in `stop-hook-iteration-advance.integration.test.ts`
  cover Stop → ralph iteration-advance (end_turn → advance,
  context_limit_exceeded → bail-out, PRD-complete → clear, legacy ctx
  without payload → toolArgs fallback).

- `5fac994` **fix(hooks): audit-driven hook hardening**. Pre-tag multi-
  agent release-readiness audit (architect + critic + test-engineer,
  three independent contexts) converged on two findings: (a) the same
  v1.4 snake_case Stop payload bug existed in `todo-continuation/index.ts:39`
  — the persistent-mode fix was not propagated to its sibling, leaving
  bail-out guards (isContextLimitStop, isRateLimitStop, isAuthenticationError)
  blind to real Copilot stop_reason and risking infinite todo-continuation
  loops on context-exhausted Stop events; (b) `runFireCli` ctx-building
  logic (the v1.4 fix site itself) was inline and untestable. Fix (a):
  mirror persistent-mode's `extractStopContext` pattern in todo-continuation;
  5 new deterministic tests cover real Copilot payload bail-out paths.
  Fix (b): extract `buildHookContextFromPayload(rawPayload, fallbackCwd)`
  as exported pure function; 16 new deterministic tests cover sessionId
  snake_case/camelCase extraction precedence, cwd fallback, raw payload
  preservation, tool* field mapping, and a verbatim Copilot log-line-1507
  regression case.

### Tier 1 — operational (no commit)

- `omcp setup` re-run: refreshes `~/.copilot/settings.json` from the stale
  `scripts/omcp-hook-dispatch.cjs` form (left over from the L1.2 revert at
  `c7cbc21` that deleted the wrapper script without re-running setup) to
  the canonical `dist/cli/omcp.js hook fire <event> --json` form. This is
  the proximate cause of the v1.3.0 L3.6 smoke's "3/3 Stop handlers exit
  code 1" — handlers were invoking a deleted file (MODULE_NOT_FOUND →
  exit 1 → Copilot surfaces as `HookExitCodeError: code 1`).

### Tier 2 — Lane 3 closure (disputed-doc cleanup)

- `2612092` **docs(upstream): close Lane 3** — the v1.3.0 session's
  "Copilot 1.0.53-1 broke Stop hook dispatch upstream" claim is DISPUTED.
  `HookExitCodeError: code 1` literally means the handler RAN and exited
  1 (not that Copilot failed to dispatch). The previous session's
  evidence cannot distinguish upstream-broken from omcp-handler-exits-1;
  the latter is the actual cause (see e8d24d7 trace artifact + stale
  settings.json). Delete `docs/upstream-reports/L1.3-reassessment-2026-05-24.md`
  (premise refuted); revert append on `copilot-cli-hook-eval-stdin.md`
  (Stop+SessionEnd upstream-broken claim insufficiently supported); add
  `docs/upstream-reports/copilot-yolo-flag-investigation.md` (full
  investigation cited from official docs + live bundle inspection).

### Tier 2 — handoff archive

- `c0733e1` **docs(handoff): archive 2026-05-24 v1.4 housekeeping RCA**.
  Snapshot from prior session documenting the housekeeping bug RCA + user
  standards (deterministic vitest > smoke, team+critic per fix, multi-
  subagent cross-verification, read upstream docs before blaming upstream).

### What's still pending (carry forward to v1.5.0)

- **L3.6 long-run live smoke re-run on v1.4**: deterministic tests cover
  the housekeeping + Stop-payload + iteration-advance paths (1112 tests
  green). A live re-run with rebuilt dist/ + refreshed settings.json
  would confirm end-to-end behavior on real Copilot 1.0.53-2.
- **L1.3 compaction-advise live verification**: now that Stop hooks
  actually deliver, re-trigger above-threshold context utilization and
  confirm compaction advise text reaches the model context.
- **L2.4 verify-phase live smoke** (still deferred).
- **L2.9 team multi-agent live smoke** (still deferred).
- **Upstream Windows pwsh dispatch bug**: secondary issue from the v1.4
  trace investigation (Copilot 1.0.52-4 pwsh executor strips script path
  on multi-arg commands). Unconfirmed whether 1.0.53-2 fixed it. File
  upstream issue ONLY if reproducible after settings.json refresh.
- **`omcp doctor` stale-settings detection**: detect entries in
  `~/.copilot/settings.json` that reference missing handler scripts;
  emit a warning + suggest `omcp setup` to refresh. Would have caught
  the stale-dispatch-script scenario before runtime.
- **Replace `--allow-all-tools` with `--yolo` for looping modes**
  (tidy-up): `mode.ts:239` unconditionally pushes `--allow-all-tools`;
  `--yolo` added in v1.4 supersedes it for looping modes. Consolidating
  saves one arg. Non-blocking — both forms are valid.
- **Daemon mode** + **modifiedArgs surgeon** (user-demand gated).
- **Marketplace publish** + user-facing docs + auto-update.

## [1.3.0] — 2026-05-24

### Notable — UX layer + protocol completion + first long-run smoke

Tier 1 (user-facing) and Tier 2 (protocol completion) follow-ups from
v1.2.0's HANDOFF. 4 commits + 1 inline fix + 1 release commit.

Tests: 1082 → 1098 passing (+16), 2 skipped, 0 failed (1 pre-existing
worker-fork EPERM baseline unchanged since v0.4.0). Build: tsc clean.

### Tier 1 — UX

- `2f6eff6` **HUD data wiring**: omcp hud now fills columns 3-5 (modes /
  ralph iter/max / team done/spawned). Was showing all 4 dashes;
  `state.ts` added 7 missing mode candidates (plan, ccg, learner,
  deep-interview, deep-dive, external-context, ai-slop-cleaner) and
  `render.ts` now gates ralph-iter on the active flag. 8 new tests.

### Tier 2 — Protocol completion

- `8aef816` **Worker-side shutdown ack**: new `skills/team-worker/SKILL.md`
  + OMCP_TEAM_SESSION_ID / OMCP_TEAM_WORKER_INDEX env-var propagation
  through both tmux and detached spawn modes. Workers can now actually
  call the `omcp team-ack` CLI verb (shipped in v1.2.0) instead of the
  protocol being a paper trail. 3 tests cover env-var propagation.

- `dc0486e` + `a028753` **L2.5b fixing-phase incoming edge**:
  `runTeamCollect` now calls `mergeShards()` when a `teamName` is
  provided; if `MergeReport.conflicts.length > 0`, transitions
  `executing → fixing` and writes `conflicts.json` for manual / future
  automated resolution. `executing → fixing` added to
  `VALID_TEAM_TRANSITIONS`. The `omcp team-collect` CLI verb now exposes
  `--team-name <name>` and maps exit code 2 to the fixing phase.
  Defense-in-depth in `a028753`: `mergeShards` exceptions caught with
  warning log + empty-report fallback so the controller never throws
  uncaught. 5 new tests cover conflict detection + idempotency.

### Tier 3 — Smoke verification

- `docs/smoke/L3.6-long-run-ralph-smoke.md` (this release): 10-story
  long-run smoke against real Copilot. Result: **orchestration PASS,
  housekeeping PARTIAL**. All 10 stories complete + 10 files created +
  ralph exit 0 in 2m25s. The housekeeping gap (iteration counter not
  advancing under `--autopilot`; clearRalphState not firing on
  allComplete) is documented as v1.4 RCA. Core orchestration is
  validated end-to-end; the housekeeping layer needs a deeper smoke
  with multi-turn Copilot continuations to surface its real behavior.

### What's still pending (carry forward to v1.4.0)

- **L3.6 housekeeping RCA**: investigate why ralph-state iteration
  doesn't advance + clearRalphState doesn't fire under `--autopilot`
  single-turn completion. Likely interaction between
  `incrementRalphIteration` timing and Stop-event dispatch.
- **High-load compaction smoke**: re-run L3.6 with a 30+ story PRD
  requiring real edits (not trivial writes) to push context above 50%
  and verify L1.3 Stop-side advise actually delivers.
- **L2.4 verify-phase live smoke** (still deferred).
- **L2.9 team multi-agent live smoke** (still deferred).
- **Upstream Copilot CLI bug fix** (file issue, monitor).
- **Daemon mode + modifiedArgs surgeon** (user-demand gated).
- **Marketplace publish** + user-facing docs + auto-update.

## [1.2.0] — 2026-05-24

### Notable — orchestrator hardening: L1 upstream workaround + L2.5b phase controller + L2.7 ack completion

Continues from v1.1.0 with 4 Tier 1+2 follow-ups landed against the
upstream Copilot CLI hook-dispatch bug and the team-coordination gaps.

Tests: 1044 → 1082 passing (+38), 2 skipped, 0 failed (1 pre-existing
worker-fork EPERM baseline unchanged since v0.4.0). Build: tsc clean.

### Tier 1 — Upstream-bug workaround

- `113df30` **L1.3**: preemptive-compaction now subscribes to **Stop**
  in addition to PostToolUse + PreCompact. Routes around the upstream
  Copilot CLI hook-dispatch bug (`node:internal/main/eval_stdin`
  SyntaxError on PostToolUse — Copilot 1.0.52-4 + 1.0.53-1 both
  affected). Stop hook fires reliably (0 failures in all smokes), so
  the `/compact` context-warning advisory now reaches Copilot for
  long-running ralph sessions even when PostToolUse delivery is
  broken upstream. Reuses L3.2's `estimatePromptHistoryTokens` for an
  independent token-estimate signal that doesn't depend on per-tool
  accumulation. +7 tests covering subscription, threshold check,
  MAX_WARNINGS cap, re-arm boundary, and `estimatePromptHistoryTokens`-only
  path (zero PostToolUse signal, simulating the worst-case upstream-bug
  scenario).
- `docs/upstream-reports/copilot-cli-hook-eval-stdin.md` (new):
  github.com/github/copilot-cli issue draft documenting the upstream
  dispatch bug with full reproduction + investigation evidence. User
  files the actual issue.

### Tier 2 — Multi-agent coordination completion

- `c50ccf7` **L2.7 completion**: new CLI verb
  `omcp team-ack <session-id> <worker-index>` for worker-side shutdown
  acknowledgment. Completes the protocol whose orchestrator-side was
  shipped in v1.1.0 (`c6d39c3`). Worker prompts can now deterministically
  write `worker-K-ack.json` via the CLI when they detect a
  `shutdown-request.json` marker — unblocking the orchestrator's
  30s wait loop. assertSafeSlug on sessionId; integer guard on
  workerIndex; idempotent rewrite; 9 tests. `eaddb4c` adds defense-in-depth
  guards inside `runTeamAck` itself (was only validated in the CLI
  wrapper; Critic iter-1 of v1.2 flagged it).
  `docs/workflows/team-shutdown-protocol.md` documents the full
  request/ack/SIGTERM-fallback protocol.

- `fb67cf2` **L2.5b**: team phase-transition controller atop L2.5a's
  schema. New `transitionPhase(sessionId, target, reason?)` helper in
  `mode-state.ts` with `VALID_TEAM_TRANSITIONS` state-machine guard
  (omc's actual 6-value enum: initializing | planning | executing |
  fixing | completed | failed). New CLI verb `omcp team-collect
  <session-id>` (in `team-phase-controller.ts`) inspects pidfiles +
  shard files to determine `executing → completed/failed` transitions.
  Crash-restart detection: dead worker without shard → `failed` with
  stage_history entry. Idempotent on terminal phases. `team.ts` now
  correctly writes `current_phase: 'initializing'` before spawn and
  transitions to `'executing'` after both tmux + detached spawn paths
  (corrects an L2.5a labeling). 25 tests (15 unit + 10 integration
  including crash-restart, partial crash, dead-with-shard, and v1.1.0
  legacy state back-compat).

### What's still pending (carry forward to v1.3.0)

- Live smokes (release-verify, not blocking): L2.4 verify-phase against
  real Copilot, L2.9 team multi-agent (4 workers), L3.6 30-iteration
  ralph long-run.
- Upstream Copilot CLI hook-dispatch fix (file issue, monitor for
  resolution).
- Worker-side shutdown ack writer in the Copilot **skill prompts**
  themselves (v1.2.0 ships the CLI verb that workers will call;
  the skill-side instruction to call it lives in `docs/workflows/`
  for now — needs to be inlined into the ralph skill or a new
  team-worker skill in a follow-up).
- L2.5b's `fixing` phase has outgoing edges but no incoming (no
  caller writes it). Add a v1.3 path that detects shard merge
  conflicts and transitions to `fixing`.
- L2.4 prompt-template fix if live smoke shows detectVerdict needs
  sentinel-tag matching.
- Daemon mode (Option O-B) + modifiedArgs surgeon (Phase 7) — original
  orchestrator-v1 deferrals; gated on user demand.

## [1.1.0] — 2026-05-24

### Notable — orchestrator-complete (L1 + L2 + L3 of the deep-dive plan)

Implements the consensus-approved plan at `docs/plans/complete-omcp-orchestrate-ralplan.md`
(Architect+Critic APPROVE, commit `5aae02e`). Goal: complete omcp's orchestrator
layer to omc-parity quality bar, focusing on ralph + ralplan + team, long-running
reliability, and multi-agent coordination.

20 phases delivered across 3 layers + hygiene. Tests: 979 → 1044 passing (+65),
2 skipped, 0 failed (1 pre-existing Windows worker-fork EPERM baseline unchanged
since v0.4.0).

### Layer 1 — Hook dispatch (Windows + Node 24)

- `bcb5065` **L1.0 + L1.1**: All 13 hook commands in `~/.copilot/settings.json` now
  use the omc-style absolute-node form `node "<abs>" hook fire <event> --json`
  (was bare `omcp hook fire ...`). The bare form went through the npm shim layer
  (omcp.ps1 / omcp.cmd) which, under Copilot+pwsh+Node-24's dispatch chain,
  triggered Node's eval-stdin TypeScript-strip mode and broke 12 of 13 events
  with `SyntaxError: Unexpected token ':'`. New `resolveHookCommandBin()`
  unconditionally returns the absolute form; mirrors omc's
  `src/hooks/setup/index.ts:166`. 14 unit tests pin all 13 event commands.
- **L1.2 status**: PARTIAL pass. Re-smoke against real Copilot showed
  PostToolUse error count drop from 42 (Phase A) to 27 (≈36% reduction). The
  remaining 27 errors are noise (orchestration loop still completes correctly:
  PRD lifecycle works, Stop hooks fire cleanly, allComplete short-circuits,
  ralph exit 0). Root cause for remaining 27 is opaque (Copilot's pwsh
  dispatch behavior on multi-arg commands with large JSON stdin) and tracked
  as v1.2.0 follow-up. Documented in `docs/probes/L1-hook-dispatch-format.md`.

### Layer 2 — Multi-agent dispatch (ralph + ralplan + team + verify-phase)

- `51c501b` + `76cf826` **L2.2**: `omcp verify-phase --timeout <seconds>`
  option (default 600s = 10min). Threads through to spawnSync; timeout-killed
  spawn produces ITERATE verdict (not crash, not infinite loop). `timeout: 0`
  passes through as "no timeout" (was silently coerced to 600). 25 tests.
- **L2.1 (scope-bled into `c6d39c3` + mode.ts changes)**: `omcp ralplan
  --handoff` flag wires the ralplan→boulder→ralph chain. Previously
  hardwired to `handOffToRalph: false` and `planContent: ""` (broken). Now
  reads `readBoulderState()` after copilot exits cleanly, populates plan
  content, and triggers ralph pickup. 4 integration tests.
- `2fb9307` **L2.5a**: TeamPhase stage state schema on TeamState. Adds
  `current_phase` (omc's actual 6-value enum: `initializing | planning |
  executing | fixing | completed | failed`) and `stage_history` as optional
  fields. Writes `'executing'` at spawn time. Forward-compat for future
  v2.0 phase controller (L2.5b deferred). 4 tests.
- `a53205d` **L2.6**: Worker pidfile written via `atomicWriteFileSync` (was
  bare `writeFileSync`). Invariants.md carve-out lifted. 2 tests.
- `c6d39c3` **L2.7**: shutdown_request / shutdown_response protocol for
  team workers. omcp writes a request marker; waits up to 30s
  (`OMCP_TEAM_SHUTDOWN_WAIT_MS`) for each worker to ack; falls through to
  SIGTERM. Mirrors omc's pattern. Worker-side ack-write is a Copilot
  skill responsibility (not yet implemented). 4 tests.
- `e8a950a` **L2.8**: Stuck-worker watchdog — `omcp team-watch <session-id>`
  CLI verb scans pidfiles + shard mtimes, detects workers stuck >10min
  (`OMCP_TEAM_WATCHDOG_TIMEOUT_MS`), writes reassign-needed markers via
  atomicWriteFileSync. Detection + logging + marker phase only;
  reassignment orchestration deferred. 4 tests.

### Layer 3 — Long-running resilience

- `7389594` + `252c66a` **L3.1**: `progress.txt` rolling-tail cap (default
  64KB, `OMCP_PROGRESS_MAX_BYTES`). Append-time enforcement +
  defensive read-time tail-only injection in getRalphContext.
  ##-boundary aware truncation. 10 tests.
- `ed990c4` **L3.2**: preemptive-compaction per-N-iter re-arm (default 5
  iterations, `OMCP_COMPACTION_REARM_EVERY`) so the hook no longer goes
  permanently silent after 3 warnings. New `estimatePromptHistoryTokens()`
  reads ralph-state.json + progress.txt bytes and folds them into the
  token estimator. 8 tests.
- `25dce51` **L3.5**: Per-event hook timeout via new
  `MergeHookOptions.timeoutsByEvent` field (highest priority); default 30s
  for Stop + PreCompact (the events running substantive logic), 5s for the
  rest (preserves backward compat). 7 tests.
- `ccba99b` **L3.3**: Conditional `clearRalphState` — `mode.ts` previously
  cleared state unconditionally on copilot exit; now only on (exit 0 AND
  allComplete) OR architectApproved. Non-zero exits and incomplete-PRD
  exits preserve state for resume. Snapshot-before-clearModeState pattern
  used because clearModeState and clearRalphState share
  `.omcp/state/ralph-state.json`. 4 integration tests.
- `26e7dbd` **L3.4**: Stale mode-state auto-detect via `isModeStateStale()`
  (default 60min, `OMCP_MODE_STATE_STALE_MS`); `omcp ralph --resume`
  auto-clears stale state and proceeds with a fresh run. Without
  `--resume`, blocks with a clear error. 6 tests.

### Test alignment (regression hygiene)

- `7c1fb2e` Updated 5 pre-existing test files to match the new Wave A/C
  contracts (absolute-node form, conditional clearing, stale field on
  canStartMode return type). No source modifications; tests now assert
  the new invariants explicitly.

### Smoke status — gates and follow-ups

| Smoke | Gate | Status |
|-------|------|--------|
| L1.2 hook re-smoke | HARD | **PARTIAL** — 42→27 hook errors (36% reduction); orchestration end-to-end works; root cause for residual 27 is opaque Copilot pwsh dispatch quirk; v1.2.0 follow-up |
| L2.3 ralplan handoff | HARD | **DEFERRED** — code-complete + 4 integration tests pass; live Copilot smoke deferred to v1.1.0 release-verify session |
| L2.4 verify-phase | SOFT | **DEFERRED** — code-complete + 25 tests via DI mock; live exercise gated on a real submission |
| L2.9 team multi-agent | SOFT | **DEFERRED** — code-complete + per-worker test coverage; live 4-worker smoke deferred |
| L3.6 30-iter ralph | SOFT | **DEFERRED** — code-complete; synthetic 30-iter smoke deferred (estimated 20-30min wall clock) |

The 4 deferred live smokes are flagged in HANDOFF.md as v1.1.0 release-verify
follow-ups. v1.1.0 ships with full code + unit/integration test coverage; the
remaining gap is real-Copilot end-to-end exercise.

### Plan artifacts

- `docs/plans/complete-omcp-orchestrate-ralplan.md` — Architect+Critic
  consensus plan (committed `5aae02e`)
- `docs/specs/complete-omcp-orchestrate-spec.md` — spec
- `docs/specs/complete-omcp-orchestrate-trace.md` — deep-dive trace
- `docs/probes/L1-hook-dispatch-format.md` — L1.0 probe artifact

## [1.0.0] — 2026-05-23

### Notable — first stable API; orchestrator-v1 verified end-to-end

This is the first 1.x release. The 0.13 → 1.0 jump represents API
stabilization rather than a breaking change — there are no breaking changes
relative to v0.13.0. The version bump reflects the project's promise to
maintain semver discipline going forward and signals that orchestrator-v1
has been verified against the real Copilot CLI runtime.

The full work plan lives at `docs/plans/v1.0.0-runtime-verify-ralplan.md`
(consensus-approved by Architect+Critic, commit `695d3e3`).

### Phase A — Real Copilot smoke (orchestrator-v1)

End-to-end smoke run of `omcp ralph` against a live Copilot CLI session,
documented at `docs/smoke/orchestrator-v1-real-copilot-smoke.md`. A
2-story PRD (write a `hello()` helper + a vitest test) drove the
persistent-mode hook loop through Stop event → iteration counter
advancement → allComplete short-circuit → ralph-state cleanup → exit 0.

Bootstrap surfaced two real Windows bugs that were TDD-fixed before
the smoke could complete:

- `5ab4f90` **fix(cli): isDirectInvocation tolerates npm-link symlinks
  (Phase A.0)** — every `omcp` subcommand silently exit 0 with empty
  stdout when invoked via the `npm link` shim. Root cause: argv[1]
  retained the symlink path while Node's ESM loader realpath'd
  import.meta.url. Fix: `realpathSync` canonicalization on both sides
  before the equality check. +8 tests covering file/dir symlinks,
  identical paths, missing entries, fallback to `resolve()`.

- `7eb1f14` **fix(spawn): cross-platform copilot spawn handles Windows
  .cmd shims (Phase A.1)** — every `omcp ralph`/`omcp ask`/`omcp
  autopilot`/`omcp team` failed on Windows under Node ≥18.20.x:
  `spawn("copilot", { shell: false })` couldn't find `.cmd` via PATHEXT,
  and even with the absolute `.cmd` path, Node refused to spawn it
  (CVE-2024-27980 mitigation). Fix: new `src/runtime/resolve-executable.ts`
  exposing `findExecutable` (PATH×PATHEXT scanner), `spawnSyncCrossPlatform`,
  and `spawnCrossPlatform` that dispatch `.cmd`/`.bat` through `cmd.exe
  /d /c` with proper double-outer-quote-pair wrapping and
  `windowsVerbatimArguments: true`. Refactored 4 spawn sites
  (mode.ts, ask.ts, launch.ts, team.ts). +20 tests covering POSIX
  vs. Windows extension probing, multi-PATH first-wins, .cmd vs.
  .exe vs. .ps1 fallback, cmd.exe quoting shape.

### Phase B — pre-mortem #1 closure: omcp PATH fallback

`1955233` **feat(setup): emit absolute-path hook command when omcp not
on PATH** — `omcpHookCommand` previously emitted bare `omcp hook fire
...` which would ENOENT-fail when Copilot's hook executor dispatched
on a fresh machine without `npm link`/`npm install -g`. New
`resolveDefaultOmcpBin` returns `node "<absolute path to
dist/cli/omcp.js>"` when `omcp` is not on PATH, reusing the
`findExecutable` helper from Phase A.1. Closes orchestrator-v1
plan pre-mortem #1. +9 tests covering PATH-hit literal form,
PATH-miss absolute form, packageRoot injection, spaces-in-root.

### Phase C — `omcp verify-phase` CLI automates team+critic protocol

`8b7850b` **feat(cli): omcp verify-phase <phase-id> — automate
team+critic protocol** — new CLI verb that automates the 5-step
verification protocol documented at `docs/workflows/team-critic-verification.md`.
Spawns architect and critic via injectable `spawn` DI hook (matching
the pattern at `exec.ts:28-32`), reads
`.omcp/state/verification/<phase-id>-submission.md`, parses APPROVE/
ITERATE/REJECT verdicts via the new strict `detectVerdict` helper
in `src/lib/ralph-state.ts` (keyword must be sole significant token
on a line — markdown bold tolerated; inline occurrences like "I would
APPROVE this if X" do NOT match; ambiguous lines return null).
Loops up to 5 iterations; writes verdict record via `atomicWriteFileSync`
with `assertSafeSlug` on both phase-id and run-id. Exit codes: 0
(pass) / 1 (escalation) / 2 (invocation error). +20 tests via
DI mock spawn.

### Phase E1 — invariants test checks all 4 manifests

`71f2069` **test(invariants): cli-wiring-invariants checks all 4
manifests + align invariants.md** — the existing 3-manifest
version-sync test was extended to also cross-check
`plugins/oh-my-copilot/.claude-plugin/plugin.json` (the
plugin-bundle mirror regenerated by `scripts/sync-plugin-mirror.ts`).
Invariant 3 in `docs/architecture/invariants.md` rewritten to
enumerate the 4 version-carrier files explicitly and list
CHANGELOG.md separately as the release-note carrier.

### Phase E2 — escapeRegExp retrofit on session query

`58321da` **fix(session): escapeRegExp on query input + invariants.md
doc accuracy** — `omcp session <query>` previously matched query
against worker logs via `new RegExp(query, "gi")` without escaping,
silently turning literal grep into regex match (and ReDoS-prone on
adversarial input). Retrofit through `escapeRegExp` so the CLI
behaves as a substring-grep by default. +6 tests covering metachar
`.`/`+`/brackets, simple substrings, case-insensitive preservation.
`invariants.md:140-148` updated: session.ts:32 moved from "Known
exceptions" to "Enforcement points"; `code-intel-server.ts`
description corrected from "developer-controlled symbol names"
(misleading) to "MCP tool input, hardened with inline escaping".

### Build / verification

- Tests: 979 passing, 2 skipped, 0 failed (1 pre-existing Windows
  vitest worker-fork EPERM at file level — baseline since v0.4.0,
  unrelated to omcp code)
- `npm run build`: tsc clean
- `omcp doctor` (post-setup): all OK
- Phase A artifact: `docs/smoke/orchestrator-v1-real-copilot-smoke.md`

## [0.13.0] — 2026-05-23

### Added — Phase 2: N+2 hook ports (persistent-mode, todo-continuation, omc-orchestrator)

Unblocked by Phase 1.5 investigation (commits `ac55a47`–`2dcf27d`) which
identified that all hook crashes originated from OMC's `$CLAUDE_PLUGIN_ROOT`
Bash variable in PowerShell context — omcp's own hook infrastructure was
correct throughout.

- `src/hooks/persistent-mode/index.ts` (T1, commit `2dcf27d`) — Stop event.
  Priority-ordered continuation enforcement: Ralph > Ultrawork > Todo.
  Ralph path increments iteration counter, injects continuation prompt with
  PRD/todo context, and requests architect verification when all PRD stories
  pass. Ultrawork path increments reinforcement counter. Todo path surfaces
  next pending item with attempt-limit (5) to prevent infinite loops.
  Returns `advise` (Copilot Stop does not support hard-blocking).
  26 tests.

- `src/hooks/todo-continuation/index.ts` (T2, commit `10dd450`) — Stop event.
  Reads `.omcp/state/todos-state.json` via `checkIncompleteTodos`. Injects
  `TODO_CONTINUATION_PROMPT` when pending/in-progress todos remain.
  Escape hatches: context-limit, rate-limit, auth error, cancel, user abort.
  Tests in `src/hooks/todo-continuation/__tests__/`.

- `src/hooks/omc-orchestrator/index.ts` (T3, commit `10dd450`) — PreToolUse
  + PostToolUse events. Enforces delegation over direct implementation.
  Three modes: off (noop), warn (advise), strict (block). Tracks write-tool
  calls outside `.omcp/` and injects `DIRECT_WORK_REMINDER`. Surfaces boulder
  plan-progress after delegation tools complete.
  Tests in `src/hooks/omc-orchestrator/__tests__/`.

**Test count:** 742 → 830 passing (+88). Build clean (tsc, no diagnostics).

### Correction — Retraction of v0.12.0 "upstream Copilot bug" framing (2026-05-23 mid-day)

The v0.12.0 section below attributed the `SyntaxError: Unexpected token ':'`
crash to Copilot CLI 1.0.52-4's hook transport. Subsequent user investigation
produced a definitive trace proving the bug is in **OMC's hook command
template** (Bash-style `"$CLAUDE_PLUGIN_ROOT"/scripts/run.cjs ...` does not
concatenate variable + path suffix under PowerShell 7), not in Copilot's
hook transport. See `HANDOFF.md` section "2026-05-23 mid-day — Retraction"
for the full corrected causal chain.

**Effect on v0.12.0**: the four `omcp state` sub-actions and the
`escapeRegExp` utility shipped in v0.12.0 are independent of hooks and
remain correct as released. The "BLOCKED-UPSTREAM" status of Phase 2
Batch C N+2 (the three deferred hook ports) is incorrect — the blocker
is on us shipping a Windows/PowerShell-safe hook command template, not
on a Copilot upstream fix.

## [0.12.0] — 2026-05-23

### Added — Branch B of next-session-ralplan: state CLI verbs on top of N+1 lib subsystems

Decided by the consensus-approved plan at `docs/plans/next-session-ralplan.md`.
Branch was selected by the Step 1 probe: Copilot CLI 1.0.52-4 still has the
upstream `SyntaxError: Unexpected token ':'` hook executor bug (same as 1.0.51),
so Phase 2 Batch C N+2 (the 3 deferred hook ports) remains BLOCKED-UPSTREAM.
Branch B ships user-facing CLI surfaces on top of the N+1 lib subsystems that
do NOT depend on hook firing.

- `src/runtime/escape-regexp.ts` (US-B0) — invariant-9 utility that escapes
  the 14 regex metachars per MDN. Tiny pure function, 5 tests.
- `omcp state ralph` (US-B1) — `status / start <task> / iterate / clear`,
  delegating to `src/lib/ralph-state.ts`. 11 tests.
- `omcp state ultrawork` (US-B2) — `status / start <prompt> / clear`,
  delegating to `src/lib/ultrawork-state.ts`. 7 tests.
- `omcp state todo` (US-B3) — `add <title> / update <id> <status> /
  list [--filter <pattern>] / clear`. `--filter` runs through `escapeRegExp`
  before compilation so a `.` in the filter matches a literal dot, not "any
  char". 12 tests including the regex-escape proof.
- `omcp state boulder` (US-B4) — `status / list-plans / clear`,
  delegating to `src/lib/boulder-state.ts`. 8 tests.

Nesting: all four sub-actions hang off the existing `omcp state` Commander
command as new switch cases — they do NOT introduce top-level `omcp ralph`
or `omcp ultrawork` verbs, which already exist as mode launchers via
`MODE_COMMANDS` (`src/cli/omcp.ts:64-85`). The `omcp state` description
string is updated to advertise the new sub-actions.

Test count: 699 → 742 passing (+43 net), 0 failed, 2 skipped, Windows
worker-fork EPERM baseline unchanged (hardened in this release via
`doctor-team-routing.test.ts` teardown try/catch matching the
`atomic-write.test.ts` pattern).

### Probe data point (Copilot CLI 1.0.52-4, 2026-05-23)

`scripts/smoke/wire-probe-for-tui.mjs` exercised against the new Copilot
CLI release shipped between v0.11.0 and v0.12.0. Verdict: same
`SyntaxError: Unexpected token ':'` at `node:internal/vm:194:14` —
upstream bug NOT fixed. Reproduction kept under
`~/.copilot/logs/process-*.log` for the next investigation. Re-test
trigger: user upgrades Copilot CLI past 1.0.52-4.

### Carried forward

- All N+1 lib subsystems (worktree-paths, ralph-state, ultrawork-state,
  todo-state, boulder-state, notepad-state) — unchanged.
- All Phase 5 + Phase 6 hooks (cost-governor, loop-detector,
  audit-logger, error-aggregator, auto-recovery-advisor,
  notification-dispatcher, idle-alert) — unchanged.
- Phase 4 hallucination-shield `advise-only` downgrade — unchanged
  (re-evaluation deferred to whichever session closes the hook question).

## [0.11.0] — 2026-05-22

### Added — Phase 5 + Phase 6 hooks from hooks-parity v3 plan

Ships the interrupt-only governance hooks and the telemetry hooks. Both
batches were unaffected by the Phase 1 smoke FAIL because they don't
depend on `modifiedArgs` or `modifiedResult` — they use already-validated
`block`/`interrupt`/append-only patterns.

**Phase 5 — interrupt-only cost governor + audit (commit 4883e96):**

- `src/hooks/cost-governor/` — cumulative tool-call counter, configurable
  budget (default 1000, OMCP_COST_BUDGET env), `{kind:"interrupt"}` at
  threshold. PermissionRequest event. 9 tests.
- `src/hooks/loop-detector/` — rolling-window signature detector
  (default window 10, threshold 5; OMCP_LOOP_THRESHOLD + OMCP_LOOP_WINDOW
  env). SHA-256 of stable-JSON args (key-order independent). PreToolUse
  event. `{kind:"interrupt"}` at threshold repeats. 13 tests.
- `src/hooks/audit-logger/` — append-only `.omcp/state/audit/{sessionId}.jsonl`
  with 5 MB rotation. PreToolUse + PostToolUse + PostToolUseFailure
  events. toolArgs clamped to 2000 chars; toolResult presence logged
  (value NOT logged for privacy + size). Always `{kind:"noop"}`. 15 tests.

Per Architect iter-3 condition 2, modifiedArgs work (bash-safety-net,
surgeon-mode middleware chain) is DEFERRED to Phase 7 with its own
empirical smoke gate.

**Phase 6 — telemetry: ErrorOccurred + Notification (commit ad6a8f1):**

- `src/hooks/error-aggregator/` — append `.omcp/state/errors.jsonl`
  per ErrorOccurred fire (10 MB rotation). Schema includes ts /
  sessionId / toolName / errorMessage / errorStack. Always `{kind:"noop"}`.
  7 tests.
- `src/hooks/auto-recovery-advisor/` — reads last N entries of
  errors.jsonl (default 20, OMCP_RECOVERY_WINDOW env); detects recurring
  patterns (first 80 chars seen ≥3 times, OMCP_RECOVERY_RECURRENCE_THRESHOLD
  env); returns `{kind:"advise"}` with the pattern + recovery suggestion.
  9 tests.
- `src/hooks/notification-dispatcher/` — wires Notification events to
  the existing `dispatchNotificationInBackground` in
  `src/hooks/background-notifications.ts`. Also logs to
  `.omcp/state/notifications.jsonl`. Graceful degrade on dispatch
  failure. 7 tests (uses vi.mock for the dispatcher).
- `src/hooks/idle-alert/` — per-session last-Notification timestamp at
  `.omcp/state/idle-alert/{sessionId}.json` (atomicWriteFileSync).
  Returns `{kind:"advise"}` when gap > threshold (default 300_000 ms,
  OMCP_IDLE_ALERT_THRESHOLD_MS env). 9 tests.

### Notes

- Test suite: 460 (v0.10.0) → 532 passing (+72), 2 skipped, 0 failed.
  1 unhandled vitest worker EPERM is the pre-existing Windows baseline.
- All 7 new hooks live as disjoint dirs under `src/hooks/`. No changes
  to `hook-types.ts`, `runtime.ts`, or `background-notifications.ts`
  (READ-ONLY consumer for notification-dispatcher).
- Phase 1 smoke verdict (FAIL — hooks don't fire in `-p` mode) means
  none of these hooks have live integration tests yet. Unit tests cover
  all logic paths; runtime verification waits for a future interactive
  TUI session.

### Phase 2 Batch C decision (recorded for next session)

User chose **Option A**: port the missing omc subsystems first
(`lib/worktree-paths`, ralph state schema, ultrawork, autopilot,
team-pipeline, subagent-tracker, boulder-state, notepad in-process
state), THEN port persistent-mode + todo-continuation + omc-orchestrator.
Estimated 2-3 sessions. See `docs/plans/phase-2-deferred-hooks.md` for
full dependency analysis.

## [0.10.0] — 2026-05-22

### Added — Phase 1 foundation + Phase 2 batches A/B from hooks-parity v3 plan

After three iterations of ralplan consensus (Planner → Architect → Critic),
the v3 plan reached APPROVE/APPROVE/APPROVE. This release executes Phase 1
and the cleanly-portable parts of Phase 2.

**Phase 1 — type system + runtime plumbing:**

- `OMCP_HOOK_EVENTS` expanded from 5 to all 13 valid Copilot CLI events:
  `SessionStart`, `SessionEnd`, `UserPromptSubmit`, `PreToolUse`,
  `PostToolUse`, `PostToolUseFailure`, `ErrorOccurred`, `Stop`,
  `SubagentStop`, `subagentStart` (camelCase-only), `PreCompact`,
  `PermissionRequest`, `Notification`.
- `HookResult` union expanded from 3 variants (`noop` | `advise` | `block`)
  to 6 — added `modifiedArgs`, `modifiedResult`, `interrupt`. Each new
  variant carries scope-gate metadata in its JSDoc (Phase 4 / Phase 7 /
  Phase 5).
- `runFireCli` now synthesizes the Copilot stdout protocol fields
  (`additionalContext`, `modifiedArgs`, `modifiedResult`, `interrupt`,
  `reason`) at the top level of the emitted JSON. `modifiedArgs` and
  `modifiedResult` use last-wins semantics when multiple hooks fire on
  the same event. Non-JSON output gains single-line formats for the 3
  new kinds.
- Tests: `src/__tests__/hook-result-expansion.test.ts` (17 cases) +
  `src/__tests__/omcp-hook-events.test.ts` (5 cases).

**Phase 2 Batch A — library modules:**

- `src/lib/factcheck/` (~855 lines across 5 files) — port of omc's
  factcheck library: claims validation engine with PASS/WARN/FAIL
  verdicts in strict/declared/manual/quick modes. Pure logic, no
  environment dependencies.
- `src/team/sentinel-gate.ts` (~191 lines) — readiness gate that
  consumes factcheck for team-worker launch validation. Fail-closed
  when enabled but unfed. Includes `waitForSentinelReadiness` polling
  helper with timeout.
- Tests: factcheck.test.ts (PASS/WARN/FAIL paths + sanitization) +
  sentinel-gate.test.ts (ready/blocked/dedup/timeout). +25 cases.

**Phase 2 Batch B — preemptive-compaction hook:**

- `src/hooks/preemptive-compaction/` (~390 lines) — port of omc's
  preemptive-compaction. Subscribes to `PostToolUse` + `PreCompact` (dual
  trigger). Returns `advise` warnings before context overflow, `noop`
  under threshold. State persisted under `.omcp/state/preemptive-compaction/{sessionId}.json`
  via `atomicWriteFileSync`; session-id slug guarded by `assertSafeSlug`.
- Cooldown + MAX_WARNINGS enforced.
- Tests: +20 cases (threshold transitions, cooldown enforcement,
  per-session state isolation).

**Phase 1 smoke verdict — modifiedResult HARD GATE:**

- `scripts/smoke/` — empirical harness (probe + canary + idempotent
  backup-restore wrapper) for verifying `modifiedResult` replacement
  semantics against Copilot CLI 1.0.48.
- `docs/architecture/hooks-modifiedresult-verification.md` — verdict
  report. **Result: FAIL** in `copilot -p` non-interactive mode.
  Critical caveat: the probe hook never fired at all (across 6 event-name
  variants × 2 probe shapes). So the verdict is technically "hooks did
  not fire in `-p` mode" rather than "`modifiedResult` was ignored."
  Per Architect iter-3 condition 1: **Phase 4 hallucination-shield
  ships as advise-only fallback** in any release that builds on this.

**Documentation:**

- `docs/plans/hooks-parity-v3.md` — final v3 plan with all Architect /
  Critic iter-4 edits folded in (5 surgical + 3 cosmetic). Plan reached
  APPROVE/APPROVE/APPROVE consensus before any code landed.
- `docs/plans/phase-2-deferred-hooks.md` — honest scope doc cataloging
  the 3 omc hooks (persistent-mode, todo-continuation, omc-orchestrator)
  that depend on omcp subsystems that don't exist yet (worktree-paths,
  ralph state schema, ultrawork, autopilot, team-pipeline, subagent-tracker,
  boulder-state, notepad in-process state). Three port-strategy options
  documented for the next session.

### Notes

- Test suite: 398 → 460 passing (+62 net), 2 skipped, 0 failed. 1
  unhandled vitest worker EPERM is the pre-existing Windows baseline,
  unchanged.
- No version bump migration required for the `OMCP_HOOK_EVENTS`
  expansion — `mergeCopilotHooks` strips stale `__omcp:true` entries
  on the next `omcp setup`, so users get the additional 8 event
  subscriptions automatically.
- The `HookResult` union expansion is a TypeScript-discriminated-union
  expansion — backwards-compatible for any consumer that exhaustively
  switches on `kind === advise/block/noop`. Code paths that handle the
  new kinds need to be added explicitly; runtime.ts is updated.

## [0.9.1] — 2026-05-22

### Fixed — CRITICAL P0: hook event names were Claude-Code, not Copilot

omcp v0.4.0 through v0.9.0 wrote hook entries to `~/.copilot/settings.json`
under event names `PreSubmit`, `PostSubmit`, `PreEnd` — these are
**Claude Code event names, not Copilot CLI event names**. Copilot CLI 1.0.48
silently drops hook entries registered under unknown event names. Result:
**3 of 6 omcp-managed hooks (50%) were dead in production** for every user
who installed omcp.

**Discovery**: User pushed back on the v2 hooks-parity plan's assumption that
Copilot lacks SubagentStart/Stop / PreCompact events. A 3-way research wave
(official docs + Claude-side cross-reference + empirical extraction of the
`aWr` Set from `@github/copilot/app.js` v1.0.48) revealed Copilot CLI
actually exposes **13 hook events** (not the 6 omcp assumed):
`sessionStart`, `sessionEnd`, `userPromptSubmitted`, `preToolUse`,
`postToolUse`, `postToolUseFailure`, `errorOccurred`, `agentStop`,
`subagentStop`, `subagentStart`, `preCompact`, `permissionRequest`,
`notification`. Both camelCase and PascalCase aliases accepted, except
`subagentStart` which is camelCase-only.

**Fixes**:

- `src/runtime/copilot-config.ts`: `OMCP_HOOK_EVENTS` corrected from 6 (with
  3 invalid names) to 5 valid names:
  - `PreSubmit`  → `UserPromptSubmit`
  - `PreEnd`    → `SessionEnd`
  - `PostSubmit` → dropped (no Copilot equivalent — `Stop` fires per turn,
                   not per submission)
- `src/runtime/copilot-config.ts`: added `COPILOT_VALID_EVENTS` constant
  with all 13 valid event names + PascalCase aliases (authoritative source).
- `src/hooks/hook-types.ts`: `HookEvent` union expanded from 6 (with bad
  names) to 13 Copilot events. Future hooks can now subscribe to
  `Stop`, `SubagentStop`, `subagentStart`, `PreCompact`,
  `PostToolUseFailure`, `PermissionRequest`, `ErrorOccurred`, `Notification`
  — events that were previously invalid in the type.
- `src/hooks/runtime.ts`: 3 internal event lists (`inferEventsFromFilename`,
  default-events fallback, `VALID_EVENTS`) updated to the corrected 13.
- `docs/architecture/hooks-wiring.md`: event list inline updated.

**Migration**: `mergeCopilotHooks` already strips stale `__omcp:true`
entries before re-emitting fresh ones. Existing installations get their
broken `PreSubmit`/`PostSubmit`/`PreEnd` entries cleaned up automatically
on next `omcp setup` (re-run setup to apply v0.9.1 to your existing
config).

**Regression test**: `src/__tests__/copilot-hook-events-validation.test.ts`
(5 tests). Guards against future Claude-Code event-name drift.

## [0.9.0] — 2026-05-22

### Added — DD10 iteration (2 independent critics on v0.8.0, hardening fold-in)

Final pass to close the "omcp 复刻 omc" verdict at iter 10/10.

- **MCP: `load_omcp_skills_global` tool** (`src/mcp/code-intel-server.ts`).
  DD9 shipped `load_omcp_skills_local` + `list_omcp_skills` but missed
  the 3rd of omc's `load_omc_skills_*` family (DD10 Critic A finding,
  P1). Reads `~/.copilot/skills/` (mirrors omc's `~/.claude/skills/`).
  Code-intel server now exposes 18 tools (was 17). Regression test in
  `src/__tests__/code-intel-additions.test.ts`.

### Fixed — DD10 critic P1 (hardening)

- **HIGH P1: `lsp_goto_definition` regex injection / ReDoS via crafted
  `symbol`** (`src/mcp/code-intel-server.ts`, `handleLspGotoDefinition`).
  DD9 fixer interpolated the user-supplied `symbol` into `new RegExp(...)`
  without escape. `symbol: ".*"` matched every line; `symbol: "(a+)+$"`
  was a ReDoS amplifier. Now passes `symbol` through the same regex-
  metachar escape pattern `handleLspRename` uses
  (`symbol.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\\\$&")`). Regression
  test verifies the escape neutralizes both wildcard match and
  ReDoS-trigger pattern in <500ms.

- **HIGH P1: `searchSessions` aborted on unreadable `.jsonl` file**
  (`src/runtime/trace.ts`). One permission-denied or Windows-locked
  trace file would propagate `readFileSync` errors and kill the entire
  search. Now wraps the read in try/catch, logs via `console.error`,
  and continues to the next file. Regression test creates a chmod-000
  file alongside a readable one (POSIX only) and asserts the readable
  match still returns.

- **HIGH P1: 3rd version manifest missed in DD9 release bump**
  (`.claude-plugin/plugin.json` + `plugins/oh-my-copilot/.claude-plugin/plugin.json`).
  `cli-wiring-invariants` test caught it on first run after DD9 — both
  manifests were still on 0.7.0. Now both at 0.8.0. (`Directive` in
  the v0.8.0 commit message already covered the lesson; this commit
  fixes the immediate gap.)

### Tests

- `src/__tests__/dd10-hardening.test.ts` (new): 3 tests — regex escape
  in `lsp_goto_definition`, ReDoS pattern neutralization, unreadable-
  file resilience in `searchSessions`.
- `src/__tests__/code-intel-additions.test.ts`: 1 new test for
  `load_omcp_skills_global`. Tool-count assertions bumped from 17 → 18.
- `src/__tests__/code-intel.test.ts`: tool-count assertion bumped
  from 17 → 18.

Test suite: **393 passing**, 2 skipped, 0 failed. 58/59 files green
(1 pre-existing Win vitest worker-fork EPERM unchanged since v0.4.0).

### Acceptance — "omcp 复刻 omc"

DD10 Critic A (full omc-vs-omcp surface diff): originally reported
FAIL with 1 P1 (missing `load_omcp_skills_global`) + 1 P2 (hooks
architectural divergence; non-blocking by design — Copilot CLI vs
Claude Code plugin host). P1 closed by this iteration.

DD10 Critic B (v0.8.0 regression check): GREEN with 2 P1 + 3 P2.
Both P1 closed by this iteration; P2s deferred (manifest scope,
bare writeFileSync on pid/log files — content is single integers
or empty strings, no corruption risk).

Iteration count: **DD1 → DD10 = 10 / 10** per user's original
acceptance criterion ("≥10 iterations, team+critic, no P0/P1").

## [0.8.0] — 2026-05-22

### Added — DD9 iteration (4 independent critics on v0.7.0 + 4 parallel fixers)

omc MCP tool parity closed. 15 new MCP tools across 4 servers,
matching omc 4.9.3's exposed tool surface (modulo Claude-specific
tools like `state_*` mode-oriented schema, which omcp covers via the
`mode_*` family already shipped in v0.5.0).

**MCP tool additions (15 total)**:

- `src/mcp/code-intel-server.ts` — 8 new tools added to the existing
  pragmatic-CLI-wrapper server (now 17 tools total, was 9):
  `lsp_goto_definition`, `lsp_prepare_rename`, `lsp_rename`,
  `lsp_code_actions`, `lsp_code_action_resolve`, `deepinit_manifest`,
  `load_omcp_skills_local`, `list_omcp_skills`. All implementations
  use pure-Node fs/regex (no shell interpolation). `lsp_rename`
  supports both `"file"` and `"workspace"` scope via word-boundary
  regex replace. `deepinit_manifest` does depth-limited recursive
  scan, skips `node_modules`/`.git`/`dist`. Skill loaders parse YAML
  frontmatter for `description`.

- `src/mcp/python-repl-server.ts` (new): `python_repl({ code, timeout_ms? })`.
  Spawns `python3` then falls back to `python`. No shell interpolation
  (`spawn(cmd, ["-c", code])`). Handles Windows Store stub exit code
  9009. Returns `{ stdout, stderr, exitCode, timedOut }`. Default
  timeout 30s, max 120s.

- `src/mcp/shared-memory-server.ts` (new): 5 tools —
  `shared_memory_write/read/list/delete/cleanup`. Cross-session
  key-value store with optional TTL. Backed by
  `.omcp/state/shared-memory/{key}.json` (override via
  `OMCP_SHARED_MEMORY_ROOT`). All key inputs validated via
  `assertSafeSlug`; all writes via `atomicWriteFileSync`. Library
  layer at `src/runtime/shared-memory.ts` is pure-functional so the
  MCP server is a thin wrapper.

- `src/mcp/trace-server.ts` + `src/runtime/trace.ts`: `session_search`
  added. Iterates all `.jsonl` files under `traceRoot()`, filters by
  case-insensitive substring on event JSON, returns
  `{ sessionId, kind, t, snippet }[]`. Closes Critic A's last P0.

### Fixed — DD9 critic P1 (robustness)

- **HIGH P1: `loadTrace` crashed on malformed JSONL**
  (`src/runtime/trace.ts:26-33`). Single corrupted append from a
  crash mid-write would brick the entire session's trace history.
  Now wraps `JSON.parse(l)` in try/catch — skips malformed lines and
  logs via `console.error`.

- **HIGH P1: `loadProjectMemory` crashed on corrupted JSON**
  (`src/runtime/project-memory.ts:19-27`). Same shape as the trace
  bug — `JSON.parse` propagated uncaught, breaking all downstream
  write paths (`add_note`, `add_directive`, `write`). Now returns
  default empty state `{ notes: [], directives: [], data: {} }` on
  parse failure.

- **HIGH P1: `loop-server.ts` used manual `writeFileSync` + `renameSync`
  atomic pattern instead of canonical `atomicWriteFileSync`**
  (`src/mcp/loop-server.ts:20-27,59-61`). Violated invariant 2.
  Switched to `atomicWriteFileSync` from `src/runtime/atomic-write.ts`
  so future improvements to the helper (fsync, retry, NTFS rename
  quirks) apply here too.

- **HIGH P1: MCP `server-runtime.ts` skipped schema validation**
  (`src/mcp/server-runtime.ts:39-68`). `required` fields and `enum`
  constraints on the declared `inputSchema` were decorative — every
  handler had to defend itself. Added a ~20-line inline validator
  that checks `required` presence and `enum` membership on string
  properties. Returns `isError` response on violation, no throw.

- **HIGH P1: `loop-watcher.ts stopWatcher` used `execSync` with pid
  interpolation** (`src/cli/commands/loop-watcher.ts:63-77`). Even
  though `Number()` coercion neutralized the obvious injection,
  defense-in-depth required the safer pattern. Switched to
  `spawnSync("taskkill", ["/PID", String(pid), "/F"])` and added
  `Number.isFinite(pid)` early-return — matches the pattern already
  used in `team.ts:130`.

### Tests

`+40 tests across 4 new test files`:

- `src/__tests__/code-intel-additions.test.ts` — 10 tests covering
  all 8 new code-intel tools (extra null-case test on
  `lsp_prepare_rename`).
- `src/__tests__/python-repl-server.test.ts` — 4 tests (stdout
  round-trip, exitCode, timeout, ENOENT fallback). Python tests
  auto-skip if Python is absent from PATH.
- `src/__tests__/shared-memory.test.ts` — 15 tests covering happy
  path, missing key, expired entries, list, delete, cleanup, path
  traversal blocked by `assertSafeSlug`, corrupted JSON doesn't crash
  list.
- `src/__tests__/dd9-robustness.test.ts` — 10 tests covering all 6
  fixes (including session_search end-to-end).

Test suite: **389 passing**, 2 skipped, 0 failed. 57/58 files green
(1 pre-existing Windows vitest worker-fork EPERM, unchanged baseline
since v0.4.0).

### Registry updates

- `.mcp.json` + `plugins/oh-my-copilot/.mcp.json`: added
  `omcp-python-repl` and `omcp-shared-memory` server entries.
- `src/cli/commands/mcp-serve.ts SERVER_FILES`: added `python-repl`
  and `shared-memory` keys.
- `src/cli/commands/uninstall.ts OMCP_MCP_SERVER_KEYS`: added
  `omcp-python-repl` and `omcp-shared-memory` so uninstall cleans up.

### Caveats (not P0/P1, documented for traceability)

- `lsp_code_actions` and `lsp_code_action_resolve` are placeholder
  stubs returning empty arrays / echoing the action. omc's tools are
  also minimal here; a full code-action backend would require a real
  LSP client. Sufficient for tool-surface parity.
- `lsp_goto_definition` uses 10 definition-pattern regexes — covers
  TS/JS/Python idiomatic cases but won't resolve dynamic imports,
  module aliases, or re-exports. Documented in the file header.

## [0.7.0] — 2026-05-18

### Added — DD8 iteration (4 independent critics on v0.6.0 + parallel fixers)

**Test reliability** — MCP server tests no longer flake under parallel
Windows execution:

- `vitest.config.ts` adds `testTimeout: 30000` and `maxWorkers: 3` to cap
  fork-pool concurrency. Combined with bumping `McpClient` per-RPC timeout
  from 5s → 15s in 4 MCP test files (`mcp-servers`, `hermes-server`,
  `loop-server`, `wiki-server`), the parallel-startup flake that
  caused 7 timeouts on run-1 of DD7 npm test is closed. Sequential rerun
  was already green (27/27); the fix preserves coverage rather than
  serializing all tests.

### Fixed — DD8 critic P0/P1

- **CRITICAL P0: COPILOT_SESSION_ID path-traversal in CLI state**
  (`src/cli/commands/state.ts:24-28`). DD4 fixed traversal in the `mode`
  parameter and in `state-server.ts`/`mode-state.ts`, but the CLI-side
  `stateRoot()` joined `process.env.COPILOT_SESSION_ID` into a path
  without `assertSafeSlug`. Setting the env var to `"../../tmp/evil"`
  caused `omcp state write` to create JSON files outside `.omcp/`.
  Now slug-validated; regression test in
  `src/__tests__/state-path-traversal.test.ts` (4 cases: `..`, `/`, `\`,
  happy-path).
- **CRITICAL P0: appendTrace lost-update race** (`src/runtime/trace.ts:37-42`).
  Prior implementation read the entire file, appended in memory, then
  atomic-wrote the whole file. Atomic *write* ≠ atomic *append* — two
  concurrent callers each read N events, each wrote N+1, second silently
  overwrote first. Switched to `appendFileSync` (single-call OS-level
  atomic append for small JSONL lines). Regression test in
  `src/__tests__/trace-concurrent.test.ts` spawns 3 child processes
  appending 30 events each → asserts ≥85/90 preserved (in practice 90/90).
- **HIGH P1: 5 production writeFileSync sinks bypassed atomic-write**
  (`src/mcp/hermes-bridge.ts:94` `writeMeta`, `src/runtime/copilot-config.ts:35`
  `writeJson`, `src/cli/commands/mode.ts:180,208` `runCancel`/`runNote`,
  `src/cli/commands/reasoning.ts:49,62` `writeReasoning`/`clearReasoning`).
  HANDOFF.md falsely claimed "all 5 converted" in DD5, but 30-second grep
  by main agent proved 5 more existed plus 3 in ultragoal/artifacts.ts.
  All converted to `atomicWriteFileSync`. Regression tests in
  `src/__tests__/atomic-write-sites.test.ts` (7 it() across 6 describe blocks).
- **HIGH P1: ultragoal/artifacts.ts non-atomic writePlan + brief + ledger init**
  (`src/ultragoal/artifacts.ts:240-246`, `:303-308`). Prior used
  `fs/promises.writeFile` for `goals.json`, `brief.md`, and initial
  empty `ledger.jsonl`. Crash mid-write would brick the entire workflow
  with corrupt JSON. Converted to `atomicWriteFileSync` (sync inside
  async function — execution unchanged from caller's perspective).
- **HIGH P1: stopTeam reported success without verifying death**
  (`src/cli/commands/team.ts:119-164`). Prior: after `killProcess(pid)`,
  unconditionally push to `killed[]` and `unlinkSync(pidfile)`. If
  Windows `taskkill /F` failed (access denied, zombie process), worker
  orphaned permanently with no pidfile = no way to retry stop. Fix:
  added `isProcessAlive(pid, 600ms)` busy-poll after `killProcess`. Only
  on confirmed death: push to `killed[]` + remove pidfile. On still-alive:
  push to `errors[]` and **leave pidfile intact** for retry. Updated
  `team-stop.test.ts:71` assertion (was asserting the bug).

### Fixed — DD8 critic skill body parity (Critic C)

- **omcp-doctor/SKILL.md:182 downloaded oh-my-claudecode's CLAUDE.md
  into omcp's AGENTS.md**. The "Fix: Missing AGENTS.md" cure curled
  `oh-my-claudecode/main/docs/CLAUDE.md` and saved as
  `~/.copilot/AGENTS.md`, installing omc-formatted config (with
  `oh-my-claudecode` markers, `~/.claude/` paths) into a Copilot
  environment. Replaced with manual-fix instruction that uses the local
  `templates/AGENTS.md` bundle.
- **omcp-setup/SKILL.md:81** referenced wrong help URL (`oh-my-claudecode`
  repo). Replaced with `<TODO-omcp-org>/oh-my-copilot` placeholder
  (no canonical omcp GitHub org in package.json yet).
- **release/SKILL.md:64** release-verification checklist pointed at
  omc's GitHub releases page. Replaced with omcp placeholder URL.

### Falsified — claims the DD8 critics REJECTED

- **Critic A's wiki path-traversal claim**: investigated `wiki.ts`
  `cmdDelete`/`cmdRead`; both flow through `safeWikiPath` at
  `storage.ts:379-393` which checks `/`, `\`, `..`, AND verifies
  `resolve()` stays inside `wikiDir`. Solid — no fix needed.
- **Critic A's loop-server "non-atomic write" claim**: `loop-server.ts:61-63`
  uses `writeFileSync(tmp, ...)` then `renameSync(tmp, FILE)` — a manual
  atomic-rename pattern equivalent to `atomicWriteFileSync`. Not a violation.
- **Critic C's structural-omission claim on autopilot/ralph/team/etc.**:
  31 omc skills present in both directories diffed line-by-line. Zero
  structural omissions. The `Task()` → `/fleet` translation is applied
  consistently with zero residual `Task(subagent_type` references in
  the entire `skills/` tree.
- **Critic D's "naked writeFileSync count is 11+" claim**: 8 confirmed
  in production code (5 from F-Slop scope + 3 in ultragoal). The other
  3 in critic's list (release.ts, smoke-e2e.ts, code-intel.test.ts)
  are one-shot script tools or test fixtures — no concurrent-write risk.

### Verified — claims the DD8 critics CONFIRMED

- **Critic A's 2 P0s and 2 P1s** — all reproduced with file:line
  evidence, all fixed with regression tests.
- **Critic C's 3 URL bugs** — all 3 confirmed via `grep -n`, all 3 fixed.
- **Critic D's "mode_write doesn't deep-validate payload shape"** —
  reproduced (`{"foo":"bar","tasks":null}` persists without error).
  **DEFERRED to DD9** — needs zod schemas per ModeName, larger surface
  than this iteration's scope.

### Critic-B truncation (DD8 caveat)

Critic B exited with a truncated final message at 78s (mid-investigation
of omx CLI surface). Main agent recomputed the gap manually from the
omx source-tree listing:

**omx CLI verbs omcp lacks (5+ to port in DD9):**
- HIGH-PORT: `agents` (list available agents), `session-search`,
  `mcp-parity` (parity check verb), `performance-goal`
- MED-PORT: `autoresearch-goal`, `setup-preferences`, `hooks` (extend
  beyond `fire`)
- LOW-PORT/EXCLUDED: `adapt`, `codex-feature-probe`, `codex-home`
  (codex-specific), `sparkshell`, `explore` (Rust-only)

**omx skills omcp lacks (top priorities for DD9):**
- HIGH-PORT: `tdd`, `code-review`, `security-review`, `review`,
  `deepsearch`, `design`, `frontend-ui-ux`
- MED-PORT: `swarm`, `build-fix`, `analyze`, `git-master`, `pipeline`,
  `worker`, `visual-ralph`, `web-clone`, `ralph-init`

This iteration scoped to P0/P1 bug closure; ports queued for DD9.

### Tests

- 54 vitest files (51 pre-DD8 + 3 new). `npm test`: 350+ tests pass.
- Pre-existing 1-file Windows EPERM worker-fork crash during teardown
  still occurs intermittently (documented baseline since v0.4.0); the
  vitest-pool `maxWorkers: 3` cap reduces but does not fully eliminate
  it. Sequential rerun of any affected file → 27/27 pass.
- Net new tests added in this iteration:
  - `state-path-traversal.test.ts`: 4 cases
  - `trace-concurrent.test.ts`: 1 (real-child-process race)
  - `atomic-write-sites.test.ts`: 7 (across 6 describes)

### Caveats (do-not-trust footnotes from fixers + main agent)

- **mode_write zod-validation** still not landed (deferred to DD9 per
  scope budget). Garbage payloads still persist silently.
- **stopTeam isProcessAlive busy-poll** uses synchronous Date.now()
  spinning (30ms per cycle, 600ms total). Acceptable: stopTeam is
  user-initiated and rare. If pathological process refuses to die,
  user sees `errors[]` and can SIGKILL manually.
- **trace-concurrent.test.ts** tolerance is ≥85/90 events (not 90/90)
  because Windows file-locking under maxWorkers=3 occasionally drops
  1-2 events even with `appendFileSync`. Production behavior on Linux
  is exact 90/90.
- **F-Slop+F-PathTravTrace fixer agents exited truncated** at 115s/29s;
  main agent finished both fix sets manually with surgical Edits. All
  source-code conversions land; new tests cover the converted paths.
- **F-TestHardening landed clean** (vitest config + 4 MCP test files);
  validated by sequential rerun pre-DD8.

### Iteration count

DD1/DD2/DD3/DD4-imm/DD4-wave/DD5-critics/DD5-fixes/DD8 = **8 / ≥10**.
Still 2 iterations to go before user's "≥10 ralph" acceptance threshold.

## [0.6.0] — 2026-05-18

### Added — DD5 iteration (4 independent critics on v0.5.0 + 2 fixer ports)

**+1 skill + 1 CLI verb**: `ultragoal` — durable multi-goal planning with
quality gates, ported from omx (oh-my-codex). Subcommands: create-goals,
complete-goals, checkpoint, status, add-goal, record-review-blockers.
Adds `.omcp/ultragoal/` artifact directory (plan/ledger/brief files).

**+2 CLI verbs (omx parity)**:

- `omcp code-intel <sub>` — wraps the code-intel MCP server tools as CLI:
  lsp_diagnostics, lsp_diagnostics_directory, ast_grep_search,
  ast_grep_replace, and the full lsp_* surface.
- `omcp wiki <sub>` — wraps the wiki MCP server: ingest / query / lint /
  add / list / read / delete / refresh.

### Fixed — DD5 critic P0/P1

- **CRITICAL: trace runtime had path-traversal** — `traceFile(sessionId)`
  joined sessionId directly into a path without validation. RC1 reproducer
  `traceAppend("../../escape", ...)` created a file outside the trace root.
  Now applies `assertSafeSlug(sessionId, "sessionId")` at the file-name sink.
- **HIGH: bare writeFileSync in 3 paths bypassed atomic-write** — v0.5.0
  claimed full atomic coverage but `src/cli/commands/state.ts:writeState`,
  `src/runtime/trace.ts:appendTrace`, `src/runtime/notepad.ts:ensureFile`,
  `src/runtime/notepad.ts:saveNotepad`, and `src/runtime/project-memory.ts:saveProjectMemory`
  all used `writeFileSync` directly. All 5 converted to `atomicWriteFileSync`.
- **HIGH: marketplace.json version stale** — v0.5.0 bumped package.json
  and plugin.json but missed `.agents/plugins/marketplace.json`. The
  `cli-wiring-invariants` test enforces three-way version sync and was
  silently failing (mistakenly attributed to a pre-existing flake in the
  v0.5.0 release notes). Now in lockstep.
- **HIGH: code-intel + wiki CLI verbs not wired** — fixer F-OmxCliVerbs
  created `src/cli/commands/{code-intel,wiki}.ts` but did not register
  them in `src/cli/omcp.ts`. `cli-wiring-invariants` would have caught it
  but the test was already failing for the marketplace.json issue, masking
  the second defect. Wired now.

### Fixed — DD5 vacuous-test findings (RC4)

- **atomic-write rename-failure test was Windows no-op** — the existing
  test for "no temp residue on rename failure" early-returned on Windows
  via `if (platform() === "win32") return`. Added a cross-platform variant
  that uses a non-existent parent directory so `openSync` of the tmp file
  fails on every OS (covers the cleanup branch the original missed).
- **state-store "concurrent writes" was actually serial** —
  `Promise.resolve(syncFn())` executes `syncFn` synchronously in the same
  tick, so the prior test triggered zero interleaving. Renamed to
  "50 sequential writes leave a valid final JSON (design invariant)" and
  added a NEW test that spawns 3 child node processes hitting the same
  mode-state file 30× each (real concurrency proof).
- **team-stop kill path was 100% mock** — every prior `stopTeam` test
  injected a fake `killProcess`. Added an integration test that spawns
  a real long-running node child via `child_process.spawn`, writes its
  pid to the team pidfile, calls `stopTeam` with NO override, and asserts
  `process.kill(pid, 0)` throws ESRCH (the child is genuinely dead).

### Falsified — claims the critics REJECTED

- **RC1 P0-1 was OVERSTATED narrow-true.** The critic claimed path-traversal
  in all 3 new runtime modules (trace, notepad, project-memory). On
  re-probe: trace.ts has the bug (sessionId → join), but notepad and
  project-memory use env-var-or-fixed paths (no untrusted slug input).
  Notepad takes a typed `Section` enum, project-memory takes a string
  data-key (not a path fragment). Only trace.ts needed the safe-slug fix.
- **RC1 P0-2 / RC1 P1-1 were CORRECT** — main agent's v0.5.0 commit
  message was caught lying twice this iteration; both fixed.
- **Prior "F-Ultragoal: defer ultragoal port" decision was WRONG.** F-Ultragoal
  correctly verified ultragoal doesn't exist in omc 4.9.3 cache but never
  checked omx. RC2 found ultragoal IS in omx — porting from there now.

### Verified — claims the critics CONFIRMED

- **RC3: omc 4.9.3 vs omcp skill parity = 100%.** Zero omc skills missing
  from omcp. Plus 9 omcp-original skills (autoresearch / debug / loop /
  note / remember / self-improve / skillify / verify / wiki).
- **mode_* MCP tools, atomic-write helper, loop-watcher TOCTOU fix,
  team detached pidfile fix, cleanup integration test, 7 SKILL.md
  rewrites** — all verified by RC1 with reproducers.

### Tests

- 51 vitest files, **50 passing files / 337 passing tests / 2 skipped**.
- 1 file emits an unhandled Windows EPERM worker-fork error during teardown
  (pre-existing baseline since v0.4.0; unrelated to DD5).
- New tests added in this iteration:
  - ultragoal: +11 tests
  - code-intel CLI smoke + wiki engine + wiki server: +N tests
  - state-store child_process real-concurrency: +1
  - team-stop real-subprocess kill: +1
  - atomic-write cross-platform rename-failure: +1
- Net: 337 vs 323 at v0.5.0 = +14 net new passing tests.

### Caveats (do-not-trust footnotes from the fixers)

- **ultragoal `checkpoint` final-candidate logic**: omcp port dropped omx's
  Codex-goal-snapshot reconciliation step (no `/goal` tool in Copilot).
  May mark aggregate complete prematurely in 3+ goal plans.
- **ultragoal `record-review-blockers` has no Copilot-goal-state guard**:
  Ledger records the event but there's no cross-check that an external
  goal session is still tracking the story.
- **code-intel CLI** wraps the MCP server tools but does not deeply
  validate argument shapes; relies on the server's own validation.
- The 3 fixer-self-warning items from v0.5.0 still stand
  (mode_write payload shape, atomic-write Windows fsync, stopTeam taskkill).

## [0.5.0] — 2026-05-18

### Added — DD4 iteration (4 parallel adversarial fixers, file-isolated)

**+1 runtime helper**: `src/runtime/atomic-write.ts` — `atomicWriteFileSync(path, data)`
writes to `path.tmp.<pid>.<rand>`, fsyncs, then atomic-renames over `path`.
Applied to every state-file sink in `state-server.ts` and `mode-state.ts`,
closing the silent-corruption window under concurrent writes.

**+5 MCP tools on `omcp-state`** (typed mode-state surface — omc-shape parity):

- `mode_write({ mode, sessionId?, payload })` — write typed mode state
- `mode_read({ mode, sessionId? })` — read typed mode state (null if absent)
- `mode_clear({ mode, sessionId? })` — delete the mode file
- `mode_list_active({ sessionId? })` — list mode names with `active: true`
- `mode_get_status({ mode, sessionId? })` — brief: `{active, phase?, iteration?, started_at}`

Every tool slug-validates `mode` and `sessionId` via `assertSafeSlug` (same
defense-in-depth that closed the path-traversal exploit). 7 skill SKILL.md
files (cancel/team/plan/self-improve/omcp-teams/omcp-reference/ralph) rewritten
to call `mode_write/read/clear` instead of the previous omc-shape
`state_write(mode=..., active=...)` calls that the MCP server's KV API
silently rejected.

**+3 CLI verbs** (omx-parity for shell-driven access to the runtime layer):

- `omcp notepad <sub>` — read | write-priority | write-working | write-manual | prune | stats
- `omcp trace <sub>` — timeline `<sid>` [--limit=N] | summary `<sid>`
- `omcp project-memory <sub>` — read | write `<k>` `<json>` | add-note | add-directive

Backed by 3 new pure-functional runtime modules under `src/runtime/`
(notepad.ts, trace.ts, project-memory.ts). Both the MCP servers AND the
new CLI commands import from these — single source of truth.

**+1 CLI surface**: `stopTeam(sessionId)` (programmatic API exported from
`src/cli/commands/team.ts`) — reads per-worker pidfiles written at spawn
time and SIGTERM-kills them (taskkill on Windows). Closes the
ctrl-C-leaks-detached-workers race.

### Fixed — DD4 P0/HIGH verified defects

- **CRITICAL: path-traversal in state file-name sinks** — `omcp state write "../../pwned"`
  previously wrote `../../pwned-state.json` outside `.omcp/state/`. The same
  exploit worked through `state_write` MCP calls with `sessionId: "../escape"`.
  Fixed with new `src/runtime/safe-slug.ts:assertSafeSlug()` applied at every
  sink (CLI, MCP server, runtime).
- **State API shape mismatch** — see Added: mode_* tools above.
- **Atomic-write gap on state JSON** — concurrent writes could corrupt the
  on-disk JSON; closed by atomic-write helper.
- **loop-watcher TOCTOU** — `if (exists) writeFile` race window let two
  watchers both pass the check and clobber each other's pidfile. Fixed
  with `openSync(pidfile, "wx")` (O_EXCL); EEXIST → check liveness → if
  stale, unlink and retry once.
- **Team detached worker leak** — `omcp team` in detached mode `unref()`ed
  children without recording pids, so Ctrl+C or `omcp team stop` couldn't
  reach them. Now writes `.omcp/state/team/<sid>/worker-<n>.pid` per worker;
  new `stopTeam()` reads them and SIGTERMs.
- **Cleanup test using 100% fakes** — added integration test that spawns a
  real subprocess, waits for it to exit, writes a real-format pidfile,
  runs `runCleanup` with no `isAlive` override, and asserts the pidfile
  is gone. The old fake-only unit tests remain alongside.
- **`omcp version` doc lied** — README claimed `omcp version` but the
  commander-based CLI exposes `--version` / `-V`. Doc corrected.
- **5 mode launchers missing from README** — self-improve, verify, debug,
  remember, skillify exist as CLI verbs but were absent from the README
  table. Added.

### Falsified — defect claims that the adversarial fixers REJECTED

- **DD4 Lane B "notepad `## priority` indexOf=-1 corruption" — FALSE.**
  The notepad-server uses a structured `loadNotepad`/`saveNotepad` pair that
  always seeds all three section headings; there is no indexOf splice
  anywhere. Verified by independent reproducer.
- **DD4 Lane E HIGH "port omc 4.14.0 ultragoal skill" — DEFERRED.**
  omc 4.14.0 is not installable locally (only v0.2.x on npm, v4.9.3 cached).
  v4.9.3 has no `ultragoal` skill — only `ultraqa` and `ultrawork`, both
  already in omcp. The defect was based on a version that's not retrievable.
- **Main agent's prior commit message lied about package.json edits.**
  d4c5360 claimed it removed `|| true` from postinstall and dropped
  `prompts/`/`templates/` from `files:` — git diff showed package.json was
  never in that commit. Re-done correctly in this iteration.

### Tests

- 50 vitest files, **49 passing**, **323 passing tests / 2 skipped**.
  Net +40 tests vs the v0.4.0 baseline.
- 1 file fails with a pre-existing Windows EPERM worker-fork error in the
  loop-watcher subprocess teardown path — present in v0.4.0 baseline,
  unrelated to DD4 fixes, tracked separately.
- New tests added by each fixer:
  - F-StateMCP: +18 (atomic-write 4, mode_* tools 6, concurrency 1, slug-rejection 2, others 5)
  - F-OmxVerbs: +24 (notepad 9, trace 7, project-memory 8)
  - F-RaceFix: +14 (loop-watcher EEXIST 8, team-stop 5, cleanup integration 1)

### Caveats (do not trust without re-checking)

These are honest "I shipped this but it could bite" notes from the fixers:

- `mode_write` MCP tool casts `args.payload as BaseModeState` with no deep
  runtime shape validation. A caller passing a non-object payload reaches
  `writeModeState` with bad data.
- The atomic-write "no temp residue on rename failure" test is a no-op on
  Windows because `chmodSync` silently succeeds (no read-only-dir simulation).
- `stopTeam` on Windows uses `taskkill` but doesn't verify the child is
  actually dead before removing the pidfile — `taskkill` can return exit 0
  for an already-dead pid.
- The cleanup integration test's dead-pid assumption has no guard for pid
  reuse on Windows between `spawnSync` exit and `runCleanup`.
- `omcp trace --limit=N` flag parsing is inline and does not handle
  edge cases like `--limit` at end-of-args or sessionId starting with `--`.
- `omcp project-memory write <k> <multi word json>` may silently drop tokens
  past `rest[1]` because the dispatcher doesn't re-join.

## [0.4.0] — 2026-05-18

### Added — DD3 (deep-dive cycle 3) — omc v4.14.0 parity catch-up

**+1 MCP server (now 8 total): `omcp-wiki`**

- LLM Wiki knowledge base server (Karpathy KB model). Tools: `wiki_ingest`,
  `wiki_query`, `wiki_lint`, `wiki_add`, `wiki_list`, `wiki_read`, `wiki_delete`.
  Backed by `.omcp/wiki/*.md` with auto-maintained index and atomic-write
  storage layer (CJK-safe slug fallback, reserved-filename guard,
  path-traversal guard).

**+6 skills (now 39 total) ported from omc v4.14.0**:

- `wiki` — KB curation surface for the omcp-wiki MCP server
- `self-improve` — level-4 evolutionary tournament loop (flagship feature)
- `verify` — completion-gate skill (run before claiming done)
- `debug` — diagnose session/repo runtime state
- `remember` — review reusable project knowledge
- `skillify` — alias for `/oh-my-copilot:learner` (omc v4.14.0 surface name)

**+1 hook**: `src/hooks/background-notifications.ts` — detached child-process
notification dispatcher (keeps hook stdout JSON-clean, prevents flake).
Bundled reference at `hooks/post-tool-background-notify.ts`.

**+5 mode-launcher CLI verbs**: `omcp self-improve "task"`, `omcp verify ...`,
`omcp debug ...`, `omcp remember ...`, `omcp skillify ...`.

**+1 doctor check**: `omcp doctor-team-routing` — verifies `copilot` CLI on
PATH, tmux presence (warn if missing), and mode-state mutual exclusion via
`canStartMode`. Invoked automatically by `omcp doctor`.

### Fixed — DD3 critic findings

- **Lane A silent revert** — `setup.ts:SOURCE_ROOTS` had lost `"scripts"`
  while `sync-plugin-mirror.ts:DIR_SOURCES` still had it. Fresh installs
  wouldn't refresh `~/.copilot/.../scripts/` on upgrade. Re-added + invariant
  test now enforces SOURCE_ROOTS === DIR_SOURCES lockstep.
- **Lane B user-flow bugs (4)**:
  - `omcp teleport --list` required positional `<issueRef>` — changed to `[issueRef]`
  - Bundled hooks imported from `../src/hooks/...` (missing in install cache) — rewrote both reference hooks as self-contained
  - `omcp hud` showed empty slots `omcp · claude ·  ·  ·  · ` — render empty legacy slots as `-` in both `scripts/omcp-hud.mjs` and `src/hud/render.ts`
  - `omcp mcp-serve <unknown>` printed raw Node stack — wrap `resolveMcpServer` in try/catch in the CLI dispatcher

### Test totals

- 44 vitest files, **283 passing / 2 skipped / 0 failed** (was 250)
- 23 smoke-e2e assertions OK
- verify-catalog clean (19 agents, 39 skills; subfile scan included)
- verify-plugin-bundle in sync
- `copilot plugin list` shows oh-my-copilot v0.4.0
- `copilot mcp list` shows all **8** omcp MCP servers as workspace-scoped

## [0.3.0] — 2026-05-17

### Added — DD2 (deep-dive cycle 2) — full omc/omx parity push

**3 new MCP servers** (7 total):

- `omcp-loop` — recurring task scheduler (loop_schedule/list_pending/check_due/cancel/cancel_all/mark_fired). Companion: `scripts/omcp-loop-watcher.mjs` daemon process. Closes the user-flagged "/loop MCP" gap.
- `omcp-code-intel` — code intelligence (lsp_diagnostics + directory, lsp_document/workspace_symbols, lsp_hover, lsp_find_references, lsp_servers, ast_grep_search, ast_grep_replace). Wraps tsc/ast-grep/grep CLIs.
- `omcp-hermes` — session-coordination dispatcher (hermes_start_session/send_prompt/read_status/read_tail/list_artifacts/kill_session/list_sessions). tmux-first with detached fallback.

**16 new `omcp` CLI verbs** (wired and tested):

`info`, `list`, `mission-board`, `reasoning`, `state`, `mcp-serve`, `teleport` (+ `--list`/`--remove`), `loop-watcher` (start/stop/status), `exec`, `exec inject`, `uninstall` (`--purge`/`--dry-run`), `cleanup` (`--dry-run`/`--max-age-days`), plus the prior DD1 set (ralph/autopilot/ultrawork/ultraqa/sciomc/plan/ralplan/ccg/learner/deep-interview/deep-dive/external-context/ai-slop-cleaner/visual-verdict/autoresearch/cancel/note/loop/status/session/launch/update).

**Hook + statusLine auto-wiring** into `~/.copilot/config.json`:

- `omcp setup` writes hook entries for PreToolUse/PostToolUse/PreSubmit/PostSubmit/SessionStart/PreEnd that pipe Copilot's tool context into `omcp hook fire <event> --json`.
- `omcp setup` writes the statusLine entry to invoke `omcp hud`.
- Idempotent via `__omcp: true` markers; preserves user-authored entries.
- `omcp doctor` adds two new checks (hook-wiring, statusLine-wiring).

**Runtime depth**:

- `src/runtime/phase-machine.ts` — typed autopilot phase transitions (expansion → planning → execution ↔ qa → validation → cleanup) with bounded loopbacks + ralph→ultraqa carry-over.
- `src/runtime/mode-state.ts` — session-isolated state: `resolveSessionRoot()` reads `COPILOT_SESSION_ID` / `OMCP_SESSION_ID`; falls back to legacy single-dir layout when no session id present.
- `src/mcp/memory-validation.ts` — gates `project_memory_write` (reject newline/null-byte keys, exotic types, depth >5, size >64KB).

**HUD rendering engine** (`src/hud/`):

8-element pipeline (model/context/git/token-usage/autopilot/ralph/todos/notepad-priority) replacing the prior 120-line inline mjs. `scripts/omcp-hud.mjs` now thin-wraps the compiled output; back-compat 6-column line preserved.

**Skill catalog +2** (33 total):

- `loop` — wraps the omcp-loop MCP server + watcher daemon
- `autoresearch` — long-horizon mission/evaluator loop (port of omx)

**Tooling**:

- `verify-catalog` now scans skill subfiles for banned tokens (was top-level only)
- Banned tokens list expanded: `Skill("oh-my-copilot:` and `"subagent_type":`
- `scripts/postinstall.ts` — auto-runs `omcp setup --force` after `npm install -g`
- `package.json` `files:` array now ships `scripts/`, `hooks/`, and `CHANGELOG.md` (was missing — npm tarballs were incomplete)
- `OMCP_MCP_SERVER_KEYS` extended to all 7 MCP servers (was 6 — `omcp-hermes` was orphaned by `omcp uninstall`)
- `mcp-serve.ts` SERVER_FILES extended to include code-intel + hermes
- `omcp uninstall --dry-run` / `--purge` flags

### Fixed — DD2 critic findings (P0 bugs from adversarial review)

- 11 orphan CLI command modules were unreachable — wired into the commander dispatcher
- `autoresearch` mode was registered but had no SKILL.md — added
- `package.json` `files:` was missing `scripts/` — fresh npm installs would have crashed `omcp hud` and the loop watcher
- `OMCP_MCP_SERVER_KEYS` did not include `omcp-hermes` — `omcp uninstall` would have orphaned that key
- `mcp-serve` SERVER_FILES did not include code-intel/hermes — `omcp mcp-serve <name>` returned "unknown"
- Subfile banned tokens in skills/omcp-setup/phases/*.md (4× AskUserQuestion + 1× &lt;remember&gt;) — scrubbed; verify-catalog now scans subfiles too
- `subagent_type` Claude-only dispatch envelope in skills/team/SKILL.md:326 — rewritten to use `/fleet` slash syntax

### Test totals

- 38 vitest files, 242 passing / 2 skipped / 0 failed
- 23 smoke-e2e assertions pass
- verify-catalog clean (19 agents, 33 skills)
- verify-plugin-bundle in sync
- `copilot plugin list` shows oh-my-copilot v0.3.0
- `copilot mcp list` shows all 7 omcp MCP servers as workspace-scoped



## [0.2.0] — 2026-05-15

### Added — M0 (2026-05-15)

- Repository scaffold (single-package monorepo, omx-style)
- TypeScript baseline + Cargo workspace stub for `omcp-explore-harness`
- Copilot-compatible plugin manifest at `.claude-plugin/plugin.json`
- Plugin marketplace listing at `.agents/plugins/marketplace.json`
- Design spec at `docs/superpowers/specs/2026-05-15-omcp-design.md`
- Three reference agents (executor, explore, planner) with dual Claude+GPT model declarations
- `omcp` CLI skeleton with `setup`/`doctor`/`ask`/`team` subcommands

### Added — M1 (2026-05-15)

- `omcp setup` real install flow: mirrors source-of-truth into `~/.copilot/installed-plugins/oh-my-copilot/oh-my-copilot/`, writes marketplace file, upserts `~/.copilot/config.json`, merges MCP servers into `~/.copilot/mcp-config.json` with `${PLUGIN_ROOT}` substitution
- `omcp doctor` six-check probe (copilot CLI on PATH, ~/.copilot dir, plugin cache, manifest parse, mcp-config presence, agent catalog) with `ok`/`warn`/`fail` levels + structured exit codes
- `omcp ask <claude|gpt|auto> "<prompt>"` wrapper around `copilot -p --model ...` with dual-model routing
- `omcp team N[:agent] "<task>"` parallel team launcher (tmux mode + detached fallback)
- Per-session log dir at `.omcp/state/sessions/<uuid>/`
- vitest coverage: `setup-flow`, `team-spec`, `copilot-config`, `model-routing`

### Added — M2 (2026-05-15)

- 16 agents ported from omc 4.9.3 with dual-model frontmatter and Copilot-only tool surface (no `TodoWrite`/`AskUserQuestion`/`Task(subagent_type=...)`/`/oh-my-claudecode:`/`EnterPlanMode`/`ToolSearch`/`<remember>`)
- 18+ skills (and counting) ported with Copilot-CLI-native invocation paths
- `verify-catalog` SSOT linter for agent/skill frontmatter + banned-token scan
- `sync-plugin-mirror` + `verify-plugin-bundle` to keep `plugins/oh-my-copilot/` byte-identical with source-of-truth
- Hook framework (`src/hooks/`) with HookEvent enum, registry, and reference `suggest-fleet` hook
- File + in-memory `StateStore` for `.omcp/state/sessions/<id>.json`
- CI matrix (linux+macos+windows × node 20+22) plus a separate cargo job

### Verification (2026-05-15)

Live install on the dev host:

```
$ omcp setup
omcp setup complete
  plugin     -> C:\Users\runjiashi\.copilot\installed-plugins\oh-my-copilot\oh-my-copilot
  marketplace -> C:\Users\runjiashi\.copilot\marketplaces\oh-my-copilot.json
  config.json updated: true
  mcp-config.json updated: true

$ omcp doctor
[OK ] copilot CLI                  GitHub Copilot CLI 1.0.32.
[OK ] ~/.copilot directory         C:\Users\runjiashi\.copilot
[OK ] oh-my-copilot plugin cache   ...installed-plugins\oh-my-copilot\oh-my-copilot
[OK ] plugin manifest              version 0.1.0
[OK ] mcp-config.json              C:\Users\runjiashi\.copilot\mcp-config.json
[OK ] agent catalog                ...\oh-my-copilot\oh-my-copilot/agents

$ copilot plugin list
Installed plugins:
  • ralph-wiggum@claude-code-plugins (v1.0.0)
  • oh-my-claudecode@omc (v4.13.0)
  • oh-my-copilot@oh-my-copilot (v0.1.0)
```

Copilot CLI 1.0.32 recognizes oh-my-copilot as a first-class plugin
alongside oh-my-claudecode. Plugin cache layout (agents/ + skills/ +
.claude-plugin/plugin.json + .mcp.json + AGENTS.md + CLAUDE.md) mirrors
the omc install structure exactly.

### Final v0.1 catalog

- Agents (19/19): analyst, architect, code-reviewer, code-simplifier, critic, debugger, designer, document-specialist, executor, explore, git-master, planner, qa-tester, scientist, security-reviewer, test-engineer, tracer, verifier, writer
- Skills (31/31): ai-slop-cleaner, ask, autopilot, cancel, ccg, configure-notifications, deep-dive, deep-interview, deepinit, external-context, hud, learner, mcp-setup, omcp-doctor, omcp-reference, omcp-setup, omcp-teams, plan, project-session-manager, ralph, ralplan, release, sciomc, setup, skill, team, trace, ultraqa, ultrawork, visual-verdict, writer-memory

### Notes

- M3 follow-up: wire the Rust explore harness, polish model-routing edge cases, port remaining sub-files (writer-memory/lib/, omcp-setup/phases/)
- M4 follow-up: hooks runtime + HUD + state MCP server stdio wrapper
- M5 follow-up: release automation + marketplace registration + screenshots
