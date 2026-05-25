# v1.8 N+2 ralph resanity smoke

**Date**: 2026-05-25
**Trigger**: v1.8 Iter-3 plan — verify v1.6 outer-loop + v1.7 stall detection still work post-N+1 changes (US-05 added cost-governor post-spawn callback to outer loop).
**Result**: ✅ **PASS — all outer-loop semantics preserved**.

---

## HEAD state at smoke time

```
Commit: 974a43824a41ecda0d5f87cb281cc6847e502c03
Message: feat(cost-governor): add per-iteration outer-loop cost-summary state (ADR-C1 Option C)

Recent 8 commits:
974a438 feat(cost-governor): add per-iteration outer-loop cost-summary state (ADR-C1 Option C)
fac3ed9 refactor(tests): extract shared McpClient helper from MCP det tests (deslop)
5698cd4 docs(smoke): v1.8 Tier 3 MCP canary live-e2e template
75ee12a feat(doctor): add check-mcp-config integrity check (pulled forward from v1.9)
050afc9 feat(verify-catalog): add agent-catalog drift detection
aa4a608 test(agents): add 19-agent QA matrix deterministic check
c51c4a9 test(mcp-servers): add deterministic harness matrix (10 servers via it.each)
14c3ba4 test(routing): add OMCP_MODEL_FAMILY deterministic routing test (3 modes)
```

---

## Integration test suite verification

### Ralph outer-loop integration tests

```
npx vitest run src/__tests__/ralph-outer-loop.integration.test.ts

 Test Files  1 passed (1)
      Tests  8 passed (8)
   Start at  13:22:48
   Duration  14.67s (transform 248ms, setup 0ms, import 311ms, tests 14.06s, environment 0ms)
```

**All 8 integration tests pass.** The outer-loop contract is verified across deterministic test scenarios.

---

## Source code evidence — outer-loop semantics intact

### v1.6 feature: maxOuterIterations cap

**File**: `src/cli/commands/mode.ts`
**Lines**: 315-320, 340

```typescript
const rawMaxOuter = opts.maxOuterIterations ?? 20;
const maxOuter = Math.max(1, rawMaxOuter);
// ...
while (iteration <= maxOuter) {
```

✅ **Verified**: Loop termination capped at `maxOuter`. Input validation clamps to >= 1.

### v1.7 feature: stallBailAfter check

**File**: `src/cli/commands/mode.ts`
**Lines**: 321-326, 446-472

```typescript
const rawStallBail = opts.stallBailAfter ?? 2;
const stallBailAfter = Math.max(1, rawStallBail);
let prevCompleted = -1; // sentinel
let stallCount = 0;
// ...
if (prevCompleted !== -1 && (postRunPrd.status?.completed ?? 0) === prevCompleted) {
  stallCount++;
  if (stallCount >= stallBailAfter) {
    // ... preserve state and break
    break;
  }
} else {
  stallCount = 0;
}
prevCompleted = (postRunPrd.status?.completed ?? 0);
```

✅ **Verified**: Stall detection logic unchanged. PRD completed-count is tracked across iterations; after N consecutive zero-progress spawns, loop exits early while preserving state for resume.

### v1.7 feature: outerLoopOwned flag guard

**File**: `src/cli/commands/mode.ts`
**Lines**: 341-353, 414-423

```typescript
writeRalphState({
  // ...
  outerLoopOwned: true,  // ← Set on every iteration while loop owns it
});
// ...
if (exitCode !== 0) {
  // Restore snapshot WITHOUT outerLoopOwned, since outer loop exits
  writeRalphState({
    ...preSpawnRalphSnapshot,
    outerLoopOwned: false,  // ← Guard ensures hook-side code path won't double-increment
  });
}
```

✅ **Verified**: outerLoopOwned flag correctly deduplicates with upstream Stop-hook in case Copilot pwsh bug ever fixes (per v1.6 architect M3 finding — clearModeState moved OUT of per-iteration body to avoid race).

---

## US-05 N+1 change: cost-governor post-spawn callback

**Lines**: 385-410

```typescript
// ADR-C1 Option C: post-spawn callback — write cost entry for this
// iteration. Fires on both success and failure paths. Errors are
// non-blocking (log to stderr, continue).
{
  const postSpawnPrd = exitCode === 0 ? getPrdCompletionStatus() : null;
  const costEntry: CostSummaryEntry = {
    iterationNumber: iteration,
    durationMs: Date.now() - iterationStartMs,
    exitCode,
    estimatedCost: 0,
    modeName: opts.mode,
    prdProgress: /* ... */,
    timestamp: new Date().toISOString(),
  };
  try {
    writeCostSummary(sessionId, costEntry);
  } catch (err) {
    // Non-blocking: log to stderr, continue loop
    process.stderr.write(`omcp: cost-summary write failed (iteration ${iteration}): ${String(err)}\n`);
  }
}
```

✅ **Verified**: 
- Cost tracking callback is **non-blocking** (try/catch, error logged, loop continues).
- Inserted **after** `spawnSyncCrossPlatform` and **before** exit-code check.
- Does NOT modify loop termination logic (allComplete / stallBail / maxOuter / non-zero-exit paths unchanged).
- Does NOT mutate iteration counter, PRD state, or loop control flow.

---

## Verdict

**PASS.** v1.8 preserves all v1.6 + v1.7 ralph outer-loop semantics:

1. ✅ `maxOuterIterations` cap enforced (lines 315-320, 340, 490-491)
2. ✅ `stallBailAfter` zero-progress detection works (lines 321-326, 446-472)
3. ✅ `outerLoopOwned` guard intact (lines 352, 421, 465)
4. ✅ Integration tests: 8/8 pass
5. ✅ US-05 cost-governor callback is non-blocking insertion (no loop semantics change)
6. ✅ Loop termination conditions unchanged: allComplete → break, architectApproved → break, stallCount >= stallBailAfter → break, iteration > maxOuter → break

**Ready for v1.8 release.**
