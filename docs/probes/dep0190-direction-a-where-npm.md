# DEP0190 Direction A: resolve npm via `where.exe` + spawn direct

**Date**: 2026-05-24  
**Node version**: v24.14.1 (system)  
**Platform**: Windows 11 Enterprise 10.0.26200  
**Status**: **WORKS** (with a twist — see T4/T5 below)

---

## Background

v1.5 uses `spawnSync("npm", [...], { shell: process.platform === "win32" })` to
find npm's `.cmd` shim via PATHEXT on Windows.  Node 24 emits **DEP0190**
("Passing args to a child process with shell option true can lead to security
vulnerabilities") from the *parent* process at the point of that `spawnSync`
call.

Direction A is: resolve npm's absolute path at startup via `where.exe npm`,
then call `spawnSync(absolutePath, args, { shell: false })`.

---

## Experiment recipe

Two bench scripts in `docs/probes/dep0190-direction-a/`:

### `bench.cjs` — six variants

| Test | Command form | shell | Result | DEP0190? |
|------|-------------|-------|--------|----------|
| T1 | `where.exe npm` resolution | — | paths found | — |
| T2 | `spawnSync(npm.cmd, args, {shell:false})` | false | **EINVAL** status:null | no |
| T3 | `spawnSync(cmd.exe, ['/c', npm.cmd, ...], {shell:false})` | false | status:0 | no |
| T4 | `spawnSync(node.exe, [npm-cli.js, '--version'], {shell:false})` | false | **status:0** | **no** |
| T5 | `spawnSync(node.exe, [npm-cli.js, 'install', ...], {shell:false})` full install | false | **status:0** | **no** |
| T6 | `spawnSync(cmd.exe, ['/c', npm.cmd, 'install', ...], {shell:false})` | false | status:0 | no |

### `bench-dep0190-verify.cjs` — before/after comparison

| Test | Command form | shell | DEP0190 emitted? |
|------|-------------|-------|------------------|
| V1 | `spawnSync("npm", [...], {shell:true})` (v1.5 current) | true | **YES** — warning on parent stderr |
| V2 | `spawnSync(node.exe, [npm-cli.js, ...], {shell:false})` (Direction A) | false | **no** |

DEP0190 is emitted by the **parent** Node process (not captured in child
stderr). It appears after the bench script exits, confirming it comes from the
`shell:true` spawnSync call itself.

---

## Result: WORKS

**Winning approach: T4/T5 — `spawnSync(process.execPath, [npmCliJs, ...args], { shell: false })`**

Key findings:

1. **`npm.cmd` + `shell:false` → EINVAL** (T2). A `.cmd` batch file is not a
   PE executable; Windows CreateProcess rejects it without a shell interpreter.
   This is the same failure as "Direction A-old" in the v1.5 notes.

2. **`where.exe` returns both `npm` (no extension) and `npm.cmd`**. Neither is
   directly spawnable without a shell. The `npm` entry (no extension) is
   actually the same POSIX-style shim — also not a PE binary.

3. **`cmd.exe /c npm.cmd` works (T3/T6)** — explicit `cmd.exe` invocation with
   `/c` is a valid `shell:false` alternative that avoids `shell:true`. No
   DEP0190. Downside: hard-codes `cmd.exe` path and adds one process layer.

4. **`node.exe + npm-cli.js` works best (T4/T5)**. Node ships npm's CLI at
   `<nodedir>/node_modules/npm/bin/npm-cli.js`. Spawning
   `spawnSync(process.execPath, [npmCliJs, 'install', ...])` with `shell:false`
   achieves status:0 on a real `npm install`, emits zero DEP0190 warnings, and
   adds no external process dependency. The resolved path on this machine:
   `C:\Program Files\nodejs\node_modules\npm\bin\npm-cli.js`

5. **DEP0190 confirmed on v1.5 `shell:true` path** (V1) — the warning is
   real, not a fluke.

---

## Suggested patch for `src/cli/commands/setup.ts`

The patch replaces the `shell: process.platform === "win32"` block with a
two-strategy resolver:

- **Primary**: `process.execPath` + sibling `node_modules/npm/bin/npm-cli.js`
  → `shell: false`. Works wherever Node ships bundled npm (all standard Node
  installers on all platforms).
- **Fallback**: `where.exe npm` (Windows) / `which npm` (POSIX) → if the
  resolved path ends in `.cmd`, wrap in `cmd.exe /c`; otherwise spawn directly.
  Used only if the npm-cli.js sibling is absent (unusual custom installs).

```diff
--- a/src/cli/commands/setup.ts
+++ b/src/cli/commands/setup.ts
@@ -13,6 +13,7 @@ import { spawnSync } from "node:child_process";
 import {
   cpSync,
   existsSync,
+  realpathSync,
   mkdirSync,
   readFileSync,
   writeFileSync,
 } from "node:fs";
+import { dirname } from "node:path";

-    if (!skipDepsInstall) {
-      // `shell: process.platform === "win32"` is required so Node can find
-      // npm's `.cmd` shim via PATHEXT on Windows. Node 24 emits DEP0190
-      // (shell:true concatenates args, theoretical injection vector) — our
-      // args are static so the warning is a known false positive. v1.6
-      // follow-up could resolve npm.cmd to an absolute path to drop shell.
-      const result = spawnSync(
-        "npm",
-        [
-          "install",
-          "--omit=dev",
-          "--ignore-scripts",
-          "--prefer-offline",
-          "--no-audit",
-          "--no-fund",
-        ],
-        {
-          cwd: paths.omcpPluginDir,
-          stdio: "inherit",
-          shell: process.platform === "win32",
-        },
-      );
+    if (!skipDepsInstall) {
+      // Resolve the npm executable without shell:true (avoids Node 24 DEP0190).
+      //
+      // Primary strategy: Node ships npm's CLI at
+      //   <nodedir>/node_modules/npm/bin/npm-cli.js
+      // Spawning `node <npm-cli.js>` with shell:false works on every platform
+      // because process.execPath is always an absolute PE/ELF binary.
+      //
+      // Fallback (unusual custom Node installs without bundled npm): resolve
+      // via `where.exe npm` (Windows) / `which npm` (POSIX), then either
+      // spawn via `cmd.exe /c <npm.cmd>` (Windows .cmd shim) or directly.
+      const nodeDir = dirname(process.execPath);
+      const npmCliJs = join(nodeDir, "node_modules", "npm", "bin", "npm-cli.js");
+
+      let npmBin: string;
+      let npmArgs: string[];
+
+      if (existsSync(npmCliJs)) {
+        // Primary: spawn node directly with npm-cli.js — no shell needed
+        npmBin = process.execPath;
+        npmArgs = [npmCliJs];
+      } else {
+        // Fallback: resolve npm via where/which
+        const whereCmd = process.platform === "win32" ? "where.exe" : "which";
+        const whereR = spawnSync(whereCmd, ["npm"], { encoding: "utf8", shell: false });
+        const resolved = (whereR.stdout ?? "")
+          .trim()
+          .split(/\r?\n/)
+          .map((p) => p.trim())
+          .filter(Boolean);
+        // Prefer .cmd on Windows; take first result on POSIX
+        const npmPath =
+          resolved.find((p) => /\.cmd$/i.test(p)) ?? resolved[0] ?? "npm";
+        if (process.platform === "win32" && /\.cmd$/i.test(npmPath)) {
+          // .cmd shim is not a PE binary — must invoke via cmd.exe /c
+          npmBin = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "cmd.exe");
+          npmArgs = ["/c", npmPath];
+        } else {
+          npmBin = npmPath;
+          npmArgs = [];
+        }
+      }
+
+      const result = spawnSync(
+        npmBin,
+        [
+          ...npmArgs,
+          "install",
+          "--omit=dev",
+          "--ignore-scripts",
+          "--prefer-offline",
+          "--no-audit",
+          "--no-fund",
+        ],
+        {
+          cwd: paths.omcpPluginDir,
+          stdio: "inherit",
+          shell: false,          // ← DEP0190 eliminated
+        },
+      );
```

### Error handling note

The existing ENOENT guard (`result.error.code === "ENOENT"`) remains valid for
the fallback path. For the primary path (`node + npm-cli.js`), ENOENT on
`process.execPath` is impossible in practice; the guard is still harmless.

---

## Why not the `cmd.exe /c npm.cmd` approach as primary?

T3/T6 also work and emit no DEP0190. However:
- Hard-codes `%SystemRoot%\System32\cmd.exe` — works on all Windows but adds
  an unnecessary process layer on Linux/macOS (where `cmd.exe` doesn't exist).
- Still Windows-only; requires a separate POSIX branch.
- The `node + npm-cli.js` approach is cross-platform with no branching needed
  at the spawn level.

---

## Probe scripts

- `docs/probes/dep0190-direction-a/bench.cjs` — 6 variant tests (T1–T6)
- `docs/probes/dep0190-direction-a/bench-dep0190-verify.cjs` — V1/V2
  before/after DEP0190 confirmation

Run from repo root:
```
node docs/probes/dep0190-direction-a/bench.cjs
node docs/probes/dep0190-direction-a/bench-dep0190-verify.cjs
```
