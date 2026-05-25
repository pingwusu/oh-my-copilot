# Phase 2 IPC Mesh — Deterministic Attestation (US-omcp-parity-P2)

**Date**: 2026-05-25
**Mode**: deterministic (mock-spawn fallback per iter-2 H4)

## Environment

omcp v2.2.x EB-06, Phase 2 IPC mesh.
Harness: `src/scripts/smoke-ipc.ts` (version 1.0.0).
Renderer: `src/lib/smoke-template.ts` (shared with P1 + P3 + P4 smoke artifacts; drift detection now spans 4 consumers).
Trigger env: `OMCP_COPILOT_AUTH=missing` (CI mode; no real Copilot CLI invoked).
Exercised surfaces: team-heartbeat (Story 7) + team-outbox-write (Story 3) + team-outbox-read cursor (Story 4) + team-inbox-write (Story 6). All run in-process via injected hooks; no real spawns.

## Pre-condition

- No pre-existing .omcp/state/team/<sid>/ directory before the harness runs.
- A fresh tmp cwd for filesystem isolation.
- 4 simulated workers numbered 1..4 with no prior heartbeat / shard / outbox entries.

## Trigger

Sequence executed by `runIpcDeterministicSmoke()`:
Phase A. Each of 4 workers calls `omcp team-heartbeat` via runTeamHeartbeat (in-process). All 4 worker-<idx>-heartbeat.json files created with schema {ts, workerIndex, pid} per ADR-EB-05.
Phase B. Leader writes 2 inbox messages via runTeamInboxWrite (markdown bodies). File stays in inbox-1.md (under 1MB rotation threshold per ADR-EB-02 sibling contract).
Phase C. Each worker writes 3 outbox entries via runTeamOutboxWrite (12 total entries; consumer name = worker-N). Each call acquires the lockfile sidecar + appends a JSONL line + releases the lockfile.
Phase D. Leader reads outbox via runTeamOutboxRead for each worker-N consumer (per-consumer cursors). Each cursor advances independently from {0,0} to EOF.
Phase E. Second read pass returns zero entries (cursors at EOF) — verifies the cursor-advance contract.
Phase F. Cursor metadata persistence verified: all 4 outbox-cursor-worker-N.json files present on disk per ADR-EB-02 §4.

## Output

```
harness cwd=C:\Users\RUNJIA~1\AppData\Local\Temp\omcp-smoke-ipc-w6532v
phaseA: 4 workers wrote heartbeat.json
phaseA: heartbeat.json schemas validated — all 4 carry {ts, workerIndex, pid}
phaseB: leader wrote 2 inbox messages — inbox-1.md present, no rotation (under 1MB)
phaseC: 12 outbox entries written across 4 consumers
phaseD: leader read 48 entries via per-consumer cursors (4 consumers × 12 outbox lines; per-consumer counts: [{"consumer":"worker-1","count":12},{"consumer":"worker-2","count":12},{"consumer":"worker-3","count":12},{"consumer":"worker-4","count":12}])
phaseE: second-pass cursor read returns 0 new entries (cursors at EOF for all consumers)
phaseF: all 4 outbox-cursor-worker-N.json files persisted on disk
```

Key invariants verified by this trace:
- ADR-EB-05 §1 heartbeat schema: all 4 heartbeat.json files carry the {ts, workerIndex, pid} shape.
- ADR-EB-02 §1 outbox JSONL schema: 12 entries round-trip through write + cursor-read without loss.
- ADR-EB-02 §4 per-consumer cursor independence: 4 separate cursor files advance without cross-contamination.
- ADR-EB-02 §2 lockfile contract holds (no torn JSONL despite intra-process serialization).
- Inbox rotation guard (1MB) does NOT trigger when content stays small.

## Verdict

PASS — deterministic. All 4 EB-06 functional surfaces participate in this trace end-to-end. The shared smoke-template renderer keeps the section structure byte-identical to P1/P3/P4 attestations. Tag-gate per iter-2 §RELEASE-cut S4: ≥1 live-Copilot smoke artifact (across P1/P3/P4/IPC) is required before v2.2.0 LOCAL tag — `src/scripts/check-live-smoke.ts` (extended in this story) will scan the IPC artifact in the live-mode check alongside the v2.1 phase artifacts.

## References

- docs/plans/omcp-eb-06-ipc-mesh-iter2.md (US-omcp-parity-P2-IPC-smoke-artifact)
- docs/adr/ADR-omcp-eb-02-outbox-schema.md (outbox JSONL schema + 64KB cap)
- docs/adr/ADR-omcp-eb-05-heartbeat-freshness.md (3× multiplier + watchdog precedence)
- src/cli/commands/team-outbox.ts (Story 3 + Story 4)
- src/cli/commands/team-inbox.ts (Story 6)
- src/cli/commands/team-heartbeat.ts (Story 7)
- src/lib/smoke-template.ts (shared renderer)
- docs/smoke/omcp-team-parity/phase1-verify-fix-loop-deterministic-attestation.md
- docs/smoke/omcp-team-parity/phase3-chain-deterministic-attestation.md
- docs/smoke/omcp-team-parity/phase4-integration-deterministic-attestation.md
