# Hook wiring on GitHub Copilot CLI

This document describes how `omcp setup` wires omcp's hook system into
GitHub Copilot CLI's native runtime so that hooks fire automatically without
requiring users to touch shell rc files.

## Background

omcp ships:

- `omcp hook fire <event> [--json]` — a CLI entry point that reads a JSON
  payload from stdin, invokes every discovered hook for `<event>`, and emits
  results to stdout. See `src/hooks/runtime.ts`.
- Reference hooks under `hooks/` (pre-tool-suggest-fleet, post-tool-track-state)
  and a discoverer that loads them from the plugin cache and from a repo-local
  `.omcp/hooks/` directory.

Without runtime wiring nothing calls `omcp hook fire`. omc solves the
equivalent problem on Claude Code by writing entries into `~/.claude/settings.json`
under the `hooks:` and `statusLine:` keys. The equivalent on Copilot CLI is
`~/.copilot/config.json`.

## Investigation: does Copilot CLI support settings-file hooks?

Run:

```
copilot help config
```

Relevant excerpts (Copilot CLI 1.0.32+):

> `disableAllHooks`: whether to disable all hooks (repo-level and user-level);
> defaults to `false`.
>
> `hooks`: inline hook definitions, keyed by event name (same schema as
> `.github/hooks/*.json`). In global config.json these act as user-level hooks;
> in repo settings.json they act as repo-level hooks.
>
> `statusLine`: configuration for a custom status line displayed below the
> input.
> - `type`: must be `"command"`
> - `command`: path to an executable script that generates status line content.
>   Supports `~` and environment variables.
> - `padding`: optional number of spaces to pad each line on the left.

This is **Case A** in the design spec: Copilot CLI supports settings-driven
hooks and statusLine, and we can wire omcp by writing those keys.

## Schema

The `hooks` value uses the same shape as Claude Code's hooks config and
`.github/hooks/*.json` files shipped by Claude Code plugins:

```json
{
  "hooks": {
    "<EventName>": [
      {
        "matcher": "*",
        "hooks": [
          {
            "type": "command",
            "command": "<shell command>",
            "timeout": 5
          }
        ]
      }
    ]
  },
  "statusLine": {
    "type": "command",
    "command": "omcp hud",
    "padding": 0
  }
}
```

Each entry under `hooks.<event>` is a *matcher group*; Copilot picks the
matching group(s) (`"*"` always matches) and runs every command in the
`hooks` array, piping the event context as JSON on stdin.

## How omcp wires itself

`src/runtime/copilot-config.ts` exposes:

| Function                      | Purpose                                         |
| ----------------------------- | ----------------------------------------------- |
| `mergeCopilotHooks`           | Add/refresh omcp hook entries; preserve user entries |
| `mergeCopilotStatusLine`      | Set `omcp hud` as `statusLine.command` unless user has a custom one |
| `applyOmcpRuntimeWiring`      | One-shot wrapper over the two merges            |
| `hasOmcpHookWiring`           | Doctor predicate                                |
| `hasOmcpStatusLine`           | Doctor predicate                                |

Each omcp-managed entry carries an internal marker `"__omcp": true`. On
re-run, `mergeCopilotHooks` strips every entry with that marker before
re-emitting the fresh entries, which makes setup idempotent and ensures we
never accumulate duplicates. Entries without the marker (user-authored) are
preserved verbatim.

For each event in `OMCP_HOOK_EVENTS`
(`PreToolUse`, `PostToolUse`, `UserPromptSubmit`, `SessionStart`,
`SessionEnd`) we add a matcher group of the form:

```json
{
  "matcher": "*",
  "hooks": [
    { "type": "command", "command": "omcp hook fire <Event> --json", "timeout": 5, "__omcp": true }
  ]
}
```

When the event fires, Copilot CLI invokes `omcp hook fire <Event> --json`
with the event payload on stdin. `runFireCli` (in `src/hooks/runtime.ts`)
parses that payload into a `HookContext` and dispatches every registered
omcp hook for the event.

The `statusLine` entry is wired identically but only when no user-defined
status line is present: if `statusLine` already exists and is **not** marked
`__omcp`, we leave it alone.

## End-user surface

`omcp setup` now prints:

```
omcp setup complete
  plugin      -> ~/.copilot/installed-plugins/oh-my-copilot/oh-my-copilot
  marketplace -> ~/.copilot/marketplaces/oh-my-copilot.json
  config.json updated: true
  mcp-config.json updated: true
  hooks auto-wired: true
  statusLine auto-wired: true

Next: hooks auto-wired - launch `copilot` and try `/oh-my-copilot:autopilot ...`
```

`omcp doctor` adds two checks:

```
[OK ] hook wiring                  omcp hook entries present in config.json
[OK ] statusLine wiring            omcp hud configured as statusLine.command
```

When wiring is missing both report `WARN` with a pointer back to this file.

## Kill switches

The hook runtime honors:

- `DISABLE_OMCP=1` / `OMCP_DISABLE=1` — disable every hook in the registry.
- `OMCP_SKIP_HOOKS=foo,bar` — skip the named hooks (by file basename) only.
- Copilot's own `disableAllHooks: true` in `~/.copilot/config.json` —
  disables both repo-level and user-level hooks regardless of omcp.

## Future work

- Subscribe to `UserPromptSubmit` and `PreCompact` once the omcp `HookEvent`
  enum grows to cover them.
- Add a `--bridge-shell` mode to `omcp hook fire` that falls back to env vars
  (`COPILOT_TOOL_NAME`, `COPILOT_TOOL_ARGS`) if Copilot ever exposes those
  instead of stdin JSON. (Tracked for parity with Case B environments where
  no settings-file hook surface exists.)
