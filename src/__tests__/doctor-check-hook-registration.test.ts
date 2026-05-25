/**
 * Deterministic tests for US-1.9-T2-DOCTOR-check-hook-registration.
 *
 * Validates each registered hook event is in COPILOT_VALID_EVENTS.
 * Special enforcement: `subagentStart` must be camelCase (Invariant 5).
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  analyzeHookRegistrationFromJson,
  probeHookRegistration,
  runDoctor,
} from "../cli/commands/doctor.js";

describe("analyzeHookRegistrationFromJson (pure)", () => {
  it("returns ok when settings.json has no hook entries", () => {
    const result = analyzeHookRegistrationFromJson(`{}`, "/fake/settings.json");
    expect(result.level).toBe("ok");
    expect(result.detail).toContain("no hook events");
  });

  it("returns ok for all valid PascalCase events", () => {
    const json = JSON.stringify({
      hooks: {
        Stop: [],
        SessionStart: [],
        SessionEnd: [],
        UserPromptSubmit: [],
        PreToolUse: [],
        PostToolUse: [],
      },
    });
    const result = analyzeHookRegistrationFromJson(json, "x");
    expect(result.level).toBe("ok");
    expect(result.detail).toContain("6 hook event(s) all valid");
  });

  it("returns ok for subagentStart (camelCase — only valid form, Invariant 5)", () => {
    const json = JSON.stringify({
      hooks: {
        subagentStart: [],
        Stop: [],
      },
    });
    const result = analyzeHookRegistrationFromJson(json, "x");
    expect(result.level).toBe("ok");
  });

  it("returns fail for SubagentStart (PascalCase — Invariant 5 violation)", () => {
    const json = JSON.stringify({
      hooks: {
        SubagentStart: [],
        Stop: [],
      },
    });
    const result = analyzeHookRegistrationFromJson(json, "x");
    expect(result.level).toBe("fail");
    expect(result.detail).toContain("subagentStart");
    expect(result.detail).toContain("camelCase");
    expect(result.detail).toContain("Invariant 5");
  });

  it("returns fail for completely unknown event names", () => {
    const json = JSON.stringify({
      hooks: {
        Stop: [],
        MyCustomEvent: [],
        AnotherBadEvent: [],
      },
    });
    const result = analyzeHookRegistrationFromJson(json, "x");
    expect(result.level).toBe("fail");
    expect(result.detail).toContain("MyCustomEvent");
    expect(result.detail).toContain("AnotherBadEvent");
  });

  it("returns fail combining SubagentStart PascalCase + unknown event", () => {
    const json = JSON.stringify({
      hooks: {
        SubagentStart: [],
        UnknownEvent: [],
      },
    });
    const result = analyzeHookRegistrationFromJson(json, "x");
    expect(result.level).toBe("fail");
    expect(result.detail).toContain("camelCase");
    expect(result.detail).toContain("UnknownEvent");
  });

  it("returns warn for invalid JSON", () => {
    const result = analyzeHookRegistrationFromJson("{ bad json }", "/fake");
    expect(result.level).toBe("warn");
    expect(result.detail).toContain("not valid JSON");
  });

  it("returns ok for all 13 valid events including subagentStart", () => {
    const json = JSON.stringify({
      hooks: {
        SessionStart: [],
        SessionEnd: [],
        UserPromptSubmit: [],
        PreToolUse: [],
        PostToolUse: [],
        PostToolUseFailure: [],
        ErrorOccurred: [],
        Stop: [],
        SubagentStop: [],
        subagentStart: [],
        PreCompact: [],
        PermissionRequest: [],
        Notification: [],
      },
    });
    const result = analyzeHookRegistrationFromJson(json, "x");
    expect(result.level).toBe("ok");
    expect(result.detail).toContain("13 hook event(s) all valid");
  });
});

describe("probeHookRegistration (filesystem)", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "omcp-hook-reg-"));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("returns ok when settings.json does not exist", () => {
    const result = probeHookRegistration(join(tmp, "settings.json"));
    expect(result.level).toBe("ok");
    expect(result.detail).toContain("no settings.json yet");
  });

  it("returns ok for settings with valid events", () => {
    const settingsPath = join(tmp, "settings.json");
    writeFileSync(
      settingsPath,
      JSON.stringify({ hooks: { Stop: [], subagentStart: [] } }),
    );
    const result = probeHookRegistration(settingsPath);
    expect(result.level).toBe("ok");
  });

  it("returns fail for settings with SubagentStart (PascalCase violation)", () => {
    const settingsPath = join(tmp, "settings.json");
    writeFileSync(
      settingsPath,
      JSON.stringify({ hooks: { SubagentStart: [], Stop: [] } }),
    );
    const result = probeHookRegistration(settingsPath);
    expect(result.level).toBe("fail");
    expect(result.detail).toContain("camelCase");
  });
});

describe("runDoctor: hook registration check wired", () => {
  let tmp: string;
  let prevHome: string | undefined;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "omcp-doctor-hookreg-"));
    prevHome = process.env.OMCP_HOME;
    process.env.OMCP_HOME = tmp;
  });

  afterEach(() => {
    if (prevHome === undefined) delete process.env.OMCP_HOME;
    else process.env.OMCP_HOME = prevHome;
    rmSync(tmp, { recursive: true, force: true });
  });

  it("runDoctor surfaces 'hook registration' check (absent settings → ok)", () => {
    const checks = runDoctor();
    const check = checks.find((c) => c.name === "hook registration");
    expect(check).toBeDefined();
    expect(check!.level).toBe("ok");
  });

  it("runDoctor surfaces 'hook registration' fail for SubagentStart PascalCase", () => {
    writeFileSync(
      join(tmp, "settings.json"),
      JSON.stringify({ hooks: { SubagentStart: [], Stop: [] } }),
    );
    const checks = runDoctor();
    const check = checks.find((c) => c.name === "hook registration");
    expect(check).toBeDefined();
    expect(check!.level).toBe("fail");
    expect(check!.detail).toContain("camelCase");
  });
});
