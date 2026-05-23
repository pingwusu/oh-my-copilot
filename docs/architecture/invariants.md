# omcp Project Invariants

This document enumerates the 9 invariants that all contributors must preserve.
Each entry lists the rule, its enforcement point in code, and any explicit
carve-outs where the rule does not apply.

---

## Invariant 1 — `assertSafeSlug` on path inputs

**Rule:** Every string that is interpolated into a file path and originates from
external input (session id, mode name, worker name) must be validated with
`assertSafeSlug` from `src/runtime/safe-slug.ts` before use. This prevents
path-traversal attacks (e.g. `../../etc/passwd`).

**Enforcement points:**
- `src/cli/commands/state.ts:27,35` — `sessionId` and `mode` arguments
- `src/hooks/audit-logger/index.ts:41` — `sessionId` from hook context
- `src/hooks/cost-governor/index.ts:35,102` — `sessionId`
- `src/hooks/idle-alert/index.ts:32` — `sessionId`
- `src/hooks/loop-detector/index.ts:97` — `sessionId`
- `src/hooks/preemptive-compaction/index.ts:98` — `sessionId`
- `src/lib/team-shard-state.ts:83` — `workerName`

**Carve-outs:** None. All external path-component inputs must pass this gate.

---

## Invariant 2 — `atomicWriteFileSync` for all state JSON writes

**Rule:** All writes to `.omcp/state/**` (and any other state JSON file) must
use `atomicWriteFileSync` from `src/runtime/atomic-write.ts`. Bare
`writeFileSync` on state JSON is forbidden. This prevents torn reads when a
hook process is killed mid-write.

**Enforcement points:**
- `src/cli/commands/mode.ts` — cancel marker, notepad
- `src/cli/commands/state.ts:98` — generic state write
- `src/cli/commands/reasoning.ts:50,63` — reasoning level state
- `src/cli/commands/doctor.ts:167` — copilot config write
- `src/hooks/cost-governor/index.ts:67` — per-session cost state
- `src/hooks/idle-alert/index.ts:57` — idle-alert state
- `src/hooks/loop-detector/index.ts:132` — loop-detector state
- `src/hooks/preemptive-compaction/index.ts:134` — compaction state
- `src/lib/boulder-state.ts:128` — boulder state
- `src/lib/ralph-state.ts:174` — ralph state (via `writeRalphState`)
- `src/hooks/wiki/storage.ts` — wiki page/index/log writes

**Carve-outs:**
- `src/cli/commands/team.ts:99` — bare `writeFileSync` for **pidfiles**
  (`.omcp/state/team/<sessionId>/worker-K.pid`). Pidfiles contain a single
  integer string, not JSON. Atomicity is not required because a torn write of
  a PID integer is either the correct PID or empty — both are safe (empty is
  treated as "not started"). Using `openSync` + `writeSync` + exclusive lock
  in loop-watcher is the stricter pattern when a TOCTOU window matters, but
  detached team workers don't have that constraint.
- `src/mcp/hermes-bridge.ts:223` — bare `writeFileSync(log, "")` to **touch a
  log file** before a detached child opens it for append. This is an
  initialisation write of an empty string to a log path, not a state JSON file.
  The file is opened for append (`openSync(log, "a")`) immediately after, so
  atomicity is irrelevant.
- `src/scripts/release.ts` — release script writes `package.json` and
  `CHANGELOG.md` with bare `writeFileSync`. These are build-time writes
  outside the runtime state path; the release script runs as a one-shot
  maintenance command, not in a concurrent hook environment.
- `src/scripts/smoke-e2e.ts` — test fixture writes; not runtime state.

---

## Invariant 3 — 4-manifest version sync on every release

**Rule:** Every version bump must touch all four version carriers in the same
commit. The `release` script (`src/scripts/release.ts`) enforces this
automatically.

**The four manifests:**
1. `package.json` — npm package version
2. `.claude-plugin/plugin.json` — Claude Code plugin manifest version
3. `.agents/plugins/marketplace.json` — Copilot marketplace listing version
4. `CHANGELOG.md` — `## [Unreleased]` header replaced with `## [X.Y.Z] — date`

**Enforcement point:** `src/scripts/release.ts:75-103` — all four files are
written in sequence before the git commit; the script fails fast if any file
is missing.

**Carve-outs:** None. Manual version bumps that skip the release script must
still touch all four files.

---

## Invariant 4 — Hook events must be in `COPILOT_VALID_EVENTS`

**Rule:** Any hook event string registered in a `hooks.json` or fired via
`omcp hook fire` must appear in `COPILOT_VALID_EVENTS` from
`src/runtime/copilot-config.ts`. Using an unknown event name (e.g. a
Claude-Code-style misnomer like `PreToolUse` when the Copilot name differs)
causes silent hook misses.

**Enforcement points:**
- `src/runtime/copilot-config.ts:163` — canonical constant definition
- `src/__tests__/copilot-hook-events-validation.test.ts` — test suite that
  verifies every OMCP hook entry is in the valid set and that v0.4–v0.9
  misnomers are absent
- `src/__tests__/omcp-hook-events.test.ts` — cross-checks all wired hook
  events against the valid set

**Carve-outs:** None.

---

## Invariant 5 — `subagentStart` must be camelCase

**Rule:** The Copilot CLI event for subagent launch is `subagentStart`
(camelCase). It has no PascalCase alias (unlike most other events). Any
hook registration using `SubagentStart` or `subagent_start` will silently fail.

**Enforcement points:**
- `src/hooks/hook-types.ts:25` — union type includes `"subagentStart"` only
- `src/hooks/runtime.ts:119,144,416` — explicit comments noting the absence
  of a PascalCase alias; the camelCase form is used directly in the event
  allowlist and routing table

**Carve-outs:** None.

---

## Invariant 6 — `escapeRegExp` before `new RegExp(untrusted)`

**Rule:** Any user-supplied or externally-derived string passed to
`new RegExp(...)` as a literal match pattern must first be escaped with
`escapeRegExp` from `src/runtime/escape-regexp.ts`. Building a RegExp directly
from untrusted input is a ReDoS vector and produces incorrect results when the
string contains regex metacharacters.

**Enforcement points:**
- `src/cli/commands/state-todo.ts:106` — `new RegExp(escapeRegExp(flags.pattern))`
- `src/lib/factcheck/config.ts:154` — `new RegExp("^" + escaped + "$")` where
  `escaped` is pre-processed

**Known exceptions (trusted inputs — not carve-outs):**
- `src/mcp/code-intel-server.ts:567-579,616,667` — patterns are constructed
  from developer-controlled symbol name strings (not user input) and are
  hardened with inline escaping where needed (`replace(/[.*+?^${}()|[\]\\]/g, "\\$&")`)
- `src/cli/commands/session.ts:32` — `query` is a CLI argument treated as a
  raw regex by design (documented behavior; callers who want literal matching
  must escape themselves)

**Carve-outs:** None for user-facing search patterns; see exceptions above for
developer-controlled symbol lookups.

---

## Invariant 7 — No Claude-only tokens in shipped prompts

**Rule:** Shipped agent and skill prompts (`agents/**`, `skills/**`) must not
contain Claude Code-specific tool names or invocation envelopes. These tokens
are meaningless in Copilot CLI and indicate an incomplete port.

**Banned tokens** (enforced by `src/scripts/verify-catalog.ts:20-35`):
- `TodoWrite`, `AskUserQuestion`, `Task(subagent_type=`
- `/oh-my-claudecode:`, `.omc/`, `EnterPlanMode`, `ExitPlanMode`, `ToolSearch`
- `<remember>`, `<remember priority>`
- `Skill("oh-my-copilot:` (Claude-only Skill tool invocation)
- `"subagent_type":` (Claude-only subagent dispatch envelope)

**Enforcement point:** `src/scripts/verify-catalog.ts` — run via
`npm run verify:catalog`; also runs during `prepack`.

**Carve-outs:** Documentation files (`docs/**`, `*.md`) are not scanned.
References to these tokens in comments explaining what NOT to do are acceptable
in source files but not in shipped prompts.

---

## Invariant 8 — Every CLI command must be registered in `runCli`

**Rule:** Every user-facing `omcp <subcommand>` must have a corresponding
`.command(...)` registration in `src/cli/omcp.ts:runCli`. Commands that exist
as exported functions but are not wired into the Commander program are dead
code and will not appear in `omcp --help`.

**Enforcement point:** `src/cli/omcp.ts` — the Commander program tree. There
is no automated check; the convention is: if you add a `run*` export in
`src/cli/commands/`, add a matching `.command(...)` call in `runCli` in the
same commit.

**Carve-outs:** Internal helpers (e.g. `formatChecks`, `exitCodeFor`) that are
consumed by other commands rather than directly by the CLI are exempt.

---

## Invariant 9 — Pidfiles use stop-verb pattern; no orphan workers

**Rule:** Any long-running detached child process spawned by omcp must write
a pidfile to `.omcp/state/` so that `omcp cancel`, `omcp cleanup`, and the
loop-watcher can terminate it. Spawning a detached process without recording
its PID creates an orphan that cannot be killed without manual intervention.

**Enforcement points:**
- `src/cli/commands/team.ts:89-99` — per-worker pidfiles at
  `.omcp/state/team/<sessionId>/worker-K.pid`
- `src/cli/commands/loop-watcher.ts:16-58` — loop-watcher pidfile at
  `.omcp/state/loop-watcher.pid` with exclusive-lock TOCTOU protection
- `src/cli/commands/cleanup.ts:84-101,158-165` — stale pidfile detection and
  cleanup for both MCP and loop-watcher pidfiles

**Carve-outs:** Short-lived child processes (e.g. `spawnSync` calls to
`copilot -p`) that block the parent until completion do not need pidfiles
because the parent process itself is the lifecycle boundary.
