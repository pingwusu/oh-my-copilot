// Cross-platform executable resolution + safe spawn wrappers.
//
// Why this exists:
//   1. Node `spawn(name, args, { shell: false })` on Windows does NOT search
//      PATHEXT for `.cmd` / `.ps1` / `.exe` shims. npm-installed CLIs land as
//      `.cmd` shims in the global bin, so a bare `spawn("copilot")` fails
//      with ENOENT on Windows even though `which copilot` returns a path.
//   2. Since Node 18.20.x / 20.12.x / 22.0.x (CVE-2024-27980 mitigation),
//      spawning a `.cmd` / `.bat` file directly with `shell: false` is
//      blocked with EINVAL even when the absolute path is supplied. The
//      official Node-recommended workaround is to spawn `cmd.exe /d /s /c
//      "<absolute path>" args...` and let cmd.exe interpret the shim.
//
// findExecutable / resolveExecutableOrName: pure-sync PATH × PATHEXT scanner.
// spawnSyncCrossPlatform / spawnCrossPlatform: spawn wrappers that resolve
// the name through findExecutable AND wrap .cmd/.bat targets through cmd.exe
// on Windows.
//
// All functions accept an options bag of injectable dependencies (path/exists/
// platform/pathext/spawn) so unit tests don't need a real filesystem or PATH.

import {
  spawn as nodeSpawn,
  spawnSync as nodeSpawnSync,
  type ChildProcess,
  type SpawnOptions,
  type SpawnSyncOptions,
  type SpawnSyncReturns,
} from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { posix as pathPosix, win32 as pathWin32 } from "node:path";

export interface FindExecutableOptions {
  /** Override the PATH lookup string (defaults to process.env.PATH). */
  path?: string;
  /** Override the PATHEXT lookup string on Windows (defaults to process.env.PATHEXT). */
  pathext?: string;
  /** Override the platform check (defaults to process.platform). */
  platform?: NodeJS.Platform;
  /** Injectable existence check, for tests. */
  exists?: (candidate: string) => boolean;
}

const DEFAULT_PATHEXT = ".COM;.EXE;.BAT;.CMD";

/**
 * Find the absolute path of an executable on PATH. On Windows, also probes
 * extensions from PATHEXT (default `.COM;.EXE;.BAT;.CMD` when PATHEXT is
 * missing) plus a trailing extensionless candidate. Returns the first
 * existing match, or `null` when nothing on PATH matches.
 *
 * The name parameter must be a bare command name (e.g. "copilot"), not a
 * relative or absolute path — for those, the caller should use them directly.
 */
export function findExecutable(
  name: string,
  opts: FindExecutableOptions = {},
): string | null {
  if (!name) return null;
  const platform = opts.platform ?? process.platform;
  const pathStr = opts.path ?? process.env.PATH ?? "";
  if (!pathStr) return null;
  const exists = opts.exists ?? existsSync;

  // Use platform-specific `path` to honor the caller's stated platform — the
  // host machine running the test may differ from the platform under test.
  const p = platform === "win32" ? pathWin32 : pathPosix;
  const dirs = pathStr.split(p.delimiter).filter((d) => d.length > 0);
  if (dirs.length === 0) return null;

  let exts: string[];
  if (platform === "win32") {
    const pathextStr = opts.pathext ?? process.env.PATHEXT ?? DEFAULT_PATHEXT;
    // Probe PATHEXT entries as-listed (preserves the user's stated preference
    // order) and append "" so an extensionless POSIX shim is also considered
    // as a last resort.
    exts = pathextStr.split(";").filter((e) => e.length > 0).concat([""]);
  } else {
    exts = [""];
  }

  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = p.join(dir, name + ext);
      if (exists(candidate)) return candidate;
    }
  }
  return null;
}

/**
 * Convenience wrapper: returns the resolved absolute path of `name` if found,
 * otherwise returns `name` unchanged. This preserves the old code-path
 * behavior at spawn sites that previously passed the bare name and relied on
 * the OS to resolve it.
 */
export function resolveExecutableOrName(
  name: string,
  opts: FindExecutableOptions = {},
): string {
  return findExecutable(name, opts) ?? name;
}

// ---------------------------------------------------------------------------
// Safe spawn wrappers
// ---------------------------------------------------------------------------

/**
 * True when the resolved path points at a Windows .cmd/.bat shim that Node's
 * post-CVE-2024-27980 spawn refuses to launch directly.
 */
function needsCmdWrapper(
  resolved: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  return platform === "win32" && /\.(cmd|bat)$/i.test(resolved);
}

/**
 * Quote a single argument for cmd.exe `/c` interpretation. Wraps the string
 * in double quotes and doubles any embedded `"` per cmd.exe parsing rules.
 */
function quoteCmdArg(s: string): string {
  return `"${s.replace(/"/g, '""')}"`;
}

export interface SpawnSyncCrossPlatformOptions extends SpawnSyncOptions {
  /** Injection points for testing. */
  spawnSync?: typeof nodeSpawnSync;
  platform?: NodeJS.Platform;
  resolved?: string; // pre-resolved path override (skips findExecutable)
}

/**
 * `spawnSync` wrapper that handles Windows .cmd/.bat shims by dispatching
 * through `cmd.exe /d /s /c`. Args are quoted per cmd.exe rules. On POSIX,
 * delegates straight to Node's spawnSync.
 */
export function spawnSyncCrossPlatform(
  name: string,
  args: string[],
  opts: SpawnSyncCrossPlatformOptions = {},
): SpawnSyncReturns<Buffer | string> {
  const platform = opts.platform ?? process.platform;
  const spawnSyncImpl = opts.spawnSync ?? nodeSpawnSync;
  const resolved = opts.resolved ?? resolveExecutableOrName(name, { platform });
  const { spawnSync: _, platform: _p, resolved: _r, ...nodeOpts } = opts;

  if (needsCmdWrapper(resolved, platform)) {
    // cmd.exe /c strips the OUTER quote pair when the command-line starts AND
    // ends with `"`. We always emit a quoted command and quoted args, so we
    // wrap the entire thing in an extra pair of quotes — cmd.exe strips them,
    // leaving the inner `"<cmd>" "<arg>"...` to be parsed correctly.
    const cmdLine = `"${[resolved, ...args].map(quoteCmdArg).join(" ")}"`;
    return spawnSyncImpl("cmd.exe", ["/d", "/c", cmdLine], {
      ...nodeOpts,
      shell: false,
      // cmd.exe handles /c parsing itself; tell Node to pass the args verbatim
      // rather than re-escaping and turning our `"..."` into `\"...\"`.
      windowsVerbatimArguments: true,
    });
  }
  return spawnSyncImpl(resolved, args, nodeOpts);
}

export interface SpawnCrossPlatformOptions extends SpawnOptions {
  spawn?: typeof nodeSpawn;
  platform?: NodeJS.Platform;
  resolved?: string;
}

/**
 * Result of resolving an npm-installed Windows .cmd shim to its underlying
 * node-script invocation.
 *
 * The npm shim format (from `npm` / `pnpm` / `yarn` install) is:
 *
 *     @ECHO off
 *     ...
 *     "%_prog%"  "%dp0%\node_modules\<package>\...js" %*
 *
 * where `%dp0%` is the .cmd's parent directory. This helper extracts the
 * underlying `.js` path so callers can spawn it directly via Node, bypassing
 * the cmd.exe wrapper. The reason this matters: on Windows, `cmd.exe /d /c
 * "<.cmd>" args` + `detached:true` + `stdio:"ignore"` causes Copilot CLI
 * (and other npm-installed CLIs that need a usable stdio for their TUI
 * renderer) to fail silently because /dev/null isn't a usable target.
 * Spawning the underlying node-script directly + redirecting stdio to a real
 * file descriptor restores observable behavior.
 *
 * Returns null when the .cmd is not an npm shim (e.g. hand-written .cmd
 * files or .bat scripts without the canonical shim pattern). Callers should
 * fall back to the cmd.exe wrapper in that case.
 */
export interface NpmShimResolution {
  /** Absolute path of the node script the shim ultimately invokes. */
  scriptPath: string;
}

export function resolveNpmShimScript(
  cmdPath: string,
  opts: {
    /** Test injection point. */
    readFile?: (p: string) => string;
    platform?: NodeJS.Platform;
  } = {},
): NpmShimResolution | null {
  const platform = opts.platform ?? process.platform;
  if (platform !== "win32") return null;
  if (!/\.cmd$/i.test(cmdPath)) return null;

  let body: string;
  try {
    const read = opts.readFile ?? ((p: string) => readFileSync(p, "utf8"));
    body = read(cmdPath);
  } catch {
    return null;
  }

  // Match the canonical npm-shim final invocation line:
  //   "%_prog%"  "%dp0%\path\to\script.js" %*
  // The script path is %dp0%-relative (i.e. relative to the .cmd's dir).
  // Tolerate any whitespace between the two quoted tokens. We DO NOT match
  // arbitrary `node "<absolute>" args` — only the %dp0%-relative form npm
  // shims emit, since absolute-path .cmd files cannot be resolved
  // deterministically without executing them.
  const match = body.match(/"%_prog%"\s+"%dp0%([\\\/].+?\.(?:c|m)?js)"/i);
  if (!match) return null;
  const cmdDir = pathWin32.dirname(cmdPath);
  const scriptRelative = match[1].replace(/\\/g, pathWin32.sep);
  // %dp0% includes a trailing backslash; the match captures from the
  // separator onward, so just join with dirname.
  const scriptPath = pathWin32.join(cmdDir, scriptRelative);
  return { scriptPath };
}

/**
 * Async `spawn` wrapper that handles Windows .cmd/.bat shims the same way
 * as spawnSyncCrossPlatform. Returns a ChildProcess.
 */
export function spawnCrossPlatform(
  name: string,
  args: string[],
  opts: SpawnCrossPlatformOptions = {},
): ChildProcess {
  const platform = opts.platform ?? process.platform;
  const spawnImpl = opts.spawn ?? nodeSpawn;
  const resolved = opts.resolved ?? resolveExecutableOrName(name, { platform });
  const { spawn: _, platform: _p, resolved: _r, ...nodeOpts } = opts;

  if (needsCmdWrapper(resolved, platform)) {
    const cmdLine = `"${[resolved, ...args].map(quoteCmdArg).join(" ")}"`;
    return spawnImpl("cmd.exe", ["/d", "/c", cmdLine], {
      ...nodeOpts,
      shell: false,
      windowsVerbatimArguments: true,
    });
  }
  return spawnImpl(resolved, args, nodeOpts);
}
