import { describe, expect, it, vi } from "vitest";

import {
  findExecutable,
  resolveExecutableOrName,
  resolveNpmShimScript,
  spawnCrossPlatform,
  spawnSyncCrossPlatform,
} from "../runtime/resolve-executable.js";

// findExecutable scans PATH × PATHEXT (Windows) or PATH alone (POSIX) and
// returns the first existing match. Path operations are dispatched on the
// `platform` option so tests can drive POSIX behavior from a Windows host
// and vice versa.
describe("findExecutable — cross-platform PATH/PATHEXT lookup", () => {
  it("returns null when name is empty", () => {
    expect(
      findExecutable("", { platform: "linux", path: "/usr/bin", exists: () => true }),
    ).toBeNull();
  });

  it("returns null when PATH is empty string", () => {
    expect(
      findExecutable("foo", { platform: "linux", path: "", exists: () => true }),
    ).toBeNull();
  });

  it("returns null when PATH is set but no candidate exists", () => {
    expect(
      findExecutable("foo", { platform: "linux", path: "/usr/bin:/bin", exists: () => false }),
    ).toBeNull();
  });

  it("POSIX: returns first PATH-dir match without extension, short-circuits remaining dirs", () => {
    const probed: string[] = [];
    const result = findExecutable("foo", {
      platform: "linux",
      path: "/a:/b:/c",
      exists: (p) => {
        probed.push(p);
        return p === "/b/foo";
      },
    });
    expect(result).toBe("/b/foo");
    // Probes /a/foo (miss), then /b/foo (hit); /c/foo never probed.
    expect(probed).toEqual(["/a/foo", "/b/foo"]);
  });

  it("POSIX: does NOT probe PATHEXT extensions even when supplied", () => {
    const probed: string[] = [];
    findExecutable("foo", {
      platform: "linux",
      path: "/a",
      pathext: ".CMD;.EXE",
      exists: (p) => {
        probed.push(p);
        return false;
      },
    });
    expect(probed).toEqual(["/a/foo"]);
  });

  it("Windows: probes PATHEXT extensions in declared order, then bare name", () => {
    const probed: string[] = [];
    findExecutable("copilot", {
      platform: "win32",
      path: "C:\\bin",
      pathext: ".COM;.EXE;.CMD",
      exists: (p) => {
        probed.push(p);
        return false;
      },
    });
    expect(probed).toEqual([
      "C:\\bin\\copilot.COM",
      "C:\\bin\\copilot.EXE",
      "C:\\bin\\copilot.CMD",
      "C:\\bin\\copilot",
    ]);
  });

  it("Windows: returns first PATHEXT match", () => {
    const result = findExecutable("copilot", {
      platform: "win32",
      path: "C:\\bin",
      pathext: ".EXE;.CMD",
      exists: (p) => p === "C:\\bin\\copilot.CMD",
    });
    expect(result).toBe("C:\\bin\\copilot.CMD");
  });

  it("Windows: scans multiple PATH directories in order, first dir with match wins", () => {
    const result = findExecutable("foo", {
      platform: "win32",
      path: "C:\\a;C:\\b;C:\\c",
      pathext: ".CMD",
      exists: (p) => p === "C:\\b\\foo.CMD" || p === "C:\\c\\foo.CMD",
    });
    expect(result).toBe("C:\\b\\foo.CMD");
  });

  it("Windows: tolerates .ps1-only shim when .cmd/.exe missing (probe order respected)", () => {
    const result = findExecutable("foo", {
      platform: "win32",
      path: "C:\\bin",
      pathext: ".EXE;.CMD;.PS1",
      exists: (p) => p === "C:\\bin\\foo.PS1",
    });
    expect(result).toBe("C:\\bin\\foo.PS1");
  });

  it("Windows: uses an explicit PATHEXT-default-equivalent when override is empty string", () => {
    // pathext: "" hits the truthy override path. We don't want the default to
    // kick in when an empty string is explicitly passed — empty means "no
    // extensions to probe", so the only candidate is the bare name.
    const probed: string[] = [];
    findExecutable("foo", {
      platform: "win32",
      path: "C:\\bin",
      pathext: "",
      exists: (p) => {
        probed.push(p);
        return false;
      },
    });
    expect(probed).toEqual(["C:\\bin\\foo"]);
  });

  it("POSIX: ignores empty entries in PATH (consecutive delimiters)", () => {
    const probed: string[] = [];
    findExecutable("foo", {
      platform: "linux",
      path: ":/a::/b:",
      exists: (p) => {
        probed.push(p);
        return false;
      },
    });
    expect(probed).toEqual(["/a/foo", "/b/foo"]);
  });
});

describe("resolveExecutableOrName — fallback wrapper", () => {
  it("returns the resolved absolute path when found", () => {
    expect(
      resolveExecutableOrName("foo", {
        platform: "linux",
        path: "/a",
        exists: (p) => p === "/a/foo",
      }),
    ).toBe("/a/foo");
  });

  it("returns the bare name when nothing on PATH matches", () => {
    expect(
      resolveExecutableOrName("foo", {
        platform: "linux",
        path: "/a",
        exists: () => false,
      }),
    ).toBe("foo");
  });

  it("returns the bare name when PATH is empty", () => {
    expect(
      resolveExecutableOrName("foo", { platform: "linux", path: "", exists: () => true }),
    ).toBe("foo");
  });
});

describe("spawnSyncCrossPlatform — Windows .cmd wrapper", () => {
  it("POSIX: spawns the resolved path directly with no cmd.exe wrapper", () => {
    const fakeSpawnSync = vi.fn().mockReturnValue({ status: 0 });
    spawnSyncCrossPlatform("foo", ["--version"], {
      platform: "linux",
      resolved: "/usr/bin/foo",
      spawnSync: fakeSpawnSync as any,
      stdio: "inherit",
    });
    expect(fakeSpawnSync).toHaveBeenCalledOnce();
    const [cmd, args, opts] = fakeSpawnSync.mock.calls[0];
    expect(cmd).toBe("/usr/bin/foo");
    expect(args).toEqual(["--version"]);
    expect(opts).toMatchObject({ stdio: "inherit" });
  });

  it("Windows: wraps .cmd target through cmd.exe /d /s /c with quoted args", () => {
    const fakeSpawnSync = vi.fn().mockReturnValue({ status: 0 });
    spawnSyncCrossPlatform("copilot", ["-p", "hello world", "--allow-all-tools"], {
      platform: "win32",
      resolved: "C:\\bin\\copilot.CMD",
      spawnSync: fakeSpawnSync as any,
      stdio: "inherit",
    });
    expect(fakeSpawnSync).toHaveBeenCalledOnce();
    const [cmd, args] = fakeSpawnSync.mock.calls[0];
    expect(cmd).toBe("cmd.exe");
    expect(args[0]).toBe("/d");
    expect(args[1]).toBe("/c");
    // The cmd.exe /c outer-quote strip means we emit an EXTRA outer pair so
    // the inner command line survives. Inner tokens are each quoted.
    expect(args[2]).toBe('""C:\\bin\\copilot.CMD" "-p" "hello world" "--allow-all-tools""');
  });

  it("Windows: .exe target bypasses cmd.exe wrapper (direct spawn)", () => {
    const fakeSpawnSync = vi.fn().mockReturnValue({ status: 0 });
    spawnSyncCrossPlatform("foo", ["bar"], {
      platform: "win32",
      resolved: "C:\\bin\\foo.exe",
      spawnSync: fakeSpawnSync as any,
    });
    const [cmd] = fakeSpawnSync.mock.calls[0];
    expect(cmd).toBe("C:\\bin\\foo.exe");
  });

  it("Windows: doubles internal quotes per cmd.exe escaping rules", () => {
    const fakeSpawnSync = vi.fn().mockReturnValue({ status: 0 });
    spawnSyncCrossPlatform("copilot", ['hello "world"'], {
      platform: "win32",
      resolved: "C:\\bin\\copilot.CMD",
      spawnSync: fakeSpawnSync as any,
    });
    const [, args] = fakeSpawnSync.mock.calls[0];
    expect(args[2]).toBe('""C:\\bin\\copilot.CMD" "hello ""world""""');
  });
});

describe("spawnCrossPlatform — async wrapper", () => {
  it("Windows: wraps .bat target through cmd.exe", () => {
    const fakeSpawn = vi.fn().mockReturnValue({ pid: 1234 });
    spawnCrossPlatform("foo", ["arg1"], {
      platform: "win32",
      resolved: "C:\\bin\\foo.bat",
      spawn: fakeSpawn as any,
      detached: true,
    });
    const [cmd, args, opts] = fakeSpawn.mock.calls[0];
    expect(cmd).toBe("cmd.exe");
    expect(args[0]).toBe("/d");
    expect(opts).toMatchObject({ detached: true, shell: false });
  });

  it("POSIX: passes through to underlying spawn", () => {
    const fakeSpawn = vi.fn().mockReturnValue({ pid: 5678 });
    spawnCrossPlatform("foo", ["arg1"], {
      platform: "linux",
      resolved: "/usr/bin/foo",
      spawn: fakeSpawn as any,
    });
    const [cmd] = fakeSpawn.mock.calls[0];
    expect(cmd).toBe("/usr/bin/foo");
  });
});

// resolveNpmShimScript: parses npm-shim .cmd files to extract the
// underlying node-script path. Used by team.ts's detached spawn path to
// bypass the cmd.exe wrapper on Windows, since /dev/null stdio + detached
// causes Copilot CLI (and other npm-installed CLIs) to fail silently.
describe("resolveNpmShimScript — npm .cmd shim parser", () => {
  const CANONICAL_SHIM = `@ECHO off
GOTO start
:find_dp0
SET dp0=%~dp0
EXIT /b
:start
SETLOCAL
CALL :find_dp0

IF EXIST "%dp0%\\node.exe" (
  SET "_prog=%dp0%\\node.exe"
) ELSE (
  SET "_prog=node"
  SET PATHEXT=%PATHEXT:;.JS;=;%
)

endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\@github\\copilot\\npm-loader.js" %*
`;

  it("returns null on non-Windows platforms (POSIX has no .cmd shims)", () => {
    const result = resolveNpmShimScript("/usr/bin/copilot", {
      readFile: () => CANONICAL_SHIM,
      platform: "linux",
    });
    expect(result).toBeNull();
  });

  it("returns null when path does not end in .cmd", () => {
    const result = resolveNpmShimScript("C:\\foo\\copilot.exe", {
      readFile: () => CANONICAL_SHIM,
      platform: "win32",
    });
    expect(result).toBeNull();
  });

  it("extracts the npm-loader.js path from the canonical npm shim", () => {
    const result = resolveNpmShimScript("C:\\.tools\\.npm-global\\copilot.cmd", {
      readFile: () => CANONICAL_SHIM,
      platform: "win32",
    });
    expect(result).not.toBeNull();
    expect(result?.scriptPath).toBe(
      "C:\\.tools\\.npm-global\\node_modules\\@github\\copilot\\npm-loader.js",
    );
  });

  it("returns null on hand-written .cmd files lacking the npm-shim pattern", () => {
    const handWritten = `@echo off\nrem just a regular batch file\necho hello\n`;
    const result = resolveNpmShimScript("C:\\foo\\thing.cmd", {
      readFile: () => handWritten,
      platform: "win32",
    });
    expect(result).toBeNull();
  });

  it("returns null when readFile throws (missing or unreadable shim)", () => {
    const result = resolveNpmShimScript("C:\\nonexistent\\foo.cmd", {
      readFile: () => {
        throw new Error("ENOENT");
      },
      platform: "win32",
    });
    expect(result).toBeNull();
  });

  it("handles forward-slash variants in the shim's %dp0% line", () => {
    const fwdSlashShim = CANONICAL_SHIM.replace(
      "%dp0%\\node_modules\\@github\\copilot\\npm-loader.js",
      "%dp0%/node_modules/@github/copilot/npm-loader.js",
    );
    const result = resolveNpmShimScript("C:\\.tools\\.npm-global\\copilot.cmd", {
      readFile: () => fwdSlashShim,
      platform: "win32",
    });
    expect(result).not.toBeNull();
    // path.win32.join normalizes forward slashes to backslashes
    expect(result?.scriptPath).toBe(
      "C:\\.tools\\.npm-global\\node_modules\\@github\\copilot\\npm-loader.js",
    );
  });

  it("works for any npm-installed CLI, not just copilot (generic shim format)", () => {
    const otherCliShim = CANONICAL_SHIM.replace(
      "@github\\copilot\\npm-loader.js",
      "vitest\\vitest.mjs",
    );
    const result = resolveNpmShimScript("C:\\.npm\\vitest.cmd", {
      readFile: () => otherCliShim,
      platform: "win32",
    });
    expect(result?.scriptPath).toBe("C:\\.npm\\node_modules\\vitest\\vitest.mjs");
  });

  it("matches .cjs script targets (CommonJS shim variant)", () => {
    const cjsShim = CANONICAL_SHIM.replace(
      "@github\\copilot\\npm-loader.js",
      "some-pkg\\bin\\entry.cjs",
    );
    const result = resolveNpmShimScript("C:\\.npm\\some-cli.cmd", {
      readFile: () => cjsShim,
      platform: "win32",
    });
    expect(result?.scriptPath).toBe("C:\\.npm\\node_modules\\some-pkg\\bin\\entry.cjs");
  });

  it("default readFile (no injection) works in ESM contexts — regression for v2.2.x dist", async () => {
    // Without an injected readFile, the helper falls back to fs.readFileSync.
    // The prior implementation used `require("node:fs").readFileSync` which
    // silently fails in ESM (require is undefined) → returns null → callers
    // silently fall back to the broken cmd.exe wrapper path. This test pins
    // the ESM-safe import of readFileSync at module top.
    const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const tmp = mkdtempSync(join(tmpdir(), "shim-esm-"));
    const cmdPath = join(tmp, "fake-cli.cmd");
    writeFileSync(cmdPath, CANONICAL_SHIM, "utf8");
    try {
      const result = resolveNpmShimScript(cmdPath, { platform: "win32" });
      expect(result).not.toBeNull();
      expect(result?.scriptPath).toMatch(/npm-loader\.js$/);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
