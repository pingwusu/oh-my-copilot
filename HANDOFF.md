# omcp 续接 handoff

**Updated**: 2026-05-23 late-evening (orchestrator-v1 fully shipped, code-complete; end-to-end runtime verification deferred to next session)
**Repo**: `C:\Users\runjiashi\oh-my-copilot-r2` (the **r2**, not the parallel `oh-my-copilot/`)
**Latest commit**: `3d2ed79`
**Version**: v0.13.0 (released this session as Phase 2 deliverable)
**Tests**: 916 passing, 0 failed, 2 skipped, 1 pre-existing Windows vitest worker-fork EPERM at file level (unchanged baseline since v0.4.0)
**Build**: `npm run build` clean (tsc no diagnostics)

---

## TL;DR

orchestrator-v1 plan (5 phases) is **code-complete and committed**. The plan is at `docs/plans/orchestrator-v1-ralplan.md` (consensus-approved through 4 ralplan iterations at commit `b66792f`). All phases (1, 1.5, 2, 3, 4, 5) shipped this session.

**What this means in practice:** every layer of the orchestrator is in place — state libs, CLI surface, hook ports, state-machine wiring, verification protocol. Unit + integration tests cover the logic.

**What is NOT yet verified:** a real Copilot TUI session has not been driven end-to-end to confirm hooks actually fire, the persistent-mode loop actually iterates, and the team-shard-merge actually reconciles concurrent worker output. The next session's primary job is exactly this **runtime smoke**.

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
