# Copilot CLI `modifiedResult` empirical verification

**Date:** 2026-05-22
**Status:** **FAIL** (with caveat — see "What we learned" below)
**Required by:** Phase 1 of `docs/plans/hooks-parity-v3.md` — HARD GATE for Phase 4 hallucination-shield.

---

## Question

Does Copilot CLI 1.0.48 honor the `modifiedResult` field in a `PostToolUse` hook's stdout JSON?

## Outcomes designed into the v3 plan

| Outcome | What it means | Downstream consequence |
|---------|---------------|------------------------|
| **PASS** | Model sees the hook-injected canary in place of the actual file content. Replacement semantics work. | Phase 4 (hallucination shield) proceeds as designed — proactive output rewriting. |
| **APPEND** | Model sees both original AND canary. Field behaves like `additionalContext`. | Phase 4 acceptance amended — shield annotates only, doesn't replace. |
| **FAIL** | Model sees only the original; canary ignored. | Phase 4 reverts to v2-style advise-only fallback. Phase 5 audit-logger still ships. |

## Verdict: **FAIL** (with critical caveat)

The empirical smoke test, executed via `node scripts/smoke/run-modifiedresult-smoke.mjs` against Copilot CLI 1.0.48 at `/c/.tools/.npm-global/copilot.cmd` in `-p` (non-interactive) mode, returned:

```
VERDICT=FAIL
hasCanary=false hasOriginal=true
exitCode=0  (after gh auth login + GH_TOKEN env var supplied)
```

The model's actual response was: `` The exact first line is `"SENTINEL_ORIGINAL_PAYLOAD_BANDIT_77"`. `` — i.e., it saw the original file content, NOT the `CANARY_REPLACEMENT_PAYLOAD_KESTREL_42` string the probe emitted.

### Critical caveat: hooks didn't fire at all in `-p` mode

Three independent diagnostic runs confirmed: **the probe hook never executed**. The probe writes to `~/.copilot/omcp-smoke-probe.log` on every fire — that file never appeared even after:
- Wiring 6 event-name variants in parallel (`postToolUse` + `PostToolUse` + `preToolUse` + `PreToolUse` + `userPromptSubmitted` + `UserPromptSubmit`) with matcher `"*"`
- Replacing the node-script probe with a stripped-down `.cmd` echo probe (no Node, no path issues)
- Running with `--allow-all-tools --allow-all-paths` (no permission gates)
- Authenticated session (`gh auth login` + `GH_TOKEN` env var)

**So the FAIL verdict is technically "hooks did not fire" — NOT "modifiedResult was ignored."**

For Phase 4 gating purposes, both lead to the same conclusion: **do not depend on `modifiedResult` semantics in v1**. But the underlying empirical finding is broader and more important.

## What we learned

1. **Copilot CLI 1.0.48 in `-p` (non-interactive) mode appears to skip the hooks subsystem entirely.** Confirmed across 3 probe-shape variants × multiple event-name variants × valid matcher `"*"`.
2. **omcp's existing regression test (`copilot-hook-events-validation.test.ts`) is structurally correct but insufficient.** It verifies that `OMCP_HOOK_EVENTS` only contains names in `COPILOT_VALID_EVENTS`. It does NOT verify that wired hooks actually fire when Copilot runs. The v0.9.1 P0 fix addressed *name correctness*; an additional integration test is needed for *firing behavior* — but such a test must run interactively (TUI), which is difficult to automate in CI.
3. **Whether hooks fire in interactive (`-i` / TUI) mode is empirically unknown from this session.** The user's installed `oh-my-copilot v0.4.0` plugin would have wired hooks via `omcp setup`; if interactive sessions observe omcp's hook effects (skill injection, status line, etc.), interactive hooks fire. But we have no quantitative evidence in this session for either branch.
4. **The Copilot bundle code at `~/.tools/.npm-global/node_modules/@github/copilot/app.js` does contain real hook-execution machinery** (e.g., `HookCommandWarningError`, `HookExitCodeError`, `postToolUseFailure` hook integration). The dispatch system exists; we just haven't observed it firing in non-interactive mode.

## Action taken per the smoke test verdict

Per Architect iter-3 condition 1 (FAIL branch):

- **Phase 4 (hallucination shield) ships as advise-only fallback** — uses `{kind: "advise", text: "..."}` to inject annotations post-hoc; does NOT use `{kind: "modifiedResult"}`.
- **PII redactor → advise-only.** Reports detected PII via advise; does not rewrite tool output.
- **Output truncator → advise-only.** Reports large-output detection via advise.
- **Phase 5 (interrupt-only cost governor / loop detector / audit logger) is UNAFFECTED.** It uses `block`/`interrupt`/append-only state writes — proven mechanisms.
- **Phase 7 (modifiedArgs surgeon mode) remains independently gated** on its own smoke test. The FAIL of `modifiedResult` here does NOT preclude `modifiedArgs` working — but Phase 7 has its own empirical gate that must run interactively to be conclusive.

## Reproducibility checklist (for a future interactive verification)

To re-test under interactive mode:

1. Manually launch `copilot` (TUI mode)
2. Pre-wire the probe at `~/.copilot/config.json` `hooks.PostToolUse` (or other event)
3. In the TUI, send a prompt that uses a real tool (Read, Bash, etc.)
4. After the response renders, check `~/.copilot/omcp-smoke-probe.log` — if it has entries, the hook fired
5. If the hook fired but the response still references the ORIGINAL payload, then `modifiedResult` is ignored even when hooks DO fire — Phase 4 stays advise-only
6. If the hook fired AND the response references the CANARY, then `modifiedResult` DOES work in interactive mode — Phase 4 can be upgraded to true replacement semantics in a follow-up release

If a future session confirms interactive-mode hooks fire and `modifiedResult` works, the Phase 4 advise-only fallback can be upgraded — this is a forward-compatible decision (no breaking changes to existing consumers).

## Test apparatus (still in repo for re-use)

- `scripts/smoke/probe-modifiedresult.mjs` (Node probe; supports a kind arg)
- `scripts/smoke/probe-simple.cmd` (CMD probe; even simpler)
- `scripts/smoke/canary-original.txt` (known-content target)
- `scripts/smoke/run-modifiedresult-smoke.mjs` (idempotent harness; backup-then-restore)
- `scripts/smoke/smoke-output.log` (last run's captured stdout/stderr/verdict)
