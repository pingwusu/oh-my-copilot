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

vi.mock("../runtime/resolve-executable.js", () => ({
  resolveExecutableOrName: (name: string) => name,
  spawnCrossPlatform: (
    _name: string,
    args: string[],
    opts: SpawnOptions = {},
  ): ChildProcess => {
    spawnCalls.push({ args: [...args], opts: { ...opts } });
    // Return a minimal stub that satisfies the ChildProcess interface used
    // by runTeam (only .pid and .unref() are accessed).
    const stub = {
      pid: 99999,
      unref: () => {},
    } as unknown as ChildProcess;
    return stub;
  },
  findExecutable: () => null,
}));

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
});
