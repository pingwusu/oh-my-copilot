# v1.8 N+1 baseline reverification attestation

**Date**: 2026-05-25
**Session**: N+1 (first execution session of iter-3 plan)
**Story**: US-1.8-T0-BASELINE-reverify
**Purpose**: Confirm v1.7.0 baseline is intact before N+1 work lands.

## git HEAD

```
8bfea68 (HEAD -> main, tag: v1.7.0) chore(release): v1.7.0 — outer-loop hardening + DEP0190 resolved + 5/6 v1.4 carry-forwards closed
```

8 recent commits visible:
```
8bfea68 chore(release): v1.7.0 — outer-loop hardening + DEP0190 resolved + 5/6 v1.4 carry-forwards closed
07b77f9 fix(setup): v1.7 US-03 DEP0190 resolved via `node <npm-cli.js>` (multi-direction team converged)
2202640 feat(setup): v1.7 US-04 — prefer `npm ci` when plugin lockfile exists
c8b1ece feat(doctor): v1.7 US-06 — stale hook commands check (carry-forward from v1.4 RCA)
7c762e7 refactor(mode): v1.7 US-07 — drop redundant --allow-all-tools for looping modes
1c87906 feat(mode): v1.7 M2 outer-loop continuation context injection
a5925c4 feat(mode): v1.7 M1 outer-loop stall detection
e2e2bac docs(architecture): consolidate v1.7→v2.0 roadmap + dedup HANDOFF forward-plan
```

Plus tip ahead of v1.7.0: `73fd9a2 docs(plans): v1.8->v2.0 ralplan iter-3 consensus (138 stories / 7 sessions)` (this ralplan commit).

## vitest

```
 Test Files  117 passed (118)
      Tests  1178 passed | 2 skipped (1188)
     Errors  1 error (pre-existing worker-fork EPERM file-level baseline; documented in handoff)
   Duration  136.88s
```

Matches handoff specification: 1178 / 2 / 0 + 1 documented EPERM baseline.

## tsc

```
npx tsc --noEmit → exit code 0, no diagnostics
```

Clean.

## 4-manifest version sync (Invariant 3)

```
package.json:                                            "version": "1.7.0",
.claude-plugin/plugin.json:                              "version": "1.7.0",
.agents/plugins/marketplace.json:                        "version": "1.7.0",
plugins/oh-my-copilot/.claude-plugin/plugin.json:        "version": "1.7.0",
```

All 4 in sync at 1.7.0. ✓

## Conclusion

Baseline is intact. N+1 work clears to proceed.

## Cross-references

- iter-3 plan: `docs/plans/v1.8-to-v2.0-ralplan-iter3.md`
- handoff: `docs/handoff-archive/2026-05-25-v1.8-to-v2.0-handoff.md`
- invariants: `docs/architecture/invariants.md`
