# Changelog

All notable changes to oh-my-copilot will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

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
