/**
 * Deterministic tests for US-1.9-T2-DOCTOR-check-settings-drift.
 * (Invariant 8: CLI registration)
 *
 * Detects entries in ~/.copilot/settings.json referencing missing scripts,
 * scanning ALL hook command entries (not just __omcp-owned ones).
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  analyzeSettingsDriftFromJson,
  probeSettingsDrift,
  runDoctor,
} from "../cli/commands/doctor.js";

describe("analyzeSettingsDriftFromJson (pure)", () => {
  it("returns ok when settings.json has no hook entries", () => {
    const result = analyzeSettingsDriftFromJson(`{}`, "/fake/settings.json");
    expect(result.level).toBe("ok");
    expect(result.detail).toContain("no hook");
  });

  it("returns ok when all hook commands reference existing scripts", () => {
    const realPath = __filename;
    const json = JSON.stringify({
      hooks: {
        Stop: [
          {
            matcher: "*",
            hooks: [{ type: "command", command: `node "${realPath}" hook fire Stop --json` }],
          },
        ],
      },
    });
    const result = analyzeSettingsDriftFromJson(json, "x");
    expect(result.level).toBe("ok");
    expect(result.detail).toContain("all referenced scripts exist");
  });

  it("returns warn when a hook command references a missing script", () => {
    const missingPath = "C:\\nonexistent\\missing-dispatch.cjs";
    const json = JSON.stringify({
      hooks: {
        Stop: [
          {
            matcher: "*",
            hooks: [{ type: "command", command: `node "${missingPath}" hook fire Stop --json` }],
          },
        ],
      },
    });
    const result = analyzeSettingsDriftFromJson(json, "x");
    expect(result.level).toBe("warn");
    expect(result.detail).toMatch(/missing-dispatch\.cjs/);
    expect(result.detail).toMatch(/omcp setup/);
  });

  it("returns warn even for non-__omcp entries with missing scripts (broader than stale-settings)", () => {
    const missingPath = "C:\\nonexistent\\user-script.sh";
    const json = JSON.stringify({
      hooks: {
        SessionStart: [
          {
            hooks: [{ type: "command", command: `node "${missingPath}"` }],
          },
        ],
      },
    });
    const result = analyzeSettingsDriftFromJson(json, "x");
    expect(result.level).toBe("warn");
    expect(result.detail).toContain("user-script.sh");
  });

  it("returns warn for invalid JSON", () => {
    const result = analyzeSettingsDriftFromJson("{ not valid }", "/fake/path");
    expect(result.level).toBe("warn");
    expect(result.detail).toMatch(/not valid JSON/);
  });

  it("truncates sample at 3 with ellipsis when many entries drift", () => {
    const events = ["Stop", "SessionEnd", "PreToolUse", "PostToolUse", "Notification"];
    const json = JSON.stringify({
      hooks: Object.fromEntries(
        events.map((event, i) => [
          event,
          [
            {
              matcher: "*",
              hooks: [
                { type: "command", command: `node "C:\\nonexistent\\missing-${i}.js" hook fire ${event} --json` },
              ],
            },
          ],
        ]),
      ),
    });
    const result = analyzeSettingsDriftFromJson(json, "x");
    expect(result.level).toBe("warn");
    expect(result.detail).toMatch(/5\/5/);
    expect(result.detail).toContain("...");
  });
});

describe("probeSettingsDrift (filesystem)", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "omcp-settings-drift-"));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("returns ok when settings.json does not exist", () => {
    const result = probeSettingsDrift(join(tmp, "settings.json"));
    expect(result.level).toBe("ok");
    expect(result.detail).toContain("no settings.json yet");
  });

  it("returns ok when all script paths exist", () => {
    const scriptPath = join(tmp, "real-script.js");
    writeFileSync(scriptPath, "// stub");
    const settingsPath = join(tmp, "settings.json");
    writeFileSync(
      settingsPath,
      JSON.stringify({
        hooks: {
          Stop: [
            {
              matcher: "*",
              hooks: [{ type: "command", command: `node "${scriptPath}" hook fire Stop --json` }],
            },
          ],
        },
      }),
    );
    const result = probeSettingsDrift(settingsPath);
    expect(result.level).toBe("ok");
  });

  it("returns warn when settings.json has drifted entries", () => {
    const settingsPath = join(tmp, "settings.json");
    writeFileSync(
      settingsPath,
      JSON.stringify({
        hooks: {
          Stop: [
            {
              matcher: "*",
              hooks: [
                {
                  type: "command",
                  command: `node "${join(tmp, "deleted-script.cjs")}" hook fire Stop --json`,
                },
              ],
            },
          ],
        },
      }),
    );
    const result = probeSettingsDrift(settingsPath);
    expect(result.level).toBe("warn");
    expect(result.detail).toMatch(/deleted-script\.cjs/);
  });
});

describe("runDoctor: settings drift check wired", () => {
  let tmp: string;
  let prevHome: string | undefined;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "omcp-doctor-drift-"));
    prevHome = process.env.OMCP_HOME;
    process.env.OMCP_HOME = tmp;
  });

  afterEach(() => {
    if (prevHome === undefined) delete process.env.OMCP_HOME;
    else process.env.OMCP_HOME = prevHome;
    rmSync(tmp, { recursive: true, force: true });
  });

  it("runDoctor surfaces 'settings drift' check (absent settings → ok)", () => {
    const checks = runDoctor();
    const check = checks.find((c) => c.name === "settings drift");
    expect(check).toBeDefined();
    expect(check!.level).toBe("ok");
    expect(check!.detail).toContain("no settings.json yet");
  });

  it("runDoctor surfaces 'settings drift' warn for drifted settings", () => {
    writeFileSync(
      join(tmp, "settings.json"),
      JSON.stringify({
        hooks: {
          Stop: [
            {
              matcher: "*",
              hooks: [
                {
                  type: "command",
                  command: `node "${join(tmp, "gone.js")}" hook fire Stop --json`,
                },
              ],
            },
          ],
        },
      }),
    );
    const checks = runDoctor();
    const check = checks.find((c) => c.name === "settings drift");
    expect(check).toBeDefined();
    expect(check!.level).toBe("warn");
    expect(check!.detail).toContain("gone.js");
  });
});
