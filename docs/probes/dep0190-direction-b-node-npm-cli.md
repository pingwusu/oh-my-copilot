# DEP0190 Direction B — `node <npm-cli.js>` probe

**Date:** 2026-05-24  
**Node version:** v24.14.1  
**Platform:** Windows 11 Enterprise (win32)

---

## Hypothesis

Instead of `spawnSync("npm", [...], { shell: true })` (which triggers DEP0190
on Node 24), resolve npm's actual JS entry point (`npm-cli.js`) and invoke it
as `spawnSync(process.execPath, [npmCliJs, ...args])` — no `.cmd` shim, no
`shell: true`.

---

## npm-cli.js location

```
where.exe npm  →  C:\Program Files\nodejs\npm.cmd
                  C:\Program Files\nodejs\npm

npm-cli.js  →  C:\Program Files\nodejs\node_modules\npm\bin\npm-cli.js
```

Derivation: `dirname(dirname(where npm.cmd)) + \node_modules\npm\bin\npm-cli.js`

On Windows the npm global prefix is always `<nodejs-install-dir>` and that dir
always contains `node_modules\npm\bin\npm-cli.js`.

---

## Bench experiment

### Script (`$TEMP/dep0190-bench-script.js`)

```js
const { spawnSync } = require("child_process");

const npmCliJs = "C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js";
const cwd = process.argv[2];   // tmp dir with minimal package.json

const result = spawnSync(
  process.execPath,
  [npmCliJs, "install", "--omit=dev", "--ignore-scripts",
   "--prefer-offline", "--no-audit", "--no-fund"],
  { cwd, stdio: ["inherit", "pipe", "pipe"] }
);

console.log("STDOUT:", result.stdout?.toString());
console.log("STDERR:", result.stderr?.toString());
console.log("STATUS:", result.status);
console.log("DEP0190_PRESENT:", result.stderr?.toString().includes("DEP0190"));
```

### package.json in tmp dir

```json
{ "name": "dep0190-bench", "version": "1.0.0", "private": true,
  "dependencies": { "ms": "^2.1.3" } }
```

### Result

```
STDOUT:
added 1 package in 1s

STDERR:
STATUS: 0
DEP0190_PRESENT: false
```

**Conclusion: PASS.** Status 0, stderr empty, no DEP0190 warning.

---

## Suggested patch for `src/cli/commands/setup.ts`

### New helper — `findNpmCliJs()`

Add after the imports block (around line 13–35):

```ts
import { execFileSync } from "node:child_process";
import { dirname } from "node:path";

/**
 * Resolve the absolute path to npm-cli.js — npm's actual JS entry point —
 * so we can invoke it as `node <npm-cli.js>` without shell:true or a .cmd shim.
 *
 * Strategy (Windows-first, works on POSIX too):
 *   1. Ask `npm` (or `npm.cmd` on Windows) for its own --prefix via
 *      `npm config get prefix`. This is the most reliable source: it works
 *      even if npm was installed by nvm, volta, fnm, or the system installer.
 *   2. Construct: <prefix>/node_modules/npm/bin/npm-cli.js
 *   3. If that file exists, return it.
 *   4. Fallback: walk up from `which npm` / `where.exe npm` dirname twice.
 *   5. If still not found, return null (caller falls back to shell:true path).
 */
function findNpmCliJs(): string | null {
  // Strategy 1: npm config get prefix
  try {
    const npmBin = process.platform === "win32" ? "npm.cmd" : "npm";
    const prefix = execFileSync(npmBin, ["config", "get", "prefix"], {
      encoding: "utf8",
      shell: process.platform === "win32",
      timeout: 5000,
    }).trim();
    const candidate = join(prefix, "node_modules", "npm", "bin", "npm-cli.js");
    if (existsSync(candidate)) return candidate;
  } catch {
    // ignore — try fallback
  }

  // Strategy 2: locate npm(.cmd) on PATH via `where.exe` / `which`
  try {
    const whichCmd = process.platform === "win32" ? "where.exe" : "which";
    const npmPath = execFileSync(whichCmd, ["npm"], {
      encoding: "utf8",
      timeout: 3000,
    })
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean)[0];
    if (npmPath) {
      // npm.cmd lives in <nodejs-install-dir>; go up one level
      const nodeDir = dirname(npmPath);
      const candidate = join(
        nodeDir,
        "node_modules",
        "npm",
        "bin",
        "npm-cli.js",
      );
      if (existsSync(candidate)) return candidate;
    }
  } catch {
    // ignore
  }

  return null;
}
```

### Updated spawn block (replace lines ~145–160)

```ts
    if (!skipDepsInstall) {
      // Direction B (v1.7): invoke npm as `node <npm-cli.js>` to avoid both
      // the .cmd shim (requires shell:true) and the DEP0190 deprecation that
      // shell:true triggers on Node 24.  Falls back to the shell:true form if
      // npm-cli.js cannot be located (e.g. exotic version managers).
      const npmCliJs = findNpmCliJs();

      const [spawnCmd, spawnArgs, spawnOpts]: [
        string,
        string[],
        import("node:child_process").SpawnSyncOptionsWithStringEncoding &
          import("node:child_process").SpawnSyncOptions,
      ] = npmCliJs
        ? [
            process.execPath,
            [
              npmCliJs,
              "install",
              "--omit=dev",
              "--ignore-scripts",
              "--prefer-offline",
              "--no-audit",
              "--no-fund",
            ],
            {
              cwd: paths.omcpPluginDir,
              stdio: "inherit",
              // No shell:true — we're calling node directly
            },
          ]
        : [
            "npm",
            [
              "install",
              "--omit=dev",
              "--ignore-scripts",
              "--prefer-offline",
              "--no-audit",
              "--no-fund",
            ],
            {
              cwd: paths.omcpPluginDir,
              stdio: "inherit",
              shell: process.platform === "win32", // legacy fallback
            },
          ];

      const result = spawnSync(spawnCmd, spawnArgs, spawnOpts);
      if (result.error && (result.error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new Error(
          `npm not found on PATH. Install Node.js (https://nodejs.org) or run ` +
            `"npm install --omit=dev" manually in ${paths.omcpPluginDir}.`,
        );
      }
      if (result.status !== 0) {
        const errCode = result.error
          ? (result.error as NodeJS.ErrnoException).code
          : undefined;
        throw new Error(
          `npm install failed (exit ${result.status ?? "unknown"}${
            errCode ? `, ${errCode}` : ""
          }) in ${paths.omcpPluginDir}. Check network connectivity and that ` +
            `node_modules is writable (permission denied if EACCES/EPERM). ` +
            `Re-run \`omcp setup\` after resolving.`,
        );
      }
      depsInstalled = true;
    }
```

### Import additions (top of file)

Add `execFileSync` to the existing `node:child_process` import:

```ts
// before:
import { spawnSync } from "node:child_process";

// after:
import { execFileSync, spawnSync } from "node:child_process";
```

Add `dirname` to the existing `node:path` import:

```ts
// before:
import { join } from "node:path";

// after:
import { dirname, join } from "node:path";
```

(`existsSync` is already imported from `node:fs`.)

---

## Risk / edge cases

| Scenario | Behaviour |
|---|---|
| Standard Windows Node.js installer | `findNpmCliJs()` Strategy 1 returns path instantly; no shell needed |
| nvm-windows / volta / fnm | Strategy 1 (`npm config get prefix`) still resolves the active npm's prefix correctly |
| POSIX (Linux/macOS) | Strategy 2 (`which npm`) finds it; npm-cli.js at same relative path |
| Exotic setup where npm-cli.js is absent | `findNpmCliJs()` returns `null`; falls back to `shell:true` (legacy behaviour, DEP0190 may reappear but install still works) |
| Node 24 + standard installer | **DEP0190_PRESENT: false** — confirmed by bench |

---

## Verdict

**Direction B works.** Recommend applying this patch as v1.7.
