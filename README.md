# oh-my-copilot (omcp)

omcp is the GitHub Copilot CLI orchestration layer — a sibling project to
[oh-my-claudecode (omc)](https://github.com/Yeachan-Heo/oh-my-claudecode) and
oh-my-codex (omx), tailored to Copilot's plugin runtime and its Claude + GPT
dual-model surface. It ships 42 skills, 19 agents, 10 MCP servers, and 4
autonomous looping modes (ralph, autopilot, team, ultrawork). v2.0 is
**Windows-first** by explicit scope decision; cross-platform support is
scheduled for v2.1+.

## Install

v2.0 public npm publish is deferred pending account availability
([ADR-v2.0-public-release-deferred.md](docs/adr/ADR-v2.0-public-release-deferred.md)).
Until then, install from a local clone:

```bash
git clone <repo-url> oh-my-copilot
cd oh-my-copilot
npm install
npm run build
omcp setup          # registers plugin + MCP servers into ~/.copilot/
```

When `npm publish` lands, the install will become:

```bash
npm install -g oh-my-copilot
omcp setup
```

## Quickstart

```bash
# Verify the environment
omcp doctor

# Run the ralph autonomous loop on a task
omcp ralph "add pagination to the user list endpoint"
```

`omcp doctor` checks Copilot CLI version, plugin registration, MCP server
availability, hook wiring, and agent catalog completeness. Fix any reported
issues before running a mode.

`omcp ralph` spawns Copilot in non-interactive autopilot mode and loops until
the PRD completion criterion is met or the iteration cap is reached. Progress
prints to stdout; interrupt with Ctrl-C and resume later with
`omcp ralph --resume "same task"`.

## Looping modes

| Mode | Description |
| --- | --- |
| `ralph` | Persistence loop: re-spawns Copilot until the PRD is complete or the iteration cap is hit; stall detection bails early when no stories advance. |
| `autopilot` | Full autonomous pipeline — expand spec, plan, execute, QA — in a single Copilot session with `--autopilot --yolo`. |
| `team` | Parallel worker shards: N concurrent Copilot instances collaborate on disjoint task partitions with merge-conflict detection. |
| `ultrawork` | High-throughput parallel execution engine for large independent task lists. |

All four modes pass `--autopilot --yolo` to Copilot and use mutual-exclusion
state to prevent concurrent mode conflicts. Cancel any active mode with
`omcp cancel`.

## MCP servers

Registered automatically by `omcp setup` into `~/.copilot/mcp-config.json`.

| Server | Purpose |
| --- | --- |
| `state` | Read/write typed mode-state and generic session state (FileStateStore). |
| `notepad` | Persistent scratchpad with priority / working / manual sections. |
| `trace` | Append and query session event timelines for observability. |
| `project-memory` | Validated key-value store for cross-session project facts and directives. |
| `loop` | Schedule, list, and cancel timed re-run triggers for external loop commands. |
| `code-intel` | LSP diagnostics and AST grep search/replace for structural code queries. |
| `hermes` | Detached session manager — start, send prompts to, and read artifacts from background Copilot sessions. |
| `wiki` | LLM wiki knowledge base backed by `.omcp/wiki/*.md` with ingest, query, and lint tools. |
| `python-repl` | Persistent Python REPL for inline data analysis and script execution. |
| `shared-memory` | Cross-session shared memory for multi-agent coordination without file-based state. |

Launch any server manually via `omcp mcp-serve <name>`.

## HUD

The HUD renders omcp state as a single status line:

```
omcp · claude · ralph · 3/20 · - · Fix auth flow · [prd 3/10] · [$0.12]
```

The 6-column contract (`omcp · family · modes · ralph-iter · team-done · note`)
was established in v1.3.0 (columns 3-5). v1.9.0 added columns 1, 2, and 6
(mode+iter with counts, PRD progress, and cost estimate).

Wire the HUD as a Copilot status line by setting `statusLine.command` in
`~/.copilot/config.json` to `omcp hud`, or run it once with:

```bash
omcp hud          # single render
omcp hud --watch  # refresh every 2 s
```

## Stability commitments (v2.0)

- **Support matrix**: GitHub Copilot CLI 1.0.53+, Node.js 20+, Windows 11
  (primary). macOS and Linux are deferred to v2.1+ per the 2026-05-25 scope
  decision — this is an explicit scope choice, not a deferral.
- **CLI shape stability**: the `ralph`, `autopilot`, `team`, and `ultrawork`
  command signatures are stable at v2.0. Breaking changes require v3.0.
- **MCP server stability**: all 10 server tool shapes are stable at v2.0.
  New tools may be added in minor versions; existing tools will not change
  signatures without a major bump.
- **Plugin protocol**: omcp targets the Copilot plugin protocol as of
  Copilot CLI 1.0.53. Upstream protocol changes may require a patch release.

## Links

- [v1.7 → v2.0 roadmap](docs/architecture/v1.7-to-v2.0-roadmap.md)
- [Project invariants](docs/architecture/invariants.md)
- [Per-version handoff archive](docs/handoff-archive/)
- [Changelog](CHANGELOG.md)

## License

MIT. See [LICENSE](./LICENSE).
