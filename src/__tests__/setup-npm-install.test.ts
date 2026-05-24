/**
 * Deterministic tests for the v1.5 fix: omcp setup writes a minimal
 * runtime package.json + runs npm install in the plugin install dir so
 * MCP servers can resolve `@modelcontextprotocol/sdk` and other runtime
 * deps when Copilot launches them.
 *
 * Background: v1.4 live smoke produced 62 occurrences of
 *   Error [ERR_MODULE_NOT_FOUND]: Cannot find package
 *   '@modelcontextprotocol/sdk' imported from
 *   ~/.copilot/installed-plugins/oh-my-copilot/oh-my-copilot/dist/mcp/
 *   server-runtime.js
 *
 * because `omcp setup` copied `dist/` but never wrote a package.json or
 * installed dependencies at that path. v1.5 fixes this by writing a
 * minimal `package.json` (runtime deps only) and shelling out to
 * `npm install --omit=dev --ignore-scripts --prefer-offline`.
 *
 * These tests use vi.mock to intercept node:child_process.spawnSync so
 * the tests never actually shell out to npm.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  mkdtempSync,
  readFileSync,
  existsSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ── Mock child_process.spawnSync ─────────────────────────────────────────────
//
// vi.mock is hoisted above all imports — declaring spawnSyncMock via
// vi.hoisted ensures it exists when the factory closure runs.

const { spawnSyncMock } = vi.hoisted(() => ({
  spawnSyncMock: vi.fn(),
}));

vi.mock("node:child_process", () => ({
  spawnSync: spawnSyncMock,
}));

// ── Imports (after mocks) ────────────────────────────────────────────────────

import { runSetup, type SetupReport } from "../cli/commands/setup.js";
import {
  SOURCE_ROOTS as SETUP_SOURCE_ROOTS,
  SOURCE_FILES as SETUP_SOURCE_FILES,
} from "../cli/commands/setup.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

const PACKAGE_ROOT = join(__dirname, "..", "..");

let tmp: string;
let prevHome: string | undefined;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "omcp-setup-npm-"));
  prevHome = process.env.OMCP_HOME;
  process.env.OMCP_HOME = tmp;
  spawnSyncMock.mockClear();
  // Default mock: success.
  spawnSyncMock.mockImplementation(
    () =>
      ({
        status: 0,
        pid: 1,
        stdout: Buffer.from(""),
        stderr: Buffer.from(""),
        output: [],
        signal: null,
      }) as ReturnType<typeof import("node:child_process").spawnSync>,
  );
});

afterEach(() => {
  if (prevHome === undefined) delete process.env.OMCP_HOME;
  else process.env.OMCP_HOME = prevHome;
  rmSync(tmp, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function pluginPkgJsonPath(): string {
  return join(tmp, "installed-plugins", "oh-my-copilot", "oh-my-copilot", "package.json");
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("setup writes minimal runtime package.json + runs npm install (v1.5)", () => {
  it("test 1: writes package.json with runtime deps + type:module + private:true", async () => {
    const report: SetupReport = await runSetup({ packageRoot: PACKAGE_ROOT });

    expect(existsSync(pluginPkgJsonPath())).toBe(true);
    const written = JSON.parse(readFileSync(pluginPkgJsonPath(), "utf8"));
    expect(written.name).toBe("oh-my-copilot-plugin-runtime");
    expect(written.type).toBe("module");
    expect(written.private).toBe(true);
    expect(written.dependencies).toBeDefined();
    expect(written.dependencies["@modelcontextprotocol/sdk"]).toBeDefined();
    expect(written.dependencies["commander"]).toBeDefined();
    expect(written.dependencies["jsonc-parser"]).toBeDefined();
    // devDependencies must be absent — install path must NEVER pull devDeps.
    expect(written.devDependencies).toBeUndefined();
    // scripts must be absent — no postinstall, no build steps.
    expect(written.scripts).toBeUndefined();
    // bin must be absent — install path is not a CLI entry point.
    expect(written.bin).toBeUndefined();
    expect(report.depsInstalled).toBe(true);
    expect(report.depsInstallSkipped).toBe(false);
  });

  it("test 2: first-time install (no lockfile) invokes `npm install` with correct args + cwd + windows-shell guard", async () => {
    await runSetup({ packageRoot: PACKAGE_ROOT });

    expect(spawnSyncMock).toHaveBeenCalledTimes(1);
    const [cmd, args, options] = spawnSyncMock.mock.calls[0] as [
      string,
      string[],
      Record<string, unknown>,
    ];
    expect(cmd).toBe("npm");
    expect(args).toEqual([
      "install",
      "--omit=dev",
      "--ignore-scripts",
      "--prefer-offline",
      "--no-audit",
      "--no-fund",
    ]);
    expect(options.cwd).toBe(
      join(tmp, "installed-plugins", "oh-my-copilot", "oh-my-copilot"),
    );
    expect(options.shell).toBe(process.platform === "win32");
  });

  it("test 2b (v1.7 US-04): existing lockfile triggers `npm ci` for reproducibility", async () => {
    // Pre-create a fake lockfile at the plugin install dir so setup
    // sees existsSync(lockfile) === true and switches to npm ci.
    const pluginDir = join(tmp, "installed-plugins", "oh-my-copilot", "oh-my-copilot");
    require("node:fs").mkdirSync(pluginDir, { recursive: true });
    require("node:fs").writeFileSync(join(pluginDir, "package-lock.json"), "{}");

    await runSetup({ packageRoot: PACKAGE_ROOT });

    // setup may call spawn more than once if a re-entry happens; we
    // want the FIRST call to be ci. Inspect what was invoked.
    const [_cmd, args] = spawnSyncMock.mock.calls[0] as [
      string,
      string[],
      Record<string, unknown>,
    ];
    expect(args[0]).toBe("ci");
    expect(args).toContain("--omit=dev");
    expect(args).toContain("--ignore-scripts");
    // --prefer-offline is install-only; ci pulls from lockfile.
    expect(args).not.toContain("--prefer-offline");
  });

  it("test 3: npm install failure (status !== 0) throws descriptive error", async () => {
    spawnSyncMock.mockImplementationOnce(
      () =>
        ({
          status: 1,
          pid: 1,
          stdout: Buffer.from(""),
          stderr: Buffer.from("ENOTFOUND registry.npmjs.org"),
          output: [],
          signal: null,
        }) as ReturnType<typeof import("node:child_process").spawnSync>,
    );

    await expect(runSetup({ packageRoot: PACKAGE_ROOT })).rejects.toThrow(
      /npm install failed.*exit 1.*Check network connectivity/i,
    );
  });

  it("test 4b: EACCES from spawn → status-null path includes errno code + permission hint", async () => {
    // Critic/test-engineer H-1: previously this returned "(exit unknown)"
    // with no errno code surfaced. v1.5 includes result.error.code in the
    // thrown message so the user sees "EACCES" + "permission" hint.
    spawnSyncMock.mockImplementationOnce(
      () =>
        ({
          status: null,
          pid: 0,
          stdout: Buffer.from(""),
          stderr: Buffer.from(""),
          output: [],
          signal: null,
          error: Object.assign(new Error("spawn npm EACCES"), {
            code: "EACCES",
          }),
        }) as ReturnType<typeof import("node:child_process").spawnSync>,
    );

    await expect(runSetup({ packageRoot: PACKAGE_ROOT })).rejects.toThrow(
      /EACCES.*permission|permission.*EACCES/i,
    );
  });

  it("test 4: ENOENT from spawn → npm-not-found error with install hint", async () => {
    spawnSyncMock.mockImplementationOnce(
      () =>
        ({
          status: null,
          pid: 0,
          stdout: Buffer.from(""),
          stderr: Buffer.from(""),
          output: [],
          signal: null,
          error: Object.assign(new Error("spawn npm ENOENT"), {
            code: "ENOENT",
          }),
        }) as ReturnType<typeof import("node:child_process").spawnSync>,
    );

    await expect(runSetup({ packageRoot: PACKAGE_ROOT })).rejects.toThrow(
      /npm not found on PATH.*Install Node\.js/i,
    );
  });

  it("test 5: dryRun skips both package.json write AND npm spawn", async () => {
    const report = await runSetup({
      packageRoot: PACKAGE_ROOT,
      dryRun: true,
    });

    expect(spawnSyncMock).not.toHaveBeenCalled();
    expect(existsSync(pluginPkgJsonPath())).toBe(false);
    expect(report.depsInstalled).toBe(false);
    expect(report.depsInstallSkipped).toBe(true);
    expect(report.dryRun).toBe(true);
  });

  it("test 6: skipDepsInstall=true writes package.json but skips npm spawn (test/CI mode)", async () => {
    const report = await runSetup({
      packageRoot: PACKAGE_ROOT,
      skipDepsInstall: true,
    });

    expect(spawnSyncMock).not.toHaveBeenCalled();
    // Package.json IS written (so re-runs without skipDepsInstall can install).
    expect(existsSync(pluginPkgJsonPath())).toBe(true);
    expect(report.depsInstalled).toBe(false);
    expect(report.depsInstallSkipped).toBe(true);
  });

  it("test 7: idempotency — calling setup twice invokes npm install twice (npm handles dedup via package-lock)", async () => {
    await runSetup({ packageRoot: PACKAGE_ROOT });
    await runSetup({ packageRoot: PACKAGE_ROOT });
    expect(spawnSyncMock).toHaveBeenCalledTimes(2);
    expect(existsSync(pluginPkgJsonPath())).toBe(true);
  });

  it("test 8 (regression guard): SOURCE_ROOTS must NOT contain 'node_modules'", () => {
    expect(SETUP_SOURCE_ROOTS).not.toContain("node_modules");
  });

  it("test 9 (regression guard): SOURCE_FILES must NOT contain 'package.json'", () => {
    // We write a minimal runtime package.json instead of copying the source
    // package.json (which would carry devDependencies + scripts + bin).
    expect(SETUP_SOURCE_FILES).not.toContain("package.json");
  });
});
