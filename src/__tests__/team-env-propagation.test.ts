// Tests for L2.7-ack: OMCP_TEAM_SESSION_ID + OMCP_TEAM_WORKER_INDEX env vars
// are propagated to workers spawned in detached mode.

import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  vi,
  type MockInstance,
} from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChildProcess, SpawnOptions } from "node:child_process";
import type { EventEmitter } from "node:events";

// ── module mocks (hoisted) ───────────────────────────────────────────────────

// Capture spawn calls so we can inspect the env options without actually
// launching child processes.
const spawnCalls: Array<{ args: string[]; opts: SpawnOptions }> = [];

// Mock factory captures the resolveNpmShimScript return value via a module-
// level flag so individual tests can flip between npm-shim-found and
// fallback paths. Default: shim NOT found (exercises fallback branch).
const shimState: { result: { scriptPath: string } | null } = { result: null };

vi.mock("../runtime/resolve-executable.js", () => ({
  resolveExecutableOrName: (name: string) => name,
  resolveNpmShimScript: () => shimState.result,
  spawnCrossPlatform: (
    _name: string,
    args: string[],
    opts: SpawnOptions = {},
  ): ChildProcess => {
    spawnCalls.push({ args: [...args], opts: { ...opts } });
    const stub = {
      pid: 99999,
      unref: () => {},
    } as unknown as ChildProcess;
    return stub;
  },
  findExecutable: () => null,
}));

// Also mock the direct `node:child_process` spawn — used by the npm-shim
// branch in team.ts (lines 156-161).
const nodeSpawnCalls: Array<{ cmd: string; args: string[]; opts: SpawnOptions }> = [];
vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>(
    "node:child_process",
  );
  return {
    ...actual,
    spawn: (cmd: string, args: string[], opts: SpawnOptions = {}) => {
      nodeSpawnCalls.push({ cmd, args: [...args], opts: { ...opts } });
      const stub = {
        pid: 88888,
        unref: () => {},
      } as unknown as ChildProcess;
      return stub;
    },
  };
});

// ── imports (after mocks) ────────────────────────────────────────────────────

import { runTeam, parseTeamSpec } from "../cli/commands/team.js";

// ── tests ─────────────────────────────────────────────────────────────────────

describe("runTeam detached mode — OMCP_TEAM_* env propagation (L2.7-ack)", () => {
  let tmp: string;
  let cwdSpy: MockInstance;

  beforeEach(() => {
    spawnCalls.length = 0;
    tmp = mkdtempSync(join(tmpdir(), "omcp-team-env-test-"));
    cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(tmp);
  });

  afterEach(() => {
    cwdSpy.mockRestore();
    vi.restoreAllMocks();
    rmSync(tmp, { recursive: true, force: true });
  });

  it("passes OMCP_TEAM_SESSION_ID to each spawned worker in detached mode", () => {
    const spec = parseTeamSpec("2");
    const report = runTeam(spec, "test task");

    // If tmux is available the test is a no-op (tmux mode uses shell env prefix
    // in the command string; the spawn call never reaches spawnCrossPlatform).
    if (report.mode !== "detached") return;

    expect(spawnCalls.length).toBe(2);
    for (const call of spawnCalls) {
      expect(call.opts.env).toBeDefined();
      expect((call.opts.env as Record<string, string>)["OMCP_TEAM_SESSION_ID"]).toBe(
        report.sessionId,
      );
    }
  });

  it("passes OMCP_TEAM_WORKER_INDEX = 1 to first worker and 2 to second in detached mode", () => {
    const spec = parseTeamSpec("2");
    const report = runTeam(spec, "test task");

    if (report.mode !== "detached") return;

    expect(spawnCalls.length).toBe(2);

    // Sort by worker index extracted from the -p arg to make the assertion
    // order-independent.
    const sorted = [...spawnCalls].sort((a, b) => {
      const ia = a.args.indexOf("-p");
      const ib = b.args.indexOf("-p");
      return (a.args[ia + 1] ?? "").localeCompare(b.args[ib + 1] ?? "");
    });

    expect(
      (sorted[0].opts.env as Record<string, string>)["OMCP_TEAM_WORKER_INDEX"],
    ).toBe("1");
    expect(
      (sorted[1].opts.env as Record<string, string>)["OMCP_TEAM_WORKER_INDEX"],
    ).toBe("2");
  });

  it("env inherits process.env entries alongside OMCP_TEAM_* vars", () => {
    const spec = parseTeamSpec("1");
    const report = runTeam(spec, "inherit test");

    if (report.mode !== "detached") return;

    expect(spawnCalls.length).toBe(1);
    const env = spawnCalls[0].opts.env as Record<string, string>;
    // PATH (or at least one standard env key) must survive the spread.
    const hasInheritedKey = Object.keys(env).some(
      (k) => !k.startsWith("OMCP_TEAM_"),
    );
    expect(hasInheritedKey).toBe(true);
  });

  it("fallback branch uses stdio: [ignore, fd, fd] not 'ignore'", () => {
    // Default shimState.result === null → exercises spawnCrossPlatform path.
    const spec = parseTeamSpec("1");
    const report = runTeam(spec, "stdio shape test");
    if (report.mode !== "detached") return;
    expect(spawnCalls.length).toBe(1);
    const stdio = spawnCalls[0].opts.stdio;
    expect(Array.isArray(stdio)).toBe(true);
    expect((stdio as unknown[])[0]).toBe("ignore");
    expect(typeof (stdio as unknown[])[1]).toBe("number");
    expect(typeof (stdio as unknown[])[2]).toBe("number");
    // stdout + stderr should map to the SAME log fd (same file).
    expect((stdio as number[])[1]).toBe((stdio as number[])[2]);
  });
});

describe("runTeam detached mode — npm-shim direct-spawn branch (v2.2.x fix)", () => {
  let tmp: string;
  let cwdSpy: MockInstance;

  beforeEach(() => {
    spawnCalls.length = 0;
    nodeSpawnCalls.length = 0;
    // Activate the npm-shim branch by returning a non-null shim resolution.
    shimState.result = { scriptPath: "C:\\fake\\node_modules\\@github\\copilot\\npm-loader.js" };
    tmp = mkdtempSync(join(tmpdir(), "omcp-team-shim-test-"));
    cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(tmp);
  });

  afterEach(() => {
    shimState.result = null;
    cwdSpy.mockRestore();
    vi.restoreAllMocks();
    rmSync(tmp, { recursive: true, force: true });
  });

  it("npm-shim branch calls node spawn directly with process.execPath + scriptPath", () => {
    const spec = parseTeamSpec("2");
    const report = runTeam(spec, "shim direct task");
    if (report.mode !== "detached") return;

    // npm-shim branch fires → node:child_process.spawn captured calls
    expect(nodeSpawnCalls.length).toBe(2);
    expect(spawnCalls.length).toBe(0); // fallback NOT called
    for (const call of nodeSpawnCalls) {
      expect(call.cmd).toBe(process.execPath);
      expect(call.args[0]).toBe(
        "C:\\fake\\node_modules\\@github\\copilot\\npm-loader.js",
      );
      // Remaining args carry the original -p task + --allow-all-tools
      expect(call.args).toContain("-p");
      expect(call.args).toContain("--allow-all-tools");
    }
  });

  it("npm-shim branch uses stdio: [ignore, fd, fd] for log capture", () => {
    const spec = parseTeamSpec("1");
    const report = runTeam(spec, "shim stdio test");
    if (report.mode !== "detached") return;

    expect(nodeSpawnCalls.length).toBe(1);
    const stdio = nodeSpawnCalls[0].opts.stdio;
    expect(Array.isArray(stdio)).toBe(true);
    expect((stdio as unknown[])[0]).toBe("ignore");
    expect(typeof (stdio as unknown[])[1]).toBe("number");
    expect((stdio as number[])[1]).toBe((stdio as number[])[2]);
  });

  it("npm-shim branch propagates OMCP_TEAM_* env vars", () => {
    const spec = parseTeamSpec("2");
    const report = runTeam(spec, "shim env test");
    if (report.mode !== "detached") return;

    expect(nodeSpawnCalls.length).toBe(2);
    const indices = nodeSpawnCalls
      .map((c) => (c.opts.env as Record<string, string>)["OMCP_TEAM_WORKER_INDEX"])
      .sort();
    expect(indices).toEqual(["1", "2"]);
    for (const call of nodeSpawnCalls) {
      const env = call.opts.env as Record<string, string>;
      expect(env["OMCP_TEAM_SESSION_ID"]).toBe(report.sessionId);
    }
  });

  it("npm-shim branch sets detached: true", () => {
    const spec = parseTeamSpec("1");
    const report = runTeam(spec, "shim detached test");
    if (report.mode !== "detached") return;
    expect(nodeSpawnCalls.length).toBe(1);
    expect(nodeSpawnCalls[0].opts.detached).toBe(true);
  });
});
