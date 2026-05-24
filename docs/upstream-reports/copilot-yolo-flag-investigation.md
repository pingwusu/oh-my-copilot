# Copilot CLI flags + autopilot-skill investigation

**Date**: 2026-05-24
**Copilot version**: `GitHub Copilot CLI 1.0.53-2` (live `copilot --version` output)
**Bundle inspected**: `C:\.tools\.npm-global\node_modules\@github\copilot\` (`package.json` reports `"version": "1.0.32"` — bundle versioning is internal; CLI banner reports `1.0.53-2`)
**Investigator**: subagent (resumed run)

## Summary

`--yolo` is **purely a permission-bundle shortcut** equivalent to `--allow-all-tools --allow-all-paths --allow-all-urls`; it has **no special effect on hook dispatch**. `--autopilot` (bare) and `--mode autopilot` are **not synonyms in the public CLI surface**: `--autopilot` is a top-level boolean meaning "keep continuing in non-interactive `-p` mode until done", whereas `--mode <mode>` is the **initial agent mode selector** with choices `interactive | plan | autopilot`. There is **no built-in `autopilot` skill** in the shipped bundle — only one skill ships (`customize-cloud-agent`). The user's hypothesis that a built-in autopilot skill proves hooks work is mistaken in its premise, but **the conclusion is still correct**: hooks (PostToolUse, Stop/agentStop, SessionEnd) DO fire in non-interactive `-p`/`--autopilot` mode per official docs. The previous session's "upstream broke Stop hook dispatch in 1.0.53-1" claim is therefore **DISPUTED**; the more likely root cause is omcp's own Stop hook handler script exiting non-zero (which is what `HookExitCodeError: code 1` literally means), or a payload-shape mismatch (camelCase vs PascalCase event names — both are supported, but the handler may only match one).

## Part 1: --yolo flag

### What it does

From bundled `copilot --help` (live output) and the embedded `permissions` help topic in `app.js`:

> `--yolo  Enable all permissions (equivalent to --allow-all-tools --allow-all-paths --allow-all-urls)`

And from `app.js` line ~7198 (permissions help topic body):

> "The --allow-all and --yolo flags are equivalent shortcuts that enable all permissions at once. They are equivalent to specifying --allow-all-tools --allow-all-paths --allow-all-urls together. These flags are useful for non-interactive scripts or when you want to run without any confirmation prompts."

The flag is purely a **permission preset**. It does not name, gate, or alter any hook-dispatch code path in the bundle. The string `yolo` appears in `app.js` only inside three regions: the option declaration, the permissions help text, and the usage-examples block (line ~7204, 7314). No `if (yolo) ...` or `if (allowAll) ... skip hooks ...` logic was found.

### Effect on hooks

**None on dispatch**. `--yolo` only suppresses *permission prompts*, not hook events. The hooks that exist (postToolUse, preToolUse, sessionStart, sessionEnd, agentStop, postToolUseFailure, etc.) are dispatched by an independent code path:

- `app.js` line ~1197 references `Additional guidance from postToolUseFailure hook:`
- `app.js` line ~2532 references `Additional context from preToolUse hook:`
- `schemas/session-events.schema.json` line ~4292 documents the `hook.start` / `hook.end` session-event entries with `hookType` field carrying values like `"preToolUse"`, `"postToolUse"`, `"sessionStart"`

The official docs page <https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/use-hooks> notes that **prompt hooks** (specifically `userPromptSubmitted`/`UserPromptSubmit`) do NOT fire in `-p` mode. Other hooks (including `agentStop`/`Stop` and `sessionEnd`/`SessionEnd`) are documented as firing.

What `--yolo` indirectly affects: with all permissions auto-granted, the `permissionRequest` hook will see no requests (because nothing is gated). This is a side effect of permission bypass, not of hook plumbing.

### Compatibility with --autopilot

**Orthogonal**. Both flags are independent options in the same option list (`copilot --help`). The official autopilot doc <https://docs.github.com/en/copilot/concepts/agents/copilot-cli/autopilot> gives the canonical programmatic invocation:

```
copilot --autopilot --yolo --max-autopilot-continues 10 -p "YOUR PROMPT HERE"
```

So `--autopilot` and `--yolo` are **expected to be combined** for non-interactive loop scripting. Neither requires the other syntactically (the CLI accepts each alone), but for unattended loops both are needed: `--autopilot` to keep continuing past first turn, `--yolo` to skip every permission gate that would otherwise stall the loop.

### Confidence: High

Source: live `copilot --help`, in-bundle permissions help topic text in `app.js`, and the official GitHub docs autopilot page.

## Part 2: --mode autopilot flag

### Difference from bare --autopilot

From live `copilot --help`:

```
--autopilot                           Start in autopilot mode
--mode <mode>                         Set the initial agent mode (choices:
                                      "interactive", "plan", "autopilot")
--max-autopilot-continues <count>     Maximum number of continuation messages
                                      in autopilot mode (default: unlimited)
```

These are two distinct option declarations. Reading them strictly:

- `--autopilot` is a boolean flag whose described action is "Start in autopilot mode".
- `--mode autopilot` is one of three choices for the `--mode <mode>` option whose description is "Set the initial agent mode".

The README confirms autopilot is also a runtime-cycle-able mode: "Autopilot is a new mode (press `Shift+Tab` to cycle through modes)". The `--mode <mode>` flag is the programmatic equivalent of the Shift+Tab toggle.

The autopilot doc page (`docs.github.com/.../autopilot`) and the official example use `--autopilot`, not `--mode autopilot`, and explicitly state `--autopilot only applies to non-interactive -p mode`. This strongly implies they are functionally similar but not identical:

- `--autopilot` is the **non-interactive-loop activator** (couples to `-p`, drives `--max-autopilot-continues`).
- `--mode autopilot` is the **initial-mode setter** that mostly matters for interactive sessions (it picks which mode the interactive UI starts in).

In practice for non-interactive scripts: `--autopilot` is the canonical flag. `--mode autopilot` may also work in `-p` (since autopilot is a valid mode choice), but the docs only show `--autopilot` for that case.

### Which is canonical

For omcp's use case (non-interactive looping), `--autopilot` is canonical. No deprecation notice was found for either flag.

### Confidence: High (for canonical recommendation), Medium (on the exact behavioral overlap between the two — bundle code obfuscation makes it hard to confirm whether they share the same internal state)

## Part 3: Built-in autopilot skill

### Skill location

**There is NO built-in `autopilot` skill.** Full enumeration of `C:\.tools\.npm-global\node_modules\@github\copilot\builtin-skills\`:

```
builtin-skills\customize-cloud-agent\SKILL.md
```

That is the **only** entry. No `autopilot/`, no `loop/`, no `long-session/`. The directory ships exactly one skill manifest.

For completeness, `definitions/` ships six agent YAMLs (`code-review.agent.yaml`, `configure-copilot.agent.yaml`, `explore.agent.yaml`, `research.agent.yaml`, `rubber-duck.agent.yaml`, `task.agent.yaml`). None of them are named `autopilot`.

### Skill manifest contents

The only built-in skill is `customize-cloud-agent`:

```yaml
---
name: customize-cloud-agent
description: >-
    Skill for customizing the Copilot cloud agent (formerly known as Copilot coding agent) environment,
    including copilot-setup-steps.yml configuration, preinstalling tools and dependencies, runners, and settings.
user-invocable: false
---
```

The body documents `copilot-setup-steps.yml` for cloud-agent GHA runners. **Nothing in it references hooks, autopilot mode, looping, or `--yolo`.** It is unrelated to local CLI looping.

### Hook usage (does it register Stop / PostToolUse / SessionEnd?)

The skill does not register or rely on hooks. The user's hypothesis — that the existence of a built-in autopilot skill proves hooks fire in long loops — **rests on a false premise** (no such skill exists in the bundle). The hypothesis's *conclusion* (hooks DO fire in autopilot) happens to be correct per official docs, but not via the cited mechanism.

### Required flags to activate

N/A — there is no autopilot skill to activate. Autopilot is a **CLI mode**, not a skill. It is activated by `--autopilot` (programmatic) or `Shift+Tab` (interactive) or `--mode autopilot` (init mode setter).

### Confidence: High

The bundle's `builtin-skills/` directory has exactly one entry. Glob enumeration was exhaustive (the `Glob` tool listed every file under that path).

## Part 4: Recommendation for omcp runMode

### Recommended arg list: **(d) `--autopilot --yolo`**

Concretely, `src/cli/commands/mode.ts:241-247` should be updated from:

```ts
if (LOOPING_MODES.has(opts.mode)) {
  args.push("--autopilot");
  if (opts.maxContinues !== undefined) {
    args.push("--max-autopilot-continues", String(opts.maxContinues));
  }
}
```

to:

```ts
if (LOOPING_MODES.has(opts.mode)) {
  args.push("--autopilot", "--yolo");
  if (opts.maxContinues !== undefined) {
    args.push("--max-autopilot-continues", String(opts.maxContinues));
  }
}
```

(Note: `--yolo` will functionally supersede the `--allow-all-tools` pushed at line 239 since `--yolo` already implies `--allow-all-tools`. Pushing both is harmless but redundant. A follow-up cleanup could replace the `--allow-all-tools` push with `--yolo` whenever a looping mode is used — but that is a tidy-up, not a correctness fix.)

### Evidence supporting this choice

1. **Official GitHub autopilot doc** gives the canonical programmatic example as `copilot --autopilot --yolo --max-autopilot-continues 10 -p "..."` — exact match to omcp's looping-mode use case. Source: <https://docs.github.com/en/copilot/concepts/agents/copilot-cli/autopilot>.
2. **The user's own reported working invocation** was `copilot --mode autopilot --yolo`. The user's data point confirms `--yolo` is needed for unattended runs (otherwise permission prompts stall the loop). It does NOT confirm `--mode autopilot` vs `--autopilot` matters — the user did not test the variant without `--mode`.
3. **`--autopilot` (not `--mode autopilot`) is what the official doc recommends for `-p` mode.** `--mode autopilot` is for setting initial interactive mode; while it likely also works with `-p`, the doc only commits to `--autopilot` for non-interactive loops.
4. **`--yolo` adds no hook-dispatch risk** (Part 1) and is required to avoid mid-loop permission stalls when novel tools/paths are touched (especially under MCP servers omcp doesn't enumerate at startup).

### Confidence: High

The recommendation matches the official documented programmatic pattern verbatim, and there is no evidence that flipping `--autopilot` to `--mode autopilot` would do anything beneficial in `-p` mode.

## Part 5: Re-evaluation of "1.0.53-1 Stop hook broken upstream" claim

### Original claim

Previous session: smoke-tested against Copilot 1.0.53-1, observed 3/3 Stop hook handlers exit `HookExitCodeError: code 1` (lines 1505/1523/1541 of `process-1779613937047-31476.log`), concluded Copilot upstream broke Stop hook dispatch.

### New evidence from Parts 1-3

1. **Hook plumbing exists and is documented active in non-interactive mode** — official hooks reference page enumerates `agentStop`/`Stop` as a real hook event; only *prompt* hooks (`userPromptSubmitted`/`UserPromptSubmit`) are documented as suppressed in `-p`.
2. **Two payload-format conventions are supported in parallel**: camelCase (`agentStop`, payload uses `hook_event_name`-style camelCase fields) AND PascalCase ("VS Code compatible", `Stop`). Both are valid. A handler script registered under one name may not see events dispatched in the other format if the handler does naive key-matching.
3. **Naming gotcha**: the Claude Code ecosystem uses PascalCase (`Stop`, `PostToolUse`, `SessionEnd`). The Copilot CLI bundle internally uses camelCase as the canonical schema (`preToolUse`, `postToolUse`, `sessionStart` per `schemas/session-events.schema.json:4294`). If omcp's hook handler script copy-pasted Claude Code's payload-parsing logic, it may attempt to read fields like `payload.hook_event_name === "Stop"` while Copilot is sending the camelCase variant first. This would cause a silent mismatch that exits non-zero.
4. **`HookExitCodeError: code 1` is a generic exit-code error**: the handler script ran and returned 1. That is the literal meaning. It does NOT mean "Copilot failed to dispatch"; it means "Copilot dispatched, and the handler exited non-zero". Copilot then surfaces that as `HookExitCodeError`. (Source: this error class name appears in the Copilot bundle string `Tool "${r}" failed. ` formatted by `Ker` function at `app.js:1197`, which prefixes `postToolUseFailure hook` messages — i.e., it's wired into the normal hook pipeline, not a dispatch failure.)

### Verdict: **DISPUTED**

The previous session's evidence (3/3 Stop hook handlers exit code 1) does **not** distinguish between:
- (A) Copilot broke Stop dispatch — handlers never ran, error fabricated upstream
- (B) Copilot dispatched correctly — handlers ran and exited 1 for some script-side reason
- (C) Copilot dispatched with PascalCase, omcp handler expected camelCase (or vice versa) — handlers ran, failed to find matching event, exited 1
- (D) Copilot dispatched correctly, handlers ran, but omcp's missing `--yolo` caused mid-execution permission prompts that confused the loop state (less likely but plausible)

The "upstream broke" framing assumes (A) without evidence. Reality is more likely (B) or (C). The previous session's docs claiming upstream breakage should not be filed as an upstream issue against Copilot CLI without first:

1. Re-running with `--autopilot --yolo` (per Part 4 recommendation).
2. Inspecting the actual Stop hook handler script (omcp side) to confirm what it does on event payload it doesn't recognize.
3. Diffing camelCase vs PascalCase payload field expectations in omcp's handler vs Copilot's emit format.

### Most likely real cause

Most probable: **the omcp Stop hook handler script returns exit code 1 on certain Copilot payload shapes** — either because of camelCase/PascalCase field-name mismatch, or because the handler logic checks a condition that fails on Copilot's actual `agentStop` payload (e.g., it tries to read `tool_name` which only exists on `postToolUse`, or reads `reason` enum values Copilot emits like `"end_turn"` that omcp doesn't whitelist).

Secondary contributing factor: omcp's looping invocation is missing `--yolo`, which is documented as required for unattended non-interactive runs. This may not be the primary cause of the Stop hook errors specifically, but it is a separate latent bug that would cause permission-prompt stalls.

### Confidence: Medium-High

The verdict is solid (the previous session's evidence is insufficient to prove upstream breakage). The "most likely real cause" specifically is medium confidence — to upgrade to High, I would need to read the actual omcp Stop hook handler at `src/hooks/persistent-mode/index.ts` and verify the payload-shape mismatch hypothesis. That is out of scope for a read-only investigation.

## Open questions / uncertainties

1. **Exact internal relationship between `--autopilot` and `--mode autopilot`**: in `-p` mode, do they produce identical internal state, or does one of them additionally disable some prompt path? `app.js` is obfuscated; verifying this requires reading minified mode-state code with renamed identifiers, which was attempted but inconclusive.
2. **camelCase vs PascalCase emission order**: when Copilot dispatches a Stop event, does it emit one payload in both formats sequentially, or does it pick one based on which event name the handler was registered under? The official doc says "Two payload formats are supported, selected by the event name used in the hook configuration" — implying registration-by-name decides emission format. omcp's actual hook config (in `~/.copilot/hooks.json` or repo `.copilot/hooks.json`) would need to be inspected to confirm what name omcp's handler is registered under. This is the highest-value follow-up to confirm/refute the Part 5 "most likely real cause".
3. **Whether `postToolUseFailure` is the actual error class that produced the `HookExitCodeError: code 1` lines**: `app.js:1197` shows `postToolUseFailure` is the named hook that surfaces tool failure messages. If those 3 errors in the log are actually `postToolUseFailure` events that fire because some tool exited non-zero (not Stop hook dispatch failures at all), then the previous session may have misread the log entirely. To close: inspect the actual log file `process-1779613937047-31476.log:1505,1523,1541` to confirm whether the error context is a Stop event or a `postToolUseFailure` event.
4. **Version mismatch oddity**: `package.json` says `"version": "1.0.32"` but `copilot --version` prints `1.0.53-2`. The bundle ships under `@github/copilot` with `buildMetadata.gitCommit: "4e4bccc"`. This is likely because npm-installed bundle is a stable train (1.0.32) but the runtime CLI in PATH is from a different install (winget/homebrew install at 1.0.53-2). For the investigation this didn't matter — both versions ship the same hook plumbing per the schema — but it is worth noting that the **previous session tested 1.0.53-1 while the live CLI now reports 1.0.53-2**; the 1-patch bump may include a hook-related fix that further muddies the "upstream broken" claim.

## Sources

- Live `copilot --help` output (CLI 1.0.53-2)
- Live `copilot --version` output (`GitHub Copilot CLI 1.0.53-2.`)
- `C:\.tools\.npm-global\node_modules\@github\copilot\app.js` — bundle JS (lines ~1197, ~2532, ~7128-7209 for permissions help text)
- `C:\.tools\.npm-global\node_modules\@github\copilot\schemas\session-events.schema.json` — lines ~4292, ~4365 (hook event schema)
- `C:\.tools\.npm-global\node_modules\@github\copilot\builtin-skills\customize-cloud-agent\SKILL.md` — only built-in skill
- `C:\.tools\.npm-global\node_modules\@github\copilot\definitions\*.agent.yaml` — six built-in agents, none named autopilot
- `C:\.tools\.npm-global\node_modules\@github\copilot\package.json` — bundle metadata
- <https://docs.github.com/en/copilot/concepts/agents/copilot-cli/autopilot> — autopilot programmatic example: `copilot --autopilot --yolo --max-autopilot-continues 10 -p "..."`
- <https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/use-hooks> — hooks usage; prompt hooks not in `-p`
- <https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-hooks-reference> — full hook event list, both camelCase and PascalCase, both formats officially supported
- <https://github.com/github/copilot-cli/issues/1652> — community report that `--yolo` regressed in 0.0.410-0.0.415 (still pauses for confirmation in some phases); evidence that `--yolo` behavior has shifted between versions
