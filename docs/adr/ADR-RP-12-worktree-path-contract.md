# ADR: RP-12 — Team Worktree Path Contract + Traversal Carve-Out

**Date**: 2026-05-29
**Status**: Accepted (RALPLAN-DR robin-port RP-12 — PORT-OMC via-Robin + PRINCIPLED-DIVERGENCE on branch prefix)
**Author**: pingwusu (omcp-r2)
**Related**:
- `.omc/plans/ralplan-robin-port-rp.md` (gitignored; §7 RP-12 + §8.5
  ≥70-test-case floor + §4.A row F13 — content reproduced inline below
  for durability)
- omc canonical `skills/team/SKILL.md` lines 913-945 — Git Worktree
  Integration API surface
- `/tmp/robin-omcp/skills/team/SKILL.md` lines 985-1050 — Robin's
  worktree integration prose
- `src/runtime/safe-slug.ts:10` — `SLUG_RE = /^[A-Za-z0-9_\-.]{1,80}$/`
  (PM-2 corrected cap value)
- Implementation: `src/cli/commands/team-worktree.ts`
- Tests: `src/__tests__/team-worktree.test.ts` (99 cases)

---

## Context

omc canonical's `skills/team/SKILL.md` lines 913-945 documents a "Git
Worktree Integration" API that materializes isolated worker worktrees
at `.omc/worktrees/{team}/{worker}` on branch `omc-team/{team}/{worker}`
with 7 named functions (`createWorkerWorktree`, `removeWorkerWorktree`,
`listTeamWorktrees`, `cleanupTeamWorktrees`, `checkMergeConflicts`,
`mergeWorkerBranch`, `mergeAllWorkerBranches`).

Robin's fork mirrors omc's API exactly. omcp-r2 had a gap — the SKILL.md
prose was already aligned via principled retargeting (we use
`.omcp/worktrees/` and `omcp-team/`), but no CLI verbs existed to
materialize the surface. v4 §4.A row F13 classifies this as **PORT-OMC
via-Robin** with **PRINCIPLED-DIVERGENCE on branch prefix**.

## Decision

Ship 5 stateless CLI verbs (`team-worktree-{create,list,merge,cleanup,
conflict-check}`) that materialize the omc-canonical API as
process-boundary commands rather than in-process function calls. This
matches our stateless-verb DNA per ADR-omcp-eb-06 + ADR-omcp-rg-05.

### Path contract

| Surface | omc canonical | omcp-r2 | Rationale |
|---|---|---|---|
| State root | `.omc/` | `.omcp/` | Principled fork-identity divergence (ADR-fork-identity) |
| Worktree subdir | `worktrees/` | `worktrees/` | Identical |
| Worktree path | `.omc/worktrees/{team}/{worker}` | `.omcp/worktrees/{team}/{worker}` | Identical shape |
| Branch prefix | `omc-team/` | `omcp-team/` | **PRINCIPLED-DIVERGENCE per Q-v3-A 4-sibling-token argument** |

### 4-sibling-token argument (Q-v3-A)

Our user-visible tokens form a consistent set:
1. Binary name: `omcp` (not `omc`)
2. State root: `.omcp/` (not `.omc/`)
3. Teleport worktree prefix: `omcp-worktrees` (not `omc-worktrees`)
4. Plugin namespace: `oh-my-copilot:` (not `oh-my-claudecode:`)

Switching the team-worktree branch prefix alone to `omc-team/` would
introduce a visible 5th-token inconsistency that breaks the existing
convention. Cross-fork compat (D2) is preserved because the X1 fixture
reader parses either prefix as forward-compat (asserts prefix
membership in `{omc-team/, omcp-team/}`), not exact string match.

### Traversal carve-out (Critic C2)

Worker worktrees materialized under `.omcp/worktrees/{team}/{worker}`
contain full `.git` subtrees + unrelated source files. State-traversal
walkers under `.omcp/` MUST skip `worktrees/**` via the new shared
helper `shouldSkipForOmcpTraversal(relpath: string): boolean` exported
from `src/lib/worktree-paths.ts`.

Failure mode without the carve-out:
1. A walker recursing under `.omcp/` would descend into worker `.git/`
   files, racing with concurrent `git worktree add` operations and
   producing intermittent "apparent state corruption" diagnostics.
2. Diagnostic output would mis-attribute unrelated source files to
   omcp state, dwarfing the actual `.omcp/state/` payload.
3. Recursive `rmSync` of a misidentified state subdir could corrupt
   live worktrees.

### Walker call site inventory (as of RP-12 landing)

| Site | Walks | Carve-out needed? |
|---|---|---|
| `src/runtime/trace.ts:59` | `.omcp/state/trace/` | NO (specific subtree) |
| `src/hud/state.ts:319` | `.omcp/state/` session dirs | NO (specific subtree, but DEFENSIVE if refactored) |
| `src/cli/commands/team-event-health-check.ts:205,262` | `.omcp/state/team/<sid>/` | NO (specific subtree) |
| `src/cli/commands/team-conflict.ts:399` | `.omcp/state/team/<sid>/conflicts/` | NO |
| `src/runtime/shared-memory.ts:76,114` | `.omcp/state/shared-memory/` | NO |
| `src/lib/worktree-paths.ts:381` (`listSessionIds`) | `.omcp/state/sessions/` | NO |
| `src/cli/commands/cleanup.ts:215` (`safeReaddir`) | Generic; callers pass specific subdirs | NO |
| `src/mcp/state-server.ts:66` | `.omcp/state/{sessionId}/` `.json` files | NO |
| `src/mcp/hermes-bridge.ts:359,416` | Hermes-specific roots, not `.omcp/` | NO |
| `src/cli/commands/state.ts:52,119` | `.omcp/state/` | **DEFENSIVE** — apply carve-out if refactored to walk `.omcp/` root |

No CURRENT walker iterates `.omcp/` root → `worktrees/` subtree.
The carve-out is a **maintenance invariant** for future walkers
(documented in this ADR + the `shouldSkipForOmcpTraversal` jsdoc).

### Test floor (v4 §8.5)

99 test cases (exceeds the ≥70-case floor) spanning:
- happy paths: 7 cases
- argv validation / error paths: 27 cases (across 5 verbs)
- non-git cwd: 5 cases
- merge happy + conflict: 5 cases
- conflict-check pre-flight: 5 cases
- path-length AC: 6 cases
- producer_fork emission: 5 cases
- CLI wrappers (stdout + JSON modes): 10 cases
- traversal carve-out interaction: 2 cases
- cross-verb round-trip idempotency: 4 cases
- multi-worker isolation: 3 cases
- boundary / stress: 3 cases
- pure helpers + constants: 13 cases
- shouldSkipForOmcpTraversal: 12 cases

### Path-length contract (PM-2, v4 corrected)

- `assertSafeSlug` enforces 1-80 chars per `src/runtime/safe-slug.ts:10`
  `SLUG_RE = /^[A-Za-z0-9_\-.]{1,80}$/`
- Verb-side `pathLengthGuard` rejects any composed absolute worktree
  path exceeding 240 chars on Windows (mitigates MAX_PATH + per-tool
  ENAMETOOLONG; leaves headroom below 260 for `.git/` paths +
  tool-suffix bytes)
- Failure: structured error returned via `result.error`, exit 2
- v3's "32 char" cap and Architect iter-2's "64 char" guess were both
  incorrect; v4 cites the actual `safe-slug.ts:10` line

## Consequences

### Visible to users
- 5 new CLI verbs documented in omc canonical SKILL.md prose
  (already mirrored in our `skills/team/SKILL.md` lines 910-941)
- Worker branches carry `omcp-team/` prefix; cross-fork readers
  must use forward-compat membership check
- `--force` flag on cleanup required to bypass uncommitted-changes
  guard; the guard is intentional safety, not a bug
- `--no-ff` is the default merge mode (matches omc canonical
  "merge with --no-ff for clear history")

### Visible to operators
- `.omcp/worktrees/` becomes a load-bearing subtree alongside
  `.omcp/state/`, `.omcp/plans/`, etc.
- Event-log entries from the 5 verbs carry
  `producer_fork: "omcp-r2"` per ADR-omcp-rg-01
- Verb-emitted JSON outputs (when `--json` passed) carry
  `producer_fork` for cross-fork attribution

### Visible to maintainers
- **Maintenance invariant**: any future walker that recurses under
  `.omcp/` root MUST apply `shouldSkipForOmcpTraversal()` to skip
  `worktrees/**`. Walker call sites that iterate a specific subtree
  (e.g. `.omcp/state/sessions/`) do not need the carve-out, but if
  refactored to walk a parent, the carve-out MUST be added.
- **Maintenance invariant**: the verb file `src/cli/commands/
  team-worktree.ts` is the source of truth for the 5 verbs. The
  re-export in `src/cli/commands/team.ts` exists purely to satisfy
  the orphan-module wiring invariant (`cli-wiring-invariants.test.
  ts`); it MUST be kept in sync if function names change.
- **Cross-fork compatibility**: X1 fixture reader (in
  `tests/cross-fork/`) uses prefix membership check
  `{omc-team/, omcp-team/}` rather than exact-string match.

### Visible at v2.4 review
- Telemetry for the 5 verbs is captured via `appendEventBestEffort`
  to `events.jsonl`; v2.4 audit can query usage frequency and
  catch zero-adoption (PM-1 mitigation).

## Follow-ups

1. omcp.ts CLI registration block (5 `program.command()` entries)
   is intentionally NOT included in this story per task
   constraints — provided as a snippet in the commit message for
   the orchestrator to wire in a follow-up commit.
2. Cross-fork smoke test: ensure Robin's reader handles
   `omcp-team/` prefix without error (X1 fixture variant).
3. Walker refactor audit at v2.4: any walker added since RP-12
   landing must apply `shouldSkipForOmcpTraversal()` if it walks
   `.omcp/` root. PR-time check via grep on `readdirSync.*\.omcp`.

## Alternatives Considered

- **A — omc-team/ branch prefix**: rejected per Q-v3-A 4-sibling-token
  argument. Would create visible inconsistency with binary, state
  root, teleport prefix, and plugin namespace.
- **B — In-process function API instead of CLI verbs**: rejected per
  ADR-omcp-eb-06 stateless-verb DNA. Robin's MCP-bridge approach
  doesn't fit our process-boundary model.
- **C — Skip the path-length guard**: rejected. Windows MAX_PATH +
  per-tool ENAMETOOLONG would surface as intermittent test failures
  on long-prefix CI runners.
- **D — No traversal carve-out (defensive)**: rejected per Critic C2.
  Future walkers added without the helper would race with
  `git worktree add` and produce false-positive corruption alerts.
