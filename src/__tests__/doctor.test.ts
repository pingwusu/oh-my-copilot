import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { exitCodeFor, runDoctor } from "../cli/commands/doctor.js";

describe("doctor checks", () => {
  let tmp: string;
  let prevHome: string | undefined;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "omcp-doctor-"));
    prevHome = process.env.OMCP_HOME;
    process.env.OMCP_HOME = tmp;
  });

  afterEach(() => {
    if (prevHome === undefined) delete process.env.OMCP_HOME;
    else process.env.OMCP_HOME = prevHome;
  });

  it("reports warn level when plugin not installed", () => {
    const checks = runDoctor();
    const pluginCheck = checks.find((c) => c.name === "oh-my-copilot plugin cache");
    expect(pluginCheck?.level).toBe("warn");
  });

  it("reports ok level when plugin and manifest exist", () => {
    const pluginDir = join(tmp, "installed-plugins", "oh-my-copilot", "oh-my-copilot");
    mkdirSync(join(pluginDir, ".claude-plugin"), { recursive: true });
    writeFileSync(
      join(pluginDir, ".claude-plugin", "plugin.json"),
      JSON.stringify({ name: "oh-my-copilot", version: "0.1.0" }),
    );
    const checks = runDoctor();
    expect(checks.find((c) => c.name === "oh-my-copilot plugin cache")?.level).toBe("ok");
    expect(checks.find((c) => c.name === "plugin manifest")?.level).toBe("ok");
  });

  it("check 9 (hook delivery health) wired: runDoctor surfaces eval_stdin warn when logs dir has matching process-*.log", () => {
    // Test-engineer H-2: previously no integration test exercised the
    // runDoctor → probeHookDeliveryHealth wiring. The try/catch at
    // doctor.ts:235-248 swallows probe exceptions into a "warn" with
    // "unable to probe" — meaning a wiring regression (wrong logsDir
    // path, swapped check name) would be invisible to the suite.
    const logsDir = join(tmp, "logs");
    mkdirSync(logsDir, { recursive: true });
    writeFileSync(
      join(logsDir, "process-test.log"),
      "[ERROR] HookExitCodeError: Hook command failed with code 1\nat node:internal/main/eval_stdin:51:5\n",
    );
    const checks = runDoctor();
    const probe = checks.find((c) => c.name === "hook delivery health");
    expect(probe).toBeDefined();
    expect(probe!.level).toBe("warn");
    expect(probe!.detail).toContain("eval_stdin");
    expect(probe!.detail).toContain("process-test.log");
  });

  it("exit code reflects highest severity", () => {
    expect(exitCodeFor([{ name: "x", level: "ok", detail: "" }])).toBe(0);
    expect(exitCodeFor([{ name: "x", level: "warn", detail: "" }])).toBe(1);
    expect(exitCodeFor([{ name: "x", level: "fail", detail: "" }])).toBe(2);
    expect(
      exitCodeFor([
        { name: "a", level: "warn", detail: "" },
        { name: "b", level: "fail", detail: "" },
      ]),
    ).toBe(2);
  });

  it("warns about hook wiring when config.json is missing", () => {
    const checks = runDoctor();
    const hookCheck = checks.find((c) => c.name === "hook wiring");
    expect(hookCheck).toBeDefined();
    expect(hookCheck?.level).toBe("warn");
  });

  it("reports ok hook wiring when settings.json has omcp __omcp entries", () => {
    // Hooks live in settings.json (Copilot 1.0.48+ reads hooks from there).
    const settings = {
      hooks: {
        PreToolUse: [
          {
            matcher: "*",
            hooks: [
              {
                type: "command",
                command: "omcp hook fire PreToolUse --json",
                __omcp: true,
              },
            ],
          },
        ],
      },
    };
    writeFileSync(join(tmp, "settings.json"), JSON.stringify(settings, null, 2));
    // statusLine stays in config.json
    const config = {
      installedPlugins: [],
      statusLine: {
        type: "command",
        command: "omcp hud",
        __omcp: true,
      },
    };
    writeFileSync(join(tmp, "config.json"), JSON.stringify(config, null, 2));
    const checks = runDoctor();
    expect(checks.find((c) => c.name === "hook wiring")?.level).toBe("ok");
    expect(checks.find((c) => c.name === "statusLine wiring")?.level).toBe("ok");
  });

  it("warns about hook wiring when config.json has no __omcp markers", () => {
    const config = {
      installedPlugins: [],
      hooks: {
        PreToolUse: [
          {
            matcher: "*",
            hooks: [
              { type: "command", command: "user-only" },
            ],
          },
        ],
      },
    };
    writeFileSync(join(tmp, "config.json"), JSON.stringify(config, null, 2));
    const checks = runDoctor();
    expect(checks.find((c) => c.name === "hook wiring")?.level).toBe("warn");
    expect(checks.find((c) => c.name === "statusLine wiring")?.level).toBe("warn");
  });
});
