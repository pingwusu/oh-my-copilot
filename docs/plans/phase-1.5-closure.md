# Phase 1.5 Closure Plan — Resolve the Hook-Crash Blocker

**Status:** CLOSED — root cause identified 2026-05-23. Phase 2 is UNBLOCKED.
**Driver:** v0.12.0 + Phase 1 (c1d205f) shipped, but probe re-verification revealed crashes persist even with OMC plugin disabled. Phase 2 (N+2 hook ports) was BLOCKED until the second crash source was identified.
**Resolution:** Track A confirmed all crashes originate from the three enabled plugins (not Copilot-internal). Track B confirmed Copilot spawns `pwsh.exe -nop -nol -c <commandStr>` (no shell:true). Track C confirmed `python C:/absolute/path/script.py` fires cleanly (0 errors). Root cause: OMC plugin's `$CLAUDE_PLUGIN_ROOT` Bash variable is empty in PowerShell → node falls back to stdin → SyntaxError. omcp's own hook command (`omcp hook fire <event> --json`) is already shell-safe and unaffected. See `.omc/research/phase-1.5-synthesis.md` for full analysis.
**Working tree:** `C:\Users\runjiashi\oh-my-copilot-r2`, HEAD `c1d205f`.

## What we know (verified evidence)

1. Phase 1 target-file fix is correct: settings.json IS the right hook target per Copilot's own `config.json` line 1: "User settings belong in settings.json."
2. OMC plugin (`installed-plugins/omc/oh-my-claudecode/hooks/hooks.json`) uses Bash-style `$CLAUDE_PLUGIN_ROOT` — user's diagnosis is correct for THIS file.
3. Even with `oh-my-claudecode@omc` DISABLED in settings.json, 12 hook-execution errors still appear in the Copilot process log on a single `copilot -p` exercise.
4. The crashes consistently show `Stderr: [stdin]:1\n{"hook_event_name":...}` SyntaxError — Node receiving JSON via stdin with no script positional arg.

## What we DON'T know (the blocker)

- **Which hooks.json is producing the residual 12 errors?** Candidates:
  - `installed-plugins/oh-my-copilot/oh-my-copilot/hooks/*.json` (omcp's auto-installed plugin copy)
  - `installed-plugins/claude-code-plugins/ralph-wiggum/hooks/hooks.json` (verified to exist)
  - Some other auto-loaded location
- **What command does Copilot actually spawn?** The bundle's `m2` function at `app.js:1200` is the entry point but its body is in heavily-minified code I haven't traced.
- **Why does even an absolute-path cmd.exe hook produce the same crash signature?** (The cmd.exe test was inconclusive due to .cmd file encoding issues from bash heredoc.)

## Strategy

Three parallel investigation tracks, each independently informative:

### Track A — Plugin isolation
Disable ALL plugins (omc, oh-my-copilot, ralph-wiggum) → exercise `copilot -p` → count hook errors → identify residual count. If errors → there's a Copilot-internal default. If zero → one of the still-enabled plugins is at fault.

### Track B — Bundle trace
Find the actual spawn invocation in `/c/.tools/.npm-global/node_modules/@github/copilot/app.js`. Start from `HookExitCodeError` (line 1193-1200) and trace backward through `m2` to find the `spawn`/`execFile` call. Identify shell, flags, and how the `command` field is passed.

### Track C — Marker probe (definitive)
Write a properly-encoded marker test using either (a) a precompiled Windows .exe (e.g., `cmd.exe /c echo > file` direct, with proper escaping in JSON), or (b) a Python script (using `python -c "..."`). Wire as the ONLY hook entry, exercise, verify whether the marker file is written. Cleanup MUST restore settings.json.

## Success criteria

All three must produce evidence; the closure verdict is reached when:
- The full list of crash sources is enumerated by name (which hooks.json files, which event, which command)
- The exact spawn invocation in app.js is identified (binary + args)
- At least one hook command form is empirically confirmed to fire successfully (marker probe writes)

## Acceptance criteria (per worker)

Worker-A returns: list of plugin disable steps tried + residual error counts + verdict on whether a Copilot-internal default exists.
Worker-B returns: file:line citation in app.js where the spawn occurs + the binary + the args + the shell wrapping. Findings in `.omc/research/phase-1.5-trace-B.md`.
Worker-C returns: marker probe wired + exercised + verdict (FIRE or NO_FIRE) + cleanup proof.

## Post-closure work (after Phase 1.5 verdict)

Update `docs/plans/orchestrator-v1-ralplan.md` Phase 2 section with the actual blocker resolution. If a Copilot-internal issue, file an upstream issue + ship a workaround in omcp setup. Then Phase 2 N+2 hook ports can resume.

## Non-goals

- Do NOT modify Copilot's bundle (read-only)
- Do NOT escalate to "rewrite everything as daemon" — daemon was already deferred in orchestrator-v1
- Do NOT bundle Phase 2 hook ports in this PR — Phase 2 is downstream of Phase 1.5
