# omcp 续接 handoff (post-v0.13.0 Phase 4 — orchestrator-v1 complete)

**Updated**: 2026-05-23 late-evening (Phase 4+5 complete; orchestrator-v1 fully shipped — phases 1, 1.5, 2, 3, 4, 5)
**Repo**: `C:\Users\runjiashi\oh-my-copilot-r2` (the **r2**, not the parallel `oh-my-copilot/`)
**Latest commit**: `fca6546` test(e2e): ralph loop PRD lifecycle integration test (Phase 4.T4)

---

## 2026-05-23 late-evening — Phase 4+5 complete; orchestrator-v1 fully shipped

Phase 4 wired the critic-verify loop into the persistent-mode hook: `detectArchitectApproval`,
`incrementRalphIteration` on every Stop, PRD `allComplete` → `noop` exit, and a full e2e
integration test driving a 2-story PRD lifecycle. Phase 5 codified the team+critic verification
protocol. All tasks T1–T4 + T5 are closed.

### Phase 4 deliverables

| Task | Status | Commit | Description |
|---|---|---|---|
| T1 — detectArchitectApproval wiring | ✓ | `b026438` | Scans Stop context text for `<architect-approved>VERIFIED_COMPLETE</architect-approved>`; clears ralph-state + returns COMPLETE advise on match |
| T2 — incrementRalphIteration on Stop | ✓ | `e612847` | Hook calls `incrementRalphIteration(worktreeRoot)` before each advise; 3 new tests confirm counter advances |
| T3 — PRD allComplete → noop exit | ✓ | `4924fb8` | `getPrdCompletionStatus().allComplete` → `noop` + clear state; architectApproved path also returns noop |
| T4 — e2e ralph loop test | ✓ | `fca6546` | `src/__tests__/ralph-loop-e2e.test.ts`; 3 scenarios: 2-story lifecycle, early exit when complete, architect approval short-circuit |

### Phase 5 deliverable

| Task | Status | Commit | Description |
|---|---|---|---|
| T5 — team+critic verification protocol | ✓ | `1a4dc3a` | `docs/workflows/team-critic-verification.md`; 5-step protocol, pass condition, iterate/reject loop; 13 tests |

**Tests: 889 (Phase 3 close) → 916 passing** (+27 net), 2 skipped, 0 failed.
1 pre-existing Windows vitest worker-fork crash (unchanged since v0.4.0).
tsc --noEmit: clean.

### orchestrator-v1 closure summary

The orchestrator-v1 plan (phases 1 → 1.5 → 2 → 3 → 4 → 5) is now fully shipped:

| Phase | Commits | Key feature |
|---|---|---|
| Phase 1 | `4fb8cd1`, `6a2606e` | OMCP_HOOK_EVENTS 5→13; HookResult 3→6 variants; smoke verdict |
| Phase 1.5 | `2dcf27d` | persistent-mode hook ported from omc (Stop event) |
| Phase 2 | `7b00ada`, `b7a423b` | factcheck + sentinel-gate libs; preemptive-compaction hook |
| Phase 3 | `2feb588`, `f8521bc`, `4a4b7bb` | ralph state-machine wiring; ralplan→boulder; team-shard-merge; invariants.md |
| Phase 4 | `b026438`, `e612847`, `4924fb8`, `fca6546` | critic-verify loop: approval detection, iteration counter, allComplete exit, e2e test |
| Phase 5 | `1a4dc3a` | team+critic verification protocol doc |

### What the next session should do

1. **Read this HANDOFF.md + `docs/workflows/team-critic-verification.md`** — the protocol that governs all future phase closures.
2. **`git log -10` + `npm test`** to verify state: 916 passing, tsc clean, HEAD = `fca6546`.
3. **Re-probe hooks** when Copilot CLI ships 1.0.53+ using `scripts/smoke/wire-probe-for-tui.mjs wire / exercise / check / unwire`.
4. **Phase 3 follow-ups** (optional carry-over from Critic iter-1):
   - `src/__tests__/cli-wiring-invariants.test.ts:155` — check all 4 manifests (currently checks 3)
   - `src/cli/commands/session.ts:32` — retrofit `escapeRegExp` for the unescaped `new RegExp(query)`
5. **Next major work**: Phase 6 (error-aggregator + auto-recovery-advisor — already shipped in v0.11.0, no action) or Phase 7 (modifiedArgs surgeon mode — needs TUI smoke PASS gate first).

---

## 2026-05-23 Phase 3 — Ralph state-machine + ralplan→boulder + team shard-merge

Phase 3 shipped as patch work behind v0.13.0 (no version bump — all CLI surface is additive).

### Phase 3 deliverables

| Task | Status | Commit | Description |
|---|---|---|---|
| T1 — ralph state-machine wiring | ✓ | `2feb588` | `runMode` writes ralph-state before spawn, clears after; `--prd` option added to `omcp ralph`; 10 tests |
| T2 — ralplan→boulder integration | ✓ | `2feb588`+`f8521bc` | `src/ralplan/index.ts` `registerRalplan()`; boulder state wired; 22+17=39 tests |
| T3 — team shard-merge | ✓ | `f8521bc` | `src/lib/team-shard-state.ts`; `runTeamMergeShards` export; 10 tests |
| T4 — invariants.md + writeFileSync carve-outs | ✓ | `4a4b7bb` | `docs/architecture/invariants.md`; CLAUDE.md link added |

**Tests: 742 (v0.13.0 baseline) → 889 passing** (+147 net), 2 skipped, 0 failed.
1 pre-existing Windows vitest worker-fork crash at file level (unchanged since v0.4.0).
tsc --noEmit: clean.

### Phase 5 — Verification protocol (recurring)

The 5-step team+critic verification protocol is codified at:

- **`docs/workflows/team-critic-verification.md`** — protocol steps, pass condition, iterate/reject loop, Phase 1.5 A/B/C closure examples, and `omcp verify <phase-id>` CLI verb placeholder.
- Test: `src/__tests__/team-critic-verification-doc.test.ts` (13 tests — doc exists + 5 heading checks + content checks).

The protocol runs after every phase: executor diff → fresh architect → fresh critic → both APPROVE = pass; ITERATE loops up to 5; REJECT after 5 = escalate.

---

### Phase 4 — COMPLETE (see top-of-file Phase 4 section)

---

## 2026-05-23 mid-day — Retraction: the probe verdict was a wrong-cause attribution

**The "Copilot CLI 1.0.52-4 still has the upstream `SyntaxError: Unexpected token ':'` hook
executor bug" claim from the v0.12.0 session section below is INCORRECT.** Subsequent user
investigation produced a definitive root-cause trace that supersedes that framing:

### Actual root cause (user-supplied trace, locally reproduced)

1. Copilot CLI 1.0.52-4 on Windows dispatches hooks via `pwsh.exe -nop -nol -c <hook command>`
   and pipes the hook event JSON to that process's stdin. **This is the correct, normal design.**
2. The OMC plugin's hook command at `omc/hooks/hooks.json:8` is **Bash-style**:
   ```
   node "$CLAUDE_PLUGIN_ROOT"/scripts/run.cjs "$CLAUDE_PLUGIN_ROOT"/scripts/keyword-detector.mjs
   ```
3. In PowerShell 7, `"$CLAUDE_PLUGIN_ROOT"/scripts/run.cjs` does NOT concatenate the
   variable with the path suffix the way Bash does. When the variable is undefined the
   argv passed to `node.exe` becomes
   `["node.exe", "", "/scripts/run.cjs", "", "/scripts/keyword-detector.mjs"]` — empty
   string between every undefined `$CLAUDE_PLUGIN_ROOT` and the path suffix.
4. When Node receives an empty string as its first positional script path, it falls back
   to executing source from stdin. Copilot's hook event JSON arriving on stdin is then
   parsed as JavaScript, producing the documented `SyntaxError: Unexpected token ':'` at
   `{"hook_event_name":...}`'s first colon.
5. Replacing the command with the PowerShell-correct form (using `$env:CLAUDE_PLUGIN_ROOT`
   inside a single double-quoted string, or with absolute paths) makes Node receive the
   hook JSON as `argv[1]` (the proper script-path slot becomes a real file), and the
   probe's expected `{"continue":true,"suppressOutput":true}` flows back. **The probe was
   identified-by-user as reproducible both ways.**

### What this means for v0.12.0

| Claim in v0.12.0 docs | Corrected understanding |
|---|---|
| "Upstream Copilot bug — unchanged in 1.0.52-4" | OMC/omcp hook command template bug — cross-platform fix is OUR responsibility |
| "Phase 2 Batch C N+2 remains BLOCKED-UPSTREAM" | N+2 is blocked on omc/omcp shipping a Windows/PowerShell-safe hook command template — NOT on a Copilot upstream fix |
| "Re-test trigger: user upgrades Copilot CLI past 1.0.52-4" | Re-test trigger: omc/omcp ships absolute-path or PowerShell-form hook commands |

### What v0.12.0 still got right

- Branch B (4 `omcp state` sub-actions on top of N+1 lib subsystems) is independent
  of the hook firing path. The CLI verbs work without hooks. **The v0.12.0 commits remain
  valid as shipped.**
- The probe procedure itself (wire / exercise / check / unwire) is correct and useful;
  it would have caught a corrected hook command working if the corrected command had
  been wired during the probe pass.

### Implications for next session

- **Hook command template fix** is now actionable in omc and/or omcp without waiting
  for Copilot.
- N+2 hook ports (`persistent-mode`, `todo-continuation`, `omc-orchestrator`) are
  unblocked **once the hook command template fix lands**.
- The user's broader directive (2026-05-23 mid-day) is to **make omcp the orchestrator**
  with ralph/ralplan/team as core long-running features, verified via team+critic in
  independent context, looping until implemented.

---

## 2026-05-23 v0.12.0 session — Branch B of next-session-ralplan landed

This session ran the **consensus-approved plan at `docs/plans/next-session-ralplan.md`**
end-to-end via `/oh-my-claudecode:ralph 串行`. The plan was a probe-then-fork
decision tree: Step 1a `copilot --version` ⇒ if 1.0.51 skip probe, else run
probe. Copilot CLI is now **1.0.52-4**, so the probe ran.

**Probe re-verdict on Copilot CLI 1.0.52-4: NO_FIRE (same upstream bug).**

The probe wired postToolUse/PostToolUse/preToolUse/PreToolUse hooks into
`~/.copilot/settings.json` and exercised the binary via `copilot -p` with
`--allow-all-tools` against a Read of `package.json`. The probe log
(`~/.copilot/omcp-debug-probe.log`) was never written. Inspection of the
session's Copilot process log
(`~/.copilot/logs/process-1779503460304-29240.log`) shows the same crash
documented for 1.0.51:

```
[ERROR] Hook execution failed: HookExitCodeError: Hook command failed with code 1
{"hook_event_name":"UserPromptSubmit", …}
SyntaxError: Unexpected token ':'
    at makeContextifyScript / compileScript / evalTypeScript / eval_stdin
```

Confirmed-affected events: `UserPromptSubmit`, `SessionStart`, `PostToolUse`.
The upstream `node --input-type=ts -` JSON-as-TS bug is unchanged in 1.0.52-4.
The probe was unwired cleanly afterward (no stale hook entries left in
`~/.copilot/settings.json`).

**Decision:** Branch B (CLI verbs) was executed. Phase 2 Batch C N+2 (the 3
deferred hook ports) **remains BLOCKED-UPSTREAM**. **Re-test trigger:** user
upgrades Copilot CLI past 1.0.52-4.

### v0.12.0 deliverables (this session, 9 commits past `e014e35`)

| Story | Status | Commit |
|---|---|---|
| US-001 probe gate | NO_FIRE verdict recorded in `.omc/progress.txt` | (no commit — diagnostic only) |
| US-B0 `escapeRegExp` runtime util + 5 tests | ✓ | `cfb8d96` |
| US-B1 `omcp state ralph` action + 11 tests | ✓ | `90d2f52` |
| US-B2 `omcp state ultrawork` action + 7 tests | ✓ | `f28be2a` |
| US-B3 `omcp state todo` action + 12 tests (incl. regex-escape proof) | ✓ | `7dd7f03` |
| US-B4 `omcp state boulder` action + 8 tests | ✓ | `e9e8169` |
| Test stability — EPERM-tolerant teardown in `doctor-team-routing.test.ts` | ✓ | `68fb5ea` |
| US-B5 v0.12.0 release — 4 manifests + CHANGELOG | ✓ | `a5af910` |
| US-B6 this HANDOFF refresh | ✓ | (this commit) |

Tests: **699 → 742 passing** (+43 net), 0 failed, 2 skipped, 1 pre-existing
Windows worker-fork EPERM at the file level (hardened against cascading into
test-level failures in `68fb5ea`).

### What the four new state sub-actions look like

All nested under the existing `omcp state` Commander command (NOT new
top-level verbs — `omcp ralph` and `omcp ultrawork` are already mode
launchers via `MODE_COMMANDS` at `src/cli/omcp.ts:64-85`). Each sub-action
delegates to the corresponding N+1 lib module for read/write semantics:

```
omcp state ralph     status | start <task> | iterate | clear
omcp state ultrawork status | start <prompt> | clear
omcp state todo      add <title> | update <id> <status> |
                     list [--filter <pattern>] | clear
omcp state boulder   status | list-plans | clear
```

The `--filter` flag on `omcp state todo list` passes through
`src/runtime/escape-regexp.ts` (US-B0) before `new RegExp(...)`, so a `.`
in the filter matches a literal dot — verified by test
`list --filter treats the pattern literally`.

### Updated "what the next session should do"

The section below this one (originally written 2026-05-22) talks about
the Option A N+1/N+2 split. **N+1 is complete (last session) and N+2 is
still blocked.** The next-session priorities are now:

1. **Re-read `docs/plans/next-session-ralplan.md`** — that's the
   consensus-approved plan that drove this session's Branch B work.
   Any further evolution should run through a new ralplan iteration.
2. **`git status` + `git log -15`** to verify state — `e014e35` was the
   start-of-session HEAD, `a5af910` is the end-of-session HEAD (or `HEAD~`
   if this HANDOFF refresh shipped after).
3. **Re-probe** when Copilot CLI ships 1.0.53+ — the same
   `scripts/smoke/wire-probe-for-tui.mjs wire / -p exercise / check / unwire`
   flow works non-interactively (see this session's process log entries
   above for the `copilot -p` invocation that exercised it).
4. **If probe returns FIRE**, re-execute Branch A of the same plan: port
   `persistent-mode`, `todo-continuation`, `omc-orchestrator` from omc.
   The N+1 lib subsystems they depend on are all in place.
5. **Optional follow-ups carried over from Critic iter-1 minor findings:**
   - Update `src/__tests__/cli-wiring-invariants.test.ts:155` to check
     all 4 manifests (currently checks 3).
   - Retrofit `src/cli/commands/session.ts:32` with `escapeRegExp` —
     the pre-existing unescaped `new RegExp(query)`.
   - Consider proper Commander subcommand nesting for `omcp state`
     (current implementation is a switch on a positional `<action>`).
6. **Phase 4 re-evaluation** — the original Phase 1 verdict that drove the
   "advise-only" downgrade has been superseded twice now (this session +
   the 2026-05-23 morning re-verdict). The downgrade still stands because
   it depends on hook firing, but a future Phase 4 sprint should redesign
   around modifiedResult-bearing hooks only once the upstream bug clears.

---

---

## TL;DR for the next agent

This session executed the **ralplan iter-3 → iter-4 consensus loop** to APPROVE/APPROVE/APPROVE,
then shipped **Phase 1 + Phase 2 (partial) + Phase 5 + Phase 6** of the v3 hooks-parity plan
across two releases: **v0.10.0** (Phase 1 + Phase 2 A/B + smoke verdict) and **v0.11.0**
(Phase 5 + Phase 6 + Option A decision recorded).

Tests: 398 (v0.9.1) → **532 passing** (+134 net). 10 commits this session.

| Phase | Status | Deliverable | Commit |
|---|---|---|---|
| v3 plan iter-4 | ✓ committed | Architect 3 conditions + Critic 5 edits + 3 cosmetic polish items folded into `docs/plans/hooks-parity-v3.md` | dae5016 |
| Phase 1 foundation | ✓ committed | OMCP_HOOK_EVENTS 5→13, HookResult 3→6, runtime plumbing, +17 tests | 4fb8cd1 |
| Phase 2 Batch A | ✓ committed | factcheck library + sentinel-gate library + tests (+25) | 7b00ada |
| Phase 2 Batch B | ✓ committed | preemptive-compaction hook + tests (+20) | b7a423b |
| Phase 1 smoke verdict | ✓ committed | FAIL (with caveat — hooks don't fire in `-p` mode); harness + verdict doc | 6a2606e |
| v0.10.0 release | ✓ committed | version bump 4 manifests + CHANGELOG | (this commit) |
| Phase 5 | ✓ committed | interrupt-only cost-governor + loop-detector + audit-logger (+37 tests) | 4883e96 |
| Phase 6 | ✓ committed | error-aggregator + auto-recovery-advisor + notification-dispatcher + idle-alert (+32 tests) | ad6a8f1 |
| v0.11.0 release | ✓ committed | 4 manifests + CHANGELOG + this HANDOFF | (this commit) |
| Phase 2 Batch C | **DEFERRED — strategy chosen: Option A** | port omc subsystems first (worktree-paths → ralph state → ultrawork → …), THEN port persistent-mode + todo-continuation + omc-orchestrator. Estimated 2-3 sessions. | — |
| Phase 3 | **PENDING** | subagent lifecycle + session hooks (20 shell hooks); several Phase 3 hooks depend on Phase 2 Batch C subsystems being in place | — |
| Phase 4 | **DOWNGRADED** | hallucination-shield → advise-only per Architect condition 1 (smoke FAIL) | — |
| Phase 7 | **GATED** | modifiedArgs surgeon mode — needs own empirical gate in interactive mode | — |

---

## Critical empirical finding (Phase 1 smoke verdict)

**Copilot CLI 1.0.48 in `copilot -p` non-interactive mode does NOT fire ANY hooks** — verified across
6 event-name variants (`postToolUse` + `PostToolUse` + `preToolUse` + `PreToolUse` + `userPromptSubmitted` +
`UserPromptSubmit`) × 2 probe shapes (Node `.mjs` and stripped-down `.cmd`) × valid matcher `"*"`. The probe
log file (`~/.copilot/omcp-smoke-probe.log`) never appeared on any run.

The bundle (`@github/copilot/app.js`) does contain hook-execution machinery (`HookCommandWarningError`,
`HookExitCodeError`, `postToolUseFailure` integration). So hooks ARE implemented — they just don't fire in
`-p` mode, at least not as-configured via the matcher-style hooks section.

**Implications for the next session:**

1. omcp's hook infrastructure may be **interactive-mode-only**. If the user runs `copilot -p "..."` for
   scripting workflows, omcp's hook-based features (skill injection, persistent-mode, etc.) won't fire.
2. The omcp regression test `copilot-hook-events-validation.test.ts` verifies event NAMES are valid but
   never verifies hooks actually FIRE end-to-end. A real integration test would need to run a Copilot TUI
   session which is difficult to script.
3. **Recommended next step:** manually launch `copilot` (TUI), pre-wire the probe at `~/.copilot/config.json`
   `hooks.postToolUse`, send a prompt that uses a real tool, then check `~/.copilot/omcp-smoke-probe.log`.
   If it has entries → hooks DO fire in interactive mode, and the next test is whether `modifiedResult`
   replaces or appends.
4. Per Architect iter-3 condition 1 (FAIL branch): **Phase 4 hallucination-shield ships as advise-only fallback**.
   This is forward-compatible — a future PASS verdict in interactive mode could upgrade Phase 4 to true
   replacement semantics.

Full verdict + reproduction steps at `docs/architecture/hooks-modifiedresult-verification.md`.

---

## 2026-05-23 Hook Architecture Re-verdict (supersedes much of Phase 1)

A follow-up TUI-mode smoke confirmed the prior Phase 1 verdict was based
on incomplete evidence. **The corrected picture is in this section — when
it disagrees with the Phase 1 paragraph above, this section wins.**

### What was wrong with the Phase 1 verdict

Phase 1 concluded "Copilot CLI in `copilot -p` mode does NOT fire ANY
hooks" because `~/.copilot/omcp-smoke-probe.log` never appeared. That
inference assumed the probe would write to the log whenever Copilot
dispatched a hook. The corrected sequence below shows that assumption
was wrong.

### What the 2026-05-23 TUI smoke actually found

Wiring debug probes (4 event-name variants × multiple command forms)
into `~/.copilot/settings.json.hooks` and exercising Copilot in TUI mode
produced the following behaviour (Copilot CLI 1.0.51, Windows 11,
Node 24.14.1):

1. **Hooks DO fire in TUI mode** for every event (`SessionStart`,
   `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `Stop`). Copilot's
   log under `~/.copilot/logs/process-*.log` records each dispatch.
2. **Every hook crashes with the same Node stack** before any user code
   runs:
   ```
   SyntaxError: Unexpected token ':'
       at makeContextifyScript (node:internal/vm:194:14)
       at compileScript (node:internal/process/execution:388:10)
       at evalTypeScript (node:internal/process/execution:260:22)
       at node:internal/main/eval_stdin:51:5
   ```
3. **The stderr above the stack is the hook event JSON itself**, e.g.
   `{"hook_event_name":"UserPromptSubmit","session_id":"…",…}`. Copilot
   pipes that JSON into `node --input-type=ts -` and Node tries to
   compile it as TypeScript. JSON is not valid TS at top level
   (`{ "key": …` is parsed as a block with a string literal followed by
   an unexpected `:`), so every hook dies with code 1.
4. **All hook command formats were tried — every one fails identically:**
   - `command: 'node "C:\…\\probe.mjs" pre-camel'` (omc-style)
   - `command: 'cmd.exe /c exit 0'` (minimal Windows command)
   - `command: '"C:\\…\\probe-simple.cmd" post-camel'` (.cmd wrapper)
   - `command: 'require("fs").appendFileSync(...)'` (inline JS)
   - `powershell: 'Add-Content -Path … -Value …'` (explicit PowerShell field)
5. **The bundle's published shell dispatcher (`VKi` → `pwsh.exe -nop
   -nol -c <command>` on Windows / `bash.exe --norc --noprofile -c
   <command>` on POSIX) is NOT the code path actually used at runtime.**
   The runtime path goes through `node --input-type=ts -` regardless of
   what is wired.
6. **Wiring location does not matter.** Hooks loaded from
   `~/.copilot/settings.json.hooks`, from
   `~/.copilot/installed-plugins/<plugin>/hooks/hooks.json`, and from
   `<config>/hooks/**/*.json` all fail identically.
7. **omc's own hooks are also affected.** The omc plugin's
   `hooks/hooks.json` registers many PascalCase events with
   `command: "node \"$CLAUDE_PLUGIN_ROOT\"/scripts/run.cjs …"` —
   verified to produce the same SyntaxError on every fire under the
   current Copilot install.

### Implications

This appears to be a **Copilot CLI 1.0.51 bug on Windows** (Node 24.x),
not an omcp wiring error. Until it is fixed upstream:

- Phase 1 conclusion that `-p` mode "doesn't fire" was misleading. Hooks
  fire in BOTH `-p` and TUI modes; the probe just never reached its log
  line because Copilot's executor crashed Node before the script ran.
- Phase 4 hallucination-shield "advise-only fallback" downgrade was
  motivated by the Phase 1 verdict and should be re-evaluated.
- Phase 2 Batch C N+2 (port `persistent-mode`, `todo-continuation`,
  `omc-orchestrator` hooks) cannot land on this Copilot version — the
  hooks would compile and ship, but the runtime would crash them on
  every fire. Recommend BLOCKED-UPSTREAM status until Copilot fixes the
  hook executor, or a Copilot version where hooks demonstrably work
  becomes the baseline.
- omcp's lib/ subsystem ports (Phase 2 Batch C N+1, this session's
  6 files) are unaffected — they back MCP servers and CLI verbs that
  do not depend on hooks firing.

### Reproduction

Repository utilities added in this session:

- `scripts/smoke/debug-probe.mjs` — captures argv / env / cwd / stdin
  context Copilot hands to a hook, then exits 0.
- `scripts/smoke/wire-probe-for-tui.mjs <wire|check|unwire>` — installs
  the debug probe into `~/.copilot/settings.json.hooks` (backup +
  restore) so an interactive Copilot TUI session can exercise it.

Use them when re-validating against a future Copilot CLI release.

### Cleanup performed this session

The previous session left 4 `__omcpSmoke: true` hook entries in
`~/.copilot/settings.json.hooks` (pointing at the unbacked
`probe-modifiedresult.mjs`). They were emitting 18 stale
`HookExitCodeError` entries per TUI session into Copilot's log. Removed
during this debug pass; safety backup at
`~/.copilot/settings.json.pre-omcp-cleanup-backup` for one cycle.

---

## Phase 2 deferred-hooks scope (next session decision point)

The 3 Phase 2 hooks (`persistent-mode`, `todo-continuation`, `omc-orchestrator`) depend on **6+ omc-internal
subsystems** that omcp does not have:

- `lib/worktree-paths` — needed by all 3
- `lib/mode-state-io` — needed by persistent-mode
- `hooks/ralph/*` — 15+ exported functions (persistent-mode imports the entire ralph state API)
- `hooks/ultrawork/*` — needed by persistent-mode
- `hooks/autopilot/*` — needed by persistent-mode
- `hooks/team-pipeline/*` — needed by persistent-mode
- `hooks/subagent-tracker/*` — needed by persistent-mode + Phase 3
- `features/boulder-state/*` — needed by omc-orchestrator
- `notepad in-process state` — needed by omc-orchestrator (omcp has notepad MCP tools but no in-process module)

**User chose Option A** (2026-05-22): port the missing omc subsystems first (worktree-paths →
ralph state schema → ultrawork → …), THEN port persistent-mode + todo-continuation + omc-orchestrator.
Estimated 2-3 sessions of foundational work before the 3 deferred hooks land. Options B (thin
omcp-native variants) and C (defer entirely) were considered and rejected — full analysis in
`docs/plans/phase-2-deferred-hooks.md`.

Detailed N+1 / N+2 ordering for Option A execution is documented further down in the
"What the next session should do" section.

---

## What this session DID accomplish (full audit trail)

### Ralplan iter-3 → iter-4 closure (consensus loop)

1. Critic iter-3 review of v3 plan → **ITERATE** verdict (5 edits required: 3 Architect conditions not folded into plan text + 2 minor)
2. Planner iter-4 applied 5 surgical edits to docs/plans/hooks-parity-v3.md
3. Architect iter-4 review → **APPROVE** (clean) with 3 cosmetic notes
4. Planner applied 3 cosmetic polish items (ADR Follow-ups, Pre-mortem Scenario 1, ADR Consequences)
5. Critic iter-4 → **APPROVE**
6. Plan iter-4 committed as `dae5016`

### Phase 1 — foundation work

- `OMCP_HOOK_EVENTS` expanded from 5 to all 13 valid Copilot events (`src/runtime/copilot-config.ts`)
- `HookResult` union expanded from 3 to 6 variants (`src/hooks/hook-types.ts`)
- `runFireCli` synthesizes Copilot stdout protocol fields (`additionalContext`, `modifiedArgs`,
  `modifiedResult`, `interrupt`, `reason`) with last-wins semantics (`src/hooks/runtime.ts`)
- Tests +22 cases (17 + 5)
- Commit: `4fb8cd1`

### Phase 1 — smoke verdict (HARD GATE)

- Smoke harness written (`scripts/smoke/{probe-modifiedresult.mjs, probe-simple.cmd, canary-original.txt, run-modifiedresult-smoke.mjs}`)
- 3 diagnostic re-runs (Node probe, .cmd probe, 6 event-name variants)
- Verdict: **FAIL** (with caveat — hooks didn't fire at all in `-p` mode)
- Doc: `docs/architecture/hooks-modifiedresult-verification.md`
- Commit: `6a2606e`

### Phase 2 — Batches A + B

**Batch A — library modules** (commit `7b00ada`):
- `src/lib/factcheck/{index,types,checks,config,sentinel}.ts` (~855 lines source + 299 tests)
- `src/team/sentinel-gate.ts` (~191 lines + 235 tests)

**Batch B — preemptive-compaction hook** (commit `b7a423b`):
- `src/hooks/preemptive-compaction/{index,constants,types}.ts` (~390 lines + 468 tests)
- Subscribes to PostToolUse + PreCompact dual trigger
- State persisted under `.omcp/state/preemptive-compaction/{sessionId}.json` via `atomicWriteFileSync`
- Session-id slug guarded by `assertSafeSlug`

**Batch C — deferred** (`docs/plans/phase-2-deferred-hooks.md`):
- persistent-mode, todo-continuation, omc-orchestrator all blocked on unported omcp subsystems

### v0.10.0 release

- All 4 manifests bumped to v0.10.0 (per invariant 6):
  - `package.json`
  - `.agents/plugins/marketplace.json`
  - `.claude-plugin/plugin.json`
  - `plugins/oh-my-copilot/.claude-plugin/plugin.json`
- `CHANGELOG.md` v0.10.0 entry added (Keep-a-Changelog format)
- Tests: 398 (session start) → 460 passing (+62 net), 2 skipped, 0 failed

---

## Critical invariants (don't violate these)

(Unchanged from prior handoff — repeated here for next-agent convenience.)

1. **Any new file-name sink** uses `assertSafeSlug` from `src/runtime/safe-slug.ts`.
2. **Any state JSON write** uses `atomicWriteFileSync` (no bare `writeFileSync`).
3. **Any new `src/cli/commands/*.ts`** is registered in `src/cli/omcp.ts` (`cli-wiring-invariants` test enforces).
4. **Any new detached subprocess** writes a pidfile to `.omcp/state/<scope>/<name>.pid` + has a stop verb.
5. **Commit message factual claims** are verified by `git diff` — main agent has been caught lying ≥2 times.
6. **Version bump synchronizes 4 manifests**: `package.json`, `.agents/plugins/marketplace.json`,
   `.claude-plugin/plugin.json`, `plugins/oh-my-copilot/.claude-plugin/plugin.json`.
7. **User-supplied strings entering `new RegExp(...)`** are escaped via
   `value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")`.
8. **Hook event names** MUST be in `COPILOT_VALID_EVENTS`. Claude-Code-style names
   (`PreSubmit`/`PostSubmit`/`PreEnd`) are silently dropped by Copilot CLI (this is the
   v0.9.1 P0 root cause).
9. **`subagentStart` is camelCase-ONLY** — no `SubagentStart` alias in Copilot's `s2t` map.

---

## Critical user emphasis (carry forward)

- "着重要点 ralph ralplan 以及 team 这些可以长时间运行并且多角色 agent，
  用于防止 llm 自视甚高以及幻觉，还有可以 long running"
- "针对核心功能的缺乏，补齐，采用 team 和 critic 模式"
- "注意把 PreToolUse 这几个 Copilot 比 Claude 有优势的地方融入 plan 中去，
  看看有没有额外更多的应用"

= Long-running multi-role anti-hallucination is THE goal. Hooks subsystem is the load-bearing component.
The Phase 1 smoke verdict surfaced an unexpected blocker (no hooks in `-p` mode); the next session should
either confirm interactive-mode hooks work, or design alternative anti-hallucination mechanisms that don't
depend on `-p`-mode hook firing.

---

## What the next session should do — ordered

1. **Read** this HANDOFF.md + `docs/plans/hooks-parity-v3.md` (the iter-4 final plan) +
   `docs/plans/phase-2-deferred-hooks.md` + `docs/architecture/hooks-modifiedresult-verification.md`.

2. **`git status` + `git log -10`** to verify state matches this handoff. **Do NOT trust the handoff blindly.**

3. **Critical empirical question:** Manually launch `copilot` in interactive TUI mode and run the smoke probe
   at `scripts/smoke/run-modifiedresult-smoke.mjs` (or a manual variant adapted to TUI). If hooks fire there
   but not in `-p`, omcp's hook subsystem is interactive-only — a major scope clarification. If hooks ALSO
   don't fire in TUI mode, that's a deeper bug — omcp needs to either fix the wiring or redesign the
   anti-hallucination architecture entirely.

4. **Phase 2 Batch C — Option A execution starts here** (user chose Option A 2026-05-22).
   Multi-session work, estimated 2-3 sessions. Suggested ordering:

   **Session N+1 (foundational):**
   - Port `lib/worktree-paths` from omc → omcp `src/lib/worktree-paths.ts`. Foundational dependency
     for almost everything else.
   - Define omcp ralph state schema at `src/lib/ralph-state.ts` — `{active, iteration, lastFiredAt,
     prompt, prdPath, architectApproved?}` JSON file at `.omcp/state/ralph-state.json` with atomic
     write + safe reader. Port `readRalphState`, `writeRalphState`, `incrementRalphIteration`,
     `clearRalphState`, `getPrdCompletionStatus`, `getRalphContext`, `detectArchitectApproval`,
     `detectArchitectRejection` from `omc/src/hooks/ralph/`.
   - Define omcp ultrawork state schema (`src/lib/ultrawork-state.ts`). Port readers from
     `omc/src/hooks/ultrawork/`.
   - Define omcp todo-continuation state (or wire to Copilot's todo API if exposed).
   - Define omcp boulder-state schema (`src/lib/boulder-state.ts`).
   - In-process notepad state (`src/lib/notepad-state.ts`) — backs the existing `notepad_*` MCP tools.

   **Session N+2 (the deferred hooks):**
   - Port `persistent-mode` (~1255 lines in omc → likely ~600-800 lines in omcp after subsystem
     replacements). Stop event. Reads ralph/ultrawork/todo-continuation/team-pipeline state to decide
     when to inject continuation prompts.
   - Port `todo-continuation` (~615 → ~400 lines). Stop event. Reads omcp todo state, returns advise
     when pending tasks remain.
   - Port `omc-orchestrator` (~574 → ~400 lines). PreToolUse + PostToolUse. Uses notepad-state +
     boulder-state to enforce delegation patterns.
   - Acceptance: NO references to `~/.claude/` paths in any ported hook. Cross-check with grep.

5. **Phase 3 — 20 shell hooks** (subagent lifecycle + session hooks). Mostly 1:1 ports but several
   depend on Phase 2 Batch C subsystems (subagent-tracker, verify-deliverables). Do Phase 3 after
   Batch C lands.

6. **Phase 4 — hallucination shield (advise-only fallback per smoke FAIL).** Lower priority — ships only
   annotations via advise, no `modifiedResult` replacement. Can be done independently of Phase 2 Batch C.

7. **Phase 7 — modifiedArgs surgeon mode.** Needs its own empirical gate (in interactive mode) before any
   work begins. Deferred until step 3 confirms hooks fire in TUI mode at all.

---

## Working environment quick-ref

- **Build**: `npm run build` (clean before this session; tsc only)
- **Tests**: `npm test`. Currently 460 passing, 2 skipped, 0 failed. 1 pre-existing Win vitest worker-fork
  EPERM baseline since v0.4.0 — unchanged.
- **CHANGELOG**: prepend to `CHANGELOG.md` (Keep-a-Changelog format).
- **Commit trailers**: project uses omc-style trailers (Constraint/Rejected/Confidence/Scope-risk/Directive/Not-tested).
- **omc reference**: `C:\Users\runjiashi\.claude\plugins\cache\omc\oh-my-claudecode\4.9.3\` (read-only)
- **omx reference**: `C:\Users\runjiashi\_refs\oh-my-codex\` (read-only)
- **Copilot CLI binary**: `/c/.tools/.npm-global/copilot.cmd` (v1.0.48)
- **Copilot CLI bundle (for grep)**: `/c/.tools/.npm-global/node_modules/@github/copilot/app.js`
- **GH auth**: user supplied an OAuth token mid-session to unblock the smoke test.
  **The token was inadvertently included in this HANDOFF file in commit a90e831
  and has been redacted here.** No remote push has occurred (repo is local-only),
  so the leak is confined to local git history. Recommended next steps:
  (a) USER: revoke the token at https://github.com/settings/tokens and reissue;
  (b) For follow-up smoke tests, set the new token in-shell only:
  `export GH_TOKEN="..." && export COPILOT_GITHUB_TOKEN="$GH_TOKEN"` —
  never write it to a tracked file.

---

## Open omx work (NOT scope of this session's `/goal`)

User's session `/goal` was "omcp 复刻 omc" — explicitly omc, not omx. omx parity still has many missing
skills and CLI verbs. Future work when user reprioritizes.
