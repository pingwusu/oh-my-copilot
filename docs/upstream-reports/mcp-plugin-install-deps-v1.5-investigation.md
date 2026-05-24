# MCP plugin-install missing dependencies — v1.5 investigation

**Date**: 2026-05-24
**Trigger**: v1.4 live smoke at `C:\Users\runjiashi\Temp\omcp-v14-smoke` produced 62 occurrences of:
```
Error [ERR_MODULE_NOT_FOUND]: Cannot find package '@modelcontextprotocol/sdk'
imported from C:\Users\runjiashi\.copilot\installed-plugins\oh-my-copilot\oh-my-copilot\dist\mcp\server-runtime.js
```

---

## Summary

`omcp setup` copies `dist/` into the plugin install directory but deliberately omits `package.json` and never runs `npm install`, so `node_modules/` is absent at the install path. Every MCP server entry-point imports through `dist/mcp/server-runtime.js`, which carries three bare ESM imports from `@modelcontextprotocol/sdk`. The recommended fix is **Option A**: `omcp setup` writes a minimal `package.json` (listing only the four runtime deps) to `omcpPluginDir`, then shells out to `npm install --omit=dev --ignore-scripts` in that directory. This is the npm-canonical flow, keeps the install path self-contained, and requires no new bundler infrastructure.

---

## Part 1: Reproduction + failure mode confirmation

### Plugin install dir contents

Observed at `C:\Users\runjiashi\.copilot\installed-plugins\oh-my-copilot\oh-my-copilot\`:

```
.claude-plugin/   (dir)
agents/           (dir)
dist/             (dir)   ← contains dist/mcp/*.js, dist/cli/omcp.js, etc.
hooks/            (dir)
prompts/          (dir)
scripts/          (dir)
skills/           (dir)
templates/        (dir)
.mcp.json         (file)
AGENTS.md         (file)
CLAUDE.md         (file)
README.md         (file)
```

**Absent**: `node_modules/`, `package.json`.

### Diff vs repo

`C:\Users\runjiashi\oh-my-copilot-r2\` (HEAD v1.4.0) contains:
- `node_modules/@modelcontextprotocol/sdk` — present
- `node_modules/commander` — present
- `node_modules/jsonc-parser` — present
- `node_modules/chalk` — present (though only used in CLI, not MCP servers)
- `package.json` — present

`setup.ts:SOURCE_ROOTS` (lines 37-46) enumerates exactly:
```typescript
const SOURCE_ROOTS = ["agents","skills","prompts","templates","hooks","scripts","dist",".claude-plugin"];
```
`SOURCE_FILES` (line 48): `[".mcp.json","AGENTS.md","CLAUDE.md","README.md"]`

Neither `package.json` nor `node_modules` appears in either list. The `sync-plugin-mirror.ts` script uses the identical `DIR_SOURCES` / `FILE_SOURCES` lists and likewise omits both.

### The MCP config path

`~/.copilot/mcp-config.json` (written by `mergeMcpServers` in `copilot-config.ts`) contains entries like:
```json
"args": ["C:\\Users\\runjiashi\\.copilot\\installed-plugins\\oh-my-copilot\\oh-my-copilot/dist/mcp/state-server-main.js"]
```

Node resolves bare specifiers (`@modelcontextprotocol/sdk`) by walking up from the importing file's directory. The walk starts at `…/oh-my-copilot/oh-my-copilot/dist/mcp/` and finds no `node_modules/` anywhere under `…/oh-my-copilot/oh-my-copilot/`, producing `ERR_MODULE_NOT_FOUND`.

### Confidence

**100% confirmed** — no `node_modules`, no `package.json` at install path; `server-runtime.js` uses bare ESM specifiers pointing to `@modelcontextprotocol/sdk`.

---

## Part 2: All MCP servers' runtime dependencies

All 10 MCP servers delegate to `server-runtime.js` via `import { runMcpServer } from "./server-runtime.js"`. Only `server-runtime.js` imports external packages. The other server files exclusively use `node:*` built-ins and intra-`dist/` relative imports.

Beyond the MCP servers, two other dist files use external packages:

| MCP server file | External imports in server-runtime.js | Other external imports |
|---|---|---|
| `dist/mcp/server-runtime.js` | `@modelcontextprotocol/sdk/server/index.js`, `@modelcontextprotocol/sdk/server/stdio.js`, `@modelcontextprotocol/sdk/types.js` | — |
| `dist/mcp/state-server-main.js` | (via server-runtime.js) | none |
| `dist/mcp/notepad-server.js` | (via server-runtime.js) | none |
| `dist/mcp/trace-server.js` | (via server-runtime.js) | none |
| `dist/mcp/project-memory-server.js` | (via server-runtime.js) | none |
| `dist/mcp/loop-server.js` | (via server-runtime.js) | none |
| `dist/mcp/code-intel-server.js` | (via server-runtime.js) | none |
| `dist/mcp/hermes-server.js` | (via server-runtime.js) | none |
| `dist/mcp/wiki-server.js` | (via server-runtime.js) | none |
| `dist/mcp/python-repl-server.js` | (via server-runtime.js) | none |
| `dist/mcp/shared-memory-server.js` | (via server-runtime.js) | none |
| `dist/cli/omcp.js` | — | `commander` |
| `dist/runtime/copilot-config.js` | — | `jsonc-parser` |

**All four runtime deps** in `package.json` are required at the install path:
- `@modelcontextprotocol/sdk@^1.26.0` — MCP servers (blocked 62 errors)
- `commander@^12.1.0` — CLI (`omcp` binary)
- `jsonc-parser@^3.3.1` — `copilot-config.js` (called by hooks)
- `chalk@^5.3.0` — CLI output formatting (used indirectly)
- `zod@^3.23.8` — present in repo but grep found no direct `from 'zod'` import in dist/mcp or dist/cli/omcp.js; may be indirect via schema helpers

---

## Part 3: Fix options evaluated

| Option | Pros | Cons | Verdict |
|---|---|---|---|
| **A: `npm install --omit=dev` in plugin dir** | npm-canonical; self-contained install; exact versions from lockfile; works after repo moves | Requires npm on PATH at setup time; network access; adds ~5s cold install; on Windows, npm may resolve to a `.cmd` shim needing `shell:true` | **RECOMMENDED** |
| **B: Copy `node_modules/` from repo** | Fast; offline; no npm needed | Copies ~200 packages including devDeps; doubles disk (~50-200 MB); brittle on node version mismatch; syncing on upgrade is non-trivial | FALLBACK only |
| **C: Symlink `node_modules/` from repo** | Zero disk; fast | Windows requires Developer Mode or admin elevation for symlinks; breaks if repo is moved or deleted; fragile in CI | REJECT on Windows |
| **D: esbuild/rollup bundle per server** | Zero install-time deps; single file | Bundler infra addition; `@modelcontextprotocol/sdk` is ESM-only and may not bundle cleanly without special config; all 10 servers need separate bundle entries | DEFERRED (v1.6+) |
| **E: Point `mcp-config.json` at repo `dist/`** | Trivially unblocks today | Ties live Copilot config to a developer repo path; breaks on any user who doesn't have the repo; not a real install | REJECT |
| **F: `@vercel/ncc` or `pkg` single-file** | Truly zero deps | ncc does not handle ESM natively; sdk is ESM-only (`"type":"module"`); would require CJS shim layer; significant build complexity | REJECT |

---

## Part 4: Recommended fix

### Option A: `runSetup` writes `package.json` then runs `npm install --omit=dev`

#### Code changes required

1. **`src/cli/commands/setup.ts`** — after the existing `cpSync` loop (line 91), add:
   - Write a minimal `package.json` to `paths.omcpPluginDir` containing only the four runtime deps (read from the source `package.json`'s `dependencies` field, excluding devDeps).
   - `spawnSync("npm", ["install", "--omit=dev", "--ignore-scripts", "--prefer-offline"], { cwd: paths.omcpPluginDir, stdio: "inherit", shell: process.platform === "win32" })`.
   - Check `status !== 0` and throw a descriptive error with hint to check network/npm.
   - Add `dryRun` guard: skip the spawn in dry-run mode; instead record `npmInstallSkipped: true` on the report.

2. **`src/cli/commands/setup.ts` — `SetupReport` interface** — add:
   ```typescript
   npmInstalled: boolean;
   npmInstallSkipped: boolean;   // true in dryRun
   ```

3. **`src/runtime/paths.ts`** — no changes needed; `omcpPluginDir` is already the right target.

4. **`src/runtime/copilot-config.ts`** — no changes needed.

5. **`SOURCE_FILES` in `setup.ts`** — do NOT add `package.json` to this array. The file written by setup should be a minimal runtime-only manifest, not a verbatim copy of the source `package.json` (which lists devDeps, bin entries, and scripts that are irrelevant and potentially harmful at the install location).

#### Minimal `package.json` to write

```json
{
  "name": "oh-my-copilot-plugin-runtime",
  "version": "<version from source>",
  "type": "module",
  "private": true,
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.26.0",
    "commander": "^12.1.0",
    "chalk": "^5.3.0",
    "zod": "^3.23.8",
    "jsonc-parser": "^3.3.1"
  }
}
```

The `"type": "module"` field is required because `dist/` uses ESM bare specifiers.

#### TDD test outline (vitest, deterministic)

All tests should live in `src/__tests__/setup-npm-install.test.ts`.

```typescript
// Test 1 — setup writes package.json with correct deps
// Given: tmp omcpPluginDir with dist/ already copied
// When:  runSetup({ dryRun: false, ... }) is called (npm spawn mocked via vi.mock)
// Then:  omcpPluginDir/package.json exists and parses to object
//        with "type":"module", dependencies includes "@modelcontextprotocol/sdk"
//        devDependencies key is absent

// Test 2 — setup invokes npm install with correct args
// Given: tmp dir, npm spawn mocked to return status:0
// When:  runSetup called
// Then:  spawn was called with args ["install","--omit=dev","--ignore-scripts"]
//        cwd === omcpPluginDir
//        shell === (process.platform === "win32")

// Test 3 — npm install failure throws descriptive error
// Given: npm spawn mocked to return status:1, stderr:"ENOTFOUND"
// When:  runSetup called
// Then:  rejects with Error message containing "npm install failed" and hint text

// Test 4 — dryRun skips npm spawn
// Given: npm spawn spy
// When:  runSetup({ dryRun: true, ... })
// Then:  spawn never called; report.npmInstallSkipped === true

// Test 5 — idempotency: second setup call does not duplicate node_modules
// Given: omcpPluginDir with existing node_modules/@modelcontextprotocol/sdk (mocked)
// When:  runSetup called twice
// Then:  npm spawn called twice (npm handles idempotency via package-lock); no error

// Test 6 — regression: SOURCE_ROOTS does not include "node_modules"
// (prevents accidental future addition of node_modules to the cpSync list)
// Given: imported SOURCE_ROOTS constant from setup.ts
// Then:  !SOURCE_ROOTS.includes("node_modules")

// Test 7 — regression: SOURCE_FILES does not include "package.json"
// (ensures setup writes its own minimal package.json, not a verbatim copy)
// Then:  !SOURCE_FILES.includes("package.json")
```

### Edge cases

| Scenario | Handling |
|---|---|
| **npm not on PATH** | `spawnSync` returns `error.code === "ENOENT"`; catch and emit actionable error: "npm not found — install Node.js (https://nodejs.org) or run `npm install` manually in `<omcpPluginDir>`" |
| **Offline machine** | `npm install --prefer-offline` uses cache if available; if cache miss, npm exits non-zero; error message should include offline hint and suggest Option B (manual copy) |
| **Windows npm shim** | `shell: process.platform === "win32"` required so that `npm.cmd` resolves correctly via `cmd.exe`; document this explicitly |
| **First install vs upgrade** | npm handles both correctly; `--prefer-offline` helps on subsequent upgrades |
| **OMCP_HOME override** | Already handled by `resolvePaths()`; no changes needed |
| **Concurrent setup calls** | npm uses a lockfile in node_modules; concurrent installs to the same dir are generally safe but may produce verbose warnings; acceptable |
| **`dist/` not built yet** | Existing validation (`JSON.parse(readFileSync(join(packageRoot, ".claude-plugin", "plugin.json")))`) does not check for dist presence; consider adding `existsSync(join(packageRoot,"dist","mcp","server-runtime.js"))` preflight check |

---

## Part 5: Open questions

1. **Should `node_modules/` be `.gitignore`d at the install path?** The install path is under `~/.copilot/` not the repo, so this is not a repo concern. No action needed.

2. **Does Copilot CLI itself ever purge `~/.copilot/installed-plugins/`?** If Copilot nukes the install dir on upgrade, the `node_modules/` would be lost and the user would need to re-run `omcp setup`. A post-install hook or a Copilot lifecycle event (if available) could automate this, but this is v1.6+ scope.

3. **`chalk` and `zod` usage in dist** — grep of `dist/mcp/*.js` and `dist/cli/omcp.js` shows `commander` and `@modelcontextprotocol/sdk` are the only confirmed external imports in those two subtrees. `chalk` and `zod` may be imported transitively via other `dist/runtime/` files. The safe approach is to include all four `dependencies` from `package.json` in the written minimal manifest, rather than auditing transitively.

4. **`@modelcontextprotocol/sdk` ESM compatibility** — the SDK is `"type":"module"` with no CJS build. Options D and F would require a custom ESM bundler config. This is the primary reason they are deferred/rejected.

5. **Lock file at install path** — should setup commit a `package-lock.json` from the repo to `omcpPluginDir` before running `npm install --frozen-lockfile`? This would give exact version reproducibility. Recommended for v1.5 but not strictly required for unblocking the smoke failure.

6. **`postinstall` script in source `package.json`** — the repo's `package.json` has a `postinstall` script (`node dist/scripts/postinstall.js`). The minimal written `package.json` omits `scripts`, so `--ignore-scripts` is a belt-and-suspenders measure; both safeguards should stay.
