# ADR: `omcp cancel` Semantics — Mid-Step Cancellation Across Modes

**Date**: 2026-05-25
**Status**: Accepted (v2.1 N+2 Session)
**Author**: pingwusu (v2.1 N+2 Story 12)
**Related**:
- `docs/plans/omcp-team-omc-parity-iter2.md` (US-omcp-parity-P3-CHAIN-cancel-propagation)
- `src/cli/commands/mode.ts:583` (`runCancel`)
- `src/cli/commands/chain.ts` (Story 12 `propagateCancelToChain`)

---

## Context

`omcp cancel` writes `.omcp/state/cancel.json` — a marker file that long-
running modes are expected to check at well-defined checkpoints and
short-circuit on. v2.1 N+2 introduces `omcp ralplan --chain` which can
orchestrate multi-mode pipelines (ralplan → team → ralph). When a user
runs `omcp cancel` mid-chain, the semantics must be unambiguous: which
in-flight modes are guaranteed to honor the cancel? Which require manual
follow-up (SIGTERM, worker stop)?

Without an explicit policy, downstream skill authors don't know whether
their checkpoint code is load-bearing for the cancel contract or merely
advisory. This ADR pins the per-mode behavior.

## Decision

### Cancel-honoring modes (mid-step cancel takes effect at next checkpoint)

| Mode | Checkpoint | Latency |
|---|---|---|
| **ralph** | `outerLoopOwned` guard before each iteration spawn | ≤ 1 iteration (≤ Copilot spawn duration) |
| **autopilot** | Phase boundary check between expansion / planning / execution / qa / validation / cleanup | ≤ 1 phase |
| **ultrawork** | Reinforcement-decay tick (every Nth task scheduling decision) | ≤ next task dispatch |
| **ultraqa** | Outer review cycle entry | ≤ 1 review cycle |
| **sciomc** | Parallel agent fan-out boundary | ≤ next agent dispatch |
| **ralplan** | Iteration loop entry (each ralplan iter checks for cancel before spawning) | ≤ 1 ralplan iter |
| **ultragoal** | Goal-state checkpoint | ≤ next checkpoint |
| **team-verify** | Between vitest / tsc / biome tool invocations within a single verify pass | ≤ 1 tool invocation |

### Cancel-best-effort modes (require SIGTERM follow-up)

| Mode | Reason |
|---|---|
| **team-launch** (`omcp team N:executor "..."`) | Workers are detached `copilot -p` spawns. The orchestrator cannot inject a cancel-signal into a running Copilot inference. The workers' parent process exits immediately after spawning, so no checkpoint code runs on the parent side. `omcp cancel` writes the marker; **users must explicitly run `omcp team-stop <sessionId>` to SIGTERM the detached workers**, or wait for them to finish naturally. |
| **spawnFixWorker** (Story 4 fix-worker spawn) | Same detached-Copilot reason as team-launch. The fix-worker doesn't check the cancel marker; if the user wants the fix attempt aborted they must `omcp team-stop <sessionId>`. |

## Drivers

1. **Detached-Copilot constraint**: `copilot -p` is a single-shot
   inference invocation; once spawned, the parent has no SDK-level
   hook to interrupt the inference. SIGTERM is the only universal stop
   signal. Promising checkpoint-honoring cancel for workers would set
   an expectation we cannot meet.
2. **Loop-mode self-discipline**: Modes that own an outer loop in the
   parent process (ralph, autopilot, etc.) DO check cancel markers
   between iterations because the inter-iteration boundary is a
   natural point to consult shared state. team-verify is the team-
   subsystem analog — it runs vitest/tsc/biome in sequence within the
   parent process, so the between-tool boundary is its checkpoint.
3. **Postmortem clarity**: Pinning behavior in an ADR lets users
   compose `omcp cancel` with `omcp status` / `omcp team-stop` /
   `omcp doctor team-routing` without surprise — they know exactly
   what state the system is in after a cancel.

## Alternatives Considered

| Option | Rejected because |
|---|---|
| Always run `omcp team-stop` automatically on cancel when chain has team step | Couples cancel to team-state lookup; if team-state.json is missing, cancel itself fails. Better to keep cancel narrow + tell the user about the team-stop follow-up. |
| Defer chain-state.json clear until ralph step ack's the cancel | Adds two-phase commit complexity; the AC says "clears chain-state.json" unconditionally. |
| Differentiate "graceful" vs "forceful" cancel via flag | Premature — no user has asked for this; YAGNI. v2.1.0 ships the single auto-detecting cancel surface. |

## Consequences

- **Story 12** implementation now matches a documented contract:
  `propagateCancelToChain` clears `chain-state.json` AND sets
  `<currentMode>-state.cancelled=true` AND writes the cancel marker
  (via the existing `runCancel` helper composed in the CLI layer).
- Users running an active chain that includes a `team` step are told
  (via `omcp cancel` output) that the team-mode state was signalled
  but its workers may still be running detached — `omcp team-stop
  <sessionId>` is the documented follow-up.
- Future N+3 polish (status revamp per ADR-omcp-status-fix-loop-count-
  deferred.md) will surface "cancel-pending" + "workers-still-alive"
  badges via `omcp status` so the user sees the partial state.

## Follow-ups

- N+3: surface `cancelled: true` on `omcp status` per the deferred
  status-revamp ADR.
- Future ralplan iter (gated by EB-omcp-parity-06): if Phase 2 IPC
  revives, the heartbeat-fresh check could short-circuit
  team-launch's workers via inbox.md cancel signals. Until then,
  workers ignore cancel by design.

## Tracking

- This ADR closes the deferred-without-ADR concern that Story 12
  inherited from the iter-2 plan (`docs/plans/omcp-team-omc-parity-
  iter2.md` US-omcp-parity-P3-CHAIN-cancel-propagation AC: "ADR
  commit lands as a separate story (US-P4-ADR-write or as part of
  this story per critic preference; chosen: keep ADR file write in
  P4 for batched ADR-writing consistency)"). Per the iter-2 critic
  recommendation we land the ADR HERE rather than batching to P4,
  because the cancel-semantic clarity is load-bearing for any user
  composing `omcp cancel` with the new `omcp ralplan --chain` flow
  in N+2.
