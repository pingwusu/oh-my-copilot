# ADR — sparkshell direction-A (Rust) blocked: USER_REQUIRED Rust toolchain

**Status**: USER_REQUIRED (not a project decision — toolchain not installed)
**Date**: 2026-05-25
**Plan reference**: docs/plans/v1.8-to-v2.0-ralplan-iter3.md US-1.9-T3-SPARKSHELL-rust-toolchain

## Context

The v1.9 sparkshell feature uses a "two-legged" (两条腿走路) strategy to work
around Copilot CLI's Windows pwsh dispatch limitations
(see `docs/upstream-reports/copilot-pwsh-dispatch-v1.5-investigation.md`).
Three directions were defined in the iter-3 plan:

| Direction | Technology | Toolchain needed |
|-----------|-----------|-----------------|
| A | Rust `.exe` via `cargo` | Rust toolchain (USER_REQUIRED) |
| B | `.cmd` batch wrapper | None — pure batch + node |
| C | Node `child_process.fork` IPC | None — Node only |

On 2026-05-25 (session N+4), `cargo --version` was not found on the dev
machine. The Rust toolchain has not been installed.

## Decision

Direction A is **blocked** pending user action. Directions B and C ship in
v1.9 without direction A.

## What ships in v1.9

- `scripts/sparkshell.cmd` — direction B
- `src/runtime/sparkshell-fork.ts` + `src/runtime/sparkshell-fork-worker.ts` — direction C
- Tests: `sparkshell-direction-cmd.test.ts` + `sparkshell-direction-fork.test.ts`

## User action required

To unblock direction A:

```powershell
# 1. Install rustup (Windows installer)
winget install Rustlang.Rustup
# OR download from https://rustup.rs/

# 2. Restart the terminal, then verify:
rustup --version
cargo --version

# 3. Re-run the executor for direction A stories:
#    US-1.9-T3-SPARKSHELL-rust-toolchain
#    US-1.9-T3-SPARKSHELL-bootstrap
#    US-1.9-T3-SPARKSHELL-exe-impl
#    US-1.9-T3-SPARKSHELL-tests
```

Alternatively, a `scripts/install-rust.ps1` helper may be added in a follow-up
story (US-1.9-T3-SPARKSHELL-rust-toolchain) when Rust is available.

## Re-evaluation target

Direction A is re-evaluated in **v2.x** (session N+5 per iter-3 plan) once the
Rust toolchain is installed. The iter-3 plan Section N+5 describes the
bootstrap, exe-impl, and test stories.

The `Cargo.toml` workspace root and `crates/` directory already exist in the
repository (from the initial scaffold) and are ready for direction A to land
without further structural changes.

## Consequences

- v1.9 ships with directions B + C covering the Windows dispatch gap.
- Direction A's `.exe` binary will not appear in the npm pack for v1.9.
  The `US-2.0-T1-NPM-bin-postinstall` story already makes `sparkshell` bin
  entry conditional on whether the `.exe` was built.
- No regression risk: the outer-loop (v1.6 ralph) remains the primary path
  when sparkshell is not registered as a Copilot CLI hook.
