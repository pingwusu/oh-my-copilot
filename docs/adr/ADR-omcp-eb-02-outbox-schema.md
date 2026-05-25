# ADR: Outbox JSONL Schema + 64KB Cap + Concurrency Contract

**Date**: 2026-05-25
**Status**: Accepted (EB-06 Story 2 — sub-ADR, lands ahead of OUTBOX-write-helper implementation)
**Author**: pingwusu
**Related**:
- `docs/plans/omcp-eb-06-ipc-mesh-iter2.md` (iter-2 plan US-omcp-parity-P2-OUTBOX-write-helper AC + Decision Driver #1)
- `docs/adr/ADR-omcp-team-omc-parity-iter2.md` (master iter-2-OMC ADR; outbox is part of the Phase 2 IPC mesh deferred behind EB-06)
- `docs/adr/ADR-omcp-eb-05-heartbeat-freshness.md` (sibling sub-ADR — pending; pins heartbeat freshness threshold)
- `docs/adr/ADR-omcp-eb-06-ipc-mesh-revival.md` (master sub-ADR — pending; covers all 6 Phase 2 stories holistically)
- omc reference: `C:\Users\runjiashi\.claude\plugins\cache\omc\oh-my-claudecode\4.9.3\src\team\outbox.ts` (prior art)

---

## Context

`omcp team-outbox-write <session-id> <consumer> <jsonPayload>` (US-EB06-OUTBOX-WRITE) writes JSONL entries to a per-session outbox file consumed by leader-side readers via byte-offset cursors. The outbox file lives at:

```
.omcp/state/team/<session-id>/outbox.jsonl
```

Multiple worker processes write to the SAME outbox file concurrently. NTFS does NOT guarantee atomic append semantics across processes on Windows (POSIX `O_APPEND` semantics are unreliable on Windows; `fs.appendFileSync` can interleave bytes mid-write under multi-process contention). The verify/fix loop + chain orchestration both depend on the outbox being a reliable, byte-clean JSONL stream that downstream cursor readers can parse one line at a time.

This ADR pins the wire format + the concurrency contract + the line-cap policy so subsequent stories (OUTBOX-read-cursor, INBOX-write, IPC-smoke-artifact) consume a stable schema.

## Decision

### 1. JSONL line schema (source-of-truth for wire format)

Every entry written to `outbox.jsonl` is a single JSON object on a single line (newline-terminated). Required fields:

```json
{
  "ts": "2026-05-25T00:00:00.000Z",
  "consumer": "ralph-verifier",
  "payload": { /* arbitrary JSON */ }
}
```

| Field | Type | Required | Notes |
|---|---|---|---|
| `ts` | ISO-8601 string | yes | UTC; written by the producer at append time |
| `consumer` | non-empty string | yes | Logical consumer name; matches the cursor file `outbox-cursor-<consumer>.json`; conforms to `assertSafeSlug` |
| `payload` | any JSON value | yes | Producer-defined; size capped (see §3) |
| `truncated` | boolean | optional | Present + `true` ONLY when the payload was truncated under the 64KB cap (see §3) |
| `original_bytes` | number | optional | Present only when `truncated: true`; the original `Buffer.byteLength` BEFORE truncation |

No `version` field: schema versioning lives in this ADR. Breaking changes ship a new ADR + a v2.x.0 release that documents migration. Additive fields (e.g., `producer_pid`) are allowed without ADR amendment; consumers MUST ignore unknown fields.

### 2. Concurrency contract — hand-rolled lockfile

The outbox is single-file shared-writer across multiple processes. The chosen contention strategy is a hand-rolled lockfile sidecar:

- **Lock file path**: `.omcp/state/team/<sid>/outbox.jsonl.lock`
- **Acquire mechanism**: `fs.openSync(<lockPath>, 'wx')` — exclusive-create. Fails with EEXIST when lockfile already present.
- **Retry strategy**: exponential backoff with the sequence `[50, 100, 200, 400, 1000, 2500]` ms (5 retries, 4.25s total budget). After all retries exhausted, exit code 4 (`lock-contention`).
- **Hold sequence**: open → `fs.appendFileSync(<outboxPath>, line)` → `fs.closeSync(lockFd)` → `fs.rmSync(<lockPath>)`. Always run in try/finally so a thrown append leaves the lockfile cleaned up.
- **Stale-lockfile policy**: before each retry, check `fs.statSync(<lockPath>).mtimeMs`. If the lockfile is older than **30 seconds**, treat it as a crash-leftover from a prior writer and force-remove (`fs.rmSync(<lockPath>, { force: true })`) before the next retry. 30s is well above the worst-case healthy hold duration (single appendFileSync + closeSync ~10-100ms) so the staleness check cannot misfire on a healthy writer.
- **Crash recovery**: a writer that crashes mid-hold leaves the lockfile + (possibly) a partial last line in `outbox.jsonl`. The reader (US-EB06-OUTBOX-READ-CURSOR) MUST tolerate a trailing incomplete JSON line gracefully — see §5.

### 3. Line cap — 64KB Buffer.byteLength

Per Architect + Critic consensus on iter-2 plan Open Question #2: **every JSONL line is capped at 65 536 bytes** (`Buffer.byteLength(line, "utf8")`) inclusive of the trailing newline.

When the producer's serialized line would exceed the cap:

1. Truncate the `payload` field. Strategy: serialize the FULL line with `truncated: true` + `original_bytes: <N>` markers, then trim the `payload`'s JSON serialization to fit. Workers should NOT rely on truncated payloads being JSON-valid; the consumer detects `truncated: true` and treats the payload as opaque text up to the cap.
2. Total emitted line still <= 65 536 bytes including the trailing `\n`.
3. The cap is enforced at WRITE time only. Readers do not re-check; they trust the writer's contract.

Rationale: 64KB matches `Buffer.poolSize` (Node's default 8KB ÷ small buffer; max contiguous append is bounded by OS-level write boundaries). A 1GB runaway log line would otherwise lock the outbox file for the duration of its append while every other producer's retry exhausts. 64KB is also large enough for any reasonable structured payload (stack traces, error summaries, command outputs ≤ ~600 lines).

The cap is NOT configurable via env var — operators changing the cap would create incompatible JSONL streams across producers. If a future use case needs a larger cap, a successor ADR + minor-version bump is required.

### 4. Inbox cursor compatibility

The cursor reader (US-EB06-OUTBOX-READ-CURSOR) writes cursor files with the shape `{ "fileIndex": number, "byteOffset": number }`. Outbox files are single-file (`fileIndex` always `0`); the same cursor shape applies to inbox files which rotate at 1MB (US-EB06-INBOX-WRITE). The cursor shape is `versioned-in-this-ADR`.

### 5. Reader-side partial-line tolerance

A writer that crashes mid-write leaves a partial JSON line as the final line in `outbox.jsonl`. The cursor reader MUST:

1. Read from `byteOffset` to EOF.
2. Split on `\n`. The LAST entry (after the final `\n`) is potentially incomplete.
3. Attempt `JSON.parse` on every complete line; emit unparseable lines as `{__parse_error__: true, raw: <string>}` with a single log entry (consumer responsibility how to handle).
4. The trailing-incomplete-line case: cursor advances ONLY past the last successfully-parsed line's `\n`. Subsequent reads pick up the partial line + the next complete line behind it. Self-healing as soon as the next writer completes a full append.

## Drivers

1. **NTFS atomic-append unreliability**: confirmed by the iter-2 pre-mortem scenario 1 + Architect/Critic consensus on Decision Driver #1. The lockfile is necessary; the 8-process concurrency test (US-EB06-OUTBOX-WRITE AC) proves both necessity (negative case without lockfile → torn writes) and sufficiency (positive case → 800 valid lines).

2. **Reader simplicity**: byte-offset cursor demands a single-file outbox + stable line-terminated wire format. Alternatives that split outbox across files (see §"Alternatives Considered") complicate cursor advancement.

3. **Hard upper bound on memory footprint**: capping each line at 64KB means a reader that scans 1000 lines reads at most 64MB into memory. Without a cap, a single 1GB log line bricks the reader's working set.

## Alternatives Considered

### Option A — Separate file per message (rejected)

- **Scope**: write each JSONL message to its own file (e.g., `outbox-000042.json`); reader does `readdirSync` + sort + concat.
- **Pros**: eliminates the lockfile entirely; no append-race surface; trivially crash-safe (rename-atomic).
- **Cons rejecting it**:
  - Cursor reader becomes `last-file-consumed: number` instead of byte-offset → schema breakage from §4 / §5
  - Glob+sort on every read scales O(N) in messages; outbox typically dwarfs file system handles on long sessions
  - Inode consumption: 1 file per message × thousands of messages exhausts NTFS MFT entries on long sessions
  - Read-side ordering: must sort lexicographically with zero-padded numeric prefixes; an off-by-one in zero-padding scrambles order
- **Rejection rationale**: Critic ADOPT'd this rejection in iter-2; iter-2 plan §"Alternatives Considered" documents the trade-off explicitly.

### Option B — Per-line rewrite via atomicWriteFileSync (rejected)

- **Scope**: every append reads the full outbox, parses lines, appends one entry, writes back via `atomicWriteFileSync`.
- **Pros**: zero lockfile; atomicWriteFileSync handles concurrency via rename-over-target.
- **Cons rejecting it**:
  - O(N) cost per append where N = current outbox line count; on a long session with 10k entries every additional message reads + writes the full file
  - Memory footprint grows linearly with session duration
  - Two concurrent appenders read the same baseline + each append exactly 1 entry → one of the two appenders' entries gets clobbered (last-writer-wins on the rename); silently loses data
- **Rejection rationale**: the data-loss path makes this fundamentally unsafe for multi-process write.

### Option C — Hand-rolled lockfile (CHOSEN)

- See §2.
- **Pros**: O(1) cost per append (single appendFileSync); no full-file rewrite; no message loss; explicit retry/stale-cleanup contract.
- **Cons**: lockfile mechanism is hand-rolled (small risk of subtle bugs); 4.25s total backoff budget could exhaust under sustained contention.
- **Mitigation**: 8-process concurrency test in US-EB06-OUTBOX-WRITE proves the lockfile mechanism works under realistic load on Windows NTFS.

### Option D — `proper-lockfile` npm dep (rejected)

- **Scope**: use the `proper-lockfile` npm package for the lockfile mechanism.
- **Pros**: battle-tested cross-platform implementation; bus-factor on file-system primitives is widely shared.
- **Cons**:
  - Adds an npm dep (omcp's dependency footprint stays small per project policy)
  - `proper-lockfile` brings transitive deps (graceful-fs, signal-exit) — three extra packages
  - On Windows, `proper-lockfile`'s default mechanism uses directory rename which has its own NTFS edge cases
- **Rejection rationale**: hand-rolled `openSync(path, 'wx')` covers the single-writer-per-file semantics omcp needs; the simplicity-vs-batteries trade-off favors zero-dep here.

## Consequences

1. **3 new npm scripts / verbs**: `omcp team-outbox-write` (US-EB06-OUTBOX-WRITE), `omcp team-outbox-read` (US-EB06-OUTBOX-READ-CURSOR), `omcp team-inbox-write` (US-EB06-INBOX-WRITE — shares the same lockfile pattern; sibling ADR cross-references this one for the lockfile contract).

2. **Plugin mirror grows by 3 CLI verbs** + the worker SKILL.md protocol change (US-EB06-WORKER-SKILL).

3. **CI runtime: +30s on the dedicated `test-concurrent` lane** for the 8-process test. Default `test` lane unaffected.

4. **Invariant-2 explicit carve-out for outbox/inbox `fs.appendFileSync`**: the lockfile sidecar + exclusive-create model is the in-process equivalent of atomicWriteFileSync for append semantics. The append path itself bypasses atomicWriteFileSync (which is rewrite-only). Per Invariant 2's existing carve-out pattern (see `docs/architecture/invariants.md:50-60` for hermes-bridge analog), this is acceptable when documented; this ADR documents.

5. **Outbox grows unbounded across long sessions**: no rotation policy. On 24h+ ralph runs accumulating thousands of entries the outbox may reach hundreds of MB. Mitigation: rotation is OUT OF SCOPE for EB-06 N+1; tracked as a follow-up for a future minor. Cursor readers already advance past consumed data, so the read-side memory cost is bounded by per-read window size.

## Follow-ups

1. EB-05 ADR (heartbeat freshness) — lands as sibling story
2. Master EB-06 ADR — lands in EB-06 N+3 alongside the master CHANGELOG entry
3. Future: outbox rotation policy if long sessions surface disk-space concerns (gated on user reports — same pattern as EB-06 itself)
4. Future: optional schema-level compression for `payload` (e.g., `payload_b64_zstd`) — only when a real use case surfaces

## Tracking

- Source: iter-2 plan US-omcp-parity-P2-OUTBOX-write-helper AC + Decision Driver #1 + Open Question #2 (resolved here as 64KB cap)
- Implementation: lands in US-EB06-OUTBOX-WRITE (next story) + US-EB06-OUTBOX-READ-CURSOR (follow-on)
- Tests: 8-process positive + 2-process Windows-only negative (in US-EB06-OUTBOX-WRITE) prove necessity + sufficiency of the lockfile mechanism
