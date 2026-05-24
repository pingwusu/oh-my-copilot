# sparkshell .exe wrapper feasibility — v1.6 investigation

**Date**: 2026-05-24
**Trigger**: v1.3–v1.5 unable to make Stop (and all other) hook events fire live on Copilot 1.0.53-2 Windows
**Hypothesis**: single-binary .exe wrapper bypasses the pwsh `-c` quoting boundary that drops the script-path argument

---

## Summary

**DEFER to v1.7 or later — not viable for v1.6.** The `crates/sparkshell` directory does not exist; the Cargo workspace has exactly one crate (`omcp-explore-harness`). Rust itself is not installed on the user's machine. Building a sparkshell-hook .exe would require (1) installing Rust, (2) creating the crate from scratch, (3) solving distribution and code-signing for Windows, and (4) validating that the single-token `.exe` invocation actually escapes the live failure mode — which the v1.5 investigation could not confirm because bench reproductions NEVER triggered the bug. Effort is 2–3 days minimum with no guarantee the hypothesis is correct. The risk/effort ratio is too high for v1.6. Recommended path: file the upstream GitHub Copilot issue (draft already in v1.5 report, Part 4) and continue shipping the persistent-mode Stop-only mitigation already in v1.2.0.

---

## Part 1: Current state of crates/sparkshell

### What exists (Cargo.toml, source)

The repository root has a `Cargo.toml` workspace file:

```toml
[workspace]
resolver = "2"
members = ["crates/omcp-explore-harness"]
```

`sparkshell` is referenced nowhere in the workspace. The `crates/` directory contains a single member: `crates/omcp-explore-harness`. That crate is a deterministic CLI harness (find/grep/symbols/stat subcommands) used as a fast Rust hot-path for codebase exploration, not a hook proxy. It has no stdin-forwarding logic and no `node` subprocess spawning. It is a well-formed, complete crate with a `main.rs`, five source modules (`walker`, `find`, `grep`, `symbols`, `stat`), integration tests under `tests/cli.rs`, and dependencies `regex 1.10` + `walkdir 2.5`.

`crates/sparkshell/` does not exist on disk. There is no `Cargo.toml` for it, no `src/`, no skeleton, no stub. It is mentioned only in `CLAUDE.md` under the M3 milestone:

> **M3**: Remaining skills + sparkshell crate + model-routing layer

M3 is scheduled after M1 (omcp CLI core) and M2 (skills + agents), neither of which has been completed yet at HEAD = a7b2ffc / tag v1.5.0. The sparkshell crate is a future milestone item, not an in-progress one.

### What's missing

Everything: directory, `Cargo.toml`, any source, workspace registration, design doc. Starting from zero.

### Confidence: HIGH

Direct filesystem listing + workspace member list confirms the absence unambiguously.

---

## Part 2: Wrapper design (what a sparkshell-hook .exe WOULD need to do)

This section is speculative — no code should be written for v1.6 — but the design is recorded here so a future implementer has a clear spec.

### .exe responsibilities

```
sparkshell-hook.exe <EventName>
  stdin  = Copilot's JSON payload (verbatim bytes)
  stdout = child node process stdout (pass-through)
  stderr = child node process stderr (pass-through)
  exit   = child node process exit code
```

Execution steps:
1. Read `argv[1]` as the event name (e.g. `Stop`, `PostToolUse`). Reject if absent or not in the known event set.
2. Locate `omcp.js`. Resolution order:
   a. `OMCP_DIST_BIN` env var (absolute path to `dist/cli/omcp.js`).
   b. Adjacent-to-.exe discovery: `<dir_of_exe>/../dist/cli/omcp.js` (works when shipped inside the omcp npm package).
   c. PATH lookup for `omcp` (fallback, same fragility as current form — only used as last resort).
3. Resolve `node.exe` absolute path (from `NODE_EXE` env var or `node` on PATH).
4. Spawn: `node <abs-omcp-js> hook fire <event> --json` with:
   - stdin piped from own stdin (the Copilot JSON payload)
   - stdout/stderr inherited or piped-through
   - No intermediate pwsh layer
5. Wait for child, forward exit code.

No external crate dependencies strictly necessary: `std::process::Command` + `std::io::copy` is sufficient. Optional: `serde_json` for payload validation in debug mode.

### Settings.json command form

After building and placing `sparkshell-hook.exe` in a stable location (e.g. `dist/bin/sparkshell-hook.exe` inside the npm package, or a system PATH location):

```json
"Stop": [{
  "matcher": "*",
  "hooks": [{
    "type": "command",
    "command": "sparkshell-hook.exe Stop",
    "timeout": 30,
    "__omcp": true
  }]
}]
```

`resolveHookCommandBin()` in `src/runtime/copilot-config.ts` would need a new branch: when `OMCP_USE_SPARKSHELL=1` (or when `sparkshell-hook.exe` is found on PATH), emit `sparkshell-hook.exe` instead of `node "<abs-path>"`.

### Build + distribution plan

1. Add `crates/sparkshell-hook/Cargo.toml` and register in workspace.
2. `cargo build --release --target x86_64-pc-windows-msvc` produces `sparkshell-hook.exe` (~500 KB stripped, no external DLLs with `lto = "thin"` + `strip = "symbols"` already in workspace profile).
3. Add a `scripts/build-sparkshell.ts` that runs `cargo build --release` and copies the .exe to `dist/bin/`.
4. Wire into `npm run build` as an optional step gated on `rustc --version` succeeding (mirrors the omx-explore-harness pattern of optional Rust acceleration with TypeScript fallback).
5. Ship `dist/bin/sparkshell-hook.exe` inside the npm package via `package.json#files`.

---

## Part 3: Bench plan

### Deterministic tests (4 tests)

| # | Test | Pass criterion |
|---|------|----------------|
| D1 | Build succeeds: `cargo build --release` produces `sparkshell-hook.exe` | Exit 0, file exists, size < 5 MB |
| D2 | Proxy correctness: invoke `sparkshell-hook.exe Stop` with a known JSON payload piped on stdin; a stub `node` script echoes its argv and stdin back to stdout | .exe output matches expected argv (`hook fire Stop --json`) and forwarded stdin JSON verbatim |
| D3 | Exit code passthrough: stub node script exits with code 7; `sparkshell-hook.exe` must exit 7 | `$LASTEXITCODE` = 7 |
| D4 | Missing event arg: invoke `sparkshell-hook.exe` with no args | Exit 1 + usage message on stderr; no crash |

These four tests are implementable as Rust integration tests under `crates/sparkshell-hook/tests/` using `assert_cmd` (already in workspace dev-deps pattern via omcp-explore-harness).

### Live smoke prerequisites

Before running the v1.5 smoke variant with the sparkshell .exe:

1. Build the .exe (D1 must pass).
2. Place it on PATH or set `OMCP_USE_SPARKSHELL=1` so `omcp setup` emits the new command form.
3. Re-run `omcp setup` to rewrite `~/.copilot/settings.json` with `sparkshell-hook.exe Stop` in the Stop hook entry.
4. Reproduce the v1.4 smoke: start a Copilot agent turn, trigger Stop, observe `~/.copilot/logs/process-*.log`.
5. Pass criterion: zero `eval_stdin SyntaxError` lines in the log for Stop events.

**Critical caveat**: the v1.5 investigation established that bench reproductions of the pwsh dispatch bug ALWAYS PASS — the bug is live-session-only. This means D1–D4 cannot validate the hypothesis. Only the live smoke (step 5) can confirm or refute it. The live smoke requires the Rust toolchain, a build step, and a Copilot session — cannot be automated in CI with current infrastructure.

---

## Part 4: Risks + trade-offs

### Build complexity

- **Rust toolchain not present** on the developer machine (`rustc` and `cargo` returned `command not found` in both Bash and PowerShell). Installing `rustup` + MSVC build tools on Windows is a 15–30 minute one-time setup. CI (GitHub Actions) would need a `dtolnay/rust-toolchain` step added to the workflow.
- The existing `omcp-explore-harness` crate proves the workspace pattern is sound and the `cargo build` + strip profile is already configured. Adding `sparkshell-hook` as a second member is low structural risk once the toolchain exists.
- Risk: MSVC linker requirement. The workspace targets `x86_64-pc-windows-msvc`. If the user's machine has only `x86_64-pc-windows-gnu` (mingw) or `stable-x86_64-unknown-linux-gnu`, the target needs to be set explicitly or cross-compilation configured.

### Distribution + signing

- An unsigned `.exe` on Windows 11 triggers **Windows Defender SmartScreen** on first run ("Windows protected your PC — unrecognized app"). This is the single largest usability risk: a hook that fails with SmartScreen nag on first invocation produces the same symptom as the current bug (hook exit 1 / timeout).
- Mitigation options: (a) code-sign with an EV certificate (~$400/yr, requires legal entity); (b) ship via `winget` / MSIX package (establishes SmartScreen reputation over time); (c) document that users must click "Run anyway" once, or use `Set-ExecutionPolicy` + `Unblock-File`; (d) use a `.cmd` batch wrapper instead (no SmartScreen for `.cmd`). Option (d) was tested in v1.5 bench as T7 and PASSED — but also goes through the same `pwsh -c "& path.cmd"` dispatch and thus does not eliminate the failure vector.
- npm-packaged `.exe` files are subject to the same SmartScreen behavior. The `omcp-explore-harness` binary (if ever shipped) would face the same issue.

### Cross-platform (currently Windows-only need)

- The pwsh dispatch bug is Windows-specific. macOS / Linux use `bash` dispatch (a separate `Xer` branch) and have no reported failures.
- Shipping a Windows-only binary inside the npm package creates platform branching: `dist/bin/sparkshell-hook.exe` exists only on the Windows build artifact. The `resolveHookCommandBin()` logic would need `process.platform === 'win32'` gating.
- Alternatively, the `.exe` could be built for all platforms (Linux / macOS `sparkshell-hook` with no extension) but this adds CI matrix complexity for a bug that only manifests on Windows.
- The `omcp-explore-harness` precedent is instructive: it is an optional acceleration layer with a TypeScript fallback. sparkshell-hook would need a similar "Rust present → use .exe; Rust absent → use node form" decision at `omcp setup` time. This is clean architecturally but adds a setup-time build gate.

---

## Part 5: Verdict

**DEFER to v1.7 — not viable for v1.6.**

Evidence chain:

1. `crates/sparkshell` does not exist. Zero code written. Estimated bootstrap effort: 2–3 days (crate scaffold + stdin-proxy implementation + D1–D4 tests + distribution wiring + `resolveHookCommandBin` branch + smoke validation).
2. Rust toolchain is not installed on the user's machine. Installing it is a prerequisite with non-trivial Windows MSVC dependencies.
3. The hypothesis (single-token `.exe` invocation survives the `pwsh -c` quoting boundary) is **unverified and unverifiable without a live smoke**. The v1.5 bench ran 8 command-form variants × 7 env variants including `.cmd` batch wrappers — all PASSED. The batch wrapper (T7) is the closest analog to the sparkshell approach (single-token invocation, no Node SEA parent) and also passed bench but was never validated in a live Copilot session.
4. Windows Defender SmartScreen represents a deployment risk that could reproduce the same user-visible symptom (hook exit 1) through a completely different mechanism.
5. The fastest path to unblocking is the upstream issue (draft in v1.5 Part 4), which requests array-form spawn for `command` fields, bypassing `pwsh -c` entirely without any new binary.

**Recommended v1.6 scope**: (a) publish the upstream issue draft from v1.5 Part 4; (b) add a `omcp doctor` warning on Copilot 1.0.53-2 + Windows that all hook events are upstream-blocked; (c) document sparkshell-hook as a M3 milestone item with this investigation as the design spec.

---

## Part 6: Open questions

1. **Does the single-token .exe form actually survive the quoting boundary?** The mechanism that drops the script-path token in the live session is not fully understood (v1.5 Part 5, Q1). A single-token `.exe` invocation (`sparkshell-hook.exe Stop`) has no inner double-quoted tokens to lose, which is the hypothesis — but the bench cannot confirm this without reproducing the live failure mode first.

2. **Would a `.cmd` wrapper (no Rust dependency) achieve the same effect?** T7 in the v1.5 bench (`pwsh -c "& path.cmd"`) passed bench. A `.cmd` wrapper requires no Rust toolchain and no code-signing. If the hypothesis is that `pwsh -c "exe-or-cmd-name arg"` with a single argument survives where `pwsh -c "node \"abs-path\" arg1 arg2"` does not, a `.cmd` test is strictly cheaper than the Rust .exe and should be tried in a live smoke first.

3. **Is the Node 24.16.0 SEA argument-quoting difference documented anywhere?** The v1.5 report cites `spawnSync` commit #62633 ("coerce args to string once") in v24.16.0 as a candidate. Worth checking the Node.js CHANGELOG between 24.14.1 and 24.16.0 specifically for `child_process` / `CreateProcess` changes.

4. **Can the upstream issue be filed now?** The draft is complete (v1.5 Part 4). Filing it does not block any omcp release and may elicit a faster fix than any workaround.

5. **When should sparkshell be revisited?** Suggested trigger: upstream issue closed WONTFIX, AND Copilot 1.x still uses `pwsh -c` dispatch on Windows, AND M1+M2 milestones complete (giving the Rust build infrastructure established time). At that point the bootstrap effort is lower because CI Rust matrix already exists from omcp-explore-harness shipping.

---

## 400-word summary

**Verdict (first sentence): DEFER — the sparkshell .exe wrapper hypothesis is not viable for v1.6 because the crate does not exist, Rust is not installed, and the hypothesis cannot be validated without a live Copilot smoke that the bench infrastructure cannot replicate.**

The investigation was triggered by 27+ `eval_stdin SyntaxError` failures across all 13 hook event types in the v1.4–v1.5 live smokes. Copilot 1.0.53-2's `Xer` dispatcher unconditionally wraps every hook command in `pwsh.exe -nop -nol -c <string>` on Windows, and something in the Copilot-embedded Node v24.16.0 SEA → pwsh → system Node v24.14.1 chain causes the double-quoted script-path token to be lost, putting Node into `eval_stdin` mode where it attempts to parse the JSON payload as TypeScript.

The hypothesis for v1.6 was: a pre-compiled `sparkshell-hook.exe` invoked as `sparkshell-hook.exe Stop` — a single executable token with a single argument, no inner double-quoted path — might survive that quoting boundary. When `pwsh -c` receives `sparkshell-hook.exe Stop`, there are no embedded quotes for CreateProcess to mishandle.

Three hard blockers make this not viable for v1.6:

**Blocker 1 — crate does not exist.** The `crates/sparkshell` directory is absent. The Cargo workspace has one member (`omcp-explore-harness`), which is an unrelated exploration harness. CLAUDE.md lists sparkshell as an M3 milestone item, behind M1 and M2 (both incomplete). Bootstrap effort is estimated at 2–3 days minimum.

**Blocker 2 — no Rust toolchain.** `rustc` and `cargo` are not on PATH in either Bash or PowerShell. Installing `rustup` + MSVC build tools on Windows is a non-trivial prerequisite that blocks any near-term build.

**Blocker 3 — hypothesis unverifiable.** The v1.5 investigation ran 8 command-form variants including `.cmd` batch wrappers (T7, the closest analog to a single-token invocation) — all PASSED bench. The live Copilot session remains the only environment that triggers the bug. Without being able to reproduce the failure in bench, there is no deterministic test that can confirm sparkshell-hook fixes anything before shipping.

The fastest unblocking path remains filing the upstream GitHub Copilot issue (draft complete in v1.5 Part 4) requesting array-form spawn for `command` fields. A cheaper intermediate experiment — testing a `.cmd` batch wrapper in a live smoke, which requires zero Rust — should be tried before any Rust investment. If the upstream issue is rejected WONTFIX and the `.cmd` live smoke also fails, sparkshell-hook becomes a viable M3 work item with this document as its design spec.
