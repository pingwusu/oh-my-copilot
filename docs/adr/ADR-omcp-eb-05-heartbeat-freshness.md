# ADR: Heartbeat Freshness Threshold + Watchdog Precedence Rule

**Date**: 2026-05-25
**Status**: Accepted (EB-06 Story 5 — sub-ADR; lands ahead of US-EB06-HEARTBEAT implementation)
**Author**: pingwusu
**Related**:
- `docs/plans/omcp-eb-06-ipc-mesh-iter2.md` (US-omcp-parity-P2-HEARTBEAT-write-poll AC + Decision Driver #3 + pre-mortem scenario 2 + scenario 4)
- `docs/adr/ADR-omcp-team-omc-parity-iter2.md` (master iter-2-OMC ADR — heartbeat is part of the Phase 2 IPC mesh deferred behind EB-06)
- `docs/adr/ADR-omcp-eb-02-outbox-schema.md` (sibling sub-ADR — pins outbox schema)
- `docs/adr/ADR-omcp-eb-06-ipc-mesh-revival.md` (master sub-ADR — pending; covers all 6 Phase 2 stories holistically)
- omc reference: `C:\Users\runjiashi\.claude\plugins\cache\omc\oh-my-claudecode\4.9.3\src\team\heartbeat.ts` + `worker-health.ts` + `bridge-entry.ts`

---

## Context

`omcp team-heartbeat <session-id> <worker-index>` (US-EB06-HEARTBEAT) writes a per-worker heartbeat marker file that the existing `runTeamWatchdog` consults for liveness detection. Without heartbeat, the watchdog has been relying on shard-file mtime as a liveness proxy (`src/cli/commands/team.ts:439-442`) since v1.0 — a worker that writes shards regularly is presumed alive; a worker whose shard mtime exceeds a threshold is presumed stuck.

The heartbeat layer is meant to:

1. **Decouple liveness from progress.** A worker doing a long-running computation (e.g., a multi-minute fix-worker spawn) writes heartbeat ticks even while no shard activity happens. Conversely a worker writing high-frequency shards from a runaway loop still gets flagged as stuck if it stops heartbeating.

2. **Survive NTFS mtime quantum races.** Windows NTFS reports mtime at 1/64 second resolution (15.625ms). A heartbeat writer and watchdog reader landing in the same quantum can produce a stale mtime read despite a concurrent write — the iter-2 plan's pre-mortem scenario 4. The fix: put the timestamp INSIDE the file as a JSON field.

This ADR pins:
- The on-disk schema for the heartbeat file.
- The freshness multiplier (3×) + interval default (30s).
- The watchdog precedence rule when both heartbeat + shard signals exist.
- The heartbeat-absent observability behavior (warning, not failure).

## Decision

### 1. Heartbeat file schema

Per worker, written to:

```
.omcp/state/team/<session-id>/worker-<index>-heartbeat.json
```

Schema (single JSON object, atomicWriteFileSync via Invariant 2):

```json
{
  "ts": "2026-05-25T00:00:00.000Z",
  "workerIndex": 1,
  "pid": 12345
}
```

| Field | Type | Required | Notes |
|---|---|---|---|
| `ts` | ISO-8601 string | yes | UTC; **THE primary freshness signal** |
| `workerIndex` | non-negative integer | yes | Matches the worker's `OMCP_TEAM_WORKER_INDEX` env var |
| `pid` | positive integer | yes | Producer's `process.pid`; used by `omcp doctor team-routing` for cross-checks |

No `version` field — schema versioning lives in this ADR.

### 2. Freshness threshold

**Default heartbeat interval**: 30 seconds (env override: `OMCP_HEARTBEAT_INTERVAL_S`).

**Freshness multiplier**: **3×** (env override: `OMCP_HEARTBEAT_FRESHNESS_MULTIPLIER`).

**Default freshness threshold**: 30s × 3 = **90 seconds**. A heartbeat is considered "fresh" when `Date.now() - Date.parse(heartbeat.ts) <= 90_000`.

### 3. Watchdog precedence rule (CRITICAL — this is the heart of the ADR)

`runTeamWatchdog` consults TWO possible liveness signals for each worker:

1. `worker-<idx>-heartbeat.json`'s `ts` field (if file exists + parses)
2. `worker-<idx>-shard.json`'s `statSync.mtimeMs` (existing v1.0 behavior)

**Precedence**:

```
IF heartbeat.json exists AND its `ts` field parses as a valid Date:
    USE heartbeat.json (primary signal — JSON-internal timestamp; NTFS mtime
    quantum irrelevant)
ELSE:
    FALL BACK to shard-mtime (existing v1.0 behavior; preserves back-compat
    with workers that don't call `omcp team-heartbeat`)
```

When `heartbeat.json` is present BUT its `ts` field is malformed or missing → also fall back to shard-mtime + emit a warning. This is permissive on purpose — a corrupt heartbeat file should never cause a watchdog crash.

### 4. Heartbeat-absent observability

When a worker's pidfile is present + no `heartbeat.json` exists for that worker AND the worker has been spawned for more than **2× heartbeat interval** (default 60 seconds), `runTeamWatchdog` emits a `[watchdog] worker-N not heartbeating` warning to `logLines`. This is a **warning, not a hard failure** — it surfaces silent-failure mode (a worker that's writing shards but never calls `omcp team-heartbeat`) without breaking back-compat with v2.1 workers.

The watchdog continues to use shard-mtime as the primary signal in this case (per §3 fallback rule). Workers that update SKILL.md to v2.2 protocol will start heartbeating + the warning silences itself naturally.

### 5. NTFS mtime quantum race mitigation

Per iter-2 plan pre-mortem scenario 4: Windows NTFS reports `statSync.mtimeMs` at 15.625ms resolution. Two writes 10ms apart can both report the same mtime; a watchdog reading mtime mid-write can see a stale value.

The §3 precedence rule mitigates this by reading the `ts` field INSIDE the heartbeat.json file rather than the file's mtime. The `ts` field is set by the producer at write time — never lossy under quantum collapse. The atomicWriteFileSync used for the heartbeat file ensures the read either sees the OLD complete content or the NEW complete content, never a mid-rename empty window.

### 6. omc calibration reference

omc's heartbeat (in `oh-my-claudecode/src/team/heartbeat.ts` + `worker-health.ts`):

- omc poll interval: **3 seconds** (`bridge-entry.ts:181 pollIntervalMs = 3000`)
- omc maxAge threshold: **30 seconds** (`worker-health.ts:47 heartbeatMaxAgeMs = 30000`) or **60 seconds** (`unified-team.ts:68 maxAge = 60000`) depending on call site
- omc multiplier effective: 10×–20× the poll interval

omcp diverges deliberately:

- omcp interval: **30 seconds** (10× omc's). Why: omcp's heartbeat is implemented as a Copilot CLI subprocess invocation (`omcp team-heartbeat`), which spawns a Node process per heartbeat. A 3-second cadence would mean each worker spends a non-trivial fraction of its time in heartbeat overhead. omc's in-process write is essentially free.
- omcp multiplier: **3×** (1/3 to 1/6 of omc's). Why: omcp's 30s interval already gives generous quantization margin; pushing to 10× would mean 5 minutes of dead-worker undetected, which is too sluggish for a fix-loop budget that defaults to 3 attempts.
- **Effective detection latency**:
  - omc: 30-60 seconds dead-worker detection
  - omcp: 60-90 seconds dead-worker detection (slightly slower but comparable; the additional latency is tolerated in exchange for not spawning subprocesses every 3 seconds)

Both tunable via env vars; operators on lighter machines can push omcp's interval down to match omc's cadence if they accept the subprocess overhead.

## Drivers

1. **NTFS mtime quantum unreliability** (§5) — drives the JSON-ts-primary signal design.
2. **Heartbeat cost vs detection latency** (§6) — drives the 30s interval + 3× multiplier vs omc's 3s+10×.
3. **Back-compat with v2.1 workers** — drives the §3 fallback rule + §4 warning-not-failure observability.

## Alternatives Considered

### Option A — Match omc's 3s interval + 10× multiplier (rejected)

- **Scope**: heartbeat every 3 seconds + 30s detection threshold.
- **Pros**: matches omc behavior exactly; smallest detection latency.
- **Cons**: each heartbeat is a fresh Node subprocess in omcp's model (omc's is in-process); 3s cadence × subprocess spawn cost ~50ms means each worker spends ~1.7% of its time heartbeating. Acceptable, but the marginal benefit vs omcp's chosen 30s + 3× is small.
- **Rejection rationale**: omcp's chosen calibration is intentionally slower to amortize subprocess cost. Operators who prefer omc-matching can override via env vars without changing the default.

### Option B — Use fs.mtime as the primary signal (rejected — the iter-2 plan's pre-mortem scenario 4 problem)

- **Scope**: read `statSync(heartbeatPath).mtimeMs` as the freshness clock.
- **Pros**: Zero parse cost; works without reading file contents.
- **Cons**: NTFS 15.625ms resolution + Windows AV scan cache can make reads see stale mtime despite a concurrent write. Real-world false-positive worker-dead risk.
- **Rejection rationale**: this is exactly the iter-1 critic CRITICAL finding; the JSON-ts design exists specifically to side-step it.

### Option C — JSON-ts primary, mtime fallback (CHOSEN)

- See §3.
- **Pros**: gets the best of both worlds — accurate timestamp from JSON field, with mtime fallback for workers that don't yet write heartbeat.json (v2.1 back-compat).
- **Cons**: requires a read of the heartbeat file content (not just stat). Cost: a single small JSON read per worker per watchdog poll; negligible.

### Option D — Heartbeat-absent → hard failure (rejected)

- **Scope**: if heartbeat.json missing AND worker has been spawned >2× interval, declare the worker dead immediately.
- **Cons**: breaks back-compat with v2.1 workers (they don't write heartbeat.json AT ALL); would mark every existing team session's workers as dead the moment v2.2 lands.
- **Rejection rationale**: §4 chose warning-not-failure for exactly this reason.

## Consequences

1. **Existing `runTeamWatchdog` extended** in US-EB06-HEARTBEAT — adds heartbeat.json read path + falls back to shard-mtime when absent. Test surface preserves all existing v1.0 watchdog tests + adds new ones for the heartbeat path.

2. **No new npm dep** — heartbeat schema is plain JSON + the existing atomicWriteFileSync runtime helper.

3. **2 new env vars** (`OMCP_HEARTBEAT_INTERVAL_S`, `OMCP_HEARTBEAT_FRESHNESS_MULTIPLIER`) — documented in this ADR + the `runTeamWatchdog` JSDoc.

4. **`omcp doctor team-routing` future enhancement**: could surface heartbeat freshness per-worker. Out of scope for EB-06; tracked as a polish follow-up.

5. **CHANGELOG entry** at v2.2.0 cut: "watchdog now uses heartbeat.json JSON-ts as primary signal with shard-mtime as fallback; v2.1 workers continue to be detected via shard-mtime without code changes."

## Follow-ups

1. US-EB06-HEARTBEAT (implementation) — consumes this ADR.
2. US-EB06-WORKER-SKILL — updates `skills/team-worker/SKILL.md` to instruct workers to call `omcp team-heartbeat` at task-start.
3. Master EB-06 ADR — finalized in EB-06 N+3 alongside CHANGELOG.
4. Post-v2.2 polish: `omcp doctor team-routing` surfaces per-worker heartbeat freshness.

## Tracking

- Source: iter-2 plan US-omcp-parity-P2-HEARTBEAT-write-poll AC + Decision Driver #3 + pre-mortem scenarios 2 + 4 (mtime quantum race)
- Implementation: lands in US-EB06-HEARTBEAT (next story).
- Tests: heartbeat.json roundtrip via atomicWriteFileSync; freshness check at 1× / 2.5× / 3× / 6× via injected time; NTFS-quantum simulation; 4-worker concurrent heartbeat race; heartbeat-absent warning emission.
