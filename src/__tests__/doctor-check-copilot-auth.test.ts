/**
 * Deterministic tests for US-1.9-T2-DOCTOR-check-copilot-auth.
 * (Invariant 8: CLI registration)
 *
 * Spawns `copilot -p "echo test"` and asserts exit 0.
 * Tests mock the spawn function to avoid requiring real Copilot auth in CI.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  probeCopilotAuth,
  type CopilotAuthSpawnResult,
  runDoctor,
} from "../cli/commands/doctor.js";

describe("probeCopilotAuth (injectable spawn)", () => {
  it("returns ok when spawn exits 0", () => {
    const mockSpawn = (_cmd: string, _args: string[]): CopilotAuthSpawnResult => ({
      status: 0,
      stderr: "",
    });
    const result = probeCopilotAuth(mockSpawn);
    expect(result.level).toBe("ok");
    expect(result.detail).toContain("authenticated");
    expect(result.detail).toContain("exit 0");
  });

  it("returns warn when spawn exits non-zero", () => {
    const mockSpawn = (_cmd: string, _args: string[]): CopilotAuthSpawnResult => ({
      status: 1,
      stderr: "Error: not authenticated — run copilot auth login",
    });
    const result = probeCopilotAuth(mockSpawn);
    expect(result.level).toBe("warn");
    expect(result.detail).toContain("exited 1");
    expect(result.detail).toContain("copilot auth login");
  });

  it("returns warn when spawn exits null (process killed/timeout)", () => {
    const mockSpawn = (_cmd: string, _args: string[]): CopilotAuthSpawnResult => ({
      status: null,
      stderr: "",
    });
    const result = probeCopilotAuth(mockSpawn);
    expect(result.level).toBe("warn");
    expect(result.detail).toContain("null");
  });

  it("returns warn when spawn exits 2 with auth hint in stderr", () => {
    const mockSpawn = (_cmd: string, _args: string[]): CopilotAuthSpawnResult => ({
      status: 2,
      stderr: "Please run: copilot auth login\nSomething else",
    });
    const result = probeCopilotAuth(mockSpawn);
    expect(result.level).toBe("warn");
    expect(result.detail).toContain("exited 2");
    // Should surface the auth hint line from stderr
    expect(result.detail).toContain("copilot auth login");
  });

  it("returns warn when spawn throws (copilot not on PATH)", () => {
    const mockSpawn = (_cmd: string, _args: string[]): CopilotAuthSpawnResult => {
      throw new Error("spawn copilot ENOENT");
    };
    const result = probeCopilotAuth(mockSpawn);
    expect(result.level).toBe("warn");
    expect(result.detail).toContain("unable to spawn copilot");
    expect(result.detail).toContain("ENOENT");
  });

  it("invokes spawn with correct command and args", () => {
    let capturedCmd = "";
    let capturedArgs: string[] = [];
    const mockSpawn = (cmd: string, args: string[]): CopilotAuthSpawnResult => {
      capturedCmd = cmd;
      capturedArgs = args;
      return { status: 0 };
    };
    probeCopilotAuth(mockSpawn);
    expect(capturedCmd).toBe("copilot");
    expect(capturedArgs).toEqual(["-p", "echo test"]);
  });
});

describe("runDoctor: copilot auth check wired", () => {
  let tmp: string;
  let prevHome: string | undefined;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "omcp-doctor-copilotauth-"));
    prevHome = process.env.OMCP_HOME;
    process.env.OMCP_HOME = tmp;
  });

  afterEach(() => {
    if (prevHome === undefined) delete process.env.OMCP_HOME;
    else process.env.OMCP_HOME = prevHome;
    rmSync(tmp, { recursive: true, force: true });
  });

  it("runDoctor surfaces 'copilot auth' check", () => {
    const checks = runDoctor();
    const check = checks.find((c) => c.name === "copilot auth");
    expect(check).toBeDefined();
    // In CI, copilot may not be installed — expect ok or warn, never crash
    expect(["ok", "warn"]).toContain(check!.level);
  });
});
