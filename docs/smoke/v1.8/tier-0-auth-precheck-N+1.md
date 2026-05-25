# v1.8 N+1 Copilot CLI auth precheck attestation

**Date**: 2026-05-25
**Session**: N+1 (first execution session)
**Story**: US-1.8-T0-AUTH-precheck
**Purpose**: Establish that Copilot CLI is authed before any live-e2e / mode-live work.

## Spawn

```
$ copilot --version
GitHub Copilot CLI 1.0.55-0.
```

```
$ echo 'say "ok"' | copilot -p --no-color
The `--no-color` flag is noted — output will be plain text without ANSI color codes. How can I help you today?

Changes    +0 -0
AI Credits 14.2 (28s)
Tokens     ↑ 22.1k • ↓ 140
```

Exit code 0. Copilot responded, consumed AI Credits (14.2) and tokens (22.1k up / 140 down). No `No authentication information found` error.

## Verdict

**Copilot CLI is AUTHED**. Live e2e + mode-live work clears to proceed in N+1 (canary MCP triage) and N+2 (LOOPING_MODES live verify).

## Token TTL

Not exposed in CLI output; Copilot uses GitHub OAuth refresh implicitly. No TTL to record.

## Failure-path runbook (preserved for documentation)

If a future precheck returns `No authentication information found`:
1. Run `copilot login`
2. Complete GitHub OAuth in browser
3. Re-run this precheck attestation

## Cross-references

- iter-3 plan: `docs/plans/v1.8-to-v2.0-ralplan-iter3.md` (US-1.8-T0-AUTH-precheck)
- handoff: `docs/handoff-archive/2026-05-25-v1.8-to-v2.0-handoff.md` (EB-01 USER_REQUIRED — now cleared for N+1)
