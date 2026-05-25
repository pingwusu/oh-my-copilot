# Phase 2 IPC Mesh — Live Attestation (US-omcp-parity-P2)

**Date**: 2026-05-25
**Mode**: live (real Copilot CLI)

## Environment

omcp v2.2.0 EB-06, Phase 2 IPC mesh.
Harness: `scripts/run-live-ipc-smoke.mjs` (operator-driven, version 1.0.0).
Renderer: hand-written (sibling of `src/lib/smoke-template.ts` shape — section headers identical to the 4 deterministic attestations).
Trigger env: GitHub Copilot CLI `copilot --version` GitHub Copilot CLI 1.0.55-0.; live auth verified by the §Output Copilot ping (§G below).
Exercised surfaces: team-heartbeat + team-outbox-write + team-outbox-read (cursor) + team-inbox-write. ALL 4 invoked as REAL `node dist/cli/omcp.js` subprocesses (NOT in-process mocks). Lockfile contention real; disk artifacts real.

## Pre-condition

- Fresh scratch dir at C:\Users\RUNJIA~1\AppData\Local\Temp\omcp-live-ipc-FGfJBl (`mkdtempSync` per-run).
- No pre-existing `.omcp/state/team/live-ipc-mplb5uyj/` directory before the harness ran.
- Copilot CLI authenticated under the current user (verified live by §G round-trip).
- `dist/cli/omcp.js` built at 2026-05-25T14:11:54.053Z.

## Trigger

Sequence executed by `scripts/run-live-ipc-smoke.mjs`:

Phase A. 4 real `node dist/cli/omcp.js team-heartbeat <sid> <idx>` subprocesses (one per worker index 1-4). Each writes `worker-<idx>-heartbeat.json` via atomicWriteFileSync per ADR-EB-05.
Phase B. 2 real `omcp team-inbox-write` subprocesses with markdown bodies. File stays in `inbox-1.md` (under 1MB rotation threshold).
Phase C. 12 real `omcp team-outbox-write` subprocesses (4 workers × 3 entries). Each acquires the lockfile sidecar + appends a JSONL line + releases. Real `openSync('wx', outbox.jsonl.lock)` race serialization.
Phase D. 4 real `omcp team-outbox-read --json` subprocesses (one per consumer). Each cursor advances independently from {0,0}.
Phase E. 4 second-pass `omcp team-outbox-read --json` subprocesses — must return 0 entries (cursors at EOF).
Phase F. Verify cursor files persisted at `outbox-cursor-worker-N.json`.
Phase G. `copilot -p` round-trip with a marker prompt — captures real Copilot CLI auth state under which a team-spawn worker would run. IPC verbs themselves do not invoke Copilot (they are pure-I/O state-management commands); this phase records the same auth state under which workers would execute their tasks.

## Output

```
harness scratch=C:\Users\RUNJIA~1\AppData\Local\Temp\omcp-live-ipc-FGfJBl
sessionId=live-ipc-mplb5uyj
phaseA: 4 real CLI heartbeat subprocesses spawned; files=worker-1-heartbeat.json,worker-2-heartbeat.json,worker-3-heartbeat.json,worker-4-heartbeat.json
phaseA: sample worker-1 heartbeat schema = {"ts":"2026-05-25T14:35:07.873Z","workerIndex":1,"pid":19692}
phaseB: 2 inbox messages written via real CLI; inbox-1.md bytes=60
phaseC: 12 outbox entries written via 12 real CLI subprocesses; outbox.jsonl lines=12
phaseD: 4 real CLI outbox-read subprocesses; total entries read = 48 (per-consumer = [{"c":"worker-1","n":12},{"c":"worker-2","n":12},{"c":"worker-3","n":12},{"c":"worker-4","n":12}])
phaseE: second-pass per-consumer reads returned 0 entries (cursors at EOF) — OK
phaseF: cursor files persisted = outbox-cursor-worker-1.json,outbox-cursor-worker-2.json,outbox-cursor-worker-3.json,outbox-cursor-worker-4.json
phaseG: real copilot -p round-trip ok=true; elapsed=50752ms; prompt-token=omcp-live-ipc-live-ipc-mplb5uyj-token; AI Credits 14.8 (46s)
```

Key invariants verified by this trace:
- ADR-EB-05 §1 heartbeat schema: all 4 `worker-N-heartbeat.json` files carry the {ts, workerIndex, pid} shape from REAL CLI invocations.
- ADR-EB-02 §1 outbox JSONL schema: 12 entries round-trip through write + cursor-read without loss across 12 real subprocess spawns.
- ADR-EB-02 §4 per-consumer cursor independence: 4 separate cursor files advance without cross-contamination under real CLI execution.
- ADR-EB-02 §2 lockfile contract holds under real cross-process contention (no torn JSONL even when 12 short-lived subprocesses race for the same outbox.jsonl.lock).
- Inbox rotation guard (1MB) does NOT trigger when content stays small (real measurement: 60 bytes).
- GitHub Copilot CLI live auth verified by §G (round-trip succeeded).

## Verdict

PASS — live. All 4 EB-06 functional surfaces participate in this trace end-to-end via real `node dist/cli/omcp.js` subprocesses. Real lockfile contention, real disk artifacts, real Copilot CLI auth round-trip. Tag-gate per iter-2 §RELEASE-cut S4 is SATISFIED by this artifact for the v2.2.0 LOCAL tag.

## References

- docs/plans/omcp-eb-06-ipc-mesh-iter2.md (US-omcp-parity-P2-IPC-smoke-artifact)
- docs/adr/ADR-omcp-eb-02-outbox-schema.md (outbox JSONL schema + 64KB cap)
- docs/adr/ADR-omcp-eb-05-heartbeat-freshness.md (3× multiplier + watchdog precedence)
- docs/adr/ADR-omcp-eb-06-ipc-mesh-revival.md (master decision record)
- src/cli/commands/team-outbox.ts
- src/cli/commands/team-inbox.ts
- src/cli/commands/team-heartbeat.ts
- scripts/run-live-ipc-smoke.mjs (this harness)
- docs/smoke/omcp-team-parity/ipc-mesh-deterministic-attestation.md (sibling deterministic)
