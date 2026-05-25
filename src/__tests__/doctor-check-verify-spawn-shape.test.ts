/**
 * Deterministic tests for US-omcp-parity-P1-DOCTOR-verify-spawn-shape.
 * (Invariants 8 + 4)
 *
 * Gates `omcp team-verify` readiness — spawns `copilot -p "echo verify-spawn-check"`
 * and asserts exit 0 AND stdout contains a recognizable model-id token
 * (`gpt-` or `claude-`). Tests mock the spawn function to avoid requiring a
 * real Copilot auth session in CI.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  detectVerifySpawnTimeout,
  probeVerifySpawnShape,
  type CopilotVerifySpawnResult,
  runDoctor,
} from "../cli/commands/doctor.js";

describe("probeVerifySpawnShape (injectable spawn)", () => {
  it("returns ok when spawn exits 0 with gpt- model-id token in stdout", () => {
    const mockSpawn = (_cmd: string, _args: string[]): CopilotVerifySpawnResult => ({
      status: 0,
      stdout: "gpt-5.2 (preview) ready — assistant response: verify-spawn-check\n",
      stderr: "",
    });
    const result = probeVerifySpawnShape(mockSpawn);
    expect(result.level).toBe("ok");
    expect(result.detail).toContain("verify-spawn ready");
    expect(result.detail).toContain("gpt-");
  });

  it("returns ok when spawn exits 0 with claude- model-id token in stdout", () => {
    const mockSpawn = (_cmd: string, _args: string[]): CopilotVerifySpawnResult => ({
      status: 0,
      stdout: "claude-sonnet-4.6 — assistant response: verify-spawn-check\n",
      stderr: "",
    });
    const result = probeVerifySpawnShape(mockSpawn);
    expect(result.level).toBe("ok");
    expect(result.detail).toContain("claude-");
  });

  it("returns warn when exit 0 but stdout has no model-id token (banner shape drift)", () => {
    const mockSpawn = (_cmd: string, _args: string[]): CopilotVerifySpawnResult => ({
      status: 0,
      stdout: "verify-spawn-check\n",
      stderr: "",
    });
    const result = probeVerifySpawnShape(mockSpawn);
    expect(result.level).toBe("warn");
    expect(result.detail).toContain("no model-id token");
    expect(result.detail).toContain("banner shape may have drifted");
  });

  it("returns warn when spawn exits 1 and surfaces first non-empty stderr line", () => {
    const mockSpawn = (_cmd: string, _args: string[]): CopilotVerifySpawnResult => ({
      status: 1,
      stdout: "",
      stderr: "\nError: not authenticated — run copilot auth login\nmore detail",
    });
    const result = probeVerifySpawnShape(mockSpawn);
    expect(result.level).toBe("warn");
    expect(result.detail).toContain("exited 1");
    expect(result.detail).toContain("not authenticated");
    expect(result.detail).toContain("copilot auth login");
  });

  it("returns warn when spawn timed out (timedOut=true)", () => {
    const mockSpawn = (_cmd: string, _args: string[]): CopilotVerifySpawnResult => ({
      status: null,
      stdout: "",
      stderr: "",
      timedOut: true,
    });
    const result = probeVerifySpawnShape(mockSpawn);
    expect(result.level).toBe("warn");
    expect(result.detail).toContain("timed out");
    expect(result.detail).toContain("30000ms");
  });

  it("returns warn when status null without timedOut flag (treated as non-zero exit)", () => {
    const mockSpawn = (_cmd: string, _args: string[]): CopilotVerifySpawnResult => ({
      status: null,
      stdout: "",
      stderr: "spawn killed by signal",
    });
    const result = probeVerifySpawnShape(mockSpawn);
    expect(result.level).toBe("warn");
    expect(result.detail).toContain("exited null");
  });

  it("returns warn when spawn throws (copilot not on PATH)", () => {
    const mockSpawn = (_cmd: string, _args: string[]): CopilotVerifySpawnResult => {
      throw new Error("spawn copilot ENOENT");
    };
    const result = probeVerifySpawnShape(mockSpawn);
    expect(result.level).toBe("warn");
    expect(result.detail).toContain("unable to spawn copilot");
    expect(result.detail).toContain("ENOENT");
  });

  it("invokes spawn with correct command and args (`copilot -p \"echo verify-spawn-check\"`)", () => {
    let capturedCmd = "";
    let capturedArgs: string[] = [];
    const mockSpawn = (cmd: string, args: string[]): CopilotVerifySpawnResult => {
      capturedCmd = cmd;
      capturedArgs = args;
      return { status: 0, stdout: "gpt-5.2 ready", stderr: "" };
    };
    probeVerifySpawnShape(mockSpawn);
    expect(capturedCmd).toBe("copilot");
    expect(capturedArgs).toEqual(["-p", "echo verify-spawn-check"]);
  });
});

describe("detectVerifySpawnTimeout (POSIX + Windows shapes)", () => {
  it("returns true when signal fired (POSIX SIGTERM on timeout)", () => {
    expect(
      detectVerifySpawnTimeout({ status: null, signal: "SIGTERM" }),
    ).toBe(true);
  });

  it("returns true when status null + errorCode ETIMEDOUT (Windows shape)", () => {
    expect(
      detectVerifySpawnTimeout({
        status: null,
        signal: null,
        errorCode: "ETIMEDOUT",
      }),
    ).toBe(true);
  });

  it("returns false on clean exit (status 0, no signal)", () => {
    expect(detectVerifySpawnTimeout({ status: 0, signal: null })).toBe(false);
  });

  it("returns false on non-zero exit (status 1, no signal, no errorCode)", () => {
    expect(detectVerifySpawnTimeout({ status: 1, signal: null })).toBe(false);
  });

  it("returns false when status null but errorCode is unrelated (ENOENT)", () => {
    expect(
      detectVerifySpawnTimeout({
        status: null,
        signal: null,
        errorCode: "ENOENT",
      }),
    ).toBe(false);
  });
});

describe("runDoctor: verify-spawn shape check wired", () => {
  let tmp: string;
  let prevHome: string | undefined;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "omcp-doctor-verifyspawn-"));
    prevHome = process.env.OMCP_HOME;
    process.env.OMCP_HOME = tmp;
  });

  afterEach(() => {
    if (prevHome === undefined) delete process.env.OMCP_HOME;
    else process.env.OMCP_HOME = prevHome;
    rmSync(tmp, { recursive: true, force: true });
  });

  it("runDoctor surfaces 'verify-spawn shape' check", () => {
    const checks = runDoctor();
    const check = checks.find((c) => c.name === "verify-spawn shape");
    expect(check).toBeDefined();
    // In CI without real Copilot auth, expect warn; on a fully-authed dev box
    // expect ok. Never crash.
    expect(["ok", "warn"]).toContain(check!.level);
  });
});
