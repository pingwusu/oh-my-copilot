# omcp 续接 handoff

**Updated**: 2026-05-24 early-morning (v1.0.0 cut — orchestrator-v1 verified end-to-end against real Copilot CLI)
**Repo**: `C:\Users\runjiashi\oh-my-copilot-r2` (the **r2**, not the parallel `oh-my-copilot/`)
**Latest commit**: see `git log -1` — Phase Z release commit
**Version**: **v1.0.0** (first stable release; cut this session as Phase Z deliverable)
**Tests**: 979 passing, 0 failed, 2 skipped, 1 pre-existing Windows vitest worker-fork EPERM at file level (unchanged baseline since v0.4.0)
**Build**: `npm run build` clean (tsc no diagnostics)

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
