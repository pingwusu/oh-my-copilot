# DEP0190 Probe — Direction C + D (v1.7)

**Date:** 2026-05-24  
**Node:** v24.14.1  **npm:** 11.11.0  **Platform:** Windows 11 (win32)  
**Bench scripts:** `docs/probes/dep0190-cd/bench-c-execfile.mjs`, `bench-d1-remove-warning-listener.mjs`, `bench-d2-argv0.mjs`

---

## Background

`src/cli/commands/setup.ts` (~line 145) currently uses:

```ts
spawnSync("npm", [...], {
  cwd: paths.omcpPluginDir,
  stdio: "inherit",
  shell: process.platform === "win32",
});
```

On Windows, `shell: true` is required because `npm` resolves to `npm.cmd` (a batch script shim), which is not a direct executable. Node 24 emits **DEP0190** on any `spawnSync`/`spawn` call with `shell: true`, warning that argument concatenation without escaping is a potential injection vector.

---

## Direction C — `execFile` instead of `spawnSync`

**Hypothesis:** `execFile` is Node 24's recommended alternative when you have a known absolute path. With `shell: false` it should not trigger DEP0190.

### C1 — `execFileSync("npm.cmd", [...], { shell: false })`

```
[C1] npm.cmd direct execFile: FAIL as expected — EINVAL
[C1] DEP0190 fired: false
```

**Result: FAIL.**  
`.cmd` files are Windows batch scripts, not PE executables. The OS kernel returns `EINVAL` when you attempt to `exec()` them directly without a shell. No DEP0190 fires (the call never reaches the warning path), but the install never runs.

### C2 — `execFileSync("cmd.exe", ["/c", "npm.cmd", ...], { shell: false })`

```
[C2] cmd.exe /c npm.cmd: SUCCESS: up to date in 926ms
[C2] DEP0190 fired: false
[C2] RESULT: PASS (works, no DEP0190)
```

**Result: PASS.**  
`cmd.exe` is a real executable. Passing `/c npm.cmd ...` as argv to `cmd.exe` (not via Node's `shell` machinery) invokes the `.cmd` shim through Windows' own command interpreter. Node never sets `shell: true`, so DEP0190 is never triggered. The install completes successfully.

### C3 — `execFileSync(process.execPath, [npm-cli.js, ...], { shell: false })`

```
[C3] node npm-cli.js: SUCCESS: up to date in 936ms
[C3] DEP0190 fired: false
[C3] RESULT: PASS (works, no DEP0190)
```

**Result: PASS.**  
Bypasses the `.cmd` shim entirely by invoking `node` directly with npm's JS entry point (`C:\Program Files\nodejs\node_modules\npm\bin\npm-cli.js`). `shell: false`, no DEP0190. Downside: the npm CLI script path is non-trivial to resolve portably (differs by Node install method, nvm, Volta, etc.).

### Recommended C patch (C2 variant)

```ts
// Direction C2: resolve npm.cmd from PATH, invoke via cmd.exe /c to avoid
// shell:true (DEP0190). cmd.exe is a real executable so execFileSync works.
import { execFileSync } from "node:child_process";
import { which } from "node:child_process"; // or use `where npm.cmd`

const npmArgs = ["install", "--omit=dev", "--ignore-scripts",
                 "--prefer-offline", "--no-audit", "--no-fund"];

if (process.platform === "win32") {
  // execFile cmd.exe /c npm.cmd — no shell:true, no DEP0190
  execFileSync("cmd.exe", ["/c", "npm.cmd", ...npmArgs],
    { cwd: paths.omcpPluginDir, stdio: "inherit", shell: false });
} else {
  execFileSync("npm", npmArgs,
    { cwd: paths.omcpPluginDir, stdio: "inherit", shell: false });
}
```

> **Caveat:** `execFileSync` throws on non-zero exit; the caller must wrap in try/catch and replicate the error handling currently done via `result.status` / `result.error`.

---

## Direction D1 — `process.removeAllListeners('warning')` emit-control

**Hypothesis:** DEP0190 is emitted as a `warning` event on the parent process. Removing the default warning listener (and optionally re-adding a filtered one) would silently swallow DEP0190 while preserving all other warnings.

```js
process.removeAllListeners("warning");
process.on("warning", (w) => {
  if (w.code === "DEP0190") return; // swallow
  process.stderr.write(`[WARNING] ${w.name}: ${w.message}\n`);
});
// ...then spawnSync("npm", [...], { shell: true }) as before
```

```
[BENCH-D1] exit status: 0
[BENCH-D1] stdout: up to date in 1s
[BENCH-D1] DEP0190 caught by our listener (suppressed): 1
[BENCH-D1] DEP0190 in child stderr: false
[BENCH-D1] RESULT: PARTIAL-SUPPRESS (works, DEP0190 caught+swallowed by listener)
```

**Result: PARTIAL-SUPPRESS.**  
The npm install works and DEP0190 is caught and silently dropped before reaching stderr. The warning event still fires internally (Node still generates it), but no output appears. This is **emit-suppression, not prevention**: the deprecation path in libuv/Node internals still executes; we're just hiding the output.

**Assessment:** Works for the user-visible symptom (no warning printed), but is semantically questionable — it globally mutates process warning listeners at startup, which could hide legitimate future warnings. It also requires calling `removeAllListeners` before the first `spawnSync`, meaning it must run at module load time or early in `setup()`. Not ideal as a long-term fix but is low-risk given DEP0190 is a known false positive for static args.

---

## Direction D2 — `spawnSync(..., { shell: true, argv0: "npm.cmd" })`

**Hypothesis:** Node 24's DEP0190 check might inspect `argv0` to decide whether to emit the warning. If `argv0: "npm.cmd"` signals that the caller knows they're using a `.cmd` shim, it might suppress the warning.

```js
spawnSync("npm", [...], { cwd, stdio: "pipe", shell: true, argv0: "npm.cmd" });
```

```
[BENCH-D2] exit status: 0
[BENCH-D2] DEP0190 fired: true
[BENCH-D2] RESULT: PARTIAL (works but DEP0190 present)
(node:28128) [DEP0190] DeprecationWarning: Passing args to a child process
  with shell option true can lead to security vulnerabilities...
```

**Result: FAIL (DEP0190 not suppressed).**  
`argv0` is forwarded to the child process as its `argv[0]` string, not used by Node's DEP0190 trigger logic. The warning fires regardless. `argv0` has no effect on whether the shell-interposition deprecation fires.

---

## Summary Table

| Direction | Mechanism | npm works | DEP0190 gone | Verdict |
|-----------|-----------|-----------|--------------|---------|
| C1 | `execFileSync("npm.cmd", shell:false)` | NO (EINVAL) | yes (never fires) | FAIL |
| C2 | `execFileSync("cmd.exe", ["/c","npm.cmd",...], shell:false)` | YES | YES | **PASS** |
| C3 | `execFileSync(node, [npm-cli.js,...], shell:false)` | YES | YES | **PASS** (portability caveat) |
| D1 | `removeAllListeners('warning')` + filtered re-listener | YES | YES (suppressed) | PARTIAL-SUPPRESS |
| D2 | `spawnSync(..., { shell:true, argv0:"npm.cmd" })` | YES | NO | FAIL |

---

## Recommendation

**Preferred fix: Direction C2** — `execFileSync("cmd.exe", ["/c", "npm.cmd", ...args], { shell: false })` on Windows.

- Truly eliminates the DEP0190 trigger path (not suppression, not hiding).
- `cmd.exe` is a stable Windows system executable with a known absolute path.
- The `/c npm.cmd` invocation uses Windows' own command interpreter, which is exactly what `shell: true` was doing under the hood, but now explicitly and without Node's injection-warning path.
- Portable: on non-Windows, use `execFileSync("npm", args, { shell: false })` directly.

**Fallback: Direction D1** if C2 causes unforeseen issues (e.g., environments where `cmd.exe` path differs). The filtered listener approach is safe for this codebase since DEP0190 on static args is a confirmed false positive, but it should be clearly documented with a comment.

**Rejected: D2** — `argv0` has no effect on DEP0190 trigger logic.
