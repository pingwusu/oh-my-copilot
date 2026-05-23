import { describe, expect, it, vi } from "vitest";

import {
  findExecutable,
  resolveExecutableOrName,
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
